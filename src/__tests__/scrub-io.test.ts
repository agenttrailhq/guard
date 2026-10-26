/**
 * The write seam `scan --scrub --apply` uses (`scrub-io.ts`), against real files in a
 * temporary folder.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
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
      rename: () => {
        throw Object.assign(new Error("held open"), { code });
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
