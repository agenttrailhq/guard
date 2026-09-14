/**
 * `core/scan-report.ts` — the pure aggregator, and its counts.
 *
 * Every number asserted here is hand-computed against the fixture catalog in
 * `scan-fixtures.ts`, never read back out of `SHIPPED_CATALOG`, so growing the
 * shipped catalog moves nothing in this file.
 *
 * The redaction assertions matter as much as the counts: `ScanResult` is redacted by
 * construction, so proving it here proves it for every consumer — the HTML, the JSON
 * and the terminal summary — instead of once per renderer.
 */

import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { compileAllowlist } from "../core/evaluate.js";
import { TRUNCATION_MARKER } from "../core/mapper.js";
import { REDACTION_PREFIX } from "../core/redaction.js";
import { compileCatalog } from "../core/rules.js";
import {
  aggregateScan,
  displayTextOf,
  MAX_DISPLAY_LEN,
  redactForReport,
  redactTitle,
  type ScanCorpus,
  type ScanResult,
} from "../core/scan-report.js";
import { bash, RULE_RM_RF, session, TEST_CATALOG, toolUse, turn } from "./scan-fixtures.js";

const CATALOG = compileCatalog(TEST_CATALOG);
const NO_ALLOWLIST = compileAllowlist([]);

function corpusOf(
  sessions: ScanCorpus["sessions"],
  projects = 1,
  quarantined = 0,
  notRead = 0,
): ScanCorpus {
  return { sessions, quarantined, projects, notRead };
}

