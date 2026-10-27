// cspell:words reclassed execdir osascript
/**
 * The verification data: what `scan --verify` found when it checked a scan's matches against
 * this machine, read-only.
 *
 * ── Value-free by construction ───────────────────────────────────────────────
 * Every field below is a count, a fixed enum or a list of those. There is no string a check
 * fills from what it read: no credential value, no fingerprint, no environment-variable name,
 * no path and no command. A report, the `--json` output and the terminal summary can all carry
 * this object as it is, and `verify-no-value.test.ts` plants a canary in every place a value
 * could come from to keep it that way.
 *
 * ── Five states, and only two of them are claims ─────────────────────────────
 * `act` and `review` say a check found something. `clean` says a check ran to the end and
 * found nothing. `not-checked` says no check exists for the category yet, and
 * `could-not-check` says one exists and failed: a timeout, a missing repo, an unreadable file.
 * A failure is never reported as `clean`.
 *
 * ── The checks count commands that RAN ───────────────────────────────────────
 * A tool call is `ran` only when its transcript records a result for it. A match whose text
 * only sits in a search, a printed string, a message or a heredoc is `mentioned`. A call with
 * no result to judge by is `unknown`, and is never counted as `ran`. See `ran.ts`.
 */

/** The nine categories the report shows a card for, in the order the report lists them. */
export const VERIFY_CATEGORIES = [
  "secrets",
  "skipped-checks",
  "lost-work",
  "cloud",
  "prod-infra",
  "tests",
  "destructive",
  "unreviewed",
  "egress",
] as const;

/** One category of checks. */
export type VerifyCategory = (typeof VERIFY_CATEGORIES)[number];

/**
 * What a category's check concluded.
 *
 * - `act`: it found something to fix.
 * - `review`: it found something only a person can judge, such as a cloud change.
 * - `clean`: it ran to the end and found nothing, and no call that ran holds a form that could
 *   hide what it looks for (see `HIDING_FORMS`).
 * - `not-checked`: there is no check for the category yet.
 * - `could-not-check`: a check exists and could not finish.
 */
export const VERIFY_STATUSES = [
  "act",
  "review",
  "clean",
  "not-checked",
  "could-not-check",
] as const;

/** One of `VERIFY_STATUSES`. */
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

/** Whether a tool call ran, judged from what its transcript recorded. */
export const RUN_STATES = ["ran", "mentioned", "unknown"] as const;

/** One of `RUN_STATES`. */
export type RunState = (typeof RUN_STATES)[number];

/**
 * Why a call got its `RunState`.
 *
 * - `result`: the transcript records a result for it.
 * - `exit-code`: it records an error result that reports the command's exit code, so it ran.
 * - `error-result`: it records an error result with no exit code: refused, blocked or failed
 *   before running.
 * - `no-result`: the app records results, and this call has none.
 * - `not-recorded`: the app records no results at all, as Cursor's session files do not.
 * - `may-run-written-file`: the call has a result, but the matched text sits only in printed
 *   text or a heredoc written to a file, and counts only because a later command in the same
 *   call might run that file (anything not on the short list of programs that cannot). The
 *   call ran; whether the matched text did is not confirmed. Its `state` is `ran`, and
 *   `isResultBackedRun` is false for it: no count or claim rests on it.
 * - `search`, `doc`, `test-string`, `heredoc`: the matched text sits only in a search pattern,
 *   printed or message text, a test-name filter or a heredoc fed to a file.
 * - `agent-reply`: the text is in the agent's own reply, not in a tool call.
 */
export type RunWhy =
  | "result"
  | "exit-code"
  | "error-result"
  | "no-result"
  | "not-recorded"
  | "may-run-written-file"
  | "search"
  | "doc"
  | "test-string"
  | "heredoc"
  | "agent-reply";

/** A call's `RunState` and the reason for it. */
export interface RunVerdict {
  readonly state: RunState;
  readonly why: RunWhy;
}

