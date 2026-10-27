// cspell:words nycrc coveragerc codecov oneline pyproject pytest numstat
/**
 * The test check, for the "Gaming tests" card: edits and commands that RAN and made a test
 * suite easier to pass.
 *
 *  - **A coverage threshold lowered** by an edit to a test or coverage config. Told apart from
 *    undoing a vitest `autoUpdate` raise: with `autoUpdate` on, a coverage run rewrites the
 *    thresholds upward by itself, and an edit right after one that takes them down again is
 *    counted as such a revert, not as lowering the floor. The `autoUpdate` setting on disk now
 *    is read for every config these edits touched.
 *  - **An exclude added** to a test or coverage exclude list, **`passWithNoTests`** on a test
 *    run or in a config, and **`|| true` on a CI step**, which makes a failing step pass.
 *  - **A test file deleted** by a command or an edit, and whether a test run that ran earlier in
 *    the same session had reported it failing: a run whose output names the file and reports a
 *    failure.
 *
 * Only calls that ran count (`calls.ts`). A config written whole carries no earlier text to
 * compare with; such rewrites are counted, never guessed at. Guard's Codex reader keeps
 * whether a call has an output record, not the output's text, so for a Codex session whether
 * a deleted test failed first is counted as not known.
 *
 * What leaves this module is counts. The paths go only into exact commands for the local
 * fixes file, built from quoted parts (`localFixCommand`).
 */

import { dirname } from "node:path";
import {
  backstopCalls,
  baseName,
  type CorpusCalls,
  executedText,
  type FileEdit,
  hidingFacts,
  isEdit,
  isShell,
  programAndArgs,
  quietStatus,
  runStateOf,
  type SessionCall,
  simpleCommands,
} from "./calls.js";
import {
  couldHideTemplate,
  counted,
  type FullCard,
  MAX_LOCAL_FIXES,
  moreMatches,
  restsOnCodex,
} from "./card-parts.js";
import {
  type CardContext,
  type ChipReason,
  chipFor,
  type LocalFix,
  localFixCommand,
  type SentenceTemplate,
  sentence,
  sentences,
  type ToCard,
  type UnsafeFix,
} from "./cards.js";
import { gitSubcommandIndex } from "./prefix-words.js";
import { READ_PROGRAMS } from "./ran.js";
import { placed, readRepoFile, rootCache } from "./repos.js";
import type { CheckedCategory, HidingForm, RunState, VerifyIO, VerifyStatus } from "./types.js";

/** Test configs the edits touched, by their `autoUpdate` setting on disk now. */
export interface AutoUpdateNow {
  readonly on: number;
  readonly off: number;
  /** Configs that could not be read: gone, outside a repo, too large. */
  readonly unread: number;
}

/** What the test check found. Every count is of calls or files that ran. */
export interface TestsFacts {
  /** Edits that lowered a coverage threshold, other than undoing an `autoUpdate` raise. */
  readonly thresholdsLowered: number;
  /** Edits that lowered a threshold right after a coverage run with `autoUpdate` on. */
  readonly autoUpdateReverts: number;
  readonly autoUpdateNow: AutoUpdateNow;
  /** Test configs written whole, so whether a threshold went down cannot be told. */
  readonly configsRewritten: number;
  /** Edits that added entries to a test or coverage exclude list. */
  readonly excludesAdded: number;
  /** Test runs given `passWithNoTests`, and edits that turned it on. */
  readonly passWithNoTests: number;
  /** Edits that gave a CI step `|| true` (or `|| exit 0`, `|| :`). */
  readonly ciStepsForcedTrue: number;
  /** Test files deleted. */
  readonly testFilesDeleted: number;
  /** Of those, deleted after a test run in the same session reported them failing. */
  readonly deletedAfterFailing: number;
  /** Of those, deleted where the app records no command output, so it is not known. */
  readonly deletedFailureUnknown: number;
  /**
   * Commands that ran and changed a test config or a CI file through the shell (`sed -i`,
   * `perl -i`, a redirection, `tee`, `cp`, `mv`, `git checkout` or `git restore` of one), or
   * applied a patch whose files are not known here (`git apply`, `git am`, `patch`). This
   * check does not read what they changed.
   */
  readonly unreadEdits: number;
  /** Matches that only mentioned one of these, and did not run. */
  readonly mentioned: number;
  /** Matches that could not be confirmed as run. */
  readonly unconfirmed: number;
  /** Calls that ran, or may have run, and could have run other commands this check does not read. */
  readonly couldHide: number;
  /** The hiding forms those calls hold, in `HIDING_FORMS` order. */
  readonly hidingForms: readonly HidingForm[];
}

