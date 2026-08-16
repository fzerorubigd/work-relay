import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Broker settings read from a small file rather than the environment.
 *
 * This exists for the processes that have no environment to speak of. cron
 * reads no shell config at all — not /etc/environment, not ~/.bashrc — so an
 * env-only design leaves every scheduled job unauthenticated. Threading a
 * source line through each script instead puts a tripwire in every script
 * written later: the one that forgets it fails at 3am.
 *
 * The Go client (cmd/bus-send/creds.go) reads the same file with the same keys
 * and the same precedence, so one file configures both.
 */
export interface BrokerCreds {
  url?: string;
  user?: string;
  pass?: string;
}

/** Overrides the default path, for tests and unusual layouts. */
export const CREDS_FILE_ENV = "WORK_RELAY_CREDS_FILE";
/** Default location under the user's config dir. */
export const CREDS_FILE_REL = "work-relay/broker.env";

/**
 * Resolve the credentials-file path. Returns undefined when no path can be
 * determined at all, which is not an error — it means there is no file to read.
 *
 * Pure: takes env and home explicitly so tests need not mutate process state.
 */
export function credsPath(
  env: Partial<Record<string, string>>,
  home: () => string = homedir,
): string | undefined {
  const override = env[CREDS_FILE_ENV];
  if (override) return override;

  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, CREDS_FILE_REL);

  let h: string;
  try {
    h = home();
  } catch {
    return undefined;
  }
  return h ? join(h, ".config", CREDS_FILE_REL) : undefined;
}

/**
 * Parse the KEY=VALUE shape people actually write by hand: blank lines, `#`
 * comments, a leading `export`, and values in matching quotes.
 *
 * Deliberately not a shell parser — no expansion, no substitution. A
 * credentials file that can run shell is a far larger thing to trust than one
 * that cannot. Only the three known keys are read; anything else is ignored
 * rather than pulled into the process, so the file cannot quietly become a
 * general-purpose environment.
 */
export function parseCreds(text: string): BrokerCreds {
  const out: BrokerCreds = {};
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;

    // slice at the FIRST '=' only: a password containing '=' is ordinary, and
    // splitting on every one would silently truncate it.
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      (val[0] === '"' || val[0] === "'") &&
      val[val.length - 1] === val[0]
    ) {
      val = val.slice(1, -1);
    }

    if (key === "WORK_RELAY_BROKER") out.url = val;
    else if (key === "WORK_RELAY_BROKER_USER") out.user = val;
    else if (key === "WORK_RELAY_BROKER_PASS") out.pass = val;
  }
  return out;
}

/**
 * Read broker settings from the credentials file.
 *
 * A missing file is not an error: the file is optional, and callers fall back
 * to the environment.
 *
 * A file that exists but is readable by group or other IS an error. Reading it
 * anyway would hand the credential to every local account while appearing to
 * work, which is the exact failure this file exists to prevent — so it fails
 * loudly at setup time instead of leaking quietly forever.
 */
export function loadCreds(path: string): BrokerCreds {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  if (mode & 0o077) {
    throw new Error(
      `credentials file ${path} is readable by others (mode ${mode.toString(8).padStart(4, "0")}); ` +
        `run: chmod 600 ${path}`,
    );
  }
  return parseCreds(readFileSync(path, "utf8"));
}
