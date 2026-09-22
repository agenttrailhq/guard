// cspell:words codexes
/**
 * `init --agent codex` and `uninstall --agent codex`.
 *
 * Most cases run through in-memory seams (`codex-files.ts` and a `SetupIO` double), so no
 * test reads or writes a real `~/.codex/hooks.json` or runs `claude`. The last block runs the
 * real file seam in a scratch home, for what a double cannot show: modes on disk, the
 * rename, and a symbolic link.
 *
 * The group that matters most is "the installed entry is frozen". Codex decides whether a
 * hook may run by hashing the entry and by where it sits, so those tests are not describing
 * an implementation detail — they are pinning a published contract whose breakage is
 * completely silent.
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
import { type CodexFileIO, createRealCodexFileIO } from "../codex/codex-io.js";
import {
  addGuardEntries,
  CODEX_HOOK_MATCHER,
  CODEX_HOOK_TIMEOUT,
  codexHookCommand,
  eventsWithEntriesAfterGuard,
  GUARD_CODEX_EVENTS,
  isGuardCodexCommand,
  parseCodexInstallRecord,
  removeGuardEntries,
  sameHooksApartFromGuard,
} from "../codex/install.js";
import { runInit } from "../commands/init.js";
import { runUninstall } from "../commands/uninstall.js";
import { VERSION } from "../core/version.js";
import { type ClaudeRunner, createRealSetupIO, type SetupIO } from "../setup-io.js";
import {
  type FakeCodexFiles,
  type FakeCodexFilesOptions,
  type FakeFile,
  fakeCodexFiles,
} from "./codex-files.js";

const HOME = "/home/test";
const SCAFFOLD = "/pkg/plugin";
const HOOK_SOURCE = `${SCAFFOLD}/scripts/guard-hook.mjs`;
const BUNDLE = "// the bundled hook\n";
const NODE = "/usr/local/bin/node";
const HOOKS = `${HOME}/.codex/hooks.json`;
const CODEX_DIR = `${HOME}/.agenttrail/guard/codex`;
const COPY = `${CODEX_DIR}/guard-hook.mjs`;
const BACKUP = `${CODEX_DIR}/hooks.json.backup`;
const ABSENT = `${CODEX_DIR}/hooks.json.was-absent`;
const RECORD = `${CODEX_DIR}/install.json`;
const CONFIG = `${HOME}/.agenttrail/guard/config.json`;
const RULES = `${HOME}/.agenttrail/guard/guardrails.json`;
const NOW = new Date("2026-09-15T00:00:00.000Z");
const COMMAND = `"${NODE}" "${COPY}" --agent codex`;

/** The entry guard writes, for `COMMAND`. Frozen — see the group that pins it below. */
const ENTRY = {
  matcher: ".*",
  hooks: [{ type: "command", command: COMMAND, timeout: 10 }],
};

/** A `hooks.json` a user already has: two hooks of their own, compact, no trailing newline. */
const ORIGINAL =
  '{"description":"mine","hooks":{"Stop":[{"matcher":".*","hooks":[{"type":"command","command":"./format.sh"}]}],"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./audit.sh","timeout":5}]}]}}';

/** One group holding one handler, as Codex's file shapes them. */
function group(command: string, matcher = ".*"): Record<string, unknown> {
  return { matcher, hooks: [{ type: "command", command }] };
}

/** One machine: a `SetupIO` double, an in-memory Codex file seam, and what was done. */
interface Machine {
  readonly setup: SetupIO;
  readonly codex: FakeCodexFiles;
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
  } & Omit<FakeCodexFilesOptions, "files"> = {},
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
  const codex = fakeCodexFiles({
    ...options,
    files: {
      ...(options.bundle === false ? {} : { [HOOK_SOURCE]: BUNDLE }),
      ...(options.hooks === undefined ? {} : { [HOOKS]: options.hooks }),
      ...options.files,
    },
  });
  return {
    setup,
    codex,
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
    { agent: "codex", print: extra.print === true },
    { scaffoldDir: SCAFFOLD, codexIo: m.codex.io, nodePath: extra.nodePath ?? NODE, now: NOW },
  );
}

function uninstall(m: Machine): Promise<number> {
  return runUninstall(m.setup, { agent: "codex" }, { codexIo: m.codex.io });
}

const textOf = (m: Machine, path: string): string | undefined => m.codex.files.get(path)?.text;

const jsonOf = (m: Machine, path: string): Record<string, unknown> =>
  JSON.parse(textOf(m, path) ?? "null");

