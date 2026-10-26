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
 *  2. The original is read again, never through a symbolic link. If it is now a link, or its
 *     size, modification time, inode or SHA-256 differ from what the caller read, the temporary
 *     file is removed and nothing is replaced.
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
  constants,
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
  /** How many names the file has. Above 1, another name keeps the old bytes after a replace. */
  readonly nlink: number;
}

/** One file read. */
export type ScrubRead =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly stat: ScrubStat }
  | {
      readonly ok: false;
      /**
       * - `changed`: the file ended before the size it was opened at.
       * - `link`: the path is a symbolic link. It is never followed, so a replace can never
       *   swap a link for a regular file and leave the file it points to as it was.
       */
      readonly reason: "missing" | "not-a-file" | "too-large" | "changed" | "link";
    };

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

/**
 * The file operations this seam uses. Production uses `node:fs`; a test can replace any one of
 * them to make it fail.
 */
export interface ScrubFs {
  readonly openSync: (path: string, flags: string | number, mode?: number) => number;
  readonly fstatSync: (fd: number) => {
    isFile(): boolean;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ino: number;
    readonly mode: number;
    readonly nlink: number;
  };
  readonly readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
  readonly chmodSync: (path: string, mode: number) => void;
  readonly mkdirSync: (path: string, options: { recursive?: boolean; mode: number }) => void;
  readonly lstatSync: (path: string) => { isDirectory(): boolean; readonly mode: number };
  readonly renameSync: (from: string, to: string) => void;
  readonly unlinkSync: (path: string) => void;
  readonly rmdirSync: (path: string) => void;
}

/** `node:fs`, as `ScrubFs`. */
const NODE_FS: ScrubFs = {
  openSync: (path, flags, mode) => openSync(path, flags, mode),
  fstatSync: (fd) => fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, length, position),
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  chmodSync: (path, mode) => chmodSync(path, mode),
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  lstatSync: (path) => lstatSync(path),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (path) => unlinkSync(path),
  rmdirSync: (path) => rmdirSync(path),
};

/**
 * Read a whole open file of `size` bytes, or `undefined` when it ends sooner: it shrank after
 * it was opened.
 */
function readAll(fs: ScrubFs, fd: number, size: number): Uint8Array | undefined {
  const bytes = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    const n = fs.readSync(fd, bytes, at, size - at, at);
    if (n <= 0) return undefined;
    at += n;
  }
  return bytes;
}

/** Write all of `bytes` to an open file. Throws when a write fails or makes no progress. */
function writeAll(fs: ScrubFs, fd: number, bytes: Uint8Array): void {
  let at = 0;
  while (at < bytes.length) {
    const n = fs.writeSync(fd, bytes, at, bytes.length - at);
    if (n <= 0) throw new Error("write made no progress");
    at += n;
  }
}

/** Close a file, ignoring any failure. Used only on a path that already failed. */
function closeQuietly(fs: ScrubFs, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // The operation has already failed; a failed close changes nothing about that.
  }
}

/**
 * Open for reading without following a symbolic link at the last step of the path. Where the
 * platform has no such flag (Windows), this is a plain read-only open.
 */
const READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** The codes an open with `O_NOFOLLOW` gives for a link: `ELOOP`, or `EMLINK` on FreeBSD. */
const LINK_CODES: ReadonlySet<string> = new Set(["ELOOP", "EMLINK"]);

/** Read `path` with the stat of the same open file. Never follows a link at `path`. */
function readWithStat(fs: ScrubFs, path: string, maxBytes: number): ScrubRead {
  let fd: number;
  try {
    fd = fs.openSync(path, READ_NO_FOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      ok: false,
      reason: typeof code === "string" && LINK_CODES.has(code) ? "link" : "missing",
    };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "not-a-file" };
    if (stat.size > maxBytes) return { ok: false, reason: "too-large" };
    const bytes = readAll(fs, fd, stat.size);
    if (bytes === undefined) return { ok: false, reason: "changed" };
    return {
      ok: true,
      bytes,
      stat: {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        mode: stat.mode & 0o777,
        nlink: stat.nlink,
      },
    };
  } catch {
    return { ok: false, reason: "missing" };
  } finally {
    closeQuietly(fs, fd);
  }
}

/** Remove a file, ignoring any failure. */
function removeQuietly(fs: ScrubFs, path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove.
  }
}

