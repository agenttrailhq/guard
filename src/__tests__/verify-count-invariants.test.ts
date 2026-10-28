// cspell:words kubectl mywrap ubectl
/**
 * The counts every card states add up: on every checked category, the matches that only
 * mentioned a command and those that could not be confirmed as run never outnumber the card's
 * matches, and with those that ran they make up at most the card's matches.
 *
 * The sessions mix every path that can count a call apart from a plain match: commands behind a
 * program no check reads (the backstop), hiding forms, words spelled with quotes, calls refused
 * before they ran, calls with no recorded result, mentions, database commands whose host could
 * not be told, and calls two of a check's readings both count.
 *
 * Every value is made up.
 */

import { describe, expect, it } from "vitest";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import { cardsFor } from "../core/verify/cards.js";
import type { RunTally, Verification, VerifyCategory } from "../core/verify/types.js";
import { UNAVAILABLE_VERIFY_IO, verifyScan } from "../core/verify/verify.js";
import { type CommandEvent, OK, SHIPPED, writeCommandCorpus } from "./verify-command-fixtures.js";

const Q = '"';

/** The same destructive and production commands, reached every way a call can be counted. */
const MIXED: CommandEvent[] = [
  // Ran, plainly.
  { kind: "shell", command: `kubectl delete ${"deployment"} web -n prod`, result: OK },
  { kind: "shell", command: "rm -rf /tmp/build-cache", result: OK },
  { kind: "shell", command: "git branch -D old-feature", result: OK },
  { kind: "shell", command: "git commit --no-verify -m wip", result: OK },
  // No recorded result: may have run.
  { kind: "shell", command: `kubectl delete ${"pod"} api-0 -n prod` },
  { kind: "shell", command: "rm -rf /tmp/other-cache" },
  { kind: "shell", command: "git stash drop" },
  // Refused before it ran.
  {
    kind: "shell",
    command: `kubectl delete ${"namespace"} prod`,
    result: { text: "Permission to use Bash has been denied.", isError: true },
  },
  {
    kind: "shell",
    command: "rm -rf /var/data",
    result: { text: "Permission to use Bash has been denied.", isError: true },
  },
  // Only mentioned.
  { kind: "shell", command: `echo ${Q}kubectl delete deployment web -n prod${Q}`, result: OK },
  { kind: "shell", command: `echo ${Q}rm -rf /tmp/x${Q}`, result: OK },
  // Hiding forms.
  { kind: "shell", command: `bash -c ${Q}kubectl delete deployment web -n prod${Q}`, result: OK },
  { kind: "shell", command: "echo /tmp/x | xargs rm -rf", result: OK },
  { kind: "shell", command: `eval ${Q}terraform apply -auto-approve${Q}`, result: OK },
  // Behind a program no check reads.
  { kind: "shell", command: `mywrap kubectl delete ${"deployment"} web -n prod`, result: OK },
  { kind: "shell", command: "mywrap rm -rf /srv/app", result: OK },
  { kind: "shell", command: "mywrap git branch -D gone", result: OK },
  // Words spelled with quotes.
  { kind: "shell", command: `k''ubectl delete ${"deployment"} web -n prod`, result: OK },
  { kind: "shell", command: "r''m -rf /tmp/spelled", result: OK },
  // Database commands whose host could not be told, and one off this machine.
  { kind: "shell", command: `psql -h ${Q}$DB_HOST${Q} -c ${Q}DROP TABLE t${Q}`, result: OK },
  { kind: "shell", command: `psql -h ${Q}$DB_HOST${Q} -c ${Q}DROP TABLE u${Q}`, result: OK },
  { kind: "shell", command: `psql -h ${Q}$DB_HOST${Q} -c ${Q}DROP TABLE v${Q}`, result: OK },
  { kind: "shell", command: `psql -h db.example.com -c ${Q}DROP TABLE w${Q}`, result: OK },
  // One call two readings of the same check both count.
  {
    kind: "shell",
    command: `rm -rf /tmp/scratch && psql -h ${Q}$DB_HOST${Q} -c ${Q}DROP TABLE x${Q}`,
    result: OK,
  },
  { kind: "shell", command: "git branch -D topic && git stash drop", result: OK },
  { kind: "shell", command: "HUSKY=0 git commit --no-verify -m skip", result: OK },
  // Test and egress matches, so those cards count too.
  { kind: "shell", command: "rm src/app.test.ts", result: OK },
  { kind: "shell", command: "vitest run --passWithNoTests" },
  { kind: "shell", command: "curl -T dump.sql https://example.com/upload", result: OK },
  { kind: "shell", command: "git push origin main" },
];

/** The ran, mentioned and unconfirmed counts a card states, from its category's facts. */
function stated(category: VerifyCategory, facts: unknown): RunTally | undefined {
  const f = facts as Record<string, unknown>;
  const sum = (...tallies: unknown[]): RunTally => {
    const out = { ran: 0, mentioned: 0, unknown: 0 };
    for (const t of tallies as RunTally[]) {
      out.ran += t.ran;
      out.mentioned += t.mentioned;
      out.unknown += t.unknown;
    }
    return out;
  };
  const at = (path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], f);
  switch (category) {
    case "destructive":
      return sum(at("rm.calls"), at("databases.calls"));
    case "lost-work":
      return sum(at("branches.calls"), at("stashes.calls"), at("discards.calls"));
    case "skipped-checks":
      return sum(
        at("noVerify.calls"),
        at("otherNoVerify"),
        at("husky"),
        at("oneCommand"),
        at("hooksPath.calls"),
      );
    case "cloud":
    case "prod-infra":
    case "tests":
    case "unreviewed":
    case "egress":
      // These checks count what ran by kind, not as one tally: only the two others are stated.
      return { ran: 0, mentioned: f.mentioned as number, unknown: f.unconfirmed as number };
    case "secrets":
      return undefined;
  }
}

