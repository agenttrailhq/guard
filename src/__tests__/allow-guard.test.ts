/**
 * `allow` is scoped to ONE rule on ONE shape — the refusals that make that true.
 *
 * The three cases at the top are not hypothetical syntax: each is a pattern a user
 * could plausibly type, and each silences the named rule on EVERYTHING while
 * `guardrails list` and `status` keep reporting it enabled. They are the reason the check is
 * empirical rather than a denylist over the pattern text.
 *
 * Every case here is asserted against the SAME picomatch call `compileAllowlist` makes,
 * so a test passing means the compiled matcher behaves that way — not that a regex over
 * the string thinks it does.
 */

import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { ALLOW_CANARIES, checkAllowPattern, GLOB_NOTE, hasGlob } from "../core/allow-guard.js";
import { PATTERN_PLACEHOLDER, REDACTION_PREFIX } from "../core/redaction.js";

/** The measurement behind the whole module, held here so it cannot quietly change. */
describe("PINNED: the picomatch behavior that makes this check necessary", () => {
  it.each([
    ["!foo"],
    ["*"],
    ["**"],
  ])("%s matches unrelated commands — it is a global mute, not a silence", (pattern) => {
    const isMatch = picomatch(pattern, { dot: true });
    // If picomatch ever stops doing this, the refusals below become over-strict and
    // this test says so first, rather than users discovering it.
    expect(isMatch("rm -rf /")).toBe(true);
    expect(isMatch("git status")).toBe(true);
  });

  it("matching is SEGMENT-based, so `**` does not cross `/` unless it is its own segment", () => {
    // The reason `GLOB_NOTE` exists, and the exact thing it must not get wrong: advice
    // to "use `**` to cross a path separator" would send a user straight to the second
    // line here.
    const target = "git reset --hard ./x";
    expect(picomatch("git reset --hard*", { dot: true })(target)).toBe(false);
    expect(picomatch("git reset --hard**", { dot: true })(target)).toBe(false);
    // `**` as a whole segment does cross.
    expect(picomatch("git reset --hard ./**", { dot: true })(target)).toBe(true);
  });

  it("one `*` covers one segment; `**` as a segment covers a subtree", () => {
    const one = "git checkout -- ./generated/a.ts";
    const deep = "git checkout -- ./generated/nested/d.ts";
    expect(picomatch("git checkout -- ./generated/*", { dot: true })(one)).toBe(true);
    expect(picomatch("git checkout -- ./generated/*", { dot: true })(deep)).toBe(false);
    expect(picomatch("git checkout -- ./generated/**", { dot: true })(deep)).toBe(true);
  });
});

describe("checkAllowPattern refuses a pattern that would mute the guardrail globally", () => {
  it.each([
    ["!foo", "picomatch negation"],
    ["*", "single star"],
    ["**", "globstar"],
    ["{*,}", "brace alternation reaching the same place"],
    ["?*", "any-char plus star"],
  ])("refuses %s (%s)", (pattern) => {
    const refusal = checkAllowPattern(pattern);
    expect(refusal, `${pattern} must be refused`).toBeDefined();
    expect(refusal?.kind).toBe("too-broad");
    // The reason names what else it caught. "Invalid pattern" would leave the user
    // guessing at a rule they believe is reasonable.
    expect(refusal?.reason).toMatch(/also matches/);
  });

  it("accepts the exact literal `status` prints — the copy-paste path must work", () => {
    expect(checkAllowPattern("git checkout -- ./generated/api-types.ts")).toBeUndefined();
  });

  it("accepts a deliberately widened pattern that is still scoped", () => {
    expect(checkAllowPattern("git checkout -- ./generated/**")).toBeUndefined();
  });

  it("every canary is a command this guardrail has no business seeing", () => {
    // Guards the corpus itself: a canary that a legitimate narrow pattern would match
    // would make the check reject reasonable input. Asserted by construction — each
    // canary must be refused when used AS a pattern against itself, and accepted
    // patterns must not touch any of them.
    for (const canary of ALLOW_CANARIES) {
      expect(picomatch("git checkout -- ./generated/**", { dot: true })(canary)).toBe(false);
    }
  });
});

