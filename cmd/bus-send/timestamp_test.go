package main

import (
	"regexp"
	"testing"
	"time"
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
			t.Skipf("zone %s unavailable: %v", name, err)
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
		t.Skip("zone unavailable")
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

// A UTC host is the case the offset form must not special-case away: it is
// correct for it to emit +00:00, and Go's RFC3339 emits Z instead.
func TestLocalTimestampOnAUTCHostStillParses(t *testing.T) {
	got := localTimestamp(time.Now().UTC())
	if _, err := time.Parse(time.RFC3339, got); err != nil {
		t.Fatalf("UTC host output does not parse: %q %v", got, err)
	}
}
