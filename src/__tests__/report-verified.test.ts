// cspell:words describedby labelledby UNREGISTEREDFACTCANARY
/**
 * The verified lead on the page: "What it found, never the values", the "Also checked on this
 * machine" chips, and the nine cards of "What actually happened".
 *
 * Rendered from the synthetic verified corpus (`verified-corpus.ts`): the real secrets card, and
 * test-only cards for the categories with no check in this build.
 */

import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  FIXES_FILENAME,
  MAX_ROWS,
  renderJson,
  renderReport,
  reportPayload,
  reviewStrings,
} from "../core/report.js";
import { reportStyles } from "../core/report-brand.js";
import { REPORT_SCRIPT } from "../core/report-script.js";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import { hidingFormLabel, TONE_ORDER, UNCONFIRMED_SENTENCE } from "../core/verify/cards.js";
import {
  CATEGORY_TITLES,
  CHIP_CANDIDATES,
  CHIP_COUNT,
  CODEX_UNVERIFIED_TEXT,
  chipText,
  KIND_LABELS,
  PROVENANCE_PHRASES,
  TONE_LABELS,
} from "../core/verify/copy.js";
import {
  HIDING_FORMS,
  SECRET_KINDS,
  VERIFY_CATEGORIES,
  type Verification,
  type VerifyCategory,
} from "../core/verify/types.js";
import { decodeEntities } from "./html-text.js";
import {
  checked,
  DESTRUCTIVE_FACTS,
  LOST_WORK_FACTS,
  notesVerification,
  SKIPPED_FACTS,
} from "./notes-corpus.js";
import {
  baseResult,
  CLOUD_LEAD_RESULT,
  CODEX_ONLY_RESULT,
  CURSOR_RESULT,
  FALLBACK_RESULT,
  HIDING_RESULT,
  LOCAL_FIX_CATEGORIES,
  SECRETS_ACT,
  SECRETS_CLEAN,
  TEST_ONLY_BUILDERS,
  testFacts,
  VERIFIED_META,
  VERIFIED_RESULT,
  verification,
  verifiedCategories,
} from "./verified-corpus.js";

const OPTIONS = { cardBuilders: TEST_ONLY_BUILDERS, localFixCategories: LOCAL_FIX_CATEGORIES };
const HTML = renderReport(VERIFIED_RESULT, VERIFIED_META, OPTIONS);
const ARTIFACT = renderReport(VERIFIED_RESULT, VERIFIED_META, { ...OPTIONS, variant: "artifact" });

/** One section's markup, by id. */
function section(html: string, id: string): string {
  const at = html.indexOf(`id="${id}"`);
  const start = html.lastIndexOf("<section", at);
  return html.slice(start, html.indexOf("</section>", at) + "</section>".length);
}

/** The cards of a page, in page order: category and tone. */
function cardsOf(html: string): { category: string; tone: string }[] {
  return [...html.matchAll(/<article class="card verified v-([a-z-]+)" id="check-([a-z-]+)"/g)].map(
    (m) => ({ tone: m[1] ?? "", category: m[2] ?? "" }),
  );
}

/** One card's markup. */
function card(html: string, category: VerifyCategory): string {
  const at = html.indexOf(`id="check-${category}"`);
  return html.slice(html.lastIndexOf("<article", at), html.indexOf("</article>", at));
}

/** The chips of a page: target, title and text. */
function chipsOf(html: string): { href: string; title: string; text: string }[] {
  return [
    ...section(html, "also-checked").matchAll(
      /<a class="check-chip v-[a-z-]+" href="([^"]+)"><span class="chip-title">([^<]*)<\/span><span class="chip-text"[^>]*>([^<]*)<\/span><\/a>/g,
    ),
  ].map((m) => ({ href: m[1] ?? "", title: m[2] ?? "", text: m[3] ?? "" }));
}

/** Every id in a page. */
const idsOf = (html: string): Set<string> =>
  new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""));

