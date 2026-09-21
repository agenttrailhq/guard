// cspell:disable -- asserts against credential-SHAPED synthetic fixtures.
/**
 * The secret scrubber's behavioral suite.
 *
 * Every assertion is against the module itself: a real secret shape goes in, and the
 * exact placeholder comes out. The negative cases matter as much as the positive ones:
 * a scrubber that returned `"[REDACTED]"` for every input would satisfy every positive
 * case, and only the negative cases fail it.
 */

import { describe, expect, it } from "vitest";
import { PATTERN_IDS, scrubText } from "../core/scrub.js";
import { INTERACTION_FIXTURES, NEGATIVE_FIXTURES, POSITIVE_FIXTURES } from "./scrub-corpus.js";

const SENTINEL = String.fromCharCode(0xe000);

describe("the corpus itself is complete", () => {
  it("covers every pattern, exactly once", () => {
    // A corpus with a hole would leave a pattern untested, so its completeness is
    // asserted rather than eyeballed.
    expect(POSITIVE_FIXTURES.map((f) => f.id).sort()).toEqual([...PATTERN_IDS].sort());
  });

  it("carries the full standard catalog — 14 patterns, no subset", () => {
    expect(PATTERN_IDS).toHaveLength(14);
    expect(new Set(PATTERN_IDS).size).toBe(14);
  });
});

describe("correctness — each pattern redacts its own secret shape", () => {
  it.each(POSITIVE_FIXTURES)("$id", ({ id, input, secret, placeholder }) => {
    const result = scrubText(input);

    // 1. The secret is gone. This is the only assertion that actually matters to a
    //    reader of a leaked report, so it comes first.
    expect(result.text).not.toContain(secret);
    // 2. The EXACT placeholder is emitted — not merely "something was redacted".
    expect(result.text).toContain(placeholder);
    // 3. Attributed to the right pattern, and counted once. A copy that redacted
    //    via the wrong pattern would pass 1 and 2 and fail here.
    expect(result.redactions).toEqual({ [id]: 1 });
    expect(result.total).toBe(1);
  });

  it("no placeholder ever echoes a meaningful run of the secret it replaced", () => {
    // Every emitted placeholder is checked against EVERY 6-character window of the
    // secret it replaced. No secret-class placeholder carries a hint any more — the AWS
    // key-id last-4 and the connection-string host were both dropped, because each
    // fingerprints something a shared report should not disclose — so every placeholder
    // is a bare `[REDACTED:kind]`. This is the general guard that catches a NEW hint that
    // leaks; the exact placeholders are pinned by the per-fixture assertions above.
    for (const { id, input, secret } of POSITIVE_FIXTURES) {
      const emitted = scrubText(input).text.match(/\[REDACTED:[^\]]*\]/g) ?? [];
      expect(emitted.length, id).toBeGreaterThan(0);
      for (const placeholder of emitted) {
        for (let i = 0; i + 6 <= secret.length; i++) {
          expect(placeholder, `${id} leaked a fragment of its secret`).not.toContain(
            secret.slice(i, i + 6),
          );
        }
      }
    }
  });
});

describe("correctness — benign strings survive untouched", () => {
  // THE assertions that exclude a degenerate copy. Without them, `() => "[REDACTED]"`
  // passes every positive case above and agrees with an equally broken twin.
  it.each(NEGATIVE_FIXTURES)("$name", ({ input }) => {
    expect(scrubText(input)).toEqual({ text: input, redactions: {}, total: 0 });
  });

  it("a Luhn-invalid digit run is neither redacted NOR counted", () => {
    // Stated separately from the fixture loop because the tally is the half a
    // text-only check would miss: suppressing the replacement while still
    // incrementing the counter produces identical text and a wrong report.
    const result = scrubText("order 4111111111111112 shipped");
    expect(result.text).toContain("4111111111111112");
    expect(result.redactions["credit-card"]).toBeUndefined();
    expect(result.total).toBe(0);
  });

  it("rejects digit runs on both sides of the Luhn length window", () => {
    // < 13 digits and > 19 digits both fail before the checksum runs.
    expect(scrubText("id 411111111111").total).toBe(0); // 12
    expect(scrubText("id 41111111111111111111").total).toBe(0); // 20
  });
});

