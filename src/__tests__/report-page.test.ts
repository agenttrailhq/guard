// cspell:words noopener noreferrer
/**
 * The report page's sections, what the file carries, and how its one script is fenced.
 *
 * Every fixture here is synthetic and hand-built, so each number is computed in the test.
 */

import { createHash } from "node:crypto";
import { PACKS } from "@agenttrail/guardrails";
import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import {
  contentSecurityPolicy,
  dataBlockText,
  escapeHtml,
  FIX_FIRST_MAX,
  headline,
  MAX_EXAMPLES,
  MAX_ROWS,
  packLabel,
  postLength,
  type ReportMeta,
  renderReport,
  reportPayload,
  reviewStrings,
  ruleSlug,
  SITE_URL,
  shareText,
  TUNING_MIN_ASKS,
  tuningHint,
  YOUR_GUARDRAILS,
} from "../core/report.js";
import { REPORT_SCRIPT } from "../core/report-script.js";
import type { ScanFinding, ScanResult } from "../core/scan-report.js";

const META: ReportMeta = { version: "0.0.0", generatedAt: new Date("2026-10-01T09:00:00.000Z") };

/** A library finding, as `aggregateScan` builds one for a shipped rule. */
function lib(
  ruleId: string,
  action: ScanFinding["action"],
  count: number,
  extra: Partial<ScanFinding> = {},
): ScanFinding {
  return {
    ruleId,
    title: `Library guardrail ${ruleId}`,
    severity: "high",
    action,
    count,
    examples: [{ text: `cmd-${ruleId} <path>`, count }],
    owasp: [],
    source: "library",
    category: "destructive-data",
    description: `Fires on ${ruleId}. Does not match the long form.`,
    ...extra,
  };
}

/** A finding for a guardrail the user wrote. */
function own(
  ruleId: string,
  action: ScanFinding["action"],
  count: number,
  extra: Partial<ScanFinding> = {},
): ScanFinding {
  return {
    ruleId,
    title: `Team guardrail ${ruleId}`,
    severity: "critical",
    action,
    count,
    examples: [{ text: `own-${ruleId} <path>`, count }],
    owasp: [],
    source: "yours",
    ...extra,
  };
}

function resultWith(
  findings: readonly ScanFinding[],
  byAction: ScanResult["riskyByAction"] = { block: 0, require_approval: 0, warn: 0 },
  extra: Partial<ScanResult> = {},
): ScanResult {
  const risky = byAction.block + byAction.require_approval + byAction.warn;
  return {
    agent: "claude",
    sessions: 2,
    quarantined: 0,
    notRead: 0,
    skippedLines: 0,
    projects: 1,
    toolCalls: 40,
    riskyActions: risky,
    riskyByAction: byAction,
    findings,
    recurring: [],
    owasp: [],
    tokens: null,
    ...extra,
  };
}

/** One whole row of All findings, up to the next row or the end of the list. */
function rowOf(html: string, index: number): string {
  const at = html.indexOf(`<li class="finding" id="finding-${index}"`);
  if (at === -1) return "";
  const next = html.indexOf('<li class="finding"', at + 1);
  const end = html.indexOf("</ol>", at);
  return html.slice(at, next === -1 || next > end ? end : next);
}

/** The text between two markers, for looking at one part of the page. */
function between(html: string, start: string, end: string): string {
  const at = html.indexOf(start);
  return at === -1 ? "" : html.slice(at, html.indexOf(end, at + start.length));
}

describe("the headline", () => {
  const cases: [ScanResult["riskyByAction"], string][] = [
    [
      { block: 3, require_approval: 2, warn: 9 },
      "Guard would have stopped 3 actions and asked you about 2 more",
    ],
    [{ block: 1, require_approval: 0, warn: 0 }, "Guard would have stopped 1 action"],
    [{ block: 0, require_approval: 4, warn: 1 }, "Guard would have asked you about 4 actions"],
    [{ block: 0, require_approval: 0, warn: 2 }, "Guard would have warned you about 2 actions"],
    [{ block: 0, require_approval: 0, warn: 0 }, "Nothing in these sessions matched a guardrail"],
  ];
  it.each(cases)("%o reads %s", (byAction, text) => {
    expect(headline(resultWith([], byAction))).toBe(text);
    expect(renderReport(resultWith([], byAction), META)).toContain(`<h1>${text}</h1>`);
  });
});

