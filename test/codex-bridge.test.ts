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
import { parseBridgeArgs } from "../src/codex-bridge.js";

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
});

test("parseBridgeArgs: --codex-socket=... + --thread-id=... (equals form)", () => {
  const got = parseBridgeArgs([
    "--codex-socket=/tmp/bar.sock",
    "--thread-id=thread-xyz",
  ]);
  expect(got.socketPath).toBe("/tmp/bar.sock");
  expect(got.threadId).toBe("thread-xyz");
});

test("parseBridgeArgs: rejects missing --codex-socket", () => {
  expect(() => parseBridgeArgs(["--thread-id", "t"])).toThrow(/--codex-socket/);
});

test("parseBridgeArgs: rejects missing --thread-id", () => {
  expect(() => parseBridgeArgs(["--codex-socket", "/tmp/x.sock"])).toThrow(/--thread-id/);
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

test("CodexClient: rpc-error response rejects the request promise", async () => {
  const sockPath = await startFakeCodex(() => ({
    error: { code: -32601, message: "Method not found" },
  }));
  const client = new CodexClient();
  await client.connect(sockPath);
  await expect(client.request("nope.method")).rejects.toThrow(/Method not found/);
  client.disconnect();
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
