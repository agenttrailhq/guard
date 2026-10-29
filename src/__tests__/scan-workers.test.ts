/**
 * Reading sessions the worker threads' way gives what one thread gives.
 *
 * The workers' own reading (`readShare`, `collectShare`) runs here in this thread, and what it
 * hands over goes through `structuredClone`, as it does between threads, so the split itself is
 * what is tested: shares by size, decisions made against a catalog compiled apart and seeded
 * into the scan's, the secrets check's parts joined, and sessions or files a worker left undone
 * read by the main thread. The workers themselves run from the built bundles, in
 * `built-artifact.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { DecisionEntry } from "../core/scan-report.js";
import { sessionBytes } from "../core/transcript/claude-session.js";
import { createFingerprinter } from "../core/verify/fingerprint.js";
import {
  checkSecrets,
  collectFile,
  createSecretsCollector,
  exportCollected,
  mergeCollected,
} from "../core/verify/secrets.js";
import { UNAVAILABLE_VERIFY_IO } from "../core/verify/verify.js";
import { createRealScanIO } from "../scan-io.js";
import {
  collectShare,
  readShare,
  type ShareInput,
  shareBySize,
  type WorkersRead,
  workerCount,
} from "../scan-workers.js";
import { writeCorpus } from "./verify-fixtures.js";
import { scan, writeGenerated } from "./workers-fixtures.js";

describe("workerCount", () => {
  it("starts none for a few sessions or one core, at most four, and leaves a core", () => {
    expect(workerCount(3, 8)).toBe(0);
    expect(workerCount(100, 1)).toBe(0);
    expect(workerCount(16, 8)).toBe(2);
    expect(workerCount(1000, 8)).toBe(4);
    expect(workerCount(1000, 3)).toBe(2);
  });
});

describe("shareBySize", () => {
  it("gives the largest first to the share with the least, each share in order", () => {
    expect(shareBySize([10, 1, 1, 1, 9], 2)).toEqual([
      [0, 2],
      [1, 3, 4],
    ]);
    expect(shareBySize([5, 5, 5, 5], 2)).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it("leaves out an empty share, and every position is in exactly one", () => {
    expect(shareBySize([3], 4)).toEqual([[0]]);
    const sizes = Array.from({ length: 37 }, (_, i) => (i * 7919) % 101);
    const shares = shareBySize(sizes, 5);
    expect(shares.flat().sort((a, b) => a - b)).toEqual(sizes.map((_, i) => i));
  });
});

describe("collectors joined from parts", () => {
  it("give exactly what one collector gives", async () => {
    const token = `ghp${"_"}JOINED0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0u`;
    const sessions = Array.from({ length: 6 }, (_, i) => [
      { kind: "prompt" as const, text: `here ${token}` },
      {
        kind: "call" as const,
        command: `export DEPLOY_TOKEN=k3Jd9Lq2Xw7Vn4B${i}`,
        result: { text: `id r9Ys3KnW8uS5jV6mC2bE4gG1kQ7tX9fB${i}` },
      },
    ]);
    const { corpus } = await writeCorpus("claude", sessions);
    const files = corpus.files ?? [];
    const io = createRealScanIO();
    const readLines = (path: string) => io.readLines(path);
    const key = new Uint8Array(32).fill(7);

    const joined = createSecretsCollector({
      agent: "claude",
      fingerprint: createFingerprinter(key),
    });
    for (const share of [files.slice(0, 2), files.slice(2)]) {
      const part = createSecretsCollector({
        agent: "claude",
        fingerprint: createFingerprinter(key),
      });
      for (const path of share) await collectFile(part, path, readLines);
      mergeCollected(joined, exportCollected(part));
    }
    const base = {
      agent: "claude" as const,
      files,
      readLines,
      io: UNAVAILABLE_VERIFY_IO,
      fingerprint: createFingerprinter(key),
    };
    expect(await checkSecrets({ ...base, collector: joined })).toEqual(await checkSecrets(base));
  });
});

/** How the in-thread stand-in for the workers leaves work undone. */
interface Undone {
  /** Shares whose sessions it never hands back, by index. */
  readonly reads?: ReadonlySet<number>;
  /** Collect tasks whose part it never hands back, by index. */
  readonly collects?: ReadonlySet<number>;
}

/** The workers' reading, run in this thread, handed over as between threads. */
function inThread(undone: Undone = {}) {
  return async (input: ShareInput, onSession: () => void): Promise<WorkersRead> => {
    const io = createRealScanIO();
    const shares = shareBySize(
      input.items.map((item) => sessionBytes(io, item.file)),
      3,
    );
    const reads: WorkersRead["reads"][number][] = input.items.map(() => undefined);
    const decisions: (readonly DecisionEntry[])[] = [];
    const files: string[] = [];
    for (const [i, share] of shares.entries()) {
      if (undone.reads?.has(i) === true) continue;
      const read = structuredClone(
        await readShare(
          { ...input, items: share.map((at) => input.items[at] as never) },
          onSession,
        ),
      );
      for (const [k, at] of share.entries()) reads[at] = read.reads[k];
      decisions.push(read.decisions);
      for (const r of read.reads) files.push(...r.files);
    }
    const collected = async () => {
      const key = input.key;
      if (key === undefined) return [];
      const parts = [];
      for (let at = 0, task = 0; at < files.length; at += 4, task++) {
        if (undone.collects?.has(task) === true) continue;
        parts.push(structuredClone(await collectShare(files.slice(at, at + 4), key)));
      }
      return parts;
    };
    return {
      reads,
      decisions: Promise.resolve(decisions),
      collected,
    };
  };
}

describe("a scan read the workers' way", () => {
  // Generated corpora, each read in one thread and the workers' way: what the scan prints and
  // the report it writes are the same, with and without the checks.
  const SEEDS = [1, 2, 3, 4, 5, 6];

  it.each(SEEDS)("gives what one thread gives (corpus %i)", async (seed) => {
    const root = writeGenerated(seed, 30);
    for (const argv of [["--json"], ["--json", "--no-checks"], []]) {
      const single = await scan(root, argv);
      const split = await scan(root, argv, inThread());
      expect(split).toEqual(single);
    }
  });

  it("reads what a worker left undone in this thread, and gives the same", async () => {
    const root = writeGenerated(7, 30);
    const single = await scan(root, []);
    const undone = inThread({ reads: new Set([1]), collects: new Set([0, 2]) });
    expect(await scan(root, [], undone)).toEqual(single);
    expect(await scan(root, ["--json"], undone)).toEqual(await scan(root, ["--json"]));
  });

  it("finds credentials and guardrail matches, so the comparison is not of empty scans", async () => {
    const root = writeGenerated(8, 30);
    const { stdout } = await scan(root, ["--json"], inThread());
    const result = JSON.parse(stdout) as { totals?: { matches?: number } };
    expect(JSON.stringify(result)).toContain("likely-real");
    expect(stdout).toContain("block-curl-pipe-to-shell");
  });
});
