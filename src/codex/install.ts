// cspell:words codexes
/**
 * Guard's install for Codex CLI: one entry per event in Codex's user hooks file,
 * `~/.codex/hooks.json`, each running a copy of guard's hook. Used by `init --agent codex`
 * and `uninstall --agent codex`.
 *
 * The hook never imports this module and never reads the files it keeps.
 *
 * ── THE INSTALLED ENTRY IS A FROZEN CONTRACT, and this is the whole hazard ───
 * Measured on codex-cli 0.154.0: Codex decides whether a hook may run by hashing the ENTRY —
 * its event, its matcher, and its handler's command and timeout — not the script the entry
 * runs. Two consequences, pulling in opposite directions:
 *
 * - A release may rewrite `guard-hook.mjs` freely. The approval survives, so guard can be
 *   upgraded without asking every user to approve it again.
 * - Changing the command string, the timeout or the matcher makes the recorded approval stop
 *   matching, and Codex then silently stops running the hook. Measured: no warning, no log
 *   line, nothing on screen — the guardrails simply stop applying until someone approves the
 *   hook again in Codex's `/hooks` screen. Restoring the entry byte for byte heals it.
 *
 * So `CODEX_HOOK_MATCHER`, `CODEX_HOOK_TIMEOUT` and the exact string `codexHookCommand`
 * writes are part of guard's published contract. `codex-install.test.ts` pins the entry
 * verbatim; changing any of the three is a breaking change for every existing user, not a
 * refactor.
 *
 * ── Approval is POSITIONAL, so no entry is ever moved ────────────────────────
 * Codex records an approval under `<file>:<event>:<group index>:<handler index>`. Moving any
 * entry within a list therefore invalidates the approval of whatever used to be at that
 * index — guard's own, or another tool's. So:
 *
 * - A first install APPENDS, at the end of each of guard's two lists.
 * - A re-install REPLACES guard's group where it already sits, rather than removing it and
 *   appending, which would move every group after it.
 * - Nothing else in the file is reordered, ever.
 *
 * ── What an install writes ───────────────────────────────────────────────────
 * - `~/.agenttrail/guard/codex/guard-hook.mjs`: a copy of the bundled hook. Codex runs the
 *   copy, because a package run through `npx` lives in a cache that can be cleared.
 * - In `~/.codex/hooks.json`, one entry under `PreToolUse` and one under
 *   `PermissionRequest`, each `{"matcher": ".*", "hooks": [{"type": "command", "command":
 *   "\"<node>\" \"<copy>\" --agent codex", "timeout": 10}]}`. Node is named by its absolute
 *   path, so the entry runs the same Node whatever `PATH` Codex started with.
 * - On the first install, the file as it was goes to `hooks.json.backup`, or, when there was
 *   no file, an empty `hooks.json.was-absent` records that. Later installs keep whichever is
 *   there.
 * - `install.json`: `{installedAt, hookPath, nodePath, guardVersion, groupIndex}`.
 *   `groupIndex` is the position each entry was written at, which is what lets `status` tell
 *   an entry that has moved since — and so lost its approval — from one that has not.
 * - `config.json` and `guardrails.json`, when missing, exactly as `init --agent claude`
 *   seeds them.
 *
 * ── `hooks.json` ONLY, never `config.toml` ──────────────────────────────────
 * Codex reads hooks from both, and the layers AGGREGATE rather than override, so an entry in
 * both runs guard twice for one tool call. `hooks.json` is also the only one of the two
 * guard can read back: it has no TOML parser and must not grow one, which is why the trust
 * state Codex keeps in `config.toml` is something guard reports it cannot see rather than
 * guesses at.
 *
 * ── `hooks.json` belongs to Codex and to the user ───────────────────────────
 * - Guard refuses, and changes nothing, when the file cannot be read, is not JSON, is not an
 *   object, has a `hooks` value that is not an object, has an event list that is not an
 *   array, holds a hook group that is not an object or whose `hooks` value is not an array,
 *   or is read-only. A file that changes while guard is installing is not written either.
 * - Only guard's own handlers are removed or added. Every other key, group and handler is
 *   kept, in order. The file is written back as two-space JSON.
 * - The file keeps its mode. A file guard creates gets 0600: Codex runs as the same user,
 *   and a hook command another tool adds later can carry a token.
 * - A project's hooks file and a managed hooks file are never read or written.
 *
 * ── Uninstall ───────────────────────────────────────────────────────────────
 * Guard's handlers are removed. When what is left matches the backup, the backup's exact
 * text is written back. When there was no file before and nothing is left, the file is
 * deleted. Otherwise what is left is written. Then the copy, the backup and both records are
 * deleted. `config.json`, `guardrails.json`, `events.jsonl` and `crashes/` are left alone.
 *
 * Removing guard's group shifts every group after it down one, which invalidates THAT
 * tool's approval the same way. Guard removes anyway — a guard that will not uninstall
 * itself is worse than one that costs a re-approval — and says plainly which events are
 * affected, naming them only when a group really does follow guard's.
 */

