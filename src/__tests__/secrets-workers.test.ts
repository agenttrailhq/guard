/**
 * How many worker threads the secrets check's reading uses, and that collectors joined from
 * parts give what one collector gives. The workers themselves run from the built bundles, in
 * `built-artifact.test.ts`.
 */

import { describe, expect, it } from "vitest";
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
import { workerCount } from "../secrets-workers.js";
import { writeCorpus } from "./verify-fixtures.js";

describe("workerCount", () => {
  it("starts none for a few files or one core, and at most four", () => {
    expect(workerCount(3, 8)).toBe(0);
    expect(workerCount(100, 1)).toBe(0);
    expect(workerCount(16, 8)).toBe(2);
    expect(workerCount(1000, 8)).toBe(4);
    expect(workerCount(1000, 3)).toBe(2);
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
