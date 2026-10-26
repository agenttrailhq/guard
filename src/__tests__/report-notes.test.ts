/**
 * The verified notes on the page: in each row's expander, in the data block and `--review`,
 * never in the share text, styled for both themes and print, and carrying no value.
 */

import { describe, expect, it } from "vitest";
import { renderReport, reportPayload, reviewStrings, shareText } from "../core/report.js";
import { REPORT_STYLES } from "../core/report-brand.js";
import { UNCONFIRMED_SENTENCE } from "../core/verify/cards.js";
import { NOTE_COULD_NOT_CHECK, NOTE_KINDS, type NoteKindName } from "../core/verify/notes.js";
import { decodedSurfaces, decodeEntities } from "./html-text.js";
import {
  checked,
  DESTRUCTIVE_FACTS,
  EGRESS_FACTS,
  notesResult,
  notesVerification,
  pageVerification,
  TONE_BUILDERS,
} from "./notes-corpus.js";
import { SECRETS_ACT, SECRETS_CLEAN, VERIFIED_META } from "./verified-corpus.js";

const RESULT = notesResult(pageVerification());
const OPTIONS = { cardBuilders: TONE_BUILDERS } as const;
const payload = reportPayload(RESULT, VERIFIED_META, TONE_BUILDERS);

/** One finding row's markup, by its guardrail id. */
function row(html: string, ruleId: string): string {
  const at = html.indexOf(`<code>${ruleId}</code>`);
  expect(at, ruleId).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<li class="finding"', at);
  // A row closes on a line of its own; the shapes inside it close on theirs.
  return html.slice(start, html.indexOf("\n</li>", at));
}

/** The expander that lists a row's command shapes. */
function commands(rowHtml: string): string {
  const start = rowHtml.indexOf('<details class="commands">');
  return rowHtml.slice(start, rowHtml.indexOf("</details>", start));
}

describe("the notes on the page corpus", () => {
  const notes = new Map((payload.notes ?? []).map((n) => [n.ruleId, n.sentence]));

  it("a printed credential, a check that could not finish and one that could not confirm", () => {
    expect(notes.get("se.env-print")?.text).toBe(
      "Likely-real credentials printed by a command: 1.",
    );
    expect(notes.get("wt.stash-drop")?.template).toBe(NOTE_COULD_NOT_CHECK.id);
    expect(notes.get("ti.test-file-delete")?.template).toBe(UNCONFIRMED_SENTENCE.id);
  });

  it("no note for a rule the table leaves out, or for a guardrail the user wrote", () => {
    expect(notes.has("ps.persistence")).toBe(false);
    expect(notes.has("wt.reset-hard")).toBe(false);
    expect(RESULT.findings.find((f) => f.ruleId === "wt.reset-hard")?.source).toBe("yours");
  });

  it("a note from a check's facts appears exactly when the report carries those facts", () => {
    // The report's boundary drops every fact key that is not registered, and carries the
    // dependency facts only where it copies them, so a note is read from what is carried. A
    // check whose keys are not registered in a build gives no note there.
    const carried = payload.verification as unknown as {
      readonly categories: Readonly<Record<string, { readonly facts?: unknown }>>;
      readonly dependencies?: unknown;
    };
    const cases: readonly [string, NoteKindName, unknown, string][] = [
      [
        "dd.rm-rf-absolute",
        "rm-targets",
        carried.categories.destructive?.facts,
        "Mostly scratch, temp or build folders. No tracked file is missing. 1 target held untracked files in a repo.",
      ],
      [
        "ex.file-upload",
        "uploads",
        carried.categories.egress?.facts,
        "False positive: the 3 upload-shaped calls that ran went to this machine or LocalStack.",
      ],
      [
        "flag-dependency-install",
        "installs",
        carried.dependencies,
        "2 package installs ran, not counting 3 lockfile restores. Package age is not checked: the scan runs offline.",
      ],
    ];
    for (const [id, kind, facts, text] of cases) {
      const holds = Object.values(NOTE_KINDS[kind].reads).every((read) => {
        if (!Array.isArray(read)) return false;
        let node: unknown = facts;
        for (const key of read as readonly string[]) {
          if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return false;
          node = (node as Readonly<Record<string, unknown>>)[key];
        }
        return typeof node === "number";
      });
      expect(notes.get(id)?.text, id).toBe(holds ? text : undefined);
    }
  });
});

