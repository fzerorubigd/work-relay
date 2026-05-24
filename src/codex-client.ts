/**
 * Thin JSON-RPC client over a unix-socket Duplex stream — the wire
 * format the codex app-server speaks per its `--listen` control-socket
 * shape. Line-delimited JSON frames: one request or response per line.
 *
 * Request/response correlation uses the standard JSON-RPC `id` field;
 * server-initiated notifications (no `id`) are ignored — the bridge is
 * a one-way translator (bus → codex) and doesn't subscribe to codex's
 * outbound notification stream.
 *
 * On socket close or error: the client emits `close` / `error`. The
 * bridge surfaces those as fail-loud exits per ADR-shape (no silent
 * envelope loss).
 */
import net from "node:net";
import { EventEmitter } from "node:events";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class CodexClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private requestId = 0;
  private pending = new Map<number, Pending>();
  private rxBuffer = "";

  /** Connect to the codex app-server at the given unix-socket path.
   * Resolves once the socket is open; rejects on connect-time error. */
  async connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const onConnectError = (err: Error) => {
        reject(err);
      };
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.removeListener("error", onConnectError);
        this.socket = socket;
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("error", (err) => this.emit("error", err));
        socket.on("close", () => {
          this.failAllPending(new Error("codex socket closed"));
          this.socket = null;
          this.emit("close");
        });
        resolve();
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.rxBuffer += chunk.toString("utf-8");
    let nl: number;
    while ((nl = this.rxBuffer.indexOf("\n")) >= 0) {
      const line = this.rxBuffer.slice(0, nl);
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.emit("error", new Error(`codex-client: malformed JSON frame: ${e}`));
        continue;
      }
      this.dispatch(msg as Record<string, unknown>);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = typeof msg.id === "number" ? msg.id : undefined;
    if (id === undefined) {
      // Server-initiated notification — ignored. Bridge is request/response only.
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      // Unsolicited response — log and drop.
      this.emit("error", new Error(`codex-client: response with unknown id ${id}`));
      return;
    }
    this.pending.delete(id);
    if (msg.error && typeof msg.error === "object" && msg.error !== null) {
      const errObj = msg.error as Record<string, unknown>;
      const message = typeof errObj.message === "string" ? errObj.message : "rpc error";
      pending.reject(new Error(message));
      return;
    }
    pending.resolve(msg.result);
  }

  /** Issue a JSON-RPC request. Resolves with the `result`; rejects on
   * RPC-error or socket failure. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket) return Promise.reject(new Error("codex-client: not connected"));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.socket!.write(frame + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Initialize handshake. Sets `capabilities.experimentalApi: true`
   * — required by codex's app-server for the `thread/inject_items`
   * + `turn/start` surface. */
  async initialize(): Promise<void> {
    await this.request("initialize", { capabilities: { experimentalApi: true } });
  }

  /** Start a turn on the given thread with the given user input. */
  async turnStart(threadId: string, input: string): Promise<unknown> {
    return this.request("turn/start", { threadId, input });
  }

  disconnect(): void {
    if (!this.socket) return;
    this.socket.end();
    this.socket = null;
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
