/**
 * An in-memory `CodexFileIO`, so no test reads or writes a real `~/.codex/hooks.json`.
 *
 * `CodexFileIO` is `CursorFileIO` (`codex/codex-io.ts` says why), so the fake is the same
 * fake under Codex's name. One implementation, so a test double that drifts — a write that
 * stops recording its mode, say — cannot drift for one app and not the other.
 */

export {
  type FakeCursorFiles as FakeCodexFiles,
  type FakeCursorFilesOptions as FakeCodexFilesOptions,
  type FakeFile,
  fakeCursorFiles as fakeCodexFiles,
} from "./cursor-files.js";