import { join } from "node:path";
import { serializeDefaultConfig } from "../core/config.js";
import {
  codexHookCopyPath,
  codexHooksAbsentPath,
  codexHooksBackupPath,
  codexHooksPath,
  codexInstallRecordPath,
  configPath,
  guardCodexDir,
  guardDir,
  userRulesPath,
} from "../core/paths.js";
import type { SetupIO } from "../setup-io.js";
import type { CodexFileIO } from "./codex-io.js";

/**
 * The Codex hooks that guard's install puts an entry under, spelled as Codex spells them in
 * `hooks.json` — PascalCase, as Claude Code spells its own.
 *
 * `PermissionRequest` is mounted beside `PreToolUse` because it is a real second line of
 * defence: measured on codex-cli 0.154.0, both fire for one action, and a deny at
 * `PermissionRequest` is honoured even when Codex's own automatic reviewer is answering the
 * approval instead of a person.
 */
export const GUARD_CODEX_EVENTS = ["PreToolUse", "PermissionRequest"] as const;

/**
 * Seconds Codex waits for guard's hook before letting the call through. Part of the frozen
 * entry — see the file header. The same budget guard's Claude Code plugin and its Cursor
 * entries get, because it runs the same local check in all three.
 */
export const CODEX_HOOK_TIMEOUT = 10;

/**
 * Which tools guard's entry is consulted for: all of them.
 *
 * Deliberately not a list of tool names. Codex Desktop names its shell tool
 * `shell_command` rather than `Bash`, so a name list written against the CLI would miss
 * every shell call there and guard would enforce nothing, silently. Matching everything and
 * deciding inside the hook — which already answers "no opinion" for a call no guardrail
 * covers — has no such blind spot. Part of the frozen entry.
 */
export const CODEX_HOOK_MATCHER = ".*";

/**
 * What `init --agent codex` must tell the user, and the reason this install is not finished
 * when the files are written.
 *
 * Measured on codex-cli 0.154.0: a hook Codex has not been told to trust never runs, and
 * nothing says so — not Codex's output, not its transcript, not the hook's own log. An
 * installed guard is completely inert until someone approves it, so the install cannot
 * report success without this.
 */
export const CODEX_APPROVAL_STEP: readonly string[] = [
  "NEXT STEP — until you do this, guard checks nothing:",
  "  Open Codex, run /hooks, and approve agenttrail-guard for PreToolUse and for",
  "  PermissionRequest. Each event is approved separately, so both need approving.",
  "  Codex does not run an unapproved hook and does not say that it skipped one.",
];

/**
 * What `status` says about approval, every time guard's entries are there.
 *
 * Guard cannot answer "is it approved?" — Codex keeps that in `config.toml`, and guard has
 * no TOML parser. Saying where the answer lives is honest; inferring one from the files
 * guard can read would not be.
 */
export const CODEX_TRUST_NOTE =
  "Codex runs a hook only once you approve it in Codex's /hooks screen, each event separately. Guard cannot tell whether you have: Codex keeps that in its own config.toml, which guard does not read.";

/** The mode of every file guard writes in its own folder, and of a `hooks.json` it creates. */
const PRIVATE_MODE = 0o600;

