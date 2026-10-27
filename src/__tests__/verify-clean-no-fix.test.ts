/**
 * A clean card never tells you to fix something.
 *
 * - Over the real card builders, every facts variant a check's rule calls clean renders no fix
 *   steps and no fix commands.
 * - Over real checks, a category that reads clean made no exact fix commands for the fixes file.
 */

import { describe, expect, it } from "vitest";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import type { CardBuilders } from "../core/verify/cards.js";
import { checkCloud, cloudStatus } from "../core/verify/cloud.js";
import { destructiveStatus } from "../core/verify/destructive.js";
import { checkEgress, egressStatus } from "../core/verify/egress.js";
import { lostWorkStatus } from "../core/verify/lost-work.js";
import { prodInfraStatus } from "../core/verify/prod-infra.js";
import { secretsStatus } from "../core/verify/secrets.js";
import { skippedChecksStatus } from "../core/verify/skipped.js";
import { checkTests, testsStatus } from "../core/verify/tests.js";
import { VERIFY_CATEGORIES, type VerifyCategory, type VerifyStatus } from "../core/verify/types.js";
import { unreviewedStatus } from "../core/verify/unreviewed.js";
import {
  checkedOf,
  commitLine,
  git,
  makeRepo,
  rev,
  runChecks,
  setRemoteBranch,
  tempFolder,
} from "./git-check-fixtures.js";
import { FACTS } from "./notes-corpus.js";
import { callsOf, fakeIO, OK, SHIPPED } from "./verify-command-fixtures.js";

/** Each check's own status rule, from its facts. The git checks read one session. */
const STATUS: Record<VerifyCategory, (facts: never) => VerifyStatus> = {
  secrets: secretsStatus,
  "skipped-checks": (f) => skippedChecksStatus(f, 1),
  "lost-work": (f) => lostWorkStatus(f, 1),
  cloud: cloudStatus,
  "prod-infra": prodInfraStatus,
  tests: testsStatus,
  destructive: (f) => destructiveStatus(f, 1),
  unreviewed: unreviewedStatus,
  egress: egressStatus,
};

/** `status` of a category for these facts, by its check's rule. */
function statusOf(category: VerifyCategory, facts: object): VerifyStatus {
  return (STATUS[category] as (facts: object) => VerifyStatus)(facts);
}

/** Every numeric leaf of an object, as a path of keys. Lists are left alone. */
function numericPaths(value: unknown, at: readonly string[] = []): string[][] {
  if (typeof value === "number") return [[...at]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) => numericPaths(inner, [...at, key]));
}

/** `value` with the number at `path` set to `n`. */
function withNumber(value: object, path: readonly string[], n: number): object {
  const [head, ...rest] = path;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    [head as string]: rest.length === 0 ? n : withNumber(record[head as string] as object, rest, n),
  };
}

/** The base facts, every number zeroed, and each number alone at 0, 1 and 2 from both. */
function variants(base: object): object[] {
  const paths = numericPaths(base);
  const zero = paths.reduce((facts, path) => withNumber(facts, path, 0), base);
  const out: object[] = [base, zero];
  for (const start of [base, zero]) {
    for (const path of paths) {
      for (const n of [0, 1, 2]) out.push(withNumber(start, path, n));
    }
  }
  return out;
}

describe("over the real card builders, a clean card gives no fix", () => {
  it.each(VERIFY_CATEGORIES)("%s", (category) => {
    const builder = (CARD_BUILDERS as CardBuilders)[category] as unknown as (
      result: object,
      context: object,
    ) => { fixSteps?: readonly unknown[]; fixes: readonly unknown[] };
    let clean = 0;
    for (const facts of variants(FACTS[category])) {
      if (statusOf(category, facts) !== "clean") continue;
      clean += 1;
      const card = builder({ status: "clean", matches: 3, facts }, { ranEvidence: "tool-result" });
      expect(card.fixSteps ?? [], `${category} ${JSON.stringify(facts)}`).toEqual([]);
      expect(card.fixes, `${category} ${JSON.stringify(facts)}`).toEqual([]);
    }
    // Not vacuous: the rule calls some of these clean.
    expect(clean).toBeGreaterThan(0);
  });

  it("negative control: the secrets card's fix lines appear once a credential is likely real", () => {
    const builder = CARD_BUILDERS.secrets as unknown as (
      result: object,
      context: object,
    ) => { fixSteps?: readonly unknown[] };
    const facts = withNumber(
      withNumber(FACTS.secrets, ["classes", "likely-real"], 1),
      ["classes", "committed-fixture"],
      1,
    );
    expect(statusOf("secrets", facts)).toBe("act");
    expect(builder({ status: "act", matches: 2, facts }, {}).fixSteps).toHaveLength(2);
  });
});

describe("over real checks, a clean category makes no exact fix command", () => {
  it("the git-backed checks: clean with no command; act with one", async () => {
    const root = makeRepo("clean-no-fix", { hooks: ["pre-commit"] });
    // A branch at main's commit, deleted: still on main, so nothing is lost.
    git(root, "branch", "on-main");
    const deleted = git(root, "branch", "-D", "on-main");
    const committed = commitLine(root, "a.txt", "plain commit");
    const clean = await runChecks(
      "claude",
      [
        {
          cwd: root,
          events: [
            { kind: "bash", command: `git commit -m "plain commit"`, output: committed },
            { kind: "bash", command: "git branch -D on-main", output: deleted },
            { kind: "bash", command: "rm -rf node_modules", output: "" },
          ],
        },
      ],
      tempFolder("home"),
      { scratchRoots: [] },
    );
    for (const category of ["skipped-checks", "lost-work", "destructive"] as const) {
      expect(checkedOf(clean[category] as never).status, category).toBe("clean");
      expect(
        clean.localFixes.filter((f) => f.category === category),
        category,
      ).toEqual([]);
    }
    // The same checks do make a command once something is to act on, so the test has teeth.
    const skipped = commitLine(root, "b.txt", "skip hooks", ["--no-verify"]);
    setRemoteBranch(root, "main", rev(root, "HEAD"));
    const act = await runChecks(
      "claude",
      [
        {
          cwd: root,
          events: [
            { kind: "bash", command: `git commit --no-verify -m "skip hooks"`, output: skipped },
          ],
        },
      ],
      tempFolder("home"),
    );
    expect(checkedOf(act["skipped-checks"] as never).status).toBe("act");
    expect(act.localFixes.filter((f) => f.category === "skipped-checks")).not.toEqual([]);
  });

  it("the command checks: clean with no command", async () => {
    const calls = await callsOf("claude", [
      [
        {
          kind: "edit",
          path: "/p/vitest.config.ts",
          old: "thresholds: { lines: 80 }",
          new: "thresholds: { lines: 90 }",
          result: OK,
        },
        { kind: "shell", command: "aws s3 ls", result: OK },
        { kind: "shell", command: "curl http://localhost:3000/health", result: OK },
      ],
    ]);
    const io = fakeIO({ processes: [] });
    const outcomes = {
      tests: await checkTests({ calls, io }),
      cloud: checkCloud({ calls, ...SHIPPED }),
      egress: await checkEgress({ calls, ...SHIPPED, io }),
    };
    for (const [name, outcome] of Object.entries(outcomes)) {
      expect(outcome.check.status, name).toBe("clean");
      expect(outcome.localFixes, name).toEqual([]);
    }
  });
});
