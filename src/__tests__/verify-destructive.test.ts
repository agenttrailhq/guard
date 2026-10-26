// cspell:words dropdb flushdb flushall mysqladmin PGHOST
/**
 * Destructive commands (`core/verify/destructive.ts`): each `rm -rf` target classed against a
 * real temporary repository and home folder, and each database wipe classed by where the
 * database is. Each class boundary, with the ran / mentioned / unknown split.
 *
 * The destructive-looking commands here are test data, held in strings and never run by the
 * check. The files a test removes, it removes from its own temporary folder with `rmSync`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickHeadline } from "../core/verify/cards.js";
import {
  DESTRUCTIVE_TEMPLATES,
  type DestructiveFacts,
  databaseTargetClasses,
  destructiveCard,
  guarded,
  literalPart,
  namesScratch,
  RM_TARGET_CLASSES,
  recursiveRmTargets,
} from "../core/verify/destructive.js";
import type { CardExtras } from "../core/verify/git-copy.js";
import { shellCommands } from "../core/verify/shell-words.js";
import { UNAVAILABLE_VERIFY_IO } from "../core/verify/verify.js";
import {
  checkedOf,
  type GitSession,
  makeRepo,
  quoted,
  runChecks,
  tempFolder,
} from "./git-check-fixtures.js";

/** The context of a scan whose results are recorded. */
const TOOL_RESULT = { ranEvidence: "tool-result" } as const;

/** The destructive result for sessions. */
async function destructive(
  sessions: readonly GitSession[],
  options: {
    agent?: "claude" | "codex" | "cursor";
    home?: string;
    scratchRoots?: readonly string[];
    unavailable?: boolean;
  } = {},
) {
  const outcome = await runChecks(
    options.agent ?? "claude",
    sessions,
    options.home ?? tempFolder("home"),
    {
      scratchRoots: options.scratchRoots ?? [],
      ...(options.unavailable === true ? { io: UNAVAILABLE_VERIFY_IO } : {}),
    },
  );
  return {
    result: checkedOf(outcome.destructive),
    facts: checkedOf(outcome.destructive).facts,
    fixes: outcome.localFixes.filter((f) => f.category === "destructive").map((f) => f.command),
  };
}

/** One session in `cwd` that ran each command. */
function ran(cwd: string | null, ...commands: string[]): GitSession[] {
  return [
    { cwd, events: commands.map((command) => ({ kind: "bash" as const, command, output: "" })) },
  ];
}

/** Every class at zero, then `over`. */
function classes(over: Partial<Record<(typeof RM_TARGET_CLASSES)[number], number>>) {
  return { ...Object.fromEntries(RM_TARGET_CLASSES.map((c) => [c, 0])), ...over };
}

describe("reading rm", () => {
  const targets = (text: string) =>
    recursiveRmTargets(shellCommands(text)[0]?.words.slice(1) ?? []).map((w) => w.value);

  it.each([
    ["rm -rf a b", ["a", "b"]],
    ["rm -fr a", ["a"]],
    ["rm -r -f a", ["a"]],
    ["rm -R a", ["a"]],
    ["rm --recursive --force a", ["a"]],
    ["rm -rf -- -odd", ["-odd"]],
    ["rm -f a", []],
    ["rm a", []],
  ])("%s → %j", (text, expected) => {
    expect(targets(text)).toEqual(expected);
  });

  it.each([
    [`\${DIR:?}/x`, true],
    [`"\${DIR:?}"/"\${SUB:?}"`, true],
    ["$DIR/x", false],
    [`\${DIR}/x`, false],
    [`\${DIR:-/tmp}/x`, false],
    ["$(pwd)/x", false],
    ["`pwd`/x", false],
  ])("guarded(%s) → %s", (raw, expected) => {
    expect(guarded(raw)).toBe(expected);
  });

  it("names scratch only below the folder the command ran in", () => {
    expect(namesScratch("/w/proj/node_modules/x", "/w/proj")).toBe(true);
    expect(namesScratch("/w/proj/dist", "/w/proj")).toBe(true);
    expect(namesScratch("/w/build/proj/src", "/w/build/proj")).toBe(false);
    expect(namesScratch("/elsewhere/.cache", "/w/proj")).toBe(true);
    expect(namesScratch("/elsewhere/src", undefined)).toBe(false);
  });

  it("a glob is read as the folder before its first wildcard", () => {
    expect(literalPart("src/*")).toBe("src");
    expect(literalPart("src/a*.ts")).toBe("src");
    expect(literalPart("*")).toBe(".");
    expect(literalPart("/*")).toBe("/");
    expect(literalPart("plain/path")).toBe("plain/path");
  });
});

