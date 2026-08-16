import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { credsPath, loadCreds, parseCreds, CREDS_FILE_ENV } from "./creds.js";

function writeCreds(body: string, mode: number): string {
  const path = join(mkdtempSync(join(tmpdir(), "wr-creds-")), "broker.env");
  writeFileSync(path, body);
  // Set the mode explicitly — writeFileSync is subject to umask, so the
  // permission test could otherwise pass for the wrong reason.
  chmodSync(path, mode);
  return path;
}

describe("parseCreds", () => {
  test("reads the known keys and ignores the rest", () => {
    const got = parseCreds(`
# fleet bus
export WORK_RELAY_BROKER="mqtts://broker.example:8883"
WORK_RELAY_BROKER_USER = agent-a
WORK_RELAY_BROKER_PASS='s3cr3t=with=equals'

UNRELATED_KEY=ignored
`);
    expect(got.url).toBe("mqtts://broker.example:8883");
    expect(got.user).toBe("agent-a");
    // A password containing '=' is ordinary; splitting on every '=' instead of
    // the first would silently truncate it.
    expect(got.pass).toBe("s3cr3t=with=equals");
  });

  test("skips comments, blanks and malformed lines", () => {
    expect(parseCreds("# WORK_RELAY_BROKER_PASS=x")).toEqual({});
    expect(parseCreds("   \n\n")).toEqual({});
    expect(parseCreds("just words")).toEqual({});
    expect(parseCreds("=novalue")).toEqual({});
  });

  test("keeps mismatched quotes rather than guessing", () => {
    expect(parseCreds(`WORK_RELAY_BROKER_USER="b'`).user).toBe(`"b'`);
  });
});

describe("loadCreds", () => {
  test("a missing file is not an error", () => {
    // The file is optional: hosts authenticating by environment, and hosts on
    // an anonymous broker, must keep working with no file at all.
    expect(loadCreds(join(tmpdir(), "definitely-absent-creds.env"))).toEqual({});
  });

  test("rejects a world-readable file and says how to fix it", () => {
    const path = writeCreds("WORK_RELAY_BROKER_PASS=leaky\n", 0o644);
    expect(() => loadCreds(path)).toThrow(/chmod 600/);
  });

  test("rejects a group-readable file", () => {
    // The subtler half of the same hole: on a shared host the group is exactly
    // the set of other agents we are keeping the bus from.
    const path = writeCreds("WORK_RELAY_BROKER_PASS=leaky\n", 0o640);
    expect(() => loadCreds(path)).toThrow();
  });

  test("reads a correctly-permissioned file", () => {
    const path = writeCreds("WORK_RELAY_BROKER_USER=agent-a\n", 0o600);
    expect(loadCreds(path).user).toBe("agent-a");
  });
});

describe("credsPath", () => {
  const home = () => "/home/agent";

  test("explicit override wins", () => {
    expect(
      credsPath({ [CREDS_FILE_ENV]: "/tmp/x.env", XDG_CONFIG_HOME: "/xdg" }, home),
    ).toBe("/tmp/x.env");
  });

  test("XDG_CONFIG_HOME next", () => {
    expect(credsPath({ XDG_CONFIG_HOME: "/xdg" }, home)).toBe(
      "/xdg/work-relay/broker.env",
    );
  });

  test("falls back to the home directory", () => {
    expect(credsPath({}, home)).toBe("/home/agent/.config/work-relay/broker.env");
  });

  test("no resolvable home is not an error", () => {
    // cron and system services can run without HOME. That means there is no
    // file to read, not that startup should fail.
    expect(
      credsPath({}, () => {
        throw new Error("no home");
      }),
    ).toBeUndefined();
  });
});