/** The hook lists of the file as it stands. */
const listsOf = (m: Machine): Record<string, unknown[]> =>
  jsonOf(m, HOOKS).hooks as Record<string, unknown[]>;

/** Nothing written, deleted or run: the promise every refusal makes. */
function expectNothingChanged(m: Machine): void {
  expect(m.codex.writes).toEqual([]);
  expect(m.codex.deletes).toEqual([]);
  expect(m.setupWrites).toEqual([]);
  expect(m.claudeCalls).toEqual([]);
}

/** `text` with one more hook of the user's own, under `event`, after anything already there. */
function withUserHook(text: string, event: string, command: string): string {
  const doc = JSON.parse(text);
  doc.hooks[event] = [...(doc.hooks[event] ?? []), group(command)];
  return JSON.stringify(doc, null, 2);
}

describe("init --agent codex, with no ~/.codex/hooks.json", () => {
  it("writes both entries, the hook copy, the install record and the no-file record; exit 0", async () => {
    const m = machine();
    expect(await install(m)).toBe(0);

    expect(jsonOf(m, HOOKS)).toEqual({
      hooks: { PreToolUse: [ENTRY], PermissionRequest: [ENTRY] },
    });
    expect(m.codex.files.get(HOOKS)?.mode).toBe(0o600);
    expect(textOf(m, COPY)).toBe(BUNDLE);
    expect(m.codex.files.get(COPY)?.mode).toBe(0o600);
    expect(textOf(m, ABSENT)).toBe("");
    expect(m.codex.files.has(BACKUP)).toBe(false);
    expect(jsonOf(m, RECORD)).toEqual({
      installedAt: NOW.toISOString(),
      hookPath: COPY,
      nodePath: NODE,
      guardVersion: VERSION,
      groupIndex: { PreToolUse: 0, PermissionRequest: 0 },
    });
    // `config.json` and `guardrails.json` are seeded as `--agent claude` seeds them.
    expect(m.setupWrites).toEqual([CONFIG, RULES]);
    // Guard's own files first, and Codex's file last.
    expect(m.codex.writes.map((w) => w.path)).toEqual([COPY, ABSENT, RECORD, HOOKS]);
    expect(m.claudeCalls).toEqual([]);
  });

  it("writes nothing into Codex's config.toml, which aggregates rather than overrides", async () => {
    const m = machine();
    await install(m);
    // An entry in both files runs guard TWICE for one tool call, and guard cannot read the
    // TOML one back to notice. Asserted over the recorded writes, not the output.
    for (const write of m.codex.writes) expect(write.path).not.toContain("config.toml");
    for (const write of m.setupWrites) expect(write).not.toContain("config.toml");
  });

  it("says what the user must still do, because until they do it guard checks nothing", async () => {
    const m = machine();
    await install(m);
    const out = m.takeOut();
    expect(out).toContain(
      `Installed for Codex CLI: a PreToolUse entry and a PermissionRequest entry in ${HOOKS}.`,
    );
    expect(out).toContain("NEXT STEP");
    expect(out).toContain("/hooks");
    expect(out).toContain("Each event is approved separately");
    expect(out).toContain("does not say that it skipped one");
  });

  it("ends with the demonstration init --agent claude prints", async () => {
    const m = machine();
    await install(m);
    const out = m.takeOut();
    expect(out).toContain("Here it is working");
    expect(out).toContain("$ rm -rf /");
    expect(out).toContain("BLOCKED");
    expect(out).toContain("evaluated, not executed");
    expect(out).toMatch(/guardrail library v\d+\.\d+\.\d+/);
    expect(out).toContain("agenttrail-guard status");
  });
});

