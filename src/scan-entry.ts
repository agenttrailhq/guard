/**
 * The entry point for `plugin/scripts/guard-scan.mjs` — `scan` and nothing else, for the
 * Claude Code plugin's `share-report` skill.
 *
 * Claude Code runs an installed plugin from its own copy of the `plugin/` folder, so the
 * skill cannot reach `dist/cli.js`, and the CLI is not reliably on PATH when it was run
 * with `npx`. This file ships in `plugin/scripts/` beside the hook, so the skill and the
 * scanner it runs are always the same version.
 *
 * Separate from `cli.ts` so the bundle carries `scan` and what it needs, and nothing else:
 * no install commands, no process for Claude Code's own CLI, not crash reporting — the
 * one module in this package that can reach the network — and not `--scrub`, which changes
 * transcripts: it passes no `scrub`, so `scan` refuses `--scrub` and `--apply` here.
 * `no-network.test.ts` walks this entry and asserts it; `bundle-graph.test.ts` asserts what
 * it may not import.
 */

import { runScan } from "./commands/scan.js";
import { createRealScanIO } from "./scan-io.js";
import { collectInWorkers, isSecretsWorker, runSecretsWorker } from "./secrets-workers.js";
import { createRealVerifyIO } from "./verify-io.js";

// A worker thread `scan` started for the secrets check runs this same file: it reads its
// transcripts and nothing else.
if (isSecretsWorker()) {
  await runSecretsWorker();
} else {
  // The skill's output is read by the agent, so the AgentTrail OS line is left out.
  const code = await runScan(process.argv.slice(2), createRealScanIO(), {
    productLine: false,
    progress: false,
    createVerifyIO: () => createRealVerifyIO(),
    collectSecrets: (agent, files) => collectInWorkers(new URL(import.meta.url), agent, files),
  });
  if (code !== 0) {
    process.exitCode = code;
  }
}
