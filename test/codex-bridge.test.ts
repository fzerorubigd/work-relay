/**
 * Smoke tests for the codex-bridge subcommand:
 *   - argv parsing (positive + missing required flags)
 *   - CodexClient round-trips JSON-RPC against a fake unix-socket
 *     daemon (line-delimited JSON framing; correlation by id)
 *   - initialize + turn/start happy paths
 *   - socket-close failure surfaces (no silent envelope loss)
 *
 * The fake daemon implements just enough of the codex protocol to
 * exercise the bridge's request/response path: it reads one line
 * per JSON-RPC request, echoes a success response with method-
 * specific shape. Tests assert the wire format the bridge writes,
 * not codex-side semantics.
 */
import { test, expect, afterEach } from "bun:test";
import net from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { CodexClient } from "../src/codex-client.js";
import {
  formatBridgeInput,
  getTurnId,
  handleCodexNotification,
  hasNeverApprovalOverride,
  parseBridgeArgs,
} from "../src/codex-bridge.js";
import { Envelope } from "../src/envelope.js";

const sockets: { server: net.Server; path: string }[] = [];

afterEach(async () => {
  while (sockets.length) {
    const { server, path: p } = sockets.pop()!;
    // server.close() invokes its callback only AFTER all in-flight
    // connections drain — if a test already called close() manually
    // (the disconnect-mid-request case), the callback fires
    // immediately. listening() check guards the case where close()
    // was already called and the server isn't listening anymore.
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.unlink(p).catch(() => {});
  }
});

async function startFakeCodex(
  handler: (req: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-test-"));
  const sockPath = path.join(dir, "control.sock");
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as Record<string, unknown>;
        const resp = handler(req);
        if (req.id !== undefined) {
          conn.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...resp }) + "\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));
  sockets.push({ server, path: sockPath });
  return sockPath;
}

test("parseBridgeArgs: --codex-socket + --thread-id (space-separated)", () => {
  const got = parseBridgeArgs([
    "--codex-socket", "/tmp/foo.sock",
    "--thread-id", "thread-abc",
  ]);
  expect(got.socketPath).toBe("/tmp/foo.sock");
  expect(got.threadId).toBe("thread-abc");
  expect(got.codexArgs).toEqual([]);
});

test("parseBridgeArgs: --codex-socket=... + --thread-id=... (equals form)", () => {
  const got = parseBridgeArgs([
    "--codex-socket=/tmp/bar.sock",
    "--thread-id=thread-xyz",
  ]);
  expect(got.socketPath).toBe("/tmp/bar.sock");
  expect(got.threadId).toBe("thread-xyz");
  expect(got.codexArgs).toEqual([]);
});

test("parseBridgeArgs: passes args after -- to codex app-server", () => {
  const got = parseBridgeArgs([
    "--codex-socket", "stdio://",
    "--thread-id", "thread-abc",
    "--",
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="danger-full-access"',
  ]);

  expect(got.socketPath).toBe("stdio://");
  expect(got.threadId).toBe("thread-abc");
  expect(got.codexArgs).toEqual([
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="danger-full-access"',
  ]);
});

test("parseBridgeArgs: rejects missing --codex-socket", () => {
  expect(() => parseBridgeArgs(["--thread-id", "t"])).toThrow(/--codex-socket/);
});

test("parseBridgeArgs: rejects missing --thread-id", () => {
  expect(() => parseBridgeArgs(["--codex-socket", "/tmp/x.sock"])).toThrow(/--thread-id/);
});

test("hasNeverApprovalOverride: detects passthrough config", () => {
  expect(hasNeverApprovalOverride(["-c", 'approval_policy="never"'])).toBe(true);
  expect(hasNeverApprovalOverride(["--config", "approval_policy=never"])).toBe(true);
  expect(hasNeverApprovalOverride(["-c", 'approval_policy="on-request"'])).toBe(false);
});

test("formatBridgeInput: includes bus metadata and reply instruction", () => {
  const envelope: Envelope = {
    version: 1,
    action: "message",
    source: "yaad",
    to: "codex-test",
    ts: "2026-05-24T10:32:01.294Z",
    payload: {
      register: "talk",
      text: "Bridge probe",
    },
  };

  expect(formatBridgeInput(envelope)).toBe([
    "Work-relay bus message",
    "source: yaad",
    "to: codex-test",
    "register: talk",
    "timestamp: 2026-05-24T10:32:01.294Z",
    "route: direct",
    "",
    "Message:",
    "Bridge probe",
    "",
    'Reply on the bus with send_message(to: "yaad", register: "talk", text: ...).',
  ].join("\n"));
});

test("formatBridgeInput: preserves group-room route", () => {
  const envelope: Envelope = {
    version: 1,
    action: "message",
    source: "agent-a",
    to: "general",
    ts: "2026-05-24T10:35:00.000Z",
    room: "general",
    payload: {
      register: "command",
      text: "review this",
    },
  };

  expect(formatBridgeInput(envelope)).toContain("route: group");
  expect(formatBridgeInput(envelope)).toContain("room: general");
  expect(formatBridgeInput(envelope)).toContain("register: command");
  expect(formatBridgeInput(envelope)).toContain(
    'Reply on the bus with send_message(to: "agent-a", register: "talk", text: ...).',
  );
});

