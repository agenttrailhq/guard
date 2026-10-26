/**
 * `init --agent cursor|codex` declines where AgentTrail OS already enforces that app, as
 * `init --agent claude` does for AgentTrail OS's Claude Code plugin.
 */
import { describe, expect, it } from "vitest";
import { runInit } from "../commands/init.js";
import { osCodexPresent, osCursorPresent, osEnforcementRecordPath } from "../core/os-presence.js";
import type { SetupIO } from "../setup-io.js";

const HOME = "/home/test";

function harness(files: Record<string, string>) {
  const out: string[] = [];
  const writes: string[] = [];
  const calls: string[][] = [];
  const io: SetupIO = {
    writeStdout: (t) => {
      out.push(t);
    },
    readFile: (p) => files[p],
    exists: () => true,
    writeFileAtomic: (p) => {
      writes.push(p);
    },
    homedir: () => HOME,
    runClaude: (args) => {
      calls.push([...args]);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { io, out: () => out.join(""), writes, calls };
}

const ON = JSON.stringify({ v: 1, enabled: true });
const deps = { scaffoldDir: "/pkg/plugin", bundledVersion: "0.1.0" };

describe.each([
  ["cursor", "Cursor"],
  ["codex", "Codex"],
] as const)("init --agent %s", (agent, name) => {
  it("declines while AgentTrail OS enforces it — exit 0, nothing written or run", async () => {
    const h = harness({ [osEnforcementRecordPath(HOME, agent)]: ON });
    expect(await runInit(h.io, { agent }, deps)).toBe(0);
    expect(h.out()).toContain(`AgentTrail OS is already enforcing ${name} on this machine.`);
    expect(h.out()).toContain("Nothing was written and nothing was changed.");
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("--print declines too", async () => {
    const h = harness({ [osEnforcementRecordPath(HOME, agent)]: ON });
    expect(await runInit(h.io, { agent, print: true }, deps)).toBe(0);
    expect(h.out()).toContain(`AgentTrail OS is already enforcing ${name}`);
  });
});

describe("the presence checks", () => {
  it.each([
    ["missing", undefined, false],
    ["not JSON", "{", false],
    ["disabled", JSON.stringify({ v: 1, enabled: false }), false],
    ["another version", JSON.stringify({ v: 2, enabled: true }), false],
    ["on", ON, true],
  ])("a record that is %s → %s", (_why, text, expected) => {
    const files: Record<string, string> = {};
    if (text !== undefined) {
      files[osEnforcementRecordPath(HOME, "cursor")] = text;
      files[osEnforcementRecordPath(HOME, "codex")] = text;
    }
    const read = (p: string) => files[p];
    expect(osCursorPresent(read, HOME)).toBe(expected);
    expect(osCodexPresent(read, HOME)).toBe(expected);
  });

  it("reads each app's record under ~/.agenttrail", () => {
    expect(osEnforcementRecordPath(HOME, "cursor")).toBe(
      `${HOME}/.agenttrail/cursor/enforcement.json`,
    );
    expect(osEnforcementRecordPath(HOME, "codex")).toBe(
      `${HOME}/.agenttrail/codex/enforcement.json`,
    );
  });
});
