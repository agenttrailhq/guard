/**
 * Is guard's Cursor hook installed? Answered from the text of Cursor's user hooks file,
 * `~/.cursor/hooks.json`.
 *
 * The file is shaped like this:
 *
 *   {"version": 1, "hooks": {"preToolUse": [{"command": "…", "timeout": 10}], …}}
 *
 * Guard's Cursor install is two entries, one in the `preToolUse` list and one in the
 * `beforeShellExecution` list, each running `guard-hook.mjs --agent cursor`.
 *
 * ── Both entries are required ────────────────────────────────────────────────
 * A terminal command's approval is asked at `beforeShellExecution`. With only the
 * `preToolUse` entry, nothing would ask: the `preToolUse` entry leaves an approval for
 * later, and so does guard's Claude Code plugin when it believes the Cursor entry is
 * installed. So one entry on its own counts as not installed.
 *
 * ── Unreadable counts as not installed ───────────────────────────────────────
 * Missing text, text that is not JSON, and a file of the wrong shape all answer `false`.
 * Guard's Claude Code plugin then acts as the only checkpoint, which is the stricter
 * answer. Other keys, including `version`, and other hook entries are not read.
 *
 * Pure: it takes the file's text, so each caller reads the file through its own IO.
 */

/** The Cursor hooks that guard's install puts an entry under. */
export const GUARD_CURSOR_EVENTS = ["preToolUse", "beforeShellExecution"] as const;

/** The file a guard entry runs. */
const HOOK_SCRIPT = "guard-hook.mjs";

/** `--agent cursor` as whole words: `--agent cursors` does not count. */
const CURSOR_FLAG = /(?:^|\s)--agent cursor(?=\s|$)/;

/** A JSON object: not `null`, and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether a hook entry's command runs guard's hook for Cursor: it names `guard-hook.mjs`
 * and passes `--agent cursor`, as whole words.
 *
 * Pure, and never throws.
 */
export function isGuardCursorCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(HOOK_SCRIPT) && CURSOR_FLAG.test(command);
}

/** Whether a hook list holds a guard entry. Anything but an array holds none. */
function listHasGuardEntry(list: unknown): boolean {
  return (
    Array.isArray(list) &&
    list.some((entry) => isRecord(entry) && isGuardCursorCommand(entry.command))
  );
}

/**
 * Whether the text of `~/.cursor/hooks.json` holds both of guard's Cursor entries.
 *
 * `false` for `undefined`, text that is not JSON, a root that is not an object, `hooks`
 * that is not an object, or a hook list that is not an array.
 *
 * Pure, and never throws.
 */
export function hasGuardCursorEntry(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const hooks = parsed.hooks;
  if (!isRecord(hooks)) return false;
  return GUARD_CURSOR_EVENTS.every((event) => listHasGuardEntry(hooks[event]));
}
