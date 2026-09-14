/**
 * `GuardIO` — the injectable seam for everything outside the process.
 *
 * Every side effect the guard performs goes through here, which is what lets the
 * fail-open tests force a throw from each one independently.
 *
 * ── There is deliberately no transport method here ────────
 * The guard's one outbound call is opt-in crash reporting, off by default, and it
 * lives alone in `net/crash-transport.ts` — NOT on this interface. That placement is
 * load-bearing: `hook-entry.ts` imports this module, so putting `postJson()` on
 * `GuardIO` would drag the transport into the hook's import graph, and
 * `no-network.test.ts` could then only assert "the hook does not CALL the method it
 * can see". An injectable IO surface is a testability convention, not a security
 * boundary: the guarantee comes from the import graph. Nothing reachable from `hook`
 * or `scan` can import `net/`, and a parser proves it over every reachable module.
 *
 * ── The write primitives are generic on purpose ──────────────────────────────
 * `mkdirp` / `writeFileAtomic` / `listDir` / `deleteFile` carry no crash-specific
 * semantics, so a second consumer can reuse them rather than adding a parallel set.
 * The decision log reuses `mkdirp` and `writeFileAtomic` and adds `appendFile` and
 * `fileSize` below.
 */

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Everything the guard needs from the outside world. */
export interface GuardIO {
  /** The whole of stdin. A throw here is handled by the caller as fail-open. */
  readStdin(): Promise<string>;
  /** Write to stdout. On the hook path this is called exactly once, by `emit.ts`. */
  writeStdout(text: string): void;
  /**
   * Read a UTF-8 file, or `undefined` if it is missing or unreadable.
   *
   * Returning `undefined` rather than throwing keeps "no config yet" — the normal
   * state on a fresh install — off the error path entirely.
   */
  readFile(path: string): string | undefined;
  /** The user's home directory; `~/.agenttrail/guard` hangs off it. */
  homedir(): string;
  /**
   * Create a directory and its parents. Already-exists is success, not an error.
   * Returns `false` if it could not be created — a read-only home is a normal
   * state on some machines and must not become an exception on the hook path.
   */
  mkdirp(path: string): boolean;
  /**
   * Write a file so a reader never observes a partial one: write a sibling temp
   * file, then `rename` over the target, which is atomic within a filesystem.
   * Returns `false` on any failure. Mode `0600` — these files are the user's.
   */
  writeFileAtomic(path: string, text: string): boolean;
  /** Entry names in a directory, or `[]` if it is missing or unreadable. */
  listDir(path: string): readonly string[];
  /** Remove a file. Returns `false` if it could not be removed. Never throws. */
  deleteFile(path: string): boolean;
  /**
   * Append to a file, creating it at mode `0600`. Returns `false` on any failure.
   *
   * The decision log is written on every matching tool call, so it needs
   * an O(1) write, not the read-modify-write that `writeFileAtomic` would force.
   * `O_APPEND` also means two concurrent Claude Code sessions interleave whole
   * lines rather than losing each other's.
   *
   * The mode applies only when this call CREATES the file — a mode the user set
   * themselves on an existing log is left alone. Compaction re-establishes `0600`,
   * because it goes through `writeFileAtomic`.
   */
  appendFile(path: string, text: string): boolean;
  /**
   * Size in bytes, or `0` when the file is missing or unreadable.
   *
   * The size bound is checked after every append, so this is the one `stat` on the
   * hook path. `0` for "cannot tell" is the fail-safe answer: it reads as "nothing
   * to compact" rather than triggering a rewrite of a file we cannot measure.
   */
  fileSize(path: string): number;
}

/** The real process IO. Imported only by entry points, never from `core/`. */
export function createRealIO(): GuardIO {
  return {
    async readStdin(): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    },

    writeStdout(text: string): void {
      process.stdout.write(text);
    },

    readFile(path: string): string | undefined {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },

    homedir(): string {
      return homedir();
    },

    mkdirp(path: string): boolean {
      try {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        return true;
      } catch {
        return false;
      }
    },

    writeFileAtomic(path: string, text: string): boolean {
      // The temp name is per-process and per-call, so two guards racing on the
      // same spool cannot clobber each other's partial file before the rename.
      const tmp = join(
        path.slice(0, Math.max(0, path.lastIndexOf("/"))) || ".",
        `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
      );
      try {
        writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
        // `writeFileSync`'s mode is only applied when it CREATES the file, so a
        // reused inode could keep a wider mode. Set it explicitly.
        chmodSync(tmp, 0o600);
        renameSync(tmp, path);
        return true;
      } catch {
        try {
          unlinkSync(tmp);
        } catch {
          /* the temp file may never have been created */
        }
        return false;
      }
    },

    listDir(path: string): readonly string[] {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },

    deleteFile(path: string): boolean {
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },

    appendFile(path: string, text: string): boolean {
      try {
        // `mode` is honoured only on creation, which is what we want: a mode the
        // user set on their own log is theirs to keep.
        appendFileSync(path, text, { encoding: "utf8", mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    },

    fileSize(path: string): number {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    },
  };
}