/**
 * What a `ran` verdict rests on, for the app whose sessions were read.
 *
 * - `tool-result`: Claude Code's `tool_result`. An error result counts as ran only when it
 *   reports the command's exit code.
 * - `output-record`: Codex's `custom_tool_call_output`. Whether Codex writes one for a call a
 *   pre-tool hook blocked is not established, so a `ran` count resting on it may include
 *   blocked calls. Whatever reads it must not present such a count as more certain than that.
 * - `none`: the app records no results, as Cursor's session files do not. Nothing is `ran`.
 */
export const RAN_EVIDENCE = ["tool-result", "output-record", "none"] as const;

/** One of `RAN_EVIDENCE`. */
export type RanEvidence = (typeof RAN_EVIDENCE)[number];

/**
 * Calls by whether they ran. `ran` counts only result-backed runs (`why` `result` or
 * `exit-code`); a `may-run-written-file` call counts as `unknown`, since whether its matched
 * text ran is not confirmed.
 */
export interface RunTally {
  readonly ran: number;
  readonly mentioned: number;
  readonly unknown: number;
}

/**
 * The forms of shell text that run a command this reading does not take apart, so a call that
 * holds one could have run something its text does not show. A check may not report a
 * category `clean`, or say no such command ran, while a call that ran holds a form that could
 * hide what it looks for: it reports that it could not confirm instead.
 *
 * - `shell-string`: a shell given a string to run, `bash -c "…"`, `sh -c`, `zsh -c`.
 * - `inline-code`: an interpreter given code on the command line: `python -c`, `node -e`,
 *   `--eval` or `-p`, `perl -e`/`-E`, `ruby -e`, `php -r`, `deno eval`, `bun -e`,
 *   `osascript -e`, `pwsh -c`/`-Command`.
 * - `piped-script`: a stream piped into a shell or an interpreter that reads its script from
 *   standard input: `cat x.sh | sh`, a download piped to `bash`, `… | python3`, `bash -s`.
 * - `find-exec`: `find -exec`, `-execdir`, `-ok`; `fd --exec`.
 * - `xargs`: `xargs`, which runs a command built from its input.
 * - `process-substitution`: `<(…)` or `>(…)`.
 * - `command-substitution`: a `$(…)` or backticks, other than one that only prints a heredoc
 *   (`-m "$(cat <<'EOF' … EOF)"`), or a heredoc whose body the shell expands and holds one.
 * - `eval`: `eval`, which runs its arguments as shell text.
 * - `git-config`: `git` with a global `-c`, `--config-env` or `--exec-path`, or after the call
 *   ran `git config`: an alias, a pager or a diff driver set that way runs a program.
 * - `git-exec`: `git rebase --exec` or `-x`, or `--ext-diff`.
 * - `git-hook`: `git` after the call wrote a hook (`.git/hooks/…`, `.husky/…`, `.githooks/…`,
 *   any `hooks/…` or a `core.hooksPath` it names) or git's own config or attributes.
 * - `unread-shell`: a shell whose syntax this reading does not parse (PowerShell): the whole
 *   command is unread.
 *
 * Not a hiding form: a local script run by name (`./x.sh`, `bash x.sh`, `source x.sh`). Its
 * file is not read; that is a stated limit, not a signal.
 */
export const HIDING_FORMS = [
  "shell-string",
  "inline-code",
  "piped-script",
  "find-exec",
  "xargs",
  "process-substitution",
  "command-substitution",
  "eval",
  "git-config",
  "git-exec",
  "git-hook",
  "unread-shell",
] as const;

/** One of `HIDING_FORMS`. */
export type HidingForm = (typeof HIDING_FORMS)[number];

/** How a likely-real credential reached a transcript. */
export const SECRET_PROVENANCES = [
  "pasted-into-prompt",
  "typed-into-command",
  "printed-by-command",
  "in-agent-reply",
] as const;

/** One way a credential reached a transcript. */
export type SecretProvenance = (typeof SECRET_PROVENANCES)[number];

/**
 * What kind of credential a value is, from the format or name that identified it. The name a
 * value was given (`DB_PASSWORD`) is never kept: a `named-secret` is all the report says.
 */