describe("rm -rf targets, one per class", () => {
  it("a variable with no guard: act, and the headline", async () => {
    const root = makeRepo("rm-var");
    const { facts, result } = await destructive(
      ran(
        root,
        `rm -rf "$BUILD_DIR/out"`,
        `rm -rf \${CACHE}/x $(pwd)/y`,
        `rm -rf "\${TMP_DIR:?}/z"`,
      ),
    );
    expect(facts.rm.classes).toEqual(classes({ "unguarded-variable": 3, "guarded-variable": 1 }));
    expect(result.status).toBe("act");
    const card = destructiveCard(result, { ranEvidence: "tool-result" });
    expect(card.headline).toEqual({
      basis: "unguarded-recursive-deletes",
      count: 3,
      restsOnCodexRan: false,
      sentence: {
        template: "destructive.headline",
        text: "3 rm -rf targets were built from a variable with no guard.",
      },
    });
    expect(pickHeadline([card], TOOL_RESULT)?.category).toBe("destructive");
  });

  it("scratch, temp and build output: clean", async () => {
    const root = makeRepo("rm-scratch");
    const scratch = tempFolder("scratch-root");
    const { facts, result } = await destructive(
      ran(root, "rm -rf node_modules dist .next build/cache", `rm -rf ${join(scratch, "work")}`),
      { scratchRoots: [scratch] },
    );
    expect(facts.rm.classes).toEqual(classes({ scratch: 5 }));
    expect(facts.rm.targets).toBe(5);
    expect(result.status).toBe("clean");
    expect(destructiveCard(result, { ranEvidence: "tool-result" }).headline).toBeUndefined();
  });

  it("tracked files wholly gone: act, with the exact restore command kept local", async () => {
    const root = makeRepo("rm-tracked", { files: { "src/a.ts": "a\n", "src/b.ts": "b\n" } });
    rmSync(join(root, "src"), { recursive: true });
    const { facts, result, fixes } = await destructive(ran(root, "rm -rf src"));
    expect(facts.rm.classes).toEqual(classes({ tracked: 1 }));
    expect(facts.rm).toMatchObject({ trackedGone: 1, trackedPartlyBack: 0, trackedBack: 0 });
    expect(result.status).toBe("act");
    expect(fixes).toEqual([quoted("git", "-C", root, "restore", "--", "src")]);
    const card = destructiveCard(result, { ranEvidence: "tool-result" });
    expect(card.fixes).toEqual([{ shape: "git restore -- <path>" }]);
    expect(JSON.stringify(card)).not.toContain(root);
    // Missing tracked files are not an unguarded delete: no headline claim.
    expect(card.headline).toBeUndefined();
  });

  it("tracked files partly back: no command restores them as a whole", async () => {
    const root = makeRepo("rm-partly", { files: { "src/a.ts": "a\n", "src/b.ts": "b\n" } });
    rmSync(join(root, "src", "a.ts"));
    const { facts, fixes } = await destructive(ran(root, "rm -rf src"));
    expect(facts.rm).toMatchObject({ trackedGone: 0, trackedPartlyBack: 1 });
    expect(fixes).toEqual([]);
  });

  it("tracked files all back: clean", async () => {
    const root = makeRepo("rm-back", { files: { "src/a.ts": "a\n" } });
    const { facts, result } = await destructive(ran(root, "rm -rf src", "rm -rf src/*"));
    expect(facts.rm.classes).toEqual(classes({ tracked: 2 }));
    expect(facts.rm.trackedBack).toBe(2);
    expect(result.status).toBe("clean");
  });

  it("untracked files in a repo: review", async () => {
    const root = makeRepo("rm-untracked");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "n.txt"), "x\n");
    const { facts, result } = await destructive(ran(root, "rm -rf notes", "rm -rf never-existed"));
    expect(facts.rm.classes).toEqual(classes({ untracked: 2 }));
    expect(result.status).toBe("review");
  });

  it("under the home folder, outside a repo: review", async () => {
    const home = tempFolder("home");
    mkdirSync(join(home, "Downloads", "old"), { recursive: true });
    const { facts, result } = await destructive(
      ran(home, "rm -rf Downloads/old", "rm -rf ~/gone/deep"),
      {
        home,
      },
    );
    expect(facts.rm.classes).toEqual(classes({ home: 2 }));
    expect(result.status).toBe("review");
  });

  it("outside the home folder and outside any repo: other", async () => {
    const elsewhere = tempFolder("elsewhere");
    const { facts } = await destructive(
      ran(elsewhere, `sudo rm -rf ${join(elsewhere, "opt-tool")}`),
    );
    expect(facts.rm.classes).toEqual(classes({ other: 1 }));
  });

  it("a relative target with no known folder, or no way to ask the machine: could-not-check", async () => {
    const none = await destructive(ran(null, "rm -rf src"));
    expect(none.facts.rm.couldNotCheck).toBe(1);
    expect(none.result.status).toBe("could-not-check");
    const root = makeRepo("rm-io");
    const io = await destructive(ran(root, "rm -rf src"), { unavailable: true });
    expect(io.facts.rm.couldNotCheck).toBe(1);
    expect(io.result.status).toBe("could-not-check");
  });
});

