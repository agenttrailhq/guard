/**
 * `ScrubIO`: the one seam through which `scan --scrub --apply` writes.
 *
 * ── What it can do, and nothing else ─────────────────────────────────────────
 *  - read one file's bytes, with the stat of the same open file;
 *  - make a new private backup folder (`0700`) and write new files into it (`0600`), never
 *    replacing one that exists;
 *  - replace one transcript file atomically, refusing when it changed since it was read;
 *  - remove files it made itself in a backup folder, when a backup is abandoned.
 *
 * It starts no process and reaches no network. Only the CLI entries create it, and only
 * `scan --scrub` uses it: `commands/scan.ts` never imports this file, so a plain `scan` has no
 * way to write through it, and `bundle-graph.test.ts` keeps it out of the hook.
 *
 * ── How a file is replaced ───────────────────────────────────────────────────
 *  1. The new bytes go to a temporary file in the same folder, created exclusively with the
 *     original file's mode, then `fsync`ed.
 *  2. The original is read again. If its size, modification time, inode or SHA-256 differ from
 *     what the caller read, the temporary file is removed and nothing is replaced.
 *  3. `rename` puts the new file in place. Where it fails (on Windows, a file another process
 *     holds open gives `EPERM` or `EBUSY`), the temporary file is removed and the original is
 *     left as it was.
 *
 * Agents take no lock on their transcripts and Node has no portable file lock, so step 2 is a
 * compare-and-swap, not a lock: it catches a write that landed since the file was read, and the
 * caller's other checks (the agent is not running, the file has not changed for five minutes)
 * keep the window narrow.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256 } from "./core/scrub-transcripts.js";

/** Largest transcript file `read` takes. Larger files are reported and left alone. */
export const MAX_SCRUB_FILE_BYTES = 256 * 1024 * 1024;

/** The mode of a backup folder. */
export const BACKUP_DIR_MODE = 0o700;

/** The mode of every file in a backup folder. */
export const BACKUP_FILE_MODE = 0o600;

/** What the change check compares. */
export interface ScrubStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  /** Permission bits only. */
  readonly mode: number;
}

/** One file read. */
export type ScrubRead =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly stat: ScrubStat }
  | { readonly ok: false; readonly reason: "missing" | "not-a-file" | "too-large" };

/** The outcome of replacing one file. */
export type ReplaceOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * - `changed`: the file is not what was read; nothing was replaced.
       * - `write-failed`: the new bytes could not be written beside it.
       * - `rename-failed`: they could not be put in its place; `code` is the error code.
       */
      readonly reason: "changed" | "write-failed" | "rename-failed";
      readonly code?: string;
    };

/** Everything `scan --scrub` may do to files. */
export interface ScrubIO {
  /** Read a file's bytes and the stat of the same open file. */
  read(path: string): ScrubRead;
  /**
   * Make a new folder `name` under `root`, mode `0700`, and return its path. `root` is made
   * too, `0700`, when missing. A name that exists gets a numbered suffix, so an existing folder
   * is never reused. `undefined` when it cannot be made private.
   */
  createBackupDir(root: string, name: string): string | undefined;
  /** Write a new file, mode `0600`. `false` when it fails or the file already exists. */
  writeBackupFile(path: string, bytes: Uint8Array): boolean;
  /** Replace `path` with `bytes`. See "How a file is replaced". */
  replaceFile(
    path: string,
    bytes: Uint8Array,
    expected: { readonly stat: ScrubStat; readonly sha256: string },
  ): ReplaceOutcome;
  /** Remove files this run wrote into `dir`, then `dir` if it is empty. Never throws. */
  discardBackup(dir: string, files: readonly string[]): void;
}

/** Read a whole open file. */
function readAll(fd: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    const n = readSync(fd, bytes, at, size - at, at);
    if (n === 0) break;
    at += n;
  }
  return at === size ? bytes : bytes.subarray(0, at);
}

/** Write all of `bytes` to an open file. */
function writeAll(fd: number, bytes: Uint8Array): void {
  let at = 0;
  while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
}

/** Read `path` with the stat of the same open file. */
function readWithStat(path: string, maxBytes: number): ScrubRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "not-a-file" };
    if (stat.size > maxBytes) return { ok: false, reason: "too-large" };
    return {
      ok: true,
      bytes: readAll(fd, stat.size),
      stat: { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, mode: stat.mode & 0o777 },
    };
  } catch {
    return { ok: false, reason: "missing" };
  } finally {
    closeSync(fd);
  }
}