describe("counts", () => {
  it("counts sessions, tool calls and risky actions independently", () => {
    const result = aggregateScan(
      corpusOf([
        session([turn([bash("rm -rf /tmp/x", "1"), bash("ls -la", "2")])]),
        session([turn([bash("git checkout -- src/a.ts", "3")])]),
      ]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.sessions).toBe(2);
    expect(result.toolCalls).toBe(3);
    expect(result.riskyActions).toBe(2);
  });

  it("a session whose every tool call is benign still counts as a session", () => {
    const result = aggregateScan(
      corpusOf([session([turn([bash("ls -la", "1"), bash("git status", "2")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.sessions).toBe(1);
    expect(result.toolCalls).toBe(2);
    expect(result.riskyActions).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.recurring).toEqual([]);
  });

  it("an empty corpus produces zeroes, not an error", () => {
    const result = aggregateScan(corpusOf([], 0), CATALOG, NO_ALLOWLIST);
    expect(result.sessions).toBe(0);
    expect(result.toolCalls).toBe(0);
    expect(result.tokens.turns).toBe(0);
  });

  it("carries the quarantine and skipped-line tallies rather than hiding them", () => {
    // One corrupt file must not lose the other 940, and it must not be silent either.
    const result = aggregateScan(
      corpusOf([session([turn([bash("ls", "1")])], 3), session([turn([])], 2)], 1, 4),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.quarantined).toBe(4);
    expect(result.skippedLines).toBe(5);
  });

  it("carries the not-read tally, so an under-read corpus is stated and not silent", () => {
    // Transcript files one directory deeper than the reader walks are counted, not
    // silently skipped: a scan over part of the corpus that reported a confident number
    // would be as silent a failure as one that over-claims.
    const result = aggregateScan(corpusOf([session([turn([])])], 1, 0, 750), CATALOG, NO_ALLOWLIST);
    expect(result.notRead).toBe(750);
  });

  it("a call matching TWO guardrails counts once as risky and once under each guardrail", () => {
    // `riskyActions` is calls, `finding.count` is matches. Conflating them would
    // inflate the hero number by the number of overlapping rules.
    const twoRuleCommand = "rm -rf /tmp/x && git checkout -- src/a.ts";
    const result = aggregateScan(
      corpusOf([session([turn([bash(twoRuleCommand, "1")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.riskyActions).toBe(1);
    expect(result.findings.map((f) => f.ruleId).sort()).toEqual(["t.git-checkout", "t.rm-rf"]);
    expect(result.findings.every((f) => f.count === 1)).toBe(true);
  });
});

describe("findings", () => {
  it("names the guardrail, its title, severity and effective action", () => {
    const result = aggregateScan(
      corpusOf([session([turn([toolUse("Read", { file_path: "/srv/app/.env" }, "1")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: "t.env-file",
      title: "Reading a .env file",
      severity: "high",
      action: "require_approval",
      count: 1,
    });
  });

  it("a guardrail that never matched is ABSENT, not present with a zero", () => {
    const result = aggregateScan(
      corpusOf([session([turn([bash("rm -rf /tmp/x", "1")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.findings.map((f) => f.ruleId)).toEqual(["t.rm-rf"]);
  });

  it("orders findings by count, then by guardrail id, so two runs render identically", () => {
    const calls = [
      bash("git checkout -- a.ts", "1"),
      bash("git checkout -- b.ts", "2"),
      bash("rm -rf /tmp/x", "3"),
    ];
    const result = aggregateScan(corpusOf([session([turn(calls)])]), CATALOG, NO_ALLOWLIST);
    expect(result.findings.map((f) => [f.ruleId, f.count])).toEqual([
      ["t.git-checkout", 2],
      ["t.rm-rf", 1],
    ]);
  });

  it("respects the allowlist, so a silenced guardrail leaves the others firing", () => {
    const allowlist = compileAllowlist([{ guardrail: "t.rm-rf", pattern: "rm -rf /tmp/**" }]);
    const result = aggregateScan(
      corpusOf([
        session([turn([bash("rm -rf /tmp/x", "1"), bash("git checkout -- src/a.ts", "2")])]),
      ]),
      CATALOG,
      allowlist,
    );
    expect(result.findings.map((f) => f.ruleId)).toEqual(["t.git-checkout"]);
  });

  it("a disabled guardrail does not appear, because compileCatalog dropped it", () => {
    const narrowed = compileCatalog(TEST_CATALOG, {
      enabledPacks: undefined,
      guardrailActionOverrides: {},
      disabledGuardrails: ["t.rm-rf"],
    });
    const result = aggregateScan(
      corpusOf([session([turn([bash("rm -rf /tmp/x", "1")])])]),
      narrowed,
      NO_ALLOWLIST,
    );
    expect(result.findings).toEqual([]);
  });
});

describe("recurring repeats", () => {
  it("a shape seen twice is a repeat; a shape seen once is not", () => {
    const result = aggregateScan(
      corpusOf([
        session([
          turn([
            bash("git checkout -- /Users/priya/app/a.ts", "1"),
            bash("git checkout -- /Users/priya/app/b.ts", "2"),
            bash("rm -rf /tmp/once", "3"),
          ]),
        ]),
      ]),
      CATALOG,
      NO_ALLOWLIST,
    );
    // The two checkouts differ only in their path, so redaction makes them ONE shape
    // seen twice — which is what makes a repeat count mean anything.
    expect(result.recurring).toEqual([
      {
        text: "git checkout -- <path>",
        count: 2,
        ruleId: "t.git-checkout",
        title: "Discards uncommitted work",
      },
    ]);
  });

  it("orders repeats by count, then lexically", () => {
    const calls = [
      ...[1, 2, 3].map((i) => bash("rm -rf /tmp/a", `r${i}`)),
      ...[1, 2].map((i) => bash("git checkout -- src/x.ts", `g${i}`)),
    ];
    const result = aggregateScan(corpusOf([session([turn(calls)])]), CATALOG, NO_ALLOWLIST);
    expect(result.recurring.map((r) => [r.text, r.count])).toEqual([
      ["rm -rf <path>", 3],
      ["git checkout -- <path>", 2],
    ]);
  });
});

describe("everything in the result is redacted", () => {
  it("a planted secret never reaches the finding text", () => {
    const command = "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE && rm -rf /tmp/x";
    const result = aggregateScan(
      corpusOf([session([turn([bash(command, "1")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    const text = JSON.stringify(result);
    expect(command).toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain(REDACTION_PREFIX);
  });

  it("a real home-directory path never reaches the finding text", () => {
    const command = "rm -rf /Users/priya/clients/acme-secret-client/build";
    const result = aggregateScan(
      corpusOf([session([turn([bash(command, "1")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    const text = JSON.stringify(result);
    for (const segment of ["priya", "acme-secret-client"]) {
      expect(command).toContain(segment);
      expect(text).not.toContain(segment);
    }
  });

  it("the session's own cwd is not carried into the result", () => {
    // `ParsedSession.cwd` is the project path. It is read for nothing and emitted
    // nowhere — the report shows a project COUNT, never a project.
    const result = aggregateScan(
      corpusOf([session([turn([bash("rm -rf /tmp/x", "1")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(JSON.stringify(result)).not.toContain("/Users/priya");
    expect(result.projects).toBe(1);
  });

  it("a file-tool finding renders as tool plus redacted path", () => {
    const result = aggregateScan(
      corpusOf([
        session([turn([toolUse("Read", { file_path: "/Users/priya/acme/.env.production" }, "1")])]),
      ]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.findings[0]?.examples[0]?.text).toBe("Read <path>");
  });

  it("no currency WORD appears anywhere in a result", () => {
    // Words only. A currency SYMBOL is legitimate inside a command shape — a real
    // report carried `${DB}` and `$?` — and `report.test.ts` polices the symbol where
    // it matters, in the guard's own chrome.
    const result = aggregateScan(
      corpusOf([session([turn([bash("rm -rf /tmp/x", "1")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(JSON.stringify(result)).not.toMatch(/\bUSD\b|\bdollars?\b|\bestimated\b/i);
  });

  it("a shell variable survives into the shape, so a coverage limit stays visible", () => {
    // `rm -rf $DIR` is a documented MISS of the rm rule — the target is only known at
    // run time. Redacting the variable would hide the coverage limit the rule
    // description states.
    const result = aggregateScan(
      corpusOf([session([turn([bash("rm -rf /tmp/x && rm -rf $DIR", "1")])])]),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.findings[0]?.examples[0]?.text).toContain("$DIR");
  });
});

describe("display text", () => {
  it("middle-truncates a very long command, keeping the head and the tail", () => {
    const command = `rm -rf ${"a".repeat(500)}END`;
    const text = displayTextOf({ tool: "Bash", args: { full_command: command } });
    expect(text.length).toBeLessThanOrEqual(MAX_DISPLAY_LEN);
    expect(text).toContain(TRUNCATION_MARKER);
    expect(text.startsWith("rm -rf")).toBe(true);
    expect(text.endsWith("END")).toBe(true);
  });

  it("flattens a multi-line command into one row", () => {
    // Found on real data. A heredoc or a `&&`-chained script is genuinely multi-line;
    // printed verbatim it turned one row of the terminal table into five and broke the
    // alignment of every row after it.
    const command = "cd /srv/app\n  git push --force-with-lease 2>&1 | tail -1\n\ngit status";
    const text = displayTextOf({ tool: "Bash", args: { full_command: command } });
    expect(text).not.toContain("\n");
    expect(text).toBe("cd <path> git push --force-with-lease 2>&1 | tail -1 git status");
  });

  it("re-indenting a script does not make it a different repeat", () => {
    // The repeat key IS this string, so whitespace differences would split one
    // recurring mistake into several singletons and hide it.
    const a = displayTextOf({ tool: "Bash", args: { full_command: "rm -rf /a  &&  ls" } });
    const b = displayTextOf({ tool: "Bash", args: { full_command: "rm -rf /a\n&& ls" } });
    expect(a).toBe(b);
  });

  it("a call with neither channel renders as the bare tool name", () => {
    expect(displayTextOf({ tool: "WebFetch", args: {} })).toBe("WebFetch");
  });

  it("redactForReport is the composition, exported so it can be read in one place", () => {
    expect(redactForReport("cat /Users/priya/.env")).toBe("cat <path>");
  });
});

/**
 * The guardrail TITLE is redacted too.
 *
 * `scan` appends the user's own `guardrails.json` to the catalog, so a title is not our
 * copy — it is whatever the author typed on that machine, in a file designed to be
 * shared. This module's invariant, "nothing in `ScanResult` is derived from an
 * unredacted string", covers it.
 *
 * The two assertions that matter pull in opposite directions, and both are needed: it
 * must actually redact, and it must not damage the shipped library's titles.
 */
describe("a guardrail title is redacted too, and the limit of that is stated", () => {
  const withTitle = (title: string): ScanResult =>
    aggregateScan(
      corpusOf([session([turn([bash("rm -rf /Users/priya/clients/acme/build", "1")])])]),
      compileCatalog([{ ...RULE_RM_RF, title }]),
      NO_ALLOWLIST,
    );

  it("a container name in a title is taken out", () => {
    expect(withTitle("Audit docker exec acme-prod-db").findings[0]?.title).toBe(
      "Audit docker exec <name>",
    );
  });

  it("a secret pasted into a title becomes a placeholder", () => {
    const out = withTitle("Ban AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE").findings[0]?.title ?? "";
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain(REDACTION_PREFIX);
  });

  it("a PATH in a title survives — the residual the path pass would have cost 11% to close", () => {
    // The trade, stated as a test: `redactPaths` is omitted for titles because it turns 6
    // of the shipped library's 56 titles into "git stash drop <path> clear", reading `/`
    // as the filesystem root where the author meant "or". See `redactTitle`.
    const title = "Watch writes under /Users/priya/clients/acme-secret-client";
    expect(withTitle(title).findings[0]?.title).toBe(title);
  });

  it("an author's own PROSE survives, and that residual is deliberate", () => {
    // The limit of title redaction: nothing distinguishes a client's name from an ordinary
    // noun. A wider rule would blank the shipped library's titles too, which is why the
    // report's copy names the limit and `scan --review` prints titles beside commands.
    const title = "AcmeCorp internal audit";
    expect(withTitle(title).findings[0]?.title).toBe(title);
  });

  it("the FULL composition would damage the shipped library — why redactTitle exists", () => {
    // The negative control for the omission: the path pass WOULD damage these titles, so
    // leaving it out is a deliberate choice rather than a harmless one.
    const damaged = SHIPPED_CATALOG.filter((r) => redactForReport(r.title) !== r.title);
    expect(damaged.length).toBeGreaterThan(0);
    expect(damaged.every((r) => redactTitle(r.title) === r.title)).toBe(true);
  });

  it("every shipped catalog title passes through unchanged — the collateral-damage check", () => {
    // The cost side of the decision, asserted over the real library rather than a
    // fixture: if redacting titles mangled the guardrails users actually see, that would
    // be a worse regression than the leak it closes.
    for (const rule of SHIPPED_CATALOG) {
      expect(redactTitle(rule.title), `"${rule.title}" was damaged by redaction`).toBe(rule.title);
    }
    expect(SHIPPED_CATALOG.length).toBeGreaterThan(10);
  });
});