describe("the hero", () => {
  it("states the share of tool calls that matched nothing, rounded down", () => {
    const html = renderReport(
      resultWith(
        [lib("a.one", "warn", 1)],
        { block: 0, require_approval: 0, warn: 1 },
        { toolCalls: 3 },
      ),
      META,
    );
    // 2 of 3 is 66.6%: shown as 66, never rounded up to a cleaner number.
    expect(html).toContain(
      '<div class="stat-value">66%</div><div class="stat-label">matched no guardrail</div>',
    );
  });

  it("omits that share when there were no tool calls", () => {
    expect(renderReport(resultWith([], undefined, { toolCalls: 0 }), META)).not.toContain(
      "matched no guardrail",
    );
  });

  it("names the most serious library guardrail, even when a user's own is more serious", () => {
    const html = renderReport(
      resultWith([own("t.mine", "block", 5), lib("a.lib", "block", 1)], {
        block: 6,
        require_approval: 0,
        warn: 0,
      }),
      META,
    );
    const hero = between(html, 'id="overview"', "</section>");
    expect(hero).toContain("Library guardrail a.lib");
    expect(hero).not.toContain("Team guardrail t.mine");
  });

  it("says only 'a guardrail you added' when every match is the user's own", () => {
    const html = renderReport(
      resultWith([own("t.mine", "block", 5)], { block: 5, require_approval: 0, warn: 0 }),
      META,
    );
    const hero = between(html, 'id="overview"', "</section>");
    expect(hero).toContain("Most serious match: a guardrail you added");
    expect(hero).not.toContain("Team guardrail");
  });

  it("offers the init command for the agent that was scanned", () => {
    for (const agent of ["claude", "cursor", "codex"] as const) {
      const html = renderReport(resultWith([], undefined, { agent }), META);
      expect(html).toContain(`agenttrail-guard init --agent ${agent}`);
    }
  });
});

describe("what Guard would have done", () => {
  it("shows one column per action, counted once per tool call", () => {
    const html = renderReport(
      resultWith(
        [lib("a.b", "block", 7), lib("a.q", "require_approval", 2), lib("a.w", "warn", 9)],
        { block: 5, require_approval: 2, warn: 4 },
      ),
      META,
    );
    const section = between(html, 'id="would-do"', "</section>");
    expect(section).toMatch(/Blocked<\/p>\n<p class="col-count">5</);
    expect(section).toMatch(/Asked you first<\/p>\n<p class="col-count">2</);
    expect(section).toMatch(/Warned<\/p>\n<p class="col-count">4</);
  });

  it("is absent when nothing matched", () => {
    expect(renderReport(resultWith([]), META)).not.toContain('id="would-do"');
  });
});

describe("the tuning hint", () => {
  const asks = (...counts: number[]) =>
    reportPayload(resultWith(counts.map((c, i) => lib(`a.ask-${i}`, "require_approval", c))), META)
      .findings;

  it("appears when one guardrail produces most of at least the minimum number of asks", () => {
    expect(TUNING_MIN_ASKS).toBe(5);
    expect(tuningHint(asks(5))).toMatchObject({ ids: ["a.ask-0"], asks: 5, remaining: 0 });
  });

  it("stays away below the minimum number of asks", () => {
    expect(tuningHint(asks(4))).toBeUndefined();
  });

  it("uses at most three guardrails, and only when they reach 60%", () => {
    // Five equal guardrails: three of them are exactly 60%.
    expect(tuningHint(asks(2, 2, 2, 2, 2))?.ids).toHaveLength(3);
    // Six equal guardrails: three of them are 50%, which is not enough.
    expect(tuningHint(asks(2, 2, 2, 2, 2, 2))).toBeUndefined();
  });

  it("offers one copyable set-action command per guardrail", () => {
    const html = renderReport(
      resultWith([lib("a.noisy", "require_approval", 9), lib("a.rare", "require_approval", 1)]),
      META,
    );
    expect(html).toContain("agenttrail-guard guardrails set-action a.noisy warn");
    expect(html).not.toContain("set-action a.rare");
  });
});

