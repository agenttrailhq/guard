// cspell:words unvouched
/**
 * `agenttrail-guard status` — is this on, what has it done, and how do I quieten it?
 *
 * ── Three things here are load-bearing, and all are about REACHING A PERSON ──
 *
 * 1. **Invalid user rules are printed FIRST, above everything.** A broken rule in
 *    `guardrails.json` is skipped rather than fatal, and the natural implementation warns on
 *    stderr and carries on. That warning reaches nobody: stderr from a hook that exits
 *    0 goes to a debug log the user never sees (`hooks.md:794`). So they keep believing
 *    a rule protects them when it does not. `status` is the only channel that reaches
 *    them, which is why this section is not buried below the decisions.
 *
 * 2. **A dangling plugin source is a PROBLEM, not silence.** A `directory` marketplace
 *    source pins an absolute path — under `npx`, a package-manager cache that may be
 *    collected. When it goes, the guard keeps enforcing from Claude Code's own cached
 *    copy, so nothing looks wrong; it simply can never be updated again. `status` is
 *    the only place a person would ever find that out, so it says so and gives the one
 *    line that fixes it.
 *
 * 3. **The most frequent match, with the exact command to silence THAT rule.** The
 *    single most likely reason someone uninstalls is one rule firing repeatedly on
 *    something legitimate. A user who has to work out which of 56 rules fired, and then
 *    find the syntax, uninstalls instead.
 *
 * ── The printed command is now real, and single-quoted ──────────────────────
 * The line this prints is a line that works — `guardrails allow` really accepts it. It
 * was never "fixed" by printing a `config.json` edit instead, and that restraint was
 * the point: the alternative teaches people to hand-edit config, and that is what they
 * would keep doing after the proper command existed.
 *
 * The QUOTING changed with it. Double quotes mis-split
 * on a command containing `"` — `echo "hi"` printed `… "echo "hi""` — and worse, they
 * let the shell expand `$VAR` and backticks on paste, so `rm -rf $DIR` silenced a
 * pattern the user never typed. Single quotes suppress every expansion; an embedded `'`
 * is escaped the POSIX way. `setup-commands.test.ts` pins the spelling and round-trips
 * it through `runRules`, because a self-consistent quoting scheme can still be wrong.
 *
 * ── The commands printed here are NOT re-scrubbed ────────────────────────────
 * `core/events.ts` scrubs every command BEFORE writing it, and `scrubText` is not
 * idempotent — a second pass mangles 11 of the 14 placeholder kinds. So nothing on
 * this path scrubs, and the property is tested directly: six secret shapes
 * through the real recorder, `runStatus` over the result, each raw secret absent from
 * this output (`events.test.ts`).
 *
 * The one consequence is handled above: a redacted command cannot serve as a match
 * pattern, so the silence suggestion is withheld and explained rather than printed.
 */

import { PACKS } from "@agenttrail/guardrails";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { catalogStamp, formatCatalogStamp } from "../core/catalog-stamp.js";
import { inspectConfig } from "../core/config-report.js";
import { mostFrequentMatch, parseDecisionLog } from "../core/decision-log.js";
import { configPath, eventsPath, userRulesPath } from "../core/paths.js";
import { isRedacted, PATTERN_PLACEHOLDER } from "../core/redaction.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardRule } from "../core/types.js";
import { loadUserRules } from "../core/user-rules.js";
import { parseUserRulesData } from "../core/user-rules-data.js";
import { GUARD_PLUGIN_ID, readInstalledPlugin, readMarketplaceHealth } from "../plugin/install.js";
import type { SetupIO } from "../setup-io.js";

/** The one-line fix for a dangling plugin source. It re-points the marketplace. */
export const REPOINT_COMMAND = "npx @agenttrail/guard init";

/**
 * The exact one-line fix `status` prints, and the one `guardrails allow` parses.
 *
 * Pinned in `setup-commands.test.ts` precisely so the two cannot drift: the string a
 * user is told to type and the string the CLI accepts have to be one string. It has
 * three dependents — that pin, the decision log's withheld-pattern line, and
 * `guardrails allow` itself — so changing it is never a local change.
 *
 * The pin alone is not enough, and `rules-command.test.ts` carries the test that is:
 * the printed line is shell-split and fed back through `runRules`, and the stored
 * pattern must equal the original command. A quoting scheme can be self-consistent and
 * still wrong, which a pinned string would not notice.
 */
export function silenceCommand(ruleId: string, pattern: string): string {
  return `agenttrail-guard guardrails allow ${ruleId} ${shellQuote(pattern)}`;
}

