/**
 * The recorded Cursor payloads in `fixtures/cursor/` carry nothing that identifies a person
 * or a machine.
 *
 * Cursor puts the user's home folder, account email, workspace folders and session ids on
 * its hook payloads. Each fixture replaces them: paths under `/home/user/`, the email as
 * `<redacted>`, and ids as `00000000-0000-4000-8000-…` placeholders. This suite fails on
 * any that slipped through, and each pattern is first proven to fire on a leak.
 *
 * The session files under `projects/` are built from the key shapes of Cursor's session
 * files, not from real sessions. They are checked the same way, and so are their folder
 * names, since Cursor names a project folder after its path.
 *
 * The patterns themselves are shared with the other apps' fixture suites; see
 * `fixture-hygiene.ts`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesUnder, LEAKS, PLACEHOLDER_ID, scanned } from "./fixture-hygiene.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");
const FILES = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .sort();

const ALL_FILES = filesUnder(FIXTURES);

/** The session files `scan --agent cursor` reads, in Cursor's folder layout. */
const SESSION_FILES = ALL_FILES.filter((f) => f.endsWith(".jsonl"));

/** A fixture, parsed. */
function load(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
}

describe("the fixtures exist, and each is one Cursor payload", () => {
  it("there are fixtures to check — a scan over nothing proves nothing", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(FILES)("%s is a payload object, not a recording wrapper", (file) => {
    const payload = load(file);
    expect(payload !== null && typeof payload === "object" && !Array.isArray(payload)).toBe(true);
    expect(typeof payload.hook_event_name).toBe("string");
    expect(typeof payload.cursor_version).toBe("string");
    // A recording keeps the hook's environment and answer beside the payload. None of
    // that is part of what Cursor sends, and the environment holds the user's paths.
    for (const key of ["env", "response", "mode", "payload", "ts"]) {
      expect(payload).not.toHaveProperty(key);
    }
  });
});

describe("the session-file fixtures exist, and each holds Cursor's record shapes", () => {
  it("there are session files to check, in Cursor's folder layout", () => {
    // A session's own file and a sub-agent's file, at least.
    expect(SESSION_FILES.length).toBeGreaterThanOrEqual(2);
    for (const file of SESSION_FILES) {
      expect(file).toMatch(/^projects\/[^/]+\/agent-transcripts\/[^/]+\//);
    }
  });

  it("every fixture file is a payload or a session file, so none escapes the checks", () => {
    expect(ALL_FILES.filter((f) => !FILES.includes(f) && !f.endsWith(".jsonl"))).toEqual([]);
  });

  it.each(SESSION_FILES)("%s holds only the record shapes Cursor writes", (file) => {
    const lines = readFileSync(join(FIXTURES, file), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const keys = Object.keys(JSON.parse(line)).sort();
      expect([
        ["message", "role"],
        ["status", "type"],
        ["error", "status", "type"],
      ]).toContainEqual(keys);
    }
  });
});

describe("each pattern fires on a leak and not on its redacted form", () => {
  it.each(LEAKS)("$name", ({ pattern, leaked, redacted }) => {
    expect(pattern.test(scanned(leaked))).toBe(true);
    expect(pattern.test(scanned(redacted))).toBe(false);
  });
});

describe("no fixture carries a personal detail", () => {
  it.each(FILES)("%s matches no leak pattern", (file) => {
    const text = scanned(readFileSync(join(FIXTURES, file), "utf8"));
    const hits = LEAKS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
    expect(hits).toEqual([]);
  });

  it.each(ALL_FILES)("%s matches no leak pattern in its path or its text", (file) => {
    const text = scanned(`${file}\n${readFileSync(join(FIXTURES, file), "utf8")}`);
    const hits = LEAKS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
    expect(hits).toEqual([]);
  });

  it.each(FILES)("%s holds the redacted value in every replaced field", (file) => {
    const payload = load(file);
    if ("user_email" in payload) expect(payload.user_email).toBe("<redacted>");

    const roots = payload.workspace_roots;
    expect(Array.isArray(roots)).toBe(true);
    for (const root of roots as unknown[]) expect(root).toMatch(/^\/home\/user\//);

    const input = payload.tool_input;
    const workingDirectories = [
      payload.cwd,
      typeof input === "object" && input !== null ? (input as { cwd?: unknown }).cwd : undefined,
    ];
    for (const cwd of workingDirectories) {
      if (cwd !== undefined) expect(cwd === "" || /^\/home\/user\//.test(String(cwd))).toBe(true);
    }

    const transcript = payload.transcript_path;
    if (transcript !== null && transcript !== undefined) {
      expect(transcript).toMatch(/^\/home\/user\//);
    }

    for (const key of ["conversation_id", "session_id", "generation_id", "tool_use_id"]) {
      const value = payload[key];
      if (typeof value === "string") {
        expect(value.replace(PLACEHOLDER_ID, ""), `${file} ${key}`).not.toMatch(/[0-9a-f]{6,}/i);
      }
    }
  });
});
