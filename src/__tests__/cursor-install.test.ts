/**
 * `init --agent cursor` and `uninstall --agent cursor`.
 *
 * Most cases run through in-memory seams (`cursor-files.ts` and a `SetupIO` double), so no
 * test reads or writes a real `~/.cursor/hooks.json` or runs `claude`. The last block runs the
 * real file seam in a scratch home, for what a double cannot show: modes on disk, the
 * rename, and a symbolic link.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../commands/init.js";
import { runUninstall } from "../commands/uninstall.js";
import { hasGuardCursorEntry, isGuardCursorCommand } from "../core/cursor-entry.js";
import { VERSION } from "../core/version.js";
import { type CursorFileIO, createRealCursorFileIO } from "../cursor/cursor-io.js";
import {
  addGuardEntries,
  cursorHookCommand,
  removeGuardEntries,
  sameHooksApartFromGuard,
} from "../cursor/install.js";
import { type ClaudeRunner, createRealSetupIO, type SetupIO } from "../setup-io.js";
import {
  type FakeCursorFiles,
  type FakeCursorFilesOptions,
  type FakeFile,
  fakeCursorFiles,
} from "./cursor-files.js";

const HOME = "/home/test";
const SCAFFOLD = "/pkg/plugin";
const HOOK_SOURCE = `${SCAFFOLD}/scripts/guard-hook.mjs`;
const BUNDLE = "// the bundled hook\n";
const NODE = "/usr/local/bin/node";
const HOOKS = `${HOME}/.cursor/hooks.json`;
const CURSOR_DIR = `${HOME}/.agenttrail/guard/cursor`;
const COPY = `${CURSOR_DIR}/guard-hook.mjs`;
const BACKUP = `${CURSOR_DIR}/hooks.json.backup`;
const ABSENT = `${CURSOR_DIR}/hooks.json.was-absent`;
const RECORD = `${CURSOR_DIR}/install.json`;
const CONFIG = `${HOME}/.agenttrail/guard/config.json`;
const RULES = `${HOME}/.agenttrail/guard/guardrails.json`;
const NOW = new Date("2026-09-15T00:00:00.000Z");
const COMMAND = `"${NODE}" "${COPY}" --agent cursor`;
const ENTRY = { command: COMMAND, timeout: 10 };

/** A `hooks.json` a user already has: two hooks of their own, compact, no trailing newline. */
const ORIGINAL =
  '{"version":1,"hooks":{"afterFileEdit":[{"command":"./format.sh"}],"preToolUse":[{"command":"./audit.sh","timeout":5}]}}';

/** One machine: a `SetupIO` double, an in-memory Cursor file seam, and what was done. */
interface Machine {
  readonly setup: SetupIO;
  readonly cursor: FakeCursorFiles;
  /** Paths `SetupIO.writeFileAtomic` wrote, in order. */
  readonly setupWrites: string[];
  /** Every `claude` invocation. */
  readonly claudeCalls: string[][];
  /** Everything printed since the last call, and clears it. */
  takeOut(): string;
}

function machine(
  options: {
    readonly hooks?: string | FakeFile;
    readonly files?: Readonly<Record<string, string | FakeFile>>;
    readonly setupFiles?: Readonly<Record<string, string>>;
    readonly bundle?: boolean;
  } & Omit<FakeCursorFilesOptions, "files"> = {},
): Machine {
  const printed: string[] = [];
  const setupWrites: string[] = [];
  const claudeCalls: string[][] = [];
  const setupFiles = new Map(Object.entries(options.setupFiles ?? {}));
  const runClaude: ClaudeRunner = (args) => {
    claudeCalls.push([...args]);
    return { code: null, stdout: "", stderr: "", spawnError: "ENOENT" };
  };
  const setup: SetupIO = {
    writeStdout: (text) => {
      printed.push(text);
    },
    readFile: (path) => setupFiles.get(path),
    exists: (path) => setupFiles.has(path),
    writeFileAtomic: (path, text) => {
      setupWrites.push(path);
      setupFiles.set(path, text);
    },
    homedir: () => HOME,
    runClaude,
  };
  const cursor = fakeCursorFiles({
    ...options,
    files: {
      ...(options.bundle === false ? {} : { [HOOK_SOURCE]: BUNDLE }),
      ...(options.hooks === undefined ? {} : { [HOOKS]: options.hooks }),
      ...options.files,
    },
  });
  return {
    setup,
    cursor,
    setupWrites,
    claudeCalls,
    takeOut: () => printed.splice(0).join(""),
  };
}