/**
 * Wrap a value so a POSIX shell passes it through as one unexpanded argument.
 *
 * Single quotes, because inside them a shell expands nothing at all — `$VAR`, backticks,
 * `!`, `*` and `"` all reach `argv` verbatim. A literal `'` cannot appear inside single
 * quotes, so it is closed, escaped and reopened: `it's` becomes `'it'\''s'`.
 */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * The stand-in `status` prints when it cannot suggest a real pattern lives in
 * `core/redaction.js` — imported above, NOT redeclared here.
 *
 * A second copy here would typecheck, satisfy every
 * test, and still be the exact drift hole the shared module exists to close: `rules
 * allow` refuses this string by value, so rewording one copy silently stops the refusal
 * matching and a pasted placeholder goes back to compiling into a rule that can never
 * fire — with nothing going red. One definition, three consumers (`status` prints it,
 * `allow-guard` refuses it, the tests pin it).
 */

/** How many recent decisions to show. */
const RECENT_LIMIT = 5;

export interface StatusDeps {
  readonly catalog?: readonly GuardRule[];
  readonly now?: Date;
  /** `--clear-history`: empty the decision log and return, printing nothing else. */
  readonly clearHistory?: boolean;
}

/** Run `status`. Returns an exit code; never throws, never calls `process.exit`. */
export async function runStatus(io: SetupIO, deps: StatusDeps = {}): Promise<number> {
  const home = io.homedir();

  // ── `--clear-history`. Handled first: it is the whole command, not a modifier. ──
  // TRUNCATE rather than delete, so the 0600 file and its 0700 directory survive and
  // the next append cannot recreate the file with a wider mode. Deleting it by hand
  // stays safe either way — `parseDecisionLog(undefined)` is `[]`.
  if (deps.clearHistory === true) {
    const path = eventsPath(home);
    try {
      io.writeFileAtomic(path, "");
    } catch {
      // Loud, and non-zero. A destructive command that silently did nothing is
      // worse than one that failed: the user would believe the log was cleared.
      io.writeStdout(`Could not clear the decision log at ${path}.\n`);
      return 1;
    }
    io.writeStdout(`Decision log cleared: ${path}\n`);
    return 0;
  }

  const now = deps.now ?? new Date();
  const catalog = deps.catalog ?? SHIPPED_CATALOG;
  const out: string[] = [];

  // ── Install state. Three-valued on purpose. ────────────────────────────────
  // `enabled` is the difference between "installed" and "enforcing": a disabled plugin
  // is still listed by `plugin list --json`, so reading only `id` would report it as
  // installed while it enforces nothing.
  let installed: ReturnType<typeof readInstalledPlugin>;
  try {
    installed = readInstalledPlugin(io.runClaude, GUARD_PLUGIN_ID);
  } catch {
    installed = undefined;
  }

  // ── Count what RUNS; explain with the stricter validator. ─────────────────
  // The hook loads `guardrails.json` through `parseUserRulesData` (zero-zod, structural).
  // `loadUserRules` is stricter and produces the messages. Counting with the strict one
  // would print a number that disagrees with what is actually enforcing — which is this
  // package's own recurring defect, one level up — so the count comes from the hook's
  // loader and any difference between the two is REPORTED rather than hidden.
  const configText = io.readFile(configPath(home));
  const rulesText = io.readFile(userRulesPath(home));
  const { config, problems } = inspectConfig(configText, PACKS);
  const userRules = loadUserRules(rulesText);
  const enforcedUserRules = parseUserRulesData(rulesText);
  const compiled = compileCatalog([...catalog, ...enforcedUserRules], config);

  // Strict ⊆ structural, so the gap is what the hook admits and the validator did not.
  const vouched = new Set(userRules.valid.map((r) => r.id));
  const unvouched = enforcedUserRules.filter((r) => !vouched.has(r.id));

  if (installed === undefined) {
    out.push("Enforcement: NOT INSTALLED — run `agenttrail-guard init`.");
  } else if (!installed.enabled) {
    out.push(
      "Enforcement: OFF — the plugin is installed but disabled, so nothing is checked.",
      `  Turn it back on: claude plugin enable ${GUARD_PLUGIN_ID}`,
    );
  } else {
    const packs = config.enabledPacks?.length ?? 0;
    out.push(
      `Enforcement: ON · ${compiled.length} guardrails` +
        (packs > 0 ? ` across ${packs} packs` : "") +
        (enforcedUserRules.length > 0 ? ` (${enforcedUserRules.length} of them yours)` : ""),
    );
  }
  out.push(`  ${formatCatalogStamp(catalogStamp(), now)}`);

  // ── Is the plugin source still there? ──────────────────────────────────────
  // Attached to the install-state stanza because that is what it IS — it does not
  // displace the invalid-user-rules block below, which the docblock pins as the first
  // standalone PROBLEM section.
  //
  // Two channels, because each covers the other's blind spot (see `install.ts`):
  // the vendor's own `errors[]` on our row, and our stat of the recorded path. Either
  // one firing is reported. Silence requires BOTH to be quiet — but `unknown` health
  // is silence too, because "we could not look" is not "it is broken", and a scary
  // unactionable line on a healthy machine is how a tool gets uninstalled.
  if (installed !== undefined) {
    const health = readMarketplaceHealth(io.runClaude, (p) => io.exists(p));
    const vendorErrors = installed.errors;
    if (health.kind === "dangling" || vendorErrors.length > 0) {
      out.push(
        "",
        "PROBLEM: the plugin source is missing, so the guard cannot be updated.",
        "  It is still enforcing — Claude Code runs its own cached copy — but an",
        "  upgrade, or any guardrail-library refresh, has nowhere to read from.",
      );
      if (health.kind === "dangling") out.push(`  Recorded source: ${health.path}`);
      for (const message of vendorErrors) out.push(`  Claude Code says: ${message}`);
      out.push(`  Fix it in one line: ${REPOINT_COMMAND}`);
    }
  }

  // ── Invalid user rules — FIRST, and loud. See the docblock. ────────────────
  if (userRules.invalid.length > 0) {
    out.push(
      "",
      `PROBLEM: ${userRules.invalid.length} of your own guardrails ${
        userRules.invalid.length === 1 ? "is" : "are"
      } invalid and ${userRules.invalid.length === 1 ? "is" : "are"} NOT running.`,
      "  Nothing else told you this — a hook's stderr goes to a log you never see.",
    );
    for (const bad of userRules.invalid) {
      out.push(`    ${bad.id}: ${bad.reason}`);
    }
    out.push(`  Fix them in ${userRulesPath(home)}`);
  }

  // ── Rules that are RUNNING but that the validator would not pass. ──────────
  // Not folded into either count. The user needs both halves: it is enforcing, and we
  // cannot vouch for it. Showing one number and moving on is how the two loaders drift
  // apart without anyone noticing.
  if (unvouched.length > 0) {
    out.push(
      "",
      `NOTE: ${unvouched.length} of your guardrails ${unvouched.length === 1 ? "is" : "are"} loaded and enforcing, but ${unvouched.length === 1 ? "does" : "do"} not pass the stricter check:`,
    );
    for (const r of unvouched) out.push(`    ${r.id}`);
    out.push(
      `  They are counted above because they run. Check them with \`agenttrail-guard guardrails validate\`.`,
    );
  }

  // ── Settings the config file lost. ────────────────────────────────────────
  // `parseConfig` is fail-open, so a wrong value resolves to a default and leaves no
  // trace — `guardrailActionOverrides: {"x": "ask"}` is discarded outright. `status` is the
  // only channel that reaches a person, the same argument the invalid-rules block above
  // is built on.
  if (problems.length > 0) {
    out.push(
      "",
      `PROBLEM: ${problems.length} setting${problems.length === 1 ? "" : "s"} in your config.json ${problems.length === 1 ? "was" : "were"} ignored.`,
    );
    for (const p of problems) out.push(`    ${p.where}: ${p.reason}`);
    out.push(`  Fix them in ${configPath(home)}`);
  }

  // ── Recent decisions + the noisy rule. ─────────────────────────────────────
  const records = parseDecisionLog(io.readFile(eventsPath(home)));

  if (records.length === 0) {
    out.push("", "No decisions recorded yet.");
  } else {
    const recent = records.slice(-RECENT_LIMIT).reverse();
    out.push("", `Recent decisions (${records.length} recorded):`);
    for (const r of recent) {
      out.push(`  ${r.decision.padEnd(5)} ${r.ruleId.padEnd(24)} ${r.command}`);
    }

    const top = mostFrequentMatch(records);
    if (top !== undefined) {
      // The rule and the count are printed either way. Only the PATTERN is
      // withheld when the shape was redacted — going quiet instead would read as
      // "no noisy rule", which is the same silent failure in a new place.
      out.push("", "Most frequent match", `  ${top.ruleId}   ${top.count}x   ${top.command}`, "");

      if (isRedacted(top.command)) {
        // A placeholder is not a shape. It is also a picomatch BRACKET EXPRESSION,
        // so `guardrails allow` would accept it, compile it as a character class, match
        // almost nothing, and report success.
        out.push(
          "That command contained a secret, so it is stored redacted — and a redaction",
          "placeholder cannot be used as a match pattern. Write the pattern against the",
          "real command yourself:",
          `  ${silenceCommand(top.ruleId, PATTERN_PLACEHOLDER)}`,
        );
      } else {
        out.push(
          "If that is expected, silence just this guardrail for that shape:",
          `  ${silenceCommand(top.ruleId, top.command)}`,
        );
      }

      out.push(
        "",
        "That does not disable the guardrail and does not turn off the guard — it stops",
        "this one guardrail matching this one shape.",
      );
    }
  }

  io.writeStdout(`${out.join("\n")}\n`);
  return 0;
}
