/**
 * Guard's install for Cursor: two entries in Cursor's user hooks file, `~/.cursor/hooks.json`,
 * that run a copy of guard's hook. Used by `init --agent cursor` and `uninstall --agent cursor`.
 *
 * The hook never imports this module and never reads the files it keeps.
 *
 * ── What an install writes ───────────────────────────────────────────────────
 * - `~/.agenttrail/guard/cursor/guard-hook.mjs`: a copy of the bundled hook. Cursor runs the
 *   copy, because a package run through `npx` lives in a cache that can be cleared.
 * - In `~/.cursor/hooks.json`, one entry at the end of the `preToolUse` list and one at the
 *   end of the `beforeShellExecution` list, each
 *   `{"command": "\"<node>\" \"<copy>\" --agent cursor", "timeout": 10}`. Node is named by
 *   its absolute path, so the entry runs the same Node whatever `PATH` Cursor started with.
 *   There is no `failClosed`: a hook that cannot run lets the call through.
 * - On the first install, the file as it was goes to `hooks.json.backup`, or, when there was
 *   no file, an empty `hooks.json.was-absent` records that. Later installs keep whichever is
 *   there.
 * - `install.json`: `{installedAt, hookPath, nodePath, guardVersion}`.
 * - `config.json` and `guardrails.json`, when missing, exactly as `init --agent claude` seeds
 *   them.
 *
 * The entries are the ones `isGuardCursorCommand` (`core/cursor-entry.ts`) recognises, which
 * is how the hook and `status` decide whether guard is installed for Cursor.
 *
 * ── `hooks.json` belongs to Cursor and to the user ──────────────────────────
 * - Guard refuses, and changes nothing, when the file cannot be read, is not JSON, is not an
 *   object, has a `version` other than 1, has a `hooks` value that is not an object, has a
 *   hook list that is not an array, or is read-only. A file that changes while guard is
 *   installing is not written either.
 * - Only guard's entries are removed or added. Every other key and entry is kept, in order.
 *   The file is written back as two-space JSON.
 * - The file keeps its mode. A file guard creates gets 0600: Cursor runs as the same user,
 *   and a hook command another tool adds later can carry a token.
 * - A project's `.cursor/hooks.json` and enterprise hooks files are never read or written.
 *
 * ── Uninstall ───────────────────────────────────────────────────────────────
 * Guard's entries are removed. When what is left matches the backup, the backup's exact text
 * is written back. When there was no file before and nothing is left, the file is deleted.
 * Otherwise what is left is written. Then the copy, the backup and both records are deleted.
 * `config.json`, `guardrails.json`, `events.jsonl` and `crashes/` are left alone.
 */

import { join } from "node:path";
import { serializeDefaultConfig } from "../core/config.js";
import { GUARD_CURSOR_EVENTS, isGuardCursorCommand } from "../core/cursor-entry.js";
import {
  configPath,
  cursorHookCopyPath,
  cursorHooksAbsentPath,
  cursorHooksBackupPath,
  cursorHooksPath,
  cursorInstallRecordPath,
  guardCursorDir,
  guardDir,
  userRulesPath,
} from "../core/paths.js";
import type { SetupIO } from "../setup-io.js";
import type { CursorFileIO } from "./cursor-io.js";

/** Seconds Cursor waits for guard's hook before letting the call through. */
export const CURSOR_HOOK_TIMEOUT = 10;

/**
 * The Cursor analogue of Claude Code's "a hold does not prompt when settings allow the tool."
 *
 * On Claude Code a `permissions.allow` rule in `settings.json` beats the hook's `ask`, and
 * the guard reads that file to say how many holds it silences. Cursor has a comparable effect
 * — its own run mode can auto-run a shell command before the guard's approval card shows (in
 * Sandbox mode a command runs with no card at all) — but there is no documented, stable file
 * to read it from, so the guard cannot count it, only name it. `ask` on Cursor's non-shell
 * tools is a separate matter and is already handled by DENYING instead (see
 * `core/cursor-emit.ts`), so this note is only about the shell approval card.
 */
export const CURSOR_RUN_MODE_NOTE =
  "An approval guardrail may not prompt when Cursor's own run mode auto-approves the command first — in Sandbox mode a shell command runs with no card — and guard cannot read Cursor's run-mode settings to say which.";

/** The mode of every file guard writes in its own folder, and of a `hooks.json` it creates. */
const PRIVATE_MODE = 0o600;

/** A path character a double-quoted shell word does not keep as written. */
const SHELL_UNSAFE = /["$`\r\n]/;

/** A step that failed, or the value it produced. */
type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

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
 * Parse the text of `hooks.json` and check that guard can change it.
 *
 * No text (no file) reads as `{"version": 1, "hooks": {}}`. A file with no `version` or no
 * `hooks` is accepted, and gains `"version": 1` first and `"hooks"` last.
 *
 * Pure, and never throws.
 */
export function readHooksFile(text: string | undefined): HooksFile {
  if (text === undefined) {
    const hooks: Record<string, unknown[]> = {};
    return { ok: true, doc: { version: 1, hooks }, hooks };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "is not a JSON object" };
  if (parsed.version !== undefined && parsed.version !== 1) {
    return { ok: false, reason: `has version ${JSON.stringify(parsed.version)}, not 1` };
  }
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) {
    return { ok: false, reason: 'has a "hooks" value that is not an object' };
  }
  const hooks = parsed.hooks ?? {};
  for (const [name, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) {
      return { ok: false, reason: `has a "${name}" hook list that is not an array` };
    }
  }
  const doc = "version" in parsed ? parsed : { version: 1, ...parsed };
  doc.hooks = hooks;
  return { ok: true, doc, hooks: hooks as Record<string, unknown[]> };
}