describe("fix these first", () => {
  it("lists only blocking guardrails, most serious first, up to the cap", () => {
    const findings = [
      lib("a.low", "block", 50, { severity: "low" }),
      lib("a.crit", "block", 1, { severity: "critical" }),
      lib("a.ask", "require_approval", 99, { severity: "critical" }),
      ...Array.from({ length: FIX_FIRST_MAX + 2 }, (_, i) =>
        lib(`a.more-${i}`, "block", 1, { severity: "medium" }),
      ),
    ];
    const section = between(
      renderReport(resultWith(findings), META),
      'id="fix-first"',
      "</section>",
    );
    expect(section.split('<article class="card">').length - 1).toBe(FIX_FIRST_MAX);
    expect(section.indexOf("a.crit")).toBeLessThan(section.indexOf("a.more-0"));
    expect(section).not.toContain("a.ask");
    expect(section).not.toContain("a.low");
  });

  it("links a library guardrail to its page, tagged; a user's own gets no link", () => {
    const html = renderReport(
      resultWith([lib("wt.reset-hard", "block", 2), own("t.mine", "block", 1)]),
      META,
    );
    const section = between(html, 'id="fix-first"', "</section>");
    const link = `${SITE_URL}/guardrails/destructive-data/wt-reset-hard?utm_source=guard&amp;utm_medium=scan-report&amp;utm_campaign=claude&amp;utm_content=guardrail`;
    expect(section).toContain(link);
    expect(section).toContain("A guardrail you added.");
    expect(section.split("/guardrails/").length - 1).toBe(1);
  });

  it("says so when nothing would have been blocked", () => {
    expect(renderReport(resultWith([lib("a.w", "warn", 1)]), META)).toContain(
      "No guardrail would have blocked anything in these sessions.",
    );
  });
});

describe("all findings", () => {
  const findings = [
    lib("a.medium", "warn", 30, { severity: "medium" }),
    own("t.mine", "require_approval", 2, { severity: "low" }),
    lib("a.critical", "block", 1, { severity: "critical", category: "working-tree" }),
  ];
  const html = renderReport(resultWith(findings), META);
  const rows = [...html.matchAll(/<li class="finding" id="finding-(\d+)"[^>]*>/g)];

  it("lists rows most serious first in the page, whatever the sort", () => {
    expect(rows.map((m) => m[0].match(/data-action="([^"]+)"/)?.[1])).toEqual([
      "block",
      "warn",
      "require_approval",
    ]);
  });

  it("gives each row whole-number ranks for every sort, so the script reads numbers only", () => {
    for (const [row] of rows) {
      for (const key of ["serious", "category", "count", "name"]) {
        expect(row).toMatch(new RegExp(`data-rank-${key}="\\d+"`));
      }
    }
  });

  it("groups a library guardrail under its pack and a user's own under one fixed group", () => {
    expect(html).toContain(`<span class="group">${packLabel("working-tree")}</span>`);
    expect(html).toContain(`<span class="group">${YOUR_GUARDRAILS}</span>`);
  });

  it("explains how a library guardrail decides, and says nothing of the kind for a user's own", () => {
    const mine = rowOf(html, 2);
    const theirs = rowOf(html, 0);
    expect(mine).toContain("Team guardrail t.mine");
    expect(theirs).toContain("How this guardrail decides, and what it misses");
    expect(theirs).toContain("Fires on a.critical.");
    expect(mine).not.toContain("How this guardrail decides");
  });

  it("has filters and a sort control, hidden until the script runs", () => {
    expect(html).toMatch(/<div class="controls js-only" hidden>/);
    for (const filter of ["all", "block", "require_approval", "warn"]) {
      expect(html).toContain(`data-filter="${filter}"`);
    }
    expect(html).toContain('aria-pressed="true">All</button>');
    expect(html).toContain('role="status" aria-live="polite"');
  });
});

