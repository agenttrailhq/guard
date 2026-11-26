/**
 * The entry point for `plugin/scripts/guard-hook.mjs` — the file Claude Code, Cursor and Codex
 * actually execute on every tool call.
 *
 * DELIBERATELY SEPARATE from `cli.ts`. Reaching the hook through the CLI would pull
 * the argument parser and the colour helper into this bundle. `color.ts` must not be
 * importable from the hook path, and the
 * cheapest way to guarantee that is for the hook's import graph never to touch the
 * CLI at all. `no-network.test.ts` walks this entry and asserts it — and asserts the
 * same thing about `net/crash-transport.ts`, which is why crash reporting CAPTURES
 * here and sends only from `crash-report`, a command this file cannot reach.
 *
 * One file, two threads. The main thread supervises (`hook-deadline.ts`): it reads the call,
 * starts this same file as a worker thread, writes the one answer, and answers on its own at
 * the deadline. The worker (`hook-worker.ts`) runs the check. `isHookWorker()` is asked
 * FIRST, before anything else here runs, so a worker never starts supervising.
 *
 * Note what is NOT here: no `process.exit`, and no assignment to `process.exitCode`.
 * The process ends naturally at 0 — which is both the invariant and the way
 * stdout is reliably flushed on a pipe. The one other way it ends is `SIGKILL` from
 * itself, and only when a worker it terminated did not stop (`hook-deadline.ts`).
 */

import { agentFromArgv } from "./core/agent.js";
import { runHookWithDeadline } from "./hook-run.js";
import { isHookWorker, runHookWorker } from "./hook-worker.js";

if (isHookWorker()) {
  await runHookWorker();
} else {
  // The app named on the hook's command line: `--agent claude` in the Claude Code plugin's
  // `hooks/hooks.json`.
  await runHookWithDeadline(agentFromArgv(process.argv.slice(2)), new URL(import.meta.url));
}