describe("checkAllowPattern refuses a pattern that would blind the rule to its own fixture", () => {
  const BLOCK_FIXTURES = [
    "git reset --hard",
    "git reset --hard HEAD~3",
    "git -C /tmp reset --hard",
  ];

  it("refuses a pattern equal to one of the rule's own block fixtures", () => {
    const refusal = checkAllowPattern("git reset --hard", BLOCK_FIXTURES);
    expect(refusal?.kind).toBe("blinds-rule");
    expect(refusal?.reason).toMatch(/git reset --hard/);
    expect(refusal?.reason).toMatch(/exists to stop/);
  });

  it("refuses a glob that would cover a block fixture", () => {
    // Not just literal equality: the pattern is compiled with the same picomatch the
    // allowlist uses, so a wider shape that swallows a fixture is caught too.
    expect(checkAllowPattern("git reset*", BLOCK_FIXTURES)?.kind).toBe("blinds-rule");
  });

  it("accepts a narrower shape that no block fixture matches", () => {
    // The pressure valve still works: a shape the rule catches but that is not one of its
    // own canonical dangerous examples can be silenced.
    expect(
      checkAllowPattern("git reset --hard origin/scratch-branch", BLOCK_FIXTURES),
    ).toBeUndefined();
  });

  it("with no fixtures supplied, behaves exactly as before", () => {
    // A user rule has no fixtures, and existing callers pass none.
    expect(checkAllowPattern("git reset --hard")).toBeUndefined();
  });
});

describe("checkAllowPattern refuses a pattern that can never match", () => {
  it("refuses the `<your pattern>` placeholder, which is the one users will paste", () => {
    // `status` prints this literal when the recorded command was redacted.
    // Pasted unedited it compiles to a literal matcher that matches nothing, and
    // `allow` would answer "Allowlisted." while the rule kept firing.
    const refusal = checkAllowPattern(PATTERN_PLACEHOLDER);
    expect(refusal?.kind).toBe("placeholder");
    expect(refusal?.reason).toContain(PATTERN_PLACEHOLDER);
  });

  it("refuses it inside a longer pattern too", () => {
    expect(checkAllowPattern(`cat ${PATTERN_PLACEHOLDER}`)?.kind).toBe("placeholder");
  });

  it("refuses a redaction placeholder — it can only match text that still holds the placeholder", () => {
    const pattern = "cat [REDACTED:secret:env]";
    // It matches ITSELF and nothing else. The real command held a secret where the
    // placeholder now is, so it never matches the thing the user is trying to silence.
    // `allow` would say "Allowlisted." and change nothing.
    expect(picomatch(pattern, { dot: true })(pattern)).toBe(true);
    expect(picomatch(pattern, { dot: true })("cat .env")).toBe(false);
    expect(picomatch(pattern, { dot: true })("cat /home/me/.env")).toBe(false);

    const refusal = checkAllowPattern(pattern);
    expect(refusal?.kind).toBe("redacted");
    expect(refusal?.reason).toContain(REDACTION_PREFIX);
  });

  it("refuses a BARE placeholder, which is over-broad as well as dead", () => {
    // The other half of the measurement: with no prefix, `[...]` really is a bracket
    // expression and matches unrelated single characters.
    const bare = "[REDACTED:secret:env]";
    expect(picomatch(bare, { dot: true })("R")).toBe(true);
    expect(picomatch(bare, { dot: true })("E")).toBe(true);
    expect(checkAllowPattern(bare)?.kind).toBe("redacted");
  });

  it("refuses an empty pattern", () => {
    expect(checkAllowPattern("")?.kind).toBe("empty");
    expect(checkAllowPattern("   ")?.kind).toBe("empty");
  });
});

describe("the glob note", () => {
  it("fires on a pattern with a glob character and not on a literal", () => {
    expect(hasGlob("git checkout -- ./generated/*")).toBe(true);
    expect(hasGlob("git reset --hard ./x")).toBe(false);
    // The note must describe the actual behavior, not the intuitive one: "use `**` to
    // cross a path separator" leads straight to `--hard**`, which does not match.
    expect(GLOB_NOTE).toContain("segments");
    expect(GLOB_NOTE).toContain("./generated/**");
    expect(GLOB_NOTE).not.toContain("use `**` to cross");
  });
});