/**
 * The hook lists without guard's entries, in the same order, and how many were removed.
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
    const kept = list.filter((entry) => !(isRecord(entry) && isGuardCursorCommand(entry.command)));
    removed += list.length - kept.length;
    if (kept.length > 0 || list.length === 0 || keep.has(name)) next[name] = kept;
  }
  return { hooks: next, removed };
}

/** The text `hooks.json` is written as. */
function serializeHooks(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The command a guard entry runs: Node and the hook copy, each in double quotes, then
 * `--agent cursor`.
 *
 * `undefined` when either path holds a double quote, `$`, a backtick or a line break, which a
 * shell would not pass through a double-quoted word as written.
 */
export function cursorHookCommand(nodePath: string, hookPath: string): string | undefined {
  if (SHELL_UNSAFE.test(nodePath) || SHELL_UNSAFE.test(hookPath)) return undefined;
  return `"${nodePath}" "${hookPath}" --agent cursor`;
}

/**
 * `hooks.json` with guard's entries: earlier guard entries removed from every list, then one
 * `{command, timeout}` entry added at the end of each of guard's two lists.
 *
 * Pure, and never throws. Running it on its own output gives the same text.
 */
export function addGuardEntries(
  text: string | undefined,
  command: string,
): { ok: true; text: string; removed: number } | { ok: false; reason: string } {
  const read = readHooksFile(text);
  if (!read.ok) return read;
  const { hooks, removed } = withoutGuardEntries(read.hooks, new Set(GUARD_CURSOR_EVENTS));
  for (const event of GUARD_CURSOR_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { command, timeout: CURSOR_HOOK_TIMEOUT }];
  }
  read.doc.hooks = hooks;
  return { ok: true, text: serializeHooks(read.doc), removed };
}

/**
 * `hooks.json` without guard's entries.
 *
 * `empty` when nothing is left but `version` and a `hooks` object with no lists.
 *
 * Pure, and never throws.
 */