describe("the verified sections sit where the lead belongs", () => {
  it("hero, never-the-values, chips, numbers, cards, then what the guardrails would have done", () => {
    const order = [
      'id="overview"',
      'id="found"',
      'id="also-checked"',
      'class="stats"',
      'id="what-happened"',
      'id="would-do"',
      'id="fix-first"',
    ].map((part) => HTML.indexOf(part));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("the top bar links to the cards", () => {
    expect(HTML).toContain('<li><a href="#what-happened">What happened</a></li>');
  });
});

describe("What it found, never the values", () => {
  const found = section(HTML, "found");

  it("lists each likely-real credential by kind, how it got there and in how many files", () => {
    const rows = [
      ...found.matchAll(
        /<li><span class="evidence-kind">([^<]*)<\/span><span class="evidence-how">([^<]*)<\/span><span class="times">([^<]*)<\/span><\/li>/g,
      ),
    ].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual([
      ["GitHub token", "you pasted it into a prompt", "in 4 transcript files"],
      ["AWS access key", "printed by a command", "in 2 transcript files"],
      ["A named secret", "typed into a command, in an agent reply", "in 1 transcript file"],
    ]);
  });

  it("every kind and every way in has a label, and there are exactly four ways in", () => {
    for (const kind of SECRET_KINDS) expect(KIND_LABELS[kind]).toMatch(/^[A-Z][A-Za-z -]+$/);
    expect(Object.values(PROVENANCE_PHRASES)).toEqual([
      "you pasted it into a prompt",
      "typed into a command",
      "printed by a command",
      "in an agent reply",
    ]);
  });

  it("is capped at the row cap, and says how many more there are", () => {
    const many = {
      ...SECRETS_ACT,
      items: Array.from({ length: MAX_ROWS + 4 }, () => SECRETS_ACT.items[0]!),
      moreItems: 2,
    };
    const v = verification({
      ...verifiedCategories(),
      secrets: { status: "act", matches: 60, facts: many },
    });
    const html = renderReport(baseResult(v), VERIFIED_META, OPTIONS);
    const rows = section(html, "found").split('<span class="evidence-kind">').length - 1;
    expect(rows).toBe(MAX_ROWS);
    expect(section(html, "found")).toContain("And 6 more likely-real credentials.");
  });

  it("is left out when nothing is likely real", () => {
    expect(CLOUD_LEAD_RESULT.verification?.categories.secrets.facts.items).toEqual([]);
    const html = renderReport(CLOUD_LEAD_RESULT, VERIFIED_META, OPTIONS);
    expect(html).not.toContain('id="found"');
    expect(html).toContain('id="also-checked"');
  });

  it("the secrets card says how many placeholders were set aside, and why, as part of them", () => {
    expect(card(HTML, "secrets")).toContain(
      "Of the placeholders or false positives, 3 were set aside by a rule that can miss a real credential: 2 unnamed and seen only in output or replies, and 1 named but not shaped like a credential.",
    );
    // The boundary copy keeps the typed counts, so the page is built from them.
    const facts = reportPayload(VERIFIED_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS).verification
      ?.categories.secrets.facts;
    expect(facts?.setAside).toEqual({ unnamedOutputOnly: 2, namedNotCredentialShaped: 1 });
  });

  it("links to the secrets card", () => {
    expect(found).toContain('<a href="#check-secrets">');
  });
});

describe("Also checked on this machine", () => {
  it("shows six chips, zeros included, leaving out the headline's category", () => {
    const chips = chipsOf(HTML);
    expect(chips).toHaveLength(CHIP_COUNT);
    expect(chips.map((c) => c.href)).toEqual(
      CHIP_CANDIDATES.filter((c) => c !== "secrets").map((c) => `#check-${c}`),
    );
    expect(chips.map((c) => c.text)).toContain("0 production databases touched");
    expect(chips.map((c) => c.text)).toContain("0 files sent off this machine");
  });

  it("each chip links to its card, which exists, and carries its title", () => {
    const ids = idsOf(HTML);
    for (const chip of chipsOf(HTML)) {
      const category = chip.href.slice("#check-".length) as VerifyCategory;
      expect(ids.has(`check-${category}`), chip.href).toBe(true);
      expect(chip.title).toBe(CATEGORY_TITLES[category]);
    }
  });

  it("a different headline frees its chip for the next candidate", () => {
    const chips = chipsOf(renderReport(CLOUD_LEAD_RESULT, VERIFIED_META, OPTIONS));
    expect(chips.map((c) => c.href)).toEqual(
      CHIP_CANDIDATES.filter((c) => c !== "cloud")
        .map((c) => `#check-${c}`)
        .slice(0, CHIP_COUNT),
    );
  });

  it("a category with no check, or a failed one, says so instead of a zero", () => {
    const v = verification({
      ...verifiedCategories(),
      "prod-infra": { status: "not-checked" },
      egress: { status: "could-not-check", matches: 1, facts: {} },
    } as unknown as Verification["categories"]);
    const chips = chipsOf(renderReport(baseResult(v), VERIFIED_META, OPTIONS));
    expect(chips.find((c) => c.href === "#check-prod-infra")?.text).toBe("not checked");
    expect(chips.find((c) => c.href === "#check-egress")?.text).toBe("could not check");
  });

  it("says what a count counts: commands that ran, with mentions and unconfirmed calls left out", () => {
    const notes = section(HTML, "also-checked");
    expect(notes).toContain("Checked against command output");
    expect(notes).toContain("4 matches only mentioned a command");
    expect(notes).toContain("1 matched call had no recorded output");
    expect(notes).not.toContain("record no command output");
  });

  it("on an app that records no command output, says nothing could be confirmed as run", () => {
    const cursor = {
      ...baseResult(
        verification(verifiedCategories(), { resultsRecorded: false, ranEvidence: "none" }),
      ),
      agent: "cursor" as const,
    };
    const notes = section(renderReport(cursor, VERIFIED_META, OPTIONS), "also-checked");
    expect(notes).toContain("These sessions record no command output");
    expect(notes).toContain("not because nothing ran");
    expect(notes).not.toContain("Checked against command output");
  });

  it("on Codex, says a call with an output record may have been blocked", () => {
    const codex = {
      ...baseResult(verification(verifiedCategories(), { ranEvidence: "output-record" })),
      agent: "codex" as const,
    };
    expect(section(renderReport(codex, VERIFIED_META, OPTIONS), "also-checked")).toContain(
      "A Codex call counted as ran may be one a hook blocked",
    );
    expect(section(HTML, "also-checked")).not.toContain("hook blocked");
  });
});

describe("What actually happened", () => {
  it("shows all nine cards, act first, then review, clean, could not check and not checked", () => {
    const cards = cardsOf(HTML);
    expect(cards.map((c) => c.category).sort()).toEqual([...VERIFY_CATEGORIES].sort());
    const tones = cards.map((c) => TONE_ORDER.indexOf(c.tone as never));
    expect([...tones].sort((a, b) => a - b)).toEqual(tones);
    expect(cards.map((c) => `${c.tone}:${c.category}`)).toEqual([
      "act:secrets",
      "act:skipped-checks",
      "act:lost-work",
      "review:cloud",
      "clean:prod-infra",
      "clean:destructive",
      "clean:egress",
      "could-not-check:tests",
      "not-checked:unreviewed",
    ]);
  });

  it("each card has its tone, title and the three fields, named for assistive technology", () => {
    const secrets = card(HTML, "secrets");
    expect(secrets).toContain(
      `<span class="tone tone-act" id="check-secrets-tone">${TONE_LABELS.act}</span>`,
    );
    // Secrets counts distinct credential-shaped values, not guardrail matches.
    expect(secrets).toContain(
      '<span class="times" data-template="secrets.count">11 credential-shaped values</span>',
    );
    expect(card(HTML, "lost-work")).toContain(
      '<span class="times" data-template="card.count">3 matches</span>',
    );
    expect(secrets).toContain('aria-labelledby="check-secrets-title"');
    expect(secrets).toContain('<h3 id="check-secrets-title">Secrets in transcripts</h3>');
    for (const field of ["What checking found", "Now", "Fix"]) {
      expect(secrets).toContain(`<dt>${field}</dt>`);
    }
  });

  it("a category with no check says Not checked, with no count and no claim", () => {
    const unreviewed = card(HTML, "unreviewed");
    expect(unreviewed).toContain(
      `<span class="tone tone-not-checked" id="check-unreviewed-tone">Not checked</span>`,
    );
    expect(unreviewed).toContain("Not checked.");
    expect(unreviewed).not.toContain('class="times"');
    expect(unreviewed).not.toContain("<dt>Now</dt>");
    expect(unreviewed).not.toContain("<dt>Fix</dt>");
  });

  it("a check that could not finish says so, and is not clean", () => {
    const tests = card(HTML, "tests");
    expect(tests).toContain("Could not check</span>");
    expect(tests).toContain("not a clean result");
    expect(tests).not.toContain("tone-clean");
  });

  it("in this build only the secrets card has a check; every other category reads Not checked", () => {
    const v: Verification = {
      ...verification(),
      categories: {
        ...Object.fromEntries(VERIFY_CATEGORIES.map((c) => [c, { status: "not-checked" }])),
        secrets: { status: "act", matches: 11, facts: SECRETS_ACT },
      } as unknown as Verification["categories"],
    };
    const html = renderReport(baseResult(v), VERIFIED_META, { cardBuilders: CARD_BUILDERS });
    const cards = cardsOf(html);
    expect(cards[0]).toEqual({ category: "secrets", tone: "act" });
    expect(cards.slice(1).every((c) => c.tone === "not-checked")).toBe(true);
    expect(section(html, "what-happened").split("Not checked.").length - 1).toBe(8);
  });

  it("fix commands are redacted shapes with copy buttons that name their card", () => {
    const lost = card(HTML, "lost-work");
    expect(lost).toContain(
      '<code id="fix-lost-work-1">git branch recovered/&lt;name&gt; &lt;sha&gt;</code>',
    );
    expect(lost).toContain('aria-label="Copy fix command 1 for lost work"');
    expect(lost).toContain('aria-label="Copy fix command 2 for lost work"');
    const ids = idsOf(HTML);
    for (const m of HTML.matchAll(/\sdata-copy="([^"]+)"/g)) expect(ids.has(m[1] ?? "")).toBe(true);
    // Accessible names are distinct across the page.
    const names = [...HTML.matchAll(/aria-label="(Copy[^"]*)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names the local fixes file only on cards whose exact commands are in it", () => {
    for (const category of VERIFY_CATEGORIES) {
      const named = card(HTML, category).includes(FIXES_FILENAME);
      expect(named, category).toBe(LOCAL_FIX_CATEGORIES.includes(category));
    }
    expect(card(HTML, "lost-work")).toContain("next to this report");
    expect(card(ARTIFACT, "lost-work")).toContain("was not published with this page");
    const none = renderReport(VERIFIED_RESULT, VERIFIED_META, { cardBuilders: TEST_ONLY_BUILDERS });
    expect(none).not.toContain(FIXES_FILENAME);
  });

  it("a category with no check never names the fixes file, whatever the file holds", () => {
    const html = renderReport(VERIFIED_RESULT, VERIFIED_META, {
      cardBuilders: TEST_ONLY_BUILDERS,
      localFixCategories: ["unreviewed", "tests"],
    });
    expect(card(html, "unreviewed")).not.toContain(FIXES_FILENAME);
    // A check that could not finish may still have made some commands.
    expect(card(html, "tests")).toContain(FIXES_FILENAME);
  });

  it("a card whose counts rest on Codex output records says they may include blocked calls", () => {
    const v = verification({
      ...verifiedCategories(),
      "skipped-checks": {
        status: "act",
        matches: 6,
        facts: testFacts("skipped-checks", { commits: 2, reachedMain: 1, codex: 1 }),
      },
    } as unknown as Verification["categories"]);
    const html = renderReport(baseResult(v), VERIFIED_META, OPTIONS);
    expect(card(html, "skipped-checks")).toContain('class="note codex-caveat"');
    expect(card(html, "lost-work")).not.toContain("codex-caveat");
  });

  it("states the tones in the section's heading line", () => {
    expect(section(HTML, "what-happened")).toContain(
      "3 to act on · 1 to review · 3 clean · 1 could not check · 1 not checked",
    );
  });

  it("says what each check read, from that check's own counts", () => {
    expect(section(HTML, "what-happened")).toContain(
      '<li><span class="read-title">Secrets in transcripts:</span> <span data-template="secrets.read">Read 18 transcript files again and searched the git-tracked files of 2 repos the sessions ran in, with read-only git.</span></li>',
    );
  });

  it("counts only the repos it could search, and the rest apart", () => {
    const v = verification({
      ...verifiedCategories(),
      secrets: {
        status: "act",
        matches: 11,
        facts: { ...SECRETS_ACT, reposChecked: 1, reposNotChecked: 3, fixtureCheck: "partial" },
      },
    });
    const html = renderReport(baseResult(v), VERIFIED_META, OPTIONS);
    expect(section(html, "what-happened")).toContain(
      "searched the git-tracked files of 1 repo the sessions ran in, with read-only git; 3 repos the sessions named could not be searched.",
    );
    expect(html).not.toContain("files of 4 repos");
  });
});

describe("the two variants carry the same verified body", () => {
  it("apart from where the fixes file is", () => {
    const body = (html: string): string =>
      section(html, "found") +
      section(html, "also-checked") +
      section(html, "what-happened").replace(/<p class="note fixes-file"[^>]*>[\s\S]*?<\/p>/g, "");
    expect(body(ARTIFACT)).toBe(body(HTML));
    expect(body(HTML).length).toBeGreaterThan(4000);
  });
});

describe("the data block and the export carry the cards, built from the capped copy", () => {
  it("has every card the page shows, with the same sentences", () => {
    const payload = reportPayload(VERIFIED_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS);
    expect(payload.cards?.map((c) => c.category)).toEqual(cardsOf(HTML).map((c) => c.category));
    for (const c of payload.cards ?? []) {
      for (const line of [...c.found, ...c.now, ...(c.fixSteps ?? [])]) {
        expect(card(HTML, c.category)).toContain(line.text.replace(/'/g, "&#39;"));
      }
    }
    const block = HTML.match(
      /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/,
    );
    expect(JSON.parse(block?.[1] ?? "{}").cards).toHaveLength(9);
  });

  it("without verification, carries no cards", () => {
    expect(reportPayload(baseResult(undefined), VERIFIED_META).cards).toBeUndefined();
  });
});

describe("the page script is unchanged and still finds everything it needs", () => {
  it("every id it asks for exists on a verified page", () => {
    const ids = idsOf(HTML);
    for (const m of REPORT_SCRIPT.matchAll(/byId\("([^"]+)"\)/g)) {
      expect(ids.has(m[1] ?? ""), m[1]).toBe(true);
    }
  });

  it("every in-page link has a target", () => {
    const ids = idsOf(HTML);
    for (const m of HTML.matchAll(/\shref="#([^"]+)"/g))
      expect(ids.has(m[1] ?? ""), m[1]).toBe(true);
  });

  it("ids are unique", () => {
    const all = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("scan --review lists every line the verified sections write", () => {
  const group = reviewStrings(VERIFIED_RESULT, TEST_ONLY_BUILDERS).find((g) =>
    g.label.startsWith("What the checks found on this machine"),
  );
  const pieces = (group?.lines ?? []).flatMap((line) => line.split("  ").filter(Boolean));

  it("every piece it shows is in the file", () => {
    expect(pieces.length).toBeGreaterThan(40);
    for (const piece of pieces) {
      expect(HTML, `"${piece}" was reviewed but is not in the file`).toContain(escapeHtml(piece));
    }
  });

  it("every templated line in the file is in it: the direction that matters", () => {
    const verified = [
      HTML.match(/<h1[^>]*>[^<]*<\/h1>/)?.[0] ?? "",
      section(HTML, "found"),
      section(HTML, "also-checked"),
      section(HTML, "what-happened"),
    ].join("\n");
    // Every line made from a template, bar the fixes-file note, which names a fixed file.
    const lines = [...verified.matchAll(/data-template="([^"]+)"[^>]*>([^<]*)</g)]
      .filter((m) => m[1] !== "card.fixes-file")
      .map((m) => decodeEntities(m[2] ?? ""));
    expect(lines.length).toBeGreaterThan(30);
    const reviewed = new Set(pieces);
    expect(lines.filter((line) => !reviewed.has(line))).toEqual([]);
    // And the fix shapes, which are code rather than sentences.
    for (const m of section(HTML, "what-happened").matchAll(/<code id="fix-[^"]+">([^<]*)</g)) {
      expect(reviewed.has(decodeEntities(m[1] ?? ""))).toBe(true);
    }
  });

  it("lists the evidence rows and the chips", () => {
    expect(group?.lines).toContain(
      "GitHub token  you pasted it into a prompt  in 4 transcript files",
    );
    expect(group?.lines).toContain("Production infrastructure  0 production databases touched");
  });

  it("is absent without verification, and with no tool calls read", () => {
    const labels = (r: Parameters<typeof reviewStrings>[0]) =>
      reviewStrings(r, TEST_ONLY_BUILDERS).map((g) => g.label);
    expect(labels(baseResult(undefined)).some((l) => l.startsWith("What the checks"))).toBe(false);
    expect(
      labels({ ...VERIFIED_RESULT, toolCalls: 0 }).some((l) => l.startsWith("What the checks")),
    ).toBe(false);
  });
});

describe("the verified sections print", () => {
  const REPORT_STYLES = reportStyles(true);
  const print = REPORT_STYLES.slice(REPORT_STYLES.indexOf("@media print"));
  const rules = [...print.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? "").split(",").map((s) => s.trim()),
    body: m[2] ?? "",
  }));
  const where = (pattern: RegExp): string[] =>
    rules.filter((r) => pattern.test(r.body)).flatMap((r) => r.selectors);

  it("a long card breaks between its fields, never inside one, and keeps its head with its title", () => {
    expect(where(/break-inside: auto/)).toContain(".verified");
    expect(where(/break-inside: avoid/)).toEqual(
      expect.arrayContaining([".verified-facts > div", ".check-chip", ".evidence-list li"]),
    );
    expect(where(/break-after: avoid/)).toEqual(
      expect.arrayContaining([".verified .card-head", ".verified-facts dt"]),
    );
  });

  it("keeps the tones' colors on paper", () => {
    expect(where(/print-color-adjust: exact/)).toEqual(
      expect.arrayContaining([".tone", ".verified", ".check-chip"]),
    );
  });

  it("defines every tone for both themes", () => {
    for (const tone of ["act", "review", "clean", "none"]) {
      for (const part of ["fg", "bg", "bd"]) {
        expect(REPORT_STYLES).toContain(`--tone-${tone}-${part}:`);
      }
    }
    for (const tone of TONE_ORDER) {
      expect(REPORT_STYLES).toContain(`.tone-${tone} {`);
      expect(REPORT_STYLES).toContain(`.v-${tone} {`);
    }
  });
});

describe("the verified sections' styles are on a page only when it shows them", () => {
  /** What only the verified sections' styles hold. */
  const VERIFIED_ONLY = [
    "--tone-",
    ".evidence-list",
    ".check-chip",
    ".verified-cards",
    ".verified-facts",
    ".verified-note",
    ".lead.totals",
    ".codex-caveat",
    ".read-list",
  ];
  const styleOf = (html: string): string =>
    html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

  it("a verified page carries them, in both variants", () => {
    for (const page of [HTML, ARTIFACT]) {
      for (const text of VERIFIED_ONLY) expect(styleOf(page), text).toContain(text);
      expect(styleOf(page)).toBe(`<style>${reportStyles(true)}`);
    }
  });

  it.each([
    ["no verification", baseResult(undefined)],
    ["a verification over a scan that read no tool calls", { ...VERIFIED_RESULT, toolCalls: 0 }],
  ])("a page with %s carries none of them", (_name, result) => {
    for (const variant of ["document", "artifact"] as const) {
      const page = renderReport(result, VERIFIED_META, { ...OPTIONS, variant });
      for (const text of VERIFIED_ONLY) expect(styleOf(page), text).not.toContain(text);
      expect(styleOf(page)).toBe(`<style>${reportStyles(false)}`);
    }
  });

  it("the stylesheet without them is the one with them, less only their rules", () => {
    const without = reportStyles(false);
    const lines = new Set(reportStyles(true).split("\n"));
    // Every line of the plain stylesheet is in the verified one, but the one print line the
    // verified one extends with its own selector.
    const extended =
      "  h1, h2, h3, .section-head, summary, h2 + .note, h2 + .lead { break-after: avoid; }";
    for (const line of without.split("\n")) {
      if (line !== extended) expect(lines.has(line), line).toBe(true);
    }
    expect(without).toContain(extended);
  });
});

describe("every Codex page whose checks ran says their reading is limited and unverified", () => {
  // Every point, in one wording: synthetic sessions only, ran may include a blocked call, ids
  // not identified, and no Codex-only finding leads.
  const NOTE =
    "The Codex reading is limited and unverified: it is tested only on synthetic sessions built from Codex's documented rollout format, never on a real Codex session. A Codex call counted as ran may be one a hook blocked, ids a Codex command printed show as not identified, and no Codex-only finding leads the report.";
  const codexPage = (ran: number, verified = true): string => {
    const v = verification(verifiedCategories(), { ranEvidence: "output-record" });
    const result = {
      ...baseResult(verified ? { ...v, matchedCalls: { ...v.matchedCalls, ran } } : undefined),
      agent: "codex" as const,
    };
    return renderReport(result, VERIFIED_META, OPTIONS);
  };
  /** How many times the note is in a section, as its text reads. */
  const notesIn = (html: string, id: string): number =>
    decodeEntities(section(html, id)).split(NOTE).length - 1;

  it("is the one shared wording", () => {
    expect(CODEX_UNVERIFIED_TEXT).toBe(NOTE);
  });

  it("a verified Codex scan where no matched call ran still says so, once, above the chips", () => {
    const html = codexPage(0);
    expect(notesIn(html, "also-checked")).toBe(1);
    expect(notesIn(html, "scanned")).toBe(1);
  });

  it("and with calls that ran, says the same once, with no second wording", () => {
    const html = codexPage(5);
    expect(notesIn(html, "also-checked")).toBe(1);
    expect(section(html, "also-checked")).not.toContain("recorded an output for it");
  });

  it("a Codex scan without the checks makes no claim about them, as a scan before the checks", () => {
    const html = codexPage(0, false);
    expect(html).not.toContain('id="also-checked"');
    expect(notesIn(html, "scanned")).toBe(0);
    expect(html).not.toContain("Codex reading");
    expect(html).not.toContain("codex-reading");
  });

  it("no other app's page says it", () => {
    for (const agent of ["claude", "cursor"] as const) {
      const html = renderReport({ ...VERIFIED_RESULT, agent }, VERIFIED_META, OPTIONS);
      expect(html).not.toContain("Codex reading");
    }
  });
});

describe("a card never reads clean, or shows a zero, where nothing could be confirmed", () => {
  const chip = (html: string, category: VerifyCategory) =>
    chipsOf(html).find((c) => c.href === `#check-${category}`)?.text;

  it("a clean check whose calls held hiding forms could not confirm, and names them", () => {
    const html = renderReport(HIDING_RESULT, VERIFIED_META, OPTIONS);
    const destructive = card(html, "destructive");
    expect(destructive).toContain(
      '<span class="tone tone-could-not-check" id="check-destructive-tone">Could not confirm</span>',
    );
    expect(destructive).toContain(
      "Could not confirm: commands that ran, or may have run, here used a shell given a string to run, xargs, which can run commands this reading does not take apart, so this is not a clean result.",
    );
    expect(destructive).not.toContain("tone-clean");
    expect(chip(html, "destructive")).toBe("could not confirm");
  });

  it("a check that found something keeps its tone and count, and still says it", () => {
    const html = renderReport(HIDING_RESULT, VERIFIED_META, OPTIONS);
    const lost = card(html, "lost-work");
    expect(lost).toContain(
      '<span class="tone tone-act" id="check-lost-work-tone">Act on this</span>',
    );
    expect(lost).toContain("used eval, which can run commands");
    expect(chip(html, "lost-work")).toBe("3 deleted branches and stashes still recoverable");
  });

  it("on an app that records no output, a check of commands that ran never reads clean", () => {
    const html = renderReport(CURSOR_RESULT, VERIFIED_META, OPTIONS);
    for (const category of ["prod-infra", "destructive", "egress"] as const) {
      expect(card(html, category), category).toContain("Could not confirm</span>");
      expect(card(html, category), category).toContain("these sessions record no command output");
      expect(chip(html, category), category).toBe("could not confirm");
    }
    expect(html).not.toContain("0 production databases touched");
    expect(html).not.toContain("0 files sent off this machine");
    // The secrets check reads text, and the checks that found something keep their tone.
    expect(card(html, "secrets")).toContain("tone-act");
    expect(card(html, "cloud")).toContain("tone-review");
    // The same corpus with output recorded keeps its clean zeros.
    expect(chip(HTML, "prod-infra")).toBe("0 production databases touched");
  });

  it("a builder's tone that is not a known status becomes could-not-check", () => {
    const builders = {
      ...TEST_ONLY_BUILDERS,
      egress: (r: unknown) => ({
        ...(
          TEST_ONLY_BUILDERS as unknown as Record<string, (r: unknown, c: unknown) => object>
        ).egress?.(r, { ranEvidence: "tool-result" }),
        tone: 'clean" onclick="x',
      }),
    } as unknown as typeof TEST_ONLY_BUILDERS;
    const html = renderReport(VERIFIED_RESULT, VERIFIED_META, { cardBuilders: builders });
    expect(card(html, "egress")).toContain("tone-could-not-check");
    expect(html).not.toContain("onclick");
  });

  it("a check that could not finish but has facts shows them, after saying so", () => {
    const v = verification({
      ...verifiedCategories(),
      secrets: {
        status: "could-not-check",
        matches: 4,
        facts: {
          ...SECRETS_ACT,
          classes: { ...SECRETS_ACT.classes, "likely-real": 0 },
          items: [],
          filesNotRead: 2,
        },
      },
    });
    const secrets = card(renderReport(baseResult(v), VERIFIED_META, OPTIONS), "secrets");
    const lines = [...secrets.matchAll(/data-template="([^"]+)"/g)].map((m) => m[1]);
    expect(lines[1]).toBe("could-not-check");
    expect(secrets).toContain("2 transcript files could not be read.");
  });
});

describe("every hiding form is named, whatever forms there are", () => {
  it("each registered form has words, and a form with no label is named from its id", () => {
    for (const form of HIDING_FORMS) {
      const text = UNCONFIRMED_SENTENCE.render({ reason: "hiding-forms", forms: [form] }) ?? "";
      expect(text, form).toContain(hidingFormLabel(form));
      expect(hidingFormLabel(form).length).toBeGreaterThan(2);
    }
    expect(hidingFormLabel("some-new-form")).toBe("some new form");
  });
});

describe("the review and the page agree on every corpus page", () => {
  // A Codex scan whose secrets would lead on another app: secrets to act on, and calls that ran.
  const codexVerification = verification(verifiedCategories(), { ranEvidence: "output-record" });
  const CODEX_ACT = {
    ...baseResult({
      ...codexVerification,
      matchedCalls: { ...codexVerification.matchedCalls, ran: 5 },
    }),
    agent: "codex" as const,
  };
  /** The first line of a scan's verified review group: where a headline would be. */
  const firstReviewed = (result: Parameters<typeof reviewStrings>[0]): string =>
    reviewStrings(result, TEST_ONLY_BUILDERS).find((g) =>
      g.label.startsWith("What the checks found on this machine"),
    )?.lines[0] ?? "";

  it("Codex: the review leads with nothing, as the page does", () => {
    const LEAD = "likely-real credentials";
    const html = renderReport(CODEX_ACT, VERIFIED_META, OPTIONS);
    expect(html.match(/<h1[^>]*>[^<]*<\/h1>/)?.[0]).not.toContain(LEAD);
    expect(firstReviewed(CODEX_ACT)).not.toContain(LEAD);
    // Negative control: the same scan on Claude Code leads with the credentials, in both.
    const claude = {
      ...CODEX_ACT,
      agent: "claude" as const,
      verification: { ...codexVerification, ranEvidence: "tool-result" as const },
    };
    expect(firstReviewed(claude)).toContain(LEAD);
  });

  const PAGES = [
    ["secrets lead", VERIFIED_RESULT],
    ["cloud lead", CLOUD_LEAD_RESULT],
    ["fallback", FALLBACK_RESULT],
    ["Codex", CODEX_ONLY_RESULT],
    ["Cursor", CURSOR_RESULT],
    ["hiding forms", HIDING_RESULT],
    ["Codex with findings to act on", CODEX_ACT],
  ] as const;

  it.each(
    PAGES,
  )("%s: every reviewed piece is in the page, and every templated line is reviewed", (_n, result) => {
    const html = renderReport(result, VERIFIED_META, OPTIONS);
    const group = reviewStrings(result, TEST_ONLY_BUILDERS).find((g) =>
      g.label.startsWith("What the checks found on this machine"),
    );
    const pieces = (group?.lines ?? []).flatMap((line) => line.split("  ").filter(Boolean));
    for (const piece of pieces) expect(html, piece).toContain(escapeHtml(piece));
    const verified = [
      html.match(/<h1[^>]*>[^<]*<\/h1>/)?.[0] ?? "",
      section(html, "found"),
      section(html, "also-checked"),
      section(html, "what-happened"),
    ].join("\n");
    const reviewed = new Set(pieces.map((p) => p.replace(/:$/, "")));
    const lines = [...verified.matchAll(/data-template="([^"]+)"[^>]*>([^<]*)</g)]
      .filter((m) => m[1] !== "card.fixes-file")
      .map((m) => decodeEntities(m[2] ?? ""));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.filter((line) => !reviewed.has(line))).toEqual([]);
  });

  it("the Codex caveat on a card is reviewed", () => {
    const v = verification({
      ...verifiedCategories(),
      "skipped-checks": {
        status: "act",
        matches: 6,
        facts: testFacts("skipped-checks", { commits: 2, reachedMain: 1, codex: 1 }),
      },
    } as unknown as Verification["categories"]);
    const lines = reviewStrings(baseResult(v), TEST_ONLY_BUILDERS).flatMap((g) => g.lines);
    expect(lines.some((l) => l.includes("may include calls a hook blocked"))).toBe(true);
  });
});

describe("the page, the data block and --json agree on what could not be confirmed", () => {
  /** A category's status in the data block and in --json, and its card's tone on the page. */
  const views = (result: Parameters<typeof renderReport>[0], category: VerifyCategory) => {
    const html = renderReport(result, VERIFIED_META, OPTIONS);
    const block = JSON.parse(
      html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)?.[1] ??
        "{}",
    );
    const json = JSON.parse(renderJson(result, VERIFIED_META));
    return {
      page: cardsOf(html).find((c) => c.category === category)?.tone,
      cards: block.cards.find((c: { category: string }) => c.category === category)?.tone,
      data: block.verification.categories[category].status,
      json: json.result.verification.categories[category].status,
    };
  };

  it("hiding forms: a clean check that could not confirm is could-not-check everywhere", () => {
    expect(views(HIDING_RESULT, "destructive")).toEqual({
      page: "could-not-check",
      cards: "could-not-check",
      data: "could-not-check",
      json: "could-not-check",
    });
    // A check that found something keeps its tone everywhere, and still says it could not confirm.
    expect(views(HIDING_RESULT, "lost-work")).toEqual({
      page: "act",
      cards: "act",
      data: "act",
      json: "act",
    });
  });

  it("an app with no recorded output: every check of commands that ran agrees", () => {
    for (const category of ["prod-infra", "destructive", "egress"] as const) {
      expect(views(CURSOR_RESULT, category), category).toEqual({
        page: "could-not-check",
        cards: "could-not-check",
        data: "could-not-check",
        json: "could-not-check",
      });
    }
    // The secrets check reads text, so it is not touched.
    expect(views(CURSOR_RESULT, "secrets").data).toBe("act");
  });

  it("negative control: with output recorded and no hiding forms, clean stays clean everywhere", () => {
    expect(views(VERIFIED_RESULT, "destructive")).toEqual({
      page: "clean",
      cards: "clean",
      data: "clean",
      json: "clean",
    });
  });
});

describe("a card that could not confirm never leads", () => {
  // Secrets clean, nothing skipped, and deleted work to act on, from calls that used eval.
  const unconfirmedLead = (forms: readonly ("eval" | "xargs")[] | undefined) =>
    baseResult(
      verification({
        ...verifiedCategories(),
        secrets: { status: "clean", matches: 3, facts: SECRETS_CLEAN },
        "skipped-checks": { status: "not-checked" },
        "lost-work": {
          status: "act",
          matches: 3,
          facts: testFacts("lost-work", { branches: 2, stashes: 1, recoverable: 3 }, forms),
        },
      } as unknown as Verification["categories"]),
    );
  const LEAD = "3 pieces of deleted work are still recoverable";

  it("the page and --review fall through to the next card that may lead", () => {
    const result = unconfirmedLead(["eval"]);
    const html = renderReport(result, VERIFIED_META, OPTIONS);
    expect(html.match(/<h1[^>]*>[^<]*<\/h1>/)?.[0]).not.toContain(LEAD);
    // The cloud card, from review, is the next that may lead.
    expect(html.match(/<h1[^>]*>[^<]*<\/h1>/)?.[0]).toContain("IAM change");
    const reviewed = reviewStrings(result, TEST_ONLY_BUILDERS).flatMap((g) => g.lines);
    expect(reviewed.some((l) => l.includes(LEAD))).toBe(false);
    // The card itself still says what it found, after saying it could not confirm.
    expect(card(html, "lost-work")).toContain("used eval");
  });

  it("negative control: the same card leads when it confirmed what it reports", () => {
    const html = renderReport(unconfirmedLead(undefined), VERIFIED_META, OPTIONS);
    expect(html.match(/<h1[^>]*>[^<]*<\/h1>/)?.[0]).toContain(LEAD);
  });
});

describe("the cards are built from the boundary copy, never the raw facts", () => {
  const CANARY = "UNREGISTEREDFACTCANARY";
  // A test-only builder that writes whatever its facts' `note` holds. `note` is not a registered
  // fact key, so the copy the cards are built from never carries it.
  const builders = {
    ...TEST_ONLY_BUILDERS,
    egress: (result: { status: string; matches: number; facts: { note?: string } }) => ({
      category: "egress",
      tone: result.status,
      count: result.matches,
      found: [{ template: "test-only.note", text: `Note: ${result.facts.note ?? "none"}` }],
      now: [],
      fixes: [],
      codexCaveat: false,
    }),
  } as unknown as typeof TEST_ONLY_BUILDERS;
  const result = baseResult(
    verification({
      ...verifiedCategories(),
      egress: { status: "clean", matches: 1, facts: { note: CANARY } },
    } as unknown as Verification["categories"]),
  );

  it("an unregistered fact reaches no page, data block or review", () => {
    const html = renderReport(result, VERIFIED_META, { cardBuilders: builders });
    expect(html).not.toContain(CANARY);
    expect(card(html, "egress")).toContain("Note: none");
    expect(JSON.stringify(reportPayload(result, VERIFIED_META, builders))).not.toContain(CANARY);
    expect(JSON.stringify(reviewStrings(result, builders))).not.toContain(CANARY);
  });

  it("negative control: the builder does write the fact when given the raw result", () => {
    const raw = (
      builders as unknown as Record<string, (r: unknown) => { found: unknown[] }>
    ).egress?.(result.verification?.categories.egress);
    expect(JSON.stringify(raw)).toContain(CANARY);
  });
});

describe("a counted chip that could not confirm never shows a zero", () => {
  it("a review card with hiding forms and a zero count reads could not confirm", () => {
    const result = baseResult(
      verification({
        ...verifiedCategories(),
        cloud: {
          status: "review",
          matches: 1,
          facts: testFacts("cloud", { iam: 0, s3: 1, terraform: 0 }, ["xargs"]),
        },
      } as unknown as Verification["categories"]),
    );
    const html = renderReport(result, VERIFIED_META, OPTIONS);
    const chip = chipsOf(html).find((c) => c.href === "#check-cloud")?.text;
    expect(chip).toBe("could not confirm");
    expect(chip).not.toMatch(/\b0\b/);
  });
});

describe("the chips the shipped card builders write state their count once", () => {
  /** The page's chips, rendered with the shipped builders, never test-only ones. */
  const shippedChips = (v: Verification) =>
    chipsOf(renderReport(baseResult(v), VERIFIED_META, { cardBuilders: CARD_BUILDERS }));

  it("every chip on a page with every category checked has at most one number", () => {
    const chips = shippedChips(notesVerification());
    expect(chips.length).toBe(CHIP_COUNT);
    for (const chip of chips) {
      expect((chip.text.match(/\d+/g) ?? []).length, chip.text).toBeLessThanOrEqual(1);
    }
    const byHref = Object.fromEntries(chips.map((c) => [c.href, c.text]));
    expect(byHref["#check-skipped-checks"]).toBe("3 commits reached main without their checks");
    expect(byHref["#check-lost-work"]).toBe("3 deleted branches or stashes still recoverable");
    expect(byHref["#check-destructive"]).toBe("0 rm -rf targets built from an unguarded variable");
  });

  it("one of each reads in the singular, with its count once", () => {
    const chips = shippedChips(
      notesVerification({
        "skipped-checks": checked("act", {
          ...SKIPPED_FACTS,
          noVerify: { ...SKIPPED_FACTS.noVerify, onMain: 1 },
        }),
        "lost-work": checked("act", {
          ...LOST_WORK_FACTS,
          branches: { ...LOST_WORK_FACTS.branches, recoverable: 1 },
          stashes: { ...LOST_WORK_FACTS.stashes, recoverable: 0 },
        }),
        destructive: checked("act", {
          ...DESTRUCTIVE_FACTS,
          rm: {
            ...DESTRUCTIVE_FACTS.rm,
            classes: { ...DESTRUCTIVE_FACTS.rm.classes, "unguarded-variable": 1 },
          },
        }),
      }),
    );
    const byHref = Object.fromEntries(chips.map((c) => [c.href, c.text]));
    expect(byHref["#check-skipped-checks"]).toBe("1 commit reached main without its checks");
    expect(byHref["#check-lost-work"]).toBe("1 deleted branch or stash still recoverable");
    expect(byHref["#check-destructive"]).toBe("1 rm -rf target built from an unguarded variable");
  });
});

describe("--json and an empty scan's data block", () => {
  it("--json for a Codex scan whose checks ran carries the limited-and-unverified note; no other app's does", () => {
    const codex = JSON.parse(renderJson(CODEX_ONLY_RESULT, VERIFIED_META));
    expect(codex.notes).toEqual([CODEX_UNVERIFIED_TEXT]);
    // Without the checks there is nothing checked to say it about.
    const { verification: _checked, ...unchecked } = CODEX_ONLY_RESULT;
    expect(JSON.parse(renderJson(unchecked, VERIFIED_META)).notes).toBe(undefined);
    for (const agent of ["claude", "cursor"] as const) {
      expect(JSON.parse(renderJson({ ...VERIFIED_RESULT, agent }, VERIFIED_META)).notes).toBe(
        undefined,
      );
    }
  });

  it("a scan that read no tool calls carries no cards, as its page shows none", () => {
    const empty = { ...VERIFIED_RESULT, toolCalls: 0 };
    const payload = reportPayload(empty, VERIFIED_META, TEST_ONLY_BUILDERS);
    expect(payload.cards).toBeUndefined();
    expect(renderReport(empty, VERIFIED_META, OPTIONS)).not.toContain('id="what-happened"');
    // Negative control: with tool calls read, the cards are there.
    expect(reportPayload(VERIFIED_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS).cards).toHaveLength(9);
  });
});

describe("small fences", () => {
  it("a Cursor page does not also say a call had no recorded output", () => {
    const notes = section(renderReport(CURSOR_RESULT, VERIFIED_META, OPTIONS), "also-checked");
    expect(notes).toContain("These sessions record no command output");
    expect(notes).not.toContain("had no recorded output");
  });

  it("a card that could not check shows its tone in the chip, never its count", () => {
    const card = {
      category: "egress" as const,
      tone: "could-not-check" as const,
      count: 4,
      found: [],
      now: [],
      fixes: [],
      codexCaveat: false,
      chip: { count: 4, label: { template: "x", text: "files sent off this machine" } },
    };
    expect(chipText(card)).toEqual({
      label: { template: "chip.tone", text: "could not check" },
    });
  });

  it("an empty scan with verification links to nothing that is not on the page", () => {
    // An empty scan has no matches either; only its verification remains.
    const empty = {
      ...VERIFIED_RESULT,
      toolCalls: 0,
      sessions: 0,
      riskyActions: 0,
      findings: [],
      recurring: [],
      owasp: [],
    };
    const html = renderReport(empty, VERIFIED_META, OPTIONS);
    expect(html).not.toContain('href="#what-happened"');
    const ids = idsOf(html);
    for (const m of html.matchAll(/\shref="#([^"]+)"/g))
      expect(ids.has(m[1] ?? ""), m[1]).toBe(true);
  });
});

describe("small accessibility and label fences", () => {
  it("each card is described by its tone, and the section is named by its heading", () => {
    expect(card(HTML, "secrets")).toContain('aria-describedby="check-secrets-tone"');
    expect(card(HTML, "secrets")).toContain('id="check-secrets-tone"');
    expect(HTML).toContain('aria-labelledby="what-happened-heading"');
    expect(HTML).toContain('<h2 id="what-happened-heading">What actually happened</h2>');
  });

  it("an evidence row of a kind this build does not know says other, never its raw id", () => {
    const facts = {
      ...SECRETS_ACT,
      items: [{ kind: "brand-new-kind", via: ["pasted-into-prompt", "made-up"], files: 1 }],
    } as unknown as typeof SECRETS_ACT;
    const html = renderReport(
      baseResult(
        verification({ ...verifiedCategories(), secrets: { status: "act", matches: 4, facts } }),
      ),
      VERIFIED_META,
      OPTIONS,
    );
    expect(section(html, "found")).toContain('<span class="evidence-kind">Other credential</span>');
    expect(section(html, "found")).toContain(
      '<span class="evidence-how">you pasted it into a prompt</span>',
    );
    expect(html).not.toContain("undefined");
  });
});
