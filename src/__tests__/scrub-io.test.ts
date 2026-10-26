/**
 * The write seam `scan --scrub --apply` uses (`scrub-io.ts`), against real files in a
 * temporary folder.
 */

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../core/scrub-transcripts.js";
import {
  BACKUP_DIR_MODE,
  BACKUP_FILE_MODE,
  createRealScrubIO,
  MAX_BACKUP_DIR_ATTEMPTS,
  type ScrubFs,
  type ScrubStat,
} from "../scrub-io.js";

const POSIX = process.platform !== "win32";

/** A new temporary folder. */
function folder(): string {
  return mkdtempSync(join(tmpdir(), "agenttrail-scrub-io-"));
}

/** A file with `text`, and what `read` says of it. */
function fileWith(text: string, mode = 0o640): { path: string; stat: ScrubStat; sha: string } {
  const path = join(folder(), "session.jsonl");
  writeFileSync(path, text);
  chmodSync(path, mode);
  const read = createRealScrubIO().read(path);
  if (!read.ok) throw new Error("fixture not readable");
  return { path, stat: read.stat, sha: sha256(read.bytes) };
}

/** Leftover temporary files beside `path`. */
function temps(path: string): string[] {
  return readdirSync(join(path, "..")).filter((name) => name.endsWith(".scrub-tmp"));
}

describe("read", () => {
  it("returns the bytes with the stat of the same file", () => {
    const { path, stat } = fileWith('{"a":1}\n');
    const read = createRealScrubIO().read(path);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Buffer.from(read.bytes).toString("utf8")).toBe('{"a":1}\n');
    expect(read.stat).toEqual(stat);
    if (POSIX) expect(read.stat.mode).toBe(0o640);
  });

  it("says why a file cannot be read", () => {
    const io = createRealScrubIO({ maxFileBytes: 4 });
    expect(io.read(join(folder(), "missing.jsonl"))).toEqual({ ok: false, reason: "missing" });
    expect(io.read(folder())).toEqual({ ok: false, reason: "not-a-file" });
    expect(io.read(fileWith("0123456789").path)).toEqual({ ok: false, reason: "too-large" });
  });
});

describe("the backup folder", () => {
  it("is private, and never reused", () => {
    const root = join(folder(), ".agenttrail", "scrub-backups");
    const io = createRealScrubIO();
    const first = io.createBackupDir(root, "same");
    const second = io.createBackupDir(root, "same");
    expect(first).toBe(join(root, "same"));
    expect(second).toBe(join(root, "same-1"));
    if (POSIX) {
      expect(statSync(root).mode & 0o777).toBe(BACKUP_DIR_MODE);
      expect(statSync(first as string).mode & 0o777).toBe(BACKUP_DIR_MODE);
    }
  });

  it("is not made where its root cannot be", () => {
    const blocker = join(folder(), "a-file");
    writeFileSync(blocker, "x");
    expect(createRealScrubIO().createBackupDir(join(blocker, "inside"), "x")).toBeUndefined();
  });

  it("takes new files at 0600, and never overwrites one", () => {
    const dir = createRealScrubIO().createBackupDir(folder(), "b") as string;
    const io = createRealScrubIO();
    const path = join(dir, "0-session.jsonl");
    expect(io.writeBackupFile(path, new Uint8Array([1, 2]))).toBe(true);
    expect(io.writeBackupFile(path, new Uint8Array([3]))).toBe(false);
    expect([...readFileSync(path)]).toEqual([1, 2]);
    if (POSIX) expect(statSync(path).mode & 0o777).toBe(BACKUP_FILE_MODE);
  });

  it("is removed with the files this run wrote when discarded", () => {
    const io = createRealScrubIO();
    const dir = io.createBackupDir(folder(), "c") as string;
    const path = join(dir, "x");
    io.writeBackupFile(path, new Uint8Array([1]));
    io.discardBackup(dir, [path]);
    expect(existsSync(dir)).toBe(false);
  });

  it("is kept when discarding finds files it did not write", () => {
    const io = createRealScrubIO();
    const dir = io.createBackupDir(folder(), "d") as string;
    writeFileSync(join(dir, "someone-else"), "x");
    io.discardBackup(dir, []);
    expect(existsSync(join(dir, "someone-else"))).toBe(true);
  });
});

