# work-relay

Lightweight MCP server that lets AI agents talk to each other and run commands over a shared MQTT bus.

`work-relay` exposes four MCP tools — `send_message`, `send_group`, `subscribe`, `leave` — and surfaces incoming bus messages back to the agent's session as `<channel source="work-relay" ...>` blocks.

The `register` field is restricted to `talk` or `command`. The relay drops any other register and any non-`message` action from the receive surface, even if other clients on the bus publish them.

## Why

Multi-agent setups need a transport that:

1. **Is independent of any single AI provider.** Agents from different models, vendors, or even local processes should be able to talk to each other without either side knowing the other's runtime.
2. **Survives long-lived sessions.** MQTT-with-retained-messages means an agent that disconnects and reconnects sees the recent state, not a black hole.
3. **Has a small, predictable tool surface.** The MCP-side API is four functions. The whole protocol fits on a page.

work-relay is not a full coordination layer — there's no consensus, no transactions, no scheduling. It's a message bus with structure: who, to whom, what register, what room.

## Architecture

```
agent-a (claude)        agent-b (claude)         worker-1 (cli)
     │                        │                        │
     │ MCP                    │ MCP                    │ MCP
     ▼                        ▼                        ▼
work-relay (process)     work-relay (process)     work-relay (process)
     │                        │                        │
     └────────────────────────┴────────────────────────┘
                            MQTT broker
                       topic: bus/agents/<id>
                       topic: bus/agents/groups/<room>
```

Each agent runs its own `work-relay` process. The process subscribes to:

- `bus/agents/<my-id>` — direct messages addressed to this agent
- `bus/agents/broadcast` — broadcasts
- `bus/agents/groups/<room>` — for each room this agent has subscribed to

Outgoing messages publish to `bus/agents/<recipient-id>` (direct) or `bus/agents/groups/<room>` (group).

## Envelope

```json
{
  "version": 1,
  "action": "message",
  "source": "agent-a",
  "to": "agent-b",
  "ts": "2026-01-01T00:00:00Z",
  "payload": {
    "register": "talk",
    "text": "build started"
  }
}
```

Fields:

- `version` — protocol version (work-relay v0 only handles `1`)
- `action` — work-relay only produces and accepts `"message"`. Other actions on the same bus are silently dropped on receive.
- `source` — sender's agent id
- `to` — recipient's agent id, or the room name for group messages
- `ts` — ISO-8601 UTC timestamp
- `payload.register` — `talk` for conversational, `command` for instructions/orders
- `payload.text` — message body, plain text

Group-message envelopes additionally carry top-level `room: "<name>"`. Direct-message envelopes omit the field.

See [SPEC.md](./SPEC.md) for the full wire spec, filter rules, and channel-notification protocol.

## Two-layer envelope filter

work-relay accepts and forwards only well-shaped v1 envelopes:

1. **Action layer.** If the envelope's `action` isn't `"message"`, the envelope is dropped before any payload inspection. The v1 surface defines only the `message` action; future versions can add more.
2. **Register layer.** If `payload.register` isn't `"talk"` or `"command"`, the envelope is dropped.

Combined: an agent connected via work-relay processes only well-shaped v1 envelopes; anything else on the bus is forward-compat noise that the relay silently drops.

## Install

```bash
git clone https://github.com/fzerorubigd/work-relay.git
cd work-relay
bun install
```

Full setup, configuration, Claude Code integration, and verification: see [INSTALL.md](./INSTALL.md).

## Configure

`work-relay` reads its config from environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `WORK_RELAY_AGENT_ID` | (required) | This agent's id (e.g. `agent-a`) |
| `WORK_RELAY_BROKER` | `mqtt://localhost:1883` | MQTT broker URL |
| `WORK_RELAY_BROKER_USER` | (none) | MQTT username |
| `WORK_RELAY_BROKER_PASS` | (none) | MQTT password |
| `WORK_RELAY_ROOMS` | (none) | Comma-separated rooms to auto-subscribe at startup. Overridden by the `--rooms` argv flag when both are set. |
| `WORK_RELAY_PERSISTENT` | `false` | When `true`, use a stable client id with `clean: false` so the broker queues messages while this agent's relay is offline. Pair with `fetch_messages` for mailbox-shape workers. |
| `WORK_RELAY_BUFFER_CAP` | `100` | Max envelopes the in-memory buffer holds before dropping the oldest. Buffer is read by `fetch_messages`. |

### Initial room subscriptions (`--rooms` / `WORK_RELAY_ROOMS`)

Both `--rooms=foo,bar` (argv) and `WORK_RELAY_ROOMS=foo,bar` (env) seed the agent's group-room subscriptions on connect, so room membership survives restarts without an explicit `subscribe()` MCP call after every reconnect. Argv takes precedence over env when both are set (standard CLI shape).

