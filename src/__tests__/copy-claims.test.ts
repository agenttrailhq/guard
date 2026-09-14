/**
 * Every shipped surface that claims "no network" must qualify it.
 *
 * > "**Every shipped surface claiming 'no network' must be qualified**, including
 * > `package.json`'s description (the npm listing) and the plugin manifest (the
 * > marketplace listing). An unqualified claim beside an opt-in transmitter is the
 * > kind of thing a security audience finds and posts about."
 *
 * ── Why this is a test and not a checklist ──────────────────────────────────
 * Copy sweeps done by hand miss the file nobody remembered. This one is GREPPED: it
 * walks the shipped surfaces, finds every claim, and requires each to be qualified.
 * A fifth surface added later fails here rather than in a Show HN thread.
 *
 * The `package.json` and `plugin.json` strings in particular are published — one to
 * npm, one to the Claude Code marketplace — so they are read far more often than the
 * README by exactly the people most likely to check.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runRules } from "../commands/rules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");

/**
 * The user-facing surfaces. Each MUST state the claim, and must qualify it — these
 * are the npm listing, the Claude Code marketplace listing, and the front page of
 * the public repo, which is where a sceptic looks first.
 */
const MUST_CLAIM = [
  join(PKG_ROOT, "package.json"),
  join(PKG_ROOT, "plugin", ".claude-plugin", "plugin.json"),
  join(PKG_ROOT, "README.md"),
];

/**
 * Source files a reader of the public repo will also see. They need not make the
 * claim at all — but if they do, it must be qualified, on the same terms. `io.ts` is
 * here because it is where someone looks to check whether there is a transport.
 */
const QUALIFY_IF_CLAIMED = [
  ...MUST_CLAIM,
  join(PKG_ROOT, "src", "io.ts"),
  // Added with `scan`, and the docblock's own reasoning is why: "copy sweeps done by
  // hand miss the file nobody remembered". These three are user-facing SHIPPED TEXT,
  // not internal prose — `--help`, `scan --help`, and the HTML report's own header.
  // The report is the most-read of the lot: it is designed to be posted in public, and
  // an unqualified claim beside an opt-in transmitter is precisely what a security
  // audience finds and quotes.
  join(PKG_ROOT, "src", "cli.ts"),
  join(PKG_ROOT, "src", "commands", "scan.ts"),
  join(PKG_ROOT, "src", "core", "report.ts"),
];

/** A claim about not touching the network. */
const CLAIM = /no network|makes no network calls|sends us nothing|no server/gi;

/** Wording that qualifies such a claim. */
const QUALIFIER =
  /crash report|out of the box|off by default|off unless|one exception|only network/i;

/** The sentence-ish window a qualifier must appear within. */
const WINDOW = 400;

describe("no unqualified 'no network' claim ships", () => {
  it.each(
    QUALIFY_IF_CLAIMED.map((f) => [f.replace(`${PKG_ROOT}/`, ""), f] as const),
  )("%s qualifies every claim it makes", (_label, file) => {
    const text = readFileSync(file, "utf8");
    const unqualified: string[] = [];
    for (const m of text.matchAll(CLAIM)) {
      const at = m.index ?? 0;
      const around = text.slice(Math.max(0, at - WINDOW), at + WINDOW);
      if (!QUALIFIER.test(around)) unqualified.push(m[0]);
    }
    expect(unqualified).toEqual([]);
  });

  it("the sweep is not vacuous — the user-facing surfaces DO make such claims", () => {
    // Without this, deleting every claim would pass the suite above, and so would a
    // typo in the CLAIM regex. Applied to the three surfaces that must carry it;
    // a source file is free to say nothing.
    for (const file of MUST_CLAIM) {
      const hits = [...readFileSync(file, "utf8").matchAll(CLAIM)];
      expect(hits.length, `${file} makes no claim at all — did the regex rot?`).toBeGreaterThan(0);
    }
  });

  it("the qualifier check can actually fail", () => {
    // Proves the assertion has teeth, rather than passing because QUALIFIER matches
    // everything. Rule 17: a guard nobody has seen fail is not known to work.
    const bad = "The guard makes no network calls. Nothing else is said anywhere nearby.";
    const hits = [...bad.matchAll(CLAIM)].filter((m) => {
      const at = m.index ?? 0;
      return !QUALIFIER.test(bad.slice(Math.max(0, at - WINDOW), at + WINDOW));
    });
    expect(hits.length).toBeGreaterThan(0);
  });
});

