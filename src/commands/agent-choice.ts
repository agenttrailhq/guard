/**
 * `--agent` on `init`, `uninstall` and `scan`: which app to install guard for, remove it
 * from, or read the sessions of.
 *
 * The flag is required, and only the exact names in `AGENTS` count. With the CLI's
 * options, `node:util`'s `parseArgs` gives a lone `--agent` as `true`, and in
 * `--agent --print` takes `--print` as the value, so both are refused here along with a
 * missing flag and any other name.
 *
 * STRICTER THAN THE HOOK PATH, on purpose. `core/agent.ts` treats the flag as advisory
 * because a hook that refuses to run protects nothing, and because the payload is there
 * to decide. These commands have no payload: they act on one app's files, so a name they
 * cannot place is refused rather than guessed at.
 *
 * The menu is built from `AGENTS`, so a fourth app appears here the moment it is added.
 */

import { agentDisplayName } from "../core/agent.js";
import { AGENTS, type AgentSource } from "../core/types.js";

/** The app an `--agent` value names, when it is exactly one of `AGENTS`. */
export function chosenAgent(value: unknown): AgentSource | undefined {
  return AGENTS.find((name) => name === value);
}

/** `--agent claude, --agent cursor or --agent codex`, as the refusal's first line spells it. */
function agentList(): string {
  const flags = AGENTS.map((name) => `--agent ${name}`);
  const head = flags.slice(0, -1).join(", ");
  const tail = flags.slice(-1).join("");
  return head === "" ? tail : `${head} or ${tail}`;
}

/** What `command` prints, before changing anything, when `--agent` names no supported app. */
export function agentChoiceMessage(command: string): string {
  const width = Math.max(...AGENTS.map((name) => name.length));
  const lines = AGENTS.map(
    (name) =>
      `  agenttrail-guard ${command} --agent ${name.padEnd(width)}   for ${agentDisplayName(name)}\n`,
  );
  return `agenttrail-guard ${command}: choose ${agentList()}.\n\n${lines.join("")}`;
}
