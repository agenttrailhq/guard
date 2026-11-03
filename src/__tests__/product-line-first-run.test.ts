/**
 * The AgentTrail OS line on a real disk, from a home with no `~/.agenttrail` in it.
 *
 * `scan` needs nothing installed, so it can be the first command anyone runs. Its record of
 * the last showing lives in `~/.agenttrail/guard/`, and that folder has to be created before
 * the record can be written. The fake disks in `scan-cli.test.ts` accept a write into any
 * folder, so this runs the real scan IO against a temporary home.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../commands/scan.js";
import { guardDir, productLineStatePath } from "../core/paths.js";
import { productLineText } from "../core/product-line.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { assistantLine, bash, RULE_RM_RF, userLine } from "./scan-fixtures.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const LINE = productLineText({ surface: "scan", agent: "claude", matches: 1, asks: 0 }) as string;
const ARGV = ["--agent", "claude", "--no-open", "--no-checks"];

/** A home holding one Claude Code session with one matched call, and nothing else. */
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agenttrail-first-run-home-"));
  const project = join(home, ".claude", "projects", "-Users-dev-app");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "session-1.jsonl"),
    `${[userLine("clean up"), assistantLine([bash("rm -rf build", "t1")])].join("\n")}\n`,
  );
  return home;
}

/** One scan in a terminal, on the real disk, with `home` as the home folder. */
async function scanIn(home: string): Promise<{ code: number; stdout: string }> {
  const work = mkdtempSync(join(tmpdir(), "agenttrail-first-run-work-"));
  const out: string[] = [];
  const io: ScanIO = {
    ...createRealScanIO(),
    homedir: () => home,
    cwd: () => work,
    writeStdout: (text) => {
      out.push(text);
    },
    writeStderr: () => {},
    openInBrowser: () => true,
    env: {},
    isTTY: () => true,
  };
  const code = await runScan(ARGV, io, { catalog: [RULE_RM_RF], now: NOW });
  return { code, stdout: out.join("") };
}

describe("scan, before ~/.agenttrail/guard exists", () => {
  it("prints the line, records it, and holds it back on the second run that day", async () => {
    const home = freshHome();
    expect(existsSync(join(home, ".agenttrail"))).toBe(false);

    const first = await scanIn(home);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`\n${LINE}\n`);
    expect(JSON.parse(readFileSync(productLineStatePath(home), "utf8"))).toEqual({
      scan: NOW.toISOString(),
    });

    const second = await scanIn(home);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("AgentTrail OS");
  });

  it("holds the line back when the folder cannot be created", async () => {
    const home = freshHome();
    // A file where the folder would go: creating `~/.agenttrail/guard` fails.
    writeFileSync(join(home, ".agenttrail"), "");

    const run = await scanIn(home);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Full report:");
    expect(run.stdout).not.toContain("AgentTrail OS");
    expect(existsSync(guardDir(home))).toBe(false);
  });
});