```bash
# argv
bun run src/index.ts --rooms=general,review

# argv with separated value
bun run src/index.ts --rooms general,review

# env (or in the MCP server entry)
WORK_RELAY_ROOMS=general,review bun run src/index.ts
```

Names are validated against the room-name regex (`^[A-Za-z0-9_-]{1,64}$`); invalid entries are dropped with a stderr warning, valid ones still subscribe — one bad name doesn't fail the whole list.

## Use it from Claude Code

work-relay needs **two pieces** of Claude Code wiring to be fully functional:

1. **MCP server entry** in `~/.claude.json` so the agent gets the four tools (`send_message`, `send_group`, `subscribe`, `leave`).
2. **Channel-server flag** at claude launch (`--dangerously-load-development-channels server:work-relay`) so inbound bus messages surface as `<channel ...>` blocks in the session.

Either piece without the other gives you a partial setup: tools without inbound, or inbound without tools. INSTALL.md walks through both.

```jsonc
// ~/.claude.json mcpServers entry
{
  "mcpServers": {
    "work-relay": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/work-relay/src/index.ts"],
      "env": {
        "WORK_RELAY_AGENT_ID": "agent-a",
        "WORK_RELAY_BROKER": "mqtt://broker.local:1883"
      }
    }
  }
}
```

```bash
# claude launch with channel-server enabled
claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:work-relay \
  --resume agent-a
```

## Verify the setup works

After install + both configs:

1. Start the agent's claude session with the cmdline above.
2. From a second machine on the same broker (or `mosquitto_pub` on this one), send a wire-format-correct envelope to this agent's topic:
   ```bash
   mosquitto_pub -h <broker> -p 1883 -t bus/agents/agent-a \
     -m '{"version":1,"action":"message","source":"test","to":"agent-a","ts":"2026-01-01T00:00:00Z","payload":{"register":"talk","text":"smoke test"}}'
   ```
3. The `<channel source="work-relay" action="message" from="test" to="agent-a" ...>` block should appear in the agent's session.
4. Have the agent call `send_message(to: "test-receiver", text: "ack from agent-a")` — confirm the receiver gets it.

If only step 4 works (outbound) but not step 3 (inbound): the channel-server flag is missing or the `experimental.claude/channel` MCP capability isn't declared. If only step 3 works but not step 4: the MCP server entry isn't in `.claude.json` or the path/env is wrong.

## Codex CLI bridge

The MCP server gives codex agents outbound (`send_message` works) but inbound only via mailbox-shape polling (`fetch_messages`) — codex's MCP client doesn't render server notifications as channel blocks. For real-time inbound, run the `codex-bridge` subcommand as a sidecar to the regular MCP registration:

```bash
WORK_RELAY_AGENT_ID=my-codex-agent \
WORK_RELAY_BROKER=mqtt://localhost:1883 \
  bun run src/index.ts codex-bridge \
    --codex-socket "$HOME/.codex/app-server-control/app-server-control.sock" \
    --thread-id "<persistent-thread-id>"
```

The bridge attaches to a running codex app-server via its unix-socket JSON-RPC control surface, sends `initialize` (with the required `experimentalApi: true` capability), then translates each inbound bus envelope into a `turn/start` call on the named thread. The codex agent processes the turn and emits its response via the already-registered `send_message` MCP tool. See [INSTALL.md §"Use from Codex CLI hosts"](./INSTALL.md#use-from-codex-cli-hosts) for the full walkthrough.

## Mailbox shape (`fetch_messages`)

For agents that don't (or can't) keep an always-on session — episodic workers fired by cron, hosts where `claude/channel` isn't surfacing inbound, etc. — `fetch_messages` exposes the same inbound stream as a tool result instead of a channel notification.

Set `WORK_RELAY_PERSISTENT=true` to make the broker queue messages for this agent while the relay is offline (stable client id, `clean: false`, QoS 1 subscriptions). On reconnect the broker delivers the queued messages, the relay buffers them in memory, and the agent calls `fetch_messages` to drain the buffer:

```jsonc
// returns
{
  "ok": true,
  "envelopes": [
    {
      "version": 1,
      "action": "message",
      "source": "agent-b",
      "to": "agent-a",
      "ts": "2026-05-01T08:55:00Z",
      "payload": { "register": "command", "text": "review PR #5" }
    }
  ],
  "buffered": 1,
  "remaining": 0
}
```

Pass `max` to limit how many are returned per call. Buffer is in-memory and ephemeral — dropping the oldest at the cap (`WORK_RELAY_BUFFER_CAP`, default 100). Durability of the not-yet-fetched-ones is the broker's job, gated on persistent-session + QoS 1 publishes.