function install(
  m: Machine,
  extra: { readonly print?: boolean; readonly nodePath?: string } = {},
): Promise<number> {
  return runInit(
    m.setup,
    { agent: "cursor", print: extra.print === true },
    { scaffoldDir: SCAFFOLD, cursorIo: m.cursor.io, nodePath: extra.nodePath ?? NODE, now: NOW },
  );
}

function uninstall(m: Machine): Promise<number> {
  return runUninstall(m.setup, { agent: "cursor" }, { cursorIo: m.cursor.io });
}

const textOf = (m: Machine, path: string): string | undefined => m.cursor.files.get(path)?.text;

const jsonOf = (m: Machine, path: string): Record<string, unknown> =>
  JSON.parse(textOf(m, path) ?? "null");

/** Nothing written, deleted or run: the promise every refusal makes. */
function expectNothingChanged(m: Machine): void {
  expect(m.cursor.writes).toEqual([]);
  expect(m.cursor.deletes).toEqual([]);
  expect(m.setupWrites).toEqual([]);
  expect(m.claudeCalls).toEqual([]);
}

/** `text` with one more hook of the user's own, under `event`, after anything already there. */
function withUserHook(text: string, event: string, command: string): string {
  const doc = JSON.parse(text);
  doc.hooks[event] = [...(doc.hooks[event] ?? []), { command }];
  return JSON.stringify(doc, null, 2);
}

describe("init --agent cursor, with no ~/.cursor/hooks.json", () => {
  it("writes both entries, the hook copy, the install record and the no-file record; exit 0", async () => {
    const m = machine();
    expect(await install(m)).toBe(0);

    expect(jsonOf(m, HOOKS)).toEqual({
      version: 1,
      hooks: { preToolUse: [ENTRY], beforeShellExecution: [ENTRY] },
    });
    expect(m.cursor.files.get(HOOKS)?.mode).toBe(0o600);
    expect(textOf(m, COPY)).toBe(BUNDLE);
    expect(m.cursor.files.get(COPY)?.mode).toBe(0o600);
    expect(textOf(m, ABSENT)).toBe("");
    expect(m.cursor.files.has(BACKUP)).toBe(false);
    expect(jsonOf(m, RECORD)).toEqual({
      installedAt: NOW.toISOString(),
      hookPath: COPY,
      nodePath: NODE,
      guardVersion: VERSION,
    });
    // `config.json` and `guardrails.json` are seeded as `--agent claude` seeds them.
    expect(m.setupWrites).toEqual([CONFIG, RULES]);
    // Guard's own files first, and Cursor's file last.
    expect(m.cursor.writes.map((w) => w.path)).toEqual([COPY, ABSENT, RECORD, HOOKS]);
    expect(m.claudeCalls).toEqual([]);
  });

  it("writes entries that the hook and status recognise as guard's Cursor install", async () => {
    const m = machine();
    await install(m);
    expect(isGuardCursorCommand(COMMAND)).toBe(true);
    expect(hasGuardCursorEntry(textOf(m, HOOKS))).toBe(true);

    // A Node path with spaces in it still gives a recognised entry.
    const spaced = machine();
    expect(await install(spaced, { nodePath: "/Applications/Node Tools/bin/node" })).toBe(0);
    expect(hasGuardCursorEntry(textOf(spaced, HOOKS))).toBe(true);
  });

  it("ends with the demonstration init --agent claude prints", async () => {
    const m = machine();
    await install(m);
    const out = m.takeOut();
    expect(out).toContain(
      `Installed for Cursor: a preToolUse entry and a beforeShellExecution entry in ${HOOKS}.`,
    );
    expect(out).toContain("Here it is working");
    expect(out).toContain("$ rm -rf /");
    expect(out).toContain("BLOCKED");
    expect(out).toContain("evaluated, not executed");
    expect(out).toMatch(/guardrail library v\d+\.\d+\.\d+/);
    expect(out).toContain("agenttrail-guard status");
  });
});

