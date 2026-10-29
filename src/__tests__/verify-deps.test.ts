// cspell:words pipenv httpx serde
/**
 * The dependency check (`core/verify/deps.ts`): installs that ran, with lockfile restores left
 * out of the install count, and package age not checked because the scan is offline.
 */

import { describe, expect, it } from "vitest";
import { checkDependencies, type DependencyFacts, readInstalls } from "../core/verify/deps.js";
import { verifiedNote } from "../core/verify/notes.js";
import type { Verification } from "../core/verify/types.js";
import { type CommandEvent, callsOf, OK } from "./verify-command-fixtures.js";

async function deps(
  events: readonly CommandEvent[],
  agent: "claude" | "codex" | "cursor" = "claude",
) {
  return checkDependencies(await callsOf(agent, [events]));
}

describe("reading installs", () => {
  it.each([
    ["npm ci", "npm", true],
    ["npm install", "npm", true],
    ["npm install left-pad", "npm", false],
    ["npm i -D vitest", "npm", false],
    ["pnpm install --frozen-lockfile", "pnpm", true],
    ["pnpm add zod", "pnpm", false],
    ["yarn", "yarn", true],
    ["yarn add react", "yarn", false],
    ["bun install", "bun", true],
    ["pip install -r requirements.txt", "pip", true],
    ["pip install -e .", "pip", true],
    ["python3 -m pip install requests", "pip", false],
    ["uv sync", "uv", true],
    ["uv pip install httpx", "uv", false],
    ["poetry install", "poetry", true],
    ["poetry add httpx", "poetry", false],
    ["pipenv install", "pipenv", true],
    ["pipenv install flask", "pipenv", false],
    ["cargo add serde", "cargo", false],
    ["go mod download", "go", true],
    ["go get example.invalid/mod@v1.2.3", "go", false],
    ["bundle install", "bundler", true],
    ["composer require vendor/pkg", "composer", false],
  ] as const)("%s → %s, restore %s", (command, manager, restore) => {
    expect(readInstalls(command)).toEqual([{ manager, restore }]);
  });

  it("is not an install: running a package, listing, or another program", () => {
    for (const command of [
      "npx vitest",
      "npm run build",
      "npm ls",
      "pip list",
      "cargo build",
      "go test ./...",
    ]) {
      expect(readInstalls(command), command).toEqual([]);
    }
  });
});

describe("the check", () => {
  it("restores are left out of the install count", async () => {
    const facts = await deps([
      { kind: "shell", command: "npm ci", result: OK },
      { kind: "shell", command: "pnpm install && pnpm add zod", result: OK },
      { kind: "shell", command: "pip install -r requirements.txt", result: OK },
      { kind: "shell", command: "pip install requests", result: OK },
    ]);
    expect(facts).toEqual({
      installs: 2,
      lockfileRestores: 3,
      managers: ["pnpm", "pip"],
      packageAge: "not-checked-offline",
      mentioned: 0,
      unconfirmed: 0,
      couldHide: 0,
      hidingForms: [],
    });
  });

  it("only mentioned, or unconfirmed, is not an install", async () => {
    const facts = await deps([
      { kind: "shell", command: `cat > README.md <<EOF\nnpm install left-pad\nEOF`, result: OK },
      { kind: "shell", command: "npm install left-pad" },
    ]);
    expect(facts).toMatchObject({ installs: 0, mentioned: 1, unconfirmed: 1 });
  });

  it("Cursor: nothing confirmed as run", async () => {
    const facts = await deps([{ kind: "shell", command: "npm install left-pad" }], "cursor");
    expect(facts).toMatchObject({ installs: 0, unconfirmed: 1 });
  });

  it("the rendered note says package age was not checked, and leaves restores out of the count", async () => {
    const facts = await deps([
      { kind: "shell", command: "npm ci", result: OK },
      { kind: "shell", command: "pnpm add zod", result: OK },
      { kind: "shell", command: "npm ci", result: OK },
    ]);
    expect(noteOf(facts)).toBe(
      "1 package install ran, not counting 2 lockfile restores. Package age is not checked: the scan runs offline.",
    );
  });

  it("the rendered note on restores alone calls the match a false positive", async () => {
    const facts = await deps([
      { kind: "shell", command: "npm ci", result: OK },
      { kind: "shell", command: "npm ci", result: OK },
    ]);
    expect(noteOf(facts)).toBe("False positive: the 2 installs that ran only restored a lockfile.");
  });

  it("no install and no restore: no note, never a line that says none ran", async () => {
    expect(noteOf(await deps([{ kind: "shell", command: "make", result: OK }]))).toBeUndefined();
  });
});

/** The note the report renders under the dependency guardrail, for these facts. */
function noteOf(facts: DependencyFacts): string | undefined {
  const verification = {
    matchedCalls: { ran: 1, mentioned: 0, unknown: 0 },
    resultsRecorded: true,
    ranEvidence: "tool-result",
    categories: {},
    dependencies: facts,
  } as unknown as Verification;
  return verifiedNote({ ruleId: "flag-dependency-install", source: "library" }, verification, [])
    ?.sentence.text;
}