/** Remove a file, ignoring any failure. */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove.
  }
}

/** `fsync` a folder, so a rename in it is on disk. Not possible on every platform. */
function syncFolder(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows cannot open a folder for this; the rename itself has still happened.
  }
}

/** What `createRealScrubIO` may be given. Production passes nothing. */
export interface ScrubIOOptions {
  readonly platform?: string;
  /** For tests: the rename, to make it fail as Windows does for a file held open. */
  readonly rename?: (from: string, to: string) => void;
  /** For tests: the largest file read. */
  readonly maxFileBytes?: number;
}

/** The real `ScrubIO`. Created only by the CLI entries, used only by `scan --scrub`. */
export function createRealScrubIO(options: ScrubIOOptions = {}): ScrubIO {
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? renameSync;
  const maxBytes = options.maxFileBytes ?? MAX_SCRUB_FILE_BYTES;

  return {
    read(path: string): ScrubRead {
      return readWithStat(path, maxBytes);
    },

    createBackupDir(root: string, name: string): string | undefined {
      try {
        mkdirSync(root, { recursive: true, mode: BACKUP_DIR_MODE });
      } catch {
        return undefined;
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        const dir = join(root, attempt === 0 ? name : `${name}-${attempt}`);
        try {
          mkdirSync(dir, { mode: BACKUP_DIR_MODE });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          return undefined;
        }
        try {
          // The mode given to `mkdir` is narrowed by the umask, never widened; set it outright.
          chmodSync(dir, BACKUP_DIR_MODE);
          const stat = lstatSync(dir);
          if (!stat.isDirectory()) return undefined;
          if (platform !== "win32" && (stat.mode & 0o777) !== BACKUP_DIR_MODE) return undefined;
          return dir;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },

    writeBackupFile(path: string, bytes: Uint8Array): boolean {
      let fd: number;
      try {
        fd = openSync(path, "wx", BACKUP_FILE_MODE);
      } catch {
        return false;
      }
      try {
        writeAll(fd, bytes);
        fsyncSync(fd);
      } catch {
        closeSync(fd);
        removeQuietly(path);
        return false;
      }
      closeSync(fd);
      try {
        chmodSync(path, BACKUP_FILE_MODE);
        return true;
      } catch {
        removeQuietly(path);
        return false;
      }
    },

    replaceFile(path, bytes, expected): ReplaceOutcome {
      const folder = dirname(path);
      const temp = join(folder, `.${basename(path)}.${randomBytes(6).toString("hex")}.scrub-tmp`);
      let fd: number;
      try {
        fd = openSync(temp, "wx", expected.stat.mode);
      } catch {
        return { ok: false, reason: "write-failed" };
      }
      try {
        writeAll(fd, bytes);
        fsyncSync(fd);
      } catch {
        closeSync(fd);
        removeQuietly(temp);
        return { ok: false, reason: "write-failed" };
      }
      closeSync(fd);
      try {
        chmodSync(temp, expected.stat.mode);
      } catch {
        removeQuietly(temp);
        return { ok: false, reason: "write-failed" };
      }

      // The change check, as late as possible before the rename.
      const now = readWithStat(path, Number.POSITIVE_INFINITY);
      if (
        !now.ok ||
        now.stat.size !== expected.stat.size ||
        now.stat.mtimeMs !== expected.stat.mtimeMs ||
        now.stat.ino !== expected.stat.ino ||
        sha256(now.bytes) !== expected.sha256
      ) {
        removeQuietly(temp);
        return { ok: false, reason: "changed" };
      }

      try {
        rename(temp, path);
      } catch (error) {
        removeQuietly(temp);
        const code = (error as NodeJS.ErrnoException).code;
        return { ok: false, reason: "rename-failed", ...(code === undefined ? {} : { code }) };
      }
      syncFolder(folder);
      return { ok: true };
    },

    discardBackup(dir: string, files: readonly string[]): void {
      for (const file of files) removeQuietly(file);
      try {
        rmdirSync(dir);
      } catch {
        // Not empty, or already gone: either way, nothing more of ours to remove.
      }
    },
  };
}
