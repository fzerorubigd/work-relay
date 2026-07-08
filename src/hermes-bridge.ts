/**
 * work-relay hermes-bridge subcommand. Bridges bus envelopes to a Hermes
 * Agent over its OpenAI-compatible HTTP API so a Hermes-backed agent joins
 * the MQTT bus as a first-class participant: other agents talk to it with
 * plain send_message / send_group, and its replies come back as ordinary
 * bus envelopes.
 *
 * Mirrors codex-bridge, with one structural difference: Hermes does NOT
 * hold the work-relay MCP send_message tool (it's reached over HTTP, not
 * as an MCP host), so the bridge always publishes Hermes's reply back to
 * the bus itself. codex-bridge, by contrast, lets the codex agent reply
 * through its own registered tool and only falls back to publishing.
 *
 * Fully config-driven — the Hermes base URL, auth, model, and session
 * strategy are all args/env. Nothing about a specific deployment is
 * hardcoded, so the same binary bridges any Hermes agent.
 *
 * Flow:
 *   1. loadConfig() → WORK_RELAY_AGENT_ID (the bus id Hermes answers as,
 *      e.g. "hermes") + WORK_RELAY_BROKER.
 *   2. Subscribe to the bus for that id (same Bus class as MCP mode).
 *   3. For each inbound envelope, POST its text to Hermes with a per-
 *      conversation session id; publish the reply back to the sender.
 *
 * The bridge does NOT manage the Hermes process lifecycle — the operator
 * runs Hermes separately. HTTP is stateless: a failed request logs and is
 * skipped (fail-soft, so a transient Hermes blip doesn't tear down the bus
 * subscription); a wrong base URL surfaces on the startup health probe.
 */
import { loadConfig } from "./config.js";
import { Bus } from "./bus.js";
import { buildEnvelope, Envelope } from "./envelope.js";
import { HermesClient, HermesClientOptions } from "./hermes-client.js";

export interface HermesBridgeArgs {
  /** Hermes API server base URL (required). */
  baseUrl: string;
  /** Optional model override passed through to Hermes per request. */
  model?: string;
  /** Fixed Hermes session id for ALL bus traffic. When unset, the bridge
   * derives a per-conversation session (see `sessionFor`). */
  sessionId?: string;
  /** Prefix for per-conversation session ids when `sessionId` is unset. */
  sessionPrefix: string;
}

const DEFAULT_SESSION_PREFIX = "work-relay:";

export function parseHermesBridgeArgs(argv: readonly string[]): HermesBridgeArgs {
  let baseUrl = "";
  let model: string | undefined;
  let sessionId: string | undefined;
  let sessionPrefix = DEFAULT_SESSION_PREFIX;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hermes-url" && i + 1 < argv.length) {
      baseUrl = argv[++i];
    } else if (a.startsWith("--hermes-url=")) {
      baseUrl = a.slice("--hermes-url=".length);
    } else if (a === "--model" && i + 1 < argv.length) {
      model = argv[++i];
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else if (a === "--session-id" && i + 1 < argv.length) {
      sessionId = argv[++i];
    } else if (a.startsWith("--session-id=")) {
      sessionId = a.slice("--session-id=".length);
    } else if (a === "--session-prefix" && i + 1 < argv.length) {
      sessionPrefix = argv[++i];
    } else if (a.startsWith("--session-prefix=")) {
      sessionPrefix = a.slice("--session-prefix=".length);
    }
  }

  if (!baseUrl) {
    throw new Error("hermes-bridge: --hermes-url is required");
  }
  return { baseUrl, model, sessionId, sessionPrefix };
}

/**
 * Map a bus envelope to a Hermes session id. A fixed `--session-id` makes
 * all bus traffic share one Hermes conversation; otherwise each bus peer
 * (or room) gets its own session (prefix + scope) so contexts don't bleed
 * into each other.
 */