/**
 * The same sweep, for PRIVACY claims.
 *
 * ── Why the qualifier list is what it is ────────────────────────────────────
 * A privacy claim is accurate when the reader is told which half is absolute and which
 * is not. Paths are structural, so "appears nowhere" is a total rule and stays. Names
 * are not: the identifier redactor is a deny-list over a fixed list of tools and cannot
 * be proved complete. So a claim about names is only allowed beside wording that says
 * so — "not a guarantee", "deny-list", "may survive", "weaker claim" — or beside the
 * review step that lets a reader check for themselves.
 */

/** A claim that the artifact contains none of something identifying. */
const PRIVACY_CLAIM =
  /appears? nowhere|nowhere in (?:it|this file|the file)|never (?:as )?names?|nothing identifying|(?:fully|completely|entirely) (?:redacted|anonymous|anonymized)|no (?:project|client|customer|container|identifying)[a-z ]{0,14}names?/gi;

/** Wording that qualifies such a claim. */
const PRIVACY_QUALIFIER =
  /not a guarantee|not complete|deny-list|may survive|can survive|weaker claim|scrubbed, not sanitized|read (?:it|them|the findings|the commands)\s+(?:above\s+)?before|--review|scan --review/i;

/**
 * The surfaces that MUST make a privacy claim — deliberately not `MUST_CLAIM`.
 *
 * `package.json` and `plugin.json` are a one-line npm and marketplace description; the
 * "no network" claim belongs there and a paragraph about identifier redaction does not.
 * The two that must carry it are the README, where a privacy-conscious reader looks
 * first, and `core/report.ts`, which is the artifact being shared and therefore the one
 * place the claim is read by someone who did not run the tool.
 */
const MUST_CLAIM_PRIVACY = [
  join(PKG_ROOT, "README.md"),
  join(PKG_ROOT, "src", "core", "report.ts"),
];

