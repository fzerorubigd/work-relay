export type Register = "talk" | "command";

export const ALLOWED_REGISTERS: ReadonlySet<Register> = new Set(["talk", "command"]);

export const ENVELOPE_VERSION = 1;
export const ALLOWED_ACTION = "message";

/**
 * A timestamp in the sender's LOCAL zone, RFC3339 with an explicit offset.
 *
 * `Date.prototype.toISOString` cannot express an offset -- it is always `Z`,
 * regardless of TZ -- so the parts are assembled here. The offset is read from
 * the system clock rather than configured: a fleet host set to UTC correctly
 * emits `+00:00`, and a DST change is picked up without anyone editing a
 * constant.
 *
 * Every site that mints a `ts` must call this. Two do (`buildEnvelope`, and
 * `filterIncoming`'s fallback for an envelope arriving without one), and
 * nothing validates the field, so a site left on the UTC form would put both
 * formats on the wire with nothing complaining.
 */
export function localTimestamp(now: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  // getTimezoneOffset is minutes *behind* UTC, so east of Greenwich is negative.
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const offset = `${sign}${pad((offsetMinutes / 60) | 0)}:${pad(offsetMinutes % 60)}`;
  return `${date}T${time}.${pad(now.getMilliseconds(), 3)}${offset}`;
}

export interface Payload {
  register: Register;
  text: string;
}

export interface Envelope {
  version: 1;
  action: "message";
  source: string;
  to: string;
  ts: string;
  payload: Payload;
  room?: string;
  // When true, the receiver should not attempt to back-reply via this channel.
  // Used by one-shot publishers (e.g. cmd/bus-send) that have no inbox.
  no_reply?: boolean;
}

export function buildEnvelope(args: {
  source: string;
  to: string;
  register: Register;
  text: string;
  room?: string;
}): Envelope {
  return {
    version: ENVELOPE_VERSION,
    action: ALLOWED_ACTION,
    source: args.source,
    to: args.to,
    ts: localTimestamp(),
    payload: {
      register: args.register,
      text: args.text,
    },
    ...(args.room !== undefined ? { room: args.room } : {}),
  };
}

/**
 * Receive-side filter. Returns the envelope if it should be surfaced to the
 * agent, or null if it should be dropped.
 *
 * Drops:
 *   - any envelope with a non-1 version
 *   - any envelope whose action is not "message" (forward-compat: future
 *     versions may add action types this v1 surface doesn't yet handle)
 *   - any envelope whose payload.register is not "talk" or "command"
 *   - missing required fields
 *
 * Strips:
 *   - all top-level fields outside {version, action, source, to, ts, payload, room, no_reply}
 *   - all payload fields outside {register, text}
 */
export function filterIncoming(raw: unknown): Envelope | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (obj.version !== ENVELOPE_VERSION) return null;
  if (obj.action !== ALLOWED_ACTION) return null;
  if (typeof obj.source !== "string" || typeof obj.to !== "string") return null;

  const payloadRaw = obj.payload;
  if (!payloadRaw || typeof payloadRaw !== "object") return null;
  const p = payloadRaw as Record<string, unknown>;

  const register = p.register;
  if (typeof register !== "string" || !ALLOWED_REGISTERS.has(register as Register)) {
    return null;
  }
  if (typeof p.text !== "string") return null;

  const ts = typeof obj.ts === "string" ? obj.ts : localTimestamp();

  const filtered: Envelope = {
    version: ENVELOPE_VERSION,
    action: ALLOWED_ACTION,
    source: obj.source,
    to: obj.to,
    ts,
    payload: {
      register: register as Register,
      text: p.text,
    },
  };

  if (typeof obj.room === "string") {
    filtered.room = obj.room;
  }

  if (typeof obj.no_reply === "boolean") {
    filtered.no_reply = obj.no_reply;
  }

  return filtered;
}

const ROOM_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidRoomName(name: string): boolean {
  return ROOM_NAME_RE.test(name);
}

// formatPreview produces the host-channel preview string for an
// incoming envelope (#7). Two shapes that both end `]: <text>`:
//
//   - DM:   `[<source>]: <text>`
//   - Room: `[<source> in <room>]: <text>`
//
// Workers parsing the preview line can split on `]: ` and rely on
// the bracket interior to disambiguate a room post from a DM.
export function formatPreview(envelope: Envelope): string {
  if (envelope.room) {
    return `[${envelope.source} in ${envelope.room}]: ${envelope.payload.text}`;
  }
  return `[${envelope.source}]: ${envelope.payload.text}`;
}

// ROOM_TOPIC_PREFIX names the MQTT topic prefix used for room (group)
// messages. Per-agent topics use `bus/agents/<name>`; the broadcast
// topic is `bus/agents/broadcast`. Only room topics carry the
// self-echo problem self-suppression below addresses.
export const ROOM_TOPIC_PREFIX = "bus/agents/groups/";

// shouldSuppressSelfEcho reports whether an incoming envelope should
// be silently dropped because it's our own publish round-tripping
// through a room subscription. When an agent calls
// `subscribe(["general"])` and then `send_group("general", ...)`,
// the message round-trips back through the subscription and would
// otherwise surface as a notification — clutter the session and
// create false-feedback (the model treats its own post as new
// input).
//
// Suppression fires only on room topics (`bus/agents/groups/*`); DM
// and broadcast paths are unaffected by construction (an agent can't
// receive its own DM, since direct topics are addressed to a single
// recipient).
export function shouldSuppressSelfEcho(topic: string, source: string, ourAgentId: string): boolean {
  return topic.startsWith(ROOM_TOPIC_PREFIX) && source === ourAgentId;
}