describe("a guardrail the user wrote is never shown as a library one", () => {
  it("has no library link, pack or description, and stays out of the post", () => {
    const shadow = own("dd.rm-rf-absolute", "block", 9, {
      title: "Hold rm on the billing cluster",
    });
    const result = resultWith([shadow, lib("a.lib", "block", 1)], {
      block: 10,
      require_approval: 0,
      warn: 0,
    });
    const html = renderReport(result, META);
    const row = rowOf(html, 0);
    expect(row).toContain("Hold rm on the billing cluster");
    expect(row).toContain("</details>");
    expect(row).not.toContain("/guardrails/");
    expect(row).not.toContain("How this guardrail decides");
    expect(shareText(result)).not.toContain("billing");
    expect(shareText(result)).toContain("Library guardrail a.lib");
  });

  it("keeps a quote-bearing id as text, never as markup or an attribute break", () => {
    const id = `t."quoted'<id>`;
    const html = renderReport(resultWith([own(id, "require_approval", 9)]), META);
    const page = html.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(page).not.toContain(id);
    expect(page).toContain(escapeHtml(id));
    // Every attribute in the page is still well formed.
    expect(page.match(/<[a-z]+\s[^>]*"[^">]*'<id>/)).toBeNull();
  });
});

describe("the suggested post", () => {
  it("carries totals and the top blocked library guardrail's title, and nothing else", () => {
    const result = resultWith(
      [lib("a.top", "block", 4, { title: "Delete with `rm -rf`" }), lib("a.next", "block", 1)],
      { block: 5, require_approval: 2, warn: 0 },
      { toolCalls: 1234 },
    );
    expect(shareText(result)).toBe(
      "I scanned 1,234 tool calls from Claude Code with AgentTrail Guard: 5 would block (4 of those: Delete with rm -rf) · 2 would ask. Checked locally, nothing uploaded.",
    );
  });

  it("leaves the title out when no library guardrail would block", () => {
    const text = shareText(
      resultWith([own("t.mine", "block", 3)], { block: 3, require_approval: 0, warn: 0 }),
    );
    expect(text).toContain("3 would block");
    expect(text).not.toContain("of those");
    expect(text).not.toContain("Team guardrail");
  });

  it("drops the title rather than run past X's limit", () => {
    const long = lib("a.long", "block", 1, { title: "x".repeat(300) });
    const text = shareText(resultWith([long], { block: 1, require_approval: 0, warn: 0 }));
    expect(text).not.toContain("xxx");
    expect(postLength(text)).toBeLessThanOrEqual(280);
  });

  it("carries no command, path or project name", () => {
    const result = resultWith([lib("a.top", "block", 4)], {
      block: 4,
      require_approval: 0,
      warn: 0,
    });
    for (const leak of ["cmd-a.top", "<path>", "/"]) expect(shareText(result)).not.toContain(leak);
  });

  it("is shown for every agent, with a plain Post-on-X link and its weighted length", () => {
    for (const agent of ["claude", "cursor", "codex"] as const) {
      const html = renderReport(resultWith([], undefined, { agent }), META);
      expect(html).toContain('id="share-link"');
      expect(html).toContain('href="https://x.com/intent/post?text=');
      expect(html).toMatch(/<span id="share-count"[^>]*>\d+ \/ 280<\/span>/);
    }
  });

  it("counts a link as 23 and wide characters as two, as X does", () => {
    const base = postLength("");
    expect(postLength("abc") - base).toBe(3);
    expect(postLength("日本") - base).toBe(4);
  });
});

describe("what the file carries is one capped projection", () => {
  const OVERSIZED = resultWith(
    Array.from({ length: MAX_ROWS + 4 }, (_, i) =>
      lib(`a.r-${String(i).padStart(3, "0")}`, "warn", MAX_ROWS + 4 - i, {
        examples: Array.from({ length: MAX_EXAMPLES + 2 }, (_, j) => ({
          text: `shape-${i}-${j}`,
          count: 1,
        })),
      }),
    ),
  );

  it("holds the first findings and shapes only", () => {
    const payload = reportPayload(OVERSIZED, META);
    expect(payload.findings).toHaveLength(MAX_ROWS);
    expect(payload.moreFindings).toBe(4);
    for (const f of payload.findings) {
      expect(f.examples).toHaveLength(MAX_EXAMPLES);
      expect(f.moreShapes).toBe(2);
    }
  });

  it("the data block is exactly the projection", () => {
    const html = renderReport(OVERSIZED, META);
    const block = between(html, '<script type="application/json" id="report-data">', "</script>");
    const parsed = JSON.parse(block.slice(block.indexOf(">") + 1));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(reportPayload(OVERSIZED, META))));
    expect(html).not.toContain(`shape-0-${MAX_EXAMPLES}`);
  });

  it("a field added to the result does not reach the file unless the projection copies it", () => {
    const withExtra = { ...resultWith([lib("a.x", "warn", 1)]), unlisted: "never-in-the-file" };
    const html = renderReport(withExtra as ScanResult, META);
    expect(html).not.toContain("never-in-the-file");
  });

  it("review lists exactly the strings in the data block, both ways", () => {
    const html = renderReport(OVERSIZED, META);
    const block = between(html, '<script type="application/json" id="report-data">', "</script>");
    const parsed = JSON.parse(block.slice(block.indexOf(">") + 1)) as ReturnType<
      typeof reportPayload
    >;
    const inBlock = new Set<string>([
      ...parsed.findings.flatMap((f) => [
        `${f.ruleId}  ${f.title}`,
        ...f.examples.map((e) => e.text),
      ]),
      ...parsed.recurring.flatMap((r) => [`${r.ruleId}  ${r.title}`, r.text]),
      parsed.shareText,
    ]);
    const reviewed = new Set(reviewStrings(OVERSIZED).flatMap((g) => g.lines));
    expect([...inBlock].filter((s) => !reviewed.has(s))).toEqual([]);
    expect([...reviewed].filter((s) => !inBlock.has(s))).toEqual([]);
  });
});

