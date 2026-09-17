package main

import (
	"regexp"
	"strings"
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
