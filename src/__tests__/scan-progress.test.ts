/**
 * `scan`'s progress on stderr: which phase, how far through, never a path or anything found,
 * one rewritten line in a terminal and one line per phase elsewhere, and nothing at all under
 * `--quiet` or in the plugin's scan.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../commands/scan.js";
import { createProgress, progressLine, REDRAW_MS } from "../commands/scan-progress.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { RULE_RM_RF } from "./scan-fixtures.js";
import { writeCorpus } from "./verify-fixtures.js";

describe("createProgress", () => {
  it("in a terminal, rewrites one line, at most once per redraw interval within a phase", () => {
    const out: string[] = [];
    let t = 0;
    const progress = createProgress(
      (s) => out.push(s),
      true,
      () => t,
    );
    progress.phase("Reading sessions", 0, 10);
    t += 10;
    progress.phase("Reading sessions", 1, 10);
    t += REDRAW_MS;
    progress.phase("Reading sessions", 2, 10);
    progress.phase("Checking 1 of 10: which commands ran");
    progress.finish("Scanned in 3 s");
    expect(out).toEqual([
      `\r\u001b[K${progressLine("Reading sessions", 0, 10)}`,
      `\r\u001b[K${progressLine("Reading sessions", 2, 10)}`,
      `\r\u001b[K${progressLine("Checking 1 of 10: which commands ran")}`,
      "\r\u001b[K",
      "agenttrail-guard: Scanned in 3 s\n",
    ]);
  });

  it("elsewhere, writes one plain line per phase and no carriage return", () => {
    const out: string[] = [];
    const progress = createProgress((s) => out.push(s), false);
    progress.phase("Reading sessions", 0, 2);
    progress.phase("Reading sessions", 1, 2);
    progress.phase("Writing the report");
    progress.finish();
    expect(out).toEqual([
      "agenttrail-guard: Reading sessions\n",
      "agenttrail-guard: Writing the report\n",
    ]);
    expect(out.join("")).not.toContain("\r");
  });

  it("counts with a thousands separator", () => {
    expect(progressLine("Reading sessions", 1200, 12000)).toBe(
      "agenttrail-guard: Reading sessions · 1,200 of 12,000",
    );
  });
});

/** One scan of a synthetic corpus, with stdout and stderr captured. */
async function scan(
  argv: readonly string[],
  terminal: boolean,
  progress?: false,
): Promise<{ stdout: string; stderr: string; root: string }> {
  const { root } = await writeCorpus("claude", [
    [{ kind: "call", command: "rm -rf build", result: { text: "" } }],
    [{ kind: "prompt", text: "hello" }],
  ]);
  const work = mkdtempSync(join(tmpdir(), "agenttrail-progress-work-"));
  const out: string[] = [];
  const err: string[] = [];
  const io: ScanIO = {
    ...createRealScanIO(),
    homedir: () => mkdtempSync(join(tmpdir(), "agenttrail-progress-home-")),
    cwd: () => work,
    writeStdout: (text) => out.push(text),
    writeStderr: (text) => err.push(text),
    isStderrTTY: () => terminal,
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  await runScan(["--agent", "claude", "--dir", root, "--no-open", ...argv], io, {
    catalog: [RULE_RM_RF],
    ...(progress === false ? { progress } : {}),
  });
  return { stdout: out.join(""), stderr: err.join(""), root };
}

describe("scan writes its progress to stderr", () => {
  it("names each phase and every check, and never a path", async () => {
    const { stderr, root } = await scan([], false);
    expect(stderr).toContain("agenttrail-guard: Reading sessions\n");
    for (let step = 1; step <= 10; step++) expect(stderr).toContain(`Checking ${step} of 10: `);
    expect(stderr).toContain("agenttrail-guard: Writing the report\n");
    expect(stderr).toMatch(/agenttrail-guard: Scanned in \d+ s\n$/);
    expect(stderr).not.toContain(root);
    expect(stderr).not.toContain(tmpdir());
  });

  it("in a terminal, clears its line before anything goes to stdout", async () => {
    const { stderr } = await scan([], true);
    expect(stderr).toContain("\r\u001b[K");
    expect(stderr.endsWith("\n")).toBe(true);
  });

  it("writes nothing to stderr under --quiet, or from the plugin's scan", async () => {
    expect((await scan(["--quiet"], true)).stderr).toBe("");
    expect((await scan([], true, false)).stderr).toBe("");
  });

  it("leaves stdout as valid JSON under --json", async () => {
    const { stdout, stderr } = await scan(["--json"], false);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain("Reading sessions");
  });
});