describe("the installed entry is frozen, and this pins it", () => {
  it("is exactly this JSON, under exactly these two events", async () => {
    const m = machine();
    await install(m);

    // Measured on codex-cli 0.154.0: Codex decides whether a hook may run by hashing the
    // ENTRY — event, matcher, command and timeout — not the script it runs. Changing any
    // byte below makes every existing approval stop matching, and Codex then stops running
    // the hook with no warning, no log line and nothing on screen. That is a BREAKING
    // CHANGE for everyone who already has guard installed, who enforce nothing until they
    // approve it again in Codex's /hooks screen. It is not a refactor.
    //
    // The matcher is `.*` and not a list of tool names because Codex Desktop calls its
    // shell tool `shell_command` rather than `Bash`, so a name list would silently miss
    // every shell call there.
    expect(jsonOf(m, HOOKS)).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command:
                  '"/usr/local/bin/node" "/home/test/.agenttrail/guard/codex/guard-hook.mjs" --agent codex',
                timeout: 10,
              },
            ],
          },
        ],
        PermissionRequest: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command:
                  '"/usr/local/bin/node" "/home/test/.agenttrail/guard/codex/guard-hook.mjs" --agent codex',
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
  });

  it("pins each value Codex hashes on its own, so one cannot be changed quietly", () => {
    expect([...GUARD_CODEX_EVENTS]).toEqual(["PreToolUse", "PermissionRequest"]);
    expect(CODEX_HOOK_MATCHER).toBe(".*");
    expect(CODEX_HOOK_TIMEOUT).toBe(10);
    expect(codexHookCommand("/n/node", "/h/guard-hook.mjs")).toBe(
      '"/n/node" "/h/guard-hook.mjs" --agent codex',
    );
  });
});

describe("init --agent codex, over an existing hooks.json", () => {
  it("keeps every other key, hook and order, adds at the end, and backs the file up as it was", async () => {
    const m = machine({ hooks: ORIGINAL });
    expect(await install(m)).toBe(0);

    const doc = jsonOf(m, HOOKS);
    expect(doc).toEqual({
      description: "mine",
      hooks: {
        Stop: [group("./format.sh")],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh", timeout: 5 }] },
          ENTRY,
        ],
        PermissionRequest: [ENTRY],
      },
    });
    expect(Object.keys(doc)).toEqual(["description", "hooks"]);
    expect(Object.keys(doc.hooks as object)).toEqual(["Stop", "PreToolUse", "PermissionRequest"]);
    expect(textOf(m, BACKUP)).toBe(ORIGINAL);
    expect(m.codex.files.has(ABSENT)).toBe(false);
    expect(m.takeOut()).toContain(`Saved the earlier ${HOOKS} as ${BACKUP}.`);
  });

  it("records the position each entry went to, which is half of Codex's approval key", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    // PreToolUse already had one hook, so guard's is second there and first under the
    // event it created.
    expect(jsonOf(m, RECORD).groupIndex).toEqual({ PreToolUse: 1, PermissionRequest: 0 });
  });

  it("replaces its own entry WHERE IT ALREADY SITS, so no other hook is moved", async () => {
    // The hazard: Codex records an approval under `<file>:<event>:<group>:<handler>`, so
    // removing guard's entry and appending a new one would move the user's hook from 1 to
    // 0 and silently invalidate ITS approval.
    const old = `"/old/bin/node" "${COPY}" --agent codex`;
    const m = machine({
      hooks: JSON.stringify({
        hooks: {
          PreToolUse: [group(old), group("./audit.sh")],
          PermissionRequest: [group(old)],
        },
      }),
    });
    expect(await install(m)).toBe(0);

    expect(listsOf(m).PreToolUse).toEqual([ENTRY, group("./audit.sh")]);
    expect(listsOf(m).PermissionRequest).toEqual([ENTRY]);
    expect(jsonOf(m, RECORD).groupIndex).toEqual({ PreToolUse: 0, PermissionRequest: 0 });
    expect(m.takeOut()).toContain(
      `Updated guard's entries in ${HOOKS}, each where it already was.`,
    );
  });

  it("leaves a handler sharing guard's group alone, and appends rather than taking that group's place", async () => {
    // A hand-edited file where someone put a handler of their own beside guard's. The group
    // survives the removal, so guard has no place of its own to return to and goes to the
    // end — which is what leaves `./after.sh` at the index it already had.
    const old = `"/old/bin/node" "${COPY}" --agent codex`;
    const shared = {
      matcher: ".*",
      hooks: [
        { type: "command", command: old },
        { type: "command", command: "./mine.sh" },
      ],
    };
    const m = machine({
      hooks: JSON.stringify({ hooks: { PreToolUse: [shared, group("./after.sh")] } }),
    });
    expect(await install(m)).toBe(0);
    expect(listsOf(m).PreToolUse).toEqual([
      { matcher: ".*", hooks: [{ type: "command", command: "./mine.sh" }] },
      group("./after.sh"),
      ENTRY,
    ]);
    expect(jsonOf(m, RECORD).groupIndex).toEqual({ PreToolUse: 2, PermissionRequest: 0 });
  });

  it("keeps a mode that is not the default", async () => {
    const m = machine({ hooks: { text: ORIGINAL, mode: 0o640 } });
    expect(await install(m)).toBe(0);
    expect(m.codex.files.get(HOOKS)?.mode).toBe(0o640);
  });

  it("accepts a file with no hooks key, and adds one, last", async () => {
    const m = machine({ hooks: '{"description":"x"}' });
    expect(await install(m)).toBe(0);
    const doc = jsonOf(m, HOOKS);
    expect(Object.keys(doc)).toEqual(["description", "hooks"]);
    // Codex's file carries no `version`, so guard writes none.
    expect(doc.version).toBeUndefined();
  });
});