export function removeGuardEntries(
  text: string,
): { ok: true; text: string; removed: number; empty: boolean } | { ok: false; reason: string } {
  const read = readHooksFile(text);
  if (!read.ok) return read;
  const { hooks, removed } = withoutGuardEntries(read.hooks, new Set());
  read.doc.hooks = hooks;
  const empty =
    Object.keys(hooks).length === 0 &&
    Object.keys(read.doc).every((key) => key === "version" || key === "hooks");
  return { ok: true, text: serializeHooks(read.doc), removed, empty };
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
 * Whether two `hooks.json` texts are the same file for Cursor once guard's entries are set
 * aside: the same keys and hook entries, with key order, formatting, empty lists and a missing
 * `version` or `hooks` not counted.
 *
 * Pure, and never throws. `false` when either text is not a file guard can read.
 */
export function sameHooksApartFromGuard(a: string, b: string): boolean {
  const canonical = (text: string): string | undefined => {
    const read = readHooksFile(text);
    if (!read.ok) return undefined;
    const { hooks } = withoutGuardEntries(read.hooks, new Set());
    const lists = Object.fromEntries(Object.entries(hooks).filter(([, list]) => list.length > 0));
    return canonicalJson({ ...read.doc, hooks: lists });
  };
  const left = canonical(a);
  return left !== undefined && left === canonical(b);
}

// ── install ──────────────────────────────────────────────────────────────────

/** What `init --agent cursor` works with. */
export interface CursorInstallRequest {
  /** Seeds `config.json` and `guardrails.json`, and names the home folder. */
  readonly setup: SetupIO;
  readonly files: CursorFileIO;
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
export interface CursorInstallPlan {
  readonly home: string;
  readonly hooksPath: string;
  readonly hookCopy: string;
  readonly nodePath: string;
  readonly command: string;
  /** `config.json` and `guardrails.json`, written through `SetupIO` at mode 0600. */
  readonly seeds: readonly PlannedWrite[];
  /** Guard's own files under `cursor/`, in the order they are written. */
  readonly files: readonly PlannedWrite[];
  /** The new `hooks.json`, or `undefined` when it already holds exactly these entries. */
  readonly hooks:
    | (PlannedWrite & { readonly before: string | undefined; readonly removed: number })
    | undefined;
  /** Whether this install saves the current `hooks.json` as the backup. */
  readonly savesBackup: boolean;
}

/** The `install.json` text for these values. */
function serializeRecord(request: CursorInstallRequest, hookPath: string): string {
  const record = {
    installedAt: request.now.toISOString(),
    hookPath,
    nodePath: request.nodePath,
    guardVersion: request.guardVersion,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Whether `install.json` already records this copy, this Node and this version. */
function recordIsCurrent(
  text: string | undefined,
  request: CursorInstallRequest,
  hookPath: string,
): boolean {
  if (text === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      isRecord(parsed) &&
      typeof parsed.installedAt === "string" &&
      parsed.hookPath === hookPath &&
      parsed.nodePath === request.nodePath &&
      parsed.guardVersion === request.guardVersion
    );
  } catch {
    return false;
  }
}

/**
 * Work out what `init --agent cursor` would change. Reads files and writes none.
 *
 * Never throws: a read that fails, or a `hooks.json` guard will not change, is a message.
 */
export function planCursorInstall(request: CursorInstallRequest): Outcome<CursorInstallPlan> {
  const { setup, files } = request;
  const home = setup.homedir();
  const hooksPath = cursorHooksPath(home);
  const hookCopy = cursorHookCopyPath(home);
  const hookSource = join(request.scaffoldDir, "scripts", "guard-hook.mjs");
  const refuse = (message: string): Outcome<CursorInstallPlan> => ({
    ok: false,
    message: `${message} Nothing was changed.`,
  });

  const command = cursorHookCommand(request.nodePath, hookCopy);
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

    const backupPath = cursorHooksBackupPath(home);
    const absentPath = cursorHooksAbsentPath(home);
    const firstInstall =
      step("read", backupPath, () => files.fileMode(backupPath)) === undefined &&
      step("read", absentPath, () => files.fileMode(absentPath)) === undefined;
    const recordPath = cursorInstallRecordPath(home);
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
    if (!recordIsCurrent(recordText, request, hookCopy)) {
      own.push({
        path: recordPath,
        text: serializeRecord(request, hookCopy),
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
  "agenttrail-guard init --agent cursor --print — this is what would happen. Nothing is changed.";

/** What `init --agent cursor --print` shows for a plan, or for a refusal. */
export function describeCursorInstall(planned: Outcome<CursorInstallPlan>): string {
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
    const removed = plan.hooks.removed;
    if (removed > 0) {
      lines.push(
        `          removes ${removed} earlier guard ${removed === 1 ? "entry" : "entries"}`,
      );
    }
    lines.push(
      `          adds this entry at the end of ${GUARD_CURSOR_EVENTS.join(" and of ")}:`,
      `          ${JSON.stringify({ command: plan.command, timeout: CURSOR_HOOK_TIMEOUT })}`,
    );
  }
  lines.push(
    "",
    "It would NOT touch a project's .cursor/hooks.json or an enterprise hooks file, and it",
    "does not run Claude Code.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Carry out a plan from `planCursorInstall`. Returns the lines to print.
 *
 * Writes in this order: `config.json` and `guardrails.json`, the hook copy, the backup or the
 * was-absent record, `install.json`, and `hooks.json` last. `hooks.json` is read again just
 * before it is written, and left alone when it changed since the plan was made.
 *
 * Never throws.
 */
export function applyCursorInstall(
  request: CursorInstallRequest,
  plan: CursorInstallPlan,
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
    lines.push(`Already installed for Cursor: ${plan.hooksPath} runs ${plan.hookCopy}.`);
  } else if (plan.hooks.removed > 0) {
    lines.push(`Updated guard's entries in ${plan.hooksPath}.`);
  } else {
    lines.push(
      `Installed for Cursor: a ${GUARD_CURSOR_EVENTS.join(" entry and a ")} entry in ${plan.hooksPath}.`,
    );
  }
  lines.push(`They run ${plan.hookCopy} with ${plan.nodePath}.`);
  if (plan.savesBackup) {
    lines.push(
      `Saved the earlier ${plan.hooksPath} as ${cursorHooksBackupPath(plan.home)}.`,
      "`agenttrail-guard uninstall --agent cursor` puts it back.",
    );
  }
  if (plan.hooks !== undefined) {
    lines.push(
      "Cursor reloads hooks.json by itself. If guard's entries do not show in Cursor's Hooks",
      "tab, restart Cursor.",
    );
  }
  for (const write of [...plan.seeds, ...plan.files]) lines.push(`Wrote ${write.path}`);
  return { ok: true, value: lines };
}

// ── uninstall ────────────────────────────────────────────────────────────────

/**
 * Remove guard's Cursor install. Returns the lines to print.
 *
 * Never throws: a read or write that fails, or a `hooks.json` guard will not change, is a
 * message.
 */
export function uninstallCursor(home: string, files: CursorFileIO): Outcome<readonly string[]> {
  const hooksPath = cursorHooksPath(home);
  const backupPath = cursorHooksBackupPath(home);
  const absentPath = cursorHooksAbsentPath(home);
  const own = [cursorHookCopyPath(home), cursorInstallRecordPath(home), backupPath, absentPath];
  let change: "none" | "restored" | "deleted" | "rewritten" = "none";

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
          "Guard is not installed for Cursor — nothing to remove.",
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
    if (present.length > 0) lines.push(`Deleted guard's Cursor files in ${guardCursorDir(home)}.`);
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
