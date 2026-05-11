// Command bus-send publishes a single work-relay message envelope onto the
// MQTT bus and exits. Intended for one-shot use from any host that can reach
// the broker over the network.
//
// See docs/SKILL.md for architecture, install, and usage details.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

const (
	envelopeVersion = 1
	actionMessage   = "message"
	defaultBroker   = "mqtt://localhost:1883"
)

// agentIDRe constrains --agent to characters that are safe inside the
// bus/agents/<agent> topic — keeps `/`, `+`, `#`, and other MQTT-meaningful
// characters out. The literal `*` broadcast sentinel is handled before this
// regex is consulted.
var agentIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type payload struct {
	Register string `json:"register"`
	Text     string `json:"text"`
}

type envelope struct {
	Version int     `json:"version"`
	Action  string  `json:"action"`
	Source  string  `json:"source"`
	To      string  `json:"to"`
	TS      string  `json:"ts"`
	Payload payload `json:"payload"`
	NoReply bool    `json:"no_reply"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "bus-send:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		agent    = flag.String("agent", "", "target agent id (required); '*' broadcasts")
		broker   = flag.String("broker", "", "MQTT broker URL (default $WORK_RELAY_BROKER or "+defaultBroker+")")
		register = flag.String("register", "talk", "message register: talk|command")
		message  = flag.String("message", "", "message text; if empty, read from stdin")
		source   = flag.String("source", "", "source field on the envelope (default: hostname)")
		timeout  = flag.Duration("timeout", 5*time.Second, "deadline for connect+publish")
	)
	flag.Parse()

	if *agent == "" {
		return errors.New("--agent is required")
	}
	if *agent != "*" && !agentIDRe.MatchString(*agent) {
		return fmt.Errorf("--agent must be '*' or match %s, got %q", agentIDRe, *agent)
	}
	if *register != "talk" && *register != "command" {
		return fmt.Errorf("--register must be 'talk' or 'command', got %q", *register)
	}

	brokerURL := *broker
	if brokerURL == "" {
		brokerURL = os.Getenv("WORK_RELAY_BROKER")
	}
	if brokerURL == "" {
		brokerURL = defaultBroker
	}

	text := *message
	if text == "" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("read stdin: %w", err)
		}
		// Trim a single trailing newline — typical terminal artifact.
		text = strings.TrimSuffix(string(b), "\n")
	}
	if text == "" {
		return errors.New("message is empty (use --message or pipe text on stdin)")
	}

	src := *source
	if src == "" {
		if h, err := os.Hostname(); err == nil && h != "" {
			src = h
		} else {
			src = "bus-send"
		}
	}

	env := envelope{
		Version: envelopeVersion,
		Action:  actionMessage,
		Source:  src,
		To:      *agent,
		TS:      time.Now().UTC().Format(time.RFC3339),
		Payload: payload{Register: *register, Text: text},
		// bus-send is one-shot and has no inbox subscription, so it always
		// signals to receivers that they should not back-reply on this channel.
		NoReply: true,
	}
	body, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("marshal envelope: %w", err)
	}

	topic := "bus/agents/" + *agent
	if *agent == "*" {
		topic = "bus/agents/broadcast"
	}

	deadline := time.Now().Add(*timeout)
	clientID := fmt.Sprintf("bus-send-%d-%d", os.Getpid(), time.Now().UnixNano())

	opts := mqtt.NewClientOptions().
		AddBroker(brokerURL).
		SetClientID(clientID).
		SetConnectTimeout(*timeout).
		SetCleanSession(true).
		SetAutoReconnect(false)

	client := mqtt.NewClient(opts)

	connTok := client.Connect()
	if !connTok.WaitTimeout(time.Until(deadline)) {
		return fmt.Errorf("connect to %s: timed out after %s", brokerURL, *timeout)
	}
	if err := connTok.Error(); err != nil {
		return fmt.Errorf("connect to %s: %w", brokerURL, err)
	}
	defer client.Disconnect(250)

	pubTok := client.Publish(topic, 0, false, body)
	if !pubTok.WaitTimeout(time.Until(deadline)) {
		return fmt.Errorf("publish to %s: timed out", topic)
	}
	if err := pubTok.Error(); err != nil {
		return fmt.Errorf("publish to %s: %w", topic, err)
	}

	return nil
}
