/**
 * `normalizeSpanAttributes`, `normalizePathSeparators` and `buildGuardSpanContext`.
 *
 * The alias is what EVERY command rule reads: `detail_contains` and `detail_matches`
 * match against `detail`. If it stops aliasing, the guard sees no `detail` and every
 * command rule silently stops matching. So the alias is tested EXHAUSTIVELY over its
 * whole behavioral surface — every combination of absent / empty / present for both
 * keys, both branches, and the non-mutation guarantee — not a happy-path sample.
 */

import { describe, expect, it } from "vitest";
import {
  buildGuardSpanContext,
  normalizePathSeparators,
  normalizeSpanAttributes,
} from "../core/normalize.js";

/** absent / empty / present — the three states that matter for a `=== undefined` check. */
const STATES = [
  ["absent", undefined],
  ["empty", ""],
  ["present", "VALUE"],
] as const;

function build(detail: string | undefined, fullCommand: string | undefined, extra: boolean) {
  const attrs: Record<string, string> = {};
  if (detail !== undefined) attrs.detail = detail;
  if (fullCommand !== undefined) attrs.full_command = fullCommand;
  if (extra) attrs.file_path = "/some/path";
  return attrs;
}

describe("normalizeSpanAttributes — every input state", () => {
  // 3 detail states × 3 full_command states × 2 extra-key states = 18 cases.
  for (const [detailName, detail] of STATES) {
    for (const [cmdName, cmd] of STATES) {
      for (const extra of [false, true]) {
        const label = `detail=${detailName}, full_command=${cmdName}, extra=${extra}`;

        it(`aliases full_command only when detail is absent: ${label}`, () => {
          const source = build(detail, cmd, extra);
          const expected =
            detail === undefined && cmd !== undefined ? { ...source, detail: cmd } : source;
          expect(normalizeSpanAttributes(source)).toEqual(expected);
        });

        it(`does not mutate its input: ${label}`, () => {
          const source = build(detail, cmd, extra);
          const before = { ...source };
          normalizeSpanAttributes(source);
          expect(source).toEqual(before);
        });
      }
    }
  }

  // ── Empty strings count as present ──────────────────────────────────────────
  // The check is `=== undefined`, not truthiness; these two rows are where that shows.

  it("an EMPTY-STRING detail is present, and blocks the alias", () => {
    const out = normalizeSpanAttributes({ detail: "", full_command: "rm -rf /" });
    expect(out.detail).toBe("");
  });

  it("an EMPTY-STRING full_command is present, and IS aliased", () => {
    const out = normalizeSpanAttributes({ full_command: "" });
    expect(out.detail).toBe("");
  });

  it("aliases full_command into detail when detail is absent", () => {
    expect(normalizeSpanAttributes({ full_command: "git reset --hard" }).detail).toBe(
      "git reset --hard",
    );
  });

  it("leaves an existing detail alone rather than overwriting it", () => {
    const out = normalizeSpanAttributes({ detail: "kept", full_command: "ignored" });
    expect(out.detail).toBe("kept");
  });

  it("returns the SAME object when it does not alias (no needless copy)", () => {
    const source = { detail: "kept" };
    expect(normalizeSpanAttributes(source)).toBe(source);
  });
});

describe("normalizePathSeparators — the Windows fix", () => {
  it("rewrites every backslash, not just the first", () => {
    expect(normalizePathSeparators("C:\\project\\src\\.env")).toBe("C:/project/src/.env");
  });

  it("leaves a posix path untouched", () => {
    expect(normalizePathSeparators("/home/x/.env")).toBe("/home/x/.env");
  });

  it("handles a mixed-separator path", () => {
    expect(normalizePathSeparators("C:/project\\src/.env")).toBe("C:/project/src/.env");
  });
});

describe("buildGuardSpanContext", () => {
  it("normalizes file_path separators before the evaluator ever sees them", () => {
    const ctx = buildGuardSpanContext({
      tool: "Read",
      args: { file_path: "C:\\project\\.env" },
    });
    expect(ctx.span.attributes.file_path).toBe("C:/project/.env");
  });

  it("does NOT touch backslashes inside a command — they are content, not a path", () => {
    const ctx = buildGuardSpanContext({
      tool: "Bash",
      args: { full_command: 'grep "a\\\\b" file' },
    });
    expect(ctx.span.attributes.full_command).toBe('grep "a\\\\b" file');
  });

  it("aliases the command into detail so the matchers can read it", () => {
    const ctx = buildGuardSpanContext({ tool: "Bash", args: { full_command: "rm -rf /" } });
    expect(ctx.span.attributes.detail).toBe("rm -rf /");
  });

  it("sets kind=execute_tool, label=tool_name, and zero numerics (pre-execution)", () => {
    const ctx = buildGuardSpanContext({ tool: "PowerShell", args: { full_command: "x" } });
    expect(ctx.span.kind).toBe("execute_tool");
    expect(ctx.span.label).toBe("PowerShell");
    expect(ctx.span.tokens).toBe(0);
    expect(ctx.span.cachedTokens).toBe(0);
    expect(ctx.span.durationMs).toBe(0);
    expect(ctx.span.failed).toBe(false);
  });

  it("emits no attributes at all for a call with no channel", () => {
    const ctx = buildGuardSpanContext({ tool: "WebFetch", args: {} });
    expect(ctx.span.attributes).toEqual({});
  });
});
