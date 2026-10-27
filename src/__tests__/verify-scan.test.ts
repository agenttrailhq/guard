/**
 * `scan --verify` through the command: the flag, what changes with it and what does not, the
 * terminal line, and what the report file carries.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScanFlags, runScan, SCAN_USAGE, verificationSummary } from "../commands/scan.js";
import { compileAllowlist } from "../core/evaluate.js";
import { MAX_ROWS, renderReport, reportPayload } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan } from "../core/scan-report.js";
import type { SecretsFacts, Verification } from "../core/verify/types.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { RULE_RM_RF } from "./scan-fixtures.js";
import { writeCorpus } from "./verify-fixtures.js";

const TOKEN = `ghp${"_"}SCANverify0aB1cD2eF3gH4iJ5kL6mN7oP8qR`;
const NOW = new Date("2026-10-01T00:00:00.000Z");

/** One in-process run of `scan` over real files. */
async function scan(argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  const real = createRealScanIO();
  const out: string[] = [];
  const io: ScanIO = {
    ...real,
    homedir: () => mkdtempSync(join(tmpdir(), "agenttrail-verify-scan-home-")),
    cwd: () => mkdtempSync(join(tmpdir(), "agenttrail-verify-scan-work-")),
    writeStdout: (text) => {
      out.push(text);
    },
    writeFile: () => true,
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  const code = await runScan(argv, io, { catalog: [RULE_RM_RF], now: NOW });
  return { code, stdout: out.join("") };
}

describe("the --verify flag", () => {
  it("is off unless given", () => {
    expect(parseScanFlags(["--agent", "claude"]).verify).toBe(false);
    expect(parseScanFlags(["--agent", "claude", "--verify"]).verify).toBe(true);
  });

  it("is in the usage, as a preview that works offline", () => {
    expect(SCAN_USAGE).toContain("--verify");
    expect(SCAN_USAGE).toContain("Preview");
    expect(SCAN_USAGE).toContain("works offline");
  });

  it("the usage says exactly which files on this machine it reads", () => {
    for (const name of [
      "CLAUDE.md",
      "CLAUDE.local.md",
      "AGENTS.md",
      "GEMINI.md",
      ".cursorrules",
      ".windsurfrules",
      ".github/copilot-instructions.md",
      "~/.claude/CLAUDE.md",
      "~/.codex/AGENTS.md",
      "~/.claude, ~/.codex and ~/.cursor",
      "the ones the sessions wrote",
      "only .md and .mdc files",
      "each at most 1 MB",
      "Only whether a file tells the agent to skip checks is",
      "read-only git (rev-parse,",
      "whether the paths the commands named still exist",
      "counts only, never these paths",
    ]) {
      expect(SCAN_USAGE).toContain(name);
    }
  });

  it("the summary says how many instruction files were read, keeping only yes or no", async () => {
    const { root } = await writeCorpus("claude", [[{ kind: "prompt", text: "hello" }]]);
    const { stdout } = await scan(["--agent", "claude", "--dir", root, "--verify"]);
    // No way to reach the machine here: nothing read, and what could not be is said.
    expect(stdout).toMatch(
      /0 instruction or memory files read for an instruction to skip checks, keeping only yes or no \(\d+ could not be read\)/,
    );
  });

  it("without it, --json carries no verification and the summary has no verify line", async () => {
    const { root } = await writeCorpus("claude", [[{ kind: "prompt", text: TOKEN }]]);
    const json = await scan(["--agent", "claude", "--dir", root, "--json"]);
    expect(JSON.parse(json.stdout).result.verification).toBeUndefined();
    const plain = await scan(["--agent", "claude", "--dir", root]);
    expect(plain.stdout).not.toContain("Checked on this machine");
  });

  it("with it, and no way to reach the machine, repos read as could-not-check, never clean", async () => {
    const { root } = await writeCorpus("claude", [[{ kind: "prompt", text: TOKEN }]], {
      cwd: mkdtempSync(join(tmpdir(), "agenttrail-verify-cwd-")),
    });
    const { stdout } = await scan(["--agent", "claude", "--dir", root, "--verify", "--json"]);
    const secrets = JSON.parse(stdout).result.verification.categories.secrets;
    expect(secrets.status).toBe("act");
    expect(secrets.facts.fixtureCheck).toBe("unavailable");
    expect(secrets.facts.reposNotChecked).toBe(1);
  });

  it.each([
    ["claude", "tool-result", true],
    ["codex", "output-record", true],
    ["cursor", "none", false],
  ] as const)("%s: --json says what a ran count rests on", async (agent, evidence, recorded) => {
    const { root } = await writeCorpus(agent, [[{ kind: "prompt", text: "hello" }]]);
    const { stdout } = await scan(["--agent", agent, "--dir", root, "--verify", "--json"]);
    const v = JSON.parse(stdout).result.verification;
    expect(v.ranEvidence).toBe(evidence);
    expect(v.resultsRecorded).toBe(recorded);
  });

  it("every category without a check reads not-checked, and the git-backed ones ran", async () => {
    const { root } = await writeCorpus("claude", [[{ kind: "prompt", text: "hello" }]]);
    const { stdout } = await scan(["--agent", "claude", "--dir", root, "--verify", "--json"]);
    const categories = JSON.parse(stdout).result.verification.categories;
    expect(Object.keys(categories)).toEqual([
      "secrets",
      "skipped-checks",
      "lost-work",
      "cloud",
      "prod-infra",
      "tests",
      "destructive",
      "unreviewed",
      "egress",
    ]);
    // The git-backed checks ran over a session with no commands. With no way to reach the
    // machine, the instruction files could not be read, so skipped checks can never be clean.
    const checked = [
      "secrets",
      "skipped-checks",
      "lost-work",
      "cloud",
      "prod-infra",
      "tests",
      "destructive",
      "unreviewed",
      "egress",
    ];
    for (const [name, value] of Object.entries(categories)) {
      if (!checked.includes(name)) expect(value).toEqual({ status: "not-checked" });
    }
    expect(categories["skipped-checks"].status).toBe("could-not-check");
    expect(categories["skipped-checks"].facts.instructions.couldNotRead).toBeGreaterThan(0);
    for (const name of ["lost-work", "destructive"]) {
      expect(categories[name].status).toBe("clean");
    }
    expect(categories.secrets.status).toBe("clean");
    // Nothing ran, so the command checks found nothing.
    for (const name of ["cloud", "tests", "unreviewed"]) {
      expect(categories[name].status, name).toBe("clean");
    }
    // With no way to reach the machine, the running programs cannot be listed, so egress never
    // reads as clean. The database targets come from the destructive-commands check, which
    // found none, so the production check is clean.
    expect(categories.egress.status).toBe("could-not-check");
    expect(categories["prod-infra"].status).toBe("clean");
    expect(categories["prod-infra"].facts.databaseCheck).toBe("checked");
  });
});

/** Secrets facts with every count zero, then `over` applied. */
function facts(over: Partial<SecretsFacts> = {}): SecretsFacts {
  return {
    classes: { "likely-real": 0, "committed-fixture": 0, placeholder: 0, "local-dev": 0 },
    items: [],
    moreItems: 0,
    filesRead: 1,
    filesNotRead: 0,
    unplaced: 0,
    setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
    fixtureCheck: "not-needed",
    reposChecked: 0,
    reposNotChecked: 0,
    ...over,
  };
}

/** A verification with the given secrets facts and status. */
function verification(
  over: Partial<SecretsFacts> = {},
  status: Verification["categories"]["secrets"]["status"] = "clean",
  rest: Partial<Pick<Verification, "matchedCalls" | "resultsRecorded" | "ranEvidence">> = {},
): Verification {
  const pending = { status: "not-checked" } as const;
  return {
    matchedCalls: { ran: 2, mentioned: 1, unknown: 0 },
    resultsRecorded: true,
    ranEvidence: "tool-result",
    ...rest,
    categories: {
      secrets: { status, matches: 0, facts: facts(over) },
      "skipped-checks": pending,
      "lost-work": pending,
      cloud: pending,
      "prod-infra": pending,
      tests: pending,
      destructive: pending,
      unreviewed: pending,
      egress: pending,
    },
  };
}

describe("the terminal line", () => {
  it("states each class found and the calls by whether they ran", () => {
    const line = verificationSummary(
      verification(
        {
          classes: { "likely-real": 3, "committed-fixture": 1, placeholder: 2, "local-dev": 1 },
          filesRead: 12,
          fixtureCheck: "complete",
          reposChecked: 2,
        },
        "act",
      ),
    );
    expect(line).toBe(
      "Checked on this machine (read-only, offline): 3 likely-real credentials in 12 transcript " +
        "files (and 1 committed fixture, 2 placeholders or false positives, 1 local dev value); " +
        "2 matched calls ran, 1 only mentioned a command, 0 could not be confirmed.",
    );
  });

  it("says what could not be done", () => {
    const line = verificationSummary(
      verification(
        {
          filesNotRead: 2,
          unplaced: 1,
          fixtureCheck: "partial",
          reposNotChecked: 1,
          reposChecked: 1,
        },
        "could-not-check",
      ),
    );
    expect(line).toContain("2 transcript files could not be read");
    expect(line).toContain("1 redacted text could not be classed");
    expect(line).toContain("1 repo could not be searched for committed fixtures");
  });

  it("says how many values were set aside, and why, only when there were some", () => {
    const line = verificationSummary(
      verification(
        {
          classes: { "likely-real": 0, "committed-fixture": 0, placeholder: 5, "local-dev": 0 },
          setAside: { unnamedOutputOnly: 3, namedNotCredentialShaped: 1 },
        },
        "clean",
      ),
    );
    expect(line).toContain(
      "4 values not counted as likely real: 3 unnamed and seen only in output or replies, 1 named but not shaped like a credential",
    );
    const one = verificationSummary(
      verification({ setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 1 } }, "clean"),
    );
    expect(one).toContain("1 value not counted as likely real: 1 named but not shaped");
    expect(one).not.toContain("unnamed");
    expect(verificationSummary(verification())).not.toContain("not counted");
  });

  it("says when no repo was found to search", () => {
    expect(verificationSummary(verification({ fixtureCheck: "unavailable" }, "act"))).toContain(
      "no repo was found to search for committed fixtures",
    );
  });

  it("says when there was nothing to check", () => {
    expect(verificationSummary(verification({ filesRead: 0 }, "not-checked"))).toContain(
      "no transcript files to check for secrets",
    );
  });

  it("says an app with no recorded output cannot confirm a run", () => {
    const line = verificationSummary(
      verification({}, "clean", {
        resultsRecorded: false,
        matchedCalls: { ran: 0, mentioned: 2, unknown: 3 },
      }),
    );
    expect(line).toContain(
      "no matched call could be confirmed as run (2 matches only mentioned a command)",
    );
    const none = verificationSummary(
      verification({}, "clean", {
        resultsRecorded: false,
        matchedCalls: { ran: 0, mentioned: 0, unknown: 1 },
      }),
    );
    expect(none).not.toContain("only mentioned");
  });

  it("says a Codex ran count may include blocked calls, and only when it has one", () => {
    const codex = verificationSummary(verification({}, "clean", { ranEvidence: "output-record" }));
    expect(codex).toContain(
      "a Codex call with an output record counts as ran, which may include blocked calls",
    );
    const none = verificationSummary(
      verification({}, "clean", {
        ranEvidence: "output-record",
        matchedCalls: { ran: 0, mentioned: 1, unknown: 1 },
      }),
    );
    expect(none).not.toContain("blocked");
    expect(verificationSummary(verification())).not.toContain("blocked");
  });

  it("on a Codex scan, always says the Codex reading is limited and unverified", () => {
    const unverified =
      "the Codex reading is limited and unverified: it is tested on synthetic sessions only";
    for (const matchedCalls of [
      { ran: 2, mentioned: 0, unknown: 0 },
      { ran: 0, mentioned: 0, unknown: 0 },
    ]) {
      expect(
        verificationSummary(
          verification({}, "clean", { ranEvidence: "output-record", matchedCalls }),
        ),
      ).toContain(unverified);
    }
    for (const ranEvidence of ["tool-result", "none"] as const) {
      expect(verificationSummary(verification({}, "clean", { ranEvidence }))).not.toContain(
        "unverified",
      );
    }
  });

  it("a real Codex scan's terminal line says so", async () => {
    const { root } = await writeCorpus("codex", [[{ kind: "prompt", text: "hello" }]]);
    const { stdout } = await scan(["--agent", "codex", "--dir", root, "--verify"]);
    expect(stdout).toContain("the Codex reading is limited and unverified");
  });

  it("is one line", () => {
    expect(verificationSummary(verification())).not.toContain("\n");
  });
});

