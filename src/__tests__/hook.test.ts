// cspell:words uncompilable
/**
 * FAIL-OPEN — the property this whole package exists to guarantee.
 *
 * A bug in the guard must never stop the agent.
 *
 * So this suite forces a failure at EVERY seam independently and asserts the same
 * three things each time: the decision is `allow`, exactly one JSON object reaches
 * stdout, and nothing touches the exit code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runHook } from "../commands/hook.js";
import type { GuardRule } from "../core/types.js";
import type { GuardIO } from "../io.js";

interface Harness {
  io: GuardIO;
  written: string[];
}

function harness(overrides: Partial<GuardIO> = {}, stdin = "{}"): Harness {
  const written: string[] = [];
  const io: GuardIO = {
    readStdin: async () => stdin,
    writeStdout: (t) => {
      written.push(t);
    },
    readFile: () => undefined,
    homedir: () => "/home/test",
    // The crash spool's write primitives, plus the decision log's two. Stubbed rather
    // than omitted so a caller cannot silently no-op against an incomplete double.
    //
    // `appendFile`/`fileSize` are NOT inert: `runHook` now wires the real decision
    // recorder by default, so every hook call that matches a rule goes through
    // them. They are stubbed here precisely so no suite writes to a real home
    // directory; `events.test.ts` drives the recorder against a fake filesystem.
    mkdirp: () => true,
    writeFileAtomic: () => true,
    listDir: () => [],
    deleteFile: () => true,
    appendFile: () => true,
    fileSize: () => 0,
    ...overrides,
  };
  return { io, written };
}

function soleDecision(written: string[]): { decision: string; reason: string } {
  expect(written).toHaveLength(1);
  const text = written[0] as string;
  expect(text.startsWith("{")).toBe(true);
  expect(text.endsWith("}")).toBe(true);
  const parsed = JSON.parse(text);
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason,
  };
}

const BLOCKING_RULE: GuardRule = {
  id: "t.block",
  category: "test",
  severity: "high",
  defaultAction: "block",
  title: "blocks danger",
  description: "fixture; does not match anything else",
  match: { any_of: [{ kind: "execute_tool", detail_contains: ["danger"] }] },
};

describe("the happy paths still work", () => {
  it("denies a matching call", async () => {
    const h = harness({}, JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } }));
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });

  it("allows a non-matching call", async () => {
    const h = harness({}, JSON.stringify({ tool_name: "Bash", tool_input: { command: "safe" } }));
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("allow");
  });
});

describe("fail-open: malformed stdin", () => {
  it.each([
    ["empty", ""],
    ["not JSON", "not json at all"],
    ["a JSON array", "[]"],
    ["a JSON string", '"hello"'],
    ["JSON null", "null"],
    ["a number", "42"],
    ["truncated object", '{"tool_name":'],
  ])("%s → allow", async (_label, stdin) => {
    const h = harness({}, stdin);
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("allow");
  });
});

describe("fail-open: a throw at every seam", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } });

  it("readStdin throws → allow", async () => {
    const h = harness({
      readStdin: async () => {
        throw new Error("stdin exploded");
      },
    });
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("allow");
  });

  it("readFile throws → allow (config is never load-bearing for availability)", async () => {
    const h = harness(
      {
        readFile: () => {
          throw new Error("disk exploded");
        },
      },
      payload,
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("allow");
  });

  it("homedir throws → allow", async () => {
    const h = harness(
      {
        homedir: () => {
          throw new Error("no home");
        },
      },
      payload,
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("allow");
  });

  it("a catalog of uncompilable guardrails → allow, not a crash", async () => {
    const broken = { ...BLOCKING_RULE, match: { any_of: [] } } as unknown as GuardRule;
    const h = harness({}, payload);
    await runHook(h.io, { catalog: [broken] });
    expect(soleDecision(h.written).decision).toBe("allow");
  });

  it("a recorder that throws does NOT change the already-emitted decision", async () => {
    const h = harness({}, payload);
    await runHook(h.io, {
      catalog: [BLOCKING_RULE],
      recorder: {
        record() {
          throw new Error("log exploded");
        },
      },
    });
    // Still a deny — the emit happened first, and a failed write is not a reason to
    // change what Claude Code was told.
    expect(soleDecision(h.written).decision).toBe("deny");
  });

  it("a corrupt config file falls back to defaults and still enforces", async () => {
    const h = harness({ readFile: () => "{{{ not json" }, payload);
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });
});

describe("the hook never touches the exit code", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  it.each([
    ["a deny", JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } })],
    ["an allow", JSON.stringify({ tool_name: "Bash", tool_input: { command: "safe" } })],
    ["a crash", "not json"],
  ])("%s leaves process.exitCode untouched", async (_l, stdin) => {
    const h = harness({}, stdin);
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(process.exitCode).toBeUndefined();
  });

  it("never rejects, whatever happens", async () => {
    const h = harness({
      readStdin: async () => {
        throw new Error("boom");
      },
    });
    await expect(runHook(h.io, { catalog: [BLOCKING_RULE] })).resolves.toBeUndefined();
  });
});

describe("the config is read from ~/.agenttrail/guard/config.json", () => {
  it("looks in the right place", async () => {
    const readFile = vi.fn(() => undefined);
    const h = harness({ readFile }, "{}");
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(readFile).toHaveBeenCalledWith("/home/test/.agenttrail/guard/config.json");
  });

  it("honours a per-rule allowlist from that file", async () => {
    const h = harness(
      {
        readFile: () =>
          JSON.stringify({ allowlist: [{ guardrail: "t.block", pattern: "**danger**" }] }),
      },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } }),
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("allow");
  });
});

describe("the decision recorder is wired, and can never block a tool call", () => {
  // `BLOCKING_RULE` matches on the token `danger`; keep this in that vocabulary.
  const PAYLOAD = JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger --now" } });

  it("records a matched decision through the real recorder by default", () => {
    // No `recorder` in deps — production's path. The default is the real writer, so
    // this also proves `hook.ts` is actually wired to it rather than to a no-op.
    const appended: Array<{ path: string; text: string }> = [];
    const h = harness(
      {
        appendFile: (path, text) => {
          appended.push({ path, text });
          return true;
        },
      },
      PAYLOAD,
    );
    return runHook(h.io, { catalog: [BLOCKING_RULE] }).then(() => {
      expect(soleDecision(h.written).decision).toBe("deny");
      expect(appended).toHaveLength(1);
      expect(appended[0]?.path).toBe("/home/test/.agenttrail/guard/events.jsonl");
      expect(JSON.parse(appended[0]?.text as string).ruleId).toBe(BLOCKING_RULE.id);
    });
  });

  it.each([
    "appendFile",
    "fileSize",
    "mkdirp",
    "writeFileAtomic",
  ] as const)("a throw from %s leaves the decision and the output untouched", async (member) => {
    const h = harness(
      {
        [member]: () => {
          throw new Error("disk full");
        },
      },
      PAYLOAD,
    );
    await expect(runHook(h.io, { catalog: [BLOCKING_RULE] })).resolves.toBeUndefined();
    // Still exactly one JSON object, still the same verdict.
    expect(soleDecision(h.written).decision).toBe("deny");
    expect(process.exitCode).toBeUndefined();
  });

  it("a read-only home does not turn a deny into anything else", async () => {
    const h = harness({ mkdirp: () => false, appendFile: () => false }, PAYLOAD);
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });

  it("an unmatched call writes nothing at all", async () => {
    const appended: string[] = [];
    const h = harness(
      {
        appendFile: (_p, text) => {
          appended.push(text);
          return true;
        },
      },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "safe" } }),
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("allow");
    expect(appended).toEqual([]);
  });
});