/** A path character a double-quoted shell word does not keep as written. */
const SHELL_UNSAFE = /["$`\r\n]/;

/** The file a guard entry runs. */
const HOOK_SCRIPT = "guard-hook.mjs";

/** `--agent codex` as whole words: `--agent codexes` does not count. */
const CODEX_FLAG = /(?:^|\s)--agent codex(?=\s|$)/;

/** A step that failed, or the value it produced. */
type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** Where each of guard's entries sits in its event's list. */
export type GuardEntryPositions = Readonly<Record<string, number>>;

/** A JSON object: not `null`, and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A mode as `0600`. */
function octal(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

/** An error's message, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A file step that failed, named by what was being done and to which path. */
class FileStepError extends Error {}

/** Run one file step, turning a failure into a message that names the path. */
function step<T>(verb: "read" | "write" | "remove", path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new FileStepError(`could not ${verb} ${path} — ${messageOf(error)}`);
  }
}

// ── the entry ────────────────────────────────────────────────────────────────

/**
 * Whether a hook handler's command runs guard's hook for Codex: it names `guard-hook.mjs`
 * and passes `--agent codex`, as whole words.
 *
 * Deliberately looser than the frozen entry. This answers "is this guard's, so guard may
 * change or remove it", which must still be true of an entry an older guard wrote in a
 * slightly different form. Whether an entry is the CURRENT one is a separate question, and
 * `status` asks it separately.
 *
 * Pure, and never throws.
 */
export function isGuardCodexCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(HOOK_SCRIPT) && CODEX_FLAG.test(command);
}

/**
 * The command a guard entry runs: Node and the hook copy, each in double quotes, then
 * `--agent codex`.
 *
 * `undefined` when either path holds a double quote, `$`, a backtick or a line break, which
 * a shell would not pass through a double-quoted word as written.
 */
export function codexHookCommand(nodePath: string, hookPath: string): string | undefined {
  if (SHELL_UNSAFE.test(nodePath) || SHELL_UNSAFE.test(hookPath)) return undefined;
  return `"${nodePath}" "${hookPath}" --agent codex`;
}

/**
 * The entry guard writes, for one command. The frozen contract in the file header, as an
 * object.
 *
 * A fresh object each call: it is spliced into a document the caller then serializes, and a
 * shared one would be the same reference under both events.
 */
export function guardCodexEntry(command: string): Record<string, unknown> {
  return {
    matcher: CODEX_HOOK_MATCHER,
    hooks: [{ type: "command", command, timeout: CODEX_HOOK_TIMEOUT }],
  };
}

// ── hooks.json, as text in and text out ─────────────────────────────────────

/** A parsed `hooks.json` guard can change, or why it will not. */
type HooksFile =
  | {
      readonly ok: true;
      readonly doc: Record<string, unknown>;
      readonly hooks: Record<string, unknown[]>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse the text of `~/.codex/hooks.json` and check that guard can change it.
 *
 * No text (no file) reads as `{"hooks": {}}`. A file with no `hooks` is accepted and gains
 * one, last. Codex's file carries no `version` field, so none is written.
 *
 * Every group and every group's handler list is checked, including under events guard does
 * not touch: guard rewrites the whole document, so a shape it cannot walk is a shape it must
 * not write back.
 *
 * Pure, and never throws.
 */
export function readCodexHooksFile(text: string | undefined): HooksFile {
  if (text === undefined) {
    const hooks: Record<string, unknown[]> = {};
    return { ok: true, doc: { hooks }, hooks };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "is not a JSON object" };
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) {
    return { ok: false, reason: 'has a "hooks" value that is not an object' };
  }
  const hooks = parsed.hooks ?? {};
  for (const [name, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) {
      return { ok: false, reason: `has a "${name}" hook list that is not an array` };
    }
    for (const group of list) {
      if (!isRecord(group)) {
        return { ok: false, reason: `has a "${name}" hook that is not an object` };
      }
      if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
        return { ok: false, reason: `has a "${name}" hook whose "hooks" value is not an array` };
      }
    }
  }
  const doc = parsed;
  doc.hooks = hooks;
  return { ok: true, doc, hooks: hooks as Record<string, unknown[]> };
}

/** Whether a hook group holds at least one of guard's handlers. */
function isGuardGroup(group: unknown): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((handler) => isRecord(handler) && isGuardCodexCommand(handler.command));
}

/**
 * Whether a hook group is guard's OWN: it holds handlers, and every one of them is guard's.
 *
 * The distinction from `isGuardGroup` only matters for a hand-edited file where someone put
 * a handler of their own beside guard's. Such a group survives the removal, so guard has no
 * place of its own to go back to and appends instead — which leaves every group after it
 * exactly where it was.
 */
function isGuardOwnGroup(group: unknown): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) return false;
  return group.hooks.every((handler) => isRecord(handler) && isGuardCodexCommand(handler.command));
}

/** Where guard's first group sits in one event's list, or `-1` when it holds none. */
export function guardGroupIndex(list: readonly unknown[]): number {
  return list.findIndex(isGuardGroup);
}