test("formatBridgeInput: respects no_reply envelopes", () => {
  const envelope: Envelope = {
    version: 1,
    action: "message",
    source: "elibion",
    to: "codex-test",
    ts: "2026-05-24T10:43:07Z",
    no_reply: true,
    payload: {
      register: "talk",
      text: "hello",
    },
  };

  expect(formatBridgeInput(envelope)).toContain(
    "The sender marked this envelope no_reply=true; do not send a bus reply unless the message explicitly asks for one.",
  );
});

test("getTurnId: extracts turn id from app-server result", () => {
  expect(getTurnId({ turnId: "turn-123" })).toBe("turn-123");
  expect(getTurnId({})).toBeNull();
  expect(getTurnId(null)).toBeNull();
});

test("handleCodexNotification: fallback-publishes agent text when send_message did not complete", async () => {
  const published: Envelope[] = [];
  const turnReplies = new Map<string, {
    envelope: Envelope;
    agentText: string;
    sentViaTool: boolean;
  }>([
    ["turn-123", {
      envelope: {
        version: 1,
        action: "message" as const,
        source: "yaad",
        to: "codex-test",
        ts: "2026-05-24T11:08:23.267Z",
        payload: {
          register: "talk" as const,
          text: "Third probe",
        },
      },
      agentText: "",
      sentViaTool: false,
    }],
  ]);

  await handleCodexNotification({
    method: "item/completed",
    params: {
      turnId: "turn-123",
      item: {
        type: "agentMessage",
        id: "item-1",
        text: "I received it.",
      },
    },
  }, turnReplies, {
    publishDirect: async (envelope: Envelope) => {
      published.push(envelope);
    },
  }, "codex-test");

  await handleCodexNotification({
    method: "turn/completed",
    params: {
      turn: {
        id: "turn-123",
        status: "completed",
      },
    },
  }, turnReplies, {
    publishDirect: async (envelope: Envelope) => {
      published.push(envelope);
    },
  }, "codex-test");

  expect(published).toHaveLength(1);
  expect(published[0].source).toBe("codex-test");
  expect(published[0].to).toBe("yaad");
  expect(published[0].payload.text).toBe("I received it.");
  expect(turnReplies.has("turn-123")).toBe(false);
});

test("handleCodexNotification: does not fallback when send_message completed", async () => {
  const published: Envelope[] = [];
  const turnReplies = new Map<string, {
    envelope: Envelope;
    agentText: string;
    sentViaTool: boolean;
  }>([
    ["turn-123", {
      envelope: {
        version: 1,
        action: "message" as const,
        source: "yaad",
        to: "codex-test",
        ts: "2026-05-24T11:08:23.267Z",
        payload: {
          register: "talk" as const,
          text: "Third probe",
        },
      },
      agentText: "I received it.",
      sentViaTool: false,
    }],
  ]);

  const bus = {
    publishDirect: async (envelope: Envelope) => {
      published.push(envelope);
    },
  };

  await handleCodexNotification({
    method: "item/completed",
    params: {
      turnId: "turn-123",
      item: {
        type: "mcpToolCall",
        id: "item-2",
        server: "work-relay",
        tool: "send_message",
        status: "completed",
      },
    },
  }, turnReplies, bus, "codex-test");

  await handleCodexNotification({
    method: "turn/completed",
    params: {
      turn: {
        id: "turn-123",
        status: "completed",
      },
    },
  }, turnReplies, bus, "codex-test");

  expect(published).toHaveLength(0);
});

test("CodexClient: initialize round-trips JSON-RPC against fake daemon", async () => {
  const captured: Record<string, unknown>[] = [];
  const sockPath = await startFakeCodex((req) => {
    captured.push(req);
    return { result: {} };
  });

  const client = new CodexClient();
  await client.connect(sockPath);
  await client.initialize();
  await new Promise((r) => setTimeout(r, 10));

  expect(captured).toHaveLength(2);
  expect(captured[0].method).toBe("initialize");
  expect((captured[0].params as Record<string, unknown>).capabilities).toEqual({
    experimentalApi: true,
  });
  expect((captured[0].params as Record<string, unknown>).clientInfo).toEqual({
    name: "work-relay",
    version: "0.1.0",
  });
  expect(captured[1].method).toBe("initialized");
  client.disconnect();
});

test("CodexClient: turn/start sends threadId + input + returns result", async () => {
  const captured: Record<string, unknown>[] = [];
  const sockPath = await startFakeCodex((req) => {
    captured.push(req);
    return { result: { turnId: "turn-001" } };
  });

  const client = new CodexClient();
  await client.connect(sockPath);
  const result = await client.turnStart("thread-X", "hello from bus");

  expect(captured).toHaveLength(1);
  expect(captured[0].method).toBe("turn/start");
  expect(captured[0].params).toEqual({
    threadId: "thread-X",
    input: [{ type: "text", text: "hello from bus" }],
  });
  expect(result).toEqual({ turnId: "turn-001" });
  client.disconnect();
});

