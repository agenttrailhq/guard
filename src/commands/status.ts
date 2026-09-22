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
 * ── One section per app ──────────────────────────────────────────────────────
 * `status` takes no `--agent`: it reports Claude Code, Cursor and Codex CLI, one section
 * each.
 *
 * - **Claude Code.** `claude --version` runs first. When `claude` cannot be started, the
 *   section says Claude Code was not found and reads no plugin state, because a failed
 *   `plugin list` would otherwise read as "not installed". Any other failure there falls
 *   through to the plugin reads.
 * - **Cursor.** Read from `~/.cursor/hooks.json`. `ON` needs both of guard's entries, each
 *   running a command in exactly the form `init --agent cursor` writes, and the Node and
 *   hook copy that command names must exist. Anything short of that, once any guard entry
 *   is there, is `BROKEN`, with the reason. A Cursor hook that cannot run lets every call
 *   through and shows nothing, so this section is the only place that is visible.
 * - **Codex CLI.** Read from `~/.codex/hooks.json`, and held to more than Cursor's test,
 *   because Codex approves a hook by hashing its whole entry AND by its position in the
 *   file. So `ON` also needs the matcher and the timeout guard writes, guard's handler
 *   alone in its group, and the entry still at the position `codex/install.json` recorded.
 *   An entry that has moved, or that guard did not write, is `BROKEN` — Codex stops running
 *   it and says nothing. What `status` will NOT do is claim to know whether the hook was
 *   approved: that state is in Codex's `config.toml`, guard has no TOML parser and must not
 *   grow one, so the section says where the answer lives instead of inventing one.
 * - **Crash records.** Each section counts the hook's records in the crash spool. A record
 *   does not say which app launched the hook, so every section shows the same count and says
 *   it is shared.
 *
 * Apart from `--clear-history`, `status` writes nothing, through any of its IO seams. It
 * reads file contents only under the home folder its `SetupIO` names. Beyond that it only
 * checks that some paths exist: Claude Code's recorded plugin source, and the Node and hook
 * copy that guard's Cursor and Codex entries run.
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

import { join } from "node:path";
import { type CodexFileIO, createRealCodexFileIO } from "../codex/codex-io.js";
import {
  CODEX_HOOK_MATCHER,
  CODEX_HOOK_TIMEOUT,
  CODEX_TRUST_NOTE,
  type CodexInstallRecord,
  codexHookCommand,
  GUARD_CODEX_EVENTS,
  guardGroupIndex,
  isGuardCodexCommand,
  parseCodexInstallRecord,
  readCodexHooksFile,
} from "../codex/install.js";
import { checkAllowPattern } from "../core/allow-guard.js";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { catalogStamp, formatCatalogStamp } from "../core/catalog-stamp.js";
import {
  approvalOverride,
  claudeSettingsPath,
  formatApprovalOverride,
  readPermissionAllow,
} from "../core/claude-settings.js";
import { inspectConfig } from "../core/config-report.js";
import { readSpool } from "../core/crash-store.js";
import { GUARD_CURSOR_EVENTS, isGuardCursorCommand } from "../core/cursor-entry.js";
import { mostFrequentMatch, parseDecisionLog } from "../core/decision-log.js";
import {
  codexHooksPath,
  codexInstallRecordPath,
  configPath,
  cursorHooksPath,
  cursorInstallRecordPath,
  eventsPath,
  userRulesPath,
} from "../core/paths.js";
import { isRedacted, PATTERN_PLACEHOLDER } from "../core/redaction.js";
import { blockFixtureCommands } from "../core/rule-fixtures.js";
import { buildRuleViews } from "../core/rule-view.js";
import { compileCatalog } from "../core/rules.js";
import { oneLineForDisplay } from "../core/scan-report.js";
import type { GuardRule } from "../core/types.js";
import { loadUserRules } from "../core/user-rules.js";
import { parseUserRulesData } from "../core/user-rules-data.js";
import { VERSION } from "../core/version.js";
import { type CursorFileIO, createRealCursorFileIO } from "../cursor/cursor-io.js";
import { CURSOR_RUN_MODE_NOTE, cursorHookCommand, readHooksFile } from "../cursor/install.js";
import { createRealIO, type GuardIO } from "../io.js";
import {
  ClaudeCliNotFoundError,
  ensureClaudeSupportsPlugins,
  GUARD_PLUGIN_ID,
  guardPluginCacheDir,
  isVersionAtLeast,
  parseClaudeVersion,
  readInstalledPlugin,
  readMarketplaceHealth,
} from "../plugin/install.js";
import type { SetupIO } from "../setup-io.js";