describe("replaceFile", () => {
  it("replaces the bytes, keeps the mode and leaves no temporary file", () => {
    const { path, stat, sha } = fileWith('{"a":"old"}\n');
    const result = createRealScrubIO().replaceFile(path, Buffer.from('{"a":"new"}\n'), {
      stat,
      sha256: sha,
    });
    expect(result).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toBe('{"a":"new"}\n');
    if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(temps(path)).toEqual([]);
  });

  it("refuses a file that grew since it was read", () => {
    const { path, stat, sha } = fileWith('{"a":"old"}\n');
    writeFileSync(path, '{"b":"appended"}\n', { flag: "a" });
    const result = createRealScrubIO().replaceFile(path, Buffer.from("x"), { stat, sha256: sha });
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(readFileSync(path, "utf8")).toBe('{"a":"old"}\n{"b":"appended"}\n');
    expect(temps(path)).toEqual([]);
  });

  it("refuses a file whose bytes changed at the same size and time", () => {
    const { path, stat } = fileWith('{"a":"old"}\n');
    // The stat matches; only the content hash tells the two apart.
    const result = createRealScrubIO().replaceFile(path, Buffer.from("x"), {
      stat,
      sha256: sha256(Buffer.from('{"a":"OLD"}\n')),
    });
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(readFileSync(path, "utf8")).toBe('{"a":"old"}\n');
  });

  it("refuses a file that is gone", () => {
    const { path, stat, sha } = fileWith("x\n");
    const io = createRealScrubIO();
    unlinkSync(path);
    expect(io.replaceFile(path, Buffer.from("y"), { stat, sha256: sha })).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(existsSync(path)).toBe(false);
  });

  it.each(["EPERM", "EBUSY"])("leaves the original when the rename fails with %s", (code) => {
    const { path, stat, sha } = fileWith('{"a":"old"}\n');
    const io = createRealScrubIO({
      fs: {
        renameSync: () => {
          throw Object.assign(new Error("held open"), { code });
        },
      },
    });
    expect(io.replaceFile(path, Buffer.from("new"), { stat, sha256: sha })).toEqual({
      ok: false,
      reason: "rename-failed",
      code,
    });
    expect(readFileSync(path, "utf8")).toBe('{"a":"old"}\n');
    expect(temps(path)).toEqual([]);
  });

  it("reports a temporary file it cannot create", () => {
    if (!POSIX) return;
    const { path, stat, sha } = fileWith("x\n");
    const dir = join(path, "..");
    chmodSync(dir, 0o500);
    try {
      expect(
        createRealScrubIO().replaceFile(path, Buffer.from("y"), { stat, sha256: sha }),
      ).toEqual({ ok: false, reason: "write-failed" });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(path, "utf8")).toBe("x\n");
  });
});

// ── Every way a write can fail ──────────────────────────────────────────────────

/** An error as `node:fs` throws it. */
function fsError(code?: string): Error {
  return code === undefined ? new Error("failed") : Object.assign(new Error(code), { code });
}

/** An `fs` override that throws `code` from `op`. */
function failing(op: keyof ScrubFs, code = "EIO"): Partial<ScrubFs> {
  return {
    [op]: () => {
      throw fsError(code);
    },
  };
}

