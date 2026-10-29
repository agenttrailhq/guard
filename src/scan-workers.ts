/**
 * Reading Claude Code sessions on worker threads.
 *
 * Parsing every transcript, deciding which guardrails each tool call matches, and classing every
 * credential-shaped value are the slowest parts of a scan, and each session can be read on its
 * own. So `scan` starts a few worker threads in this same process and hands them tasks, one at a
 * time each, from one queue:
 *
 * - **read** a share of the sessions as the main thread would (`readClaudeSession`), evaluate
 *   every call in them against the same guardrails, compiled there from the same rules and
 *   config (`primeDecisions`), and hand both back, so the main thread looks those calls up
 *   rather than evaluating them again (`seedDecisions`);
 * - when the checks run, **collect**: read some of those sessions' files for the secrets check,
 *   into a collector under the run's one fingerprint key. The parts are joined into one
 *   collector (`mergeCollected`), and the check finishes as it would have in one thread.
 *
 * Every read comes before any collect, so the sessions arrive first, and the main thread runs
 * the other checks while the workers collect.
 *
 * A worker reads transcript files and nothing else: no repo, no process, no network. What it
 * hands back holds transcript text and values; it moves between threads of this process in
 * memory and is never written. A worker that fails leaves its task undone: sessions it was
 * reading to the main thread, which reads them itself, and files it was collecting to the
 * secrets check, which reads them itself.
 *
 * The worker runs the same bundle file as the command (`cli.js`, `guard-scan.mjs`): each entry
 * asks `isScanWorker()` first and, in a worker, runs `runScanWorker()` instead.
 */

import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { type CompiledAllowlist, compileAllowlist } from "./core/evaluate.js";
import { type CompiledRule, compileCatalog } from "./core/rules.js";
import { type DecisionEntry, decisionsMade, exportDecisions } from "./core/scan-report.js";
import {
  type ClaudeSessionRead,
  readClaudeSession,
  sessionBytes,
} from "./core/transcript/claude-session.js";
import type { GuardConfig, GuardRule } from "./core/types.js";
import { primeDecisions } from "./core/verify/calls.js";
import { createFingerprinter } from "./core/verify/fingerprint.js";
import {
  type CollectedPart,
  collectFile,
  createSecretsCollector,
  exportCollected,
} from "./core/verify/secrets.js";
import { createRealScanIO } from "./scan-io.js";

/** Marks a worker started by `readInWorkers`. */
const ROLE = "agenttrail-guard-scan";

/**
 * Most worker threads. Four, with the main thread a fifth: about what a laptop's fast cores
 * take, and never more than the cores there are, less one for the main thread (`workerCount`).
 */
const MAX_WORKERS = 4;

/** Fewest sessions worth starting a worker thread for. */
const MIN_SESSIONS_PER_WORKER = 8;

/** One session to read: its main transcript, and the id it is read under. */
export interface SessionItem {
  readonly file: string;
  readonly sessionId: string;
}

/** What the rules are compiled from, the same on every thread. */
export interface RulesInput {
  readonly rules: readonly GuardRule[];
  readonly config: GuardConfig;
}

/** What the sessions are read with. */
export interface ShareInput extends RulesInput {
  readonly items: readonly SessionItem[];
  /** The run's fingerprint key, when the secrets check will run; without it, no values are read. */
  readonly key?: Uint8Array;
}

/** What a worker is given when it starts. */
interface WorkerInput extends RulesInput {
  readonly role: typeof ROLE;
  readonly key?: Uint8Array;
}

/** A share's sessions, read, with the decisions made on their calls. */
export interface ShareSessions {
  /** One per item, in the order given. */
  readonly reads: readonly ClaudeSessionRead[];
  readonly decisions: readonly DecisionEntry[];
}

/** A task a worker is handed. */
type Task =
  | { readonly kind: "read"; readonly items: readonly SessionItem[] }
  | { readonly kind: "collect"; readonly files: readonly string[] };

/**
 * What a worker posts: a session read; a read task's sessions, then the decisions on their
 * calls; or a collect task's part.
 */
type WorkerMessage =
  | { readonly type: "session" }
  | { readonly type: "read"; readonly reads: readonly ClaudeSessionRead[] }
  | { readonly type: "decided"; readonly decisions: readonly DecisionEntry[] }
  | { readonly type: "collected"; readonly part: CollectedPart };

/** Is this thread a worker `readInWorkers` started? */
export function isScanWorker(): boolean {
  return !isMainThread && (workerData as Partial<WorkerInput> | null)?.role === ROLE;
}

/** Read sessions as the main thread reads them. `onSession` is told after each one. */
async function readSessions(
  items: readonly SessionItem[],
  onSession: () => void,
): Promise<ClaudeSessionRead[]> {
  const io = createRealScanIO();
  const reads: ClaudeSessionRead[] = [];
  for (const item of items) {
    reads.push(await readClaudeSession(io, item));
    onSession();
  }
  return reads;
}

/** The guardrails compiled in this thread, from the same rules and config as on the main one. */
interface CompiledRules {
  readonly catalog: readonly CompiledRule[];
  readonly allowlist: CompiledAllowlist;
}

