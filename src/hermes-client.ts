/**
 * Thin HTTP client for a Hermes Agent's OpenAI-compatible API server
 * (NousResearch/hermes-agent, `gateway/platforms/api_server.py`). One
 * request per bus envelope: POST /v1/chat/completions with the envelope
 * text as a user message and an `X-Hermes-Session-Id` header so Hermes
 * keeps server-side conversation continuity. Returns the assistant reply.
 *
 * Fully config-driven — base URL, optional bearer key, optional session
 * key, optional model, and timeout all come from the bridge args/env.
 * Nothing about a specific Hermes deployment is hardcoded, so the same
 * binary bridges any Hermes agent.
 *
 * `fetchImpl` is an injection point for tests: production uses the global
 * `fetch`; tests pass a fake that returns canned Responses without a
 * network round-trip.
 */

export interface HermesClientOptions {
  /** Hermes API server base URL, e.g. `http://host:8080`. A trailing
   * `/` (or `/v1`) is tolerated — the client normalizes it. */
  baseUrl: string;
  /** Optional bearer token → `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** Optional Hermes session key → `X-Hermes-Session-Key`. */
  sessionKey?: string;
  /** Optional model override; omitted → Hermes uses its configured model. */
  model?: string;
  /** Per-request timeout in ms (default 120000). */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ChatResult {
  text: string;
}

export class HermesClient {
  constructor(private readonly opts: HermesClientOptions) {}

  /** Join the base URL with an API path, tolerating a trailing `/` or a
   * base that already ends in `/v1`. */
  private url(apiPath: string): string {
    let base = this.opts.baseUrl.replace(/\/+$/, "");
    if (base.endsWith("/v1")) base = base.slice(0, -"/v1".length);
    return `${base}${apiPath}`;
  }

  private headers(sessionId: string): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "x-hermes-session-id": sessionId,
    };
    if (this.opts.apiKey) h["authorization"] = `Bearer ${this.opts.apiKey}`;
    if (this.opts.sessionKey) h["x-hermes-session-key"] = this.opts.sessionKey;
    return h;
  }

  /** Send one user message to Hermes on the given session and return the
   * assistant reply text. Throws on HTTP error or an unparseable body —
   * the bridge logs + skips (fail-soft) so a transient Hermes blip never
   * tears down the bus subscription. */
  async chat(sessionId: string, text: string): Promise<ChatResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: text }],
      stream: false,
    };
    if (this.opts.model) body.model = this.opts.model;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 120000);
    let resp: Response;
    try {
      resp = await f(this.url("/v1/chat/completions"), {
        method: "POST",
        headers: this.headers(sessionId),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `hermes chat failed: HTTP ${resp.status} ${resp.statusText}` +
          (detail ? ` — ${detail.slice(0, 500)}` : ""),
      );
    }

    const json = await resp.json();
    const replyText = parseChatCompletion(json);
    if (replyText === null) {
      throw new Error(
        `hermes chat: could not extract reply from response: ${JSON.stringify(json).slice(0, 500)}`,
      );
    }
    return { text: replyText };
  }

  /** Best-effort liveness probe against `/health`. Never throws — returns
   * false on any error so the bridge can log a warning without aborting. */
  async health(): Promise<boolean> {
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const resp = await f(this.url("/health"), {
        method: "GET",
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Extract the assistant reply text from an OpenAI-compatible chat
 * completion response. Handles both string `content` and the array-of-
 * parts shape some servers emit. Returns null when no text can be found
 * (caller treats null as "no reply").
 */
export function parseChatCompletion(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;

  if (typeof content === "string") return content;

  // OpenAI-compatible servers sometimes return content as an array of
  // parts ({type, text}); concatenate the text parts.
  if (Array.isArray(content)) {
    const parts = content
      .map((p) =>
        p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string"
          ? ((p as Record<string, unknown>).text as string)
          : "",
      )
      .filter((s) => s.length > 0);
    if (parts.length) return parts.join("");
  }

  return null;
}
