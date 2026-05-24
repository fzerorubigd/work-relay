#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { Bus } from "./bus.js";
import {
  ALLOWED_REGISTERS,
  Envelope,
  Register,
  buildEnvelope,
  formatPreview,
  isValidRoomName,
  shouldSuppressSelfEcho,
} from "./envelope.js";
import { runBridge } from "./codex-bridge.js";

const TOOLS = [
  {
    name: "send_message",
    description:
      "Send a direct message to another agent. Use `*` as `to` to broadcast.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent id, or `*` for broadcast" },
        text: { type: "string", description: "Message body" },
        register: {
          type: "string",
          enum: ["talk", "command"],
          description: "Defaults to `talk`. Use `command` for instructions.",
        },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "send_group",
    description: "Send a message to a named group room.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Room name (alphanumeric + - + _, 1–64 chars)",
        },
        text: { type: "string", description: "Message body" },
        register: {
          type: "string",
          enum: ["talk", "command"],
          description: "Defaults to `talk`.",
        },
      },
      required: ["room", "text"],
    },
  },
  {
    name: "subscribe",
    description: "Join one or more group rooms to start receiving their messages.",
    inputSchema: {
      type: "object",
      properties: {
        rooms: {
          type: "array",
          items: { type: "string" },
          description: "Room names to subscribe to",
        },
      },
      required: ["rooms"],
    },
  },
  {
    name: "leave",
    description: "Leave one or more group rooms.",
    inputSchema: {
      type: "object",
      properties: {
        rooms: {
          type: "array",
          items: { type: "string" },
          description: "Room names to leave",
        },
      },
      required: ["rooms"],
    },
  },
  {
    name: "fetch_messages",
    description:
      "Drain and return any inbound envelopes the relay has buffered since the last fetch. Use this in mailbox-shape workers (cron-fired or scheduled) that fetch + process queued messages instead of relying on push channels. Returns the envelopes as a JSON array via the standard MCP tool-result path; works even when claude/channel notification surfacing is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        max: {
          type: "integer",
          description: "Maximum envelopes to return in this fetch (default = full buffer).",
        },
      },
    },
  },
] as const;

interface ToolError {
  ok: false;
  error: string;
  message: string;
}

interface ToolOk {
  ok: true;
  ts?: string;
  subscribed?: string[];
  envelopes?: Envelope[];
  buffered?: number;
  remaining?: number;
}

function ok(extra: Omit<ToolOk, "ok"> = {}): ToolOk {
  return { ok: true, ...extra };
}

function err(code: string, message: string): ToolError {
  return { ok: false, error: code, message };
}

function asContent(result: ToolOk | ToolError) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: !result.ok,
  };
}

