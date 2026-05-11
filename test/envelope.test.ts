import { test, expect } from "bun:test";
import { filterIncoming, isValidRoomName, buildEnvelope } from "../src/envelope.js";

test("filterIncoming: accepts well-formed message envelope (talk)", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "agent-a",
    to: "agent-b",
    ts: "2026-01-01T00:00:00Z",
    payload: { register: "talk", text: "hello" },
  });
  expect(got).not.toBeNull();
  expect(got!.payload.register).toBe("talk");
  expect(got!.payload.text).toBe("hello");
});

test("filterIncoming: accepts command register", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "agent-a",
    to: "agent-b",
    ts: "2026-01-01T00:00:00Z",
    payload: { register: "command", text: "run it" },
  });
  expect(got).not.toBeNull();
  expect(got!.payload.register).toBe("command");
});

test("filterIncoming: rejects unknown register inside a message envelope", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "agent-a",
    to: "agent-b",
    payload: { register: "other-register", text: "x" },
  });
  expect(got).toBeNull();
});

test("filterIncoming: rejects non-message action (system-event)", () => {
  const got = filterIncoming({
    version: 1,
    action: "system-event",
    source: "system",
    to: "agent-a",
    payload: { foo: 1, bar: 2 },
  });
  expect(got).toBeNull();
});

test("filterIncoming: rejects non-message action (signal)", () => {
  const got = filterIncoming({
    version: 1,
    action: "signal",
    source: "agent-b",
    to: "agent-a",
    payload: { type: "ping", value: "x" },
  });
  expect(got).toBeNull();
});

test("filterIncoming: rejects non-message action (tick)", () => {
  const got = filterIncoming({
    version: 1,
    action: "tick",
    source: "system",
    to: "agent-a",
    payload: { counter: 1 },
  });
  expect(got).toBeNull();
});

test("filterIncoming: rejects wrong version", () => {
  const got = filterIncoming({
    version: 2,
    action: "message",
    source: "a",
    to: "b",
    payload: { register: "talk", text: "x" },
  });
  expect(got).toBeNull();
});

test("filterIncoming: rejects missing payload", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "a",
    to: "b",
  });
  expect(got).toBeNull();
});

test("filterIncoming: rejects missing payload.text", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "a",
    to: "b",
    payload: { register: "talk" },
  });
  expect(got).toBeNull();
});

test("filterIncoming: strips extra fields from payload", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "a",
    to: "b",
    payload: {
      register: "talk",
      text: "hi",
      extra_field_a: { nested: 1 },
      extra_field_b: "value",
    },
  });
  expect(got).not.toBeNull();
  expect((got!.payload as any).extra_field_a).toBeUndefined();
  expect((got!.payload as any).extra_field_b).toBeUndefined();
});

test("filterIncoming: keeps room field for group messages", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "a",
    to: "general",
    payload: { register: "talk", text: "hi" },
    room: "general",
  });
  expect(got).not.toBeNull();
  expect(got!.room).toBe("general");
});

test("filterIncoming: preserves no_reply when set to a boolean", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "bus-send",
    to: "agent-a",
    payload: { register: "talk", text: "hi" },
    no_reply: true,
  });
  expect(got).not.toBeNull();
  expect(got!.no_reply).toBe(true);
});

test("filterIncoming: drops no_reply when not a boolean", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "a",
    to: "b",
    payload: { register: "talk", text: "x" },
    no_reply: "true",
  });
  expect(got).not.toBeNull();
  expect(got!.no_reply).toBeUndefined();
});

test("filterIncoming: omits no_reply when absent", () => {
  const got = filterIncoming({
    version: 1,
    action: "message",
    source: "a",
    to: "b",
    payload: { register: "talk", text: "x" },
  });
  expect(got).not.toBeNull();
  expect(got!.no_reply).toBeUndefined();
});

test("filterIncoming: rejects non-object input", () => {
  expect(filterIncoming(null)).toBeNull();
  expect(filterIncoming("string")).toBeNull();
  expect(filterIncoming(42)).toBeNull();
});