/** Write `bytes` to an open file, `fsync` it and close it. `false` when any step fails. */
function writeSyncClose(fs: ScrubFs, fd: number, bytes: Uint8Array): boolean {
  try {
    writeAll(fs, fd, bytes);
    fs.fsyncSync(fd);
  } catch {
    closeQuietly(fs, fd);
    return false;
  }
  try {
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** `fsync` a folder, so a rename in it is on disk. Not possible on every platform. */
function syncFolder(fs: ScrubFs, path: string): void {
  try {
    const fd = fs.openSync(path, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      closeQuietly(fs, fd);
    }
  } catch {
    // Windows cannot open a folder for this; the rename itself has still happened.
  }
}

/** What `createRealScrubIO` may be given. Production passes nothing. */
export interface ScrubIOOptions {
  readonly platform?: string;
  /** For tests: file operations to use in place of `node:fs`, to make one of them fail. */
  readonly fs?: Partial<ScrubFs>;
  /** For tests: the largest file read. */
  readonly maxFileBytes?: number;
}

/** Most numbered names tried for a backup folder before giving up. */
export const MAX_BACKUP_DIR_ATTEMPTS = 100;

/** The real `ScrubIO`. Created only by the CLI entries, used only by `scan --scrub`. */
export function createRealScrubIO(options: ScrubIOOptions = {}): ScrubIO {
  const platform = options.platform ?? process.platform;
  const fs: ScrubFs = { ...NODE_FS, ...options.fs };
  const maxBytes = options.maxFileBytes ?? MAX_SCRUB_FILE_BYTES;

  return {
    read(path: string): ScrubRead {
      return readWithStat(fs, path, maxBytes);
    },

    createBackupDir(root: string, name: string): string | undefined {
      try {
        fs.mkdirSync(root, { recursive: true, mode: BACKUP_DIR_MODE });
      } catch {
        return undefined;
      }
      for (let attempt = 0; attempt < MAX_BACKUP_DIR_ATTEMPTS; attempt++) {
        const dir = join(root, attempt === 0 ? name : `${name}-${attempt}`);
        try {
          fs.mkdirSync(dir, { mode: BACKUP_DIR_MODE });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          return undefined;
        }
        let isPrivate = false;
        try {
          // The mode given to `mkdir` is narrowed by the umask, never widened; set it outright.
          fs.chmodSync(dir, BACKUP_DIR_MODE);
          const stat = fs.lstatSync(dir);
          isPrivate =
            stat.isDirectory() && (platform === "win32" || (stat.mode & 0o777) === BACKUP_DIR_MODE);
        } catch {
          isPrivate = false;
        }
        if (isPrivate) return dir;
        // Made, but not provably private: remove the empty folder rather than use it.
        try {
          fs.rmdirSync(dir);
        } catch {
          // Left empty; nothing was written into it.
        }
        return undefined;
      }
      return undefined;
    },

    writeBackupFile(path: string, bytes: Uint8Array): boolean {
      let fd: number;
      try {
        fd = fs.openSync(path, "wx", BACKUP_FILE_MODE);
      } catch {
        return false;
      }
      if (!writeSyncClose(fs, fd, bytes)) {
        removeQuietly(fs, path);
        return false;
      }
      try {
        fs.chmodSync(path, BACKUP_FILE_MODE);
        return true;
      } catch {
        removeQuietly(fs, path);
        return false;
      }
    },

    replaceFile(path, bytes, expected): ReplaceOutcome {
      const folder = dirname(path);
      const temp = join(folder, `.${basename(path)}.${randomBytes(6).toString("hex")}.scrub-tmp`);
      let fd: number;
      try {
        fd = fs.openSync(temp, "wx", expected.stat.mode);
      } catch {
        return { ok: false, reason: "write-failed" };
      }
      if (!writeSyncClose(fs, fd, bytes)) {
        removeQuietly(fs, temp);
        return { ok: false, reason: "write-failed" };
      }
      try {
        fs.chmodSync(temp, expected.stat.mode);
      } catch {
        removeQuietly(fs, temp);
        return { ok: false, reason: "write-failed" };
      }

      // The change check, as late as possible before the rename.
      const now = readWithStat(fs, path, Number.POSITIVE_INFINITY);
      if (
        !now.ok ||
        now.stat.size !== expected.stat.size ||
        now.stat.mtimeMs !== expected.stat.mtimeMs ||
        now.stat.ino !== expected.stat.ino ||
        sha256(now.bytes) !== expected.sha256
      ) {
        removeQuietly(fs, temp);
        return { ok: false, reason: "changed" };
      }

      try {
        fs.renameSync(temp, path);
      } catch (error) {
        removeQuietly(fs, temp);
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return {
          ok: false,
          reason: "rename-failed",
          ...(typeof code === "string" ? { code } : {}),
        };
      }
      syncFolder(fs, folder);
      return { ok: true };
    },

    discardBackup(dir: string, files: readonly string[]): void {
      for (const file of files) removeQuietly(fs, file);
      try {
        fs.rmdirSync(dir);
      } catch {
        // Not empty, or already gone: either way, nothing more of ours to remove.
      }
    },
  };
}
