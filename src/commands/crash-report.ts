/**
 * `agenttrail-guard crash-report` — the ONLY transmitter in the binary.
 *
 * Subcommands: `--status` (default) · `--enable` · `--disable` · `--send` · `--clear`.
 *
 * ── Why a separate verb rather than a side effect of `status` ────────────────
 * A crash report is sent only when the user explicitly asks. A send that happens
 * because the user asked for *status* is a side effect, however well documented, so
 * sending is a verb of its own: `crash-report --send`.
 *
 * ── This file is the ONE place allowed to import `src/net/` ──────────────────
 * `no-network.test.ts` enumerates `commands/*.ts` and asserts every other one — and
 * `hook-entry.ts` — cannot reach `src/net/**`. Adding an import here is fine; adding
 * one anywhere else fails the build.
 *
 * Returns an exit code; never calls `process.exit` (`built-artifact.test.ts:89`).
 */

import { parseConfig } from "../core/config.js";
import { clearSpool, deleteSpooled, readSpool } from "../core/crash-store.js";
import { configPath } from "../core/paths.js";
import type { GuardIO } from "../io.js";
import {
  type FetchLike,
  realFetch,
  resolveEndpoint,
  sendCrashRecord,
} from "../net/crash-transport.js";

/** Injected so tests never open a socket and never read the real environment. */
export interface CrashReportDeps {
  readonly fetchImpl?: FetchLike;
  readonly env?: Record<string, string | undefined>;
}

/** Rewrite `config.json` with `crashReports` flipped. Returns whether it stuck. */
function setCrashReports(io: GuardIO, on: boolean): boolean {
  const path = configPath(io.homedir());
  const existing = io.readFile(path);

  // Preserve every key we do not own. Parsing through `parseConfig` would DROP
  // unknown fields (including `version`, which the parser does not read),
  // so the raw object is edited instead and only our key is touched.
  let raw: Record<string, unknown> = {};
  if (existing !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // A corrupt config is replaced rather than left un-editable. The user asked
      // for a setting change; refusing because of unrelated damage helps nobody.
    }
  }
  raw.crashReports = on;

  const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  if (dir.length > 0 && !io.mkdirp(dir)) return false;
  return io.writeFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Run the command. Resolves to an exit code. Never throws. */
export async function runCrashReport(
  argv: readonly string[],
  io: GuardIO,
  deps: CrashReportDeps = {},
): Promise<number> {
  const config = parseConfig(io.readFile(configPath(io.homedir())));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));

  // Refuse two modes at once rather than silently picking one by source order.
  // `--send --clear` is the case that matters: one transmits and one destroys, and
  // a user who typed both did not mean "quietly do the second".
  const modes = ["--enable", "--disable", "--send", "--clear", "--status"].filter((m) =>
    flags.has(m),
  );
  if (modes.length > 1) {
    io.writeStdout(`agenttrail-guard: pick one of ${modes.join(", ")}, not several.\n`);
    return 1;
  }

  if (flags.has("--enable") || flags.has("--disable")) {
    const on = flags.has("--enable");
    if (!setCrashReports(io, on)) {
      io.writeStdout("agenttrail-guard: could not write config.json.\n");
      return 1;
    }
    io.writeStdout(
      on
        ? "Crash reporting ENABLED. Stack traces only, scrubbed, and sent only when you run `crash-report --send`.\n"
        : "Crash reporting DISABLED. Nothing will be sent.\n",
    );
    return 0;
  }

  if (flags.has("--clear")) {
    io.writeStdout(`Deleted ${clearSpool(io)} spooled crash report(s).\n`);
    return 0;
  }

  const spool = readSpool(io);

  if (flags.has("--send")) {
    if (!config.crashReports) {
      // The gate, stated as a refusal rather than a silent no-op, so a user who
      // expected a send learns why nothing happened.
      io.writeStdout(
        "Crash reporting is off, so nothing was sent. Enable it with `agenttrail-guard crash-report --enable`.\n",
      );
      return 1;
    }
    const endpoint = resolveEndpoint(
      flagValue(argv, "--endpoint"),
      (deps.env ?? process.env).AGENTTRAIL_GUARD_CRASH_ENDPOINT,
      config.crashEndpoint,
    );
    if (endpoint === undefined) {
      io.writeStdout(
        'No crash-report endpoint configured, so nothing was sent. Set one with --endpoint <url>, AGENTTRAIL_GUARD_CRASH_ENDPOINT, or "crashEndpoint" in config.json.\n',
      );
      return 1;
    }
    if (spool.length === 0) {
      io.writeStdout("No crash reports to send.\n");
      return 0;
    }

    let sent = 0;
    for (const item of spool) {
      const outcome = await sendCrashRecord(item.record, {
        enabled: config.crashReports,
        endpoint,
        fetchImpl: deps.fetchImpl ?? realFetch,
      });
      if (outcome.kind !== "sent") {
        // Stop at the first failure and leave the rest spooled. Hammering a
        // failing endpoint once per record is worse for them and for us.
        io.writeStdout(
          `Sent ${sent} of ${spool.length}; stopped after a failure (${describe(outcome.kind)}). The rest are still on disk.\n`,
        );
        return 1;
      }
      deleteSpooled(io, item.name);
      sent += 1;
    }
    io.writeStdout(`Sent ${sent} crash report(s).\n`);
    return 0;
  }

  // `--status`, and the default with no flags.
  io.writeStdout(
    [
      `Crash reporting: ${config.crashReports ? "ON" : "OFF (default)"}`,
      `Spooled locally: ${spool.length}`,
      "Stack traces only. No commands, no file contents, no environment.",
      "Nothing is ever sent without both the setting ON and an explicit `--send`.",
      `Files: ~/.agenttrail/guard/crashes/ — deleting them is always safe.`,
      "",
    ].join("\n"),
  );
  return 0;
}

/** `--endpoint <url>`; returns `undefined` when absent or valueless. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

function describe(kind: string): string {
  return kind === "no-endpoint"
    ? "no endpoint"
    : kind === "disabled"
      ? "disabled"
      : "network error";
}
