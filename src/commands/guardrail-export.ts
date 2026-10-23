/**
 * `guardrails export` — turn one of the user's own guardrails into a file for the public
 * library, in two steps:
 *
 * 1. `export <id>` writes a JSON draft. It holds the guardrail plus a `fixtures` block whose
 *    examples are blanks marked `FILL IN`, an `owasp` blank (a guardrail in `guardrails.json`
 *    never carries OWASP ids, and every library guardrail cites at least one), and a
 *    `title` / `description` blank where the user's guardrail had none (the library requires
 *    both).
 * 2. `export <draft.json>` checks the filled draft exactly as `validate` does, and only then
 *    writes the library's TypeScript module.
 *
 * The draft is the only file the user edits, so the examples are written once and the
 * module can never carry a blank or a failing example.
 *
 * Everything here is pure: the command in `rules.ts` does the reading and writing.
 */

import type { Fixture, Rule } from "@agenttrail/guardrails";
import type { GuardRule } from "../core/types.js";

/** The marker every blank starts with. `validate` refuses a file that still has one. */
export const BLANK = "FILL IN";

/** The line printed after a successful `guardrails add`, without the guardrail's id. */
export const ADD_FOLLOW_UP =
  "Want everyone to have this guardrail? Run: agenttrail-guard guardrails export";

/** The line printed after a successful `guardrails add` of `id`. */
export function addFollowUp(id: string): string {
  return `${ADD_FOLLOW_UP} ${id}`;
}

/**
 * Whether the line after `add` may print: only to a person at an interactive terminal, never
 * under `--quiet` or `--json`, and never into a pipe, a file or a script's captured output.
 */
export function addFollowUpAllowed(output: {
  readonly quiet: boolean;
  readonly json: boolean;
  readonly isTTY: boolean;
}): boolean {
  return output.isTTY && !output.quiet && !output.json;
}

/** The repository a guardrail is submitted to, and the guide for doing it. */
export const LIBRARY_REPO = "https://github.com/agenttrailhq/guardrails";
export const SUBMIT_GUIDE = `${LIBRARY_REPO}/blob/main/CONTRIBUTING.md#submit-a-guardrail`;

// ── Ids ─────────────────────────────────────────────────────────────────────

/**
 * The id prefix each pack uses (`wt.`, `gb.`, …), read from the shipped catalog.
 *
 * The library has no table of these; they are a naming convention, and `safety-bypass`
 * uses `gb.`, which no rule could derive from the pack's name. Taking the most common
 * dotted prefix in each pack follows the convention as it stands. Ids without a dot are
 * ignored.
 */
export function packPrefixes(catalog: readonly GuardRule[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const rule of catalog) {
    const dot = rule.id.indexOf(".");
    if (dot <= 0) continue;
    const prefix = rule.id.slice(0, dot + 1);
    const pack = counts.get(rule.category) ?? new Map<string, number>();
    pack.set(prefix, (pack.get(prefix) ?? 0) + 1);
    counts.set(rule.category, pack);
  }
  const prefixes = new Map<string, string>();
  for (const [pack, byPrefix] of counts) {
    const best = [...byPrefix].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best !== undefined) prefixes.set(pack, best[0]);
  }
  return prefixes;
}

/**
 * The id a guardrail gets in the library: the pack's prefix, then the user's name for it
 * with any first dotted segment (`local.`, `team.`) dropped.
 */
export function exportId(
  id: string,
  pack: string,
  prefixes: ReadonlyMap<string, string>,
): { id: string; warning?: string } {
  const prefix = prefixes.get(pack);
  if (prefix === undefined || (id.startsWith(prefix) && id.length > prefix.length)) return { id };
  const dot = id.indexOf(".");
  const rest = dot === -1 ? id : id.slice(dot + 1);
  const renamed = `${prefix}${rest.length > 0 ? rest : id}`;
  return {
    id: renamed,
    warning: `\`${id}\` has no pack prefix. Pack \`${pack}\` uses \`${prefix}\`, so the draft uses \`${renamed}\`. Change it in the draft if you prefer another name; it cannot be renamed after it is merged.`,
  };
}

