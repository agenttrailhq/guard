/**
 * `scan --scrub`: the edits that take likely-real credentials out of one transcript file.
 *
 * Pure. It takes a file's text and the values to remove, and returns the new text with what
 * changed. Reading, backing up and writing are `scrub-io.ts`'s; deciding which values are
 * likely real is `verify/secrets.ts`'s. `scrub.ts`, the pattern redactor the report uses, is
 * not involved: this module replaces known values, it does not look for new ones.
 *
 * ── How a value is replaced ──────────────────────────────────────────────────
 * Transcripts are JSON Lines. Each line is edited as raw text, and only inside its JSON
 * strings: every occurrence of a value, in the escaped form JSON gives it, becomes
 * `[REDACTED-BY-AGENTTRAIL:<kind>]`. No line is parsed and written back, so key order, number
 * formats and spacing stay exactly as the app wrote them. An occurrence that starts inside an
 * escape sequence (the `n` of `\n`) is not a match.
 *
 * Three escaped forms are tried for each value: JSON's own, the same with every non-ASCII
 * character as `\uXXXX`, and the same with `/` as `\/`. Writers differ on those two points.
 *
 * ── Each changed line is checked ─────────────────────────────────────────────
 * The new line must parse as JSON. A line that would not, or that did not parse to begin with,
 * is left exactly as it was and counted. A line that parses but still holds a value once
 * decoded (written in an escape form not tried above) keeps its edits and is counted too, so
 * the caller can say the file was not fully cleaned.
 *
 * ── Idempotent ───────────────────────────────────────────────────────────────
 * The replacement holds no value and matches no credential pattern, so a second run finds
 * nothing to replace and returns the text unchanged.
 */

import { createHash } from "node:crypto";
import type { SecretKind } from "./verify/types.js";

/** The word in every replacement, so a scrubbed spot is easy to find. */
export const SCRUB_MARKER = "REDACTED-BY-AGENTTRAIL";

/** What a value of `kind` is replaced with. */
export function scrubPlaceholder(kind: SecretKind): string {
  return `[${SCRUB_MARKER}:${kind}]`;
}

/** The SHA-256 of some bytes, as hex. Compares a file's bytes across reads. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One value to remove, and the kind it is reported as. */
export interface ScrubTarget {
  readonly value: string;
  readonly kind: SecretKind;
}

/** What scrubbing one file's text would do. */
export interface FileScrubPlan {
  /** The new text. The same string when nothing changed. */
  readonly text: string;
  readonly changed: boolean;
  /** Replacements made, by kind. */
  readonly replaced: Readonly<Partial<Record<SecretKind, number>>>;
  /** Replacements made in all. */
  readonly total: number;
  readonly linesChanged: number;
  /** Lines holding a value that were left as they were, because the edit would not parse. */
  readonly linesLeft: number;
  /** Changed lines that still hold a value once decoded. */
  readonly linesIncomplete: number;
}

/** A value's raw form and what replaces it. */
interface Form {
  readonly raw: string;
  readonly kind: SecretKind;
  readonly placeholder: string;
}

/** `text` as it sits between the quotes of a JSON string. */
function jsonForm(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** `form` with every character above `~` written as a lowercase `\uXXXX`. */
function asciiForm(form: string): string {
  let out = "";
  for (const ch of form) {
    const code = ch.charCodeAt(0);
    if (code <= 0x7e) {
      out += ch;
      continue;
    }
    for (let i = 0; i < ch.length; i++) {
      out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/** The raw forms of each target, longest value first, as they may appear in a line. */
function formsOf(targets: readonly ScrubTarget[]): Form[] {
  const forms: Form[] = [];
  const sorted = [...targets].sort((a, b) => b.value.length - a.value.length);
  for (const target of sorted) {
    if (target.value === "") continue;
    const json = jsonForm(target.value);
    const raws = new Set([json, asciiForm(json), json.replaceAll("/", "\\/")]);
    for (const raw of raws) {
      forms.push({ raw, kind: target.kind, placeholder: scrubPlaceholder(target.kind) });
    }
  }
  return forms;
}

/** Is the character at `at` the second half of an escape, after an odd run of `\`? */
function escapedAt(text: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text.charCodeAt(i) === 92; i--) slashes += 1;
  return slashes % 2 === 1;
}

/** Replace every unescaped occurrence of each form in one string's raw contents. */
function replaceInString(inner: string, forms: readonly Form[], counts: Map<SecretKind, number>) {
  let text = inner;
  for (const form of forms) {
    if (!text.includes(form.raw)) continue;
    let out = "";
    let from = 0;
    for (;;) {
      const at = text.indexOf(form.raw, from);
      if (at < 0) break;
      if (escapedAt(text, at)) {
        out += text.slice(from, at + 1);
        from = at + 1;
        continue;
      }
      out += text.slice(from, at) + form.placeholder;
      from = at + form.raw.length;
      counts.set(form.kind, (counts.get(form.kind) ?? 0) + 1);
    }
    text = out + text.slice(from);
  }
  return text;
}

/** One line with every form replaced inside its JSON strings, and nowhere else. */
function replaceInLine(line: string, forms: readonly Form[], counts: Map<SecretKind, number>) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf('"', i);
    if (open < 0) {
      out += line.slice(i);
      break;
    }
    let end = open + 1;
    while (end < line.length) {
      const code = line.charCodeAt(end);
      if (code === 92) end += 2;
      else if (code === 34) break;
      else end += 1;
    }
    if (end >= line.length) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, open + 1);
    out += replaceInString(line.slice(open + 1, end), forms, counts);
    out += '"';
    i = end + 1;
  }
  return out;
}

