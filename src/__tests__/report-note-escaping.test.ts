/**
 * A finding's verified note is written as text, whatever it holds.
 *
 * Notes are made from counts and fixed phrases, so no real note carries markup. This file puts
 * one there: it replaces `verifiedNotes` with a TEST-ONLY one that gives every finding a note
 * of markup, quotes and a closing script tag, so the page's note slot is shown to escape it,
 * as `report-verified-escaping.test.ts` shows for the cards and chips.
 */

import { describe, expect, it, vi } from "vitest";
import { renderReport } from "../core/report.js";
import { notesResult, pageVerification, TONE_BUILDERS } from "./notes-corpus.js";
import { VERIFIED_META } from "./verified-corpus.js";

/** Markup, quotes and a script, built here so no source line spells a working tag. */
const OPEN = "<";
const HOSTILE = `${OPEN}/span>${OPEN}script>hostile()${OPEN}/script>${OPEN}b>bold${OPEN}/b> & "quoted"`;

vi.mock("../core/verify/notes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/verify/notes.js")>();
  return {
    ...actual,
    // TEST-ONLY: a note of hostile text for every finding.
    verifiedNotes: (findings: readonly { readonly ruleId: string }[]) =>
      findings.map((finding) => ({
        ruleId: finding.ruleId,
        category: "destructive",
        outcome: "found",
        sentence: { template: "test-only.hostile-note", text: HOSTILE },
      })),
  };
});

const HTML = renderReport(notesResult(pageVerification()), VERIFIED_META, {
  cardBuilders: TONE_BUILDERS,
});

/** The page without its data block, which is JSON and escapes on its own terms. */
const markup = HTML.replace(
  /<script type="application\/json" id="report-data">[\s\S]*?<\/script>/,
  "",
);

describe("a verified note's text is escaped", () => {
  it("the hostile note reached the page, in a note slot", () => {
    expect(markup).toContain(
      '<span data-template="test-only.hostile-note">&lt;/span&gt;&lt;script&gt;hostile()',
    );
  });

  it.each([
    ["a span closed early", /test-only\.hostile-note">\s*<\/span><script>/],
    ["a script", /<script>hostile\(\)/],
    ["an element", /<b>bold<\/b>/],
  ])("leaves no %s", (_name, pattern) => {
    expect(markup).not.toMatch(pattern);
  });

  it("carries exactly two script elements: the data block and the page script", () => {
    expect(HTML.split("<script").length - 1).toBe(2);
  });
});
