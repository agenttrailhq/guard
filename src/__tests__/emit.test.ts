/**
 * The emitter: the exact wire shape Claude Code reads, and the at-most-one-object guarantee.
 * A renamed field would make Claude Code read the output as plain text and run the tool.
 */

import { describe, expect, it } from "vitest";
import { buildHookOutput, createEmitter } from "../core/emit.js";

describe("buildHookOutput — wire shape", () => {
  it("carries the exact field names Claude Code reads", () => {
    const parsed = JSON.parse(buildHookOutput("deny", "blocked by rule: x"));
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked by rule: x",
      },
    });
  });

  it("an ask carries the same fields", () => {
    const reason = "agenttrail-guard needs a person to approve this: A rule (guardrail x)";
    const parsed = JSON.parse(buildHookOutput("ask", reason));
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(reason);
  });

  it("starts with { and ends with } — the whole parse contract", () => {
    const out = buildHookOutput("deny", "");
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
  });

  it("escapes a reason containing quotes or newlines rather than breaking the JSON", () => {
    const out = buildHookOutput("deny", 'a "quoted" thing\nand a newline');
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe("buildHookOutput — never allow", () => {
  // A PreToolUse `allow` skips Claude Code's own permission prompt.
  it("an allow with no reason is no output at all", () => {
    expect(buildHookOutput("allow", "")).toBe("");
  });

  it("an allow with a reason is a systemMessage with no decision", () => {
    const reason = "agenttrail-guard is warning about this: A rule (guardrail x)";
    const parsed = JSON.parse(buildHookOutput("allow", reason));
    expect(parsed).toEqual({ systemMessage: reason });
  });

  it("no allow output carries a permission decision", () => {
    for (const reason of [
      "",
      "agenttrail-guard is warning about this: A rule (guardrail x)",
      'a "quoted" reason',
    ]) {
      expect(buildHookOutput("allow", reason)).not.toContain("permissionDecision");
    }
  });
});

describe("createEmitter — at most one object, ever", () => {
  it("writes one object", () => {
    const writes: string[] = [];
    createEmitter({ write: (t) => writes.push(t) }).emit("deny", "x");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] as string)).toHaveProperty("hookSpecificOutput");
  });

  it("writes nothing for an allow with no reason", () => {
    const writes: string[] = [];
    createEmitter({ write: (t) => writes.push(t) }).emit("allow", "");
    expect(writes).toEqual([]);
  });

  it("is idempotent — a second emit is dropped, not appended", () => {
    // Two objects concatenated would start `{` and end `}` yet fail to parse, which
    // Claude Code treats as plain text: the tool call proceeds and the deny is lost.
    const writes: string[] = [];
    const emitter = createEmitter({ write: (t) => writes.push(t) });
    emitter.emit("deny", "first");
    emitter.emit("allow", "second");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("first");
  });

  it("the first call wins even when it wrote nothing", () => {
    const writes: string[] = [];
    const emitter = createEmitter({ write: (t) => writes.push(t) });
    emitter.emit("allow", "");
    emitter.emit("allow", "late message");
    expect(writes).toEqual([]);
  });

  it("reports whether it has emitted", () => {
    const emitter = createEmitter({ write: () => {} });
    expect(emitter.hasEmitted()).toBe(false);
    emitter.emit("allow", "");
    expect(emitter.hasEmitted()).toBe(true);
  });
});

describe("the emit module contains no process.exit (structurally)", () => {
  it("has no exit call anywhere in its source", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../core/emit.ts", import.meta.url)), "utf8");
    // Strip block comments: the header discusses `process.exit` at length on purpose.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/process\s*\.\s*exit\s*\(/);
    expect(code).not.toMatch(/exitCode/);
  });
});