describe("init --agent cursor, over an existing hooks.json", () => {
  it("keeps every other key, hook and order, adds at the end, and backs the file up as it was", async () => {
    const original =
      '{"hooks":{"afterFileEdit":[{"command":"./format.sh"}],"preToolUse":[{"command":"./audit.sh","timeout":5}]},"version":1,"note":"kept"}';
    const m = machine({ hooks: original });
    expect(await install(m)).toBe(0);

    const doc = jsonOf(m, HOOKS);
    expect(doc).toEqual({
      hooks: {
        afterFileEdit: [{ command: "./format.sh" }],
        preToolUse: [{ command: "./audit.sh", timeout: 5 }, ENTRY],
        beforeShellExecution: [ENTRY],
      },
      version: 1,
      note: "kept",
    });
    expect(Object.keys(doc)).toEqual(["hooks", "version", "note"]);
    expect(Object.keys(doc.hooks as object)).toEqual([
      "afterFileEdit",
      "preToolUse",
      "beforeShellExecution",
    ]);
    expect(textOf(m, BACKUP)).toBe(original);
    expect(m.cursor.files.has(ABSENT)).toBe(false);
    expect(m.takeOut()).toContain(`Saved the earlier ${HOOKS} as ${BACKUP}.`);
  });

  it("replaces an earlier guard entry instead of adding a second one", async () => {
    const old = `"/old/bin/node" "${COPY}" --agent cursor`;
    const m = machine({
      hooks: JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: "./audit.sh" }, { command: old, timeout: 10 }],
          beforeShellExecution: [{ command: old, timeout: 10 }],
        },
      }),
    });
    expect(await install(m)).toBe(0);
    expect(jsonOf(m, HOOKS)).toEqual({
      version: 1,
      hooks: { preToolUse: [{ command: "./audit.sh" }, ENTRY], beforeShellExecution: [ENTRY] },
    });
    expect(m.takeOut()).toContain(`Updated guard's entries in ${HOOKS}.`);
  });

  it("keeps a mode that is not the default", async () => {
    const m = machine({ hooks: { text: ORIGINAL, mode: 0o640 } });
    expect(await install(m)).toBe(0);
    expect(m.cursor.files.get(HOOKS)?.mode).toBe(0o640);
  });

  it("accepts a file with no version and no hooks key, and adds them", async () => {
    const m = machine({ hooks: '{"note":"x"}' });
    expect(await install(m)).toBe(0);
    const doc = jsonOf(m, HOOKS);
    expect(Object.keys(doc)).toEqual(["version", "note", "hooks"]);
    expect(doc.version).toBe(1);
  });
});