describe("what the report file carries", () => {
  const corpus = { sessions: [], quarantined: 0, notRead: 0, projects: 0 };
  const catalog = compileCatalog([RULE_RM_RF]);
  const meta = { version: "0.0.0", generatedAt: NOW };

  it("no verification: the payload and the page are what they were", () => {
    const plain = aggregateScan(corpus, catalog, compileAllowlist([]));
    expect("verification" in reportPayload(plain, meta)).toBe(false);
    expect(renderReport(plain, meta)).not.toContain("likely-real");
  });

  it("with verification: a field-by-field copy, its list capped at the row cap", () => {
    const many = Array.from({ length: MAX_ROWS + 7 }, () => ({
      kind: "github-token" as const,
      via: ["pasted-into-prompt" as const],
      files: 1,
    }));
    const v = verification({ items: many, moreItems: 3 }, "act");
    const result = aggregateScan(corpus, catalog, compileAllowlist([]), new Set(), v);
    expect(result.verification).toBe(v);
    const carried = reportPayload(result, meta).verification;
    expect(carried?.categories.secrets.facts.items).toHaveLength(MAX_ROWS);
    expect(carried?.categories.secrets.facts.moreItems).toBe(10);
    expect(carried?.matchedCalls).toEqual(v.matchedCalls);
    expect(carried?.ranEvidence).toBe("tool-result");
    expect(carried?.categories.cloud).toEqual({ status: "not-checked" });
    expect(carried?.categories.secrets.facts.items[0]).not.toBe(many[0]);
  });

  it("with verification on a reader that counts skips, both are carried", () => {
    const v = verification();
    const result = aggregateScan(
      { ...corpus, agent: "cursor", capabilities: { tokens: false, skips: true } },
      catalog,
      compileAllowlist([]),
      new Set(),
      v,
    );
    const payload = reportPayload(result, meta);
    expect(payload.skipped).toBeDefined();
    expect(payload.verification?.resultsRecorded).toBe(true);
  });
});
