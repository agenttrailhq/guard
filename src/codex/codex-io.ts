/**
 * `CodexFileIO` — the file seam for `init --agent codex`, `uninstall --agent codex`, and the
 * Codex section of `status`, which only reads through it.
 *
 * It is Cursor's seam, under Codex's name and nothing else: the same four operations, the
 * same implementation. Both installs edit a JSON file another app owns, so both need a read
 * that tells a missing file from an unreadable one, a mode read, an atomic write that keeps
 * the file's mode and writes through a symbolic link, and a delete that forgives a missing
 * file. ONE implementation, so a fix to the write — the temp-file cleanup, the link
 * handling — can never land for one app and quietly not for the other.
 *
 * The name exists so that neither app's code has to read as if it were the other's, and so
 * that the day Codex needs an operation Cursor does not, this alias becomes its own
 * interface without touching a single call site.
 *
 * Only the CLI commands import this module, so it is outside the hook bundle graph
 * (`bundle-graph.test.ts`).
 */

import { type CursorFileIO, createRealCursorFileIO } from "../cursor/cursor-io.js";

/** Everything the Codex install needs from the file system. */
export type CodexFileIO = CursorFileIO;

/** The real file seam. Imported only by the CLI commands. */
export const createRealCodexFileIO: () => CodexFileIO = createRealCursorFileIO;
