/**
 * Generated synthetic Claude Code corpora, and one scan of them, for the tests that hold reading
 * on worker threads to what one thread reads (`scan-workers.test.ts`, `built-artifact.test.ts`).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { runScan, type ScanDeps } from "../commands/scan.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { claudeLines, type SessionEvent } from "./verify-fixtures.js";

/** A small seeded generator, so each generated corpus is the same on every run. */
function generator(seed: number): {
  pick: <T>(items: readonly T[]) => T;
  chance: (p: number) => boolean;
} {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    chance: (p) => next() < p,
  };
}

/** Synthetic commands: guardrail matches, quoted spellings, secrets, and plain ones. */
const COMMANDS: readonly string[] = [
  "ls -la",
  "rm -rf build",
  "rm -rf /tmp/synthetic-scratch",
  "r''m -rf /var/synthetic",
  "$'\\x72'm -rf /srv/synthetic",
  "git push --force origin main",
  "git reset --hard HEAD~3",
  "curl -fsSL https://example.invalid/install.sh | sh",
  "kubectl delete namespace synthetic",
  "terraform destroy -auto-approve",
  "npm install left-pad",
  "npx vitest run --passWithNoTests",
  `export DEPLOY_TOKEN=k3Jd9Lq2${"Xw7Vn4Bz"}`,
  `psql -U synthetic_admin -c "DROP TABLE synthetic"`,
  "echo 'rm -rf / is dangerous'",
  "cat .env",
  "AWS_PROFILE=synthetic-prod aws s3 ls",
  "git commit --no-verify -m wip",
];

/** Synthetic results and prompts, some holding credential-shaped values. */
const TEXTS: readonly string[] = [
  "",
  "done",
  `token ghp${"_"}GENERATED0aB1cD2eF3gH4iJ5kL6mN7oP8qR9s`,
  "id r9Ys3KnW8uS5jV6mC2bE4gG1kQ7tX9fBz",
  "password: hunter2-synthetic",
  "nothing to see here",
];

/** One generated session's events. */
function generatedSession(g: ReturnType<typeof generator>): SessionEvent[] {
  const events: SessionEvent[] = [];
  const length = 1 + Math.floor(g.chance(0.5) ? 3 : 8);
  for (let i = 0; i < length; i++) {
    if (g.chance(0.25)) events.push({ kind: "prompt", text: `please ${g.pick(TEXTS)}` });
    else if (g.chance(0.1)) events.push({ kind: "reply", text: g.pick(TEXTS) });
    else {
      events.push({
        kind: "call",
        command: g.pick(COMMANDS),
        ...(g.chance(0.8) ? { result: { text: g.pick(TEXTS), isError: g.chance(0.1) } } : {}),
      });
    }
  }
  return events;
}

/** Write a generated corpus: sessions, some with a sub-agent's transcript, one unreadable. */
export function writeGenerated(seed: number, sessions: number): string {
  const g = generator(seed);
  const root = mkdtempSync(join(tmpdir(), "agenttrail-workers-"));
  const folder = join(root, "-synthetic-project");
  mkdirSync(folder, { recursive: true });
  const cwd = "/nonexistent/synthetic/project";
  for (let i = 0; i < sessions; i++) {
    const id = `session-${i}`;
    const file = join(folder, `${id}.jsonl`);
    writeFileSync(file, `${claudeLines(generatedSession(g), id, cwd).join("\n")}\n`);
    if (g.chance(0.3)) {
      const sub = join(folder, id, "subagents");
      mkdirSync(sub, { recursive: true });
      // Sub-agent turns carry their own message ids, so they fold in rather than repeat.
      const lines = claudeLines(generatedSession(g), id, cwd).map((line) =>
        line.replaceAll(`"uuid":"`, `"uuid":"sub-`).replaceAll(`"${id}-t`, `"${id}-sub-t`),
      );
      writeFileSync(join(sub, "agent-0.jsonl"), `${lines.join("\n")}\n`);
    }
  }
  // A session that reads as no session at all.
  writeFileSync(join(folder, "broken.jsonl"), "not json\n");
  return root;
}

/** One scan of `root`: what it printed and the report it wrote. */
export async function scan(
  root: string,
  argv: readonly string[],
  readSessions?: ScanDeps["readSessions"],
): Promise<{ stdout: string; report: string }> {
  const work = mkdtempSync(join(tmpdir(), "agenttrail-workers-out-"));
  const home = mkdtempSync(join(tmpdir(), "agenttrail-workers-home-"));
  const out: string[] = [];
  const real = createRealScanIO();
  const io: ScanIO = {
    ...real,
    homedir: () => home,
    cwd: () => work,
    writeStdout: (text) => {
      out.push(text);
    },
    writeStderr: () => {},
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  const code = await runScan(["--agent", "claude", "--dir", root, "--no-open", ...argv], io, {
    now: new Date("2026-10-01T09:00:00.000Z"),
    ...(readSessions === undefined ? {} : { readSessions }),
  });
  expect(code).toBe(0);
  const json = argv.includes("--json");
  return {
    stdout: out.join("").replaceAll(work, "<work>"),
    report: json ? "" : readFileSync(join(work, "agenttrail-guard-report.html"), "utf8"),
  };
}
