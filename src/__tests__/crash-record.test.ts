/**
 * `buildCrashRecord` — what actually leaves the machine.
 *
 * The adversarial cases are the point. Every other scrubbed surface in this product
 * (`events.jsonl`, the scan report) stays on the user's disk, where a miss is
 * embarrassing but containable. This one is the only thing that is transmitted, so
 * the tests are written as attacks rather than as happy paths.
 *
 * The secret scrubber is INJECTED here. The real one is `core/scrub.ts`;
 * this file uses a deliberately minimal stand-in so the record
 * builder's own behavior — the composition order, the message drop, the never-throw
 * contract — is what is under test. `crash-composition.test.ts` covers the wiring to
 * the real module.
 */

import { describe, expect, it } from "vitest";
import { buildCrashRecord, CRASH_RECORD_VERSION, type CrashMeta } from "../core/crash-record.js";
// The REAL scrubber, for the ordering block at the bottom.
import { scrubText } from "../core/scrub.js";

const META: CrashMeta = {
  ts: "2026-09-07T12:00:00.000Z",
  guardVersion: "0.1.0",
  nodeVersion: "v20.0.0",
  platform: "darwin",
  command: "hook",
};

/** Stands in for `scrubText`. Same shape, three patterns. */
const scrub = (t: string) => ({
  text: t
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/postgres:\/\/[^\s)]+/g, "[REDACTED]"),
});

/** Build an Error with a stack we control exactly. */
function errWith(name: string, message: string, frames: string[]): Error {
  const e = new Error(message);
  e.name = name;
  e.stack = [`${name}: ${message}`, ...frames].join("\n");
  return e;
}

