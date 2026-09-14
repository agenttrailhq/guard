/**
 * `agenttrail-guard uninstall` — remove our plugin, and only ours.
 *
 * "A tool that is hard to remove is a tool people warn each other about." So this
 * removes our entry, leaves every other hook untouched, and running it twice is not an
 * error.
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

import { guardDir } from "../core/paths.js";
import { uninstallGuardPlugin } from "../plugin/install.js";
import type { SetupIO } from "../setup-io.js";

/** Run `uninstall`. Returns an exit code; never throws, never calls `process.exit`. */
export async function runUninstall(io: SetupIO): Promise<number> {
  let result: ReturnType<typeof uninstallGuardPlugin>;
  try {
    result = uninstallGuardPlugin({ runner: io.runClaude });
  } catch (error) {
    io.writeStdout(`agenttrail-guard: ${(error as Error).message}\n`);
    return 1;
  }

  if (result.status === "not-installed") {
    // Not an error. "Already gone" is the desired end state.
    io.writeStdout(
      `${result.pluginId} is not installed — nothing to remove.\n` +
        `Your settings in ${guardDir(io.homedir())} were left alone.\n`,
    );
    return 0;
  }

  io.writeStdout(
    `Removed ${result.pluginId} (scope: ${result.scope}).\n` +
      (result.marketplaceRemoved ? "Removed its marketplace entry too.\n" : "") +
      "Every other plugin and hook you have is untouched.\n\n" +
      `Your settings are still in ${guardDir(io.homedir())} — your allowlist, action\n` +
      "overrides and your own guardrails. Delete that directory if you want them gone.\n",
  );
  return 0;
}
