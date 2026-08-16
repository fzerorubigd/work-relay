package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Broker settings may come from a small file instead of the environment,
// because the processes that need them often have no environment to speak of.
// cron reads no shell config at all — not /etc/environment, not ~/.bashrc — so
// an env-only design silently leaves every scheduled job unauthenticated. The
// alternative, threading a source line through each script, puts a tripwire in
// every script written later: the one that forgets it fails at 3am.
//
// A flag is not the answer either. Anything passed as a flag is visible in `ps`
// to every user on the host, and these hosts are shared.
const (
	// credsFileEnv overrides the default path, for tests and unusual layouts.
	credsFileEnv = "WORK_RELAY_CREDS_FILE"
	// credsFileRel is the default location under the user's config dir.
	credsFileRel = "work-relay/broker.env"
)

// brokerCreds holds only the keys this file is allowed to carry. Anything else
// in the file is ignored rather than exported into the process, so the file
// cannot quietly become a general-purpose environment.
type brokerCreds struct {
	URL  string
	User string
	Pass string
}

// credsPath returns the file to read, and whether a path could be determined at
// all. A user with no resolvable config dir is not an error — it just means
// there is no file to read.
func credsPath(getenv func(string) string, home func() (string, error)) (string, bool) {
	if p := getenv(credsFileEnv); p != "" {
		return p, true
	}
	if dir := getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, credsFileRel), true
	}
	h, err := home()
	if err != nil || h == "" {
		return "", false
	}
	return filepath.Join(h, ".config", credsFileRel), true
}

// loadCreds reads broker settings from the credentials file. A missing file is
// not an error: the file is optional, and callers fall back to flags and the
// environment.
//
// A file that exists but is readable by group or other IS an error. Reading it
// anyway would hand out the credential to every local account while looking
// like it worked, which is the exact failure this file exists to prevent — so
// it fails loudly at setup time instead of leaking quietly forever.
func loadCreds(path string) (brokerCreds, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return brokerCreds{}, nil
		}
		return brokerCreds{}, fmt.Errorf("open credentials file %s: %w", path, err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return brokerCreds{}, fmt.Errorf("stat credentials file %s: %w", path, err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return brokerCreds{}, fmt.Errorf(
			"credentials file %s is readable by others (mode %04o); run: chmod 600 %s",
			path, mode, path)
	}

	var c brokerCreds
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		key, val, ok := parseCredsLine(sc.Text())
		if !ok {
			continue
		}
		switch key {
		case "WORK_RELAY_BROKER":
			c.URL = val
		case "WORK_RELAY_BROKER_USER":
			c.User = val
		case "WORK_RELAY_BROKER_PASS":
			c.Pass = val
		}
	}
	if err := sc.Err(); err != nil {
		return brokerCreds{}, fmt.Errorf("read credentials file %s: %w", path, err)
	}
	return c, nil
}

// parseCredsLine handles the KEY=VALUE shape people actually write by hand:
// blank lines, `#` comments, a leading `export`, and values wrapped in matching
// quotes. It is deliberately not a shell parser — no expansion, no
// substitution — because a credentials file that can run shell is a much larger
// thing to trust than one that cannot.
func parseCredsLine(line string) (key, val string, ok bool) {
	s := strings.TrimSpace(line)
	if s == "" || strings.HasPrefix(s, "#") {
		return "", "", false
	}
	s = strings.TrimPrefix(s, "export ")
	k, v, found := strings.Cut(s, "=")
	if !found {
		return "", "", false
	}
	k = strings.TrimSpace(k)
	v = strings.TrimSpace(v)
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		v = v[1 : len(v)-1]
	}
	if k == "" {
		return "", "", false
	}
	return k, v, true
}