/**
 * One event's list without guard's handlers, in the same order, and how many went.
 *
 * A group guard's handlers empty is dropped; a group that held one of guard's beside
 * someone else's keeps its other handlers and its place. A group with none of guard's is
 * passed through untouched, reference and all, so key order inside it cannot drift.
 */
function listWithoutGuardHandlers(list: readonly unknown[]): {
  kept: unknown[];
  removed: number;
} {
  const kept: unknown[] = [];
  let removed = 0;
  for (const group of list) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const handlers = group.hooks.filter(
      (handler) => !(isRecord(handler) && isGuardCodexCommand(handler.command)),
    );
    const dropped = group.hooks.length - handlers.length;
    removed += dropped;
    if (dropped === 0) kept.push(group);
    else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
  }
  return { kept, removed };
}

/**
 * The hook lists without guard's handlers, in the same order, and how many went.
 *
 * A list the removal empties is dropped, unless its name is in `keep`.
 */
function withoutGuardEntries(
  hooks: Record<string, unknown[]>,
  keep: ReadonlySet<string>,
): { hooks: Record<string, unknown[]>; removed: number } {
  const next: Record<string, unknown[]> = {};
  let removed = 0;
  for (const [name, list] of Object.entries(hooks)) {
    const { kept, removed: gone } = listWithoutGuardHandlers(list);
    removed += gone;
    if (kept.length > 0 || list.length === 0 || keep.has(name)) next[name] = kept;
  }
  return { hooks: next, removed };
}

/** The text `hooks.json` is written as. */
function serializeHooks(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * `hooks.json` with guard's entries: guard's earlier handlers removed from every list, then
 * one entry put back under each of guard's two events — **where guard's already was**, and
 * otherwise at the end.
 *
 * Keeping the position is what protects every other tool's approval, which Codex records by
 * index. See the file header.
 *
 * Pure, and never throws. Running it on its own output gives the same text.
 */
export function addGuardEntries(
  text: string | undefined,
  command: string,
):
  | { ok: true; text: string; removed: number; indexes: GuardEntryPositions }
  | { ok: false; reason: string } {
  const read = readCodexHooksFile(text);
  if (!read.ok) return read;

  // Read the places guard's own groups hold, off the file as it stands, before any removal
  // moves anything.
  const was = new Map<string, number>();
  for (const event of GUARD_CODEX_EVENTS) {
    const at = (read.hooks[event] ?? []).findIndex(isGuardOwnGroup);
    if (at >= 0) was.set(event, at);
  }

  const { hooks, removed } = withoutGuardEntries(read.hooks, new Set(GUARD_CODEX_EVENTS));
  const indexes: Record<string, number> = {};
  for (const event of GUARD_CODEX_EVENTS) {
    const list = [...(hooks[event] ?? [])];
    // `min` covers the hand-edited file that held guard's handler in two groups: the later
    // one's removal can leave the list shorter than the first one's index.
    const at = Math.min(was.get(event) ?? list.length, list.length);
    list.splice(at, 0, guardCodexEntry(command));
    hooks[event] = list;
    indexes[event] = at;
  }
  read.doc.hooks = hooks;
  return { ok: true, text: serializeHooks(read.doc), removed, indexes };
}

/**
 * `hooks.json` without guard's entries.
 *
 * `empty` when nothing is left but a `hooks` object with no lists.
 *
 * Pure, and never throws.
 */
export function removeGuardEntries(
  text: string,
): { ok: true; text: string; removed: number; empty: boolean } | { ok: false; reason: string } {
  const read = readCodexHooksFile(text);
  if (!read.ok) return read;
  const { hooks, removed } = withoutGuardEntries(read.hooks, new Set());
  read.doc.hooks = hooks;
  const empty =
    Object.keys(hooks).length === 0 && Object.keys(read.doc).every((key) => key === "hooks");
  return { ok: true, text: serializeHooks(read.doc), removed, empty };
}

/**
 * Guard's events that hold a group AFTER guard's own, which removing guard's would move up
 * one — and so cost that tool its approval.
 *
 * Pure, and never throws. Empty for a file guard cannot read, which `removeGuardEntries`
 * refuses separately.
 */
export function eventsWithEntriesAfterGuard(text: string): readonly string[] {
  const read = readCodexHooksFile(text);
  if (!read.ok) return [];
  return GUARD_CODEX_EVENTS.filter((event) => {
    const list = read.hooks[event] ?? [];
    const at = guardGroupIndex(list);
    return at >= 0 && at < list.length - 1;
  });
}

/** JSON with every object's keys sorted, so two equal values give one string. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Whether two `hooks.json` texts are the same file for Codex once guard's entries are set
 * aside: the same keys and hook entries, with key order, formatting, empty lists and a
 * missing `hooks` not counted.
 *
 * Pure, and never throws. `false` when either text is not a file guard can read.
 */
export function sameHooksApartFromGuard(a: string, b: string): boolean {
  const canonical = (text: string): string | undefined => {
    const read = readCodexHooksFile(text);
    if (!read.ok) return undefined;
    const { hooks } = withoutGuardEntries(read.hooks, new Set());
    const lists = Object.fromEntries(Object.entries(hooks).filter(([, list]) => list.length > 0));
    return canonicalJson({ ...read.doc, hooks: lists });
  };
  const left = canonical(a);
  return left !== undefined && left === canonical(b);
}

// ── install.json ─────────────────────────────────────────────────────────────

/** What `codex/install.json` records about the install that wrote it. */
export interface CodexInstallRecord {
  readonly guardVersion?: string;
  /** Where each entry was written. Empty for a record an older guard wrote. */
  readonly groupIndex: GuardEntryPositions;
}

/**
 * `codex/install.json`, as far as it can be read. `undefined` for no file, text that is not
 * JSON, or a root that is not an object.
 *
 * Pure, and never throws.
 */
export function parseCodexInstallRecord(text: string | undefined): CodexInstallRecord | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const recorded = isRecord(parsed.groupIndex) ? parsed.groupIndex : {};
  const groupIndex: Record<string, number> = {};
  for (const event of GUARD_CODEX_EVENTS) {
    const at = recorded[event];
    if (typeof at === "number" && Number.isInteger(at) && at >= 0) groupIndex[event] = at;
  }
  return {
    guardVersion: typeof parsed.guardVersion === "string" ? parsed.guardVersion : undefined,
    groupIndex,
  };
}