/**
 * Compile `rules` here from the same rules and config as on the main thread, so a decision made
 * here is the one the main thread would make.
 */
function compileRules(rules: RulesInput): CompiledRules {
  return {
    catalog: compileCatalog(rules.rules, rules.config),
    allowlist: compileAllowlist(rules.config.allowlist),
  };
}

/**
 * Evaluate every call in `reads`, and give the decisions made doing so that `compiled` had not
 * made before: a call already decided, in an earlier share, was handed over then.
 */
function decide(reads: readonly ClaudeSessionRead[], compiled: CompiledRules): DecisionEntry[] {
  const { catalog, allowlist } = compiled;
  const before = decisionsMade(catalog, allowlist);
  const sessions = reads.flatMap((read) => (read.session === undefined ? [] : [read.session]));
  primeDecisions("claude", sessions, catalog, allowlist);
  return exportDecisions(catalog, allowlist, before);
}

/**
 * Read a share's sessions and evaluate their calls, as a worker does. Exported so a test can run
 * the worker's own reading in one thread. `onSession` is told after each session.
 */
export async function readShare(
  input: RulesInput & { readonly items: readonly SessionItem[] },
  onSession: () => void = () => {},
): Promise<ShareSessions> {
  const reads = await readSessions(input.items, onSession);
  return { reads, decisions: decide(reads, compileRules(input)) };
}

/** Read files for the secrets check, as a worker does. */
export async function collectShare(
  files: readonly string[],
  key: Uint8Array,
): Promise<CollectedPart> {
  const collector = createSecretsCollector({
    agent: "claude",
    fingerprint: createFingerprinter(key),
  });
  const io = createRealScanIO();
  for (const path of files) await collectFile(collector, path, (p) => io.readLines(p));
  return exportCollected(collector);
}

/**
 * A worker's whole job: each task it is handed, in turn, until it is ended. A read hands its
 * sessions back as soon as they are read, and the decisions after.
 */
export function runScanWorker(): void {
  const input = workerData as WorkerInput;
  const post = (message: WorkerMessage): void => parentPort?.postMessage(message);
  // Once for every share this worker reads, so a call decided for one is not decided again.
  const compiled = compileRules(input);
  parentPort?.on("message", (task: Task) => {
    void (async () => {
      if (task.kind === "read") {
        const reads = await readSessions(task.items, () => post({ type: "session" }));
        post({ type: "read", reads });
        post({ type: "decided", decisions: decide(reads, compiled) });
      } else if (input.key !== undefined) {
        post({ type: "collected", part: await collectShare(task.files, input.key) });
      }
    })();
  });
}

/** How many worker threads to start for `sessions` sessions: none when one thread will do. */
export function workerCount(sessions: number, cores: number = availableParallelism()): number {
  return Math.max(
    0,
    Math.min(MAX_WORKERS, cores - 1, Math.floor(sessions / MIN_SESSIONS_PER_WORKER)),
  );
}

/**
 * Share items out into `shares` shares by size, the largest first, each to the share with the
 * least so far, so the shares take about as long. Each share lists its items' positions in order;
 * an empty share is left out.
 */
export function shareBySize(sizes: readonly number[], shares: number): number[][] {
  const out: number[][] = Array.from({ length: shares }, () => []);
  const loads: number[] = out.map(() => 0);
  const order = sizes.map((_, at) => at).sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0) || a - b);
  for (const at of order) {
    let least = 0;
    for (let i = 1; i < shares; i++) if ((loads[i] ?? 0) < (loads[least] ?? 0)) least = i;
    out[least]?.push(at);
    loads[least] = (loads[least] ?? 0) + (sizes[at] ?? 0);
  }
  for (const share of out) share.sort((a, b) => a - b);
  return out.filter((share) => share.length > 0);
}

/** What reading the sessions on worker threads gives. */
export interface WorkersRead {
  /** One per item, in the order given; `undefined` for one no worker read. */
  readonly reads: readonly (ClaudeSessionRead | undefined)[];
  /**
   * The decisions made on each share's calls. It settles after the sessions, while the main
   * thread starts on the checks that need none.
   */
  readonly decisions: Promise<readonly (readonly DecisionEntry[])[]>;
  /**
   * The secrets check's parts, one per collect task done, in task order, when a key was given.
   * The workers collect while the main thread runs the other checks. Calling it, once the main
   * thread has nothing else to do, has it take collect tasks from the queue too; it settles when
   * every task is done.
   */
  readonly collected: () => Promise<readonly CollectedPart[]>;
}

/** Read shares per worker: more than one, so a worker that finishes early takes another. */
const READ_SHARES_PER_WORKER = 4;

/** Files per collect task. */
const FILES_PER_COLLECT = 16;

/** A task in the queue: its id, and for a read, its items' positions. */
interface Queued {
  readonly id: number;
  readonly task: Task;
  readonly positions?: readonly number[];
}

/**
 * Read `items` on `threads` worker threads started from `entry`. A session no worker read is left
 * `undefined`, for the main thread to read itself; with no worker at all, every one is.
 */
