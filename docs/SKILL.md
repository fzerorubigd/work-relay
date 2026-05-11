# bus-send — one-shot publisher for the work-relay bus

`cmd/bus-send` is a small Go binary that publishes a single message envelope
onto the work-relay MQTT bus and exits. It is the "send a message and walk
away" companion to the long-running MCP server.

## Architecture

```
┌──────────────┐                  ┌──────────────┐                  ┌──────────────┐
│  bus-send    │  publish (QoS 0) │  MQTT broker │  subscribe (#)   │  subscriber  │
│  (this CLI)  │ ───────────────▶ │   (mqtt://   │ ───────────────▶ │  agent (MCP) │
│              │                  │  host:1883)  │                  │              │
└──────────────┘                  └──────────────┘                  └──────────────┘
```

- The broker, topic shape, and envelope wire format are defined in
  [`SPEC.md`](../SPEC.md). bus-send is a producer-only client that conforms to
  that wire format.
- Topics: direct messages publish to `bus/agents/<agent>`; broadcasts (`--agent
  '*'`) publish to `bus/agents/broadcast`.
- QoS 0, no retain — fire-and-forget. The CLI exits 0 once the message has been
  handed off to the broker, non-zero with a stderr message on connect or
  publish failure.

## CLI usage

```
bus-send --agent <name> [--message <text>] [flags...]
```

| Flag | Required | Default | Notes |
|------|----------|---------|-------|
| `--agent` | yes | — | Target agent id. `*` broadcasts to `bus/agents/broadcast`. |
| `--broker` | no | `$WORK_RELAY_BROKER` else `mqtt://localhost:1883` | MQTT broker URL. |
| `--register` | no | `talk` | One of `talk` or `command`. |
| `--message` | no | — | Message body. If absent, read from stdin. |
| `--source` | no | `os.Hostname()`, falling back to `bus-send` | Sender identity stamped on the envelope. |
| `--timeout` | no | `5s` | Combined deadline for connect + publish. |

### Examples

```bash
# Send a one-line message
bus-send --agent agent-b --message "build started"

# Pipe stdin (multi-line, command register)
git log --oneline -5 | bus-send --agent agent-b --register command

# Broadcast to all agents
bus-send --agent '*' --message "broker maintenance in 5m"

# Override the broker for a different bus
bus-send --broker mqtt://other-host:1883 --agent agent-b --message hi

# Tighter deadline if you want bus-send to fail fast
bus-send --agent agent-b --message hi --timeout 2s
```

## `no_reply` semantics

Every envelope bus-send publishes carries `"no_reply": true` at the top level.

The receiver should treat this as a hint: **process the message normally, but
do not attempt to back-reply via this channel.** bus-send is one-shot — it has
no inbox subscription open by the time a reply would be sent, so any reply
would be dropped at the MQTT layer or surface as a "delivered to nobody"
message in someone's logs.

The flag is purely advisory. Receivers that ignore it are not broken; they just
generate noise. Receivers that honor it should suppress automatic acks, "got
it" replies, or other reflex traffic when `no_reply === true`.

`no_reply` is an additive optional field on the v1 wire format — envelopes
without it behave as before. See [`SPEC.md`](../SPEC.md) for the canonical wire
shape.

## Install on a work machine

Prereqs:

1. **Network reach to the broker.** Whether that's `localhost`, a LAN host, a
   VPN-routed address, or a public hostname with TLS is a deployment choice —
   set `--broker` / `WORK_RELAY_BROKER` to whatever URL the broker is reachable
   at from the machine running bus-send.
2. **Go ≥ 1.24** — only needed at build time. The output binary is static and
   has no runtime dependencies. (Minimum is set by `paho.mqtt.golang` v1.5.1's
   own `go` directive; bump in lockstep if that dependency changes.)

Build:

```bash
git clone git@github.com:fzerorubigd/work-relay.git
cd work-relay/cmd/bus-send
go build -o bus-send .
sudo install bus-send /usr/local/bin/
```

Or cross-compile on another machine and `scp` the resulting binary —
`go build` produces a single static executable.

Verify:

```bash
bus-send --agent <your-agent-id> --message "hello from $(hostname)"
echo "exit=$?"
```

If exit is non-zero, the stderr line tells you whether the failure was at
connect (broker unreachable, auth, DNS) or publish (timed out before ack).

# Room etiquette

work-relay's MCP tools (`send_message`, `send_group`, `subscribe`, `leave`) let
agents talk over the same MQTT bus as `bus-send`, but with a long-running
session and inbound `<channel ...>` notifications. The `no_reply semantics`
section above covers one mechanism for suppressing reflex acknowledgements (the
`no_reply: true` envelope flag). The conventions below are the broader version:
even on envelopes without the flag, agents should follow these rules on rooms
and DMs alike.

## No ping-pong (rooms or DMs)

Don't send acknowledgement-only messages on either surface. "Got it" /
"thanks" / a thumbs-up is noise — the audit trail already records the fact.

The underlying rule: **being addressed is not a prompt to reply; it's a prompt
to act if there's an action, otherwise to do nothing.** This applies on
`send_group` (room posts) and `send_message` (DMs) equally. A DM is for the
substance, not the acknowledgement.

## Three audience shapes for room posts

Every room post falls into one of three shapes. The sender should know which
shape they're sending; the reader should know which shape applies to them.

- **Addressed to all** — state changes everyone subscribed should see ("PR #N
  opened", "CI green", "merged"). The default for status pings.
- **Addressed to a subset** — content meant for specific named members in the
  body ("alice, please rebase"; "bob, your eyes when bandwidth allows").
  Other subscribers see it for context but it isn't for them, and they
  shouldn't reply.
- **One-way info / broadcast** — informational with no expected reply ("issue
  #N filed", "rolling back to v0.3"). Not a question, not a hand-off, just
  visibility.

## Self-echo is dropped by the relay

When you `subscribe(["foo"])` and then `send_group("foo", "...")`, your own
message round-trips through the broker but the relay drops it before the
channel notification fires. You don't see your own posts; consumers see them
once. Sender doesn't need to filter manually.

## DMs vs rooms

Use a room when multiple agents should see the same content — that's the
broadcast surface. Use a DM (`send_message`) when the conversation is
genuinely 1:1 — design discussion, clarification questions, targeted status
checks. The no-ping-pong rule still applies in DMs.