describe("ran, mentioned, unknown", () => {
  it("mentions are counted apart", async () => {
    const root = makeRepo("rm-mention");
    const { facts, result } = await destructive(
      ran(
        root,
        `echo "rm -rf build"`,
        `grep -rn "rm -rf $HOME" scripts`,
        "cat > notes.md <<'EOF'\nrm -rf ~/projects\nEOF",
        `grep -rn "psql -h db.example.com -c 'DROP TABLE x'" .`,
      ),
    );
    expect(facts.rm.calls).toEqual({ ran: 0, mentioned: 3, unknown: 0 });
    expect(facts.databases.calls).toEqual({ ran: 0, mentioned: 1, unknown: 0 });
    expect(facts.rm.targets).toBe(0);
    expect(result.status).toBe("clean");
  });

  it("no recorded result: unknown, never clean", async () => {
    const root = makeRepo("rm-unknown");
    const { facts, result } = await destructive([
      { cwd: root, events: [{ kind: "bash", command: "rm -rf dist", noResult: true }] },
    ]);
    expect(facts.rm.calls).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    expect(facts.rm.targets).toBe(0);
    expect(result.status).toBe("could-not-check");
  });

  it("Cursor: unknown. Codex: ran, with the caveat on the card and no headline", async () => {
    const root = makeRepo("rm-apps");
    const cursor = await destructive(
      [{ cwd: root, events: [{ kind: "bash", command: `rm -rf "$X"` }] }],
      {
        agent: "cursor",
      },
    );
    expect(cursor.facts.rm.calls).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    expect(cursor.result.status).toBe("could-not-check");

    const codex = await destructive(ran(root, `rm -rf "$X"`), { agent: "codex" });
    expect(codex.facts.rm.classes["unguarded-variable"]).toBe(1);
    const card = destructiveCard(codex.result, { ranEvidence: "output-record" });
    expect(card.codexCaveat).toBe(true);
    expect(card.headline?.restsOnCodexRan).toBe(true);
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
  });
});

describe("databases", () => {
  it.each([
    [`psql -h db.prod.example.com -c "DROP TABLE users"`, "other"],
    [`psql postgresql://app@10.0.0.5:5432/app -c "DROP TABLE x"`, "other"],
    [`psql -c "DROP DATABASE app_test"`, "scratch"],
    [`psql -h localhost -d app -c "TRUNCATE orders"`, "local"],
    [`PGHOST=db.example.com psql -c "DROP TABLE t"`, "other"],
    [`psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE"`, "unresolved"],
    ["psql app <<'SQL'\nDROP TABLE t;\nSQL", "local"],
    ["dropdb -h 127.0.0.1 app_dev", "local"],
    [`mysql -h db.internal -e "DROP DATABASE shop"`, "other"],
    [`mysql -e "DROP DATABASE shop_tmp"`, "scratch"],
    ["mysqladmin -h localhost drop shop", "local"],
    ["redis-cli FLUSHALL", "local"],
    ["redis-cli -h cache.example.com flushdb", "other"],
    [`mongosh mongodb://db.example.com/app --eval "db.dropDatabase()"`, "other"],
    ["npx prisma migrate reset --force", "unresolved"],
    ["bin/rails db:drop", "unresolved"],
    [`docker exec -it pg psql -U postgres -c "DROP DATABASE app"`, "local"],
    [`kubectl exec db-0 -- psql -c "DROP TABLE x"`, "other"],
    [`ssh prod-db "psql -c 'DROP TABLE x'"`, "other"],
  ])("%s → %s", async (command, expected) => {
    const root = makeRepo("db");
    const { facts } = await destructive(ran(root, command));
    expect(facts.databases.calls.ran).toBe(1);
    expect(facts.databases.classes[expected as "local"]).toBe(1);
  });

  it("a SQLite file in a temp folder is scratch", async () => {
    const root = makeRepo("db-sqlite");
    const scratch = tempFolder("sqlite");
    const { facts } = await destructive(
      ran(
        root,
        `sqlite3 ${join(scratch, "app.db")} "DROP TABLE t"`,
        `sqlite3 app.db "DROP TABLE t"`,
      ),
      {
        scratchRoots: [scratch],
      },
    );
    expect(facts.databases.classes).toEqual({ local: 1, scratch: 1, other: 0, unresolved: 0 });
  });

  it.each([
    `psql -c "SELECT 1"`,
    "redis-cli GET k",
    `mysql -e "SHOW TABLES"`,
    "prisma migrate dev",
  ])("%s is not destructive", async (command) => {
    const root = makeRepo("db-safe");
    const { facts } = await destructive(ran(root, command));
    expect(facts.databases.calls).toEqual({ ran: 0, mentioned: 0, unknown: 0 });
  });

  it("databaseTargetClasses gives the counts of databases wiped by commands that ran", async () => {
    const root = makeRepo("db-export");
    const { result } = await destructive([
      {
        cwd: root,
        events: [
          { kind: "bash", command: `psql -h db.example.com -c "DROP TABLE t"`, output: "" },
          { kind: "bash", command: `psql -c "DROP DATABASE app_test"`, output: "" },
          { kind: "bash", command: `echo "psql -h db2.example.com -c 'DROP TABLE t'"`, output: "" },
          { kind: "bash", command: `psql -h db3.example.com -c "DROP TABLE t"`, noResult: true },
        ],
      },
    ]);
    expect(databaseTargetClasses(result)).toEqual({
      local: 0,
      scratch: 1,
      other: 1,
      unresolved: 0,
    });
    expect(databaseTargetClasses({ status: "not-checked" })).toBeUndefined();
  });

  it("a database on another machine is review; local and scratch alone are clean", async () => {
    const root = makeRepo("db-status");
    expect(
      (await destructive(ran(root, `psql -h db.example.com -c "DROP TABLE t"`))).result.status,
    ).toBe("review");
    expect((await destructive(ran(root, `psql -c "DROP TABLE t"`))).result.status).toBe("clean");
  });
});