describe("stack traces only — the message never survives", () => {
  it("drops a SyntaxError message that quotes the user's command", () => {
    // The most likely crash in this binary: JSON.parse on the PreToolUse payload.
    // Its message embeds a slice of what the user just ran, and a scrubber tuned
    // for secret SHAPES cannot catch it, because a command is not a shape.
    const e = errWith(
      "SyntaxError",
      `Unexpected token 'r', "rm -rf /home/priya/prod-backups" is not valid JSON`,
      ["    at JSON.parse (<anonymous>)", "    at parsePayload (/app/dist/cli.js:4:5)"],
    );
    const rec = buildCrashRecord(e, META, scrub);
    expect(JSON.stringify(rec)).not.toContain("rm -rf");
    expect(JSON.stringify(rec)).not.toContain("prod-backups");
    expect(JSON.stringify(rec)).not.toContain("priya");
  });

  it("keeps the error NAME, which is a closed set we control", () => {
    expect(buildCrashRecord(errWith("TypeError", "x", []), META, scrub).errorName).toBe(
      "TypeError",
    );
  });

  it("has no message field at all — not an empty one", () => {
    const rec = buildCrashRecord(errWith("Error", "secret", []), META, scrub);
    expect(Object.keys(rec)).not.toContain("message");
    expect(JSON.stringify(rec)).not.toContain("secret");
  });

  it("carries no environment, argv, or cwd", () => {
    const json = JSON.stringify(buildCrashRecord(errWith("Error", "x", []), META, scrub));
    for (const forbidden of ["PATH", "HOME", "argv", "cwd", "env"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe("secrets and paths are both gone — and each pass is load-bearing", () => {
  const nasty = errWith("Error", "boom", [
    "    at a (/Users/priya/acme-secret-client/src/billing.ts:1:1)",
    "    at b (/app/dist/cli.js:2:2) AKIA0123456789ABCDEF",
    "    at c (/app/dist/cli.js:3:3) postgres://u:pw@db.internal/prod",
  ]);

  it("no AWS key, PEM header or connection string survives", () => {
    const json = JSON.stringify(buildCrashRecord(nasty, META, scrub));
    expect(json).not.toContain("AKIA0123456789ABCDEF");
    expect(json).not.toContain("postgres://");
    expect(json).not.toContain("db.internal");
  });

  it("no path, project name or username survives", () => {
    const json = JSON.stringify(buildCrashRecord(nasty, META, scrub));
    expect(json).not.toContain("priya");
    expect(json).not.toContain("acme-secret-client");
  });

  it("a secret in the FUNCTION NAME needs the secret pass — the path pass keeps heads", () => {
    // Finding, recorded because it is not obvious and it decides the scrub order:
    // `scrubPaths` rebuilds each frame as `<head> (<location>)`, so it discards
    // anything trailing the location entirely — a secret appended after the closing
    // paren is dropped by the PATH pass alone. What it preserves verbatim is the
    // HEAD, because that is our own call path and the useful part of a report.
    // So the head is exactly where the secret pass earns its place, and this is the
    // case that proves it is not decorative.
    const e = errWith("Error", "x", ["    at handlerAKIA0123456789ABCDEF (/app/dist/cli.js:1:1)"]);
    expect(buildCrashRecord(e, META, scrub).frames).not.toContain("AKIA");
    // With a no-op secret scrubber the key survives — the mutation, pinned.
    expect(buildCrashRecord(e, META, (t) => ({ text: t })).frames).toContain("AKIA");
  });

  it("a secret trailing a frame is dropped by the path pass alone — belt and braces", () => {
    // The other half of the same finding: two independent mechanisms cover the
    // trailing position, so losing either one still redacts it.
    const e = errWith("Error", "x", ["    at f (/app/dist/cli.js:1:1) AKIA0123456789ABCDEF"]);
    expect(buildCrashRecord(e, META, (t) => ({ text: t })).frames).not.toContain("AKIA");
  });

  it("a path that carries no secret needs the path pass — the secret pass keeps it", () => {
    // The counterpart of the case above, proving the path half is not decorative either.
    const e = errWith("Error", "x", ["    at f (/Users/priya/acme-secret-client/a.ts:1:1)"]);
    expect(buildCrashRecord(e, META, scrub).frames).not.toContain("priya");
    // The stand-in secret scrubber has no path pattern — exactly like the real one.
    expect(scrub("/Users/priya/acme-secret-client/a.ts").text).toContain("priya");
  });
});

describe("it never throws, whatever it is handed", () => {
  it.each([
    ["a thrown string", "boom"],
    ["undefined", undefined],
    ["null", null],
    ["a plain object", { code: 1 }],
    ["a number", 42],
  ])("%s produces a NonError record rather than throwing", (_l, thrown) => {
    const rec = buildCrashRecord(thrown, META, scrub);
    expect(rec.errorName).toBe("NonError");
    expect(rec.frames).toBe("");
    expect(JSON.stringify(rec)).not.toContain("boom");
  });

  it("survives an Error with no stack", () => {
    const e = new Error("x");
    e.stack = undefined;
    expect(buildCrashRecord(e, META, scrub).frames).toBe("");
  });

  it("survives a scrubber that throws — an empty frame list beats a second crash", () => {
    const rec = buildCrashRecord(errWith("Error", "x", ["    at f (node:fs:1:1)"]), META, () => {
      throw new Error("scrubber exploded");
    });
    expect(rec.frames).toBe("");
    expect(rec.errorName).toBe("Error");
  });
});

describe("the record shape is stable and versioned", () => {
  it("carries a version the receiver can switch on", () => {
    expect(buildCrashRecord(new Error("x"), META, scrub).v).toBe(CRASH_RECORD_VERSION);
  });

  it("its keys are exactly the documented set", () => {
    const rec = buildCrashRecord(new Error("x"), META, scrub);
    expect(Object.keys(rec).sort()).toEqual(
      [
        "command",
        "errorName",
        "frames",
        "guardVersion",
        "nodeVersion",
        "platform",
        "ts",
        "v",
      ].sort(),
    );
  });

  it("`command` is the guard's own subcommand, never user input", () => {
    expect(buildCrashRecord(new Error("x"), { ...META, command: "scan" }, scrub).command).toBe(
      "scan",
    );
  });
});

describe("SCRUB THE FIELD, THEN SERIALIZE — order, against the real scrubber", () => {
  /**
   * The rule this pins, and why it is not a formatting preference.
   *
   * `JSON.stringify` escapes a quote to `\"`. The `.env` heuristic in
   * `core/scrub.ts` has a quoted branch that needs a literal `"` and an unquoted
   * branch that EXCLUDES `"`, so neither matches the escaped form:
   *
   *   field-first     → {"command":"export API_KEY=[REDACTED:secret:env]"}
   *   serialize-first → {"command":"export API_KEY=\"abcd1234wxyz\""}   ← leaks
   *
   * Against the real `core/scrub.ts`. `buildCrashRecord` scrubs
   * the raw stack STRING and returns an object; `crash-store.ts` and
   * `crash-transport.ts` serialize that already-clean object. Inverting it is a
   * leak, not a refactor — which is exactly why the inverted form is asserted below
   * rather than described in a comment.
   */
  const QUOTED_SECRET = 'export API_KEY="abcd1234wxyz"';

  it("the real scrubber redacts the field form", () => {
    expect(scrubText(QUOTED_SECRET).text).not.toContain("abcd1234wxyz");
  });

  it("and demonstrably FAILS on the serialized form — the reason for the order", () => {
    // The negative control. If this ever starts passing, the hazard is gone and this
    // whole block can be simplified; until then it is the proof the order matters.
    expect(scrubText(JSON.stringify({ command: QUOTED_SECRET })).text).toContain("abcd1234wxyz");
  });

  it("a crash record built the production way carries no quoted secret, even serialized", () => {
    // End to end through the real binding: secret in a frame HEAD, which is the
    // position `scrubPaths` preserves, so only the secret pass can remove it.
    const e = errWith("Error", "x", [`    at ${QUOTED_SECRET} (/app/dist/cli.js:1:1)`]);
    const rec = buildCrashRecord(e, META, scrubText);
    expect(JSON.stringify(rec)).not.toContain("abcd1234wxyz");
  });

  it("the spooled bytes round-trip through JSON.parse unchanged", () => {
    // The other half of "scrub the field": the record stays valid JSON, so a reader
    // gets back exactly the redacted text rather than a re-escaped approximation.
    const e = errWith("Error", "x", [`    at ${QUOTED_SECRET} (/app/dist/cli.js:1:1)`]);
    const rec = buildCrashRecord(e, META, scrubText);
    const round = JSON.parse(JSON.stringify(rec));
    expect(round).toEqual(rec);
    expect(round.frames).not.toContain("abcd1234wxyz");
  });
});
