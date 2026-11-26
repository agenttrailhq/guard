/**
 * The hook's worker thread: the whole check, exactly as `runHook` does it, on the payload the
 * main thread read (`hook-deadline.ts`).
 *
 * It writes nothing to stdout. Its one answer goes to the main thread as a message, which
 * writes it, so the deadline and the check can never both reach stdout. After the answer it
 * records the decision, as the hook always has, and ends.
 *
 * It runs from the same bundle file as the main thread: the entry asks `isHookWorker()` first
 * and, in a worker, runs this instead of supervising.
 */

import { realpathSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { runHook } from "./commands/hook.js";
import { captureCrash } from "./core/crash-capture.js";
import { scrubSecrets } from "./core/crash-scrub.js";
import { VERSION } from "./core/version.js";
import { HOOK_WORKER_ROLE, type HookWorkerInput, type HookWorkerMessage } from "./hook-deadline.js";
import { createRealIO, type GuardIO } from "./io.js";

/** Is this thread the hook's worker? Checked before anything else in the bundle runs. */
export function isHookWorker(): boolean {
  return (
    !isMainThread && (workerData as Partial<HookWorkerInput> | null)?.role === HOOK_WORKER_ROLE
  );
}

/** Run the check on the payload the main thread handed over. Never rejects. */
export async function runHookWorker(): Promise<void> {
  const data = workerData as HookWorkerInput;
  const post = (message: HookWorkerMessage): void => {
    try {
      parentPort?.postMessage(message);
    } catch {
      /* the main thread is gone */
    }
  };
  const real = createRealIO();
  const io: GuardIO = {
    ...real,
    readStdin: async () => data.input,
    // The main thread writes the answer. Nothing from here reaches stdout.
    writeStdout: () => {},
    homedir: () => data.home,
  };
  await runHook(io, {
    ...(data.agent !== undefined ? { agent: data.agent } : {}),
    env: process.env,
    realpath: (path) => realpathSync.native(path),
    processCwd: data.cwd,
    onAnswered: (text) => post({ kind: "answer", text }),
    onStepAside: (standDown) => post({ kind: "stepAside", standDown }),
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
}