describe("init --agent cursor refuses a hooks.json it will not change, and changes nothing", () => {
  it.each([
    ["not JSON", "{not json", "is not valid JSON"],
    ["an array", "[]", "is not a JSON object"],
    ["a string", '"hooks"', "is not a JSON object"],
    ["version 2", '{"version":2,"hooks":{}}', "has version 2, not 1"],
    ["version as a string", '{"version":"1","hooks":{}}', 'has version "1", not 1'],
    ["hooks as an array", '{"version":1,"hooks":[]}', 'has a "hooks" value that is not an object'],
    ["hooks as null", '{"version":1,"hooks":null}', 'has a "hooks" value that is not an object'],
    [
      "a hook list that is an object",
      '{"version":1,"hooks":{"preToolUse":{}}}',
      'has a "preToolUse" hook list that is not an array',
    ],
    [
      "another app's hook list that is a string",
      '{"version":1,"hooks":{"afterFileEdit":"./x.sh"}}',
      'has a "afterFileEdit" hook list that is not an array',
    ],
  ])("%s", async (_label, text, reason) => {
    const m = machine({ hooks: text });
    expect(await install(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} ${reason}. Nothing was changed.`);
    expectNothingChanged(m);
    expect(textOf(m, HOOKS)).toBe(text);
  });

  it("a read-only hooks.json", async () => {
    const m = machine({ hooks: { text: ORIGINAL, mode: 0o444 } });
    expect(await install(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} is read-only. Nothing was changed.`);
    expectNothingChanged(m);
  });

  it("a hooks.json it cannot read, rather than taking it for a missing file", async () => {
    const m = machine({ hooks: ORIGINAL, failReads: [HOOKS] });
    expect(await install(m)).toBe(1);
    expect(m.takeOut()).toContain(`could not read ${HOOKS}`);
    expectNothingChanged(m);
  });

  it("a missing hook bundle", async () => {
    const m = machine({ bundle: false });
    expect(await install(m)).toBe(1);
    expect(m.takeOut()).toContain(`could not find guard's hook at ${HOOK_SOURCE}`);
    expectNothingChanged(m);
  });

  it.each([
    ["a double quote", '/opt/no"de/bin/node'],
    ["a dollar sign", "/opt/$HOME/bin/node"],
    ["a backtick", "/opt/`id`/bin/node"],
    ["a line break", "/opt/no\nde/bin/node"],
  ])("a Node path holding %s, which a shell would not keep as written", async (_label, nodePath) => {
    const m = machine();
    expect(await install(m, { nodePath })).toBe(1);
    expect(m.takeOut()).toContain("Nothing was changed.");
    expectNothingChanged(m);
  });
});

describe("init --agent cursor when a write does not go through", () => {
  it("the system refuses the hooks.json write: exit 1, and the file is as it was", async () => {
    const m = machine({ hooks: ORIGINAL, failWrites: [HOOKS] });
    expect(await install(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} was not changed.`);
    expect(textOf(m, HOOKS)).toBe(ORIGINAL);
  });

  it("another program changes hooks.json while guard installs: guard does not write over it", async () => {
    const other = withUserHook(ORIGINAL, "stop", "./other.sh");
    const m = machine({
      hooks: ORIGINAL,
      beforeRead: (path, earlierReads, files) => {
        if (path === HOOKS && earlierReads === 1) files.set(HOOKS, { text: other, mode: 0o644 });
      },
    });
    expect(await install(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} changed while guard was installing`);
    expect(textOf(m, HOOKS)).toBe(other);
    expect(m.cursor.writes.map((w) => w.path)).not.toContain(HOOKS);
  });
});