describe("init --agent codex refuses a hooks.json it will not change, and changes nothing", () => {
  it.each([
    ["not JSON", "{not json", "is not valid JSON"],
    ["an array", "[]", "is not a JSON object"],
    ["a string", '"hooks"', "is not a JSON object"],
    ["hooks as an array", '{"hooks":[]}', 'has a "hooks" value that is not an object'],
    ["hooks as null", '{"hooks":null}', 'has a "hooks" value that is not an object'],
    [
      "an event list that is an object",
      '{"hooks":{"PreToolUse":{}}}',
      'has a "PreToolUse" hook list that is not an array',
    ],
    [
      "another app's event list that is a string",
      '{"hooks":{"Stop":"./x.sh"}}',
      'has a "Stop" hook list that is not an array',
    ],
    [
      "a hook group that is not an object",
      '{"hooks":{"PreToolUse":["./x.sh"]}}',
      'has a "PreToolUse" hook that is not an object',
    ],
    [
      "a hook group whose handler list is not an array",
      '{"hooks":{"PreToolUse":[{"matcher":".*","hooks":{}}]}}',
      'has a "PreToolUse" hook whose "hooks" value is not an array',
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

describe("init --agent codex when a write does not go through", () => {
  it("the system refuses the hooks.json write: exit 1, and the file is as it was", async () => {
    const m = machine({ hooks: ORIGINAL, failWrites: [HOOKS] });
    expect(await install(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} was not changed.`);
    expect(textOf(m, HOOKS)).toBe(ORIGINAL);
  });

  it("another program changes hooks.json while guard installs: guard does not write over it", async () => {
    const other = withUserHook(ORIGINAL, "Stop", "./other.sh");
    const m = machine({
      hooks: ORIGINAL,
      beforeRead: (path, earlierReads, files) => {
        if (path === HOOKS && earlierReads === 1) files.set(HOOKS, { text: other, mode: 0o644 });
      },
    });
    expect(await install(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} changed while guard was installing`);
    expect(textOf(m, HOOKS)).toBe(other);
    expect(m.codex.writes.map((w) => w.path)).not.toContain(HOOKS);
  });
});

describe("a repeated init --agent codex", () => {
  it.each([
    ["no hooks.json before", undefined],
    ["an existing hooks.json", ORIGINAL],
  ])("with %s, the second run changes nothing", async (_label, hooks) => {
    const m = machine(hooks === undefined ? {} : { hooks });
    expect(await install(m)).toBe(0);
    const afterFirst = textOf(m, HOOKS);
    const writes = m.codex.writes.length;
    const seeds = m.setupWrites.length;
    m.takeOut();

    expect(await install(m)).toBe(0);
    expect(m.codex.writes).toHaveLength(writes);
    expect(m.codex.deletes).toEqual([]);
    expect(m.setupWrites).toHaveLength(seeds);
    expect(textOf(m, HOOKS)).toBe(afterFirst);
    expect(m.takeOut()).toContain(`Already installed for Codex CLI: ${HOOKS} runs ${COPY}.`);
  });

  it("still names the approval step on a run that changed nothing", async () => {
    // The run most likely to be read as "there is nothing left to do".
    const m = machine();
    await install(m);
    m.takeOut();
    await install(m);
    expect(m.takeOut()).toContain("NEXT STEP");
  });

  it("does not move guard's entry when another hook was added before it", async () => {
    const m = machine();
    await install(m);
    const doc = JSON.parse(textOf(m, HOOKS) ?? "null");
    doc.hooks.PreToolUse = [group("./theirs.sh"), ...doc.hooks.PreToolUse];
    m.codex.files.set(HOOKS, { text: JSON.stringify(doc, null, 2), mode: 0o600 });
    m.takeOut();

    expect(await install(m)).toBe(0);
    expect(listsOf(m).PreToolUse).toEqual([group("./theirs.sh"), ENTRY]);
    // The record follows the entry, so `status` compares against where it really is.
    expect(jsonOf(m, RECORD).groupIndex).toEqual({ PreToolUse: 1, PermissionRequest: 0 });
  });

  it("keeps the first backup when hooks.json has changed since", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    const changed = withUserHook(textOf(m, HOOKS) ?? "", "Stop", "./later.sh");
    m.codex.files.set(HOOKS, { text: changed, mode: 0o644 });

    expect(await install(m)).toBe(0);
    expect(textOf(m, BACKUP)).toBe(ORIGINAL);
    expect(m.codex.files.has(ABSENT)).toBe(false);
  });

  it("keeps the record that there was no file, and takes no backup of guard's own file", async () => {
    const m = machine();
    await install(m);
    const changed = withUserHook(textOf(m, HOOKS) ?? "", "Stop", "./later.sh");
    m.codex.files.set(HOOKS, { text: changed, mode: 0o600 });

    expect(await install(m)).toBe(0);
    expect(m.codex.files.has(ABSENT)).toBe(true);
    expect(m.codex.files.has(BACKUP)).toBe(false);
  });

  it("with another Node: the entries and the record move to it, and no old entry is left", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    expect(await install(m, { nodePath: "/opt/node/bin/node" })).toBe(0);

    const newEntry = {
      matcher: ".*",
      hooks: [
        { type: "command", command: `"/opt/node/bin/node" "${COPY}" --agent codex`, timeout: 10 },
      ],
    };
    expect(listsOf(m).PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh", timeout: 5 }] },
      newEntry,
    ]);
    expect(listsOf(m).PermissionRequest).toEqual([newEntry]);
    expect(jsonOf(m, RECORD).nodePath).toBe("/opt/node/bin/node");
    expect(textOf(m, BACKUP)).toBe(ORIGINAL);
  });
});

describe("init --agent codex --print", () => {
  it("writes nothing, runs nothing, and names each file and the entry it would add", async () => {
    const m = machine();
    expect(await install(m, { print: true })).toBe(0);
    expectNothingChanged(m);
    const out = m.takeOut();
    expect(out).toContain(
      "init --agent codex --print — this is what would happen. Nothing is changed.",
    );
    for (const path of [CONFIG, RULES, COPY, ABSENT, RECORD])
      expect(out).toContain(`write   ${path}`);
    expect(out).toContain(`write   ${HOOKS}  (a new file, mode 0600)`);
    expect(out).toContain("adds this entry at the end of PreToolUse and of PermissionRequest:");
    expect(out).toContain(JSON.stringify(ENTRY));
    expect(out).toContain("NEXT STEP");
    expect(out).toContain("It would NOT touch ~/.codex/config.toml");
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

  it("says it would replace its own entry in place when one is already there", async () => {
    const old = `"/old/bin/node" "${COPY}" --agent codex`;
    const m = machine({
      hooks: JSON.stringify({
        hooks: { PreToolUse: [group(old)], PermissionRequest: [group(old)] },
      }),
    });
    expect(await install(m, { print: true })).toBe(0);
    expectNothingChanged(m);
    expect(m.takeOut()).toContain("replaces guard's own entry, where it already sits");
  });

  it("says where it would stop, exits 0, and still writes nothing", async () => {
    const m = machine({ hooks: '{"hooks":[]}' });
    expect(await install(m, { print: true })).toBe(0);
    expectNothingChanged(m);
    expect(m.takeOut()).toContain(
      `It would STOP: ${HOOKS} has a "hooks" value that is not an object.`,
    );
  });

  it("once installed, says there is nothing to change in hooks.json", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    const writes = m.codex.writes.length;
    m.takeOut();
    expect(await install(m, { print: true })).toBe(0);
    expect(m.codex.writes).toHaveLength(writes);
    expect(m.takeOut()).toContain("already runs this copy — nothing to change there");
  });
});

describe("uninstall --agent codex", () => {
  it("after an install over an existing file: its exact bytes and mode are back, and guard's files are gone", async () => {
    const m = machine({ hooks: { text: ORIGINAL, mode: 0o640 } });
    await install(m);
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    expect(textOf(m, HOOKS)).toBe(ORIGINAL);
    expect(m.codex.files.get(HOOKS)?.mode).toBe(0o640);
    for (const path of [COPY, RECORD, BACKUP, ABSENT]) expect(m.codex.files.has(path)).toBe(false);
    expect(m.takeOut()).toContain("it is back to how it was before the install");
    expect(m.claudeCalls).toEqual([]);
  });

  it("after an install over no file: the file guard created is removed", async () => {
    const m = machine();
    await install(m);
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    expect(m.codex.files.has(HOOKS)).toBe(false);
    for (const path of [COPY, RECORD, BACKUP, ABSENT]) expect(m.codex.files.has(path)).toBe(false);
    expect(m.takeOut()).toContain(
      `Removed ${HOOKS}: guard created it, and nothing else was in it.`,
    );
  });

  it("when the user added hooks since the install: guard's entries go, and every other hook stays", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    let changed = withUserHook(textOf(m, HOOKS) ?? "", "PreToolUse", "./later.sh");
    changed = withUserHook(changed, "Stop", "./stop.sh");
    m.codex.files.set(HOOKS, { text: changed, mode: 0o644 });
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    expect(jsonOf(m, HOOKS)).toEqual({
      description: "mine",
      hooks: {
        Stop: [group("./format.sh"), group("./stop.sh")],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh", timeout: 5 }] },
          group("./later.sh"),
        ],
      },
    });
    expect(m.codex.files.has(BACKUP)).toBe(false);
    expect(m.takeOut()).toContain("Every other hook in it is untouched.");
  });

  it("warns, by event, when removing guard's entry moves someone else's up a place", async () => {
    // Removing is still the right answer — a guard that will not uninstall itself is worse
    // — but the cost is real and invisible, so it is stated.
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    m.codex.files.set(HOOKS, {
      text: withUserHook(textOf(m, HOOKS) ?? "", "PreToolUse", "./later.sh"),
      mode: 0o644,
    });
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    const out = m.takeOut();
    expect(out).toContain("A hook of yours sat after guard's under PreToolUse");
    expect(out).toContain("Codex approves a hook by its position");
    expect(out).toContain("/hooks");
    expect(out).not.toContain("PermissionRequest");
  });

  it("says nothing about positions when guard's entries were last", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    m.takeOut();
    expect(await uninstall(m)).toBe(0);
    expect(m.takeOut()).not.toContain("moved up one place");
  });

  it("after an install over no file, a hook the user added since keeps the file", async () => {
    const m = machine();
    await install(m);
    m.codex.files.set(HOOKS, {
      text: withUserHook(textOf(m, HOOKS) ?? "", "Stop", "./format.sh"),
      mode: 0o600,
    });

    expect(await uninstall(m)).toBe(0);
    expect(jsonOf(m, HOOKS)).toEqual({ hooks: { Stop: [group("./format.sh")] } });
  });

  it("running it twice is not an error, and the second run changes nothing", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    await uninstall(m);
    const writes = m.codex.writes.length;
    const deletes = m.codex.deletes.length;
    m.takeOut();

    expect(await uninstall(m)).toBe(0);
    expect(m.codex.writes).toHaveLength(writes);
    expect(m.codex.deletes).toHaveLength(deletes);
    expect(m.takeOut()).toContain("Guard is not installed for Codex CLI — nothing to remove.");
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
    expect(m.codex.files.has(crash)).toBe(true);
    expect(m.codex.files.has(events)).toBe(true);
    for (const path of m.codex.deletes) {
      expect([HOOKS, COPY, RECORD, BACKUP, ABSENT]).toContain(path);
    }
  });

  it("refuses a hooks.json it will not change, and keeps guard's files", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    m.codex.files.set(HOOKS, { text: "{broken", mode: 0o644 });
    m.takeOut();

    expect(await uninstall(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} is not valid JSON. Nothing was changed.`);
    expect(m.codex.deletes).toEqual([]);
    expect(m.codex.files.has(COPY)).toBe(true);
  });

  it("refuses a read-only hooks.json, and keeps guard's files", async () => {
    const m = machine({ hooks: ORIGINAL });
    await install(m);
    const installed = textOf(m, HOOKS) ?? "";
    m.codex.files.set(HOOKS, { text: installed, mode: 0o444 });
    m.takeOut();

    expect(await uninstall(m)).toBe(1);
    expect(m.takeOut()).toContain(`${HOOKS} is read-only. Nothing was changed.`);
    expect(textOf(m, HOOKS)).toBe(installed);
    expect(m.codex.files.has(COPY)).toBe(true);
  });

  it("does not restore a backup that itself holds guard's entries", async () => {
    const withGuard = JSON.stringify({
      hooks: { PreToolUse: [group("./audit.sh"), ENTRY], PermissionRequest: [ENTRY] },
    });
    const m = machine({ hooks: withGuard, files: { [BACKUP]: withGuard, [RECORD]: "{}" } });

    expect(await uninstall(m)).toBe(0);
    expect(jsonOf(m, HOOKS)).toEqual({ hooks: { PreToolUse: [group("./audit.sh")] } });
  });
});

describe("the hooks.json helpers", () => {
  const INPUTS = [
    undefined,
    ORIGINAL,
    '{"description":"x"}',
    '{"hooks":{"PreToolUse":[],"Stop":[{"matcher":".*","hooks":[{"type":"command","command":"./s.sh"}]}]}}',
    JSON.stringify({ hooks: { PermissionRequest: [ENTRY, group("./after.sh")] } }),
  ];

  it.each(INPUTS)("addGuardEntries on its own output gives the same text (%s)", (text) => {
    const once = addGuardEntries(text, COMMAND);
    if (!once.ok) throw new Error(once.reason);
    const twice = addGuardEntries(once.text, COMMAND);
    expect(twice.ok && twice.text).toBe(once.text);
    expect(twice.ok && twice.removed).toBe(2);
    expect(twice.ok && twice.indexes).toEqual(once.indexes);
  });

  it.each(
    INPUTS.filter((text): text is string => text !== undefined && !text.includes("--agent codex")),
  )("removeGuardEntries undoes addGuardEntries, up to formatting (%s)", (text) => {
    const added = addGuardEntries(text, COMMAND);
    if (!added.ok) throw new Error(added.reason);
    const removed = removeGuardEntries(added.text);
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.removed).toBe(2);
    expect(sameHooksApartFromGuard(removed.text, text)).toBe(true);
  });

  it("sameHooksApartFromGuard ignores key order, formatting, empty lists and a missing hooks key", () => {
    const a =
      '{"hooks":{"Stop":[{"matcher":".*","hooks":[{"command":"./s.sh"}]}],"PreToolUse":[]}}';
    const b = JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ command: "./s.sh" }], matcher: ".*" }] } },
      null,
      4,
    );
    expect(sameHooksApartFromGuard(a, b)).toBe(true);
    // The negative controls: a changed command, a changed order of entries, and a file
    // that is not JSON all count as different.
    expect(sameHooksApartFromGuard(a, a.replace("./s.sh", "./t.sh"))).toBe(false);
    const two = JSON.stringify({ hooks: { Stop: [group("./a"), group("./b")] } });
    const swapped = JSON.stringify({ hooks: { Stop: [group("./b"), group("./a")] } });
    expect(sameHooksApartFromGuard(two, swapped)).toBe(false);
    expect(sameHooksApartFromGuard("{broken", "{broken")).toBe(false);
  });

  it("codexHookCommand quotes both paths, and refuses characters a shell would change", () => {
    expect(codexHookCommand("/a b/node", "/c d/guard-hook.mjs")).toBe(
      '"/a b/node" "/c d/guard-hook.mjs" --agent codex',
    );
    expect(codexHookCommand('/a"b/node', COPY)).toBeUndefined();
    expect(codexHookCommand(NODE, "/home/$USER/guard-hook.mjs")).toBeUndefined();
  });

  it("isGuardCodexCommand reads the flag as whole words, and does not claim Cursor's entry", () => {
    expect(isGuardCodexCommand(COMMAND)).toBe(true);
    expect(isGuardCodexCommand(`"${NODE}" "${COPY}" --agent cursor`)).toBe(false);
    expect(isGuardCodexCommand(`"${NODE}" "${COPY}" --agent codexes`)).toBe(false);
    expect(isGuardCodexCommand(`"${NODE}" "/other/hook.mjs" --agent codex`)).toBe(false);
    expect(isGuardCodexCommand(undefined)).toBe(false);
  });

  it("eventsWithEntriesAfterGuard names only the events where a hook really follows guard's", () => {
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [ENTRY, group("./after.sh")],
        PermissionRequest: [group("./before.sh"), ENTRY],
        Stop: [group("./x.sh")],
      },
    });
    expect(eventsWithEntriesAfterGuard(text)).toEqual(["PreToolUse"]);
    expect(eventsWithEntriesAfterGuard("{broken")).toEqual([]);
  });

  it("parseCodexInstallRecord keeps only whole, non-negative positions", () => {
    expect(parseCodexInstallRecord(undefined)).toBeUndefined();
    expect(parseCodexInstallRecord("{")).toBeUndefined();
    expect(parseCodexInstallRecord("[]")).toBeUndefined();
    // A record an older guard wrote: readable, with no positions to compare against.
    expect(parseCodexInstallRecord('{"guardVersion":"0.0.1"}')).toEqual({
      guardVersion: "0.0.1",
      groupIndex: {},
    });
    expect(
      parseCodexInstallRecord('{"groupIndex":{"PreToolUse":2,"PermissionRequest":-1,"Stop":9}}'),
    ).toEqual({ guardVersion: undefined, groupIndex: { PreToolUse: 2 } });
  });
});

describe.skipIf(process.platform === "win32")("on a real file system, in a scratch home", () => {
  /** A scratch home with a bundled hook to copy, and the real seams pointed at it. */
  function realMachine() {
    const home = mkdtempSync(join(tmpdir(), "agenttrail-guard-codex-install-"));
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
    const files: CodexFileIO = createRealCodexFileIO();
    const hooksPath = join(home, ".codex", "hooks.json");
    return {
      home,
      hooksPath,
      claudeCalls,
      init: () =>
        runInit(
          setup,
          { agent: "codex" },
          { scaffoldDir: scaffold, codexIo: files, nodePath: process.execPath, now: NOW },
        ),
      uninstall: () => runUninstall(setup, { agent: "codex" }, { codexIo: files }),
    };
  }

  const modeOf = (path: string): number => statSync(path).mode & 0o777;

  /** Whether a `hooks.json` text holds a guard entry under both of guard's events. */
  function hasGuardEntry(text: string | undefined): boolean {
    if (text === undefined) return false;
    const removed = removeGuardEntries(text);
    return removed.ok && removed.removed === GUARD_CODEX_EVENTS.length;
  }

  it("keeps the file's mode, leaves no temp file, and uninstall puts the exact bytes back", async () => {
    const m = realMachine();
    mkdirSync(join(m.home, ".codex"));
    writeFileSync(m.hooksPath, ORIGINAL);
    chmodSync(m.hooksPath, 0o640);

    expect(await m.init()).toBe(0);
    expect(modeOf(m.hooksPath)).toBe(0o640);
    expect(hasGuardEntry(readFileSync(m.hooksPath, "utf8"))).toBe(true);
    expect(readdirSync(join(m.home, ".codex"))).toEqual(["hooks.json"]);
    const copy = join(m.home, ".agenttrail", "guard", "codex", "guard-hook.mjs");
    expect(readFileSync(copy, "utf8")).toBe(BUNDLE);
    expect(modeOf(copy)).toBe(0o600);

    expect(await m.uninstall()).toBe(0);
    expect(readFileSync(m.hooksPath, "utf8")).toBe(ORIGINAL);
    expect(modeOf(m.hooksPath)).toBe(0o640);
    expect(readdirSync(join(m.home, ".agenttrail", "guard", "codex"))).toEqual([]);
    expect(existsSync(join(m.home, ".agenttrail", "guard", "config.json"))).toBe(true);
    expect(m.claudeCalls).toEqual([]);
  });

  it("creates a new hooks.json at mode 0600, and uninstall removes it", async () => {
    const m = realMachine();
    expect(await m.init()).toBe(0);
    expect(modeOf(m.hooksPath)).toBe(0o600);
    expect(hasGuardEntry(readFileSync(m.hooksPath, "utf8"))).toBe(true);

    expect(await m.uninstall()).toBe(0);
    expect(existsSync(m.hooksPath)).toBe(false);
  });

  it("writes through a symbolic link, so the link stays a link", async () => {
    const m = realMachine();
    const target = join(m.home, "dotfiles", "codex-hooks.json");
    mkdirSync(join(m.home, "dotfiles"));
    mkdirSync(join(m.home, ".codex"));
    writeFileSync(target, ORIGINAL);
    symlinkSync(target, m.hooksPath);

    expect(await m.init()).toBe(0);
    expect(lstatSync(m.hooksPath).isSymbolicLink()).toBe(true);
    expect(hasGuardEntry(readFileSync(target, "utf8"))).toBe(true);

    expect(await m.uninstall()).toBe(0);
    expect(lstatSync(m.hooksPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
  });

  it("refuses a read-only hooks.json and leaves its bytes alone", async () => {
    const m = realMachine();
    mkdirSync(join(m.home, ".codex"));
    writeFileSync(m.hooksPath, ORIGINAL);
    chmodSync(m.hooksPath, 0o444);

    expect(await m.init()).toBe(1);
    expect(readFileSync(m.hooksPath, "utf8")).toBe(ORIGINAL);
    expect(existsSync(join(m.home, ".agenttrail"))).toBe(false);
  });
});
