/**
 * `core/color.ts` — the CLI colour helper, and the invariant that it must never reach
 * the hook.
 *
 * The reachability half of that invariant is `bundle-graph.test.ts`'s, over the import
 * graph. This file covers the behavior: which environments turn colour off, and that
 * "off" really means no escape byte at all rather than a shorter one.
 */

import { describe, expect, it } from "vitest";
import { createColors, hyperlink, NO_COLORS, shouldUseColor } from "../core/color.js";

/**
 * Any ANSI CSI sequence.
 *
 * Built with `String.fromCharCode` rather than written as a regex literal: Biome's
 * `noControlCharactersInRegex` rejects the literal form, and `core/scrub.ts` builds its
 * own sentinel matcher the same way for the same reason.
 */
const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[`);

describe("when colour is used", () => {
  it.each([
    ["a TTY with a plain environment", {}, true, true],
    ["a pipe", {}, false, false],
    ["NO_COLOR set, even on a TTY", { NO_COLOR: "1" }, true, false],
    ["NO_COLOR set to any value", { NO_COLOR: "anything" }, true, false],
    ["an EMPTY NO_COLOR, which is not the signal", { NO_COLOR: "" }, true, true],
    ["TERM=dumb", { TERM: "dumb" }, true, false],
    ["FORCE_COLOR on a pipe", { FORCE_COLOR: "1" }, false, true],
    ["FORCE_COLOR beating NO_COLOR", { FORCE_COLOR: "1", NO_COLOR: "1" }, true, true],
    ["an EMPTY FORCE_COLOR, which is not the signal", { FORCE_COLOR: "" }, false, false],
  ])("%s", (_label, env, isTTY, expected) => {
    expect(shouldUseColor({ env, isTTY })).toBe(expected);
  });
});

describe("the helpers", () => {
  it("wrap text in a code and reset it when enabled", () => {
    const c = createColors(true);
    expect(c.red("x")).toBe("\u001B[31mx\u001B[0m");
    expect(c.bold("x")).toMatch(ANSI);
  });

  it("emit NO escape byte at all when disabled", () => {
    // Not "a shorter sequence" — none. A single stray escape on stdout is what makes
    // Claude Code discard a hook's JSON, and the same byte in a piped scan summary
    // corrupts whatever consumes it.
    const c = createColors(false);
    for (const style of [c.bold, c.dim, c.red, c.green, c.yellow, c.blue, c.cyan]) {
      expect(style("x")).toBe("x");
      expect(style("x")).not.toMatch(ANSI);
    }
  });

  it("negative control — the detector DOES see an escape sequence", () => {
    expect("\u001B[31mx\u001B[0m").toMatch(ANSI);
  });

  it("NO_COLORS is the disabled instance, so a caller has a safe default", () => {
    expect(NO_COLORS.enabled).toBe(false);
    expect(NO_COLORS.cyan("x")).toBe("x");
  });

  it("reports which way it was built", () => {
    expect(createColors(true).enabled).toBe(true);
    expect(createColors(false).enabled).toBe(false);
  });
});

describe("hyperlink", () => {
  const ESC = String.fromCharCode(0x1b);

  it("wraps the text in an OSC 8 link when enabled", () => {
    expect(hyperlink(true, "file:///tmp/r.html", "/tmp/r.html")).toBe(
      `${ESC}]8;;file:///tmp/r.html${ESC}\\/tmp/r.html${ESC}]8;;${ESC}\\`,
    );
  });

  it("is the bare text, with no escape byte, when disabled", () => {
    const plain = hyperlink(false, "file:///tmp/r.html", "/tmp/r.html");
    expect(plain).toBe("/tmp/r.html");
    expect(plain).not.toContain(ESC);
  });
});