describe("a repeated init --agent cursor", () => {
  it.each([
    ["no hooks.json before", undefined],
    ["an existing hooks.json", ORIGINAL],
  ])("with %s, the second run changes nothing", async (_label, hooks) => {
    const m = machine(hooks === undefined ? {} : { hooks });
    expect(await install(m)).toBe(0);
    const afterFirst = textOf(m, HOOKS);
    const writes = m.cursor.writes.length;
    const seeds = m.setupWrites.length;
    m.takeOut();

    expect(await install(m)).toBe(0);
    expect(m.cursor.writes).toHaveLength(writes);
    expect(m.cursor.deletes).toEqual([]);
    expect(m.setupWrites).toHaveLength(seeds);
    expect(textOf(m, HOOKS)).toBe(afterFirst);
    expect(m.takeOut()).toContain(`Already installed for Cursor: ${HOOKS} runs ${COPY}.`);
  });

  it("keeps the first backup when hooks.json has changed since", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    const changed = withUserHook(textOf(m, HOOKS) ?? "", "stop", "./later.sh");
    m.cursor.files.set(HOOKS, { text: changed, mode: 0o644 });

    expect(await install(m)).toBe(0);
    expect(textOf(m, BACKUP)).toBe(ORIGINAL);
    expect(m.cursor.files.has(ABSENT)).toBe(false);
  });

  it("keeps the record that there was no file, and takes no backup of guard's own file", async () => {
    const m = machine();
    await install(m);
    const changed = withUserHook(textOf(m, HOOKS) ?? "", "stop", "./later.sh");
    m.cursor.files.set(HOOKS, { text: changed, mode: 0o600 });

    expect(await install(m)).toBe(0);
    expect(m.cursor.files.has(ABSENT)).toBe(true);
    expect(m.cursor.files.has(BACKUP)).toBe(false);
  });

  it("with another Node: the entries and the record move to it, and no old entry is left", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    expect(await install(m, { nodePath: "/opt/node/bin/node" })).toBe(0);

    const newEntry = { command: `"/opt/node/bin/node" "${COPY}" --agent cursor`, timeout: 10 };
    const hooks = jsonOf(m, HOOKS).hooks as Record<string, unknown[]>;
    expect(hooks.preToolUse).toEqual([{ command: "./audit.sh", timeout: 5 }, newEntry]);
    expect(hooks.beforeShellExecution).toEqual([newEntry]);
    expect(jsonOf(m, RECORD).nodePath).toBe("/opt/node/bin/node");
    expect(textOf(m, BACKUP)).toBe(ORIGINAL);
  });
});

describe("init --agent cursor --print", () => {
  it("writes nothing, runs nothing, and names each file and the entry it would add", async () => {
    const m = machine();
    expect(await install(m, { print: true })).toBe(0);
    expectNothingChanged(m);
    const out = m.takeOut();
    expect(out).toContain(
      "init --agent cursor --print — this is what would happen. Nothing is changed.",
    );
    for (const path of [CONFIG, RULES, COPY, ABSENT, RECORD])
      expect(out).toContain(`write   ${path}`);
    expect(out).toContain(`write   ${HOOKS}  (a new file, mode 0600)`);
    expect(out).toContain("adds this entry at the end of preToolUse and of beforeShellExecution:");
    expect(out).toContain(JSON.stringify(ENTRY));
    expect(out).not.toContain("BLOCKED");
  });

  it("over an existing file, names the backup and the mode it keeps", async () => {
    const m = machine({ hooks: { text: ORIGINAL, mode: 0o640 } });
    expect(await install(m, { print: true })).toBe(0);
    expectNothingChanged(m);
    const out = m.takeOut();
    expect(out).toContain(`write   ${BACKUP}  (${HOOKS} as it is now, mode 0600)`);
    expect(out).toContain(`write   ${HOOKS}  (keeps its mode 0640)`);
  });

  it("says where it would stop, exits 0, and still writes nothing", async () => {
    const m = machine({ hooks: '{"version":2}' });
    expect(await install(m, { print: true })).toBe(0);
    expectNothingChanged(m);
    expect(m.takeOut()).toContain(`It would STOP: ${HOOKS} has version 2, not 1.`);
  });

  it("once installed, says there is nothing to change in hooks.json", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    const writes = m.cursor.writes.length;
    m.takeOut();
    expect(await install(m, { print: true })).toBe(0);
    expect(m.cursor.writes).toHaveLength(writes);
    expect(m.takeOut()).toContain("already runs this copy — nothing to change there");
  });
});

