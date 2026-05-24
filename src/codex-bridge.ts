/**
 * work-relay codex-bridge subcommand. Bridges bus envelopes to a
 * running codex app-server via its JSON-RPC control surface so a
 * codex-backed agent reacts to bus events in real time — the
 * channel-push semantic that codex's polling-only MCP shape lacks.
 *
 * Flow:
 *   1. Connect to the codex daemon at --codex-socket.
 *   2. JSON-RPC initialize with capabilities.experimentalApi = true
 *      (codex requires this for thread/inject_items + turn/start).
 *   3. Subscribe to the bus for the agent's id (same Bus class the
 *      MCP-server mode uses; just no MCP server attached on top).
 *   4. For each envelope, send turn/start with the envelope text
 *      as user input. The codex agent processes the turn and emits
 *      the response via its already-registered send_message MCP
 *      tool back onto the bus.
 *
 * The bridge does NOT manage the codex daemon's lifecycle —
 * operator starts/stops codex separately. Daemon disconnect makes
 * the bridge log + exit non-zero (fail-loud; same shape as
 * MCP-server-mode's broker-unavailable handling).
 */
import { loadConfig } from "./config.js";
import { Bus } from "./bus.js";
import { buildEnvelope, Envelope } from "./envelope.js";
import { CodexClient } from "./codex-client.js";

export interface BridgeArgs {
  socketPath: string;
  threadId: string;
  codexArgs: string[];
}

export function formatBridgeInput(envelope: Envelope): string {
  const register = envelope.payload.register;
  const text = envelope.payload.text;
  const route = envelope.room ? "group" : "direct";
  const replyInstruction = envelope.no_reply
    ? "The sender marked this envelope no_reply=true; do not send a bus reply unless the message explicitly asks for one."
    : `Reply on the bus with send_message(to: "${envelope.source}", register: "talk", text: ...).`;

  const header = [
    "Work-relay bus message",
    `source: ${envelope.source}`,
    `to: ${envelope.to}`,
    `register: ${register}`,
    `timestamp: ${envelope.ts}`,
    `route: ${route}`,
    ...(envelope.room ? [`room: ${envelope.room}`] : []),
  ];

  return [
    ...header,
    "",
    "Message:",
    text,
    "",
    replyInstruction,
  ].join("\n");
}

export function parseBridgeArgs(argv: readonly string[]): BridgeArgs {
  let socketPath = "";
  let threadId = "";
  let codexArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      codexArgs = [...argv.slice(i + 1)];
      break;
    } else if (a === "--codex-socket" && i + 1 < argv.length) {
      socketPath = argv[++i];
    } else if (a.startsWith("--codex-socket=")) {
      socketPath = a.slice("--codex-socket=".length);
    } else if (a === "--thread-id" && i + 1 < argv.length) {
      threadId = argv[++i];
    } else if (a.startsWith("--thread-id=")) {
      threadId = a.slice("--thread-id=".length);
    }
  }
  if (!socketPath) {
    throw new Error("codex-bridge: --codex-socket is required");
  }
  if (!threadId) {
    throw new Error("codex-bridge: --thread-id is required");
  }
  return { socketPath, threadId, codexArgs };
}

export function hasNeverApprovalOverride(codexArgs: readonly string[]): boolean {
  for (let i = 0; i < codexArgs.length; i++) {
    if (codexArgs[i] !== "-c" && codexArgs[i] !== "--config") continue;
    const value = codexArgs[i + 1] ?? "";
    if (/^approval_policy\s*=\s*["']?never["']?$/.test(value)) {
      return true;
    }
  }
  return false;
}

interface TurnReplyState {
  envelope: Envelope;
  agentText: string;
  sentViaTool: boolean;
}

export function getTurnId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  return typeof obj.turnId === "string" ? obj.turnId : null;
}