/**
 * The one-line fix for a dangling plugin source. It re-points the marketplace. `@latest`
 * so `npx` resolves the current release rather than re-running a copy it cached earlier.
 */
export const REPOINT_COMMAND = "npx @agenttrail/guard@latest init --agent claude";

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

/** The command that installs guard for Cursor, or puts a broken install right. */
const CURSOR_INIT = "agenttrail-guard init --agent cursor";

/** The command that installs guard for Codex CLI, or puts a broken install right. */
const CODEX_INIT = "agenttrail-guard init --agent codex";

/** The command that refreshes Claude Code's cached copy of the plugin to this version. */
const CLAUDE_INIT = "agenttrail-guard init --agent claude";

/** What to do when an app runs a NEWER guard than the command reporting on it. */
const UPDATE_CLI =
  "Run `npx @agenttrail/guard@latest status`, or update this command with `npm install -g @agenttrail/guard@latest`.";

/**
 * Whether `a` is a strictly newer release than `b`, by `x.y.z`.
 *
 * Deliberately narrow: an unparsable version, or two that differ only after `x.y.z`, is
 * never "newer", so the refresh advice stays the default and only a clear downgrade is
 * steered away from.
 */
function isNewerThan(a: string, b: string): boolean {
  const va = parseClaudeVersion(a);
  const vb = parseClaudeVersion(b);
  if (va === null || vb === null) return false;
  return isVersionAtLeast(va, vb) && !isVersionAtLeast(vb, va);
}

/** Shown whenever guard's Cursor entries are there, working or not. */
const AGENT_WINDOW_NOTE =
  "  Use Cursor in an editor window: Cursor's Agent Window can skip hooks, so guard may not check its agent there.";

export interface StatusDeps {
  readonly catalog?: readonly GuardRule[];
  readonly now?: Date;
  /** `--clear-history`: empty the decision log and return, printing nothing else. */
  readonly clearHistory?: boolean;
  /** Reads `~/.cursor/hooks.json` and guard's Cursor files. The real file system when omitted. */
  readonly cursorIo?: CursorFileIO;
  /** Reads `~/.codex/hooks.json` and guard's Codex files. The real file system when omitted. */
  readonly codexIo?: CodexFileIO;
  /** Reads the crash spool, which the hook writes. The real one when omitted. */
  readonly guardIo?: GuardIO;
  /**
   * Path to Claude Code's `settings.json`, for the approval-override check. Defaults to
   * `CLAUDE_CONFIG_DIR`'s `settings.json`, else `~/.claude/settings.json`. Injectable so
   * a test need not depend on the runner's environment.
   */
  readonly settingsPath?: string;
}

/** What `status` found for guard's Cursor install. */
type CursorState =
  | { readonly kind: "on" }
  | { readonly kind: "not-installed" }
  | { readonly kind: "broken"; readonly reason: string };

