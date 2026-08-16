package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeCreds(t *testing.T, body string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "broker.env")
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatalf("write: %v", err)
	}
	// WriteFile is subject to umask, so set the mode explicitly — otherwise the
	// permission test would pass for the wrong reason on a tight-umask machine.
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	return path
}

func TestLoadCredsReadsKnownKeys(t *testing.T) {
	path := writeCreds(t, `
# fleet bus
export WORK_RELAY_BROKER="mqtts://broker.example:8883"
WORK_RELAY_BROKER_USER = agent-a
WORK_RELAY_BROKER_PASS='s3cr3t=with=equals'

UNRELATED_KEY=ignored
`, 0o600)

	got, err := loadCreds(path)
	if err != nil {
		t.Fatalf("loadCreds: %v", err)
	}
	if got.URL != "mqtts://broker.example:8883" {
		t.Errorf("URL = %q", got.URL)
	}
	if got.User != "agent-a" {
		t.Errorf("User = %q", got.User)
	}
	// The password is the one value most likely to contain '=' — splitting on
	// every '=' instead of the first would silently truncate it.
	if got.Pass != "s3cr3t=with=equals" {
		t.Errorf("Pass = %q", got.Pass)
	}
}

func TestLoadCredsMissingFileIsNotAnError(t *testing.T) {
	// The file is optional: hosts that authenticate by environment, and hosts
	// on an anonymous broker, must keep working with no file at all.
	got, err := loadCreds(filepath.Join(t.TempDir(), "absent.env"))
	if err != nil {
		t.Fatalf("missing file should not error, got %v", err)
	}
	if got != (brokerCreds{}) {
		t.Errorf("expected zero creds, got %+v", got)
	}
}

func TestLoadCredsRejectsWorldReadableFile(t *testing.T) {
	// Reading it anyway would hand the credential to every local account while
	// appearing to work. Failing loudly at setup beats leaking quietly forever.
	path := writeCreds(t, "WORK_RELAY_BROKER_PASS=leaky\n", 0o644)

	_, err := loadCreds(path)
	if err == nil {
		t.Fatal("expected an error for a world-readable credentials file")
	}
	if !strings.Contains(err.Error(), "chmod 600") {
		t.Errorf("error should tell the operator how to fix it, got: %v", err)
	}
}

func TestLoadCredsRejectsGroupReadableFile(t *testing.T) {
	// Group-readable is the subtler half of the same hole: on a shared host the
	// group is exactly the set of other agents we are keeping the bus from.
	path := writeCreds(t, "WORK_RELAY_BROKER_PASS=leaky\n", 0o640)

	if _, err := loadCreds(path); err == nil {
		t.Fatal("expected an error for a group-readable credentials file")
	}
}

func TestParseCredsLine(t *testing.T) {
	cases := []struct {
		name, line, key, val string
		ok                   bool
	}{
		{"plain", "A=b", "A", "b", true},
		{"export prefix", "export A=b", "A", "b", true},
		{"spaces around =", "  A = b  ", "A", "b", true},
		{"double quoted", `A="b c"`, "A", "b c", true},
		{"single quoted", `A='b c'`, "A", "b c", true},
		{"mismatched quotes kept", `A="b'`, "A", `"b'`, true},
		{"empty value", "A=", "A", "", true},
		{"comment", "# A=b", "", "", false},
		{"blank", "   ", "", "", false},
		{"no equals", "just words", "", "", false},
		{"no key", "=b", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			key, val, ok := parseCredsLine(c.line)
			if ok != c.ok || key != c.key || val != c.val {
				t.Errorf("parseCredsLine(%q) = (%q, %q, %v), want (%q, %q, %v)",
					c.line, key, val, ok, c.key, c.val, c.ok)
			}
		})
	}
}

func TestCredsPathPrecedence(t *testing.T) {
	home := func() (string, error) { return "/home/agent", nil }

	t.Run("explicit override wins", func(t *testing.T) {
		env := map[string]string{credsFileEnv: "/tmp/x.env", "XDG_CONFIG_HOME": "/xdg"}
		got, ok := credsPath(func(k string) string { return env[k] }, home)
		if !ok || got != "/tmp/x.env" {
			t.Errorf("got (%q, %v)", got, ok)
		}
	})

	t.Run("XDG_CONFIG_HOME next", func(t *testing.T) {
		env := map[string]string{"XDG_CONFIG_HOME": "/xdg"}
		got, ok := credsPath(func(k string) string { return env[k] }, home)
		if !ok || got != "/xdg/work-relay/broker.env" {
			t.Errorf("got (%q, %v)", got, ok)
		}
	})

	t.Run("falls back to home", func(t *testing.T) {
		got, ok := credsPath(func(string) string { return "" }, home)
		if !ok || got != "/home/agent/.config/work-relay/broker.env" {
			t.Errorf("got (%q, %v)", got, ok)
		}
	})

	t.Run("no resolvable home is not an error", func(t *testing.T) {
		// cron and system services can run without HOME set. That means there is
		// no file to read, not that the send should fail.
		noHome := func() (string, error) { return "", os.ErrNotExist }
		if _, ok := credsPath(func(string) string { return "" }, noHome); ok {
			t.Error("expected no path when neither env nor home resolves")
		}
	})
}
