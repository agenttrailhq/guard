// cspell:words pipenv httpx serde
/**
 * The dependency check (`core/verify/deps.ts`): installs that ran, with lockfile restores left
 * out of the install count, and package age not checked because the scan is offline.
 */

import { describe, expect, it } from "vitest";
import { sentences } from "../core/verify/cards.js";
import {
  checkDependencies,
  DEPENDENCY_SENTENCES,
  LOCKFILE_RESTORES_LEFT_OUT,
  readInstalls,
} from "../core/verify/deps.js";
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

  it("says package age was not checked, and how many restores were left out", async () => {
    const facts = await deps([
      { kind: "shell", command: "npm ci", result: OK },
      { kind: "shell", command: "npm ci", result: OK },
    ]);
    expect(sentences(DEPENDENCY_SENTENCES, facts).map((s) => s.text)).toEqual([
      "No install that ran added or changed a package.",
      "2 lockfile restores were left out.",
      "Package age: not checked, because the scan runs offline.",
    ]);
    expect(LOCKFILE_RESTORES_LEFT_OUT.render({ ...facts, lockfileRestores: 0 })).toBeUndefined();
  });
});