test("CodexClient: turn/start can override approval policy", async () => {
  const captured: Record<string, unknown>[] = [];
  const sockPath = await startFakeCodex((req) => {
    captured.push(req);
    return { result: { turnId: "turn-001" } };
  });

  const client = new CodexClient();
  await client.connect(sockPath);
  await client.turnStart("thread-X", "hello from bus", { approvalPolicy: "never" });

  expect(captured[0].params).toEqual({
    threadId: "thread-X",
    input: [{ type: "text", text: "hello from bus" }],
    approvalPolicy: "never",
  });
  client.disconnect();
});

test("CodexClient: resumeThread can override approval policy", async () => {
  const captured: Record<string, unknown>[] = [];
  const sockPath = await startFakeCodex((req) => {
    captured.push(req);
    return { result: { threadId: "thread-X" } };
  });

  const client = new CodexClient();
  await client.connect(sockPath);
  await client.resumeThread("thread-X", { approvalPolicy: "never" });

  expect(captured[0].params).toEqual({
    threadId: "thread-X",
    approvalPolicy: "never",
    persistExtendedHistory: false,
  });
  client.disconnect();
});

test("CodexClient: rpc-error response rejects the request promise", async () => {
  const sockPath = await startFakeCodex(() => ({
    error: { code: -32601, message: "Method not found" },
  }));
  const client = new CodexClient();
  await client.connect(sockPath);
  await expect(client.request("nope.method")).rejects.toThrow(/Method not found/);
  client.disconnect();
});

test("CodexClient: response with unknown id is dropped without error event", async () => {
  const client = new CodexClient();

  let sawError = false;
  client.on("error", () => {
    sawError = true;
  });
  (client as unknown as { dispatch: (msg: Record<string, unknown>) => void }).dispatch({
    jsonrpc: "2.0",
    id: 0,
    result: {},
  });
  await new Promise((r) => setTimeout(r, 10));

  expect(sawError).toBe(false);
});

test("CodexClient: server approval request gets an auto-accept response when enabled", async () => {
  const frames: string[] = [];
  const client = new CodexClient();
  client.setAutoApproveServerRequests(true);
  (client as unknown as { writer: { write: (frame: string) => void } }).writer = {
    write: (frame: string) => {
      frames.push(frame.trim());
    },
  };

  (client as unknown as { dispatch: (msg: Record<string, unknown>) => void }).dispatch({
    jsonrpc: "2.0",
    id: 0,
    method: "item/commandExecution/requestApproval",
    params: {},
  });
  await new Promise((r) => setTimeout(r, 10));

  expect(JSON.parse(frames[0])).toEqual({
    jsonrpc: "2.0",
    id: 0,
    result: { decision: "accept" },
  });
});

test("CodexClient: MCP form elicitation gets auto-accepted when enabled", async () => {
  const frames: string[] = [];
  const client = new CodexClient();
  client.setAutoApproveServerRequests(true);
  (client as unknown as { writer: { write: (frame: string) => void } }).writer = {
    write: (frame: string) => {
      frames.push(frame.trim());
    },
  };

  (client as unknown as { dispatch: (msg: Record<string, unknown>) => void }).dispatch({
    jsonrpc: "2.0",
    id: 0,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-X",
      turnId: "turn-X",
      serverName: "work-relay",
      mode: "form",
      message: "Approve MCP tool call?",
      _meta: null,
      requestedSchema: {
        type: "object",
        properties: {
          allow: { type: "boolean" },
          scope: { type: "string", enum: ["turn", "session"] },
        },
        required: ["allow", "scope"],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 10));

  expect(JSON.parse(frames[0])).toEqual({
    jsonrpc: "2.0",
    id: 0,
    result: {
      action: "accept",
      content: { allow: true, scope: "turn" },
      _meta: null,
    },
  });
});

test("CodexClient: socket close mid-request rejects pending + emits close", async () => {
  // Server tracks the live connection so the test can destroy it
  // mid-request (server.close() alone doesn't drop existing
  // connections — daemon-vanish simulation needs an explicit
  // socket.destroy()).
  const conns: net.Socket[] = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-test-"));
  const sockPath = path.join(dir, "control.sock");
  const server = net.createServer((conn) => {
    conns.push(conn);
    conn.on("data", () => {
      // Swallow — never responds. The test triggers daemon-vanish
      // by destroying the connection from the server side.
    });
    conn.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));
  sockets.push({ server, path: sockPath });

  const client = new CodexClient();
  await client.connect(sockPath);

  let closed = false;
  client.on("close", () => {
    closed = true;
  });
  // Suppress the error event the disconnect raises so the test
  // process doesn't see an unhandled-error from EventEmitter.
  client.on("error", () => {});

  const inFlight = client.request("turn/start", { threadId: "t", input: "x" });
  await new Promise((r) => setTimeout(r, 10));
  // Daemon vanish: destroy the server-side connection.
  for (const c of conns) c.destroy();

  await expect(inFlight).rejects.toThrow();
  await new Promise((r) => setTimeout(r, 10));
  expect(closed).toBe(true);
});