async function main() {
  // Subcommand router. The first positional arg (after the binary
  // path) routes between modes:
  //   - `codex-bridge` → run the codex-bridge translator (no MCP
  //     server attached; bridge translates bus envelopes into codex
  //     JSON-RPC turn/start calls).
  //   - default (no subcommand, or any other positional) → run the
  //     existing MCP server (stdio transport, tools surface) for
  //     backwards compatibility with the documented INSTALL.md
  //     entrypoint shape.
  const subcommand = process.argv[2];
  if (subcommand === "codex-bridge") {
    await runBridge(process.argv.slice(3));
    return;
  }

  const config = loadConfig();
  const bus = new Bus(config);
  await bus.connect();

  const server = new Server(
    { name: "work-relay", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        experimental: { "claude/channel": {} },
      },
    },
  );

  // Mailbox-shape buffer for `fetch_messages`. Always populated; the channel
  // notification path is best-effort and may be unavailable on hosts where
  // the claude/channel feature isn't active. `fetch_messages` lets a worker
  // pull from the buffer directly via the standard MCP tool-result path.
  const buffer: Envelope[] = [];

  bus.onMessage(async (envelope: Envelope, topic: string) => {
    // Drop our own room publishes when they round-trip through the
    // subscription (#7). Without this, every send_group on a room
    // we're subscribed to surfaces back as a notification — clutter
    // for the operator and false-feedback for the model. Silent
    // drop on the matching path; DMs and broadcasts are unaffected
    // by construction.
    if (shouldSuppressSelfEcho(topic, envelope.source, config.agentId)) {
      return;
    }

    // Buffer first — guaranteed delivery regardless of channel-feature state.
    buffer.push(envelope);
    if (buffer.length > config.bufferCap) {
      // Drop oldest. With `bufferCap = 100` (default) this is a generous
      // ceiling; persistent-session workers should fetch frequently enough
      // that the cap rarely fires.
      buffer.shift();
    }

    // Deliver incoming envelopes as MCP `notifications/claude/channel` so
    // the host renders them into <channel ...> blocks. This is best-effort:
    // older claude-code or hosts without the channels feature simply
    // discard the notification; the buffer above is the durable path.
    //
    // The `meta` object's values must be primitives — Claude's client-side
    // Zod validator rejects non-string values and closes the transport.
    // Serialize the payload object instead of passing it through directly.
    // Distinguish room posts from DMs in the preview text (#7) — see
    // formatPreview's doc for the wire shape.
    const preview = formatPreview(envelope);
    try {
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: preview,
          meta: {
            source: "work-relay",
            action: envelope.action,
            from: envelope.source,
            to: envelope.to,
            ts: envelope.ts,
            payload: JSON.stringify(envelope.payload),
            ...(envelope.room !== undefined ? { room: envelope.room } : {}),
          },
        },
      });
    } catch (e) {
      process.stderr.write(`work-relay: notification delivery failed: ${e}\n`);
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      case "send_message": {
        const to = String(args.to ?? "");
        const text = String(args.text ?? "");
        const register = (args.register ?? "talk") as Register;
        if (!ALLOWED_REGISTERS.has(register)) {
          return asContent(err("invalid_register", `register must be one of: talk, command`));
        }
        if (!to || !text) {
          return asContent(err("invalid_argument", "to and text are required"));
        }
        const envelope = buildEnvelope({ source: config.agentId, to, register, text });
        try {
          await bus.publishDirect(envelope);
          return asContent(ok({ ts: envelope.ts }));
        } catch (e) {
          return asContent(err("broker_unavailable", String(e)));
        }
      }

      case "send_group": {
        const room = String(args.room ?? "");
        const text = String(args.text ?? "");
        const register = (args.register ?? "talk") as Register;
        if (!ALLOWED_REGISTERS.has(register)) {
          return asContent(err("invalid_register", `register must be one of: talk, command`));
        }
        if (!isValidRoomName(room)) {
          return asContent(
            err("invalid_room", "room name must match [A-Za-z0-9_-]{1,64}"),
          );
        }
        if (!text) {
          return asContent(err("invalid_argument", "text is required"));
        }
        const envelope = buildEnvelope({
          source: config.agentId,
          to: room,
          register,
          text,
          room,
        });
        try {
          await bus.publishGroup(room, envelope);
          return asContent(ok({ ts: envelope.ts }));
        } catch (e) {
          return asContent(err("broker_unavailable", String(e)));
        }
      }

      case "subscribe": {
        const rooms = Array.isArray(args.rooms) ? args.rooms.map(String) : [];
        for (const r of rooms) {
          if (!isValidRoomName(r)) {
            return asContent(err("invalid_room", `invalid room: ${r}`));
          }
        }
        try {
          for (const r of rooms) await bus.subscribeRoom(r);
          return asContent(ok({ subscribed: bus.rooms() }));
        } catch (e) {
          return asContent(err("broker_unavailable", String(e)));
        }
      }

      case "leave": {
        const rooms = Array.isArray(args.rooms) ? args.rooms.map(String) : [];
        try {
          for (const r of rooms) await bus.leaveRoom(r);
          return asContent(ok({ subscribed: bus.rooms() }));
        } catch (e) {
          return asContent(err("broker_unavailable", String(e)));
        }
      }

      case "fetch_messages": {
        // `max` defaults to draining the entire buffer (unset/null/undefined).
        // An explicit `max: 0` returns an empty array — useful for callers
        // that want to peek at `remaining` without taking anything.
        // Negative or non-integer values fall back to drain-all.
        let max: number;
        if (args.max === undefined || args.max === null) {
          max = buffer.length;
        } else if (typeof args.max === "number" && Number.isFinite(args.max) && args.max >= 0) {
          max = Math.floor(args.max);
        } else {
          max = buffer.length;
        }
        const envelopes = buffer.splice(0, max);
        return asContent(
          ok({
            envelopes,
            buffered: envelopes.length,
            remaining: buffer.length,
          }),
        );
      }

      default:
        return asContent(err("unknown_tool", `no such tool: ${request.params.name}`));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await bus.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`work-relay fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
