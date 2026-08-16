import { credsPath, loadCreds, type BrokerCreds } from "./creds.js";
import { isValidRoomName } from "./envelope.js";

export interface Config {
  agentId: string;
  brokerUrl: string;
  brokerUser?: string;
  brokerPass?: string;
  initialRooms: string[];
  /** Persistent MQTT session — required for the broker to queue messages
   * for an agent while its work-relay is offline. Pair with `fetch_messages`
   * for a mailbox-shape worker that wakes on a schedule. */
  persistent: boolean;
  /** Maximum envelopes the in-memory buffer holds at once before dropping
   * the oldest. Only relevant when callers use `fetch_messages`. */
  bufferCap: number;
}

/**
 * Resolve the initial-rooms list from argv (`--rooms=foo,bar` or
 * `--rooms foo,bar`) with `WORK_RELAY_ROOMS` env as fallback. Argv wins
 * when both are present (standard CLI-precedence shape). Names are
 * validated against the room-name regex; invalid names are dropped and
 * surfaced on stderr so operators know which entries were skipped, but
 * one bad name doesn't fail the rest of the list.
 *
 * Pure function — takes argv + env explicitly so tests can drive it
 * without mutating process state.
 */
export function parseInitialRooms(
  argv: readonly string[],
  env: Partial<Record<string, string>>,
  warn: (msg: string) => void = (msg) => process.stderr.write(`work-relay: ${msg}\n`),
): string[] {
  const fromArgv = extractRoomsArg(argv);
  const raw = fromArgv ?? env.WORK_RELAY_ROOMS ?? "";
  const candidates = raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const valid: string[] = [];
  for (const name of candidates) {
    if (isValidRoomName(name)) {
      valid.push(name);
    } else {
      warn(`--rooms: dropping invalid room name "${name}" (must match [A-Za-z0-9_-]{1,64})`);
    }
  }
  return valid;
}

/** Extract the `--rooms` value from argv, supporting both `--rooms=foo,bar`
 * and `--rooms foo,bar` shapes. Returns the raw comma-separated string
 * (validation happens upstream) or undefined when the flag is absent. */
function extractRoomsArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rooms" && i + 1 < argv.length) {
      return argv[i + 1];
    }
    if (a.startsWith("--rooms=")) {
      return a.slice("--rooms=".length);
    }
  }
  return undefined;
}

export function loadConfig(): Config {
  const agentId = process.env.WORK_RELAY_AGENT_ID;
  if (!agentId) {
    throw new Error("WORK_RELAY_AGENT_ID environment variable is required");
  }

  // Environment first, then the optional credentials file. The file is the
  // standing default; a deliberately-exported variable should always beat what
  // is on disk. Same keys, same precedence as the Go client in cmd/bus-send,
  // so one file configures both.
  const path = credsPath(process.env);
  const file: BrokerCreds = path ? loadCreds(path) : {};

  const brokerUrl =
    process.env.WORK_RELAY_BROKER ?? file.url ?? "mqtt://localhost:1883";

  const initialRooms = parseInitialRooms(process.argv.slice(2), process.env);

  const persistent = (process.env.WORK_RELAY_PERSISTENT ?? "").toLowerCase() === "true";
  const bufferCap = parseInt(process.env.WORK_RELAY_BUFFER_CAP ?? "100", 10);

  return {
    agentId,
    brokerUrl,
    brokerUser: process.env.WORK_RELAY_BROKER_USER ?? file.user,
    brokerPass: process.env.WORK_RELAY_BROKER_PASS ?? file.pass,
    initialRooms,
    persistent,
    bufferCap: Number.isFinite(bufferCap) && bufferCap > 0 ? bufferCap : 100,
  };
}
