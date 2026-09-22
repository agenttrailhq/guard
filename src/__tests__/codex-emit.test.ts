/**
 * `buildCodexAnswer` — the verdict-to-answer table for Codex's two events — and
 * `createCodexEmitter`, which writes it.
 *
 * Three properties are pinned by name here, because each one failing is silent:
 *
 * 1. **Exactly the accepted fields.** Measured on codex-cli 0.154.0, a valid deny carrying
 *    one extra field was discarded whole and the action RAN. A renamed or added key here
 *    would disable the guard while it still looked installed.
 * 2. **Never `ask`, never `allow`.** `ask` is rejected and the action runs — which is why
 *    an approval is a deny. A bare `allow` is rejected at `PreToolUse` and, at
 *    `PermissionRequest`, would skip Codex's own approval card.
 * 3. **The message stands on its own.** Codex prints it verbatim and the model repeats it,
 *    so it names the product, says what happened, and names the guardrail.
 */

import { RULES } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import {
  buildCodexAnswer,
  CODEX_APPROVAL_LEAD,
  codexApprovalMessage,
  codexSystemMessage,
  createCodexEmitter,
  NO_ANSWER,
} from "../core/codex-emit.js";
import type { CodexCheckedEvent } from "../core/codex-mapper.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { APPROVAL_LEAD, BLOCK_LEAD, compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardDecision, MappedCall } from "../core/types.js";

const EVENTS: readonly CodexCheckedEvent[] = ["PreToolUse", "PermissionRequest"];

const BLOCKED: GuardDecision = {
  decision: "deny",
  reason: `${BLOCK_LEAD}Block git force-push (guardrail wt.force-push)`,
  matches: [{ ruleId: "wt.force-push", action: "block" }],
};

const APPROVAL: GuardDecision = {
  decision: "ask",
  reason: `${APPROVAL_LEAD}Writing to a system directory (guardrail fs.system-paths)`,
  matches: [{ ruleId: "fs.system-paths", action: "require_approval" }],
};

const WARNING: GuardDecision = {
  decision: "allow",
  reason:
    "agenttrail-guard is warning about this: Installing a new dependency (guardrail sc.install)",
  matches: [{ ruleId: "sc.install", action: "warn" }],
};

const NOTHING: GuardDecision = { decision: "allow", reason: "", matches: [] };

/** Every verdict, so a sweep cannot quietly cover only one of them. */
const VERDICTS = [
  ["a block", BLOCKED],
  ["an approval", APPROVAL],
  ["a warning", WARNING],
  ["no match", NOTHING],
] as const;

describe("PreToolUse answers", () => {
  it("a block is a deny carrying the verdict's own reason", () => {
    expect(JSON.parse(buildCodexAnswer({ event: "PreToolUse", decision: BLOCKED }).output)).toEqual(
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: BLOCKED.reason,
        },
      },
    );
  });

  it("an approval is a deny too, with a message that says why nobody was asked", () => {
    // `ask` is rejected and the action runs, so there is nothing else an approval can be.
    expect(
      JSON.parse(buildCodexAnswer({ event: "PreToolUse", decision: APPROVAL }).output),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: codexApprovalMessage(APPROVAL.reason),
      },
    });
  });

  it("a warning is a systemMessage and no decision", () => {
    expect(buildCodexAnswer({ event: "PreToolUse", decision: WARNING }).output).toBe(
      JSON.stringify({ systemMessage: WARNING.reason }),
    );
  });

  it("no match writes nothing at all", () => {
    expect(buildCodexAnswer({ event: "PreToolUse", decision: NOTHING }).output).toBe(NO_ANSWER);
  });
});

describe("PermissionRequest answers", () => {
  it("a block denies the escalation, which beats Codex's own reviewer", () => {
    expect(
      JSON.parse(buildCodexAnswer({ event: "PermissionRequest", decision: BLOCKED }).output),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: BLOCKED.reason },
      },
    });
  });

  it("an approval denies it as well, with the same message the other event carries", () => {
    expect(
      JSON.parse(buildCodexAnswer({ event: "PermissionRequest", decision: APPROVAL }).output),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: codexApprovalMessage(APPROVAL.reason) },
      },
    });
  });

  it.each([
    ["a warning", WARNING],
    ["no match", NOTHING],
  ])("%s writes nothing, so Codex's own card is left alone", (_label, decision) => {
    // A warning is said once, at `PreToolUse`. Saying it here too would print the same
    // sentence twice for one action — and an `allow` here would skip the card entirely.
    expect(buildCodexAnswer({ event: "PermissionRequest", decision }).output).toBe(NO_ANSWER);
  });
});

describe("the shape Codex accepts, field by field", () => {
  it("a PreToolUse deny carries exactly three fields, and one top-level key", () => {
    // Measured: one unknown field voids the whole answer and the action runs.
    const parsed = JSON.parse(buildCodexAnswer({ event: "PreToolUse", decision: BLOCKED }).output);
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput)).toEqual([
      "hookEventName",
      "permissionDecision",
      "permissionDecisionReason",
    ]);
  });

  it("a PermissionRequest deny carries exactly the event name and the decision", () => {
    const parsed = JSON.parse(
      buildCodexAnswer({ event: "PermissionRequest", decision: BLOCKED }).output,
    );
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput)).toEqual(["hookEventName", "decision"]);
    expect(Object.keys(parsed.hookSpecificOutput.decision)).toEqual(["behavior", "message"]);
  });

  it("a warning carries exactly one field", () => {
    expect(Object.keys(JSON.parse(codexSystemMessage("hello")))).toEqual(["systemMessage"]);
  });

  it("every answer is either empty or one whole JSON object", () => {
    for (const event of EVENTS) {
      for (const [label, decision] of VERDICTS) {
        const { output } = buildCodexAnswer({ event, decision });
        if (output === NO_ANSWER) continue;
        expect(output.startsWith("{"), `${label} at ${event}`).toBe(true);
        expect(output.endsWith("}"), `${label} at ${event}`).toBe(true);
        expect(() => JSON.parse(output)).not.toThrow();
      }
    }
  });
});

