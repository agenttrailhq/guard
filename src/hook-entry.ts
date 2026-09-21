/**
 * The entry point for `plugin/scripts/guard-hook.mjs` — the file Claude Code
 * actually executes on every tool call.
 *
 * DELIBERATELY SEPARATE from `cli.ts`. Reaching the hook through the CLI would pull
 * the argument parser and the colour helper into this bundle. `color.ts` must not be
 * importable from the hook path, and the
 * cheapest way to guarantee that is for the hook's import graph never to touch the
 * CLI at all. `no-network.test.ts` walks this entry and asserts it — and asserts the
 * same thing about `net/crash-transport.ts`, which is why crash reporting CAPTURES
 * here and sends only from `crash-report`, a command this file cannot reach.
 *
 * Note what is NOT here: no `process.exit`, and no assignment to `process.exitCode`.
 * The process ends naturally at 0 — which is both the invariant and the way
 * stdout is reliably flushed on a pipe. Crash capture does not change that: it runs
 * after the decision is emitted and swallows everything.
 */

import { runHook } from "./commands/hook.js";
import { agentFromArgv } from "./core/agent.js";
import { captureCrash } from "./core/crash-capture.js";
import { scrubSecrets } from "./core/crash-scrub.js";
import { VERSION } from "./core/version.js";
import { createRealIO } from "./io.js";

const io = createRealIO();

await runHook(io, {
  // The app named on the hook's command line: `--agent claude` in the Claude Code
  // plugin's `hooks/hooks.json`.
  agent: agentFromArgv(process.argv.slice(2)),
  captureCrash: (err) => {
    captureCrash(err, {
      io,
      scrubSecrets,
      command: "hook",
      guardVersion: VERSION,
      now: () => Date.now(),
    });
  },
});
