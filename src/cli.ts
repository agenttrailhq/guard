#!/usr/bin/env node
/**
 * `agenttrail-guard` — the npm bin.
 *
 * `runCli` RETURNS an exit code and never calls `process.exit`, so the commands stay
 * testable and no code path can stumble into Claude Code's blocking signal. The bin
 * wrapper at the bottom assigns `process.exitCode` only for a genuine CLI failure.
 *
 * **`hook` always returns 0**, whatever happened inside it. Claude Code normally
 * invokes `plugin/scripts/guard-hook.mjs` directly, but `agenttrail-guard hook` is
 * the documented manual form and must honour the same invariant.
 *
 * ── `rules` is an unlisted alias for `guardrails` ─────────────────────────────
 * `rules` dispatches exactly like `guardrails`. It is not listed in `USAGE`, and every
 * message the command prints names `guardrails`.
 *
 * ── `guardrails` and `scan` are dispatched BEFORE this file's own `parseArgs` ─
 * With the option set below, `guardrails list --pack working-tree` comes back
 * as `values: {pack: true}` with `working-tree` fallen into the positionals, and
 * `guardrails allow x "-rf /"` loses the pattern entirely into `{r: true, f: true}`. An
 * undeclared flag becomes a boolean and eats its value; a pattern that starts with `-`
 * is consumed outright. The same thing happens to `scan --dir /tmp/x`, which arrives as
 * `{dir: true}` with the directory in the positionals. Both therefore take their RAW
 * argv and scan it themselves, the same shape of exception `hook` already has below.
 *
 * ── FOUR IO objects, and the split is structural ────────────────────────────
 * `hook` takes `GuardIO`; `init`/`status`/`uninstall`/`guardrails` take `SetupIO`; `scan`
 * takes `ScanIO`; `init`, `uninstall` and `status` also take `CursorFileIO` and
 * `CodexFileIO`, for those two apps' hooks files, and `status` reads the crash spool through
 * `GuardIO`. They are separate because `io.ts` is inside the hook bundle graph, so
 * teaching it to spawn a process would ship a process spawner into the file Claude Code
 * runs on every tool call — and `scan` needs one, to open the report. This module is
 * the only place all three meet, and it is NOT on the hook path, because Claude Code
 * invokes `plugin/scripts/guard-hook.mjs` (built from `hook-entry.ts`) rather than this
 * file. `bundle-graph.test.ts` enforces the boundary from both ends.
 *
 * ── `crash-report` is the only command that can reach the network ───────────
 * Same shape of argument, one level up: it is dispatched here and nowhere else, and
 * `no-network.test.ts` asserts that no other `commands/*.ts` — and not
 * `hook-entry.ts` — can import `src/net/**`.
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CodexFileIO } from "./codex/codex-io.js";
import { runCrashReport } from "./commands/crash-report.js";
import { runHook } from "./commands/hook.js";
import { runInit } from "./commands/init.js";
import { runRules } from "./commands/rules.js";
import { runScan } from "./commands/scan.js";
import { runStatus } from "./commands/status.js";
import { runUninstall } from "./commands/uninstall.js";
import { agentFromArgv } from "./core/agent.js";
import { VERSION } from "./core/version.js";
import type { CursorFileIO } from "./cursor/cursor-io.js";
import { createRealIO, type GuardIO } from "./io.js";
import { createRealScanIO, type ScanIO } from "./scan-io.js";
import { createRealSetupIO, type SetupIO } from "./setup-io.js";

const USAGE = `agenttrail-guard — local guardrails for Claude Code, Cursor and Codex CLI

Usage:
  agenttrail-guard init --agent <claude|cursor|codex>        Install the hook for one of them, and seed config
  agenttrail-guard status                                    Show what is enforcing, and what it has been doing
  agenttrail-guard uninstall --agent <claude|cursor|codex>   Remove the hook from one of them (only ours)
  agenttrail-guard hook                                      Evaluate a hook payload on stdin (used by all three)
  agenttrail-guard guardrails                                See and change what the guard enforces
  agenttrail-guard scan --agent <claude|cursor|codex>        Read your transcripts; write a shareable report
  agenttrail-guard crash-report                              Show, enable, disable, send or clear crash reports
  agenttrail-guard --help                                    Show this message
  agenttrail-guard --version                                 Show the version

crash-report flags: --status (default) --enable --disable --send [--endpoint <url>] --clear
Crash reporting is OFF by default and sends stack traces only. It is the one network
call this tool can make, and only when you turn it on and run --send yourself.

guardrails subcommands: list  show  enable  disable  set-action  add  remove  allow
                        reset  validate  (run "agenttrail-guard guardrails --help")

scan flags: --agent <claude|cursor|codex> (required) --dir <root> --out <file> --artifact
            --no-open --review --json
scan reads transcripts already on your disk, writes one self-contained HTML file, and
opens it in your browser (--no-open to skip).
No account, and no network call of its own — crash reporting above is the one
exception in this tool, and a scan never uses it. Commands, paths and identifying
operands are redacted before display or write; --review shows every line first.

Flags:
  --print                      With init: show what would happen, change nothing
  --clear-history              With status: empty the local decision log
`;

// Re-exported from `core/version.ts` so `hook-entry.ts` can read the version
// without importing this file (the CLI must stay out of the hook
// bundle). Every existing importer of `VERSION` from here keeps working.
export { VERSION };

/**
 * Run the CLI. Returns the process exit code; never exits, never throws.
 */
