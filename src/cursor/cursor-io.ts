/**
 * `CursorFileIO` — the file seam for `init --agent cursor`, `uninstall --agent cursor`, and the
 * Cursor section of `status`, which only reads through it.
 *
 * ── Why not `SetupIO` ─────────────────────────────────────────────────────────
 * - `SetupIO.writeFileAtomic` always writes mode 0600. `~/.cursor/hooks.json` is Cursor's
 *   file, and guard keeps whatever mode it has.
 * - `SetupIO.readFile` answers `undefined` for a missing file and an unreadable one alike.
 *   Guard must refuse a `hooks.json` it cannot read, not treat it as absent and write a new
 *   one over it.
 * - Several suites build `SetupIO` doubles as object literals, and new required members would
 *   break every one of them.
 *
 * Only the CLI commands import this module, so it is outside the hook bundle graph
 * (`bundle-graph.test.ts`).
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Everything the Cursor install needs from the file system. */
export interface CursorFileIO {
  /** A UTF-8 file's text, or `undefined` when it does not exist. THROWS on any other failure. */
  readFile(path: string): string | undefined;
  /** A file's permission bits, such as `0o644`, or `undefined` when it does not exist. THROWS otherwise. */
  fileMode(path: string): number | undefined;
  /**
   * Write `text` to `path` through a temp file in the same folder and a rename, so a reader
   * sees the old file or the new one and never half of either.
   *
   * The file ends with exactly `mode`, whatever the umask. A symbolic link is written through,
   * so the link stays a link. Missing folders are created at 0700. THROWS on failure, after
   * removing the temp file.
   */
  writeFileAtomic(path: string, text: string, mode: number): void;
  /** Delete a file. A file that does not exist is not an error. THROWS on any other failure. */
  deleteFile(path: string): void;
}

/** Whether a file-system error says the path does not exist. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** The file a write lands in: the target of a symbolic link, or `path` itself. */
function writeTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isMissing(error)) return path;
    throw error;
  }
}

/** The real file seam. Imported only by the CLI commands. */
export function createRealCursorFileIO(): CursorFileIO {
  return {
    readFile(path: string): string | undefined {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },

    fileMode(path: string): number | undefined {
      try {
        return statSync(path).mode & 0o777;
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },

    writeFileAtomic(path: string, text: string, mode: number): void {
      const target = writeTarget(path);
      const dir = dirname(target);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Same folder as the target, because a rename is only atomic within one file system.
      // `wx` refuses to write through anything already at the temp path.
      const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
      try {
        writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
        chmodSync(tmp, mode);
        renameSync(tmp, target);
      } catch (error) {
        try {
          unlinkSync(tmp);
        } catch {
          /* the temp file may never have been created */
        }
        throw error;
      }
    },

    deleteFile(path: string): void {
      try {
        unlinkSync(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}
