package main

import (
	"regexp"
	"strings"
	"testing"
	"time"

	// Embeds the zone database in the test binary.
	//
	// Without it, LoadLocation fails on a host with no system tzdata — a slim
	// container, a scratch image — and every zone assertion below would skip.
	// A skipped test still prints "ok" for the package, so the suite would
	// report success with the shipping bug present. Demonstrated in review:
	// unresolvable zone names plus a reverted shipping line exits 0.
	_ "time/tzdata"
)

// An envelope's ts must carry an explicit offset. A bare Z makes every reader
// responsible for knowing the zone, which is the bug this replaced.
var offsetForm = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$`)

func TestLocalTimestampCarriesAnExplicitOffset(t *testing.T) {
	// Zones chosen for the shapes that break naive offset arithmetic: a
	// half-hour zone, a 45-minute zone, and a negative one.
	for _, name := range []string{"Europe/Berlin", "Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns"} {
		loc, err := time.LoadLocation(name)
		if err != nil {
			// tzdata is embedded above, so this is a real fault, not an
			// environment to tiptoe around.
			t.Fatalf("zone %s unavailable: %v", name, err)
		}
		got := localTimestamp(time.Now().In(loc))
		if !offsetForm.MatchString(got) {
			t.Errorf("%s: %q is not RFC3339 with an offset", name, got)
		}
	}
}

func TestLocalTimestampNamesTheSameInstant(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Kathmandu")
	if err != nil {
		t.Fatalf("zone unavailable: %v", err)
	}
	now := time.Now().Truncate(time.Second)
	parsed, err := time.Parse(time.RFC3339, localTimestamp(now.In(loc)))
	if err != nil {
		t.Fatalf("own output does not parse: %v", err)
	}
	if !parsed.Equal(now) {
		t.Errorf("offset form names a different instant: %v vs %v", parsed, now)
	}
}

// A UTC host is the case that motivated not using time.RFC3339: that layout
// renders a literal Z there, which is the thing this change removes, and UTC is
// the default in containers and scheduled jobs.
func TestLocalTimestampOnAUTCHostEmitsAnOffsetNotZ(t *testing.T) {
	got := localTimestamp(time.Now().UTC())
	if !offsetForm.MatchString(got) {
		t.Errorf("UTC host emitted %q, want a numeric offset", got)
	}
	if !strings.HasSuffix(got, "+00:00") {
		t.Errorf("UTC host emitted %q, want it to end +00:00", got)
	}
	if _, err := time.Parse(time.RFC3339, got); err != nil {
		t.Fatalf("output does not parse as RFC3339: %q %v", got, err)
	}
}

// The assertions above cover localTimestamp, which is a pure one-line function.
// These cover the line that actually ships a ts, which is what a reader of the
// envelope receives. Both mutations below left the suite green before it existed:
// reverting to time.RFC3339, and wrapping the instant in .UTC().
func TestBuildEnvelopeShipsTheSendersOwnZone(t *testing.T) {
	kathmandu, err := time.LoadLocation("Asia/Kathmandu")
	if err != nil {
		t.Fatalf("zone unavailable: %v", err)
	}

	// A sender east of Greenwich must ship ITS offset. Wrapping the instant in
	// .UTC() anywhere on this path still yields a valid offset form, so only a
	// non-UTC zone distinguishes "kept the sender's zone" from "discarded it".
	env := buildEnvelope(time.Now().In(kathmandu), "agent-a", "agent-b", "talk", "hello")
	if !strings.HasSuffix(env.TS, "+05:45") {
		t.Errorf("envelope shipped %q, want the sender's +05:45 offset", env.TS)
	}

	// And a UTC sender must ship +00:00 rather than a bare Z, which is the case
	// time.RFC3339 renders wrongly.
	utc := buildEnvelope(time.Now().UTC(), "agent-a", "agent-b", "talk", "hello")
	if !strings.HasSuffix(utc.TS, "+00:00") {
		t.Errorf("UTC sender shipped %q, want +00:00", utc.TS)
	}
	if !offsetForm.MatchString(utc.TS) {
		t.Errorf("UTC sender shipped %q, which is not the offset form", utc.TS)
	}
}
