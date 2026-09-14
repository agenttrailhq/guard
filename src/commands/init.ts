// cspell:words upsert repointed
/**
 * `agenttrail-guard init` — install the hook, seed the config, prove it works.
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
import { serializeDefaultConfig } from "../core/config.js";
import { compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { mapToolCall } from "../core/mapper.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { configPath, guardDir, userRulesPath } from "../core/paths.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardRule } from "../core/types.js";
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
    "agenttrail-guard init --print — this is what would happen. Nothing is changed.",
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

/** Run the demo through the real evaluator and describe the outcome. */
function demonstrate(catalog: readonly GuardRule[]): string {
  const mapped = mapToolCall({ tool_name: "Bash", tool_input: { command: DEMO_COMMAND } });
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
 * Run `init`. Returns a process exit code; never throws, never calls `process.exit`.
 *
 * `--print` performs every READ — version gate, coexistence check, marketplace state —
 * and then describes what it would do, writing no file and running no mutating command.
 */
export async function runInit(
  io: SetupIO,
  argv: { readonly print?: boolean } = {},
  deps: InitDeps = {},
): Promise<number> {
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
      lines.push(`Installed ${result.pluginId} (scope: ${result.scope}).`);
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

  io.writeStdout(
    `${lines.join("\n")}\n\n` +
      "Here it is working — a dangerous command, evaluated, not run:\n\n" +
      `${demonstrate(catalog)}\n` +
      `${formatCatalogStamp(catalogStamp(), now)}\n` +
      "Run `agenttrail-guard status` any time to see what it has been doing.\n",
  );
  return 0;
}