/** Most strings `holdsValue` looks at in one line. */
const MAX_STRINGS = 100_000;

/** Does any string in a parsed line, key or value, still contain one of `values`? */
function holdsValue(parsed: unknown, values: readonly string[]): boolean {
  const stack: unknown[] = [parsed];
  let seen = 0;
  while (stack.length > 0 && seen < MAX_STRINGS) {
    const item = stack.pop();
    if (typeof item === "string") {
      seen += 1;
      if (values.some((v) => item.includes(v))) return true;
    } else if (Array.isArray(item)) {
      for (const x of item) stack.push(x);
    } else if (item !== null && typeof item === "object") {
      for (const [key, x] of Object.entries(item)) {
        stack.push(key);
        stack.push(x);
      }
    }
  }
  return false;
}

/** `JSON.parse`, or `undefined` for text that is not JSON. */
function parsed(line: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(line) };
  } catch {
    return undefined;
  }
}

/**
 * Scrub one file's text. See the module header.
 *
 * `held` is the values the secrets check found in this file. A line with none of the tried
 * forms is decoded and checked for them when it holds an escape, so a value written in a form
 * none of the tried ones match is counted as left rather than missed.
 */
export function planFileScrub(
  text: string,
  targets: readonly ScrubTarget[],
  held: readonly string[] = [],
): FileScrubPlan {
  const forms = formsOf(targets).filter((form) => text.includes(form.raw));
  const heldValues = [...new Set(held.filter((v) => v !== ""))];
  const counts = new Map<SecretKind, number>();
  if (forms.length === 0 && heldValues.length === 0) {
    return {
      text,
      changed: false,
      replaced: {},
      total: 0,
      linesChanged: 0,
      linesLeft: 0,
      linesIncomplete: 0,
    };
  }

  const values = [...new Set(targets.map((t) => t.value).filter((v) => v !== ""))];
  const lines = text.split("\n");
  let linesChanged = 0;
  let linesLeft = 0;
  let linesIncomplete = 0;

  for (const [index, line] of lines.entries()) {
    if (!forms.some((form) => line.includes(form.raw))) {
      // No tried form here. A held value can still be here only behind an escape (`\`).
      if (heldValues.length > 0 && line.includes("\\")) {
        const decoded = parsed(line);
        if (decoded !== undefined && holdsValue(decoded.value, heldValues)) linesLeft += 1;
      }
      continue;
    }
    const lineCounts = new Map<SecretKind, number>();
    const next = replaceInLine(line, forms, lineCounts);
    if (next === line) {
      // Nothing was replaced. The line still holds a value when it is not JSON (a string cut
      // off part-way, as in a last line written as the app stopped), or when it decodes to one.
      // An occurrence that only starts inside an escape sequence is not a value.
      const before = parsed(line);
      if (before === undefined || holdsValue(before.value, values)) linesLeft += 1;
      continue;
    }
    const after = parsed(next);
    if (parsed(line) === undefined || after === undefined) {
      linesLeft += 1;
      continue;
    }
    lines[index] = next;
    linesChanged += 1;
    for (const [kind, n] of lineCounts) counts.set(kind, (counts.get(kind) ?? 0) + n);
    if (holdsValue(after.value, values)) linesIncomplete += 1;
  }

  const replaced: Partial<Record<SecretKind, number>> = {};
  let total = 0;
  for (const [kind, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    replaced[kind] = n;
    total += n;
  }
  const changed = linesChanged > 0;
  return {
    text: changed ? lines.join("\n") : text,
    changed,
    replaced,
    total,
    linesChanged,
    linesLeft,
    linesIncomplete,
  };
}
