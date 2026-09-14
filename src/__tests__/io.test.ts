/**
 * `createRealIO` — the one module allowed to touch the process.
 *
 * `readFile` returning `undefined` rather than throwing is the load-bearing bit: "no
 * config yet" is the NORMAL state on a fresh install, and routing it through the
 * error path would put every new user one stack trace away from a broken hook.
 *
 * `readStdin` is covered by `built-artifact.test.ts`, which pipes real bytes into the
 * real bundle in a child process — the only way to exercise it for real.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRealIO } from "../io.js";

describe("readFile", () => {
  it("reads a real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-io-"));
    const file = join(dir, "config.json");
    writeFileSync(file, '{"failOpen":true}');
    expect(createRealIO().readFile(file)).toBe('{"failOpen":true}');
  });

  it("returns undefined for a missing file instead of throwing", () => {
    expect(
      createRealIO().readFile(join(tmpdir(), "definitely-not-here-9f3a.json")),
    ).toBeUndefined();
  });

  it("returns undefined for a directory instead of throwing", () => {
    expect(createRealIO().readFile(tmpdir())).toBeUndefined();
  });
});

describe("homedir", () => {
  it("reports the real home directory", () => {
    expect(createRealIO().homedir()).toBe(homedir());
  });
});

describe("writeStdout", () => {
  it("writes through to process.stdout exactly once", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    createRealIO().writeStdout("hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("hello");
    spy.mockRestore();
  });
});

describe("appendFile and fileSize — the decision log's hot path", () => {
  it("creates the file at 0600 and appends without rewriting", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const log = join(root, "events.jsonl");

    expect(io.appendFile(log, "one\n")).toBe(true);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(io.appendFile(log, "two\n")).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("one\ntwo\n");
  });

  it("inside a 0700 directory, which is what init already writes", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const dir = join(root, ".agenttrail", "guard");
    expect(io.mkdirp(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(io.appendFile(join(dir, "events.jsonl"), "x\n")).toBe(true);
    expect(statSync(join(dir, "events.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("returns false rather than throwing when the directory is missing", () => {
    // A read-only home, or a directory that never got created, must not become an
    // exception on the hook path.
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    expect(io.appendFile(join(root, "nope", "events.jsonl"), "x\n")).toBe(false);
  });

  it("returns false rather than throwing when the target is a directory", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    expect(io.appendFile(root, "x\n")).toBe(false);
  });

  it("fileSize reports bytes, and grows with each append", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const log = join(root, "events.jsonl");
    expect(io.fileSize(log)).toBe(0); // missing reads as 0, never a throw
    io.appendFile(log, "12345");
    expect(io.fileSize(log)).toBe(5);
    io.appendFile(log, "678");
    expect(io.fileSize(log)).toBe(8);
  });

  it("fileSize counts BYTES, not characters", () => {
    // The size bound is a byte budget; a multi-byte command must not read as short.
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const log = join(root, "events.jsonl");
    io.appendFile(log, "a\u00e9b"); // 4 bytes, 3 characters — é is two bytes in UTF-8
    expect(io.fileSize(log)).toBe(4);
  });

  it("fileSize returns 0 for an unreadable path rather than throwing", () => {
    // `0` is the fail-safe answer: it reads as "nothing to compact" rather than
    // triggering a rewrite of a file we cannot measure.
    const io = createRealIO();
    expect(io.fileSize(join(tmpdir(), "definitely-not-here-4c1e", "x.jsonl"))).toBe(0);
  });
});

describe("the write primitives — the crash spool's, reused by the decision log", () => {
  it("mkdirp creates nested directories and is idempotent", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const deep = join(root, "a", "b", "c");
    expect(io.mkdirp(deep)).toBe(true);
    expect(io.mkdirp(deep)).toBe(true); // already exists is success, not an error
    expect(existsSync(deep)).toBe(true);
  });

  it("mkdirp returns false rather than throwing when the path is unusable", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    // A directory cannot be created under a regular file.
    expect(io.mkdirp(join(file, "sub"))).toBe(false);
  });

  it("writeFileAtomic writes 0600 and leaves no temp file", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const target = join(root, "out.json");
    expect(io.writeFileAtomic(target, "hello")).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["out.json"]);
  });

  it("writeFileAtomic overwrites an existing file in place", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const target = join(root, "out.json");
    io.writeFileAtomic(target, "first");
    io.writeFileAtomic(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(readdirSync(root)).toEqual(["out.json"]);
  });

  it("writeFileAtomic returns false and cleans up when the directory is missing", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    expect(io.writeFileAtomic(join(root, "nope", "out.json"), "x")).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("listDir returns entries, and [] for a missing directory", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    writeFileSync(join(root, "a"), "1");
    expect(io.listDir(root)).toEqual(["a"]);
    expect(io.listDir(join(root, "missing"))).toEqual([]);
  });

  it("deleteFile removes a file and returns false for one that is not there", () => {
    const io = createRealIO();
    const root = mkdtempSync(join(tmpdir(), "guard-io-"));
    const f = join(root, "a");
    writeFileSync(f, "1");
    expect(io.deleteFile(f)).toBe(true);
    expect(existsSync(f)).toBe(false);
    expect(io.deleteFile(f)).toBe(false); // already gone is not an exception
  });
});