export function sessionFor(
  args: Pick<HermesBridgeArgs, "sessionId" | "sessionPrefix">,
  envelope: Envelope,
): string {
  if (args.sessionId) return args.sessionId;
  const scope = envelope.room ? `room:${envelope.room}` : envelope.source;
  return `${args.sessionPrefix}${scope}`;
}

/**
 * Render a bus envelope into the user message sent to Hermes. Unlike
 * codex-bridge's formatter there is no "reply via send_message" line —
 * the bridge publishes the reply itself, so Hermes just answers normally.
 * The compact header gives Hermes the sender/route/register signal.
 */
export function formatHermesInput(envelope: Envelope): string {
  const route = envelope.room ? "group" : "direct";
  const header = [
    "Work-relay bus message",
    `from: ${envelope.source}`,
    `route: ${route}`,
    ...(envelope.room ? [`room: ${envelope.room}`] : []),
    `register: ${envelope.payload.register}`,
  ];
  return [...header, "", envelope.payload.text].join("\n");
}

export async function runHermesBridge(
  argv: readonly string[],
  // Injection point for tests: substitute a fake HermesClient that
  // doesn't do real HTTP. Production passes undefined; the factory
  // defaults to `new HermesClient(opts)`.
  clientFactory: (opts: HermesClientOptions) => HermesClient = (opts) => new HermesClient(opts),
): Promise<void> {
  const args = parseHermesBridgeArgs(argv);
  const config = loadConfig();

  const client = clientFactory({
    baseUrl: args.baseUrl,
    apiKey: process.env.HERMES_API_KEY,
    sessionKey: process.env.HERMES_SESSION_KEY,
    model: args.model,
  });

  // Best-effort startup probe — a wrong URL / down Hermes surfaces here
  // instead of silently swallowing every envelope. Non-fatal: HTTP is
  // stateless and Hermes may come up after the bridge.
  const healthy = await client.health();
  process.stderr.write(
    `work-relay hermes-bridge: hermes at ${args.baseUrl} health=${
      healthy ? "ok" : "unreachable (will retry per-message)"
    }\n`,
  );

  const bus = new Bus(config);
  await bus.connect();
  process.stderr.write(`work-relay hermes-bridge: subscribed as "${config.agentId}"\n`);

  bus.onMessage(async (envelope: Envelope) => {
    // Ignore our own publishes (e.g. a broadcast round-tripping through a
    // subscription) so Hermes never talks to itself in a loop.
    if (envelope.source === config.agentId) return;

    const text = envelope.payload?.text ?? "";
    if (!text) {
      // Empty-text envelope — skip rather than round-trip an empty turn.
      return;
    }

    const sessionId = sessionFor(args, envelope);
    let reply: string;
    try {
      const res = await client.chat(sessionId, formatHermesInput(envelope));
      reply = res.text.trim();
    } catch (e) {
      process.stderr.write(
        `work-relay hermes-bridge: chat failed for envelope from ${envelope.source}: ${e}\n`,
      );
      return;
    }

    // no_reply envelopes are still delivered to Hermes (so they land in
    // its session history / memory) but we don't publish a reply back.
    if (envelope.no_reply) return;

    if (!reply) {
      process.stderr.write(
        `work-relay hermes-bridge: empty reply for envelope from ${envelope.source}; nothing published\n`,
      );
      return;
    }

    const out = buildEnvelope({
      source: config.agentId,
      to: envelope.source,
      register: "talk",
      text: reply,
    });
    try {
      await bus.publishDirect(out);
      process.stderr.write(
        `work-relay hermes-bridge: published reply to ${envelope.source} (session ${sessionId})\n`,
      );
    } catch (e) {
      process.stderr.write(`work-relay hermes-bridge: publish reply failed: ${e}\n`);
    }
  });

  const shutdown = async () => {
    await bus.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Block forever — process stays alive until SIGINT/SIGTERM.
  await new Promise<never>(() => {});
}
