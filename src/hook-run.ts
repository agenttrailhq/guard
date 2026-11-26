/**
 * One real hook run with its deadline, for the two entries that start one: the plugin bundle
 * (`hook-entry.ts`) and `agenttrail-guard hook` (`cli.ts`).
 *
 * `workerUrl` is the running bundle's own file: the worker is the same file, and each entry
 * asks `isHookWorker()` before anything else, so a worker runs the check and nothing more.
 */

import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import type { AgentSource } from "./core/types.js";
import { HOOK_WORKER_MAX_HEAP_MB, superviseHook } from "./hook-deadline.js";
import { createRealIO, writeStdoutFlushed } from "./io.js";

export function runHookWithDeadline(agent: AgentSource | undefined, workerUrl: URL): Promise<void> {
  return superviseHook({
    ...(agent !== undefined ? { agent } : {}),
    cwd: process.cwd(),
    home: homedir(),
    readStdin: () => createRealIO().readStdin(),
    write: writeStdoutFlushed,
    startWorker: (workerInput) =>
      new Worker(workerUrl, {
        workerData: workerInput,
        resourceLimits: { maxOldGenerationSizeMb: HOOK_WORKER_MAX_HEAP_MB },
        // The worker's own stdio stays its own: nothing it prints can reach the answer.
        stdout: true,
        stderr: true,
      }),
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    releaseStdin: () => process.stdin.destroy(),
    killSelf: () => process.kill(process.pid, "SIGKILL"),
  });
}