export async function readInWorkers(
  entry: URL,
  input: ShareInput,
  onSession: () => void = () => {},
  threads: number = workerCount(input.items.length),
): Promise<WorkersRead> {
  const reads: (ClaudeSessionRead | undefined)[] = input.items.map(() => undefined);
  const decisions: (readonly DecisionEntry[])[] = [];
  const parts = new Map<number, CollectedPart>();
  if (threads <= 0) {
    return { reads, decisions: Promise.resolve([]), collected: () => Promise.resolve([]) };
  }
  const io = createRealScanIO();
  const shares = shareBySize(
    input.items.map((item) => sessionBytes(io, item.file)),
    threads * READ_SHARES_PER_WORKER,
  );

  // The queue: every read first, then the collects each read adds.
  const queue: Queued[] = shares.map((positions, id) => ({
    id,
    positions,
    task: { kind: "read", items: positions.map((at) => input.items[at] as SessionItem) },
  }));
  let nextId = queue.length;
  /** Reads whose sessions have not come back, and reads whose decisions have not. */
  let unread = queue.length;
  let undecided = queue.length;
  let busy = 0;
  let live = 0;
  /** Workers waiting for a task: a read still running may yet add collects. */
  const idle: (() => void)[] = [];

  const settled = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const sessions = settled<void>();
  const decided = settled<readonly (readonly DecisionEntry[])[]>();
  const collected = settled<readonly CollectedPart[]>();
  const settle = (): void => {
    if (live === 0) {
      // No worker left to take what is queued: its reads are left to the main thread.
      for (const queued of queue) {
        if (queued.task.kind !== "read") continue;
        unread -= 1;
        undecided -= 1;
      }
      queue.length = 0;
    }
    if (unread === 0) sessions.resolve();
    if (undecided === 0) decided.resolve(decisions);
    if (unread === 0 && undecided === 0 && busy === 0 && queue.length === 0) {
      collected.resolve([...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part));
    }
  };
  const wake = (): void => {
    for (const waiting of idle.splice(0)) waiting();
  };
  const addCollects = (files: readonly string[]): void => {
    if (input.key === undefined) return;
    for (let at = 0; at < files.length; at += FILES_PER_COLLECT) {
      queue.push({
        id: nextId++,
        task: { kind: "collect", files: files.slice(at, at + FILES_PER_COLLECT) },
      });
    }
  };

  const start = (): void => {
    let worker: Worker;
    try {
      worker = new Worker(entry, {
        workerData: {
          role: ROLE,
          rules: input.rules,
          config: input.config,
          ...(input.key === undefined ? {} : { key: input.key }),
        } satisfies WorkerInput,
      });
    } catch {
      return;
    }
    live += 1;
    let current: Queued | undefined;
    let currentRead = false;
    let ended = false;
    const end = (): void => {
      ended = true;
      live -= 1;
      void worker.terminate();
    };
    const next = (): void => {
      if (ended) return;
      current = queue.shift();
      currentRead = false;
      if (current === undefined) {
        if (unread > 0 && input.key !== undefined) idle.push(next);
        else end();
        settle();
        return;
      }
      busy += 1;
      worker.postMessage(current.task);
    };
    worker.on("message", (message: WorkerMessage) => {
      const task = current;
      if (message.type === "session") {
        onSession();
        return;
      }
      if (task === undefined) return;
      if (message.type === "read") {
        for (const [k, at] of (task.positions ?? []).entries()) reads[at] = message.reads[k];
        currentRead = true;
        unread -= 1;
        addCollects(message.reads.flatMap((read) => read.files));
        wake();
        settle();
        return;
      }
      busy -= 1;
      if (message.type === "decided") {
        decisions.push(message.decisions);
        undecided -= 1;
      } else {
        parts.set(task.id, message.part);
      }
      current = undefined;
      next();
      settle();
    });
    const fail = (): void => {
      if (ended) return;
      ended = true;
      live -= 1;
      // Its task is left undone: a read's sessions to the main thread, its decisions to the
      // main thread's own evaluation, a collect's files to the secrets check.
      if (current !== undefined) {
        busy -= 1;
        if (current.task.kind === "read") {
          if (!currentRead) unread -= 1;
          undecided -= 1;
        }
        current = undefined;
      }
      wake();
      settle();
    };
    worker.once("error", fail);
    worker.once("exit", fail);
    next();
  };
  for (let i = 0; i < Math.min(threads, shares.length); i++) start();
  settle();

  /** The main thread's turn: collect tasks it takes from the queue, in this thread. */
  const help = async (): Promise<readonly CollectedPart[]> => {
    const key = input.key;
    for (;;) {
      const queued = key === undefined ? undefined : queue.shift();
      if (queued === undefined || key === undefined) break;
      if (queued.task.kind !== "collect") {
        queue.unshift(queued);
        break;
      }
      busy += 1;
      parts.set(queued.id, await collectShare(queued.task.files, key));
      busy -= 1;
      settle();
    }
    settle();
    return await collected.promise;
  };

  await sessions.promise;
  return { reads, decisions: decided.promise, collected: help };
}
