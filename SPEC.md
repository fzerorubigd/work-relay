# work-relay — protocol spec

Working spec for the MCP tool surface, MQTT envelope shape, and the channel-notification protocol used to surface inbound messages to a Claude Code session. Locked once v0 ships.

## MCP tools

### `send_message(to, text, register)`

Send a direct message to another agent.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `to` | string | yes | Recipient agent id, or `*` for broadcast |
| `text` | string | yes | Message body |
| `register` | enum | no (default `talk`) | One of `talk`, `command` |

Publishes to MQTT topic `bus/agents/<to>`. For `*`, publishes to `bus/agents/broadcast`.

Returns `{ ok: true, ts: "<iso8601>" }` on success.

Rejects with an error if `register` is anything other than `talk` or `command`.

### `send_group(room, text, register)`

Send a message to a named group room. Sender does not need to be subscribed to the room to send to it.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `room` | string | yes | Room name (alphanumeric + `-` + `_`, 1–64 chars) |
| `text` | string | yes | Message body |
| `register` | enum | no (default `talk`) | One of `talk`, `command` |

Publishes to MQTT topic `bus/agents/groups/<room>`.

Returns `{ ok: true, ts: "<iso8601>" }`.

### `subscribe(rooms)`

Join one or more group rooms. The MCP server adds MQTT subscriptions for each room and starts surfacing incoming messages to the agent.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `rooms` | string[] | yes | Room names |

Returns `{ ok: true, subscribed: [...] }` with the list of currently-subscribed rooms (post-subscribe).

Idempotent: subscribing to an already-subscribed room is a no-op.

### `leave(rooms)`

Leave one or more group rooms.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `rooms` | string[] | yes | Room names |

Returns `{ ok: true, subscribed: [...] }` with the list of currently-subscribed rooms (post-leave).

Idempotent.

## MQTT topics

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `bus/agents/<my-id>` | subscribe | Direct messages to this agent |
| `bus/agents/broadcast` | subscribe | Broadcasts to all agents |
| `bus/agents/groups/<room>` | subscribe (when joined) | Group room traffic |
| `bus/agents/<recipient>` | publish | Outgoing direct message |
| `bus/agents/broadcast` | publish | Outgoing broadcast (sender uses `to: "*"`; topic is rewritten from `bus/agents/*`) |
| `bus/agents/groups/<room>` | publish | Outgoing group message |

Broadcast convention: producers that want to reach all agents set the envelope's `to` field to `"*"` and publish on the literal topic `bus/agents/broadcast`. They do **not** publish on `bus/agents/*` — that would be an MQTT topic with a literal `*` segment, which subscribers do not listen on. Every relay/CLI that emits broadcasts must perform this rewrite (`to == "*"` → topic `bus/agents/broadcast`).

## Envelope (wire format)

JSON, UTF-8, single object per MQTT message. Compatible with the broader bus envelope shape.

```json
{
  "version": 1,
  "action": "message",
  "source": "<agent-id>",
  "to": "<agent-id-or-room>",
  "ts": "<iso8601-utc>",
  "payload": {
    "register": "talk" | "command",
    "text": "<utf-8 string>"
  },
  "room": "<room-name, group messages only>",
  "no_reply": true
}
```

Field meanings:

- `version` — protocol version. v0 of work-relay produces and accepts only `1`.
- `action` — v1 defines only `message`. work-relay produces only `message` and rejects unknown actions on receive (forward-compat).
- `source` — sender's agent id.
- `to` — recipient's agent id, or the room name for group messages.
- `ts` — ISO-8601 UTC timestamp.
- `payload` — action-specific body. For `message`, contains `register` and `text`.
- `room` — present only for group messages.
- `no_reply` — optional. When `true`, the receiver should not attempt to back-reply via this channel. Set by one-shot publishers (e.g. `cmd/bus-send`) that have no inbox to receive a response on. Receivers may still process the message normally; they just suppress automatic acks/replies.

### Forward compatibility

v1 of the protocol defines only the `message` action. work-relay produces only `message`-action envelopes and accepts only `message`-action envelopes on receive. Receivers MUST drop unknown actions silently — future protocol versions may add more, and old clients are expected to ignore what they don't understand without error.

## Receive-side filtering

When `work-relay` receives a message on a subscribed topic:

1. Parse the envelope as JSON. If parsing fails → drop.
2. If `version` is not `1` → drop.
3. If `action` is not `"message"` → drop. This is the load-bearing forward-compat filter; future protocol versions may add action types that v1 receivers must ignore cleanly.
4. If `source` or `to` is missing or not a string → drop.
5. If `payload` is missing or not an object → drop.
6. If `payload.register` is not `"talk"` or `"command"` → drop.
7. If `payload.text` is missing or not a string → drop.
8. Strip any extra top-level fields beyond `{version, action, source, to, ts, payload, room, no_reply}` and any extra payload fields beyond `{register, text}` — surface a clean envelope to the agent. `no_reply` is preserved only when it is a boolean.

The intent: work-relay processes only well-shaped v1 envelopes. The filter operates at the action layer (rejecting non-`message` actions, forward-compat for future action types) and the register layer (rejecting unknown registers), giving two structural defenses.

## Channel-notification protocol (host-facing)

work-relay declares the experimental `claude/channel` capability when constructing its MCP server:

```ts
new Server(
  { name: "work-relay", version: "..." },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
  }
);
```

For each filtered inbound envelope, work-relay sends an MCP JSON-RPC notification:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "[<source>] <text>",
    "meta": {
      "source": "work-relay",
      "action": "message",
      "from": "<envelope.source>",
      "to": "<envelope.to>",
      "ts": "<envelope.ts>",
      "payload": "<JSON-stringified envelope.payload>",
      "room": "<envelope.room, optional>"
    }
  }
}
```

### Why `meta.payload` is a JSON string, not an object

Claude Code's client-side validator (Zod schema) requires every value in `meta` to be a primitive. A nested object value triggers a transport-closing ZodError. work-relay therefore serializes `payload` to a JSON string before passing it through `meta`, and consumers must `JSON.parse(meta.payload)` to inspect the envelope's register and text.

### How a host renders the notification

A Claude Code session launched with `--dangerously-load-development-channels server:work-relay` consumes the notifications and renders each one as a channel block:

```
<channel source="work-relay" action="message" from="<source>" to="<to>" ts="..." payload="<JSON-string>">
[<source>] <text>
</channel>
```

`source="work-relay"` identifies the channel server; `from` is the envelope sender; `payload` is the JSON-stringified payload that the consumer parses to access `register` and `text`.

## Error responses

All four tools return errors in the form:

```json
{ "ok": false, "error": "<machine-readable code>", "message": "<human-readable>" }
```

Codes:

| Code | Meaning |
|------|---------|
| `invalid_register` | `register` was not `talk` or `command` |
| `invalid_room` | room name violates the format rules |
| `invalid_argument` | required field missing or wrong type |
| `not_subscribed` | (reserved for future use) |
| `broker_unavailable` | MQTT broker is unreachable |
| `rate_limited` | (reserved for future use) |
| `unknown_tool` | tool name not recognized |

## Out of scope for v0

- Authentication / authorization (every agent on the bus has equal trust)
- Rate limiting
- Persistent group room membership beyond the launch-arg seed (subscriptions are per-process; restart re-seeds from `--rooms` argv or `WORK_RELAY_ROOMS` env, but mid-session `subscribe()` additions don't survive a restart)
- Message replay / history (MQTT retain only — no full log)
- TLS to the broker (assumed handled at the broker layer if needed)

These are intentional v0 omissions, not oversights. They land cleanly later because the API surface is the chokepoint.
