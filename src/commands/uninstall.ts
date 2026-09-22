/**
 * `agenttrail-guard uninstall --agent claude|cursor|codex` — remove our plugin or our
 * entries in another app's hooks file, and only ours.
 *
 * "A tool that is hard to remove is a tool people warn each other about." So this
 * removes our entry, leaves every other hook untouched, and running it twice is not an
 * error.
 *
 * That sentence is also what settles the one hard question on the Codex path. Codex
 * approves a hook by its POSITION in the file, so removing guard's entry moves any entry
 * after it up one and costs that tool its approval. Guard could refuse to remove itself
 * unless its entry is last. It does not: a guard that will not uninstall itself leaves the
 * user hand-editing the very file guard just refused to touch, still enforcing after they
 * asked it to stop, and guard cannot even confirm the harm — the approvals live in Codex's
 * `config.toml`, which guard does not read. So it removes, and says plainly which events
 * are affected, and only when an entry really does follow guard's.
 *
 * `--agent` is required, and checked before anything is read, written or run. `--agent
 * cursor` is `uninstallCursor` in `cursor/install.ts` and `--agent codex` is
 * `uninstallCodex` in `codex/install.ts`; neither runs `claude`. The rest of this paragraph
 * describes `--agent claude`.
 *
 * The two mechanics that make that true — the pre-check that supplies idempotence the
 * vendor does not, and the strict uninstall-then-marketplace-remove order — live in
 * `plugin/install.ts`, each with the measurement that justifies it. This command is
 * only the human wrapper around them.
 *
 * `init` writes two files under `~/.agenttrail/guard/`; `uninstall` deliberately does
 * NOT delete them. They hold the user's allowlist, their action overrides and their own
 * rules — reinstalling and silently finding all of that gone would be worse than
 * leaving two small JSON files behind. The message says where they are so removing them
 * is one obvious command.
 */

import { type CodexFileIO, createRealCodexFileIO } from "../codex/codex-io.js";
import { uninstallCodex } from "../codex/install.js";
import { unhandledAgent } from "../core/agent.js";
import { guardDir } from "../core/paths.js";
import { type CursorFileIO, createRealCursorFileIO } from "../cursor/cursor-io.js";
import { uninstallCursor } from "../cursor/install.js";
import { guardPluginCacheDir, uninstallGuardPlugin } from "../plugin/install.js";
import type { SetupIO } from "../setup-io.js";
import { agentChoiceMessage, chosenAgent } from "./agent-choice.js";

export interface UninstallDeps {
  /** `--agent cursor`'s file seam. Overridden in tests, so none touches a real `~/.cursor`. */
  readonly cursorIo?: CursorFileIO;
  /** `--agent codex`'s file seam. Overridden in tests, so none touches a real `~/.codex`. */
  readonly codexIo?: CodexFileIO;
}

/**
 * Clear the guard plugin's stale cache directories. Returns how many version directories
 * were there, for the message.
 *
 * Claude Code caches each installed plugin VERSION in its own directory and its own
 * `plugin uninstall` leaves them behind, so they accumulate across uninstall/reinstall
 * cycles. Once the plugin is gone every version under its cache directory is stale, so the
 * whole tree goes. Best-effort throughout: a cache that cannot be listed or removed is inert
 * residue, never a reason to fail an uninstall — and when the IO cannot list or remove
 * directories at all (a bare test IO), the step is simply skipped.
 */
function clearStalePluginCache(io: SetupIO): number {
  if (io.readdir === undefined || io.removeDirRecursive === undefined) return 0;
  const cacheDir = guardPluginCacheDir(io.homedir(), process.env.CLAUDE_CONFIG_DIR);
  const entries = io.readdir(cacheDir);
  if (entries === undefined) return 0;
  io.removeDirRecursive(cacheDir);
  return entries.length;
}

/**
 * Run `uninstall`. Returns an exit code; never throws, never calls `process.exit`.
 *
 * `--agent` must name an app `AGENTS` holds. A name it does not, including no flag at
 * all, prints the choice and exits 1 before any read, write or spawn.
 */
export async function runUninstall(
  io: SetupIO,
  argv: { readonly agent?: string | boolean } = {},
  deps: UninstallDeps = {},
): Promise<number> {
  const agent = chosenAgent(argv.agent);
  if (agent === undefined) {
    io.writeStdout(agentChoiceMessage("uninstall"));
    return 1;
  }

  // Which uninstaller runs. A checked switch, not `agent === "cursor" ? … : …`: an app
  // with no branch would have fallen through to the Claude Code plugin uninstall and
  // reported another app's removal as its own.
  switch (agent) {
    case "cursor": {
      const removed = uninstallCursor(io.homedir(), deps.cursorIo ?? createRealCursorFileIO());
      if (!removed.ok) {
        io.writeStdout(`agenttrail-guard: ${removed.message}\n`);
        return 1;
      }
      io.writeStdout(`${removed.value.join("\n")}\n`);
      return 0;
    }
    case "codex": {
      const removed = uninstallCodex(io.homedir(), deps.codexIo ?? createRealCodexFileIO());
      if (!removed.ok) {
        io.writeStdout(`agenttrail-guard: ${removed.message}\n`);
        return 1;
      }
      io.writeStdout(`${removed.value.join("\n")}\n`);
      return 0;
    }
    case "claude":
      break;
    default:
      return unhandledAgent(agent);
  }

  let result: ReturnType<typeof uninstallGuardPlugin>;
  try {
    result = uninstallGuardPlugin({ runner: io.runClaude });
  } catch (error) {
    io.writeStdout(`agenttrail-guard: ${(error as Error).message}\n`);
    return 1;
  }

  // Clear the plugin's cache either way: stale version directories can outlive an
  // uninstall the vendor already did, so "not installed" is exactly when they may still
  // be there.
  const clearedCaches = clearStalePluginCache(io);
  const cacheLine =
    clearedCaches > 0
      ? `Cleared ${clearedCaches} stale plugin cache director${clearedCaches === 1 ? "y" : "ies"}.\n`
      : "";

  if (result.status === "not-installed") {
    // Not an error. "Already gone" is the desired end state.
    io.writeStdout(
      `${result.pluginId} is not installed — nothing to remove.\n` +
        cacheLine +
        `Your settings in ${guardDir(io.homedir())} were left alone.\n`,
    );
    return 0;
  }

  io.writeStdout(
    `Removed ${result.pluginId} (scope: ${result.scope}).\n` +
      (result.marketplaceRemoved ? "Removed its marketplace entry too.\n" : "") +
      cacheLine +
      "Every other plugin and hook you have is untouched.\n\n" +
      `Your settings are still in ${guardDir(io.homedir())} — your allowlist, action\n` +
      "overrides and your own guardrails. Delete that directory if you want them gone.\n",
  );
  return 0;
}
