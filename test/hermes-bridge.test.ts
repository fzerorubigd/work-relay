/**
 * Smoke tests for the hermes-bridge subcommand:
 *   - argv parsing (space + equals forms, defaults, missing required flag)
 *   - session-id mapping (fixed vs per-source vs per-room)
 *   - input formatting (direct / group / register; no tool-reply line)
 *   - OpenAI-compatible response parsing (string, array-of-parts, missing)
 *   - HermesClient round-trips against an injected fake fetch (URL, headers,
 *     body, model passthrough) and surfaces HTTP errors + health probe
 *
 * No network: HermesClient takes a `fetchImpl` injection point, so tests
 * assert the exact request the bridge would send and drive canned
 * Responses back through the same code path production uses.
 */
import { test, expect } from "bun:test";

import {
  formatHermesInput,
  parseHermesBridgeArgs,
  sessionFor,
} from "../src/hermes-bridge.js";
import { HermesClient, parseChatCompletion } from "../src/hermes-client.js";
import { Envelope } from "../src/envelope.js";

function dm(text: string, source = "agent-a"): Envelope {
  return {
    version: 1,
    action: "message",
    source,
    to: "hermes",
    ts: "2026-07-08T18:00:00.000Z",
    payload: { register: "talk", text },
  };
}

test("parseHermesBridgeArgs: --hermes-url (space form) + defaults", () => {
  const got = parseHermesBridgeArgs(["--hermes-url", "http://host:8080"]);
  expect(got.baseUrl).toBe("http://host:8080");
  expect(got.model).toBeUndefined();
  expect(got.sessionId).toBeUndefined();
  expect(got.sessionPrefix).toBe("work-relay:");
});

test("parseHermesBridgeArgs: equals form + model + session-id + prefix", () => {
  const got = parseHermesBridgeArgs([
    "--hermes-url=http://h:9",
    "--model=openrouter:anthropic/claude-sonnet-4.6",
    "--session-id=shared-1",
    "--session-prefix=fleet:",
  ]);
  expect(got.baseUrl).toBe("http://h:9");
  expect(got.model).toBe("openrouter:anthropic/claude-sonnet-4.6");
  expect(got.sessionId).toBe("shared-1");
  expect(got.sessionPrefix).toBe("fleet:");
});

test("parseHermesBridgeArgs: rejects missing --hermes-url", () => {
  expect(() => parseHermesBridgeArgs(["--model", "x"])).toThrow(/--hermes-url/);
});

test("sessionFor: fixed session-id wins for all envelopes", () => {
  const args = { sessionId: "shared", sessionPrefix: "work-relay:" };
  expect(sessionFor(args, dm("a", "agent-a"))).toBe("shared");
  expect(sessionFor(args, dm("b", "agent-b"))).toBe("shared");
});

test("sessionFor: per-source when no fixed session-id", () => {
  const args = { sessionId: undefined, sessionPrefix: "work-relay:" };
  expect(sessionFor(args, dm("a", "agent-a"))).toBe("work-relay:agent-a");
  expect(sessionFor(args, dm("b", "agent-b"))).toBe("work-relay:agent-b");
});

test("sessionFor: per-room scope for group envelopes", () => {
  const env: Envelope = {
    version: 1,
    action: "message",
    source: "agent-a",
    to: "general",
    ts: "2026-07-08T18:00:00.000Z",
    room: "general",
    payload: { register: "talk", text: "hi" },
  };
  expect(sessionFor({ sessionPrefix: "work-relay:" }, env)).toBe("work-relay:room:general");
});

test("formatHermesInput: direct route includes sender + register, no tool line", () => {
  const out = formatHermesInput(dm("Bridge probe", "agent-a"));
  expect(out).toBe(
    [
      "Work-relay bus message",
      "from: agent-a",
      "route: direct",
      "register: talk",
      "",
      "Bridge probe",
    ].join("\n"),
  );
  expect(out).not.toContain("send_message");
});

test("formatHermesInput: group route surfaces room + register", () => {
  const env: Envelope = {
    version: 1,
    action: "message",
    source: "agent-a",
    to: "general",
    ts: "2026-07-08T18:01:00.000Z",
    room: "general",
    payload: { register: "command", text: "review this" },
  };
  const out = formatHermesInput(env);
  expect(out).toContain("route: group");
  expect(out).toContain("room: general");
  expect(out).toContain("register: command");
  expect(out).toContain("review this");
});