export const SECRET_KINDS = [
  "aws-access-key",
  "aws-secret-key",
  "private-key",
  "github-token",
  "slack-token",
  "api-key",
  "jwt",
  "bearer-token",
  "auth-header",
  "database-url",
  "url-credentials",
  "password",
  "named-secret",
  "random-string",
  "other",
] as const;

/** One kind of credential. */
export type SecretKind = (typeof SECRET_KINDS)[number];

/** The four classes every credential-shaped value is sorted into. */
export const SECRET_CLASSES = [
  "likely-real",
  "committed-fixture",
  "placeholder",
  "local-dev",
] as const;

/**
 * One class of credential-shaped value.
 *
 * - `likely-real`: none of the other three.
 * - `committed-fixture`: the same value is in a git-tracked file in a repo the sessions ran in.
 * - `placeholder`: a placeholder or a false positive, such as `your-api-key-here` or an id.
 * - `local-dev`: a credential for a database or service on this machine, such as a local
 *   database URL.
 */
export type SecretClass = (typeof SECRET_CLASSES)[number];

/** One likely-real credential, as the report may describe it: never the value. */
export interface SecretItem {
  readonly kind: SecretKind;
  /** Every way it reached the transcripts, in `SECRET_PROVENANCES` order. */
  readonly via: readonly SecretProvenance[];
  /** How many transcript files contain it. */
  readonly files: number;
}

/**
 * Whether the committed-fixture test could run.
 *
 * - `complete`: every repo the sessions named was searched to the end.
 * - `partial`: some were, and some could not be (gone, too large, timed out).
 * - `unavailable`: none could be, or no session named one. A value is then never reclassed as a
 *   fixture, so the likely-real count can be higher than it would otherwise be, never lower.
 * - `not-needed`: no value was left to test once placeholders and local dev data were set aside.
 */
export const FIXTURE_CHECKS = ["complete", "partial", "unavailable", "not-needed"] as const;

/** One of `FIXTURE_CHECKS`. */
export type FixtureCheck = (typeof FIXTURE_CHECKS)[number];

/** What the secrets check found. Counts are of DISTINCT values. */
export interface SecretsFacts {
  readonly classes: Readonly<Record<SecretClass, number>>;
  /** The likely-real values, most widespread first, at most `MAX_SECRET_ITEMS`. */
  readonly items: readonly SecretItem[];
  /** Likely-real values beyond `items`. */
  readonly moreItems: number;
  /** Transcript files read for the check. */
  readonly filesRead: number;
  /** Transcript files that could not be read. A non-zero count keeps the check from `clean`. */
  readonly filesNotRead: number;
  /**
   * Texts the redaction changed whose values could not be recovered, so could not be classed.
   * A non-zero count keeps the check from `clean`.
   */
  readonly unplaced: number;
  /**
   * Of the `placeholder` count, the values set aside by a rule that can under-count:
   * - `unnamedOutputOnly`: an unnamed random string seen only in command output or an agent
   *   reply, where ids and hashes are common;
   * - `namedNotCredentialShaped`: a value found only by the name it was given whose own text
   *   does not look like a credential (`tokens: count`, a letters-only password).
   * A real credential can be among them, so the report states how many there were.
   */
  readonly setAside: {
    readonly unnamedOutputOnly: number;
    readonly namedNotCredentialShaped: number;
  };
  readonly fixtureCheck: FixtureCheck;
  /** Repos whose tracked files were searched to the end. */
  readonly reposChecked: number;
  /** Repos the sessions named that could not be searched. */
  readonly reposNotChecked: number;
}

/**
 * A category whose check ran, with that check's typed facts.
 *
 * `matches` is the raw match count the card shows. `facts` holds only counts, fixed enums and
 * lists of those; a list is capped where it is made, with a `more…` count beside it.
 */
export interface CheckedCategory<F> {
  readonly status: VerifyStatus;
  readonly matches: number;
  readonly facts: F;
}

/** A category whose check does not exist yet. */
export interface PendingCheck {
  readonly status: "not-checked";
}

/** The secrets category. */
export type SecretsCheck = CheckedCategory<SecretsFacts>;