declare module "./types.js" {
  interface CategoryFactsMap {
    tests: TestsFacts;
  }
}

/** The test category's result. */
export type TestsCheck = CheckedCategory<TestsFacts>;

// ── What counts as what ──────────────────────────────────────────────────────

/** A test runner's or a coverage tool's config file, by name. */
const TEST_CONFIG =
  /^(?:(?:vitest|vite|jest|karma)\.(?:config|workspace)(?:\.[\w-]+)?\.(?:[cm]?[jt]s|json)|package\.json|\.nycrc(?:\.(?:json|ya?ml))?|\.c8rc(?:\.json)?|\.coveragerc|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|\.?codecov\.ya?ml)$/i;

/** A coverage tool's own config file, where every number is about coverage. */
const COVERAGE_FILE =
  /^(?:\.nycrc(?:\.(?:json|ya?ml))?|\.c8rc(?:\.json)?|\.coveragerc|\.?codecov\.ya?ml)$/i;

/** Text that is about coverage. */
const COVERAGE_TEXT = /threshold|coverage|fail[_-]under|check-coverage/i;

/** A threshold and its value: `lines: 80`, `"branches": 75.5`, `fail_under = 90`, `target: 80%`. */
const THRESHOLD =
  /["']?\b(lines|branches|functions|statements|fail[_-]under|target)\b["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/g;

/** `autoUpdate` turned on: `true`, or a function that rounds the new value. */
const AUTO_UPDATE_ON = /\bautoUpdate\b["']?\s*:\s*(?!false\b)[^\s,}]/;

/** An exclude list and its entries. */
const EXCLUDE_LIST =
  /\b(?:exclude|coveragePathIgnorePatterns|testPathIgnorePatterns|modulePathIgnorePatterns|testIgnore|omit)\b["']?\s*[:=]\s*\[([^\]]*)\]/g;

/** A quoted entry in a list. */
const QUOTED = /(["'`])(?:(?!\1).)+\1/g;

/** `passWithNoTests` on a command line. */
const PASS_FLAG = /--pass-?with-?no-?tests\b(?!\s*=\s*false)/i;

/** `passWithNoTests` turned on, in a config or a script. */
const PASS_SETTING = /passWithNoTests["']?\s*:\s*true|--pass-?with-?no-?tests\b(?!\s*=\s*false)/gi;

/** A shell step forced to pass. */
const FORCED_TRUE = /\|\|\s*(?:true\b|exit\s+0\b|:(?=[\s"';)]|$))/gm;

/** A CI definition, by path. */
const CI_FILE =
  /(?:^|[\\/])(?:\.github[\\/]workflows[\\/][^\\/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci[\\/]config\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|\.travis\.ya?ml|Jenkinsfile|\.buildkite[\\/][^\\/]+)$/;

/** Build output, where a file shaped like a test is not one. */
const BUILD_OUTPUT = /(?:^|[\\/])(?:dist|build|out|coverage|node_modules)[\\/]/;

/** A test file or a test folder, by path. */
export function isTestPath(path: string): boolean {
  if (BUILD_OUTPUT.test(path)) return false;
  const name = baseName(path.replace(/[\\/]+$/, ""));
  return (
    /[._](?:test|spec)\.[a-z0-9]+$/i.test(name) ||
    /^test_.+\.py$/i.test(name) ||
    /_test\.(?:go|py|rb|exs?)$/i.test(name) ||
    /(?:^|[\\/])__tests__(?:[\\/]|$)/.test(path)
  );
}

/** Is `path` a test or coverage config? */
export function isTestConfig(path: string): boolean {
  return TEST_CONFIG.test(baseName(path));
}

/** Is `path` a CI definition? */
export function isCiFile(path: string): boolean {
  return CI_FILE.test(path);
}

/** The values of each threshold in a text, in order. */
function thresholds(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const match of text.matchAll(THRESHOLD)) {
    const key = (match[1] as string).replace("-", "_");
    const list = out.get(key) ?? [];
    list.push(Number(match[2]));
    out.set(key, list);
  }
  return out;
}

/**
 * Did an edit lower a threshold? Some threshold's value went down, place by place, or the
 * edit took every threshold out.
 */
export function lowersThreshold(edit: FileEdit): boolean {
  if (edit.whole || edit.deleted) return false;
  const name = baseName(edit.path);
  if (!COVERAGE_FILE.test(name) && !COVERAGE_TEXT.test(`${edit.removed}\n${edit.added}`)) {
    return false;
  }
  const before = thresholds(edit.removed);
  const after = thresholds(edit.added);
  if (before.size > 0 && after.size === 0) return true;
  for (const [key, was] of before) {
    const now = after.get(key);
    if (now === undefined) continue;
    for (let i = 0; i < Math.min(was.length, now.length); i++) {
      if ((now[i] as number) < (was[i] as number)) return true;
    }
  }
  return false;
}

/** How many entries the exclude lists in a text hold. */
function excludeEntries(text: string): number {
  let count = 0;
  for (const match of text.matchAll(EXCLUDE_LIST)) {
    count += [...(match[1] ?? "").matchAll(QUOTED)].length;
  }
  return count;
}

/** Did an edit add an entry to an exclude list? */
export function addsExclude(edit: FileEdit): boolean {
  return !edit.whole && !edit.deleted && excludeEntries(edit.added) > excludeEntries(edit.removed);
}

/** How often `pattern` matches `text`. */
function occurrences(pattern: RegExp, text: string): number {
  return [...text.matchAll(pattern)].length;
}

/** Did an edit turn `passWithNoTests` on? */
export function addsPassWithNoTests(edit: FileEdit): boolean {
  return occurrences(PASS_SETTING, edit.added) > occurrences(PASS_SETTING, edit.removed);
}

/** Did an edit force a CI step to pass? */
export function forcesCiStep(edit: FileEdit): boolean {
  return occurrences(FORCED_TRUE, edit.added) > occurrences(FORCED_TRUE, edit.removed);
}

/** The test files a shell text deletes: `rm`, `unlink` and `git rm` targets. */
export function deletedTestPaths(command: string): string[] {
  const out: string[] = [];
  for (const simple of simpleCommands(command)) {
    const { program, args } = programAndArgs(simple);
    let targets: string[] = [];
    if (program === "rm" || program === "unlink") targets = args;
    else if (program === "git") {
      let k = 0;
      while (k < args.length && (args[k] as string).startsWith("-")) {
        k += args[k] === "-C" || args[k] === "-c" ? 2 : 1;
      }
      if (args[k] === "rm") targets = args.slice(k + 1);
    }
    for (const target of targets) {
      if (!target.startsWith("-") && isTestPath(target)) out.push(target);
    }
  }
  return out;
}

/** A test run, as a command. */
const TEST_RUN =
  /\b(?:vitest|jest|mocha|pytest|playwright\s+test|go\s+test|cargo\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?)\b/;

/**
 * A line of a test run's output that reports a failure. Read on the line that names a file, so
 * a run that failed elsewhere does not count against a file it lists as passing.
 */
const FAILED_LINE = /\bFAIL(?:ED)?\b|✗|×|\b[1-9]\d* (?:failed|failing)\b/;

/** What may stand right before a file name in a run's output: a folder, a blank, a quote. */
const NAME_BEFORE = /[\s/\\"'`([]/;

/** What may stand right after it: a blank, `::` or `:line`, `>`, a quote, a bracket. */
const NAME_AFTER = /[\s:"'`)\],>]/;

/**
 * Does `line` name the file `name` as a whole path segment? `a.test.ts` is named in
 * `FAIL src/a.test.ts` but not in `FAIL src/data.test.ts` or `src/a.test.tsx`.
 */
function namesFile(line: string, name: string): boolean {
  if (name === "") return false;
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    const before = line[at - 1];
    const after = line[at + name.length];
    if (
      (before === undefined || NAME_BEFORE.test(before)) &&
      (after === undefined || NAME_AFTER.test(after))
    ) {
      return true;
    }
  }
  return false;
}

/** Did a run's output name the file `name`, as a whole path segment, on a failing line? */
export function namesAsFailing(output: string, name: string): boolean {
  return output.split(/\r?\n/).some((line) => FAILED_LINE.test(line) && namesFile(line, name));
}

/**
 * The paths a shell text writes through the shell: `sed -i` and `perl -i` targets, redirection
 * targets, `tee` files, and the destination of `cp` and `mv`.
 */
export function shellWrittenPaths(command: string): string[] {
  const out: string[] = [];
  for (const simple of simpleCommands(command)) {
    out.push(...simple.writes);
    const { program, args } = programAndArgs(simple);
    const operands = args.filter((a) => !a.startsWith("-"));
    if (
      (program === "sed" && args.some((a) => /^-[A-Za-z]*i|^--in-place/.test(a))) ||
      (program === "perl" && args.some((a) => /^-[A-Za-z]*i/.test(a)))
    ) {
      // The script is the first operand unless given with -e; every other operand is a file.
      const scripted = args.some((a) => /^-[A-Za-z]*e$/.test(a));
      out.push(...(scripted ? operands : operands.slice(1)));
    } else if (program === "tee") out.push(...operands);
    else if ((program === "cp" || program === "mv") && operands.length >= 2) {
      out.push(operands[operands.length - 1] as string);
    }
  }
  return out;
}

/** `git apply` options that only report on a patch, unless `--apply` is given too. */
const APPLY_REPORTS = /^--(?:check|stat|numstat|summary)$/;

/**
 * Does a shell text change files in a way this check cannot read: a patch applied (`git
 * apply`, `git am`, `patch`), whose files are not known here, or a test config or CI file
 * checked out or restored from another version (`git checkout <ref> -- vitest.config.ts`,
 * `git restore --source …`)?
 */
export function changesFilesUnread(command: string): boolean {
  for (const simple of simpleCommands(command)) {
    const { program, args } = programAndArgs(simple);
    if (program === "patch") {
      if (!args.includes("--dry-run")) return true;
      continue;
    }
    if (program !== "git") continue;
    const k = gitSubcommandIndex(args);
    const sub = args[k];
    const rest = args.slice(k + 1);
    if (sub === "apply" && (rest.includes("--apply") || !rest.some((a) => APPLY_REPORTS.test(a)))) {
      return true;
    }
    if (sub === "am") return true;
    if (
      (sub === "checkout" || sub === "restore") &&
      rest.some((a) => !a.startsWith("-") && (isTestConfig(a) || isCiFile(a)))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Does a shell text change a test config or a CI file through the shell, or apply a patch that
 * may have? Either way this check does not read what changed.
 */
export function writesConfigByShell(command: string): boolean {
  return (
    shellWrittenPaths(command).some((path) => isTestConfig(path) || isCiFile(path)) ||
    changesFilesUnread(command)
  );
}

/** Is `text` a test run? */
export function isTestRun(text: string): boolean {
  return TEST_RUN.test(text);
}

/** Is `text` a test run with coverage? */
function isCoverageRun(text: string): boolean {
  return isTestRun(text) && /\bcoverage\b/i.test(text);
}

// ── The check ────────────────────────────────────────────────────────────────

/** What the test check needs. */
export interface TestsInput {
  readonly calls: CorpusCalls;
  readonly io: VerifyIO;
}

/** What the test check produced. */
export interface TestsOutcome {
  readonly check: TestsCheck;
  readonly localFixes: readonly (LocalFix | UnsafeFix)[];
}

/**
 * The commands for the local fixes file: how to see a config's history, or a deleted test's.
 * The folder and the file are parts of their kind (`localFixCommand`): a path with unsafe
 * characters gives no command, only the note that a safe one could not be made.
 */
function historyFix(path: string, deleted: boolean): LocalFix | UnsafeFix {
  // The folder is an absolute path, so a plain ref; the file is a path inside the folder git
  // runs in.
  const dir = { ref: dirname(path) };
  const file = { repoPath: baseName(path) };
  return localFixCommand(
    "tests",
    deleted
      ? ["git", "-C", dir, "log", "--diff-filter=D", "--oneline", "--", file]
      : ["git", "-C", dir, "log", "-p", "--", file],
  );
}

/**
 * Run the test check. See the module header.
 *
 * Never throws: a config that cannot be read is counted as unread.
 */
export async function checkTests(input: TestsInput): Promise<TestsOutcome> {
  const { agent, calls } = input.calls;
  const outputRecorded = agent === "claude";
  const counts = {
    thresholdsLowered: 0,
    autoUpdateReverts: 0,
    configsRewritten: 0,
    excludesAdded: 0,
    passWithNoTests: 0,
    ciStepsForcedTrue: 0,
    testFilesDeleted: 0,
    deletedAfterFailing: 0,
    deletedFailureUnknown: 0,
    unreadEdits: 0,
    mentioned: 0,
    unconfirmed: 0,
  };
  let matches = 0;
  const fixes: (LocalFix | UnsafeFix)[] = [];
  const addFix = (fix: LocalFix | UnsafeFix): void => {
    if (fixes.length < MAX_LOCAL_FIXES) fixes.push(fix);
  };
  // Configs the edits touched, absolute, for the `autoUpdate` reading.
  const configs = new Set<string>();
  // Lowering edits whose revert reading waits on the setting on disk.
  const lowering: Array<{
    path: string | undefined;
    autoUpdateInEdit: boolean;
    revertsToSeen: boolean;
  }> = [];
  // Per session and file: the threshold values seen, from edits, writes and reads, in order.
  const seen = new Map<string, Array<{ order: number; values: Map<string, number[]> }>>();
  const seenKey = (call: SessionCall, path: string): string => `${call.session}\u0000${path}`;
  const see = (call: SessionCall, path: string, text: string): void => {
    const values = thresholds(text);
    if (values.size === 0) return;
    const list = seen.get(seenKey(call, path)) ?? [];
    list.push({ order: call.order, values });
    seen.set(seenKey(call, path), list);
  };
  // Per session and file: the whole content last written by a call that ran.
  const written = new Map<string, string>();
  // Test runs that ran, per session, for the "deleted after it failed" reading.
  const runs = new Map<number, SessionCall[]>();
  const tally = (state: RunState): boolean => {
    matches += 1;
    if (state === "mentioned") counts.mentioned += 1;
    else if (state === "unknown") counts.unconfirmed += 1;
    return state === "ran";
  };

  /**
   * Did a test run that ran before `call`, in its session, report `path` failing, on the line
   * that names it?
   */
  const failedBefore = (call: SessionCall, path: string): boolean => {
    const name = baseName(path.replace(/[\\/]+$/, ""));
    return (runs.get(call.session) ?? []).some(
      (run) =>
        run.order < call.order &&
        run.result !== undefined &&
        namesAsFailing(run.result.content, name),
    );
  };

  /**
   * Is every lowered value in `edit` a value the file held before the last coverage run
   * before it, as edits, writes and reads earlier in the session showed? Only then is a
   * lowering read as undoing an automatic raise.
   */
  const revertsToSeen = (call: SessionCall, edit: FileEdit): boolean => {
    const coverageRuns = (runs.get(call.session) ?? []).filter(
      (run) => run.order < call.order && isCoverageRun(executedText(run.command ?? "")),
    );
    const lastRun = coverageRuns[coverageRuns.length - 1];
    if (lastRun === undefined) return false;
    const before = new Map<string, Set<number>>();
    for (const entry of seen.get(seenKey(call, edit.path)) ?? []) {
      if (entry.order >= lastRun.order) continue;
      for (const [key, values] of entry.values) {
        const set = before.get(key) ?? new Set<number>();
        for (const value of values) set.add(value);
        before.set(key, set);
      }
    }
    const was = thresholds(edit.removed);
    const now = thresholds(edit.added);
    let lowered = false;
    for (const [key, values] of now) {
      const old = was.get(key) ?? [];
      for (let i = 0; i < Math.min(old.length, values.length); i++) {
        if ((values[i] as number) >= (old[i] as number)) continue;
        lowered = true;
        if (!before.get(key)?.has(values[i] as number)) return false;
      }
    }
    return lowered;
  };

  for (const call of calls) {
    if (isShell(call)) {
      const raw = call.command;
      const deletes = deletedTestPaths(raw).length > 0;
      const passes = PASS_FLAG.test(raw);
      const testRun = isTestRun(raw);
      if (writesConfigByShell(raw)) {
        if (tally(runStateOf(agent, call, writesConfigByShell))) counts.unreadEdits += 1;
        if (!deletes && !passes && !testRun) continue;
      }
      if (!deletes && !passes && !testRun) continue;

      // A plain test run is not a finding; it is kept for what later calls are judged by.
      if (testRun && !deletes && !passes) {
        if (runStateOf(agent, call, isTestRun) === "ran") {
          const list = runs.get(call.session) ?? [];
          list.push(call);
          runs.set(call.session, list);
        }
        continue;
      }
      const holds = (command: string): boolean =>
        deletedTestPaths(command).length > 0 || PASS_FLAG.test(command);
      if (!tally(runStateOf(agent, call, holds))) continue;
      const ran = executedText(raw);
      if (isTestRun(ran)) {
        const list = runs.get(call.session) ?? [];
        list.push(call);
        runs.set(call.session, list);
      }
      if (PASS_FLAG.test(ran)) counts.passWithNoTests += 1;
      for (const target of deletedTestPaths(ran)) {
        counts.testFilesDeleted += 1;
        if (!outputRecorded) counts.deletedFailureUnknown += 1;
        else if (failedBefore(call, target)) counts.deletedAfterFailing += 1;
        const path = placed(target, call.cwd);
        if (path !== undefined) addFix(historyFix(path, true));
      }
      continue;
    }

    if (!isEdit(call)) {
      // A read of a test config: the values it showed, for the revert reading.
      const read = call.mapped.args.file_path;
      if (
        call.mapped.tool === "Read" &&
        read !== undefined &&
        isTestConfig(read) &&
        call.result !== undefined &&
        !call.result.isError
      ) {
        see(call, read, call.result.content);
      }
      continue;
    }
    const raw = call.edit;
    // A whole write is compared with the content this session last wrote to the file, when
    // there is one; otherwise it is only counted as rewritten.
    const previous = raw.whole ? written.get(seenKey(call, raw.path)) : undefined;
    const edit: FileEdit =
      previous === undefined ? raw : { ...raw, removed: previous, whole: false };
    const config = isTestConfig(edit.path);
    const ci = isCiFile(edit.path);
    const deletesTest = edit.deleted && isTestPath(edit.path);
    if (!config && !ci && !deletesTest) continue;
    const findings = {
      lowers: config && lowersThreshold(edit),
      rewrites: (config || ci) && edit.whole,
      excludes: config && addsExclude(edit),
      passes: (config || ci) && !edit.whole && addsPassWithNoTests(edit),
      forces: ci && !edit.whole && forcesCiStep(edit),
    };
    const record = (): void => {
      if (runStateOf(agent, call, () => true) !== "ran") return;
      if (raw.whole) written.set(seenKey(call, raw.path), raw.added);
      else written.delete(seenKey(call, raw.path));
      if (config) see(call, raw.path, `${raw.removed}\n${raw.added}`);
    };
    if (!deletesTest && !Object.values(findings).some(Boolean)) {
      record();
      continue;
    }
    if (!tally(runStateOf(agent, call, () => true))) continue;
    // The values the edit took out were in the file before it.
    const reverts = findings.lowers && revertsToSeen(call, edit);
    record();

    const path = placed(edit.path, call.cwd);
    if (config && path !== undefined) configs.add(path);
    if (findings.lowers) {
      lowering.push({
        path,
        autoUpdateInEdit: AUTO_UPDATE_ON.test(`${edit.removed}\n${edit.added}`),
        revertsToSeen: reverts,
      });
      if (path !== undefined) addFix(historyFix(path, false));
    }
    if (findings.rewrites) counts.configsRewritten += 1;
    if (findings.excludes) counts.excludesAdded += 1;
    if (findings.passes) counts.passWithNoTests += 1;
    if (findings.forces) counts.ciStepsForcedTrue += 1;
    if (deletesTest) {
      counts.testFilesDeleted += 1;
      if (!outputRecorded) counts.deletedFailureUnknown += 1;
      else if (failedBefore(call, edit.path)) counts.deletedAfterFailing += 1;
      if (path !== undefined) addFix(historyFix(path, true));
    }
  }

  // The `autoUpdate` setting on disk now, for every config the edits touched.
  const cache = rootCache();
  const onDisk = new Map<string, boolean | undefined>();
  const autoUpdateNow = { on: 0, off: 0, unread: 0 };
  for (const path of configs) {
    const read = await readRepoFile(input.io, path, cache);
    const on = read.ok ? AUTO_UPDATE_ON.test(read.text) : undefined;
    onDisk.set(path, on);
    if (on === undefined) autoUpdateNow.unread += 1;
    else if (on) autoUpdateNow.on += 1;
    else autoUpdateNow.off += 1;
  }
  for (const lower of lowering) {
    const on =
      lower.autoUpdateInEdit || (lower.path !== undefined && onDisk.get(lower.path) === true);
    if (on && lower.revertsToSeen) counts.autoUpdateReverts += 1;
    else counts.thresholdsLowered += 1;
  }

  // A test file deleted, a test config or CI file written, or a patch applied, behind a program
  // no check reads.
  const behind = backstopCalls(
    input.calls,
    READ_PROGRAMS.tests,
    (tail) =>
      deletedTestPaths(tail).length > 0 || writesConfigByShell(tail) || changesFilesUnread(tail),
  );
  const facts: TestsFacts = {
    ...counts,
    autoUpdateNow,
    ...hidingFacts(input.calls, behind),
  };
  return { check: { status: testsStatus(facts), matches, facts }, localFixes: fixes };
}

/** The test card's tone, from its facts. */
export function testsStatus(facts: TestsFacts): VerifyStatus {
  if (
    facts.thresholdsLowered +
      facts.passWithNoTests +
      facts.ciStepsForcedTrue +
      facts.deletedAfterFailing >
    0
  ) {
    return "act";
  }
  if (
    facts.excludesAdded +
      facts.testFilesDeleted +
      facts.autoUpdateReverts +
      facts.configsRewritten >
    0
  ) {
    return "review";
  }
  return quietStatus(facts.unconfirmed + facts.unreadEdits, facts.couldHide);
}

// ── The card ─────────────────────────────────────────────────────────────────

/** A template that states a count when it is above zero. */
function whenAny(
  id: string,
  count: (f: TestsFacts) => number,
  say: (n: number, f: TestsFacts) => string,
): SentenceTemplate<TestsFacts> {
  return { id, render: (f) => (count(f) > 0 ? say(count(f), f) : undefined) };
}

/** Everything a weakened suite can show, summed. */
function signals(f: TestsFacts): number {
  return (
    f.thresholdsLowered +
    f.autoUpdateReverts +
    f.configsRewritten +
    f.excludesAdded +
    f.passWithNoTests +
    f.ciStepsForcedTrue +
    f.testFilesDeleted
  );
}

/** "What checking found". */
export const TESTS_FOUND: readonly SentenceTemplate<TestsFacts>[] = [
  whenAny(
    "tests.thresholds-lowered",
    (f) => f.thresholdsLowered,
    (n) =>
      `${counted(n, "edit that ran lowered", "edits that ran lowered")} a test coverage threshold.`,
  ),
  whenAny(
    "tests.auto-update-reverts",
    (f) => f.autoUpdateReverts,
    (n) =>
      `${counted(n, "edit", "edits")} lowered a threshold back to a value it had before a coverage run with autoUpdate on, which may be undoing an automatic raise.`,
  ),
  whenAny(
    "tests.configs-rewritten",
    (f) => f.configsRewritten,
    (n) =>
      `${counted(n, "test config or CI file was", "test configs or CI files were")} rewritten whole with no earlier content to compare, so what changed cannot be told from the edit.`,
  ),
  whenAny(
    "tests.excludes-added",
    (f) => f.excludesAdded,
    (n) =>
      `${counted(n, "edit that ran added", "edits that ran added")} files to a test or coverage exclude list.`,
  ),
  whenAny(
    "tests.pass-with-no-tests",
    (f) => f.passWithNoTests,
    (n) =>
      `${counted(n, "test run or config was", "test runs or configs were")} set to pass with no tests (passWithNoTests).`,
  ),
  whenAny(
    "tests.ci-forced-true",
    (f) => f.ciStepsForcedTrue,
    (n) =>
      `${counted(n, "edit gave a CI step", "edits gave CI steps")} "|| true", so a failing step passes.`,
  ),
  whenAny(
    "tests.deleted",
    (f) => f.testFilesDeleted,
    (n) =>
      `${counted(n, "test file was", "test files were")} deleted by commands or edits that ran.`,
  ),
  whenAny(
    "tests.deleted-after-failing",
    (f) => f.deletedAfterFailing,
    (n) =>
      `${n} of them ${n === 1 ? "was" : "were"} deleted after a test run in the same session reported ${n === 1 ? "it" : "them"} failing.`,
  ),
  whenAny(
    "tests.deleted-failure-unknown",
    (f) => f.deletedFailureUnknown,
    (n) =>
      `For ${n} of them the test output was not recorded, so whether ${n === 1 ? "it" : "they"} failed first is not known.`,
  ),
  // Said whatever the tone: a revert or a rewrite outranks it, and the card still could not
  // confirm what these commands changed, so there may be more than the card shows.
  whenAny(
    "tests.unread-edits",
    (f) => f.unreadEdits,
    (n, f) => {
      const found = testsStatus(f);
      const edits = `${counted(n, "command that ran", "commands that ran")} changed a test config or CI file through the shell or git, or applied a patch, which this check does not read`;
      return found === "act" || found === "review"
        ? `Could not confirm all of it: ${edits}, so there may be more than this card shows.`
        : `Could not confirm: ${edits}, so what changed is not known.`;
    },
  ),
  {
    id: "tests.nothing",
    render: (f) =>
      signals(f) === 0 && f.couldHide === 0 && f.unconfirmed === 0 && f.unreadEdits === 0
        ? "No edit or command that ran lowered a coverage threshold, added a test exclude, passed with no tests, forced a CI step to pass or deleted a test file."
        : undefined,
  },
  couldHideTemplate("tests.could-hide"),
  whenAny(
    "tests.mentioned",
    (f) => f.mentioned,
    (n, f) => `${moreMatches(n, signals(f) > 0)} only mentioned one of these and did not run.`,
  ),
  whenAny(
    "tests.unconfirmed",
    (f) => f.unconfirmed,
    (n) => `${counted(n, "match", "matches")} could not be confirmed as run.`,
  ),
];

/** "Now": the `autoUpdate` setting on disk. */
export const TESTS_NOW: readonly SentenceTemplate<TestsFacts>[] = [
  {
    id: "tests.auto-update-now",
    render: ({ autoUpdateNow: a }) => {
      const read = a.on + a.off;
      return read > 0
        ? `Coverage autoUpdate is on in ${a.on} of the ${counted(read, "test config", "test configs")} these edits touched that could be read.`
        : undefined;
    },
  },
  whenAny(
    "tests.auto-update-unread",
    (f) => f.autoUpdateNow.unread,
    (n) =>
      `${counted(n, "test config", "test configs")} these edits touched could not be read now.`,
  ),
];

/** "Fix", in sentences. */
export const TESTS_FIX_STEPS: readonly SentenceTemplate<TestsFacts>[] = [
  whenAny(
    "tests.fix.thresholds",
    (f) => f.thresholdsLowered,
    () => "Put the lowered thresholds back, or set them to today's coverage.",
  ),
  whenAny(
    "tests.fix.pass-with-no-tests",
    (f) => f.passWithNoTests,
    () => "Remove passWithNoTests, so a run that finds no tests fails.",
  ),
  whenAny(
    "tests.fix.ci",
    (f) => f.ciStepsForcedTrue,
    () => 'Take "|| true" off the CI steps, so a failing step fails the build.',
  ),
  whenAny(
    "tests.fix.deleted",
    (f) => f.deletedAfterFailing,
    () => "Restore the deleted tests from history and fix what made them fail.",
  ),
];

/** The headline claim: lowered test floors. */
export const TESTS_HEADLINE: SentenceTemplate<TestsFacts> = whenAny(
  "tests.headline",
  (f) => f.thresholdsLowered,
  (n) => `${counted(n, "edit", "edits")} lowered a test coverage threshold`,
);

/** The chip's usual claim: the number is shown apart. */
const TESTS_CHIP: ChipReason<TestsFacts> = {
  id: "tests.chip",
  count: (f) => f.thresholdsLowered,
  one: "test floor lowered",
  many: "test floors lowered",
};

/** What can make the card act, then review, in the order `testsStatus` reads them. */
const TESTS_CHIP_REASONS: readonly ChipReason<TestsFacts>[] = [
  TESTS_CHIP,
  {
    id: "tests.chip.pass-with-no-tests",
    count: (f) => f.passWithNoTests,
    one: "test run or config set to pass with no tests",
    many: "test runs or configs set to pass with no tests",
  },
  {
    id: "tests.chip.ci-forced",
    count: (f) => f.ciStepsForcedTrue,
    one: "CI step forced to pass",
    many: "CI steps forced to pass",
  },
  {
    id: "tests.chip.deleted-after-failing",
    count: (f) => f.deletedAfterFailing,
    one: "test deleted after it failed",
    many: "tests deleted after they failed",
  },
  {
    id: "tests.chip.excludes",
    count: (f) => f.excludesAdded,
    one: "test or coverage exclude added",
    many: "test or coverage excludes added",
  },
  {
    id: "tests.chip.deleted",
    count: (f) => f.testFilesDeleted,
    one: "test file deleted",
    many: "test files deleted",
  },
  {
    id: "tests.chip.reverts",
    count: (f) => f.autoUpdateReverts,
    one: "threshold set back after an automatic raise",
    many: "thresholds set back after an automatic raise",
  },
  {
    id: "tests.chip.rewritten",
    count: (f) => f.configsRewritten,
    one: "test config or CI file rewritten whole",
    many: "test configs or CI files rewritten whole",
  },
];

/** The card for the test check. */
export const testsCard: ToCard<"tests"> = (result, context: CardContext) => {
  const f = result.facts;
  const headline = sentence(TESTS_HEADLINE, f);
  const ran = signals(f) > 0;
  const card: FullCard = {
    category: "tests",
    tone: result.status,
    count: result.matches,
    found: sentences(TESTS_FOUND, f),
    now: sentences(TESTS_NOW, f),
    fixes: [
      ...(f.thresholdsLowered > 0 ? [{ shape: "git log -p -- <test config>" }] : []),
      ...(f.testFilesDeleted > 0
        ? [{ shape: "git log --diff-filter=D --oneline -- <test file>" }]
        : []),
    ],
    fixSteps: sentences(TESTS_FIX_STEPS, f),
    chip: chipFor(f, TESTS_CHIP_REASONS, TESTS_CHIP),
    codexCaveat: restsOnCodex(context) && ran,
    ...(headline === undefined
      ? {}
      : {
          headline: {
            basis: "lowered-test-floors",
            count: f.thresholdsLowered,
            restsOnCodexRan: restsOnCodex(context),
            sentence: headline,
          },
        }),
  };
  return card;
};
