/**
 * `SetupIO` — the side-effect seam for the CLI-only commands (`init`, `status`,
 * `uninstall`).
 *
 * ── Why this is NOT part of `GuardIO`, and it is structural ─────────────────
 * `io.ts` is inside the HOOK BUNDLE GRAPH: `hook-entry.ts` imports it, so anything
 * reachable from it is inlined into `plugin/scripts/guard-hook.mjs` — the file Claude
 * Code executes before EVERY tool call. Teaching `GuardIO` to spawn a process would
 * therefore ship a process spawner into the hot enforcement path, where it has no
 * business being and where an accidental call could stall a developer's agent.
 *
 * So the file writer and the `claude` runner live here instead, in a module the hook
 * graph never touches. `bundle-graph.test.ts` asserts that — it fails if any module
 * reachable from `hook-entry.ts` imports `node:child_process`.
 *
 * The second reason is smaller but real: every existing test builds a bare
 * four-member `GuardIO` literal, so adding required members there turns the suite red
 * across files that have nothing to do with this module.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Result of one `claude …` invocation. */
export interface ClaudeRunResult {
  /** Process exit code, or `null` if the process could not be spawned at all. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set when the process could not be spawned (e.g. `"ENOENT"` — `claude` is not on
   * PATH). When present, `code` is `null`.
   */
  readonly spawnError?: string;
}

/** Runs `claude` with the given args. Injected so no test touches the real binary. */
export type ClaudeRunner = (args: readonly string[]) => ClaudeRunResult;

/** Everything the setup commands need from outside the process. */
export interface SetupIO {
  /** Write to stdout. These commands are for humans; multi-line output is expected. */
  writeStdout(text: string): void;
  /** Read a UTF-8 file, or `undefined` when missing or unreadable. */
  readFile(path: string): string | undefined;
  /** Does this path exist? Used to detect a marketplace source that has vanished. */
  exists(path: string): boolean;
  /**
   * Write `text` to `path` atomically at mode `0600`.
   *
   * Temp file then rename, so a crash mid-write cannot leave a half-written config
   * that the hook would then read as corrupt. Throws on failure — the caller turns
   * that into a named error, because a config the user believes exists but does not
   * is worse than a loud failure.
   */
  writeFileAtomic(path: string, text: string): void;
  /** The user's home directory; `~/.agenttrail/guard` hangs off it. */
  homedir(): string;
  /** Run `claude` with these arguments. */
  runClaude: ClaudeRunner;
  /**
   * List a directory's entries, or `undefined` when it is missing or unreadable.
   *
   * OPTIONAL, so the many bare `SetupIO` test literals keep compiling. Used only by
   * `uninstall` to see and clear the plugin's stale cache directories; when absent, that
   * cleanup is skipped (best-effort by design).
   */
  readdir?(path: string): string[] | undefined;
  /**
   * Remove a directory and everything under it. Best-effort — the real one never throws.
   *
   * OPTIONAL, for the same reason as `readdir`. Only `uninstall` uses it, only against the
   * guard's own plugin-cache tree.
   */
  removeDirRecursive?(path: string): void;
}

/**
 * The real `claude` runner.
 *
 * NOTE the deliberate absence of `-y`/`--yes`. With Claude Code 2.1.263 and stdin
 * and stdout both pipes (never a TTY), `marketplace add` and `install` of a
 * local `directory` source both exit 0 with no prompt, so the flag is unnecessary —
 * and it is not harmless. `-y` accepts a marketplace-DECLARED COMMAND without
 * confirmation, which is exactly the install class a human should be shown. Passing it
 * "just in case" would trade a hypothetical hang for a real hole.
 */
export const defaultClaudeRunner: ClaudeRunner = (args) => {
  const r = spawnSync("claude", [...args], { encoding: "utf8" });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { code: null, stdout: "", stderr: "", spawnError: code ?? r.error.message };
  }
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** The real setup IO. Imported only by the CLI entry, never from `core/` or the hook. */
export function createRealSetupIO(): SetupIO {
  return {
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

    exists(path: string): boolean {
      return existsSync(path);
    },

    writeFileAtomic(path: string, text: string): void {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Same directory as the target: `rename` is only atomic within one filesystem,
      // and a temp dir can be on another one.
      const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
      try {
        writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, path);
      } catch (error) {
        try {
          unlinkSync(tmp);
        } catch {
          /* the temp file may never have been created */
        }
        throw error;
      }
    },

    homedir(): string {
      return homedir();
    },

    runClaude: defaultClaudeRunner,

    readdir(path: string): string[] | undefined {
      try {
        return readdirSync(path);
      } catch {
        return undefined;
      }
    },

    removeDirRecursive(path: string): void {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* best-effort: a cache we could not clear is inert residue, never a failure */
      }
    },
  };
}