describe("the card", () => {
  const none = { ran: 0, mentioned: 0, unknown: 0 };
  /** Facts with every count zero, then `over` applied. */
  function facts(
    over: Partial<DestructiveFacts["rm"]> = {},
    db: Partial<DestructiveFacts["databases"]["classes"]> = {},
  ): DestructiveFacts {
    return {
      unsafeFixes: 0,
      rm: {
        calls: none,
        targets: 0,
        classes: classes({}) as DestructiveFacts["rm"]["classes"],
        trackedBack: 0,
        trackedGone: 0,
        trackedPartlyBack: 0,
        couldNotCheck: 0,
        ...over,
      },
      databases: {
        calls: none,
        classes: { local: 0, scratch: 0, other: 0, unresolved: 0, ...db },
      },
    };
  }

  it("states each class it found, from templates", () => {
    const f = facts(
      {
        calls: { ran: 3, mentioned: 1, unknown: 0 },
        targets: 6,
        classes: classes({
          "unguarded-variable": 1,
          scratch: 3,
          tracked: 1,
          home: 1,
        }) as DestructiveFacts["rm"]["classes"],
        trackedGone: 1,
      },
      { other: 1, local: 2 },
    );
    const card = destructiveCard(
      { status: "act", matches: 5, facts: f },
      { ranEvidence: "tool-result" },
    ) as ReturnType<typeof destructiveCard> & CardExtras;
    const ids = new Set(DESTRUCTIVE_TEMPLATES.map((t) => t.id));
    for (const line of [...card.found, ...card.now, ...(card.fixSteps ?? [])]) {
      expect(ids.has(line.template)).toBe(true);
    }
    expect(card.found.map((s) => s.text)).toEqual([
      "3 rm -rf commands ran, with 6 targets.",
      `1 target was built from a variable with no \${VAR:?} guard, so an empty value deletes from the wrong folder.`,
      "3 targets were scratch, temp or build output.",
      "1 target held files git tracks.",
      "1 target was under the home folder, outside any repo.",
      "3 databases were dropped or wiped: 1 on another machine, 2 local.",
      "1 match only mentioned a delete, and is not counted.",
    ]);
    expect(card.now.map((s) => s.text)).toEqual(["1 tracked target is still gone."]);
    expect(card.chip).toEqual({
      count: 1,
      label: {
        template: "destructive.chip",
        text: "1 rm -rf target built from an unguarded variable",
      },
    });
    expect(card.fixSteps?.map((s) => s.template)).toEqual([
      "destructive.fix.restore",
      "destructive.fix.guard",
      "destructive.fix.outside",
      "destructive.fix.databases",
    ]);
  });

  it("a clean result states zero on its chip and makes no claim that can lead", () => {
    const card = destructiveCard(
      { status: "clean", matches: 0, facts: facts() },
      { ranEvidence: "tool-result" },
    ) as ReturnType<typeof destructiveCard> & CardExtras;
    expect(card.chip?.label.text).toBe("0 rm -rf targets built from an unguarded variable");
    expect(card.found.map((s) => s.text)).toEqual(["No rm -rf and no database wipe ran."]);
    expect(card.headline).toBeUndefined();
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
    expect(card.fixes).toEqual([]);
  });
});