Both surfaces (channel notifications and `fetch_messages`) are populated for every inbound envelope. Agents that have channels working can ignore `fetch_messages`; agents that don't can ignore the channel path. They don't conflict — fetch drains its own buffer.

### What happens if no one reads the queue?

Persistent-session queues are durable in MQTT, but **not infinite**. Three caps to be aware of:

- **`max_queued_messages`** (mosquitto default: **1000 per persistent session**). If a worker stays offline long enough that more than 1000 messages pile up for it, the broker silently drops the oldest. For low-volume agent traffic this is generous; for chatty buses, raise it.
- **`persistent_client_expiration`** (mosquitto default: **never**). If left at the default, orphaned sessions keep their queues forever. To garbage-collect agents that have permanently gone away, set something like `persistent_client_expiration 14d` in `mosquitto.conf`.
- **Broker restart**. By default, mosquitto keeps queues in memory only. If the broker process restarts without the disk-persistence options enabled, all queues are lost. Set both `persistence true` and `persistence_location /path/to/dir/` to survive restarts.

Recommended `mosquitto.conf` for a small multi-agent bus:

```conf
# durability
persistence true
persistence_location /var/lib/mosquitto/
autosave_interval 30

# keep persistent sessions for two weeks before GC
persistent_client_expiration 14d

# raise queue ceiling if traffic is bursty
max_queued_messages 5000
```

In practice, for a worker that fetches every few minutes, the only operational risk is a long broker outage with no on-disk persistence. Once that's configured, the queue is durable enough that an agent can be offline for hours or days and still process the backlog cleanly when it comes back.

## Room etiquette

Rooms are broadcast topics — every subscriber sees every message. The signal-to-noise ratio is the room's responsibility, not the relay's. Conventions that keep rooms useful:

- **Treat every post as visible to everyone subscribed.** Multiple humans + agents can be reading; assume the audience.
- **No ping-pong acknowledgements — on rooms or DMs.** "Got it" / "thanks" / a thumbs-up emoji is noise on either surface; the audit trail already records the fact. The underlying principle is: stay silent if you have nothing substantive to add, even when a post names you specifically. Being addressed is not a prompt to reply — it's a prompt to act if there's an action, and otherwise to do nothing.
- **Three audience shapes for room posts.** Every room post falls into one of three shapes; sender should know which shape they're sending, reader should know which shape applies to them:
  - **Addressed to all** — state changes everyone subscribed should see ("PR #N opened", "CI green", "merged"). The default for status pings.
  - **Addressed to a subset** — content meant for specific named members in the body ("alice, please rebase"; "bob, your eyes when bandwidth allows"). Other subscribers see it for context but it isn't for them, and they shouldn't reply.
  - **One-way info** — informational with no expected reply ("issue #N filed", "rolling back to v0.3"). Not a question, not a hand-off, just visibility.
- **Reply only with new content.** Across all three shapes: state changes (PR opened, CI green, approval landed, merged), substantive concerns, fresh information. Not courtesy, not closure.
- **Self-echo is dropped by the relay.** When you `subscribe(["foo"])` and then `send_group("foo", "...")`, your own message round-trips through the broker but the relay filters it out before the channel notification fires. You don't see your own posts; consumers see them once. Sender doesn't need to filter manually.
- **DMs for substantive 1:1 work.** When the conversation is genuinely point-to-point — design discussion, clarification questions, targeted status checks — use `send_message` instead of routing it through the room. The no-ping-pong rule still applies; a DM is for the substance, not the acknowledgement.

## Design choices

- **MQTT, not WebSockets / gRPC / REST.** MQTT's retain + last-will gives each agent the right amount of "what did I miss" without inventing it.
- **No authentication in v1.** Network-level isolation is the trust model. A future version can add per-agent tokens; the envelope shape doesn't have to change.
- **Action + register filter.** Two structural defenses against cross-traffic on a shared bus. Drops at the action layer (only `message` accepted) and again at the register layer (only `talk` / `command`).
- **Explicit room subscription.** Agents have to call `subscribe` before they receive group traffic. Implicit-on-publish was rejected because it makes membership accidental and leak-prone.
- **Channel notifications via MCP.** Inbound bus messages reach the agent through the MCP `notifications/claude/channel` JSON-RPC notification (gated on the `experimental.claude/channel` capability). The host renders these as `<channel ...>` blocks. Stderr-write was tried first and didn't work — the MCP transport treats stderr as logs.

## Status

v0. The MCP surface is stable; the envelope shape is stable; storage and broker config may evolve.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
