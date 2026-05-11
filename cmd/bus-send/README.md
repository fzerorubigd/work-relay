# cmd/bus-send

One-shot Go CLI that publishes a single message envelope onto the work-relay
MQTT bus.

Full documentation — architecture, flag reference, install instructions, and
`no_reply` semantics — lives in [`../../docs/SKILL.md`](../../docs/SKILL.md).

Quick build:

```bash
go build -o bus-send .
./bus-send --agent <name> --message "hi"
```
