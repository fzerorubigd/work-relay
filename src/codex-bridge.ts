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
import { Envelope } from "./envelope.js";
import { CodexClient } from "./codex-client.js";

export interface BridgeArgs {
  socketPath: string;
  threadId: string;
}

export function parseBridgeArgs(argv: readonly string[]): BridgeArgs {
  let socketPath = "";
  let threadId = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--codex-socket" && i + 1 < argv.length) {
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
  return { socketPath, threadId };
}

export async function runBridge(
  argv: readonly string[],
  // Injection point for tests: substitute a fake CodexClient that
  // doesn't open a real socket. Production passes undefined; the
  // factory defaults to `new CodexClient()`.
  codexFactory: () => CodexClient = () => new CodexClient(),
): Promise<void> {
  const args = parseBridgeArgs(argv);
  const config = loadConfig();

  const codex = codexFactory();
  await codex.connect(args.socketPath);
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
  await codex.resumeThread(args.threadId);

  const bus = new Bus(config);
  await bus.connect();

  bus.onMessage(async (envelope: Envelope) => {
    const input = envelope.payload?.text ?? "";
    if (!input) {
      // Empty-text envelope — skip rather than start an empty turn.
      // No envelope is lost (the bus delivered it; we chose to ignore).
      return;
    }
    try {
      await codex.turnStart(args.threadId, input);
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