describe("the data block cannot be broken out of", () => {
  const HOSTILE = "</script><script>alert(1)</script> <!-- ]]>";
  const result = resultWith(
    [own("t.x", "block", 1, { title: HOSTILE, examples: [{ text: HOSTILE, count: 1 }] })],
    {
      block: 1,
      require_approval: 0,
      warn: 0,
    },
  );
  const html = renderReport(result, META);

  it("has exactly one executable script and one data block", () => {
    expect(html.split("<script>").length - 1).toBe(1);
    expect(html.split('<script type="application/json" id="report-data">').length - 1).toBe(1);
    expect(html.split("</script>").length - 1).toBe(2);
  });

  it("writes every < in the block as an escape", () => {
    expect(dataBlockText(reportPayload(result, META))).not.toContain("<");
    expect(dataBlockText(reportPayload(result, META))).toContain("\\u003c/script>");
  });

  it("round-trips to the projection", () => {
    const block = between(html, '<script type="application/json" id="report-data">', "</script>");
    expect(JSON.parse(block.slice(block.indexOf(">") + 1))).toEqual(
      JSON.parse(JSON.stringify(reportPayload(result, META))),
    );
  });
});

describe("the standalone page's policy", () => {
  const html = renderReport(resultWith([lib("a.b", "block", 1)]), META);

  it("is the first element of the head", () => {
    const head = between(html, "<head>", "</head>");
    expect(
      head
        .replace("<head>", "")
        .trimStart()
        .startsWith('<meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
  });

  it("allows no requests and only the script as written in the page", () => {
    const script = between(html, "<script>", "</script>").slice("<script>".length);
    expect(script).toBe(REPORT_SCRIPT);
    const hash = createHash("sha256").update(script, "utf8").digest("base64");
    const policy = contentSecurityPolicy();
    expect(policy).toContain(`script-src 'sha256-${hash}'`);
    expect(policy).toMatch(/^default-src 'none';/);
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("img-src");
    expect(html).toContain(`content="${policy}"`);
  });

  it("negative control — a changed script would not match the hash", () => {
    const other = createHash("sha256").update(`${REPORT_SCRIPT} `, "utf8").digest("base64");
    expect(contentSecurityPolicy()).not.toContain(other);
  });
});

describe("the artifact variant is static", () => {
  it.each([
    "claude",
    "cursor",
    "codex",
  ] as const)("a %s artifact carries no script, data block or policy", (agent) => {
    const html = renderReport(resultWith([lib("a.b", "block", 1)], undefined, { agent }), META, {
      variant: "artifact",
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("report-data");
    expect(html).not.toContain("Content-Security-Policy");
    expect(html).toContain('id="finding-0"');
    expect(html).toContain('id="share-link"');
  });
});

describe("library names and links", () => {
  it("has a display name for every shipped pack", () => {
    for (const pack of PACKS) expect(packLabel(pack), pack).not.toBe(pack);
  });

  it("slugs an id the way the library's pages do", () => {
    expect(ruleSlug("wt.reset-hard")).toBe("wt-reset-hard");
    expect(ruleSlug("Odd..ID__x")).toBe("odd-id-x");
    expect(ruleSlug("-.edge.-")).toBe("edge");
  });

  it("no shipped description carries a currency word", () => {
    for (const rule of SHIPPED_CATALOG) {
      expect(rule.description, rule.id).not.toMatch(
        /\bUSD\b|\bdollars?\b|\bestimated\b|\brisk avoided\b/i,
      );
    }
  });
});

describe("the privacy and coverage sections stay", () => {
  it.each([
    "claude",
    "cursor",
    "codex",
  ] as const)("a %s report keeps them, in the privacy area", (agent) => {
    const html = renderReport(
      resultWith([], undefined, {
        agent,
        skipped: {
          unparseableLines: 0,
          truncatedLastLines: 0,
          unknownRecords: 0,
          turnsEndedWithError: 0,
          unreadableFiles: 0,
          notActions: 0,
          unmappedTools: [],
        },
      }),
      META,
    );
    for (const heading of [
      "Before you share this",
      "How redaction works and where it can miss",
      "What was scanned",
      "What was not evaluated",
    ]) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
    expect(html).toContain("Turn off headers and footers");
    expect(html).toContain("marks where a long command was shortened");
    expect(html.indexOf('id="privacy"')).toBeLessThan(html.indexOf('id="scanned"'));
  });

  it("has no score and no currency in its own words", () => {
    const html = renderReport(resultWith([lib("a.b", "block", 1)]), META);
    expect(html).not.toMatch(/risk score/i);
  });
});
