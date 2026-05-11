# Installing work-relay

End-to-end setup: from a clean machine to a Claude Code agent that can both send messages on the bus AND receive them as `<channel>` blocks.

## Prerequisites

- **Bun 1.1 or later.** Check with `bun --version`. Install: <https://bun.sh>.
- **An MQTT broker on the network you want the agents to share.** Mosquitto is the simplest:
  ```bash
  # Debian/Ubuntu
  sudo apt install mosquitto mosquitto-clients
  sudo systemctl enable --now mosquitto
  # macOS
  brew install mosquitto
  brew services start mosquitto
  ```
  Default broker URL is `mqtt://localhost:1883`. The `mosquitto-clients` package gives you `mosquitto_pub` / `mosquitto_sub` for verification.
- **Claude Code installed** for the user that will run the agent. Per-user install: `curl -fsSL https://claude.ai/install.sh | bash`.

## Install from source

```bash
git clone https://github.com/fzerorubigd/work-relay.git
cd work-relay
bun install
```

That's it — no build step. Bun runs the TypeScript directly.

The package binary is exposed as `work-relay`; you can either:

- Run it from the repo: `bun run src/index.ts`
- Or `bun link` to put `work-relay` on your PATH globally:
  ```bash
  bun link
  # in another shell or after rehashing:
  bun link work-relay
  ```

Make sure `~/.bun/bin` is on your PATH (`echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc` if not).

## Configure environment

`work-relay` reads its configuration from environment variables. There is no config file.

| Variable                 | Required | Default                      | Notes                                                          |
|--------------------------|----------|------------------------------|----------------------------------------------------------------|
| `WORK_RELAY_AGENT_ID`    | yes      | —                            | This agent's id (e.g. `agent-a`)                               |
| `WORK_RELAY_BROKER`      | no       | `mqtt://localhost:1883`      | MQTT broker URL                                                |
| `WORK_RELAY_BROKER_USER` | no       | (anonymous)                  | Username, if the broker requires auth                          |
| `WORK_RELAY_BROKER_PASS` | no       | (anonymous)                  | Password, if the broker requires auth                          |
| `WORK_RELAY_ROOMS`       | no       | (none)                       | Comma-separated rooms to auto-subscribe at startup             |

Each agent must have a unique `WORK_RELAY_AGENT_ID` on the same broker.

## Wire it into Claude Code (two pieces required)

work-relay needs **both** of these for full functionality. Either alone gives you a partial setup.

### 1. MCP server — exposes the four tools

Add to `~/.claude.json` (the `mcpServers` block):

```jsonc
{
  "mcpServers": {
    "work-relay": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/work-relay/src/index.ts"],
      "env": {
        "WORK_RELAY_AGENT_ID": "your-agent-id",
        "WORK_RELAY_BROKER": "mqtt://your-broker:1883"
      }
    }
  }
}
```

Or via `claude mcp add`:

```bash
claude mcp add work-relay \
  --command bun \
  --args run \
  --args /absolute/path/to/work-relay/src/index.ts \
  --env WORK_RELAY_AGENT_ID=your-agent-id \
  --env WORK_RELAY_BROKER=mqtt://your-broker:1883
```

The repeated `--args` form passes one element to the spawned `args` array per flag; some shells handle the multi-flag form differently — the JSON config block above is the canonical form, and editing `~/.claude.json` directly is the safer route if anything looks off.

This makes the agent see four tools: `send_message`, `send_group`, `subscribe`, `leave`. **Outbound works after this.** Inbound doesn't yet.

### 2. Channel-server flag — surfaces inbound as `<channel>` blocks

Launch claude with:

```bash
claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:work-relay \
  --resume your-agent-id
```

The `--dangerously-load-development-channels server:work-relay` flag tells Claude Code to treat the `work-relay` MCP server (registered above) as a channel-source. work-relay declares the `experimental.claude/channel` capability and emits MCP `notifications/claude/channel` messages for every inbound bus envelope; Claude Code receives those notifications and renders them as `<channel ...>` blocks in the session.

**Both pieces together:** outbound via tool calls, inbound via channel blocks. That's the full functionality.

### Run unsupervised in tmux

For long-running agent sessions:

```bash
tmux new-session -d -s claude \
  'claude --dangerously-skip-permissions --dangerously-load-development-channels server:work-relay --resume your-agent-id'
```

Reattach later: `tmux attach -t claude`.

## Verify the setup

After both wiring pieces are in place and the claude session is running:

### Test 1 — outbound

In the agent's session, ask it to call:

```
send_message(to: "test-receiver", text: "outbound smoke test")
```

If the tool returns `{ok: true, ts: "..."}`, the agent published to `bus/agents/test-receiver` on the broker. Verify with `mosquitto_sub`:

```bash
mosquitto_sub -h localhost -p 1883 -t 'bus/agents/test-receiver' -v
```

You should see the JSON envelope land on the topic.

### Test 2 — inbound

In a different terminal:

```bash
mosquitto_pub -h localhost -p 1883 \
  -t bus/agents/your-agent-id \
  -m '{"version":1,"action":"message","source":"test","to":"your-agent-id","ts":"2026-01-01T00:00:00Z","payload":{"register":"talk","text":"inbound smoke test"}}'
```

The agent's claude session should now show:

```
<channel source="work-relay" action="message" from="test" to="your-agent-id" ts="..." payload="...">
[test] inbound smoke test
</channel>
```

If you see the `<channel>` block, full bidirectional setup is working.

## Common problems

| Symptom | Likely cause |
|---------|--------------|
| `Error: WORK_RELAY_AGENT_ID environment variable is required` at startup | env not passed to the bun process |
| `broker_unavailable` from tool calls | broker URL wrong or broker not running |
| Outbound works, inbound silently drops | `--dangerously-load-development-channels server:work-relay` flag missing on claude launch |
| Inbound works, outbound errors | `mcpServers.work-relay` entry missing in `~/.claude.json` or path wrong |
| Inbound publishes don't surface | wire shape mismatch — confirm publisher uses `version: 1`, `action: "message"`, nested `payload: {register, text}` |
| `invalid_register` from `send_message` | only `talk` and `command` are accepted; other registers rejected by design |
| Tools work but no `<channel>` blocks for inbound from a known-good publisher | the claude binary doesn't recognize `experimental.claude/channel`; check Claude Code version |

## Use from non-Claude-Code hosts

Other Claude Agent SDK / Claude API hosts: stdio MCP support is provided by the `@modelcontextprotocol/sdk` client. Spawn `work-relay` (via `bun run src/index.ts` or the linked binary) as a child process with the env above, then call the four tools the same way Claude Code does.

For non-MCP-aware clients (CLI scripts, Python tools), there's no built-in HTTP gateway in v0 — talk to the MQTT broker directly using the envelope shape documented in [SPEC.md](./SPEC.md). The relay's only job is the MCP-side ergonomics; nothing about the wire format depends on running through it.

Per-host instructions for other hosts will be added here as they come up.

## Run the tests

```bash
bun test
```

The test suite covers envelope filtering and room-name validation (no network — broker not required for tests).

## What changes when you upgrade

After `git pull` on a running install:

1. **Restart the bun work-relay process.** It's a child of the claude session — kill the bun PID and the claude session will respawn it on the next tool call. For a clean restart, kill claude (the bun child dies with it) and re-launch the tmux session.
2. **No `bun install` step needed** unless `package.json` changed (rare).
3. **Tests should still pass:** `bun test` after pull confirms.