/**
 * Each category's facts type, keyed by category.
 *
 * A module that adds a check adds its category here from its OWN file, by module augmentation,
 * so checks written side by side never edit one shared union:
 *
 *     declare module "./types.js" {
 *       interface CategoryFactsMap {
 *         "lost-work": LostWorkFacts;
 *       }
 *     }
 *
 * A category with no entry can only be `PendingCheck`.
 *
 * Every category's facts but secrets' extend `CommandCheckFacts`, so each carries the hiding
 * forms of the calls it read; `HidingFormsRequired` below fails to compile when one does not.
 */
export interface CategoryFactsMap {
  secrets: SecretsFacts;
}

/**
 * The facts every category but secrets carries. Those checks read commands that ran, and a call
 * that ran can hide what they look for (`HIDING_FORMS`), so each says which forms its calls held:
 * an empty list when none did. The card and the report then say could not confirm, never clean.
 * Secrets is the one check of text rather than commands, and is exempt.
 */
export interface CommandCheckFacts {
  readonly hidingForms: readonly HidingForm[];
}

/**
 * The categories in a facts map, other than secrets, whose facts lack `hidingForms`. `never` when
 * every one has it.
 */
export type CategoriesMissingHidingForms<M> = {
  [C in Exclude<keyof M, "secrets">]: M[C] extends CommandCheckFacts ? never : C;
}[Exclude<keyof M, "secrets">];

/** Holds only `true`. */
type MustBeTrue<T extends true> = T;

/**
 * Compiles only while every category in `CategoryFactsMap` but secrets has `hidingForms`. A check
 * that adds its category without it fails here, wherever its augmentation lives.
 */
export type HidingFormsRequired = MustBeTrue<
  [CategoriesMissingHidingForms<CategoryFactsMap>] extends [never] ? true : false
>;

/** The categories whose check exists. */
export type CheckedCategoryName = Extract<keyof CategoryFactsMap, VerifyCategory>;

/**
 * A category whose check exists but could not finish and has no facts to report, such as a
 * check whose one source could not be read. It still carries its raw match count, which the
 * card shows.
 */
export interface CouldNotCheckResult {
  readonly status: "could-not-check";
  readonly matches: number;
}

/**
 * One category's result: its facts when its check ran, could-not-check with only a count when
 * the check could not finish, or not-checked.
 */
export type CategoryResult<C extends VerifyCategory> = C extends CheckedCategoryName
  ? CheckedCategory<CategoryFactsMap[C]> | CouldNotCheckResult | PendingCheck
  : PendingCheck;

/** Every category but secrets, which always runs. */
export type PendingCategory = Exclude<VerifyCategory, "secrets">;

/**
 * Each category's result. Secrets always runs, so it is always checked; every other category is
 * not-checked until its check exists and runs.
 */
export type VerifyCategories = { readonly secrets: SecretsCheck } & {
  readonly [C in PendingCategory]: CategoryResult<C>;
};

/** What `scan --verify` found. Value-free; see the module header. */
export interface Verification {
  /**
   * The calls that matched a guardrail, by whether they ran. The checks count `ran` only.
   */
  readonly matchedCalls: RunTally;
  /**
   * `false` when the app records no tool results, so no call can be confirmed as `ran`.
   * Cursor's session files are the case.
   */
  readonly resultsRecorded: boolean;
  /** What each `ran` in `matchedCalls` rests on. See `RAN_EVIDENCE`. */
  readonly ranEvidence: RanEvidence;
  readonly categories: VerifyCategories;
}

/** Most likely-real items the verification carries. The report caps again at its own row cap. */
export const MAX_SECRET_ITEMS = 200;

// ── The read-only seam ──────────────────────────────────────────────────────

/**
 * Why a read-only call did not give an answer. Every one of these becomes `could-not-check`
 * for what depended on it, and never `clean`.
 *
 * - `refused`: the call is not on the allow-list, or the path is outside every allowed root.
 * - `timeout`: it ran out of its per-call time.
 * - `too-large`: its output, the file, or the process list is over its cap. A list read only in
 *   part is this, never a complete answer.
 * - `budget`: the run's total time is used up.
 * - `not-a-repo`: `git` says the folder is not in a repository.
 * - `missing`: the folder or file is not there, or `git` is not installed.
 * - `failed`: anything else.
 */
