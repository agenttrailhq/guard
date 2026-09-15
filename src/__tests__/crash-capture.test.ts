/**
 * Capture on the hook path — and the proof that it cannot change a decision.
 *
 * ── The module-layer half of fault injection ────────────────────────────────
 * Nothing in the released binary may be told to fail (no `AGENTTRAIL_GUARD_FORCE_CRASH`,
 * no lever of any kind), because a switch that makes the guard fail on command is a
 * way to turn the guard off, and undocumented still means present and findable in a
 * tool whose whole job is to not be bypassable.
 *
 * So the fault is injected here, through seams that already existed for the
 * fail-open suite: `runHook`'s `deps` and a `GuardIO` whose methods throw. No
 * production surface is added by these tests.
 *
 * `crash-runtime.test.ts` covers the other half — a crash inside the RELEASED bytes,
 * with the fault injected by a test-only preload.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_CHECKED_MESSAGE, runHook } from "../commands/hook.js";
import { captureCrash, resetCaptureGuardForTests } from "../core/crash-capture.js";
import { readSpool } from "../core/crash-store.js";
import { createRealIO, type GuardIO } from "../io.js";

let home: string;
let io: GuardIO;
let out: string[];

const scrub = (t: string) => ({ text: t });

function deps(overrides: Partial<Parameters<typeof captureCrash>[1]> = {}) {
  return {
    io,
    scrubSecrets: scrub,
    command: "hook" as const,
    guardVersion: "0.1.0",
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "guard-cap-"));
  out = [];
  const real = createRealIO();
  io = { ...real, homedir: () => home, writeStdout: (t) => void out.push(t) };
  resetCaptureGuardForTests();
});

describe("capture writes locally and only locally", () => {
  it("spools a record for a real Error", () => {
    expect(captureCrash(new Error("boom"), deps())).toBe(true);
    const spooled = readSpool(io);
    expect(spooled).toHaveLength(1);
    expect(spooled[0]?.record.command).toBe("hook");
  });

  it("never throws when the filesystem refuses", () => {
    const broken: GuardIO = {
      ...io,
      mkdirp: () => {
        throw new Error("read-only home");
      },
    };
    expect(() => captureCrash(new Error("x"), deps({ io: broken }))).not.toThrow();
    expect(captureCrash(new Error("x"), deps({ io: broken }))).toBe(false);
  });

  it("never throws when the scrubber explodes", () => {
    const boom = () => {
      throw new Error("scrubber exploded");
    };
    expect(() => captureCrash(new Error("x"), deps({ scrubSecrets: boom }))).not.toThrow();
  });

  it("does not recurse when the capture path itself throws", () => {
    // A crash inside the crash handler must not become an infinite regress.
    let calls = 0;
    const reentrant: GuardIO = {
      ...io,
      mkdirp: (p) => {
        calls += 1;
        captureCrash(new Error("inner"), deps({ io: reentrant }));
        return io.mkdirp(p);
      },
    };
    captureCrash(new Error("outer"), deps({ io: reentrant }));
    expect(calls).toBe(1);
  });
});

describe("capture cannot change what Claude Code sees", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });

  async function decisionOf(hookDeps: Parameters<typeof runHook>[1]): Promise<string> {
    out = [];
    const stdinIo: GuardIO = { ...io, readStdin: async () => payload };
    await runHook(stdinIo, hookDeps);
    return JSON.parse(out.join("")).hookSpecificOutput.permissionDecision;
  }

  it("a throwing capture sink leaves the decision untouched", async () => {
    const throwing = vi.fn(() => {
      throw new Error("capture exploded");
    });
    // `deny` on the good path; the capture sink is not reached at all here.
    expect(await decisionOf({ captureCrash: throwing })).toBe("deny");
  });

  it("a crash on the parse path gives no decision, says so, and captures", async () => {
    const bad: GuardIO = { ...io, readStdin: async () => "not json" };
    const captured: unknown[] = [];
    out = [];
    await runHook(bad, { captureCrash: (e) => void captured.push(e) });
    expect(JSON.parse(out.join(""))).toEqual({ systemMessage: NOT_CHECKED_MESSAGE });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeInstanceOf(Error);
  });

  it("a capture sink that throws ON the error path still emits one message", async () => {
    // The ordering that matters: emit first, capture last. If capture ran before
    // the emit, a throw here would lose the message that the call was not checked.
    const bad: GuardIO = { ...io, readStdin: async () => "not json" };
    out = [];
    await runHook(bad, {
      captureCrash: () => {
        throw new Error("capture exploded");
      },
    });
    const text = out.join("");
    expect(JSON.parse(text)).toEqual({ systemMessage: NOT_CHECKED_MESSAGE });
    expect(out).toHaveLength(1);
  });

  it("with no capture sink at all, behavior is exactly as it was before crash capture", async () => {
    const bad: GuardIO = { ...io, readStdin: async () => "not json" };
    out = [];
    await runHook(bad);
    expect(JSON.parse(out.join(""))).toEqual({ systemMessage: NOT_CHECKED_MESSAGE });
  });
});
