// cspell:words upsert repointed
/**
 * `agenttrail-guard init --agent claude|cursor` — install the hook, seed the config, prove it
 * works.
 *
 * `--agent` is required, and checked before anything is read, written or run. `--agent
 * cursor` is `cursor/install.ts`: it writes guard's entries into `~/.cursor/hooks.json` and
 * never runs `claude`. Everything below this paragraph describes `--agent claude`.
 *
 * ── It installs via the PLUGIN system, and never writes settings.json ────────
 * `init` writes exactly two files, both under `~/.agenttrail/guard/`, and then shells
 * out to `claude plugin …` twice. It does not read, merge into, or rewrite the user's
 * own `hooks` block — Claude Code owns that file, and the plugin system registers the
 * hook without it. Installing this scaffold into a clean HOME produces
 * `extraKnownMarketplaces` and `enabledPlugins` and NO `hooks` key at all.
 *
 * ── It finishes with a demonstration ─────────────────────────────────────────
 * `init` feeds a synthetic `rm -rf /` through the REAL evaluator, on the real catalog,
 * and shows it blocked. Nothing is executed: the string never reaches a shell, only
 * the mapper.
 */

import { SHIPPED_CATALOG } from "../core/catalog.js";
import { catalogStamp, formatCatalogStamp } from "../core/catalog-stamp.js";
import {
  approvalOverride,
  claudeSettingsPath,
  formatApprovalOverride,
  readPermissionAllow,
} from "../core/claude-settings.js";
import { serializeDefaultConfig } from "../core/config.js";
import { mapCursorCall } from "../core/cursor-mapper.js";
import { compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { mapToolCall } from "../core/mapper.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { configPath, guardDir, userRulesPath } from "../core/paths.js";
import { compileCatalog } from "../core/rules.js";
import type { AgentSource, GuardRule, MappedCall } from "../core/types.js";
import { VERSION } from "../core/version.js";
import { type CursorFileIO, createRealCursorFileIO } from "../cursor/cursor-io.js";
import {
  applyCursorInstall,
  CURSOR_RUN_MODE_NOTE,
  describeCursorInstall,
  planCursorInstall,
} from "../cursor/install.js";
import {
  AGENTTRAIL_PLUGIN_ID,
  agenttrailPluginPresent,
  ensureClaudeSupportsPlugins,
  GUARD_PLUGIN_ID,
  installGuardPlugin,
  readInstalledPlugin,
  readMarketplaceHealth,
  resolvePluginScaffoldDir,
} from "../plugin/install.js";
import type { SetupIO } from "../setup-io.js";
import { agentChoiceMessage, chosenAgent } from "./agent-choice.js";

/** The command fed through the evaluator to demonstrate enforcement. Never executed. */
const DEMO_COMMAND = "rm -rf /";

export interface InitDeps {
  /** The rule catalog. `@agenttrail/guardrails` arrives through here. */
  readonly catalog?: readonly GuardRule[];
  /** Overridden in tests so no test depends on the repo's own directory layout. */
  readonly scaffoldDir?: string;
  /** The bundled `plugin.json` version, for staleness detection. */
  readonly bundledVersion?: string;
  readonly now?: Date;
  /** `--agent cursor`'s file seam. Overridden in tests, so none touches a real `~/.cursor`. */
  readonly cursorIo?: CursorFileIO;
  /** The Node that guard's Cursor entries run. Defaults to the Node running this command. */
  readonly nodePath?: string;
  /**
   * Path to Claude Code's `settings.json`, for the approval-override check. Defaults to
   * `CLAUDE_CONFIG_DIR`'s `settings.json`, else `~/.claude/settings.json`. Injectable so
   * a test need not depend on the runner's environment.
   */
  readonly settingsPath?: string;
}

/** What `init` was asked for. `agent` is the raw `--agent` value, checked by `runInit`. */
export interface InitArgs {
  readonly print?: boolean;
  readonly agent?: string | boolean;
}

/** Read the bundled plugin manifest's version, if it can be read. */
function readBundledVersion(io: SetupIO, scaffoldDir: string): string | undefined {
  const text = io.readFile(`${scaffoldDir}/.claude-plugin/plugin.json`);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const v = (parsed as Record<string, unknown>).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `--print`: describe what `init` would ACTUALLY do, having looked.
 *
 * It performs the same reads `init` does — the version gate, the coexistence check,
 * and the marketplace and plugin state — so the plan it prints describes this machine:
 * a dangling marketplace is reported, and a plugin already installed at the bundled
 * version is not offered for install again.
 *
 * It performs READS ONLY. Every mutating verb is described, never issued, and
 * `setup-commands.test.ts` asserts that over the recorded argv rather than by eye.
 */
function dryRunReport(io: SetupIO, home: string, scaffoldDir: string, deps: InitDeps): string {
  const lines: string[] = [
    "agenttrail-guard init --agent claude --print — this is what would happen. Nothing is changed.",
    "",
  ];

  // The version gate, actually run. It throws on "no claude" / "too old", which is a
  // real answer to "what would happen": it would stop right here.
  try {
    ensureClaudeSupportsPlugins(io.runClaude);
  } catch (error) {
    return `${lines.join("\n")}  It would STOP: ${(error as Error).message}\n`;
  }

  if (io.readFile(configPath(home)) === undefined) {
    lines.push(`  write   ${configPath(home)}  (mode 0600)`);
  }
  if (io.readFile(userRulesPath(home)) === undefined) {
    lines.push(`  write   ${userRulesPath(home)}  (mode 0600)`);
  }

  const health = readMarketplaceHealth(io.runClaude, (p) => io.exists(p));
  if (health.kind === "dangling") {
    lines.push(
      `  PROBLEM the marketplace points at ${health.path}, which no longer exists.`,
      "          Claude Code runs a cached copy, so the guard still works — but it",
      "          cannot be updated until this is re-pointed.",
      `  run     claude plugin marketplace add ${scaffoldDir} --scope user  (re-points it)`,
    );
  } else if (health.kind === "ok" && health.path === scaffoldDir) {
    lines.push("  (marketplace already points here — nothing to do)");
  } else if (health.kind === "unknown") {
    lines.push(
      "  ?       could not read the marketplace list, so this is a guess:",
      `  run     claude plugin marketplace add ${scaffoldDir} --scope user`,
    );
  } else {
    lines.push(`  run     claude plugin marketplace add ${scaffoldDir} --scope user`);
  }

  const installed = readInstalledPlugin(io.runClaude, GUARD_PLUGIN_ID);
  const bundled = deps.bundledVersion ?? readBundledVersion(io, scaffoldDir);
  if (installed === undefined) {
    lines.push(`  run     claude plugin install ${GUARD_PLUGIN_ID} --scope user`);
  } else if (bundled !== undefined && installed.version !== bundled) {
    lines.push(
      `  run     claude plugin update ${GUARD_PLUGIN_ID} --scope user`,
      `          (installed ${installed.version ?? "unknown"} → bundled ${bundled})`,
    );
  } else {
    lines.push(`  (${GUARD_PLUGIN_ID} already installed at ${installed.version ?? "unknown"})`);
  }
  if (installed !== undefined && !installed.enabled) {
    lines.push("  NOTE    it is installed but DISABLED, so it is enforcing nothing.");
  }

  lines.push(
    "",
    "It would NOT touch ~/.claude/settings.json — Claude Code owns that file, and",
    "the guard's hook lives inside the plugin rather than in your own hooks block.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The demo command as the app's hook receives it: a Claude Code `Bash` call, or the command
 * at Cursor's `beforeShellExecution` checkpoint.
 */
function demoCall(agent: AgentSource): MappedCall {
  const cursor =
    agent === "cursor"
      ? mapCursorCall({ hook_event_name: "beforeShellExecution", command: DEMO_COMMAND })
      : undefined;
  return (
    cursor?.candidates[0] ??
    mapToolCall({ tool_name: "Bash", tool_input: { command: DEMO_COMMAND } })
  );
}

/**
 * The closing lines of a successful `init`: the demonstration, the library's age, a pointer.
 *
 * `overrideBlock` is the settings.json approval-override disclosure, already formatted with a
 * trailing newline per line, or empty. It only applies to Claude Code (whose `permissions.allow`
 * can silence a hold), so the Cursor path leaves it empty.
 */
function closing(
  catalog: readonly GuardRule[],
  agent: AgentSource,
  now: Date,
  overrideBlock = "",
): string {
  return (
    "Here it is working — a dangerous command, evaluated, not run:\n\n" +
    `${demonstrate(catalog, agent)}\n` +
    `${formatCatalogStamp(catalogStamp(), now)}\n` +
    overrideBlock +
    "Run `agenttrail-guard status` any time to see what it has been doing.\n"
  );
}

/** Run the demo through the real evaluator and describe the outcome. */
function demonstrate(catalog: readonly GuardRule[], agent: AgentSource): string {
  const mapped = demoCall(agent);
  const decision = evaluateCall(
    compileCatalog(catalog),
    buildGuardSpanContext(mapped),
    mapped,
    compileAllowlist([]),
  );
  if (decision.decision === "deny") {
    return (
      `  $ ${DEMO_COMMAND}\n` +
      `  BLOCKED — ${decision.reason}\n` +
      "  (nothing ran; that command was evaluated, not executed)\n"
    );
  }
  // Do NOT print a reassuring banner that is not true. If the demo does not fire,
  // something is wrong with the catalog and the user needs to know now, not later.
  return (
    `  $ ${DEMO_COMMAND}\n` +
    `  NOT BLOCKED — the bundled guardrails did not match (decision: ${decision.decision}).\n` +
    "  That is a problem: report it at https://github.com/agenttrailhq/guard\n"
  );
}

/**
 * `init --agent cursor`: plan by reading, then either describe the plan (`--print`) or carry
 * it out. Never runs `claude`.
 */
function initCursor(
  io: SetupIO,
  dryRun: boolean,
  scaffoldDir: string,
  deps: InitDeps,
  catalog: readonly GuardRule[],
  now: Date,
): number {
  const request = {
    setup: io,
    files: deps.cursorIo ?? createRealCursorFileIO(),
    scaffoldDir,
    nodePath: deps.nodePath ?? process.execPath,
    guardVersion: VERSION,
    now,
  };
  const planned = planCursorInstall(request);
  if (dryRun) {
    io.writeStdout(describeCursorInstall(planned));
    return 0;
  }
  if (!planned.ok) {
    io.writeStdout(`agenttrail-guard: ${planned.message}\n`);
    return 1;
  }
  const applied = applyCursorInstall(request, planned.value);
  if (!applied.ok) {
    io.writeStdout(`agenttrail-guard: ${applied.message}\n`);
    return 1;
  }
  // The Cursor analogue of the Claude path's approval-override disclosure: Cursor's own run
  // mode can auto-run a shell command before the guard's approval card shows.
  io.writeStdout(
    `${applied.value.join("\n")}\n\n${closing(catalog, "cursor", now, `${CURSOR_RUN_MODE_NOTE}\n`)}`,
  );
  return 0;
}

/**
 * Run `init`. Returns a process exit code; never throws, never calls `process.exit`.
 *
 * `--agent` must be exactly `claude` or `cursor`. Anything else, including no flag, prints
 * the choice and exits 1 before any read, write or spawn.
 *
 * `--print` performs every READ — version gate, coexistence check, marketplace state —
 * and then describes what it would do, writing no file and running no mutating command.
 */
export async function runInit(
  io: SetupIO,
  argv: InitArgs = {},
  deps: InitDeps = {},
): Promise<number> {
  const agent = chosenAgent(argv.agent);
  if (agent === undefined) {
    io.writeStdout(agentChoiceMessage("init"));
    return 1;
  }

  const dryRun = argv.print === true;
  const catalog = deps.catalog ?? SHIPPED_CATALOG;
  const now = deps.now ?? new Date();
  const home = io.homedir();

  let scaffoldDir: string;
  try {
    scaffoldDir = deps.scaffoldDir ?? resolvePluginScaffoldDir();
  } catch (error) {
    io.writeStdout(`agenttrail-guard: ${(error as Error).message}\n`);
    return 1;
  }

  if (agent === "cursor") return initCursor(io, dryRun, scaffoldDir, deps, catalog, now);

  // Coexistence FIRST, before any write or any spawn. The agenttrail plugin already does
  // what this hook does, and two hooks would mean two decisions, two prompts and twice
  // the latency. Declining is a normal outcome, so it exits 0, not 1.
  try {
    if (agenttrailPluginPresent(io.runClaude)) {
      io.writeStdout(
        `The agenttrail plugin (${AGENTTRAIL_PLUGIN_ID}) is already installed.\n\n` +
          "It already does everything the guard does, and more. Running both would mean\n" +
          "two hooks deciding on every tool call — two prompts, twice the latency, no\n" +
          "benefit. Leaving your setup untouched.\n\n" +
          "Nothing was written and nothing was changed.\n",
      );
      return 0;
    }
  } catch (error) {
    io.writeStdout(`agenttrail-guard: ${(error as Error).message}\n`);
    return 1;
  }

  if (dryRun) {
    io.writeStdout(dryRunReport(io, home, scaffoldDir, deps));
    return 0;
  }

  // Seed our own two files. Never overwrite: a re-run must not discard the user's
  // allowlist or their own rules, and idempotence is an acceptance criterion.
  const written: string[] = [];
  try {
    if (io.readFile(configPath(home)) === undefined) {
      io.writeFileAtomic(configPath(home), serializeDefaultConfig());
      written.push(configPath(home));
    }
    if (io.readFile(userRulesPath(home)) === undefined) {
      io.writeFileAtomic(userRulesPath(home), "[]\n");
      written.push(userRulesPath(home));
    }
  } catch (error) {
    io.writeStdout(
      `agenttrail-guard: could not write to ${guardDir(home)} — ${(error as Error).message}\n`,
    );
    return 1;
  }

  let result: ReturnType<typeof installGuardPlugin>;
  try {
    result = installGuardPlugin({
      runner: io.runClaude,
      scaffoldDir,
      bundledVersion: deps.bundledVersion ?? readBundledVersion(io, scaffoldDir),
      pathExists: (p) => io.exists(p),
    });
  } catch (error) {
    io.writeStdout(`agenttrail-guard: ${(error as Error).message}\n`);
    return 1;
  }

  const lines: string[] = [];
  switch (result.status) {
    case "already-installed":
      lines.push(`Already installed: ${result.pluginId} (scope: ${result.scope}).`);
      break;
    case "refreshed":
      lines.push(
        `Refreshed ${result.pluginId} — Claude Code runs a cached copy, so a changed`,
        "package on disk needs the plugin updated to take effect.",
        // `plugin update` itself prints "Restart to apply changes." Without saying so here,
        // a refresh looks like it did nothing — the user keeps the session open and keeps
        // running the OLD cached hook.
        "Restart Claude Code for the refreshed version to take effect.",
      );
      break;
    case "refresh-failed":
      lines.push(
        `WARNING: ${result.pluginId} is still installed, but could NOT be updated.`,
        `  ${result.refreshError ?? "no reason given"}`,
        "  It is still enforcing the version it already had — nothing was broken.",
        `  To retry by hand: claude plugin update ${result.pluginId} --scope ${result.scope}`,
      );
      break;
    default:
      lines.push(
        `Installed ${result.pluginId} (scope: ${result.scope}).`,
        // A fresh install needs the same restart the refresh path asks for: Claude Code
        // loads plugin hooks at session start, so the guard does not begin enforcing in
        // the session that is already open until it restarts.
        "Restart Claude Code for the guard to start enforcing.",
      );
  }

  if (result.marketplace === "recovered") {
    // The failure this whole command was hardened against. Say it plainly: the user
    // had an install that looked fine and could not have been updated.
    lines.push(
      "Recovered the marketplace: its recorded source had vanished, so the guard could",
      `not have been updated. Re-pointed at ${scaffoldDir}.`,
    );
  } else if (result.marketplace === "repointed") {
    lines.push(`Re-pointed the marketplace at ${scaffoldDir}.`);
  }

  if (result.marketplaceErrors.length > 0) {
    // Re-pointing clears these, so any still here are unexpected: print the vendor's
    // own words rather than a guess at what they mean.
    lines.push("", "WARNING: Claude Code still reports a problem with our marketplace:");
    for (const message of result.marketplaceErrors) lines.push(`  ${message}`);
  }

  if (result.disabled) {
    lines.push(
      "",
      "WARNING: the plugin is installed but DISABLED, so it is not enforcing anything.",
      `Run: claude plugin enable ${result.pluginId}`,
    );
  }
  for (const path of written) lines.push(`Wrote ${path}`);

  // The holds `settings.json` will override. A require_approval guardrail whose tool is
  // allowed outright never prompts (Claude Code's allow rule beats the hook's `ask`), so
  // saying so now is more honest than letting a hold be found to do nothing later. Read
  // against the shipped catalog's actions — the state just installed. Read-only, and only
  // on the Claude path: Cursor does not consult Claude Code's `permissions.allow`.
  const settingsFile = deps.settingsPath ?? claudeSettingsPath(home, process.env.CLAUDE_CONFIG_DIR);
  const allow = readPermissionAllow(io.readFile(settingsFile));
  const override =
    allow === undefined
      ? { total: 0, overridden: 0, tools: [] as readonly string[] }
      : approvalOverride(
          catalog.map((rule) => ({ match: rule.match, action: rule.defaultAction })),
          allow,
        );
  const overrideBlock = formatApprovalOverride(override)
    .map((line) => `${line}\n`)
    .join("");

  io.writeStdout(`${lines.join("\n")}\n\n${closing(catalog, "claude", now, overrideBlock)}`);
  return 0;
}