export type CheckFailure =
  | "refused"
  | "timeout"
  | "too-large"
  | "budget"
  | "not-a-repo"
  | "missing"
  | "failed";

/** The output of one allow-listed `git` call. */
export type GitOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: CheckFailure };

/** The text of one bounded file read. */
export type FileOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: CheckFailure };

/**
 * The processes verification may know are running: the agent apps, by id. A process list is
 * read inside the seam and reduced to these ids there, so no other process name, and no text a
 * program put in its own title, is ever held. A check that needs another kind of process adds
 * its id here, with its matching rule in the seam.
 */
export const WATCHED_PROCESSES = ["claude", "cursor", "codex"] as const;

/** One of `WATCHED_PROCESSES`. */
export type WatchedProcess = (typeof WATCHED_PROCESSES)[number];

/**
 * Which watched processes are running, by id, each at most once, in `WATCHED_PROCESSES` order.
 * `ok` only when the whole list was read. A process not in a complete list was not seen, which
 * is not proof it is not running (a program can run under another name); any failure, a list
 * over its cap included, leaves every process unknown.
 */
export type ProcessOutcome =
  | { readonly ok: true; readonly running: readonly WatchedProcess[] }
  | { readonly ok: false; readonly reason: CheckFailure };

/**
 * Everything verification may do outside the process. Read-only, and nothing else.
 *
 * The real one is `src/verify-io.ts`. It is kept out of `ScanIO` so the browser opener stays the
 * only process `ScanIO` starts, and out of the hook's import graph entirely.
 */
export interface VerifyIO {
  /** Run `git` with an allow-listed argument list in `cwd`. Never through a shell. */
  git(cwd: string, args: readonly string[]): Promise<GitOutcome>;
  /** Whether `path` is a folder: `undefined` when it cannot be read. */
  isDirectory(path: string): boolean | undefined;
  /** Read a file of at most the size cap, under a root a `git rev-parse` call has returned. */
  readFile(path: string): Promise<FileOutcome>;
  /** Which watched processes are running. Ids only; see `WATCHED_PROCESSES`. */
  processNames(): Promise<ProcessOutcome>;
  /**
   * Charge `ms` of in-process work (searching what was read) to the run's one time budget.
   * `false` once the budget is used up: the caller stops and reports what it did not finish.
   * Optional so a seam that does nothing need not keep a budget.
   */
  charge?(ms: number): boolean;
}

// ── What a category's facts may say ──────────────────────────────────────────

/**
 * Every string a category's facts may hold as a value. Facts are counts, booleans and these
 * enums; the report and `--json` drop any other string at the boundary, so a branch name or a
 * path put into facts by mistake never reaches the page or the JSON. A check whose facts use
 * an enum of its own adds that enum here.
 */
export const FACT_VALUE_ENUMS: readonly (readonly string[])[] = [
  VERIFY_CATEGORIES,
  VERIFY_STATUSES,
  RUN_STATES,
  RAN_EVIDENCE,
  HIDING_FORMS,
  SECRET_PROVENANCES,
  SECRET_KINDS,
  SECRET_CLASSES,
  FIXTURE_CHECKS,
  WATCHED_PROCESSES,
];

/**
 * Every key a category's facts may use, besides the values of `FACT_VALUE_ENUMS` (a record
 * keyed by an enum, such as `classes`). The boundary drops any other key with its value. A
 * check adds its own keys here.
 *
 * A value may be a count, a boolean, one of the enums, or a list or record of those; a number
 * in a list passes as it is. `hidingForms` is the shared key for the `HIDING_FORMS` held by the
 * calls that kept a category from `clean`.
 */
export const FACT_KEYS: readonly string[] = [
  "classes",
  "items",
  "moreItems",
  "filesRead",
  "filesNotRead",
  "unplaced",
  "setAside",
  "unnamedOutputOnly",
  "namedNotCredentialShaped",
  "fixtureCheck",
  "reposChecked",
  "reposNotChecked",
  "kind",
  "via",
  "files",
  "hidingForms",
];