describe("no unqualified privacy claim ships", () => {
  it.each(
    QUALIFY_IF_CLAIMED.map((f) => [f.replace(`${PKG_ROOT}/`, ""), f] as const),
  )("%s qualifies every privacy claim it makes", (_label, file) => {
    const text = readFileSync(file, "utf8");
    const unqualified: string[] = [];
    for (const m of text.matchAll(PRIVACY_CLAIM)) {
      const at = m.index ?? 0;
      const around = text.slice(Math.max(0, at - WINDOW), at + WINDOW);
      if (!PRIVACY_QUALIFIER.test(around)) unqualified.push(m[0]);
    }
    expect(unqualified).toEqual([]);
  });

  it("the sweep is not vacuous — the README and the report DO make such claims", () => {
    // Without this, deleting every privacy claim would pass the suite above, and so
    // would a typo in PRIVACY_CLAIM. This is the check that would have caught the
    // regression the other way: a rewrite that removed the claim rather than fixing it.
    for (const file of MUST_CLAIM_PRIVACY) {
      const hits = [...readFileSync(file, "utf8").matchAll(PRIVACY_CLAIM)];
      expect(
        hits.length,
        `${file} makes no privacy claim at all — did the regex rot?`,
      ).toBeGreaterThan(0);
    }
  });

  it("the qualifier check can actually fail — on the exact sentence that shipped", () => {
    // Not an invented fixture: this is verbatim what `core/report.ts` and the README
    // once said. If this stops being flagged, the gate has stopped working against the
    // one string it was built for.
    const bad =
      "Project names, working directories and file paths appear nowhere in this file. " +
      "Only the count of projects does.";
    const hits = [...bad.matchAll(PRIVACY_CLAIM)].filter((m) => {
      const at = m.index ?? 0;
      return !PRIVACY_QUALIFIER.test(bad.slice(Math.max(0, at - WINDOW), at + WINDOW));
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("and it PASSES the same sentence once it is qualified — the other half of the teeth", () => {
    // A gate that flags everything is as useless as one that flags nothing. This proves
    // the qualifier is what makes the difference, not the claim's absence.
    const good =
      "Working directories and file paths appear nowhere in this file. Identifying " +
      "names are a weaker claim: redaction is thorough but not a guarantee.";
    const hits = [...good.matchAll(PRIVACY_CLAIM)].filter((m) => {
      const at = m.index ?? 0;
      return !PRIVACY_QUALIFIER.test(good.slice(Math.max(0, at - WINDOW), at + WINDOW));
    });
    expect(hits.length).toBe(0);
  });
});

/** README text with wrapping and markdown emphasis flattened, for claim checks. */
function flat(markdown: string): string {
  return markdown.replace(/\*\*/g, "").replace(/\s+/g, " ");
}

describe("the README documents the file the guard keeps", () => {
  it("documents the crashes directory and says deleting it is safe", () => {
    // A privacy-conscious reader will look for this file, so it must be documented.
    //
    // Asserted on MEANING rather than on one spelling of the path: the README lists
    // the files under a shared `~/.agenttrail/guard/` heading, so pinning the
    // fully-qualified string would break on a purely editorial change while a file
    // going undocumented would still slip through.
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    expect(readme).toContain("~/.agenttrail/guard/");
    expect(readme).toMatch(/`crashes\/`/);
    expect(readme).toMatch(/deleting the\s+directory is always safe/);
  });

  it("documents events.jsonl: what it holds, that it stays put, and how to clear it", () => {
    // Four claims, because the file is only defensible with all four. Whitespace-normalized,
    // so a re-wrap of the paragraph cannot break a claim check. Markdown emphasis is
    // stripped for the same reason.
    const readme = flat(readFileSync(join(PKG_ROOT, "README.md"), "utf8"));
    expect(readme).toMatch(/`events\.jsonl`/);
    expect(readme).toMatch(/never leaves your machine/i);
    expect(readme).toMatch(/scrubbed before it is written/i);
    expect(readme).toMatch(/--clear-history/);
    expect(readme).toMatch(/deleting the file outright is always safe/i);
    expect(readme).toMatch(/1 MiB/);
    expect(readme).toMatch(/30 days/);
  });

  it("does not claim the guard redacts nothing", () => {
    // Commands ARE scrubbed, at write. A README that said otherwise would understate the
    // product in the one place a security reader looks.
    const readme = flat(readFileSync(join(PKG_ROOT, "README.md"), "utf8"));
    expect(readme).not.toMatch(/does not redact secrets from anything it reads/i);
    expect(readme).not.toMatch(/Scrubbing lands with the `scan` report/i);
  });

  it("both documented limits sit UNDER 'What the guard does not do'", () => {
    // Asserted by SECTION, not by file. Either limit could be stated somewhere
    // truthful-but-buried — a parenthetical under "Files it keeps" — and a
    // whole-file `toContain` would pass while a reader looking for what the tool
    // does not guarantee never found it.
    const raw = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    const start = raw.indexOf("## What the guard does not do");
    expect(start).toBeGreaterThan(-1);
    const next = raw.indexOf("\n## ", start + 1);
    const section = flat(raw.slice(start, next === -1 ? undefined : next));

    // The scrubber's coverage gap: an assignment-anchored pattern cannot see a
    // secret passed as a bare argument.
    expect(section).toMatch(/bare command-line argument/i);
    expect(section).toMatch(/scrubbed, not sanitized/i);
    // The age bound's residual: enforced at compaction, so a quiet machine keeps
    // its last half-megabyte past 30 days.
    expect(section).toMatch(/ceiling, not a sweep/i);
    expect(section).toMatch(/status --clear-history/);
  });

  it("states both halves: off unless enabled, AND stack traces only", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/off unless you turn it on/i);
    expect(readme).toMatch(/stack traces only/i);
    expect(readme).toMatch(/no commands, no file contents, no environment/i);
  });
});

/**
 * The README carries a VERBATIM copy of the `guardrails` usage table.
 *
 * That copy is the thing a person reads before they type anything, so a stale one
 * teaches a command that does not exist. A change to the command names or the column
 * alignment goes in one place and not the other, so the two are pinned together here.
 *
 * Compared against the STRING THE COMMAND PRINTS, not against a literal in this
 * file: a third copy would drift the same way the second one does.
 */
describe("the README's usage table is the one the CLI prints", () => {
  it("matches line for line, including the column alignment", async () => {
    const printed: string[] = [];
    await runRules(["--help"], {
      writeStdout: (t) => printed.push(t),
      readFile: () => undefined,
      exists: () => true,
      writeFileAtomic: () => {},
      homedir: () => "/home/test",
      runClaude: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    // The table rows, de-indented by the two spaces the terminal form carries.
    const rows = printed
      .join("")
      .split("\n")
      .filter((l) => l.startsWith("  guardrails "))
      .map((l) => l.slice(2));
    expect(rows).toHaveLength(9);

    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    expect(readme).toContain(`\n\`\`\`\n${rows.join("\n")}\n\`\`\`\n`);
  });
});
