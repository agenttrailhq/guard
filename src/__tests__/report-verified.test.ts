// cspell:words labelledby
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
  renderReport,
  reportPayload,
  reviewStrings,
} from "../core/report.js";
import { REPORT_STYLES } from "../core/report-brand.js";
import { REPORT_SCRIPT } from "../core/report-script.js";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import { TONE_ORDER } from "../core/verify/cards.js";
import {
  CATEGORY_TITLES,
  CHIP_CANDIDATES,
  CHIP_COUNT,
  KIND_LABELS,
  PROVENANCE_PHRASES,
  TONE_LABELS,
} from "../core/verify/copy.js";
import {
  SECRET_KINDS,
  VERIFY_CATEGORIES,
  type Verification,
  type VerifyCategory,
} from "../core/verify/types.js";
import { decodeEntities } from "./html-text.js";
import {
  baseResult,
  CLOUD_LEAD_RESULT,
  LOCAL_FIX_CATEGORIES,
  SECRETS_ACT,
  TEST_ONLY_BUILDERS,
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
      "which may include calls a hook blocked",
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
    expect(secrets).toContain(`<span class="tone tone-act">${TONE_LABELS.act}</span>`);
    expect(secrets).toContain('<span class="times">11 matches</span>');
    expect(secrets).toContain('aria-labelledby="check-secrets-title"');
    expect(secrets).toContain('<h3 id="check-secrets-title">Secrets in transcripts</h3>');
    for (const field of ["What checking found", "Now", "Fix"]) {
      expect(secrets).toContain(`<dt>${field}</dt>`);
    }
  });

  it("a category with no check says Not checked, with no count and no claim", () => {
    const unreviewed = card(HTML, "unreviewed");
    expect(unreviewed).toContain(`<span class="tone tone-not-checked">Not checked</span>`);
    expect(unreviewed).toContain("Not checked yet.");
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
    expect(section(html, "what-happened").split("Not checked yet.").length - 1).toBe(8);
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
        facts: { commits: 2, reachedMain: 1, codex: 1 },
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

  it("says what the checks read", () => {
    expect(section(HTML, "what-happened")).toContain(
      "read 18 transcript files again and searched the git-tracked files of 2 repos",
    );
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