// ── install ──────────────────────────────────────────────────────────────────

/** What `init --agent codex` works with. */
export interface CodexInstallRequest {
  /** Seeds `config.json` and `guardrails.json`, and names the home folder. */
  readonly setup: SetupIO;
  readonly files: CodexFileIO;
  /** The bundled `plugin/` folder. The hook is `scripts/guard-hook.mjs` inside it. */
  readonly scaffoldDir: string;
  /** The Node that the entries run, normally `process.execPath`. */
  readonly nodePath: string;
  readonly guardVersion: string;
  readonly now: Date;
}

/** One file the install writes. */
export interface PlannedWrite {
  readonly path: string;
  readonly text: string;
  readonly mode: number;
  /** What the file is, for `--print`. Empty when the path says it. */
  readonly note: string;
}

/** Everything an install would change, worked out by reading only. */
export interface CodexInstallPlan {
  readonly home: string;
  readonly hooksPath: string;
  readonly hookCopy: string;
  readonly nodePath: string;
  readonly command: string;
  /** Where each entry lands. Recorded, so `status` can see one that has moved since. */
  readonly indexes: GuardEntryPositions;
  /** Whether guard's entries were already in the file, so this run replaces rather than adds. */
  readonly replaces: boolean;
  /** `config.json` and `guardrails.json`, written through `SetupIO` at mode 0600. */
  readonly seeds: readonly PlannedWrite[];
  /** Guard's own files under `codex/`, in the order they are written. */
  readonly files: readonly PlannedWrite[];
  /** The new `hooks.json`, or `undefined` when it already holds exactly these entries. */
  readonly hooks:
    | (PlannedWrite & { readonly before: string | undefined; readonly removed: number })
    | undefined;
  /** Whether this install saves the current `hooks.json` as the backup. */
  readonly savesBackup: boolean;
}