/** Files in `dir`. */
function names(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe("read fails safely", () => {
  it("a stat that throws reads as missing", () => {
    const { path } = fileWith("x\n");
    expect(createRealScrubIO({ fs: failing("fstatSync") }).read(path)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("a file that ends before its size reads as changed, not as a short file", () => {
    const { path } = fileWith("0123456789\n");
    expect(createRealScrubIO({ fs: { readSync: () => 0 } }).read(path)).toEqual({
      ok: false,
      reason: "changed",
    });
  });

  it("a close that fails after a full read still returns the bytes", () => {
    const { path, stat } = fileWith("x\n");
    const read = createRealScrubIO({ fs: failing("closeSync") }).read(path);
    expect(read.ok && read.stat).toEqual(stat);
  });
});

describe("the backup folder fails safely", () => {
  it("a mkdir error other than EEXIST gives no folder", () => {
    const root = folder();
    let calls = 0;
    const io = createRealScrubIO({
      fs: {
        mkdirSync: (path, options) => {
          calls += 1;
          if (options.recursive !== true) throw fsError("EACCES");
          mkdirSync(path, options);
        },
      },
    });
    expect(io.createBackupDir(root, "x")).toBeUndefined();
    expect(calls).toBe(2);
    expect(names(root)).toEqual([]);
  });

  it(`gives up once ${MAX_BACKUP_DIR_ATTEMPTS} names are taken`, () => {
    const root = folder();
    mkdirSync(join(root, "same"));
    for (let i = 1; i < MAX_BACKUP_DIR_ATTEMPTS; i++) mkdirSync(join(root, `same-${i}`));
    expect(createRealScrubIO().createBackupDir(root, "same")).toBeUndefined();
    expect(names(root)).toHaveLength(MAX_BACKUP_DIR_ATTEMPTS);
  });

  it.each([
    ["chmod fails", failing("chmodSync")],
    ["lstat fails", failing("lstatSync")],
    ["it is not a folder", { lstatSync: () => ({ isDirectory: () => false, mode: 0o40700 }) }],
    [
      "its mode is wider than 0700",
      { lstatSync: () => ({ isDirectory: () => true, mode: 0o40755 }) },
    ],
  ] as const)("a folder that cannot be shown private is removed when %s", (_why, fs) => {
    if (!POSIX) return;
    const root = folder();
    expect(createRealScrubIO({ fs }).createBackupDir(root, "x")).toBeUndefined();
    expect(names(root)).toEqual([]);
  });

  it("the mode is not checked on Windows, where it means nothing", () => {
    const root = folder();
    const io = createRealScrubIO({
      platform: "win32",
      fs: { lstatSync: () => ({ isDirectory: () => true, mode: 0o40777 }) },
    });
    expect(io.createBackupDir(root, "x")).toBe(join(root, "x"));
  });

  it("a folder that cannot be removed after failing is left empty, and no folder is returned", () => {
    const root = folder();
    const io = createRealScrubIO({ fs: { ...failing("chmodSync"), ...failing("rmdirSync") } });
    expect(io.createBackupDir(root, "x")).toBeUndefined();
    expect(names(join(root, "x"))).toEqual([]);
  });
});

describe("a backup file fails safely", () => {
  it.each([
    ["the write", failing("writeSync")],
    ["a write that makes no progress", { writeSync: () => 0 }],
    ["the fsync", failing("fsyncSync")],
    ["the close", failing("closeSync")],
    ["the chmod", failing("chmodSync")],
  ] as const)("when %s fails, nothing is left behind", (_what, fs) => {
    const dir = folder();
    const path = join(dir, "1-session.jsonl");
    expect(createRealScrubIO({ fs }).writeBackupFile(path, new Uint8Array([1, 2, 3]))).toBe(false);
    expect(names(dir)).toEqual([]);
  });

  it("an existing file is never overwritten (exclusive create)", () => {
    const dir = folder();
    const path = join(dir, "1-session.jsonl");
    writeFileSync(path, "someone else's");
    expect(createRealScrubIO().writeBackupFile(path, new Uint8Array([1]))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("someone else's");
  });
});

describe("replaceFile fails safely", () => {
  it.each([
    ["the temporary file's write", failing("writeSync")],
    ["a write that makes no progress", { writeSync: () => 0 }],
    ["the temporary file's fsync", failing("fsyncSync")],
    ["the temporary file's close", failing("closeSync")],
    ["the temporary file's chmod", failing("chmodSync")],
  ] as const)("when %s fails: write-failed, original kept, no temporary file", (_what, fs) => {
    const { path, stat, sha } = fileWith('{"a":"old"}\n');
    expect(
      createRealScrubIO({ fs }).replaceFile(path, Buffer.from("new\n"), { stat, sha256: sha }),
    ).toEqual({ ok: false, reason: "write-failed" });
    expect(readFileSync(path, "utf8")).toBe('{"a":"old"}\n');
    expect(temps(path)).toEqual([]);
  });

  it.each([
    "EPERM",
    "EBUSY",
    "EXDEV",
    "EACCES",
  ])("a rename failing with %s keeps the original and names the code", (code) => {
    const { path, stat, sha } = fileWith('{"a":"old"}\n');
    const io = createRealScrubIO({ fs: failing("renameSync", code) });
    expect(io.replaceFile(path, Buffer.from("new\n"), { stat, sha256: sha })).toEqual({
      ok: false,
      reason: "rename-failed",
      code,
    });
    expect(readFileSync(path, "utf8")).toBe('{"a":"old"}\n');
    expect(temps(path)).toEqual([]);
  });

  it.each([
    ["an error with no code", fsError()],
    ["something that is not an error", "not an error"],
    ["nothing at all", undefined],
  ])("a rename failing with %s is reported with no code", (_what, thrown) => {
    const { path, stat, sha } = fileWith('{"a":"old"}\n');
    const io = createRealScrubIO({
      fs: {
        renameSync: () => {
          throw thrown;
        },
      },
    });
    expect(io.replaceFile(path, Buffer.from("new\n"), { stat, sha256: sha })).toEqual({
      ok: false,
      reason: "rename-failed",
    });
    expect(readFileSync(path, "utf8")).toBe('{"a":"old"}\n');
  });

  it("a folder that cannot be fsynced after the rename still counts as replaced", () => {
    const { path, stat, sha } = fileWith('{"a":"old"}\n');
    const io = createRealScrubIO({
      fs: {
        openSync: (p, flags, mode) => {
          if (p === join(path, "..")) throw fsError("EISDIR");
          return openSync(p, flags, mode);
        },
      },
    });
    expect(io.replaceFile(path, Buffer.from("new\n"), { stat, sha256: sha })).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });
});

describe("links", () => {
  it("a symbolic link is read as a link, never followed", () => {
    if (!POSIX) return;
    const { path } = fileWith('{"a":"target"}\n');
    const link = join(folder(), "link.jsonl");
    symlinkSync(path, link);
    expect(createRealScrubIO().read(link)).toEqual({ ok: false, reason: "link" });
  });

  it("a hard-linked file reports how many names it has", () => {
    const { path } = fileWith('{"a":"x"}\n');
    expect(createRealScrubIO().read(path).ok && true).toBe(true);
    linkSync(path, join(folder(), "other-name.jsonl"));
    const read = createRealScrubIO().read(path);
    expect(read.ok && read.stat.nlink).toBe(2);
  });

  it("a path swapped for a link to the same file before the replace is refused", () => {
    if (!POSIX) return;
    // The original moved aside and the path made a link to it: same inode, size, time, bytes.
    const { path, stat, sha } = fileWith('{"a":"old"}\n');
    const aside = join(folder(), "aside.jsonl");
    renameSync(path, aside);
    symlinkSync(aside, path);
    const result = createRealScrubIO().replaceFile(path, Buffer.from("new\n"), {
      stat,
      sha256: sha,
    });
    expect(result).toEqual({ ok: false, reason: "changed" });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(aside, "utf8")).toBe('{"a":"old"}\n');
    expect(temps(path)).toEqual([]);
  });
});

describe("the change check, one property at a time", () => {
  /** A file with a fixed modification time, so a copy can be given the same one. */
  function settled(text: string): { path: string; stat: ScrubStat; sha: string } {
    const made = fileWith(text);
    utimesSync(made.path, 1_700_000_000, 1_700_000_000);
    const read = createRealScrubIO().read(made.path);
    if (!read.ok) throw new Error("fixture not readable");
    return { path: made.path, stat: read.stat, sha: sha256(read.bytes) };
  }

  /** `replaceFile` against `expected`, and the file's text after. */
  function attempt(path: string, expected: { stat: ScrubStat; sha256: string }) {
    const result = createRealScrubIO().replaceFile(path, Buffer.from("new\n"), expected);
    return { result, text: readFileSync(path, "utf8"), temps: temps(path) };
  }

  const CHANGED = { ok: false, reason: "changed" };

  it("an unchanged file is replaced: the control for the cases below", () => {
    const { path, stat, sha } = settled('{"a":"old"}\n');
    expect(attempt(path, { stat, sha256: sha }).result).toEqual({ ok: true });
  });

  it("size alone: the file's size differs from the one read", () => {
    const { path, stat, sha } = settled('{"a":"old"}\n');
    const run = attempt(path, { stat: { ...stat, size: stat.size + 1 }, sha256: sha });
    expect(run).toEqual({ result: CHANGED, text: '{"a":"old"}\n', temps: [] });
  });

  it("modification time alone: touched, same bytes, same inode", () => {
    const { path, stat, sha } = settled('{"a":"old"}\n');
    utimesSync(path, 1_700_000_100, 1_700_000_100);
    const run = attempt(path, { stat, sha256: sha });
    expect(run).toEqual({ result: CHANGED, text: '{"a":"old"}\n', temps: [] });
  });

  it("inode alone: an identical copy moved over it, with the same time", () => {
    if (!POSIX) return;
    const { path, stat, sha } = settled('{"a":"old"}\n');
    const copy = `${path}.copy`;
    writeFileSync(copy, '{"a":"old"}\n');
    chmodSync(copy, stat.mode);
    utimesSync(copy, 1_700_000_000, 1_700_000_000);
    renameSync(copy, path);
    const now = createRealScrubIO().read(path);
    expect(now.ok && now.stat.ino).not.toBe(stat.ino);
    expect(now.ok && { ...now.stat, ino: stat.ino }).toEqual(stat);
    const run = attempt(path, { stat, sha256: sha });
    expect(run).toEqual({ result: CHANGED, text: '{"a":"old"}\n', temps: [] });
  });

  it("content alone: the same size, time and inode, different bytes", () => {
    const { path, stat, sha } = settled('{"a":"old"}\n');
    writeFileSync(path, '{"a":"OLD"}\n');
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    const now = createRealScrubIO().read(path);
    expect(now.ok && now.stat).toEqual(stat);
    const run = attempt(path, { stat, sha256: sha });
    expect(run).toEqual({ result: CHANGED, text: '{"a":"OLD"}\n', temps: [] });
  });
});