describe("where a note is shown", () => {
  const html = renderReport(RESULT, VERIFIED_META, OPTIONS);

  it("first in its row's command expander, which says it holds one", () => {
    const r = row(html, "se.env-print");
    const expander = commands(r);
    expect(expander).toMatch(
      /^<details class="commands"><summary>The command shape behind it, and what checking found<\/summary>\n<div class="verified-note v-act"><p class="verified-note-label">What checking found on this machine<\/p>\n<p data-template="note\.secrets-printed">Likely-real credentials printed by a command: 1\.<\/p><\/div>\n<ul class="shapes">/,
    );
  });

  it("a note that could not confirm takes the neutral mark, not its card's tone", () => {
    expect(commands(row(html, "ti.test-file-delete"))).toContain(
      '<div class="verified-note v-could-not-check">',
    );
    expect(commands(row(html, "wt.stash-drop"))).toContain(
      '<div class="verified-note v-could-not-check">',
    );
  });

  it("a row with no note is as it was", () => {
    const r = row(html, "ps.persistence");
    expect(r).not.toContain("verified-note");
    expect(r).toContain("<summary>The command shape behind it</summary>");
  });

  it("the artifact shows the same notes", () => {
    const artifact = renderReport(RESULT, VERIFIED_META, { ...OPTIONS, variant: "artifact" });
    expect(commands(row(artifact, "se.env-print"))).toBe(commands(row(html, "se.env-print")));
  });

  it("the data block carries the notes", () => {
    const data = decodedSurfaces(html).data.split("\n");
    expect(data).toContain("notes");
    expect(data).toContain("Likely-real credentials printed by a command: 1.");
  });

  it("--review lists each note after its guardrail's id", () => {
    const lines = reviewStrings(RESULT, TONE_BUILDERS).flatMap((g) => g.lines);
    expect(lines).toContain("se.env-print  Likely-real credentials printed by a command: 1.");
    for (const note of payload.notes ?? []) {
      expect(lines).toContain(`${note.ruleId}  ${note.sentence.text}`);
    }
  });

  it("the share text never carries a note", () => {
    const share = shareText(RESULT);
    expect(payload.shareText).toBe(share);
    for (const note of payload.notes ?? []) {
      expect(share).not.toContain(note.sentence.text);
      expect(share).not.toContain("checking found");
    }
    const at = html.indexOf('id="share"');
    const section = html.slice(at, html.indexOf("</section>", at));
    expect(section).not.toContain("verified-note");
    expect(decodeEntities(section)).not.toContain("printed by a command");
  });

  it("a scan with no verification shows no note and carries none", () => {
    const plain = notesResult(undefined);
    expect(reportPayload(plain, VERIFIED_META).notes).toBeUndefined();
    expect(renderReport(plain, VERIFIED_META)).not.toContain('class="verified-note');
  });

  it("a verification with no note to give carries no notes field", () => {
    const quiet = notesResult(
      notesVerification({
        secrets: checked("clean", SECRETS_CLEAN),
        "lost-work": { status: "not-checked" },
        tests: { status: "not-checked" },
      }),
    );
    expect(reportPayload(quiet, VERIFIED_META, TONE_BUILDERS).notes).toBeUndefined();
  });
});

describe("how a note looks", () => {
  const rule = (selector: string): string => {
    const at = REPORT_STYLES.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return REPORT_STYLES.slice(at, REPORT_STYLES.indexOf("}", at));
  };

  it("is marked by a left border the tone classes color, set before them so they win", () => {
    expect(rule(".verified-note")).toContain("border-left: 3px solid var(--tone-none-fg)");
    expect(REPORT_STYLES.indexOf(".verified-note {")).toBeLessThan(
      REPORT_STYLES.indexOf(".v-act {"),
    );
  });

  it("is in sentence case, with no all-caps label", () => {
    for (const selector of [".verified-note", ".verified-note-label", ".verified-note p"]) {
      expect(rule(selector)).not.toMatch(/text-transform|letter-spacing/);
    }
  });

  it("uses theme colors only, so it follows both themes", () => {
    for (const selector of [".verified-note", ".verified-note-label"]) {
      expect(rule(selector)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    }
  });

  it("prints whole and in its colors", () => {
    const print = REPORT_STYLES.slice(REPORT_STYLES.indexOf("@media print"));
    expect(print).toMatch(
      /\.verified-note \{ break-inside: avoid; \}|\.verified-note[^{]*\{ break-inside: avoid; \}/,
    );
    expect(print).toMatch(
      /\.verified-note \{ print-color-adjust: exact;|\.verified-note[^{]*\{ print-color-adjust: exact;/,
    );
  });
});

describe("no value reaches the page through a note", () => {
  const CANARY = `CANARY${"page"}`;
  const hostile = notesResult(
    notesVerification({
      secrets: checked("act", {
        ...SECRETS_ACT,
        host: `${CANARY}.example.com`,
        [`${CANARY}-key`]: 1,
      }),
      destructive: checked("clean", {
        ...DESTRUCTIVE_FACTS,
        rm: { ...DESTRUCTIVE_FACTS.rm, targets: `${CANARY}/Users/sample/project` },
      }),
      egress: checked("clean", { ...EGRESS_FACTS, processCheck: CANARY, path: CANARY }),
    }),
  );

  it("health: the hostile scan still has notes", () => {
    expect(reportPayload(hostile, VERIFIED_META, TONE_BUILDERS).notes?.length).toBeGreaterThan(0);
  });

  it.each(["document", "artifact"] as const)("in no decoded form of the %s", (variant) => {
    const html = renderReport(hostile, VERIFIED_META, { ...OPTIONS, variant });
    for (const [surface, text] of Object.entries(decodedSurfaces(html))) {
      expect(text, surface).not.toContain(CANARY);
    }
  });

  it("not in --review", () => {
    const lines = reviewStrings(hostile, TONE_BUILDERS).flatMap((g) => g.lines);
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("negative control: the same search finds a canary that is on the page", () => {
    const html = renderReport(hostile, VERIFIED_META, OPTIONS).replace(
      "What checking found on this machine",
      `What checking found on this machine ${CANARY}`,
    );
    expect(decodedSurfaces(html).text).toContain(CANARY);
  });
});