/** `wt.stash-drop` → `wt-stash-drop`: the file name the library uses for that id. */
export function fileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export " +
    "extends false finally for function if import in instanceof new null return super " +
    "switch this throw true try typeof var void while with let static yield await"
  ).split(" "),
);

/** `wt.stash-drop` → `wtStashDrop`: the export name the library uses for that id. */
export function exportName(id: string): string {
  const words = id.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  const name = words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join("");
  if (name.length === 0 || /^[0-9]/.test(name) || RESERVED.has(name)) {
    return `rule${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  }
  return name;
}

// ── The draft ───────────────────────────────────────────────────────────────

type Channel = "command" | "file";

/**
 * Which kinds of example a guardrail needs. A `file_glob` condition is proven with a path,
 * anything else with a command; a guardrail with both kinds of condition needs both,
 * because an example of the wrong kind matches nothing and passes as quiet.
 */
export function channelsOf(match: unknown): Channel[] {
  const found = new Set<Channel>();
  if (match !== null && typeof match === "object") {
    const m = match as Record<string, unknown>;
    for (const key of ["any_of", "all_of"]) {
      const list = m[key];
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (c === null || typeof c !== "object") continue;
        found.add("file_glob" in c ? "file" : "command");
      }
    }
  }
  if (found.size === 0) found.add("command");
  return (["command", "file"] as const).filter((c) => found.has(c));
}

function blankFixture(channel: Channel, direction: "block" | "allow"): Fixture {
  const verb = direction === "block" ? "must match" : "must NOT match";
  return channel === "file"
    ? { tool: "Edit", file_path: `${BLANK}: a file path this guardrail ${verb}` }
    : { tool: "Bash", command: `${BLANK}: a command this guardrail ${verb}` };
}

/** The draft `export <id>` writes. Its blanks are what `findBlanks` reports. */
export function draftFor(rule: GuardRule, id: string): Record<string, unknown> {
  const channels = channelsOf(rule.match);
  return {
    id,
    category: rule.category,
    severity: rule.severity,
    defaultAction: rule.defaultAction,
    owasp: [`${BLANK}: the OWASP ids this guardrail addresses, such as ASI02 or LLM03`],
    title: rule.title.length > 0 && rule.title !== rule.id ? rule.title : `${BLANK}: a short title`,
    description:
      rule.description.length > 0
        ? rule.description
        : `${BLANK}: at least 120 characters on what this guardrail catches, and what it does not catch`,
    match: rule.match,
    fixtures: {
      block: channels.map((c) => blankFixture(c, "block")),
      allow: channels.map((c) => blankFixture(c, "allow")),
    },
  };
}

/**
 * What the library's own tests will reject, said before the pull request rather than by CI.
 * Warnings, not refusals: the library's tests are the authority, and they can change.
 */
export function libraryWarnings(rule: {
  id: string;
  title: string;
  description: string;
  match: unknown;
  owasp?: readonly string[] | undefined;
}): string[] {
  const warnings: string[] = [];
  if (JSON.stringify(rule.match).includes('"detail_contains"')) {
    warnings.push(
      "it uses `detail_contains`. New library guardrails use `detail_matches` (a regular expression, matched case-insensitively); rewrite the condition in the draft.",
    );
  }
  if (rule.description.length < 120 || !DOES_NOT.test(rule.description)) {
    warnings.push(
      'its `description` must be at least 120 characters and say what it does not catch (for example "Does not match …").',
    );
  }
  if (rule.title.length <= 10 || rule.title === rule.id) {
    warnings.push("its `title` must be longer than 10 characters and not just the id.");
  }
  if (rule.owasp === undefined || rule.owasp.length === 0) {
    warnings.push(
      "it has no `owasp` ids. Every library guardrail lists at least one OWASP risk it addresses (ASI01 to ASI10, LLM01 to LLM10).",
    );
  }
  return warnings;
}

const DOES_NOT =
  /does not|deliberately not|misses|missed|cannot|known miss|not caught|not matched|not flagged|ceiling/i;

/** Every string in `value` that is still a blank, by its path (`fixtures.block[0].command`). */
export function findBlanks(value: unknown, path = ""): string[] {
  if (typeof value === "string") return value.startsWith(BLANK) ? [path || "(the file)"] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findBlanks(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => findBlanks(v, path ? `${path}.${k}` : k));
  }
  return [];
}

// ── The library module ──────────────────────────────────────────────────────
// Written in the library's style and its formatter's layout (2-space indent, double quotes
// unless a string holds more double than single quotes, trailing commas, 100 columns), so
// the file passes the library's lint without reformatting.

const WIDTH = 100;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quote(text: string): string {
  const doubles = (text.match(/"/g) ?? []).length;
  const singles = (text.match(/'/g) ?? []).length;
  if (doubles > singles) {
    return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
  }
  return JSON.stringify(text);
}

function key(name: string): string {
  return IDENT.test(name) ? name : quote(name);
}

function call(name: string, args: string[]): string {
  return `${name}(${args.join(", ")})`;
}

/** A fixture as the helper call the library writes it with. */
function fixtureCall(f: Fixture, helpers: Set<string>): string | undefined {
  if ("command" in f) {
    if (f.tool === "Bash") {
      helpers.add("bash");
      return call("bash", [quote(f.command)]);
    }
    if (f.tool === "PowerShell") {
      helpers.add("pwsh");
      return call("pwsh", [quote(f.command)]);
    }
    return undefined;
  }
  helpers.add("file");
  return call(
    "file",
    f.tool === "Edit" ? [quote(f.file_path)] : [quote(f.file_path), quote(f.tool)],
  );
}

type Code = { call: string } | unknown;

/** Render a value; objects always break, arrays and calls stay on one line when they fit. */
function render(value: Code, indent: number, prefixLen: number): string {
  const pad = " ".repeat(indent);
  if (value !== null && typeof value === "object" && "call" in (value as object)) {
    const text = (value as { call: string }).call;
    if (prefixLen + text.length <= WIDTH) return text;
    const open = text.indexOf("(");
    const args = text.slice(open + 1, -1);
    return `${text.slice(0, open)}(\n${pad}  ${args},\n${pad})`;
  }
  if (typeof value === "string") return quote(value);
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => render(v, indent + 2, indent + 2));
    const flat = `[${items.join(", ")}]`;
    if (!items.some((i) => i.includes("\n")) && prefixLen + flat.length <= WIDTH) return flat;
    const lines = value.map((v) => `${pad}  ${render(v, indent + 2, indent + 2)},`);
    return `[\n${lines.join("\n")}\n${pad}]`;
  }
  const lines = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
    const head = `${pad}  ${key(k)}: `;
    const body = render(v, indent + 2, head.length);
    // A string that does not fit moves to its own line, as the formatter does.
    if (typeof v === "string" && head.length + body.length + 1 > WIDTH) {
      return `${pad}  ${key(k)}:\n${pad}    ${body},`;
    }
    return `${head}${body},`;
  });
  return `{\n${lines.join("\n")}\n${pad}}`;
}

/** The pack's `index.ts` lines that register a module. */
export function indexLines(rule: Pick<Rule, "id">): { importLine: string; listEntry: string } {
  const name = exportName(rule.id);
  return {
    importLine: `import { ${name} } from "./${fileStem(rule.id)}.js";`,
    listEntry: `  ${name},`,
  };
}

/** The library module for a checked, filled-in rule. */
export function renderRuleModule(rule: Rule): string {
  const helpers = new Set<string>();
  const asCode = (fixtures: readonly Fixture[]): Code[] =>
    fixtures.map((f) => {
      const c = fixtureCall(f, helpers);
      return c === undefined ? f : { call: c };
    });
  const body = {
    id: rule.id,
    category: rule.category,
    severity: rule.severity,
    defaultAction: rule.defaultAction,
    ...(rule.owasp !== undefined ? { owasp: rule.owasp } : {}),
    title: rule.title,
    description: rule.description,
    match: rule.match,
    fixtures: { block: asCode(rule.fixtures.block), allow: asCode(rule.fixtures.allow) },
  };
  const imports = [
    ...(helpers.size > 0
      ? [`import { ${[...helpers].sort().join(", ")} } from "../../fixtures.js";`]
      : []),
    `import type { Rule } from "../../schema.js";`,
  ];
  return `${imports.join("\n")}\n\nexport const ${exportName(rule.id)}: Rule = ${render(body, 0, 0)};\n`;
}