/** A JSON object: not `null`, and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An error's message, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A guard entry's command: the Node and the hook copy, each in double quotes. */
const GUARD_COMMAND = /^"([^"]+)" "([^"]+)" --agent cursor$/;

/**
 * The Node and hook copy a guard entry's command runs, when the command is exactly what
 * `cursorHookCommand` writes for them. `undefined` for any other spelling.
 */
function parseGuardCommand(command: string): { node: string; copy: string } | undefined {
  const match = GUARD_COMMAND.exec(command);
  const node = match?.[1];
  const copy = match?.[2];
  if (node === undefined || copy === undefined) return undefined;
  return cursorHookCommand(node, copy) === command ? { node, copy } : undefined;
}

/**
 * Guard's Cursor install, as `~/.cursor/hooks.json` and the files its entries name show it.
 *
 * Reads only, and never throws: a read that fails is a `broken` reason.
 */
function readCursorState(home: string, files: CursorFileIO): CursorState {
  const hooksPath = cursorHooksPath(home);
  const broken = (reason: string): CursorState => ({ kind: "broken", reason });

  let text: string | undefined;
  try {
    text = files.readFile(hooksPath);
  } catch (error) {
    return broken(`could not read ${hooksPath} — ${messageOf(error)}`);
  }
  if (text === undefined) return { kind: "not-installed" };

  const read = readHooksFile(text);
  if (!read.ok) return broken(`${hooksPath} ${read.reason}`);

  const lists = GUARD_CURSOR_EVENTS.map((event) => ({
    event,
    commands: (read.hooks[event] ?? []).flatMap((entry) =>
      isRecord(entry) && typeof entry.command === "string" && isGuardCursorCommand(entry.command)
        ? [entry.command]
        : [],
    ),
  }));
  const present = lists.find((list) => list.commands.length > 0);
  if (present === undefined) return { kind: "not-installed" };
  const absent = lists.find((list) => list.commands.length === 0);
  if (absent !== undefined) {
    return broken(
      `${hooksPath} has guard's ${present.event} entry but not its ${absent.event} entry`,
    );
  }

  const found = new Set<string>();
  for (const { event, commands } of lists) {
    for (const command of commands) {
      const parsed = parseGuardCommand(command);
      if (parsed === undefined) {
        return broken(
          `guard's ${event} entry in ${hooksPath} runs a command in a form guard does not write`,
        );
      }
      const named = [
        ["the Node", parsed.node],
        ["the hook copy", parsed.copy],
      ] as const;
      for (const [what, path] of named) {
        if (found.has(path)) continue;
        let mode: number | undefined;
        try {
          mode = files.fileMode(path);
        } catch (error) {
          return broken(`could not check ${path} — ${messageOf(error)}`);
        }
        if (mode === undefined) {
          return broken(`${what} that guard's ${event} entry runs is missing: ${path}`);
        }
        found.add(path);
      }
    }
  }
  return { kind: "on" };
}

/** What `status` found for guard's Codex install. */
type CodexState =
  | { readonly kind: "on" }
  | { readonly kind: "not-installed" }
  | { readonly kind: "broken"; readonly reason: string; readonly fix: string };

/** The fix for a Codex install `init` can put right. */
const CODEX_AGAIN = `Run \`${CODEX_INIT}\` again.`;

/**
 * The fix for the one Codex state `init` CANNOT put right.
 *
 * Re-running `init` would leave the entry where it is — guard never moves one — and only
 * re-record the new position, so the report would go quiet without anything being approved.
 * The one action that restores enforcement is the user's, in Codex.
 */
const CODEX_APPROVE_AGAIN =
  "Codex approves a hook by its position, so guard's is no longer approved and is not running. Approve it again in Codex's /hooks screen.";

/** A guard entry's command: the Node and the hook copy, each in double quotes. */
const GUARD_CODEX_COMMAND = /^"([^"]+)" "([^"]+)" --agent codex$/;

/**
 * The Node and hook copy a guard entry's command runs, when the command is exactly what
 * `codexHookCommand` writes for them. `undefined` for any other spelling.
 */
function parseGuardCodexCommand(command: string): { node: string; copy: string } | undefined {
  const match = GUARD_CODEX_COMMAND.exec(command);
  const node = match?.[1];
  const copy = match?.[2];
  if (node === undefined || copy === undefined) return undefined;
  return codexHookCommand(node, copy) === command ? { node, copy } : undefined;
}

/**
 * The command in a hook group, when the group is the entry guard writes: guard's matcher,
 * guard's handler alone in the group, `type: "command"`, and guard's timeout.
 *
 * Every one of those is checked because Codex's approval covers all of them. An entry that
 * differs anywhere is an entry no approval matches, so it is not running — which is a
 * broken install, however healthy the file looks.
 *
 * Keys Codex does not hash are not counted, so a comment field someone added is not a fault.
 */
function guardCodexEntryCommand(group: unknown): string | undefined {
  if (!isRecord(group) || group.matcher !== CODEX_HOOK_MATCHER) return undefined;
  // One handler, so guard's handler index is 0 — the other half of the approval's key.
  if (!Array.isArray(group.hooks) || group.hooks.length !== 1) return undefined;
  const handler = group.hooks[0];
  if (!isRecord(handler)) return undefined;
  if (handler.type !== "command" || handler.timeout !== CODEX_HOOK_TIMEOUT) return undefined;
  return typeof handler.command === "string" && isGuardCodexCommand(handler.command)
    ? handler.command
    : undefined;
}

/** `codex/install.json` as far as it can be read. Never throws. */
function readCodexRecord(home: string, files: CodexFileIO): CodexInstallRecord | undefined {
  try {
    return parseCodexInstallRecord(files.readFile(codexInstallRecordPath(home)));
  } catch {
    return undefined;
  }
}

/**
 * Guard's Codex install, as `~/.codex/hooks.json`, `codex/install.json` and the files the
 * entries name show it.
 *
 * Reads only, and never throws: a read that fails is a `broken` reason.
 */
function readCodexState(
  home: string,
  files: CodexFileIO,
  record: CodexInstallRecord | undefined,
): CodexState {
  const hooksPath = codexHooksPath(home);
  const broken = (reason: string, fix: string = CODEX_AGAIN): CodexState => ({
    kind: "broken",
    reason,
    fix,
  });
  // `install.json` is guard's own record that it installed. With it there and the entries
  // gone, "not installed" would hide the fact that something removed them.
  const gone = (what: string): CodexState =>
    record === undefined
      ? { kind: "not-installed" }
      : broken(`guard is recorded as installed for Codex CLI, but ${what}`);

  let text: string | undefined;
  try {
    text = files.readFile(hooksPath);
  } catch (error) {
    return broken(`could not read ${hooksPath} — ${messageOf(error)}`);
  }
  if (text === undefined) return gone(`there is no ${hooksPath}`);

  const read = readCodexHooksFile(text);
  if (!read.ok) return broken(`${hooksPath} ${read.reason}`);

  const lists = GUARD_CODEX_EVENTS.map((event) => {
    const list = read.hooks[event] ?? [];
    return { event, list, at: guardGroupIndex(list) };
  });
  const present = lists.find((entry) => entry.at >= 0);
  if (present === undefined) return gone(`${hooksPath} holds no guard entry`);
  const absent = lists.find((entry) => entry.at < 0);
  if (absent !== undefined) {
    return broken(
      `${hooksPath} has guard's ${present.event} entry but not its ${absent.event} entry`,
    );
  }

  const found = new Set<string>();
  for (const { event, list, at } of lists) {
    const command = guardCodexEntryCommand(list[at]);
    if (command === undefined) {
      return broken(
        `guard's ${event} entry in ${hooksPath} is not the entry guard writes, so Codex's approval of it no longer applies`,
      );
    }
    const parsed = parseGuardCodexCommand(command);
    if (parsed === undefined) {
      return broken(
        `guard's ${event} entry in ${hooksPath} runs a command in a form guard does not write`,
      );
    }
    const named = [
      ["the Node", parsed.node],
      ["the hook copy", parsed.copy],
    ] as const;
    for (const [what, path] of named) {
      if (found.has(path)) continue;
      let mode: number | undefined;
      try {
        mode = files.fileMode(path);
      } catch (error) {
        return broken(`could not check ${path} — ${messageOf(error)}`);
      }
      if (mode === undefined) {
        return broken(`${what} that guard's ${event} entry runs is missing: ${path}`);
      }
      found.add(path);
    }
  }

  // Last, because it is the one fault `init` cannot repair, and the least likely: it means
  // another tool put a hook ahead of guard's since the install.
  for (const { event, at } of lists) {
    const recorded = record?.groupIndex[event];
    if (recorded !== undefined && recorded !== at) {
      return broken(
        `guard's ${event} entry in ${hooksPath} has moved from position ${recorded} to position ${at} since it was installed`,
        CODEX_APPROVE_AGAIN,
      );
    }
  }
  return { kind: "on" };
}

/** The guard version `install.json` records, or `undefined` when it cannot be read. */
function recordedCursorVersion(home: string, files: CursorFileIO): string | undefined {
  try {
    const text = files.readFile(cursorInstallRecordPath(home));
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.guardVersion === "string"
      ? parsed.guardVersion
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The crash-record line both sections show, or `undefined` when the hook has none.
 *
 * `spoolIo` names the home folder, so the spool read is the one under it. Never throws.
 */
function hookCrashLine(spoolIo: GuardIO): string | undefined {
  let records: ReturnType<typeof readSpool>;
  try {
    records = readSpool(spoolIo);
  } catch {
    return undefined;
  }
  const hook = records.filter((crash) => crash.record.command === "hook");
  if (hook.length === 0) return undefined;
  // ISO-8601 in UTC, so the text order is the time order.
  const newest = hook.reduce<string | undefined>((latest, crash) => {
    const ts: unknown = crash.record.ts;
    return typeof ts === "string" && (latest === undefined || ts > latest) ? ts : latest;
  }, undefined);
  return (
    `  Crash records from guard's hook (shared by Claude Code, Cursor and Codex): ${hook.length}` +
    `${newest === undefined ? "" : `, newest ${newest}`}. See \`agenttrail-guard crash-report\`.`
  );
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

  // ── Is Claude Code there at all? ──────────────────────────────────────────
  // `readInstalledPlugin` reads a `claude` that cannot start as "not installed", which
  // would tell someone without Claude Code to run `init --agent claude`. Only a failure to
  // start counts: an old or unreadable version falls through to the reads below.
  let claudeFound = true;
  try {
    ensureClaudeSupportsPlugins(io.runClaude);
  } catch (error) {
    if (error instanceof ClaudeCliNotFoundError) claudeFound = false;
  }

  // ── Install state. Three-valued on purpose. ────────────────────────────────
  // `enabled` is the difference between "installed" and "enforcing": a disabled plugin
  // is still listed by `plugin list --json`, so reading only `id` would report it as
  // installed while it enforces nothing.
  let installed: ReturnType<typeof readInstalledPlugin>;
  try {
    installed = claudeFound ? readInstalledPlugin(io.runClaude, GUARD_PLUGIN_ID) : undefined;
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
  const userRules = loadUserRules(rulesText);
  const enforcedUserRules = parseUserRulesData(rulesText);
  // A user's own category can be disabled by name, just like a library pack, so it is a
  // known pack for spotting a misspelled `disabledPacks` entry.
  const { config, problems } = inspectConfig(configText, [
    ...new Set([...catalog, ...enforcedUserRules].map((r) => r.category)),
  ]);
  const compiled = compileCatalog([...catalog, ...enforcedUserRules], config);

  // Strict ⊆ structural, so the gap is what the hook admits and the validator did not.
  const vouched = new Set(userRules.valid.map((r) => r.id));
  const unvouched = enforcedUserRules.filter((r) => !vouched.has(r.id));

  // What an app with guard installed enforces. Both apps' hooks load the same config,
  // library and user guardrails, so the number is the same in both sections.
  //
  // Packs are reported as ENABLED of the LIBRARY's packs, resolved from `disabledPacks`:
  // the config names only what is off, so this line is where a person sees what is on.
  const libraryPacks = [...new Set(catalog.map((r) => r.category))];
  const offPacks = new Set(config.disabledPacks);
  const enabledPackCount = libraryPacks.filter((p) => !offPacks.has(p)).length;
  const enforcing =
    `Enforcement: ON · ${compiled.length} guardrails` +
    (libraryPacks.length > 0 ? ` across ${enabledPackCount} of ${libraryPacks.length} packs` : "") +
    (enforcedUserRules.length > 0 ? ` (${enforcedUserRules.length} of them yours)` : "");

  // ── require_approval holds a settings.json allow rule overrides. ───────────
  // A hold returns Claude Code's `ask`, but a matching `permissions.allow` rule wins:
  // the tool runs with NO prompt. Count the holds that silences, over the SAME enabled +
  // effective-action set the enforcement line above describes, so status does not claim
  // a hold that can never fire. Read-only; the hook cannot see this happen (it is one
  // fresh process per call with no view of the outcome), so status is the only surface.
  // This is Claude Code's own `permissions.allow`, so it is disclosed only in that section.
  const views = buildRuleViews(catalog, enforcedUserRules, config);
  const settingsFile = deps.settingsPath ?? claudeSettingsPath(home, process.env.CLAUDE_CONFIG_DIR);
  const allow = readPermissionAllow(io.readFile(settingsFile));
  const override =
    allow === undefined
      ? { total: 0, overridden: 0, tools: [] as readonly string[] }
      : approvalOverride(
          views.filter((v) => v.enabled).map((v) => ({ match: v.rule.match, action: v.action })),
          allow,
        );

  // Records carry no app, so each section shows the same line.
  const crashLine = hookCrashLine({ ...(deps.guardIo ?? createRealIO()), homedir: () => home });

  // ── Claude Code ────────────────────────────────────────────────────────────
  if (!claudeFound) {
    out.push(
      "Claude Code: not found. Once it is installed, run `agenttrail-guard init --agent claude`.",
    );
  } else {
    out.push("Claude Code");
    if (installed === undefined) {
      out.push("Enforcement: NOT INSTALLED — run `agenttrail-guard init --agent claude`.");
    } else if (!installed.enabled) {
      out.push(
        "Enforcement: OFF — the plugin is installed but disabled, so nothing is checked.",
        `  Turn it back on: claude plugin enable ${GUARD_PLUGIN_ID}`,
      );
    } else {
      out.push(enforcing);
      // Name the cached copy that is actually running, so which version enforces is
      // unambiguous — Claude Code runs a per-version cache, not the installed source, and
      // stale versions can sit beside it. Show the full path when it is where the
      // documented layout puts it; otherwise fall back to the version alone rather than
      // assert a path that is not there.
      if (installed.version !== undefined) {
        const bundle = join(
          guardPluginCacheDir(home, process.env.CLAUDE_CONFIG_DIR),
          installed.version,
        );
        out.push(
          io.exists(bundle)
            ? `  Active bundle: ${bundle}`
            : `  Active version: ${installed.version}`,
        );
        // The step an update most often misses. Installing a new guard replaces the files
        // on disk, but Claude Code keeps running the cached copy until `init` refreshes it
        // and Claude Code restarts — so the CLI is current while the old hook enforces.
        // When the cached copy is the NEWER one, it is this command that is out of date, and
        // running its `init` would downgrade the plugin, so that is never what it suggests.
        if (installed.version !== VERSION) {
          out.push(
            isNewerThan(installed.version, VERSION)
              ? `  Claude Code is running guard ${installed.version}, newer than this guard ${VERSION} — this command is out of date. ${UPDATE_CLI}`
              : `  Claude Code is running guard ${installed.version}; this is guard ${VERSION}. Refresh it: \`${CLAUDE_INIT}\`, then restart Claude Code.`,
          );
        }
      }
    }
  }
  out.push(`  ${formatCatalogStamp(catalogStamp(), now)}`);
  if (crashLine !== undefined) out.push(crashLine);

  // Printed only while enforcing. A not-installed or disabled guard holds nothing, so a
  // "will not prompt" line beside it would name a hole that is not the current one.
  if (installed?.enabled) {
    for (const line of formatApprovalOverride(override)) out.push(`  ${line}`);
  }

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

  // ── Cursor ─────────────────────────────────────────────────────────────────
  const cursorIo = deps.cursorIo ?? createRealCursorFileIO();
  const cursor = readCursorState(home, cursorIo);
  out.push("", "Cursor");
  if (cursor.kind === "not-installed") {
    out.push(`Enforcement: NOT INSTALLED — run \`${CURSOR_INIT}\`.`);
  } else {
    if (cursor.kind === "on") {
      out.push(enforcing);
    } else {
      out.push(`Enforcement: BROKEN — ${cursor.reason}.`, `  Run \`${CURSOR_INIT}\` again.`);
    }
    const recorded = recordedCursorVersion(home, cursorIo);
    if (recorded !== undefined && recorded !== VERSION) {
      out.push(
        isNewerThan(recorded, VERSION)
          ? `  Installed by guard ${recorded}, newer than this guard ${VERSION} — this command is out of date. ${UPDATE_CLI}`
          : `  Installed by guard ${recorded}; this is guard ${VERSION}. Refresh it: \`${CURSOR_INIT}\``,
      );
    }
    out.push(AGENT_WINDOW_NOTE);
    // The Cursor analogue of the Claude Code approval-override line above. Guard cannot read
    // Cursor's run-mode settings, so this is a plain note rather than a count.
    out.push(`  ${CURSOR_RUN_MODE_NOTE}`);
  }
  if (crashLine !== undefined) out.push(crashLine);

  // ── Codex CLI ──────────────────────────────────────────────────────────────
  const codexIo = deps.codexIo ?? createRealCodexFileIO();
  const codexRecord = readCodexRecord(home, codexIo);
  const codex = readCodexState(home, codexIo, codexRecord);
  out.push("", "Codex CLI");
  if (codex.kind === "not-installed") {
    out.push(`Enforcement: NOT INSTALLED — run \`${CODEX_INIT}\`.`);
  } else {
    if (codex.kind === "on") {
      out.push(enforcing);
    } else {
      out.push(`Enforcement: BROKEN — ${codex.reason}.`, `  ${codex.fix}`);
    }
    const recorded = codexRecord?.guardVersion;
    if (recorded !== undefined && recorded !== VERSION) {
      out.push(
        isNewerThan(recorded, VERSION)
          ? `  Installed by guard ${recorded}, newer than this guard ${VERSION} — this command is out of date. ${UPDATE_CLI}`
          : `  Installed by guard ${recorded}; this is guard ${VERSION}. Refresh it: \`${CODEX_INIT}\``,
      );
    }
    // Shown even when everything guard can check is right, because the one thing it cannot
    // check is the one that decides whether any of this runs.
    out.push(`  ${CODEX_TRUST_NOTE}`);
  }
  if (crashLine !== undefined) out.push(crashLine);

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
    // Distinguish what is DISPLAYED from what is RECORDED: the table is capped at
    // RECENT_LIMIT, so a bare "(N recorded)" beside fewer rows reads as if some went
    // missing. Each command is flattened to one line and truncated, so a heredoc or a
    // `&&`-chained script cannot spill its whole body across the table (the command is the
    // last column, so one-lining it also keeps every row column-aligned).
    out.push(
      "",
      records.length > recent.length
        ? `Recent decisions (latest ${recent.length} of ${records.length}):`
        : `Recent decisions (${records.length} recorded):`,
    );
    for (const r of recent) {
      out.push(
        `  ${r.decision.padEnd(5)} ${r.agent.padEnd(6)} ${r.ruleId.padEnd(24)} ${oneLineForDisplay(r.command)}`,
      );
    }

    // An `ask` here is the guard's VERDICT, not proof you were prompted. The hook is a
    // fresh process that emits a decision and exits; it never learns whether Claude Code
    // actually asked, and a matching settings.json allow rule runs the tool with no
    // prompt (see the enforcement stanza above). So the log cannot mark "was pre-permitted"
    // apart from "held" — the honest thing is to say the log records the verdict, not the outcome.
    // The two explanations are different facts, so an agent that cannot ask gets its own.
    // On Claude Code and Cursor an `ask` may or may not have reached a person; on Codex it
    // certainly did not, because the answer guard sent was a block. Printing Claude Code's
    // sentence over a Codex row states the opposite of what happened.
    const asked = records.filter((r) => r.decision === "ask");
    if (asked.some((r) => r.agent !== "codex")) {
      out.push(
        "  An `ask` above is the guard's decision, not confirmation you were prompted:",
        "  the hook cannot see whether a settings.json allow rule let the tool run anyway.",
      );
    }
    if (asked.some((r) => r.agent === "codex")) {
      out.push(
        "  An `ask` on a codex row was sent as a block: Codex has no way to ask, so the",
        "  action was stopped. The log keeps the guardrail's own decision, which is what",
        "  makes one guardrail comparable across apps.",
      );
    }

    const top = mostFrequentMatch(records);
    if (top !== undefined) {
      // The rule and the count are printed either way. Only the PATTERN is
      // withheld when the shape was redacted — going quiet instead would read as
      // "no noisy rule", which is the same silent failure in a new place.
      out.push(
        "",
        "Most frequent match",
        `  ${top.ruleId}   ${top.count}x   ${oneLineForDisplay(top.command)}`,
        "",
      );

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
      } else if (/[\r\n]/.test(top.command)) {
        // The `guardrails allow` line exists to be COPY-PASTED. A multi-line command
        // single-quotes into a value that spans lines with its inner quotes re-escaped —
        // unusable as a paste, which is the only thing it is for. Decline rather than emit
        // one, and say why: a one-line pattern against the real shape is the safe fix.
        out.push(
          "That command spans multiple lines, so it cannot be offered as a one-line",
          "silence pattern — pasted back it would span lines with its quotes re-escaped.",
          "If a shorter, single-line shape of it is the one firing on something legitimate,",
          "write a `guardrails allow` pattern against that shape yourself.",
        );
      } else {
        // Never suggest a line `guardrails allow` would refuse. The one that matters here:
        // the noisiest command IS one of the guardrail's own block fixtures — a command it
        // exists to stop — so silencing that exact shape would blind the guardrail to its
        // own purpose. Suggesting it would train the user to disarm the rule.
        const refusal = checkAllowPattern(top.command, blockFixtureCommands(top.ruleId));
        if (refusal === undefined) {
          out.push(
            "If that is expected, silence just this guardrail for that shape:",
            `  ${silenceCommand(top.ruleId, top.command)}`,
          );
        } else if (refusal.kind === "blinds-rule") {
          out.push(
            "That is one of this guardrail's own examples of what it exists to stop, so",
            "silencing it would blind the guardrail to its own purpose. If a NARROWER shape is",
            "the one firing on something legitimate, silence that instead — never the",
            "dangerous command itself.",
          );
        } else {
          out.push(
            `That exact shape cannot be turned into a safe silence pattern — ${refusal.reason}`,
            "Write a narrower pattern against the real command yourself.",
          );
        }
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
