/**
 * Thin JSON-RPC client over either a unix-socket Duplex stream or a
 * `codex app-server --listen stdio://` child process. Line-delimited
 * JSON frames: one request or response per line.
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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export interface CodexTurnOptions {
  approvalPolicy?: "never";
}

export class CodexClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private writer: NodeJS.WritableStream | null = null;
  private requestId = 0;
  private pending = new Map<number, Pending>();
  private rxBuffer = "";
  private autoApproveServerRequests = false;

  setAutoApproveServerRequests(enabled: boolean): void {
    this.autoApproveServerRequests = enabled;
  }

  /** Connect to the codex app-server at the given unix-socket path, or
   * spawn a stdio app-server when socketPath is `stdio://`.
   * Resolves once the socket is open; rejects on connect-time error. */
  async connect(socketPath: string, appServerArgs: string[] = []): Promise<void> {
    if (socketPath === "stdio://") {
      const proc = spawn("codex", ["app-server", ...appServerArgs, "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;
      this.writer = proc.stdin;
      proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
      proc.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
      proc.on("error", (err) => this.emit("error", err));
      proc.on("close", () => {
        this.failAllPending(new Error("codex stdio app-server closed"));
        this.proc = null;
        this.writer = null;
        this.emit("close");
      });
      return;
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const onConnectError = (err: Error) => {
        reject(err);
      };
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.removeListener("error", onConnectError);
        this.socket = socket;
        this.writer = socket;
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("error", (err) => this.emit("error", err));
        socket.on("close", () => {
          this.failAllPending(new Error("codex socket closed"));
          this.socket = null;
          this.writer = null;
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
    const method = typeof msg.method === "string" ? msg.method : undefined;
    if (id !== undefined && method !== undefined) {
      this.handleServerRequest(id, method, msg.params);
      return;
    }

    if (id === undefined) {
      if (method !== undefined) {
        this.emit("notification", { method, params: msg.params });
      }
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      // Unsolicited response — warn and drop. Some Codex app-server builds
      // emit extra response frames during startup/initialization; they should
      // not tear down the bridge or lose subsequent bus envelopes.
      process.stderr.write(`codex-client: dropping response with unknown id ${id}\n`);
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

  private handleServerRequest(id: number, method: string, params: unknown): void {
    process.stderr.write(`codex-client: server request ${method} id ${id}\n`);
    process.stderr.write(`codex-client: server request params ${safeJson(params)}\n`);

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval": {
        this.respond(id, {
          decision: this.autoApproveServerRequests ? "accept" : "decline",
        });
        return;
      }

      case "item/fileChange/requestApproval":
      case "applyPatchApproval": {
        this.respond(id, {
          decision: this.autoApproveServerRequests ? "accept" : "decline",
        });
        return;
      }

      case "item/permissions/requestApproval": {
        if (!this.autoApproveServerRequests) {
          this.respondError(id, -32000, "permission request declined by work-relay bridge");
          return;
        }
        const requested =
          params && typeof params === "object"
            ? (params as { permissions?: { network?: unknown; fileSystem?: unknown } }).permissions
            : undefined;
        this.respond(id, {
          permissions: {
            ...(requested?.network ? { network: requested.network } : {}),
            ...(requested?.fileSystem ? { fileSystem: requested.fileSystem } : {}),
          },
          scope: "turn",
        });
        return;
      }

      case "item/tool/requestUserInput": {
        this.respond(id, { answers: {} });
        return;
      }

      case "mcpServer/elicitation/request": {
        const elicitation = parseMcpElicitation(params);
        if (!this.autoApproveServerRequests || elicitation?.mode !== "form") {
          this.respond(id, { action: "decline", content: null, _meta: null });
          return;
        }
        this.respond(id, {
          action: "accept",
          content: buildElicitationContent(elicitation.requestedSchema),
          _meta: null,
        });
        return;
      }

      default: {
        this.respondError(id, -32601, `work-relay bridge does not handle server request ${method}`);
      }
    }
  }

  /** Issue a JSON-RPC request. Resolves with the `result`; rejects on
   * RPC-error or socket failure. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.writer) return Promise.reject(new Error("codex-client: not connected"));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.writer!.write(frame + "\n", (err?: Error | null) => {
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
    await this.request("initialize", {
      clientInfo: { name: "work-relay", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  /** Start a turn on the given thread with the given user input. */
  async turnStart(
    threadId: string,
    input: string,
    options: CodexTurnOptions = {},
  ): Promise<unknown> {
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input }],
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    });
  }

  /** Load a persisted thread into this app-server process. */
  async resumeThread(
    threadId: string,
    options: CodexTurnOptions = {},
  ): Promise<unknown> {
    return this.request("thread/resume", {
      threadId,
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      persistExtendedHistory: false,
    });
  }

  disconnect(): void {
    if (this.socket) this.socket.end();
    if (this.proc) this.proc.kill("SIGTERM");
    this.socket = null;
    this.proc = null;
    this.writer = null;
  }

  private notify(method: string, params?: unknown): void {
    if (!this.writer) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writer.write(frame + "\n");
  }

  private respond(id: number, result: unknown): void {
    if (!this.writer) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, result });
    this.writer.write(frame + "\n");
  }

  private respondError(id: number, code: number, message: string): void {
    if (!this.writer) return;
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
    this.writer.write(frame + "\n");
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    return json.length > 2000 ? `${json.slice(0, 2000)}...` : json;
  } catch {
    return String(value);
  }
}

function parseMcpElicitation(params: unknown):
  | { mode: "form"; requestedSchema: Record<string, unknown> }
  | { mode: "url" }
  | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  if (p.mode === "url") return { mode: "url" };
  if (p.mode !== "form") return null;
  const schema = p.requestedSchema;
  if (!schema || typeof schema !== "object") return null;
  return { mode: "form", requestedSchema: schema as Record<string, unknown> };
}

function buildElicitationContent(schema: Record<string, unknown>): Record<string, unknown> {
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((k): k is string => typeof k === "string"))
    : new Set<string>();

  const content: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== "object") continue;
    const prop = raw as Record<string, unknown>;
    if (!required.has(key) && prop.default === undefined) continue;
    content[key] = elicitationDefaultValue(prop);
  }
  return content;
}

function elicitationDefaultValue(prop: Record<string, unknown>): unknown {
  if (prop.default !== undefined) return prop.default;

  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum[0];
  }
  if (Array.isArray(prop.oneOf) && prop.oneOf.length > 0) {
    const first = prop.oneOf[0];
    if (first && typeof first === "object" && "const" in first) {
      return (first as { const: unknown }).const;
    }
  }

  switch (prop.type) {
    case "boolean":
      return true;
    case "number":
    case "integer":
      return typeof prop.minimum === "number" ? prop.minimum : 0;
    case "string":
      return "";
    case "array":
      return [];
    default:
      return null;
  }
}