describe("never ask, never allow", () => {
  it("no answer to any verdict on either event decides ask or allow", () => {
    for (const event of EVENTS) {
      for (const [label, decision] of VERDICTS) {
        const { output } = buildCodexAnswer({ event, decision });
        if (output === NO_ANSWER) continue;
        const parsed = JSON.parse(output);
        const specific = parsed.hookSpecificOutput;
        const where = `${label} at ${event}`;
        expect(specific?.permissionDecision, where).not.toBe("ask");
        expect(specific?.permissionDecision, where).not.toBe("allow");
        expect(specific?.decision?.behavior, where).not.toBe("allow");
      }
    }
  });

  it("the words appear nowhere in any answer, not even inside a message", () => {
    // A deny whose MESSAGE happened to be built from the word would still be a deny, but
    // this keeps the sweep honest about what is being asserted.
    for (const event of EVENTS) {
      for (const [, decision] of VERDICTS) {
        const { output } = buildCodexAnswer({ event, decision });
        expect(output).not.toContain('"ask"');
        expect(output).not.toContain('"allow"');
      }
    }
  });
});

describe("the message a person reads", () => {
  it("replaces the approval lead rather than doubling it", () => {
    const message = codexApprovalMessage(APPROVAL.reason);
    expect(message.startsWith(CODEX_APPROVAL_LEAD)).toBe(true);
    expect(message).not.toContain(APPROVAL_LEAD);
    expect(message).toContain("Writing to a system directory (guardrail fs.system-paths)");
  });

  it("keeps a reason that was built some other way whole", () => {
    expect(codexApprovalMessage("something else entirely")).toBe(
      `${CODEX_APPROVAL_LEAD}something else entirely`,
    );
  });

  it("names the product, says a person must approve, and says it is blocked", () => {
    // Codex prints this text verbatim and the model repeats it, so all three have to be
    // in the sentence itself — there is no second place the user can look.
    expect(CODEX_APPROVAL_LEAD).toContain("agenttrail-guard");
    expect(CODEX_APPROVAL_LEAD).toContain("approve");
    expect(CODEX_APPROVAL_LEAD).toContain("blocked");
  });

  it("every deny the real catalogue can produce carries a non-empty reason naming a guardrail", () => {
    // The emitter invents no text: an answer with an empty reason would block a command
    // and explain nothing. What keeps that from happening is the verdict, so it is the
    // verdicts of the shipped rules that are checked.
    const catalog = compileCatalog(RULES, DEFAULT_CONFIG);
    const allowlist = compileAllowlist([]);
    const seen = new Set<string>();
    for (const rule of RULES) {
      for (const fixture of rule.fixtures.block) {
        const mapped: MappedCall =
          "command" in fixture
            ? { tool: "Bash", args: { full_command: fixture.command } }
            : { tool: "Write", args: { file_path: fixture.file_path } };
        const decision = evaluateCall(catalog, buildGuardSpanContext(mapped), mapped, allowlist);
        if (decision.decision === "allow") continue;
        seen.add(decision.decision);
        const lead = decision.decision === "deny" ? BLOCK_LEAD : CODEX_APPROVAL_LEAD;
        for (const event of EVENTS) {
          const parsed = JSON.parse(buildCodexAnswer({ event, decision }).output);
          const message: string =
            parsed.hookSpecificOutput.permissionDecisionReason ??
            parsed.hookSpecificOutput.decision.message;
          expect(message.startsWith(lead), rule.id).toBe(true);
          // Something after the lead: a sentence that stopped at "blocked this:" names
          // nothing the user could go and look at.
          expect(message.slice(lead.length).trim(), rule.id).toContain("guardrail");
        }
      }
    }
    // Both verdicts really occur, so the sweep above is not vacuous.
    expect([...seen].sort()).toEqual(["ask", "deny"]);
  });
});

describe("which event offers the decision to the log", () => {
  it.each([
    ["a block", BLOCKED, true, true],
    ["an approval", APPROVAL, true, true],
    ["a warning", WARNING, true, true],
    ["no match", NOTHING, false, false],
  ])("%s: PreToolUse %s, PermissionRequest %s", (_label, decision, pre, permission) => {
    // Both events offer it, and the key in `core/codex-mapper.ts` folds the pair into one
    // line. A call that matched nothing is not recorded at all.
    expect(buildCodexAnswer({ event: "PreToolUse", decision }).record).toBe(pre);
    expect(buildCodexAnswer({ event: "PermissionRequest", decision }).record).toBe(permission);
  });
});

describe("createCodexEmitter", () => {
  it("writes the first answer and ignores every later one", () => {
    const written: string[] = [];
    const emitter = createCodexEmitter({ write: (text) => written.push(text) });
    emitter.emit('{"systemMessage":"first"}');
    emitter.emit('{"systemMessage":"second"}');
    expect(written).toEqual(['{"systemMessage":"first"}']);
    expect(emitter.hasEmitted()).toBe(true);
  });

  it("a first answer of nothing still wins, so a later path cannot decide instead", () => {
    const written: string[] = [];
    const emitter = createCodexEmitter({ write: (text) => written.push(text) });
    emitter.emit(NO_ANSWER);
    emitter.emit('{"systemMessage":"too late"}');
    expect(written).toEqual([]);
    expect(emitter.hasEmitted()).toBe(true);
  });
});
