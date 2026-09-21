import type { CursorFileIO } from "../cursor/cursor-io.js";

/**
 * An in-memory `CursorFileIO`, so no test reads or writes a real `~/.cursor/hooks.json`.
 *
 * It records every read, write and delete. A path listed in `failReads` or `failWrites`
 * throws the way a refused system call does, and `beforeRead` lets a test change a file
 * between two reads, as another program writing it would.
 */

/** A file's text and permission bits. */
export interface FakeFile {
  readonly text: string;
  readonly mode: number;
}

export interface FakeCursorFiles {
  readonly io: CursorFileIO;
  readonly files: Map<string, FakeFile>;
  /** Every write, in order. */
  readonly writes: Array<{ path: string; text: string; mode: number }>;
  /** Every delete of a file that existed, in order. */
  readonly deletes: string[];
  /** Every path passed to `readFile` or `fileMode`, in order. */
  readonly reads: string[];
}

export interface FakeCursorFilesOptions {
  /** Starting files. A string is a file at mode 0644. */
  readonly files?: Readonly<Record<string, string | FakeFile>>;
  readonly failReads?: readonly string[];
  readonly failWrites?: readonly string[];
  /** Runs before each `readFile`, with how many times `readFile` read that path before. */
  readonly beforeRead?: (path: string, earlierReads: number, files: Map<string, FakeFile>) => void;
}

export function fakeCursorFiles(options: FakeCursorFilesOptions = {}): FakeCursorFiles {
  const files = new Map<string, FakeFile>(
    Object.entries(options.files ?? {}).map(([path, file]) => [
      path,
      typeof file === "string" ? { text: file, mode: 0o644 } : file,
    ]),
  );
  const writes: FakeCursorFiles["writes"] = [];
  const deletes: string[] = [];
  const reads: string[] = [];
  const readCounts = new Map<string, number>();

  const failRead = (path: string): void => {
    if (options.failReads?.includes(path)) {
      throw new Error(`EACCES: permission denied, open '${path}'`);
    }
  };

  const io: CursorFileIO = {
    readFile(path) {
      reads.push(path);
      failRead(path);
      const earlier = readCounts.get(path) ?? 0;
      readCounts.set(path, earlier + 1);
      options.beforeRead?.(path, earlier, files);
      return files.get(path)?.text;
    },
    fileMode(path) {
      reads.push(path);
      failRead(path);
      return files.get(path)?.mode;
    },
    writeFileAtomic(path, text, mode) {
      if (options.failWrites?.includes(path)) {
        throw new Error(`EACCES: permission denied, open '${path}'`);
      }
      writes.push({ path, text, mode });
      files.set(path, { text, mode });
    },
    deleteFile(path) {
      if (files.delete(path)) deletes.push(path);
    },
  };

  return { io, files, writes, deletes, reads };
}