/** The `install.json` text for these values. */
function serializeRecord(
  request: CodexInstallRequest,
  hookPath: string,
  indexes: GuardEntryPositions,
): string {
  const record = {
    installedAt: request.now.toISOString(),
    hookPath,
    nodePath: request.nodePath,
    guardVersion: request.guardVersion,
    groupIndex: indexes,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Whether `install.json` already records this copy, this Node, this version and these positions. */
function recordIsCurrent(
  text: string | undefined,
  request: CodexInstallRequest,
  hookPath: string,
  indexes: GuardEntryPositions,
): boolean {
  if (text === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      typeof parsed.installedAt !== "string" ||
      parsed.hookPath !== hookPath ||
      parsed.nodePath !== request.nodePath ||
      parsed.guardVersion !== request.guardVersion
    ) {
      return false;
    }
    const recorded = parseCodexInstallRecord(text)?.groupIndex ?? {};
    return GUARD_CODEX_EVENTS.every((event) => recorded[event] === indexes[event]);
  } catch {
    return false;
  }
}

/**
 * Work out what `init --agent codex` would change. Reads files and writes none.
 *
 * Never throws: a read that fails, or a `hooks.json` guard will not change, is a message.
 */
export function planCodexInstall(request: CodexInstallRequest): Outcome<CodexInstallPlan> {
  const { setup, files } = request;
  const home = setup.homedir();
  const hooksPath = codexHooksPath(home);
  const hookCopy = codexHookCopyPath(home);
  const hookSource = join(request.scaffoldDir, "scripts", "guard-hook.mjs");
  const refuse = (message: string): Outcome<CodexInstallPlan> => ({
    ok: false,
    message: `${message} Nothing was changed.`,
  });

  const command = codexHookCommand(request.nodePath, hookCopy);
  if (command === undefined) {
    return refuse(
      `cannot write a hook command for ${request.nodePath} and ${hookCopy}: a path holds a double quote, "$", a backtick or a line break.`,
    );
  }

  try {
    const bundle = step("read", hookSource, () => files.readFile(hookSource));
    if (bundle === undefined) return refuse(`could not find guard's hook at ${hookSource}.`);

    const before = step("read", hooksPath, () => files.readFile(hooksPath));
    const mode = step("read", hooksPath, () => files.fileMode(hooksPath));
    const merged = addGuardEntries(before, command);
    if (!merged.ok) return refuse(`${hooksPath} ${merged.reason}.`);
    const changes = merged.text !== before;
    if (changes && mode !== undefined && (mode & 0o200) === 0) {
      return refuse(`${hooksPath} is read-only.`);
    }

    const backupPath = codexHooksBackupPath(home);
    const absentPath = codexHooksAbsentPath(home);
    const firstInstall =
      step("read", backupPath, () => files.fileMode(backupPath)) === undefined &&
      step("read", absentPath, () => files.fileMode(absentPath)) === undefined;
    const recordPath = codexInstallRecordPath(home);
    const recordText = step("read", recordPath, () => files.readFile(recordPath));
    const copyText = step("read", hookCopy, () => files.readFile(hookCopy));

    const own: PlannedWrite[] = [];
    if (copyText !== bundle) {
      own.push({
        path: hookCopy,
        text: bundle,
        mode: PRIVATE_MODE,
        note: `a copy of ${hookSource}`,
      });
    }
    if (firstInstall) {
      own.push(
        before === undefined
          ? {
              path: absentPath,
              text: "",
              mode: PRIVATE_MODE,
              note: `empty; records that there was no ${hooksPath}`,
            }
          : {
              path: backupPath,
              text: before,
              mode: PRIVATE_MODE,
              note: `${hooksPath} as it is now`,
            },
      );
    }
    if (!recordIsCurrent(recordText, request, hookCopy, merged.indexes)) {
      own.push({
        path: recordPath,
        text: serializeRecord(request, hookCopy, merged.indexes),
        mode: PRIVATE_MODE,
        note: "",
      });
    }

    const seeds: PlannedWrite[] = [];
    if (setup.readFile(configPath(home)) === undefined) {
      seeds.push({
        path: configPath(home),
        text: serializeDefaultConfig(),
        mode: PRIVATE_MODE,
        note: "",
      });
    }
    if (setup.readFile(userRulesPath(home)) === undefined) {
      seeds.push({ path: userRulesPath(home), text: "[]\n", mode: PRIVATE_MODE, note: "" });
    }

    return {
      ok: true,
      value: {
        home,
        hooksPath,
        hookCopy,
        nodePath: request.nodePath,
        command,
        indexes: merged.indexes,
        replaces: merged.removed > 0,
        seeds,
        files: own,
        hooks: changes
          ? {
              path: hooksPath,
              text: merged.text,
              mode: mode ?? PRIVATE_MODE,
              note: "",
              before,
              removed: merged.removed,
            }
          : undefined,
        savesBackup: firstInstall && before !== undefined,
      },
    };
  } catch (error) {
    return refuse(`${messageOf(error)}.`);
  }
}

/** The `--print` header. */
const PRINT_HEADER =
  "agenttrail-guard init --agent codex --print — this is what would happen. Nothing is changed.";

/** The two events, as the messages name them. */
const EVENT_LIST = GUARD_CODEX_EVENTS.join(" and of ");

/** What `init --agent codex --print` shows for a plan, or for a refusal. */
export function describeCodexInstall(planned: Outcome<CodexInstallPlan>): string {
  if (!planned.ok) return `${PRINT_HEADER}\n\n  It would STOP: ${planned.message}\n`;
  const plan = planned.value;
  const lines = [PRINT_HEADER, ""];
  for (const write of [...plan.seeds, ...plan.files]) {
    const note = write.note === "" ? "" : `${write.note}, `;
    lines.push(`  write   ${write.path}  (${note}mode ${octal(write.mode)})`);
  }
  if (plan.hooks === undefined) {
    lines.push(`  (${plan.hooksPath} already runs this copy — nothing to change there)`);
  } else {
    const kept = plan.hooks.before === undefined ? "a new file, mode" : "keeps its mode";
    lines.push(`  write   ${plan.hooks.path}  (${kept} ${octal(plan.hooks.mode)})`);
    lines.push(
      plan.replaces
        ? `          replaces guard's own entry, where it already sits, under ${EVENT_LIST}:`
        : `          adds this entry at the end of ${EVENT_LIST}:`,
      `          ${JSON.stringify(guardCodexEntry(plan.command))}`,
    );
  }
  lines.push("", ...CODEX_APPROVAL_STEP);
  lines.push(
    "",
    "It would NOT touch ~/.codex/config.toml, a project's hooks file or a managed hooks",
    "file, and it does not run Claude Code.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Carry out a plan from `planCodexInstall`. Returns the lines to print.
 *
 * Writes in this order: `config.json` and `guardrails.json`, the hook copy, the backup or
 * the was-absent record, `install.json`, and `hooks.json` last. `hooks.json` is read again
 * just before it is written, and left alone when it changed since the plan was made.
 *
 * Never throws.
 */
export function applyCodexInstall(
  request: CodexInstallRequest,
  plan: CodexInstallPlan,
): Outcome<readonly string[]> {
  const unchanged = `${plan.hooksPath} was not changed.`;
  try {
    for (const seed of plan.seeds) request.setup.writeFileAtomic(seed.path, seed.text);
  } catch (error) {
    return {
      ok: false,
      message: `could not write to ${guardDir(plan.home)} — ${messageOf(error)}. ${unchanged}`,
    };
  }

  try {
    for (const write of plan.files) {
      step("write", write.path, () =>
        request.files.writeFileAtomic(write.path, write.text, write.mode),
      );
    }
    const hooks = plan.hooks;
    if (hooks !== undefined) {
      const current = step("read", hooks.path, () => request.files.readFile(hooks.path));
      if (current !== hooks.before) {
        return {
          ok: false,
          message: `${hooks.path} changed while guard was installing, so guard did not write it. Run the command again.`,
        };
      }
      step("write", hooks.path, () =>
        request.files.writeFileAtomic(hooks.path, hooks.text, hooks.mode),
      );
    }
  } catch (error) {
    return { ok: false, message: `${messageOf(error)}. ${unchanged}` };
  }

  const lines: string[] = [];
  if (plan.hooks === undefined) {
    lines.push(`Already installed for Codex CLI: ${plan.hooksPath} runs ${plan.hookCopy}.`);
  } else if (plan.replaces) {
    lines.push(`Updated guard's entries in ${plan.hooksPath}, each where it already was.`);
  } else {
    lines.push(
      `Installed for Codex CLI: a ${GUARD_CODEX_EVENTS.join(" entry and a ")} entry in ${plan.hooksPath}.`,
    );
  }
  lines.push(`They run ${plan.hookCopy} with ${plan.nodePath}.`);
  if (plan.savesBackup) {
    lines.push(
      `Saved the earlier ${plan.hooksPath} as ${codexHooksBackupPath(plan.home)}.`,
      "`agenttrail-guard uninstall --agent codex` puts it back.",
    );
  }
  for (const write of [...plan.seeds, ...plan.files]) lines.push(`Wrote ${write.path}`);
  // Last, and printed every time rather than only on a change: an install that found
  // everything already in place is exactly when someone assumes there is nothing left to do.
  lines.push("", ...CODEX_APPROVAL_STEP);
  return { ok: true, value: lines };
}

// ── uninstall ────────────────────────────────────────────────────────────────

/**
 * Remove guard's Codex install. Returns the lines to print.
 *
 * Never throws: a read or write that fails, or a `hooks.json` guard will not change, is a
 * message.
 */
export function uninstallCodex(home: string, files: CodexFileIO): Outcome<readonly string[]> {
  const hooksPath = codexHooksPath(home);
  const backupPath = codexHooksBackupPath(home);
  const absentPath = codexHooksAbsentPath(home);
  const own = [codexHookCopyPath(home), codexInstallRecordPath(home), backupPath, absentPath];
  let change: "none" | "restored" | "deleted" | "rewritten" = "none";
  let reindexed: readonly string[] = [];

  try {
    const before = step("read", hooksPath, () => files.readFile(hooksPath));
    const backup = step("read", backupPath, () => files.readFile(backupPath));
    const hadNoFile = step("read", absentPath, () => files.fileMode(absentPath)) !== undefined;
    const present = own.filter(
      (path) => step("read", path, () => files.fileMode(path)) !== undefined,
    );

    if (before !== undefined) {
      const rest = removeGuardEntries(before);
      if (!rest.ok) {
        return { ok: false, message: `${hooksPath} ${rest.reason}. Nothing was changed.` };
      }
      if (rest.removed > 0) {
        const mode = step("read", hooksPath, () => files.fileMode(hooksPath)) ?? PRIVATE_MODE;
        if ((mode & 0o200) === 0) {
          return { ok: false, message: `${hooksPath} is read-only. Nothing was changed.` };
        }
        // Worked out before the write, off the file as it stands.
        reindexed = eventsWithEntriesAfterGuard(before);
        // A backup that itself holds guard's entries would put them back, so it is not used.
        const restore =
          backup !== undefined &&
          !hasGuardEntries(backup) &&
          sameHooksApartFromGuard(rest.text, backup)
            ? backup
            : undefined;
        if (restore !== undefined) {
          change = "restored";
          step("write", hooksPath, () => files.writeFileAtomic(hooksPath, restore, mode));
        } else if (hadNoFile && rest.empty) {
          change = "deleted";
          step("remove", hooksPath, () => files.deleteFile(hooksPath));
        } else {
          change = "rewritten";
          step("write", hooksPath, () => files.writeFileAtomic(hooksPath, rest.text, mode));
        }
      }
    }

    for (const path of present) step("remove", path, () => files.deleteFile(path));

    const settings = [
      "",
      `Your settings are still in ${guardDir(home)} — your allowlist, action`,
      "overrides and your own guardrails. Delete that directory if you want them gone.",
    ];
    if (change === "none" && present.length === 0) {
      return {
        ok: true,
        value: [
          "Guard is not installed for Codex CLI — nothing to remove.",
          `Your settings in ${guardDir(home)} were left alone.`,
        ],
      };
    }
    const lines: string[] = [];
    if (change === "restored") {
      lines.push(
        `Removed guard's entries from ${hooksPath}; it is back to how it was before the install.`,
      );
    } else if (change === "deleted") {
      lines.push(`Removed ${hooksPath}: guard created it, and nothing else was in it.`);
    } else if (change === "rewritten") {
      lines.push(`Removed guard's entries from ${hooksPath}. Every other hook in it is untouched.`);
    } else {
      lines.push(`${hooksPath} has no guard entries, so it was not changed.`);
    }
    if (present.length > 0) lines.push(`Deleted guard's Codex files in ${guardCodexDir(home)}.`);
    // Only when a hook really did sit after guard's: Codex approves a hook by its position,
    // so those moved up one and are no longer approved. Nothing else reports this.
    if (reindexed.length > 0) {
      lines.push(
        "",
        `A hook of yours sat after guard's under ${reindexed.join(" and ")}, so it has`,
        "moved up one place. Codex approves a hook by its position, so that hook is no longer",
        "approved and will not run. Approve it again in Codex's /hooks screen.",
      );
    }
    return { ok: true, value: [...lines, ...settings] };
  } catch (error) {
    const done =
      change === "none" ? "" : ` Guard's entries were already removed from ${hooksPath}.`;
    return { ok: false, message: `${messageOf(error)}.${done}` };
  }
}

/** Whether a `hooks.json` text holds any guard entry. */
function hasGuardEntries(text: string): boolean {
  const read = removeGuardEntries(text);
  return read.ok && read.removed > 0;
}