describe("engine semantics carried over from the source of truth", () => {
  it("an empty string short-circuits", () => {
    expect(scrubText("")).toEqual({ text: "", redactions: {}, total: 0 });
  });

  it("counts repeats rather than deduplicating", () => {
    const result = scrubText("AKIAIOSFODNN7EXAMPLE then AKIAJ7RQEXAMPLE12345");
    expect(result.redactions).toEqual({ "aws-access-key-id": 2 });
    expect(result.total).toBe(2);
  });

  it.each(INTERACTION_FIXTURES)("$name", ({ input, expected }) => {
    const result = scrubText(input);
    expect(result.redactions).toEqual(expected);
    expect(result.total).toBe(Object.values(expected).reduce((a, b) => a + b, 0));
  });

  it("an emitted placeholder is inert to every later pattern", () => {
    // The sentinel guarantee. `[REDACTED:secret:private-key]` contains
    // `PRIVATE KEY`-ish text that the broad `.env` heuristic could otherwise clip,
    // and the placeholder must come out whole.
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----";
    const result = scrubText(pem);
    expect(result.text).toBe("[REDACTED:secret:private-key]");
    expect(result.total).toBe(1);
  });

  it("does NOT delete a legitimate U+E000 when nothing is redacted", () => {
    // The engine strips the sentinel into a WORKING COPY while scanning. On a
    // zero-redaction value it must return the ORIGINAL string, or it silently eats
    // a legitimate private-use character out of a user's content.
    const input = `private use ${SENTINEL} char, nothing to redact`;
    const result = scrubText(input);
    expect(result.text).toBe(input);
    expect(result.text).toContain(SENTINEL);
    expect(result.total).toBe(0);
  });

  it("strips a pre-existing U+E000 when a redaction DOES occur, without collision", () => {
    // The other branch: once the working copy is returned, a pre-existing sentinel
    // must already be gone, or it would collide with the placeholder scheme and the
    // final restore pass would substitute the wrong slot.
    const result = scrubText(`${SENTINEL} AKIAIOSFODNN7EXAMPLE`);
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).toBe(" [REDACTED:secret:aws]");
    expect(result.total).toBe(1);
  });

  it("preserves the key name and the ORIGINAL separator in an assignment", () => {
    // Re-emitting the CAPTURED separator rather than a hard-coded `=` is what keeps
    // `key: value` from being rewritten as `key=value`.
    expect(scrubText("API_KEY=abcd1234efgh").text).toBe("API_KEY=[REDACTED:secret:env]");
    expect(scrubText("api_key: abcd1234efgh").text).toBe("api_key: [REDACTED:secret:env]");
  });

  it("PINNED: a quoted JSON value loses its quotes, so the output is not valid JSON", () => {
    // Known behavior, pinned so it is visible rather than discovered.
    //
    // The separator group covers the KEY's closing quote (`": `); the VALUE's own
    // quotes are consumed by the value alternation and are not re-emitted. So a
    // JSON object comes back with an unquoted placeholder and no longer parses.
    //
    // It matters for the `scan` report and `events.jsonl` only if they ever scrub a JSON
    // blob and then re-parse it — they must scrub for DISPLAY, after serializing, not
    // before.
    expect(scrubText('{"api_key": "abcd1234efgh"}').text).toBe(
      '{"api_key": [REDACTED:secret:env]}',
    );
  });

  it("is safe to call repeatedly — the shared global regexes carry no state", () => {
    // Every catalog entry is a `g`-flagged RegExp reused across calls. `replace`
    // resets `lastIndex`; `test`/`exec` do not. If anyone "tidies" a pattern into a
    // `.test()` guard, every other call starts returning a different answer.
    const input = "AKIAIOSFODNN7EXAMPLE and priya@acme.io";
    const first = scrubText(input);
    for (let i = 0; i < 5; i++) expect(scrubText(input)).toEqual(first);
  });

  it("PINNED: scrubbing is NOT idempotent — scrub once, at the boundary", () => {
    // Known behavior, pinned because the opposite is the natural assumption.
    //
    // The `.env` heuristic matches the word `secret` inside the placeholder the
    // catalog itself emits (`[REDACTED:secret:aws]` is `secret` + `:` + a value), so a
    // second pass mangles the first pass's output and inflates the tally.
    //
    // The consequence for the consumers: **scrub exactly once, at the point of
    // display/write.** The `scan` report and `events.jsonl` read independent sources
    // today, so nothing double-scrubs — but if either ever scrubs a value that came
    // from the other, this is what happens.
    const once = scrubText("AKIAIOSFODNN7EXAMPLE and priya@acme.io").text;
    expect(once).toBe("[REDACTED:secret:aws] and [REDACTED:pii:email]");

    const twice = scrubText(once);
    expect(twice.text).not.toBe(once);
    expect(twice.redactions).toEqual({ "env-secret": 1 });
  });
});
