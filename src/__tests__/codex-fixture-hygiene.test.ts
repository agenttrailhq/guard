/**
 * The committed Codex session files in `fixtures/codex/` carry nothing that identifies a
 * person or a machine.
 *
 * They are built from the key shapes of Codex's session files, not copied from real
 * sessions, and they are held to the same leak patterns as every other fixture tree
 * (`fixture-hygiene.ts`). Two places make this tree sharper than it looks:
 *
 * - a shell call's JavaScript embeds `workdir:"/Users/<name>/…"`, so the home folder is
 *   inside a string inside a string and easy to miss by eye;
 * - Codex names each file after its thread id, so the PATH leaks as readily as the text.
 *
 * Both are covered: every pattern runs over each file's path joined to its contents.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesUnder, LEAKS, scanned } from "./fixture-hygiene.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const ALL_FILES = filesUnder(FIXTURES);
const SESSION_FILES = ALL_FILES.filter((f) => f.endsWith(".jsonl"));

/** Record types `core/codex-transcript/parse.ts` knows, plus the one it counts as unknown. */
const KNOWN_TYPES = new Set([
  "session_meta",
  "turn_context",
  "world_state",
  "event_msg",
  "response_item",
  "token_usage_record",
]);

/** Every line of a fixture, blank lines dropped. */
function linesOf(file: string): string[] {
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

describe("the session-file fixtures exist, in Codex's folder layout", () => {
  it("there are session files to check — a scan over nothing proves nothing", () => {
    // Two days, so the walk is exercised over more than one folder.
    expect(SESSION_FILES.length).toBeGreaterThanOrEqual(2);
    for (const file of SESSION_FILES) {
      expect(file).toMatch(/^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/);
    }
  });

  it("every fixture file is a session file, so none escapes the checks", () => {
    expect(ALL_FILES.filter((f) => !f.endsWith(".jsonl"))).toEqual([]);
  });

  it("every line that is JSON is one record envelope of a type the reader knows", () => {
    for (const file of SESSION_FILES) {
      for (const line of linesOf(file)) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        expect(Object.keys(record).sort(), `${file}: ${line.slice(0, 40)}`).toEqual([
          "ordinal",
          "payload",
          "timestamp",
          "type",
        ]);
        expect(typeof record.timestamp).toBe("string");
        // One record type is deliberately unknown, so "this reader does not know it" has
        // something to count; everything else must be a shape Codex really writes.
        if (record.type !== "some_future_record") {
          expect(KNOWN_TYPES.has(String(record.type)), String(record.type)).toBe(true);
        }
      }
    }
  });

  it("carries exactly the two lines that are not JSON, which the reader counts apart", () => {
    const bad = SESSION_FILES.flatMap((file) =>
      linesOf(file).filter((line) => {
        try {
          JSON.parse(line);
          return false;
        } catch {
          return true;
        }
      }),
    );
    // One in the middle of a file, and one cut-off tail. Both are deliberate.
    expect(bad).toHaveLength(2);
  });
});

describe("each pattern fires on a leak and not on its redacted form", () => {
  it.each(LEAKS)("$name", ({ pattern, leaked, redacted }) => {
    expect(pattern.test(scanned(leaked))).toBe(true);
    expect(pattern.test(scanned(redacted))).toBe(false);
  });
});

describe("no fixture carries a personal detail", () => {
  it.each(ALL_FILES)("%s matches no leak pattern in its path or its text", (file) => {
    const text = scanned(`${file}\n${readFileSync(join(FIXTURES, file), "utf8")}`);
    const hits = LEAKS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
    expect(hits).toEqual([]);
  });

  it("every working directory and shim workdir is under /home/user/", () => {
    const seen: string[] = [];
    for (const file of SESSION_FILES) {
      for (const line of linesOf(file)) {
        let record: { payload?: Record<string, unknown> };
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const payload = record.payload ?? {};
        if (typeof payload.cwd === "string") seen.push(payload.cwd);
        // The command's own working directory, inside the shim's JavaScript.
        if (typeof payload.input === "string") {
          for (const [, dir] of payload.input.matchAll(/workdir:"((?:[^"\\]|\\.)*)"/g)) {
            seen.push(dir ?? "");
          }
        }
      }
    }
    // Both kinds are present, so this is not an assertion over an empty list.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const dir of seen) expect(dir).toMatch(/^\/home\/user\//);
  });
});
