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
 * no install commands, no process for Claude Code's own CLI, and not crash reporting — the
 * one module in this package that can reach the network. `no-network.test.ts` walks this
 * entry and asserts it; `bundle-graph.test.ts` asserts what it may not import.
 */

import { runScan } from "./commands/scan.js";
import { createRealScanIO } from "./scan-io.js";

const code = await runScan(process.argv.slice(2), createRealScanIO());
if (code !== 0) {
  process.exitCode = code;
}