describe("uninstall --agent cursor", () => {
  it("after an install over an existing file: its exact bytes and mode are back, and guard's files are gone", async () => {
    const m = machine({ hooks: { text: ORIGINAL, mode: 0o640 } });
    await install(m);
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    expect(textOf(m, HOOKS)).toBe(ORIGINAL);
    expect(m.cursor.files.get(HOOKS)?.mode).toBe(0o640);
    expect(hasGuardCursorEntry(textOf(m, HOOKS))).toBe(false);
    for (const path of [COPY, RECORD, BACKUP, ABSENT]) expect(m.cursor.files.has(path)).toBe(false);
    expect(m.takeOut()).toContain("it is back to how it was before the install");
    expect(m.claudeCalls).toEqual([]);
  });

  it("after an install over no file: the file guard created is removed", async () => {
    const m = machine();
    await install(m);
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    expect(m.cursor.files.has(HOOKS)).toBe(false);
    expect(hasGuardCursorEntry(textOf(m, HOOKS))).toBe(false);
    for (const path of [COPY, RECORD, BACKUP, ABSENT]) expect(m.cursor.files.has(path)).toBe(false);
    expect(m.takeOut()).toContain(
      `Removed ${HOOKS}: guard created it, and nothing else was in it.`,
    );
  });

  it("when the user added hooks since the install: guard's entries go, and every other hook stays", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    let changed = withUserHook(textOf(m, HOOKS) ?? "", "preToolUse", "./later.sh");
    changed = withUserHook(changed, "stop", "./stop.sh");
    m.cursor.files.set(HOOKS, { text: changed, mode: 0o644 });
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    expect(jsonOf(m, HOOKS)).toEqual({
      version: 1,
      hooks: {
        afterFileEdit: [{ command: "./format.sh" }],
        preToolUse: [{ command: "./audit.sh", timeout: 5 }, { command: "./later.sh" }],
        stop: [{ command: "./stop.sh" }],
      },
    });
    expect(hasGuardCursorEntry(textOf(m, HOOKS))).toBe(false);
    expect(m.cursor.files.has(BACKUP)).toBe(false);
    expect(m.takeOut()).toContain("Every other hook in it is untouched.");
  });

  it("after an install over no file, a hook the user added since keeps the file", async () => {
    const m = machine();
    await install(m);
    m.cursor.files.set(HOOKS, {
      text: withUserHook(textOf(m, HOOKS) ?? "", "afterFileEdit", "./format.sh"),
      mode: 0o600,
    });

    expect(await uninstall(m)).toBe(0);
    expect(jsonOf(m, HOOKS)).toEqual({
      version: 1,
      hooks: { afterFileEdit: [{ command: "./format.sh" }] },
    });
  });

  it("running it twice is not an error, and the second run changes nothing", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    await uninstall(m);
    const writes = m.cursor.writes.length;
    const deletes = m.cursor.deletes.length;
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    expect(m.cursor.writes).toHaveLength(writes);
    expect(m.cursor.deletes).toHaveLength(deletes);
    expect(m.takeOut()).toContain("Guard is not installed for Cursor — nothing to remove.");
  });

  it("leaves config.json, guardrails.json, events.jsonl and crashes/ alone", async () => {
    const crash = `${HOME}/.agenttrail/guard/crashes/1.json`;
    const events = `${HOME}/.agenttrail/guard/events.jsonl`;
    const m = machine({
      hooks: ORIGINAL,
      files: { [crash]: "{}", [events]: "{}\n" },
      setupFiles: { [CONFIG]: "{}", [RULES]: "[]", [events]: "{}\n" },
    });
    await install(m);
    const seeds = m.setupWrites.length;

    expect(await uninstall(m)).toBe(0);
    expect(m.setupWrites).toHaveLength(seeds);
    expect(m.cursor.files.has(crash)).toBe(true);
    expect(m.cursor.files.has(events)).toBe(true);
    for (const path of m.cursor.deletes) {
      expect([HOOKS, COPY, RECORD, BACKUP, ABSENT]).toContain(path);
    }
  });

  it("refuses a hooks.json it will not change, and keeps guard's files", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    m.cursor.files.set(HOOKS, { text: "{broken", mode: 0o644 });
    m.takeOut();

    expect(await uninstall(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} is not valid JSON. Nothing was changed.`);
    expect(m.cursor.deletes).toEqual([]);
    expect(m.cursor.files.has(COPY)).toBe(true);
  });

  it("refuses a read-only hooks.json, and keeps guard's files", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    const installed = textOf(m, HOOKS) ?? "";
    m.cursor.files.set(HOOKS, { text: installed, mode: 0o444 });
    m.takeOut();

    expect(await uninstall(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} is read-only. Nothing was changed.`);
    expect(textOf(m, HOOKS)).toBe(installed);
    expect(m.cursor.files.has(COPY)).toBe(true);
  });

  it("does not restore a backup that itself holds guard's entries", async () => {
    const withGuard = JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{ command: "./audit.sh" }, ENTRY], beforeShellExecution: [ENTRY] },
    });
    const m = machine({ hooks: withGuard, files: { [BACKUP]: withGuard, [RECORD]: "{}" } });

    expect(await uninstall(m)).toBe(0);
    expect(jsonOf(m, HOOKS)).toEqual({
      version: 1,
      hooks: { preToolUse: [{ command: "./audit.sh" }] },
    });
  });
});