test("isValidRoomName: accepts plain names", () => {
  expect(isValidRoomName("general")).toBe(true);
  expect(isValidRoomName("project-x")).toBe(true);
  expect(isValidRoomName("room_42")).toBe(true);
  expect(isValidRoomName("a")).toBe(true);
});

test("isValidRoomName: rejects invalid chars and lengths", () => {
  expect(isValidRoomName("")).toBe(false);
  expect(isValidRoomName("with space")).toBe(false);
  expect(isValidRoomName("with/slash")).toBe(false);
  expect(isValidRoomName("ümlaut")).toBe(false);
  expect(isValidRoomName("a".repeat(65))).toBe(false);
});

test("buildEnvelope: includes all required envelope fields", () => {
  const env = buildEnvelope({
    source: "agent-a",
    to: "agent-b",
    register: "talk",
    text: "hello",
  });
  expect(env.version).toBe(1);
  expect(env.action).toBe("message");
  expect(env.source).toBe("agent-a");
  expect(env.to).toBe("agent-b");
  expect(env.payload.register).toBe("talk");
  expect(env.payload.text).toBe("hello");
  expect(env.room).toBeUndefined();
  expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("buildEnvelope: includes room when provided", () => {
  const env = buildEnvelope({
    source: "agent-a",
    to: "general",
    register: "talk",
    text: "hi",
    room: "general",
  });
  expect(env.room).toBe("general");
});

// --- #7: preview format + self-echo suppression ---

import {
  formatPreview,
  shouldSuppressSelfEcho,
  ROOM_TOPIC_PREFIX,
} from "../src/envelope.js";
import type { Envelope } from "../src/envelope.js";

function envelopeFor(args: {
  source: string;
  to: string;
  text: string;
  room?: string;
}): Envelope {
  return {
    version: 1,
    action: "message",
    source: args.source,
    to: args.to,
    ts: "2026-01-01T00:00:00Z",
    payload: { register: "talk", text: args.text },
    ...(args.room ? { room: args.room } : {}),
  };
}

test("formatPreview: DM format ends with `]: <text>`", () => {
  const got = formatPreview(envelopeFor({
    source: "alice",
    to: "bob",
    text: "build started",
  }));
  expect(got).toBe("[alice]: build started");
});

test("formatPreview: room format names the room in the bracket", () => {
  const got = formatPreview(envelopeFor({
    source: "alice",
    to: "general",
    text: "build green",
    room: "general",
  }));
  expect(got).toBe("[alice in general]: build green");
});

test("formatPreview: both shapes share the `]: ` separator", () => {
  // Workers parsing the preview line can split on `]: ` and
  // disambiguate via the bracket interior. Pin both shapes use
  // the same separator.
  const dm = formatPreview(envelopeFor({ source: "a", to: "b", text: "x" }));
  const room = formatPreview(envelopeFor({ source: "a", to: "r", text: "x", room: "r" }));
  expect(dm).toContain("]: ");
  expect(room).toContain("]: ");
});

test("shouldSuppressSelfEcho: drops own room publish", () => {
  const drop = shouldSuppressSelfEcho(
    `${ROOM_TOPIC_PREFIX}general`,
    "agent-a",
    "agent-a",
  );
  expect(drop).toBe(true);
});

test("shouldSuppressSelfEcho: keeps other-source room post", () => {
  const drop = shouldSuppressSelfEcho(
    `${ROOM_TOPIC_PREFIX}general`,
    "agent-b",
    "agent-a",
  );
  expect(drop).toBe(false);
});

test("shouldSuppressSelfEcho: keeps own DM (different topic prefix)", () => {
  // DMs land on `bus/agents/<name>`. An agent can't receive its own
  // DM by construction, but the suppression rule still must NOT
  // accidentally fire on a non-room topic — defensive coverage.
  const drop = shouldSuppressSelfEcho(
    "bus/agents/agent-a",
    "agent-a",
    "agent-a",
  );
  expect(drop).toBe(false);
});

test("shouldSuppressSelfEcho: keeps broadcast", () => {
  const drop = shouldSuppressSelfEcho(
    "bus/agents/broadcast",
    "agent-a",
    "agent-a",
  );
  expect(drop).toBe(false);
});
