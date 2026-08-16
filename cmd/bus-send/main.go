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
		broker   = flag.String("broker", "", "MQTT broker URL (default $WORK_RELAY_BROKER, then the credentials file, then "+defaultBroker+")")
		register = flag.String("register", "talk", "message register: talk|command")
		message  = flag.String("message", "", "message text; if empty, read from stdin")
		source   = flag.String("source", "", "source field on the envelope (default: hostname)")
		user     = flag.String("user", "", "broker username (default $WORK_RELAY_BROKER_USER, then the credentials file)")
		pass     = flag.String("pass", "", "broker password (default $WORK_RELAY_BROKER_PASS, then the credentials file; prefer those, a flag value is visible in ps)")
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

	// Optional credentials file, consulted below after flags and environment.
	// Read before the broker URL so one file can supply all three settings.
	var file brokerCreds
	if path, ok := credsPath(os.Getenv, os.UserHomeDir); ok {
		var err error
		if file, err = loadCreds(path); err != nil {
			return err
		}
	}

	brokerURL := *broker
	if brokerURL == "" {
		brokerURL = os.Getenv("WORK_RELAY_BROKER")
	}
	if brokerURL == "" {
		brokerURL = file.URL
	}
	if brokerURL == "" {
		brokerURL = defaultBroker
	}

	// Credentials resolve flag, then environment, then the credentials file —
	// same precedence as -broker. Names match the work-relay MCP
	// (src/config.ts) so one credential pair configures both clients.
	//
	// The file is last because it is the standing default: an explicit flag or
	// a deliberately-exported variable should always beat what is on disk.
	// It is also the only one of the three that reaches cron, which has no
	// environment and cannot be given flags without exposing them in `ps`.
	brokerUser := *user
	if brokerUser == "" {
		brokerUser = os.Getenv("WORK_RELAY_BROKER_USER")
	}
	if brokerUser == "" {
		brokerUser = file.User
	}
	brokerPass := *pass
	if brokerPass == "" {
		brokerPass = os.Getenv("WORK_RELAY_BROKER_PASS")
	}
	if brokerPass == "" {
		brokerPass = file.Pass
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

	// Set only when present, so an unauthenticated broker keeps working
	// unchanged and the two can be migrated independently.
	if brokerUser != "" {
		opts.SetUsername(brokerUser)
	}
	if brokerPass != "" {
		opts.SetPassword(brokerPass)
	}

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