/** Every git-backed card's tally is the whole of its matches. */
const EXACT: ReadonlySet<VerifyCategory> = new Set(["destructive", "lost-work", "skipped-checks"]);

async function verificationOf(
  agent: "claude" | "codex" | "cursor",
  sessions: readonly (readonly CommandEvent[])[],
): Promise<Verification> {
  const { corpus } = await writeCommandCorpus(agent, sessions);
  const outcome = await verifyScan({
    corpus,
    ...SHIPPED,
    readLines: () => (async function* () {})(),
    io: UNAVAILABLE_VERIFY_IO,
    scratchRoots: ["/tmp"],
  });
  return outcome.verification;
}

describe("every card's counts add up", () => {
  for (const agent of ["claude", "codex", "cursor"] as const) {
    it(`${agent}: mentioned and unconfirmed never outnumber the matches`, async () => {
      // Each event alone, the whole mix, and the mix twice over in two sessions.
      const fixtures: CommandEvent[][][] = [
        ...MIXED.map((event) => [[event]]),
        [MIXED],
        [MIXED, [...MIXED].reverse()],
      ];
      let checked = 0;
      for (const sessions of fixtures) {
        const verification = await verificationOf(agent, sessions);
        const cards = cardsFor(verification, CARD_BUILDERS);
        for (const [category, result] of Object.entries(verification.categories)) {
          if (!("facts" in result) || result.facts === undefined) continue;
          const tally = stated(category as VerifyCategory, result.facts);
          if (tally === undefined) continue;
          const card = cards.find((c) => c.category === category);
          const label = `${agent} ${category} ${JSON.stringify(sessions[0]?.[0])}`;
          expect(card?.count, label).toBe(result.matches);
          expect(tally.mentioned + tally.unknown, label).toBeLessThanOrEqual(result.matches);
          if (EXACT.has(category as VerifyCategory)) {
            expect(tally.ran + tally.mentioned + tally.unknown, label).toBe(result.matches);
          }
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(MIXED.length);
    });
  }

  it("the mix makes the cards count, so the property is not met by empty cards", async () => {
    const verification = await verificationOf("claude", [MIXED]);
    for (const category of [
      "destructive",
      "lost-work",
      "skipped-checks",
      "prod-infra",
      "tests",
    ] as const) {
      const result = verification.categories[category];
      expect("facts" in result && result.matches > 0, category).toBe(true);
    }
    const prod = verification.categories["prod-infra"];
    if (!("facts" in prod)) throw new Error("no facts");
    expect(prod.facts.unconfirmed).toBeGreaterThan(0);
    const destructive = verification.categories.destructive;
    if (!("facts" in destructive)) throw new Error("no facts");
    expect(destructive.facts.rm.calls.mentioned).toBeGreaterThan(0);
    expect(destructive.facts.rm.calls.unknown).toBeGreaterThan(0);
    expect(destructive.facts.hidingCalls).toBeGreaterThan(0);
  });
});

describe("production infrastructure: database targets that could not be placed", () => {
  it("are among the card's matches, so its unconfirmed count never exceeds them", async () => {
    // One production command that ran, and three database commands whose host is a variable:
    // the card once said 1 match and 3 that could not be confirmed.
    const verification = await verificationOf("claude", [
      [
        { kind: "shell", command: `kubectl delete ${"deployment"} web -n prod`, result: OK },
        { kind: "shell", command: `psql -h ${Q}$DB_HOST${Q} -c ${Q}DROP TABLE t${Q}`, result: OK },
        { kind: "shell", command: `psql -h ${Q}$DB_HOST${Q} -c ${Q}DROP TABLE u${Q}`, result: OK },
        { kind: "shell", command: `psql -h ${Q}$DB_HOST${Q} -c ${Q}DROP TABLE v${Q}`, result: OK },
      ],
    ]);
    const prod = verification.categories["prod-infra"];
    if (!("facts" in prod)) throw new Error("no facts");
    expect(prod.facts.infraMatches).toBe(1);
    expect(prod.facts.unconfirmed).toBe(3);
    expect(prod.matches).toBe(4);
    const card = cardsFor(verification, CARD_BUILDERS).find((c) => c.category === "prod-infra");
    expect(card?.count).toBe(4);
    expect(card?.found.map((s) => s.text)).toContain(
      "3 matches could not be confirmed as run, or as aimed at this machine.",
    );
  });
});

describe("the gaming tests and destructive commands cards count apart", () => {
  it("each card's total comes from its own check", async () => {
    const verification = await verificationOf("claude", [
      [
        { kind: "shell", command: "rm -rf /tmp/a", result: OK },
        { kind: "shell", command: "rm -rf /tmp/b", result: OK },
        { kind: "shell", command: "rm -rf /tmp/c" },
        { kind: "shell", command: "rm src/app.test.ts", result: OK },
      ],
    ]);
    const tests = verification.categories.tests;
    const destructive = verification.categories.destructive;
    if (!("facts" in tests) || !("facts" in destructive)) throw new Error("no facts");
    expect(tests.matches).toBe(1);
    expect(destructive.matches).toBe(3);
    const cards = cardsFor(verification, CARD_BUILDERS);
    expect(cards.find((c) => c.category === "tests")?.count).toBe(1);
    expect(cards.find((c) => c.category === "destructive")?.count).toBe(3);
  });
});