describe("the hooks.json helpers", () => {
  const INPUTS = [
    undefined,
    ORIGINAL,
    '{"note":"x"}',
    '{"version":1,"hooks":{"preToolUse":[],"stop":[{"command":"./s.sh"}]}}',
    JSON.stringify({
      version: 1,
      hooks: { beforeShellExecution: [ENTRY, { command: "./after.sh" }] },
    }),
  ];

  it.each(INPUTS)("addGuardEntries on its own output gives the same text (%s)", (text) => {
    const once = addGuardEntries(text, COMMAND);
    if (!once.ok) throw new Error(once.reason);
    const twice = addGuardEntries(once.text, COMMAND);
    expect(twice).toEqual({ ok: true, text: once.text, removed: 2 });
  });

  it.each(
    INPUTS.filter((text): text is string => text !== undefined && !text.includes("--agent cursor")),
  )("removeGuardEntries undoes addGuardEntries, up to formatting (%s)", (text) => {
    const added = addGuardEntries(text, COMMAND);
    if (!added.ok) throw new Error(added.reason);
    const removed = removeGuardEntries(added.text);
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.removed).toBe(2);
    expect(sameHooksApartFromGuard(removed.text, text)).toBe(true);
  });

  it("sameHooksApartFromGuard ignores key order, formatting, empty lists and a missing version", () => {
    const a = '{"version":1,"hooks":{"stop":[{"command":"./s.sh","timeout":5}],"preToolUse":[]}}';
    const b = JSON.stringify({ hooks: { stop: [{ timeout: 5, command: "./s.sh" }] } }, null, 4);
    expect(sameHooksApartFromGuard(a, b)).toBe(true);
    // The negative controls: a changed command, a changed order of entries, and a file
    // that is not JSON all count as different.
    expect(sameHooksApartFromGuard(a, a.replace("./s.sh", "./t.sh"))).toBe(false);
    const two = '{"hooks":{"stop":[{"command":"./a"},{"command":"./b"}]}}';
    expect(
      sameHooksApartFromGuard(two, '{"hooks":{"stop":[{"command":"./b"},{"command":"./a"}]}}'),
    ).toBe(false);
    expect(sameHooksApartFromGuard("{broken", "{broken")).toBe(false);
  });

  it("cursorHookCommand quotes both paths, and refuses characters a shell would change", () => {
    expect(cursorHookCommand("/a b/node", "/c d/guard-hook.mjs")).toBe(
      '"/a b/node" "/c d/guard-hook.mjs" --agent cursor',
    );
    expect(cursorHookCommand('/a"b/node', COPY)).toBeUndefined();
    expect(cursorHookCommand(NODE, "/home/$USER/guard-hook.mjs")).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("on a real file system, in a scratch home", () => {
  /** A scratch home with a bundled hook to copy, and the real seams pointed at it. */
  function realMachine() {
    const home = mkdtempSync(join(tmpdir(), "agenttrail-guard-cursor-install-"));
    const scaffold = join(home, "pkg", "plugin");
    mkdirSync(join(scaffold, "scripts"), { recursive: true });
    writeFileSync(join(scaffold, "scripts", "guard-hook.mjs"), BUNDLE);
    const claudeCalls: string[][] = [];
    const setup: SetupIO = {
      ...createRealSetupIO(),
      writeStdout: () => {},
      homedir: () => home,
      runClaude: (args) => {
        claudeCalls.push([...args]);
        return { code: null, stdout: "", stderr: "", spawnError: "ENOENT" };
      },
    };
    const files: CursorFileIO = createRealCursorFileIO();
    const hooksPath = join(home, ".cursor", "hooks.json");
    return {
      home,
      hooksPath,
      claudeCalls,
      init: () =>
        runInit(
          setup,
          { agent: "cursor" },
          { scaffoldDir: scaffold, cursorIo: files, nodePath: process.execPath, now: NOW },
        ),
      uninstall: () => runUninstall(setup, { agent: "cursor" }, { cursorIo: files }),
    };
  }

  const modeOf = (path: string): number => statSync(path).mode & 0o777;

  it("keeps the file's mode, leaves no temp file, and uninstall puts the exact bytes back", async () => {
    const m = realMachine();
    mkdirSync(join(m.home, ".cursor"));
    writeFileSync(m.hooksPath, ORIGINAL);
    chmodSync(m.hooksPath, 0o640);

    expect(await m.init()).toBe(0);
    expect(modeOf(m.hooksPath)).toBe(0o640);
    expect(hasGuardCursorEntry(readFileSync(m.hooksPath, "utf8"))).toBe(true);
    expect(readdirSync(join(m.home, ".cursor"))).toEqual(["hooks.json"]);
    const copy = join(m.home, ".agenttrail", "guard", "cursor", "guard-hook.mjs");
    expect(readFileSync(copy, "utf8")).toBe(BUNDLE);
    expect(modeOf(copy)).toBe(0o600);

    expect(await m.uninstall()).toBe(0);
    expect(readFileSync(m.hooksPath, "utf8")).toBe(ORIGINAL);
    expect(modeOf(m.hooksPath)).toBe(0o640);
    expect(readdirSync(join(m.home, ".agenttrail", "guard", "cursor"))).toEqual([]);
    expect(existsSync(join(m.home, ".agenttrail", "guard", "config.json"))).toBe(true);
    expect(m.claudeCalls).toEqual([]);
  });

  it("creates a new hooks.json at mode 0600, and uninstall removes it", async () => {
    const m = realMachine();
    expect(await m.init()).toBe(0);
    expect(modeOf(m.hooksPath)).toBe(0o600);
    expect(hasGuardCursorEntry(readFileSync(m.hooksPath, "utf8"))).toBe(true);

    expect(await m.uninstall()).toBe(0);
    expect(existsSync(m.hooksPath)).toBe(false);
  });

  it("writes through a symbolic link, so the link stays a link", async () => {
    const m = realMachine();
    const target = join(m.home, "dotfiles", "cursor-hooks.json");
    mkdirSync(join(m.home, "dotfiles"));
    mkdirSync(join(m.home, ".cursor"));
    writeFileSync(target, ORIGINAL);
    symlinkSync(target, m.hooksPath);

    expect(await m.init()).toBe(0);
    expect(lstatSync(m.hooksPath).isSymbolicLink()).toBe(true);
    expect(hasGuardCursorEntry(readFileSync(target, "utf8"))).toBe(true);

    expect(await m.uninstall()).toBe(0);
    expect(lstatSync(m.hooksPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
  });

  it("refuses a read-only hooks.json and leaves its bytes alone", async () => {
    const m = realMachine();
    mkdirSync(join(m.home, ".cursor"));
    writeFileSync(m.hooksPath, ORIGINAL);
    chmodSync(m.hooksPath, 0o444);

    expect(await m.init()).toBe(1);
    expect(readFileSync(m.hooksPath, "utf8")).toBe(ORIGINAL);
    expect(existsSync(join(m.home, ".agenttrail"))).toBe(false);
  });
});