export async function handleCodexNotification(
  notification: unknown,
  turnReplies: Map<string, TurnReplyState>,
  bus: Pick<Bus, "publishDirect">,
  agentId: string,
): Promise<void> {
  if (!notification || typeof notification !== "object") return;
  const { method, params } = notification as { method?: unknown; params?: unknown };
  if (typeof method !== "string" || !params || typeof params !== "object") return;
  const p = params as Record<string, unknown>;

  if (method === "item/agentMessage/delta") {
    const turnId = typeof p.turnId === "string" ? p.turnId : null;
    const delta = typeof p.delta === "string" ? p.delta : "";
    if (!turnId || !delta) return;
    const state = turnReplies.get(turnId);
    if (state) state.agentText += delta;
    return;
  }

  if (method === "item/completed") {
    const turnId = typeof p.turnId === "string" ? p.turnId : null;
    const item = p.item && typeof p.item === "object" ? p.item as Record<string, unknown> : null;
    const state = turnId ? turnReplies.get(turnId) : undefined;
    if (!turnId || !item || !state) return;

    if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
      state.agentText = item.text;
      process.stderr.write(`work-relay codex-bridge: agent message for turn ${turnId}: ${item.text}\n`);
      return;
    }

    if (item.type === "mcpToolCall") {
      const server = typeof item.server === "string" ? item.server : "";
      const tool = typeof item.tool === "string" ? item.tool : "";
      const status = typeof item.status === "string" ? item.status : "";
      process.stderr.write(
        `work-relay codex-bridge: mcp tool ${server}.${tool} ${status} for turn ${turnId}\n`,
      );
      if (server === "work-relay" && tool === "send_message" && status === "completed") {
        state.sentViaTool = true;
      }
      if (item.error) {
        process.stderr.write(
          `work-relay codex-bridge: mcp tool error ${JSON.stringify(item.error)}\n`,
        );
      }
      return;
    }
  }

  if (method === "item/mcpToolCall/progress") {
    process.stderr.write(`work-relay codex-bridge: mcp progress ${JSON.stringify(p)}\n`);
    return;
  }

  if (method === "error") {
    process.stderr.write(`work-relay codex-bridge: codex turn error ${JSON.stringify(p)}\n`);
    return;
  }

  if (method === "turn/completed") {
    const turn = p.turn && typeof p.turn === "object" ? p.turn as Record<string, unknown> : null;
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (!turnId || !turn) return;
    const state = turnReplies.get(turnId);
    if (!state) return;
    turnReplies.delete(turnId);

    const status = typeof turn.status === "string" ? turn.status : "unknown";
    process.stderr.write(`work-relay codex-bridge: turn ${turnId} completed with status ${status}\n`);
    if (state.sentViaTool || state.envelope.no_reply) return;

    const text = state.agentText.trim();
    if (!text) {
      process.stderr.write(
        `work-relay codex-bridge: no fallback reply for turn ${turnId}; no agent text captured\n`,
      );
      return;
    }

    const reply = buildEnvelope({
      source: agentId,
      to: state.envelope.source,
      register: "talk",
      text,
    });
    await bus.publishDirect(reply);
    process.stderr.write(
      `work-relay codex-bridge: fallback-published reply to ${state.envelope.source} for turn ${turnId}\n`,
    );
  }
}

export async function runBridge(
  argv: readonly string[],
  // Injection point for tests: substitute a fake CodexClient that
  // doesn't open a real socket. Production passes undefined; the
  // factory defaults to `new CodexClient()`.
  codexFactory: () => CodexClient = () => new CodexClient(),
): Promise<void> {
  const args = parseBridgeArgs(argv);
  const approvalPolicy = hasNeverApprovalOverride(args.codexArgs) ? "never" : undefined;
  const config = loadConfig();

  const codex = codexFactory();
  codex.setAutoApproveServerRequests(approvalPolicy === "never");
  await codex.connect(args.socketPath, args.codexArgs);
  // Attach lifecycle listeners BEFORE the initialize handshake so
  // a malformed-JSON / socket-error during init is caught by the
  // fail-loud exit path rather than surfacing as an unhandled
  // EventEmitter error. Same lifecycle window the `close` listener
  // needs to cover.
  codex.on("close", () => {
    process.stderr.write(
      "work-relay codex-bridge: codex daemon disconnected; exiting\n",
    );
    process.exit(1);
  });
  codex.on("error", (e: unknown) => {
    process.stderr.write(
      `work-relay codex-bridge: codex client error: ${e}\n`,
    );
    process.exit(1);
  });
  await codex.initialize();
  await codex.resumeThread(args.threadId, { approvalPolicy });

  const bus = new Bus(config);
  await bus.connect();
  const turnReplies = new Map<string, TurnReplyState>();

  codex.on("notification", (notification: unknown) => {
    handleCodexNotification(notification, turnReplies, bus, config.agentId).catch((e) => {
      process.stderr.write(`work-relay codex-bridge: notification handling failed: ${e}\n`);
    });
  });

  bus.onMessage(async (envelope: Envelope) => {
    const input = envelope.payload?.text ? formatBridgeInput(envelope) : "";
    if (!input) {
      // Empty-text envelope — skip rather than start an empty turn.
      // No envelope is lost (the bus delivered it; we chose to ignore).
      return;
    }
    try {
      const result = await codex.turnStart(args.threadId, input, { approvalPolicy });
      const turnId = getTurnId(result);
      if (turnId) {
        turnReplies.set(turnId, {
          envelope,
          agentText: "",
          sentViaTool: false,
        });
      }
    } catch (e) {
      process.stderr.write(
        `work-relay codex-bridge: turn/start failed for envelope from ${envelope.source}: ${e}\n`,
      );
    }
  });

  const shutdown = async () => {
    codex.disconnect();
    await bus.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Block forever — process stays alive until SIGINT/SIGTERM or
  // codex disconnect triggers an exit.
  await new Promise<never>(() => {});
}
