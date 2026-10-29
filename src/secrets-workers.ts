/**
 * The secrets check's reading of the transcripts, on worker threads.
 *
 * Classing every credential-shaped value in every transcript is the slowest part of a scan, and
 * each file can be read on its own. So `scan` starts a few worker threads in this same process,
 * each reading its share of the files into its own collector under the run's one fingerprint
 * key, while the main thread runs the other checks. The parts are then joined into one
 * collector (`mergeCollected`), and the check finishes as it would have in one thread.
 *
 * A worker reads transcript files and nothing else: no repo, no process, no network. What it
 * hands back holds values; it moves between threads of this process in memory and is never
 * written. A worker that fails leaves its files unread, and the check reads them itself.
 *
 * The worker runs the same bundle file as the command (`cli.js`, `guard-scan.mjs`): each entry
 * asks `isSecretsWorker()` first and, in a worker, runs `runSecretsWorker()` instead.
 */

import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { AgentSource } from "./core/types.js";
import { createFingerprinter } from "./core/verify/fingerprint.js";
import {
  type CollectedPart,
  collectFile,
  createSecretsCollector,
  exportCollected,
  mergeCollected,
  type SecretsCollector,
} from "./core/verify/secrets.js";
import { createRealScanIO } from "./scan-io.js";

/** Marks a worker started by `collectInWorkers`. */
const ROLE = "agenttrail-guard-secrets";

/**
 * Most worker threads. Kept below the cores a laptop runs fastest, so the main thread, which
 * runs the other checks meanwhile, keeps one.
 */
const MAX_WORKERS = 3;

/** Fewest files worth starting a worker thread for. */
const MIN_FILES_PER_WORKER = 8;

/** What a worker is given. */
interface WorkerInput {
  readonly role: typeof ROLE;
  readonly agent: AgentSource;
  readonly files: readonly string[];
  readonly key: Uint8Array;
}

/** Is this thread a worker `collectInWorkers` started? */
export function isSecretsWorker(): boolean {
  return !isMainThread && (workerData as Partial<WorkerInput> | null)?.role === ROLE;
}

/** A worker's whole job: read its files into a collector, and hand the collector back. */
export async function runSecretsWorker(): Promise<void> {
  const input = workerData as WorkerInput;
  const collector = createSecretsCollector({
    agent: input.agent,
    fingerprint: createFingerprinter(input.key),
  });
  const io = createRealScanIO();
  for (const path of input.files) await collectFile(collector, path, (p) => io.readLines(p));
  parentPort?.postMessage(exportCollected(collector));
}

/** How many worker threads to start for `files` files: none when one thread will do. */
export function workerCount(files: number, cores: number = availableParallelism()): number {
  return Math.max(0, Math.min(MAX_WORKERS, cores - 1, Math.floor(files / MIN_FILES_PER_WORKER)));
}

/** One worker's part, or `undefined` when it failed. */
function runWorker(entry: URL, input: WorkerInput): Promise<CollectedPart | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (part: CollectedPart | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(part);
    };
    try {
      const worker = new Worker(entry, { workerData: input });
      // Its part is all a worker has to give: it is ended then, so nothing it left running
      // can keep the scan from exiting.
      worker.once("message", (part: CollectedPart) => {
        settle(part);
        void worker.terminate();
      });
      worker.once("error", () => settle(undefined));
      worker.once("exit", () => settle(undefined));
    } catch {
      settle(undefined);
    }
  });
}

/**
 * Read `files` into one collector, on worker threads started from `entry`. Files a worker could
 * not read, or every file when no worker could start, are left out of it; the secrets check
 * reads those itself.
 */
export async function collectInWorkers(
  entry: URL,
  agent: AgentSource,
  files: readonly string[],
  threads: number = workerCount(files.length),
): Promise<SecretsCollector> {
  const key = randomBytes(32);
  const collector = createSecretsCollector({ agent, fingerprint: createFingerprinter(key) });
  if (threads <= 0) return collector;
  // Spread by position, so each worker gets a mix of early and late, large and small files.
  const shares = Array.from({ length: threads }, (_, i) =>
    files.filter((_, at) => at % threads === i),
  );
  const parts = await Promise.all(
    shares.map((share) => runWorker(entry, { role: ROLE, agent, files: share, key })),
  );
  for (const part of parts) if (part !== undefined) mergeCollected(collector, part);
  return collector;
}