export async function runCli(
  argv: readonly string[],
  io: GuardIO,
  setupIo?: SetupIO,
  scanIo?: ScanIO,
  cursorIo?: CursorFileIO,
  codexIo?: CodexFileIO,
): Promise<number> {
  let positionals: string[];
  let values: {
    help?: boolean | undefined;
    version?: boolean | undefined;
    print?: boolean | undefined;
    "clear-history"?: boolean | undefined;
    /**
     * Declared as a string, but a lone `--agent` still arrives as `true`, and
     * `--agent --print` arrives as `"--print"`. `init` and `uninstall` accept only the exact
     * names.
     */
    agent?: string | boolean | undefined;
  };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        print: { type: "boolean" },
        "clear-history": { type: "boolean" },
        agent: { type: "string" },
      },
      allowPositionals: true,
      strict: false,
    });
    positionals = parsed.positionals as string[];
    values = parsed.values as typeof values;
  } catch {
    io.writeStdout(USAGE);
    return 1;
  }

  const command = positionals[0];

  // `hook` is checked BEFORE --help/--version so that a stray flag in a hooks.json
  // command line can never turn an enforcement call into a usage dump on stdout.
  //
  // `--agent` is read from the raw argv here, by the same function the hook bundle uses, so
  // `agenttrail-guard hook` and the bundle read one command line the same way.
  if (command === "hook") {
    await runHook(io, { agent: agentFromArgv(argv.slice(1)) });
    return 0;
  }

  // Checked before --help/--version for the same reason `hook` is: a stray flag
  // must not turn a command into a usage dump.
  if (command === "crash-report") {
    return await runCrashReport(argv.slice(1), io);
  }

  // `guardrails` takes its arguments RAW — see the docblock. `parseArgs` above has
  // already run, but only its `positionals[0]` is used here, so nothing it did to the
  // rest reaches `runRules`.
  //
  // `rules` is the older spelling, kept working and left out of `USAGE`.
  if (command === "guardrails" || command === "rules") {
    return await runRules(argv.slice(1), setupIo ?? createRealSetupIO());
  }

  // Same exception, same reason — see the docblock. Also lazily constructed, so `hook`
  // never pays to build the scan IO and its process spawner.
  if (command === "scan") {
    return await runScan(argv.slice(1), scanIo ?? createRealScanIO());
  }

  if (values.version === true) {
    io.writeStdout(`${VERSION}\n`);
    return 0;
  }
  if (values.help === true || command === undefined) {
    io.writeStdout(USAGE);
    return 0;
  }

  // The setup commands. Lazily constructed so that `hook` — the hot path — never pays
  // for the setup IO, and so a test can drive them with a fake.
  if (command === "init" || command === "status" || command === "uninstall") {
    const setup = setupIo ?? createRealSetupIO();
    // Omitted rather than `undefined`, so each command builds the real seam itself.
    const appDeps = {
      ...(cursorIo === undefined ? {} : { cursorIo }),
      ...(codexIo === undefined ? {} : { codexIo }),
    };
    if (command === "init") {
      // `cliPath` lets `init` tell an `npx` run (its path carries `/_npx/`) from a global
      // install, so its closing line names a command the user actually has. This is the
      // real entry path; a direct unit-test call omits it and gets the global-install line.
      return runInit(
        setup,
        { print: values.print === true, agent: values.agent },
        {
          ...appDeps,
          cliPath: fileURLToPath(import.meta.url),
        },
      );
    }
    if (command === "status") {
      return runStatus(setup, {
        clearHistory: values["clear-history"] === true,
        guardIo: io,
        ...appDeps,
      });
    }
    return runUninstall(setup, { agent: values.agent }, appDeps);
  }

  io.writeStdout(`agenttrail-guard: unknown command "${command}".\n\n${USAGE}`);
  return 1;
}

const code = await runCli(process.argv.slice(2), createRealIO());
if (code !== 0) {
  process.exitCode = code;
}
