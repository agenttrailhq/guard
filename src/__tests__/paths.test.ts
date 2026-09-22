/**
 * `core/paths.ts` — every path guard writes, reads or deletes, for every app.
 *
 * This module had no test of its own until now, which is the wrong way round for what it
 * does. A wrong path here does not fail loudly: `init` still writes a file and still
 * reports success, and it is `uninstall` and `status --clear-history` that break — months
 * later, by leaving a live hook entry behind or by emptying nothing. So each path is
 * pinned as a literal string rather than recomputed with `join`, which would restate the
 * implementation and pass however it changed.
 *
 * Two properties beyond the literals:
 * - the three apps' state directories are DISJOINT, so removing one cannot remove another;
 * - nothing guard writes escapes `~/.agenttrail/guard/`, except the two vendor hooks
 *   files it is invited into.
 *
 * POSIX separators throughout: `join` uses the host's, so these run on Linux and macOS.
 * `windows-paths.test.ts` covers the separator question for rule matching, which is where
 * it actually bites.
 */

import { describe, expect, it } from "vitest";
import {
  codexHookCopyPath,
  codexHooksAbsentPath,
  codexHooksBackupPath,
  codexHooksPath,
  codexInstallRecordPath,
  configPath,
  crashesDir,
  cursorHookCopyPath,
  cursorHooksAbsentPath,
  cursorHooksBackupPath,
  cursorHooksPath,
  cursorInstallRecordPath,
  dedupMarkerPath,
  eventsPath,
  guardCodexDir,
  guardCursorDir,
  guardDir,
  userRulesPath,
} from "../core/paths.js";

const HOME = "/home/dev";

/** Every exported path, with the literal it must produce under `HOME`. */
const PATHS: readonly (readonly [string, (home: string) => string, string])[] = [
  ["guardDir", guardDir, "/home/dev/.agenttrail/guard"],
  ["configPath", configPath, "/home/dev/.agenttrail/guard/config.json"],
  ["userRulesPath", userRulesPath, "/home/dev/.agenttrail/guard/guardrails.json"],
  ["eventsPath", eventsPath, "/home/dev/.agenttrail/guard/events.jsonl"],
  ["dedupMarkerPath", dedupMarkerPath, "/home/dev/.agenttrail/guard/.last-decision"],
  ["crashesDir", crashesDir, "/home/dev/.agenttrail/guard/crashes"],

  ["cursorHooksPath", cursorHooksPath, "/home/dev/.cursor/hooks.json"],
  ["guardCursorDir", guardCursorDir, "/home/dev/.agenttrail/guard/cursor"],
  ["cursorHookCopyPath", cursorHookCopyPath, "/home/dev/.agenttrail/guard/cursor/guard-hook.mjs"],
  [
    "cursorHooksBackupPath",
    cursorHooksBackupPath,
    "/home/dev/.agenttrail/guard/cursor/hooks.json.backup",
  ],
  [
    "cursorHooksAbsentPath",
    cursorHooksAbsentPath,
    "/home/dev/.agenttrail/guard/cursor/hooks.json.was-absent",
  ],
  [
    "cursorInstallRecordPath",
    cursorInstallRecordPath,
    "/home/dev/.agenttrail/guard/cursor/install.json",
  ],

  ["codexHooksPath", codexHooksPath, "/home/dev/.codex/hooks.json"],
  ["guardCodexDir", guardCodexDir, "/home/dev/.agenttrail/guard/codex"],
  ["codexHookCopyPath", codexHookCopyPath, "/home/dev/.agenttrail/guard/codex/guard-hook.mjs"],
  [
    "codexHooksBackupPath",
    codexHooksBackupPath,
    "/home/dev/.agenttrail/guard/codex/hooks.json.backup",
  ],
  [
    "codexHooksAbsentPath",
    codexHooksAbsentPath,
    "/home/dev/.agenttrail/guard/codex/hooks.json.was-absent",
  ],
  [
    "codexInstallRecordPath",
    codexInstallRecordPath,
    "/home/dev/.agenttrail/guard/codex/install.json",
  ],
];

describe("every guard path, spelled out", () => {
  it.each(PATHS)("%s", (_name, fn, expected) => {
    expect(fn(HOME)).toBe(expected);
  });

  it("is rooted at the home it is given, not at the process's own", () => {
    // Every test in this package injects a home; a function that ignored its argument
    // would pass all the literals above only because they share one prefix.
    for (const [name, fn] of PATHS) {
      expect(fn("/tmp/elsewhere"), name).toContain("/tmp/elsewhere/");
    }
  });
});

describe("the apps cannot remove each other's state", () => {
  it("keeps Cursor's and Codex's guard directories disjoint", () => {
    // `uninstall --agent cursor` deletes the Cursor directory wholesale. If Codex's
    // files lived under it — or under a prefix of it, such as `cursor` vs `cursor-x` —
    // uninstalling one app would silently disarm the other.
    expect(guardCodexDir(HOME).startsWith(`${guardCursorDir(HOME)}/`)).toBe(false);
    expect(guardCursorDir(HOME).startsWith(`${guardCodexDir(HOME)}/`)).toBe(false);
    expect(guardCodexDir(HOME)).not.toBe(guardCursorDir(HOME));
  });

  it.each([
    ["cursor", guardCursorDir],
    ["codex", guardCodexDir],
  ])("keeps %s's files inside the guard directory", (_app, dir) => {
    expect(dir(HOME).startsWith(`${guardDir(HOME)}/`)).toBe(true);
  });

  it("writes outside ~/.agenttrail/guard/ only into the two vendor hooks files", () => {
    // The promise `init` makes, as a property of the paths rather than of one test's
    // recorded writes: the only things guard names outside its own directory are the
    // files the vendors invite it into.
    const outside = PATHS.map(([, fn]) => fn(HOME)).filter(
      (path) => !path.startsWith(`${guardDir(HOME)}/`) && path !== guardDir(HOME),
    );
    expect(outside.sort()).toEqual(["/home/dev/.codex/hooks.json", "/home/dev/.cursor/hooks.json"]);
  });
});

describe("each app's hook copy and its record sit together", () => {
  it.each([
    ["cursor", guardCursorDir, cursorHookCopyPath, cursorInstallRecordPath],
    ["codex", guardCodexDir, codexHookCopyPath, codexInstallRecordPath],
  ])("%s", (_app, dir, copy, record) => {
    // `uninstall` restores the backup and then removes the directory, so a copy or a
    // record written anywhere else would outlive it.
    expect(copy(HOME)).toBe(`${dir(HOME)}/guard-hook.mjs`);
    expect(record(HOME)).toBe(`${dir(HOME)}/install.json`);
  });
});
