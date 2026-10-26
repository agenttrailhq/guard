// cspell:words devpass Fingerprinter
/**
 * `findLikelyReal` (`core/verify/secrets.ts`): the secrets check, keeping the text of each
 * likely-real value for `scan --scrub` to replace. Synthetic transcripts and a temporary git
 * repo built in the test.
 *
 * Every credential-shaped string is assembled at runtime from parts, never written whole as a
 * source literal; none of them is real.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSource } from "../core/types.js";
import { createFingerprinter } from "../core/verify/fingerprint.js";
import { checkSecrets, findLikelyReal, type SecretsInput } from "../core/verify/secrets.js";
import { createRealScanIO } from "../scan-io.js";
import { createRealVerifyIO } from "../verify-io.js";
import { type SessionEvent, writeCorpus } from "./verify-fixtures.js";

const GITHUB = `ghp${"_"}Hn5Kx2Wq8Lr4Tz7Vm1Bd6Fc9Gj3Sp0Ya5Ue2`;
const AWS_ID = `AKIA${"N5YP2RX8QK4TZ7VM"}`;
const DEPLOY = `r4Jw8Kn2${"Xc6Vb9Lt"}`;
const FIXTURE = `fx7Ln3Qz8${"Mw2Kd5Rp4T"}`;
const LOCAL_URL = `postgres://app:${"devpass552"}@localhost:5432/app`;

/** A temporary git repo with `files` in its index. */
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agenttrail-likely-real-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const REPO = repoWith({ "test/fixtures/service.json": JSON.stringify({ SERVICE_TOKEN: FIXTURE }) });

const SESSION: SessionEvent[] = [
  { kind: "prompt", text: `use this one ${GITHUB}` },
  { kind: "call", command: "cat keys.txt", result: { text: `aws_access_key_id = ${AWS_ID}` } },
  { kind: "call", command: `export DEPLOY_TOKEN=${DEPLOY}`, result: { text: "" } },
  { kind: "call", command: `SERVICE_TOKEN=${FIXTURE} pnpm test`, result: { text: "ok" } },
  { kind: "call", command: "export API_TOKEN=your-api-token-here", result: { text: "" } },
  { kind: "call", command: `psql ${LOCAL_URL}`, result: { text: "" } },
];

/** The secrets-check input for one written corpus. */
async function input(agent: AgentSource, maxHeldValues?: number): Promise<SecretsInput> {
  const { corpus } = await writeCorpus(agent, [SESSION], { cwd: REPO });
  const io = createRealScanIO();
  return {
    agent,
    files: corpus.files ?? [],
    readLines: (path: string) => io.readLines(path),
    io: createRealVerifyIO(),
    fingerprint: createFingerprinter(),
    ...(maxHeldValues === undefined ? {} : { maxHeldValues }),
  };
}

describe("findLikelyReal", () => {
  it("returns exactly the likely-real values, longest first, with their kinds", async () => {
    const given = await input("claude");
    const found = await findLikelyReal(given);
    const file = given.files[0] as string;
    expect(found.values).toEqual([
      { value: GITHUB, kind: "github-token", files: [file] },
      { value: AWS_ID, kind: "aws-access-key", files: [file] },
      { value: DEPLOY, kind: "named-secret", files: [file] },
    ]);
    expect(found.notHeld).toBe(0);
  });

  it("says which transcript files hold each value", async () => {
    const { corpus } = await writeCorpus("claude", [SESSION, [{ kind: "reply", text: GITHUB }]], {
      cwd: REPO,
    });
    const files = corpus.files ?? [];
    const io = createRealScanIO();
    const found = await findLikelyReal({
      agent: "claude",
      files,
      readLines: (path) => io.readLines(path),
      io: createRealVerifyIO(),
      fingerprint: createFingerprinter(),
    });
    const byValue = new Map(found.values.map((v) => [v.value, v.files]));
    expect(byValue.get(GITHUB)).toEqual([files[0], files[1]]);
    expect(byValue.get(AWS_ID)).toEqual([files[0]]);
  });

  it("returns the same check as checkSecrets", async () => {
    const found = await findLikelyReal(await input("codex"));
    expect(found.check).toEqual(await checkSecrets(await input("codex")));
    expect(found.check.facts.classes["likely-real"]).toBe(found.values.length);
  });

  it("counts likely-real values past the held-values cap instead of returning them", async () => {
    const found = await findLikelyReal(await input("claude", 1));
    expect(found.values).toHaveLength(1);
    expect(found.notHeld).toBeGreaterThan(0);
    expect(found.values.length + found.notHeld).toBe(found.check.facts.classes["likely-real"]);
  });

  it("returns nothing when there is nothing likely real", async () => {
    const { corpus } = await writeCorpus("claude", [[{ kind: "prompt", text: "hello" }]]);
    const io = createRealScanIO();
    const found = await findLikelyReal({
      agent: "claude",
      files: corpus.files ?? [],
      readLines: (path) => io.readLines(path),
      io: createRealVerifyIO(),
      fingerprint: createFingerprinter(),
    });
    expect(found.values).toEqual([]);
    expect(found.notHeld).toBe(0);
  });
});
