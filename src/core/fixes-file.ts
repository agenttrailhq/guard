/**
 * The local fixes file: the exact fix commands for this machine, with real branch names and
 * paths, behind the redacted shapes the report shows.
 *
 * `commands/scan.ts` writes it next to the report, at `0600`, only when a check has made an
 * exact command. It is never part of the page, its data block or `--json`: those carry the
 * shapes. It holds the commands the checks built from what they found, and no credential value,
 * since no check puts a value in a command.
 *
 * One command per line. A command that spans lines is left out and counted rather than written
 * in a form that would run differently from what the check meant.
 *
 * Pure. No I/O.
 */

import { readableTime } from "./report.js";
import { isLocalFix, type LocalFix, type UnsafeFix } from "./verify/cards.js";
import { CATEGORY_TITLES } from "./verify/copy.js";
import { VERIFY_CATEGORIES, type VerifyCategory } from "./verify/types.js";

/** What a check hands the file: an exact command, or a fix it could not make safe. */
export type FileFix = LocalFix | UnsafeFix;

/** What the file says about itself. */
export interface FixesFileMeta {
  readonly version: string;
  readonly generatedAt: Date;
  /** The report's file name, without its folder. */
  readonly reportName: string;
}

/** A line break or any other control character but a tab. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** The commands the file can hold: exact commands, one line each. */
function writable(fixes: readonly FileFix[]): LocalFix[] {
  return fixes.filter(
    (fix): fix is LocalFix =>
      isLocalFix(fix) && fix.command.trim() !== "" && !CONTROL.test(fix.command),
  );
}

/** The fixes a check could not make safe: listed by category with a note, never as a command. */
function unsafe(fixes: readonly FileFix[]): UnsafeFix[] {
  return fixes.filter((fix): fix is UnsafeFix => !isLocalFix(fix) && "unsafe" in fix);
}

/** How many exact commands the file would hold. */
export function exactFixCount(fixes: readonly FileFix[]): number {
  return writable(fixes).length;
}

/** How many fixes the file lists as could not be made safe. */
export function unsafeFixCount(fixes: readonly FileFix[]): number {
  return unsafe(fixes).length;
}

/**
 * The categories the file holds an exact command for, in card order. A card names the file
 * only for these: a category whose fixes all could not be made safe has no command in it.
 */
export function fixCategories(fixes: readonly FileFix[]): VerifyCategory[] {
  const kept = writable(fixes);
  return VERIFY_CATEGORIES.filter((category) => kept.some((fix) => fix.category === category));
}

/** Whether the file has anything to say: an exact command, or a fix that could not be made safe. */
export function hasFileFixes(fixes: readonly FileFix[]): boolean {
  return writable(fixes).length + unsafe(fixes).length > 0;
}

/** The file's text: a short header, then each category's commands under its card's title. */
export function fixesFileText(fixes: readonly FileFix[], meta: FixesFileMeta): string {
  const kept = writable(fixes);
  const notes = unsafe(fixes);
  const left = fixes.length - kept.length - notes.length;
  const out: string[] = [
    "AgentTrail Guard: fix commands for this machine",
    "",
    `Written by agenttrail-guard ${meta.version} on ${readableTime(meta.generatedAt)}, with ${meta.reportName}.`,
    "",
    "These are the exact commands behind the redacted shapes in the report, with real",
    "branch names and paths. Keep this file on this machine: it is not part of the",
    "report, and only your user account can read it. Read each command before you run",
    "it. Nothing here has been run.",
  ];
  if (left > 0) {
    out.push(
      "",
      `${left === 1 ? "1 command was" : `${left} commands were`} left out because ${left === 1 ? "it does" : "they do"} not fit on one line.`,
    );
  }
  for (const category of VERIFY_CATEGORIES) {
    const commands = kept.filter((fix) => fix.category === category);
    const unsafeHere = notes.filter((fix) => fix.category === category).length;
    if (commands.length + unsafeHere === 0) continue;
    out.push("", CATEGORY_TITLES[category]);
    for (const fix of commands) out.push(fix.command);
    if (unsafeHere > 0) {
      out.push(
        `(${unsafeHere === 1 ? "1 fix here: could not make a safe command" : `${unsafeHere} fixes here: could not make a safe command`}, so none is written for ${unsafeHere === 1 ? "it" : "them"}.)`,
      );
    }
  }
  return `${out.join("\n")}\n`;
}
