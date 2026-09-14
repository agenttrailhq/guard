// cspell:words pastable
/**
 * The two strings that cross the decision-log / `guardrails` boundary.
 *
 * `isRedacted` is a DETECTION, and a detection that stops matching fails silently: it
 * simply starts returning `false`, and `guardrails allow` goes back to accepting a pattern
 * that can never fire. So the prefix is not asserted against this module's own
 * constant — that would only prove the file agrees with itself. It is asserted against
 * the output of a REAL `scrubText` run over a real secret, so a change to the
 * placeholder shape reds the build instead of quietly disabling the check.
 */

import { describe, expect, it } from "vitest";
import { isRedacted, PATTERN_PLACEHOLDER, REDACTION_PREFIX } from "../core/redaction.js";
import { scrubText } from "../core/scrub.js";

describe("PINNED against the real scrubber", () => {
  it.each([
    ["an AWS access key", "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE"],
    [
      "a GitHub token",
      "git remote set-url origin https://ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com/x/y",
    ],
  ])("%s is replaced by something isRedacted() recognizes", (_name, command) => {
    const scrubbed = scrubText(command).text;
    // The scrubber actually did something — otherwise the next assertion is vacuous.
    expect(scrubbed, "scrubText left this untouched, so this case proves nothing").not.toBe(
      command,
    );
    expect(scrubbed).toContain(REDACTION_PREFIX);
    expect(isRedacted(scrubbed)).toBe(true);
  });

  it("does NOT fire on an ordinary command", () => {
    // The other direction. A detector that always returned true would pass every
    // assertion above while refusing every legitimate pattern a user types.
    const plain = "git reset --hard ./x";
    expect(scrubText(plain).text).toBe(plain);
    expect(isRedacted(plain)).toBe(false);
  });

  it("a plain `.env` PATH is not redacted — the scrubber matches value shapes", () => {
    // `scrubText` looks for things shaped like secrets, not for paths that tend to hold
    // them, so `cat /home/me/.env` passes through whole.
    //
    // It is pinned rather than merely noted because it decides how `guardrails allow`
    // behaves on the most likely `block-env-file-read` case: the command reaches
    // `status` intact, so the printed line IS pastable and this refusal must not fire.
    // If the scrubber ever widens to cover paths, this goes red and the interaction
    // gets looked at rather than discovered by a user whose valve stopped working.
    const envRead = "cat /home/me/project/.env";
    expect(scrubText(envRead).text).toBe(envRead);
    expect(isRedacted(envRead)).toBe(false);
  });
});

describe("isRedacted", () => {
  it("finds a placeholder anywhere in the text, not only at the start", () => {
    // The realistic shape: the command survives and only the secret is replaced.
    expect(isRedacted("cat [REDACTED:secret:env]")).toBe(true);
    expect(isRedacted("[REDACTED:secret:env]")).toBe(true);
  });

  it("is false for text that merely mentions redaction", () => {
    expect(isRedacted("echo REDACTED")).toBe(false);
    expect(isRedacted("echo [redacted]")).toBe(false);
  });
});

describe("PATTERN_PLACEHOLDER", () => {
  it("is the literal `status` prints, and is not itself a usable pattern", () => {
    // If this were ever changed to something a user might legitimately type, the
    // refusal in `allow-guard.ts` would start rejecting real input.
    expect(PATTERN_PLACEHOLDER).toBe("<your pattern>");
  });
});