test("parseChatCompletion: string content", () => {
  expect(
    parseChatCompletion({ choices: [{ message: { role: "assistant", content: "hello" } }] }),
  ).toBe("hello");
});

test("parseChatCompletion: array-of-parts content", () => {
  expect(
    parseChatCompletion({
      choices: [{ message: { content: [{ type: "text", text: "foo" }, { type: "text", text: "bar" }] } }],
    }),
  ).toBe("foobar");
});

test("parseChatCompletion: missing/empty shapes return null", () => {
  expect(parseChatCompletion(null)).toBeNull();
  expect(parseChatCompletion({})).toBeNull();
  expect(parseChatCompletion({ choices: [] })).toBeNull();
  expect(parseChatCompletion({ choices: [{}] })).toBeNull();
  expect(parseChatCompletion({ choices: [{ message: {} }] })).toBeNull();
});

test("HermesClient.chat: sends OpenAI shape + headers, returns parsed reply", async () => {
  const captured: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const client = new HermesClient({
    baseUrl: "http://host:8080/",
    apiKey: "secret-token",
    sessionKey: "sess-key",
    model: "claude-opus-4-8",
    fetchImpl,
  });

  const res = await client.chat("work-relay:agent-a", "ping");
  expect(res.text).toBe("pong");

  expect(captured).toHaveLength(1);
  // Trailing slash on baseUrl normalized; /v1 path appended once.
  expect(captured[0].url).toBe("http://host:8080/v1/chat/completions");

  const headers = captured[0].init.headers as Record<string, string>;
  expect(headers["x-hermes-session-id"]).toBe("work-relay:agent-a");
  expect(headers["authorization"]).toBe("Bearer secret-token");
  expect(headers["x-hermes-session-key"]).toBe("sess-key");

  const body = JSON.parse(String(captured[0].init.body));
  expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  expect(body.model).toBe("claude-opus-4-8");
  expect(body.stream).toBe(false);
});

test("HermesClient.chat: omits auth headers + model when not configured", async () => {
  let capturedInit: RequestInit = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedInit = init ?? {};
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const client = new HermesClient({ baseUrl: "http://h:1", fetchImpl });
  await client.chat("s", "hi");

  const headers = capturedInit.headers as Record<string, string>;
  expect(headers["authorization"]).toBeUndefined();
  expect(headers["x-hermes-session-key"]).toBeUndefined();
  const body = JSON.parse(String(capturedInit.body));
  expect(body.model).toBeUndefined();
});

test("HermesClient.chat: HTTP error surfaces (fail-loud to the bridge)", async () => {
  const fetchImpl = (async () =>
    new Response("upstream boom", { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch;
  const client = new HermesClient({ baseUrl: "http://h:1", fetchImpl });
  await expect(client.chat("s", "hi")).rejects.toThrow(/HTTP 502/);
});

test("HermesClient.chat: unparseable body throws", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;
  const client = new HermesClient({ baseUrl: "http://h:1", fetchImpl });
  await expect(client.chat("s", "hi")).rejects.toThrow(/could not extract reply/);
});

test("HermesClient.health: true on 200, false on error/throw", async () => {
  const okFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  const badFetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  const throwFetch = (async () => {
    throw new Error("conn refused");
  }) as unknown as typeof fetch;

  expect(await new HermesClient({ baseUrl: "http://h:1", fetchImpl: okFetch }).health()).toBe(true);
  expect(await new HermesClient({ baseUrl: "http://h:1", fetchImpl: badFetch }).health()).toBe(false);
  expect(await new HermesClient({ baseUrl: "http://h:1", fetchImpl: throwFetch }).health()).toBe(false);
});

test("HermesClient: base URL ending in /v1 is not doubled", async () => {
  const captured: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    captured.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new HermesClient({ baseUrl: "http://h:1/v1", fetchImpl });
  await client.chat("s", "hi");
  expect(captured[0]).toBe("http://h:1/v1/chat/completions");
});
