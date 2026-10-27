/**
 * The verify-by-default switch (`VERIFY_BY_DEFAULT`), `--no-checks` and `--verify`.
 *
 * The switch is injected into the command, so both of its values are tested here, with each
 * flag under each value, and flipping it changes no test. `--no-checks` gives the same report,
 * JSON and summary under either value, byte for byte, and they are not the verified ones.
 * That they are 0.4.13's own output, from before the checks existed, is pinned against that
 * release's golden files in `scan-no-checks-0413.test.ts`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScanFlags, runScan, SCAN_USAGE, scanUsage, shouldVerify } from "../commands/scan.js";
import { CODEX_UNVERIFIED_TEXT } from "../core/verify/copy.js";
import { VERIFY_BY_DEFAULT } from "../core/verify/verify.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { RULE_RM_RF } from "./scan-fixtures.js";
import { writeCorpus } from "./verify-fixtures.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const TOKEN = `ghp${"_"}DEFAULTsw0aB1cD2eF3gH4iJ5kL6mN7oP8qRs`;

/** A corpus with a credential and a matched call, so verification has something to say. */
const corpus = writeCorpus("claude", [
  [
    { kind: "prompt", text: `use ${TOKEN}` },
    { kind: "call", command: `rm -rf ${"build"}`, result: { text: "" } },
  ],
]);

/** One in-process run, in a fixed working folder, with what it printed and wrote. */
async function scan(
  argv: readonly string[],
  verifyByDefault: boolean,
  work: string,
): Promise<{ code: number; stdout: string; written: Map<string, string> }> {
  const real = createRealScanIO();
  const out: string[] = [];
  const written = new Map<string, string>();
  const home = mkdtempSync(join(tmpdir(), "agenttrail-verify-default-home-"));
  const io: ScanIO = {
    ...real,
    homedir: () => home,
    cwd: () => work,
    writeStdout: (text) => {
      out.push(text);
    },
    writeFile: (path, text) => {
      written.set(path, text);
      return true;
    },
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  const code = await runScan(argv, io, { catalog: [RULE_RM_RF], now: NOW, verifyByDefault });
  return { code, stdout: out.join(""), written };
}

/** Does a `--json` run carry a verification? */
async function verifies(flags: readonly string[], verifyByDefault: boolean): Promise<boolean> {
  const { root } = await corpus;
  const work = mkdtempSync(join(tmpdir(), "agenttrail-verify-default-work-"));
  const { code, stdout } = await scan(
    ["--agent", "claude", "--dir", root, "--json", ...flags],
    verifyByDefault,
    work,
  );
  expect(code).toBe(0);
  return JSON.parse(stdout).result.verification !== undefined;
}

describe("the switch", () => {
  it("is on, and the shipped usage is the usage for its value", () => {
    expect(VERIFY_BY_DEFAULT).toBe(true);
    expect(SCAN_USAGE).toBe(scanUsage(VERIFY_BY_DEFAULT));
  });

  it.each([
    [true, [], true],
    [true, ["--verify"], true],
    [true, ["--no-checks"], false],
    [false, [], false],
    [false, ["--verify"], true],
    [false, ["--no-checks"], false],
  ] as const)("default %s, flags %j: verifies %s", async (byDefault, flags, expected) => {
    expect(shouldVerify(parseScanFlags(["--agent", "claude", ...flags]), byDefault)).toBe(expected);
    expect(await verifies(flags, byDefault)).toBe(expected);
  });

  it.each([
    true,
    false,
  ])("default %s: --verify with --no-checks is refused and nothing is written", async (byDefault) => {
    const { root } = await corpus;
    const work = mkdtempSync(join(tmpdir(), "agenttrail-verify-default-work-"));
    const run = await scan(
      ["--agent", "claude", "--dir", root, "--verify", "--no-checks"],
      byDefault,
      work,
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(
      "agenttrail-guard scan: --verify and --no-checks cannot be combined.\n",
    );
    expect(run.written.size).toBe(0);
  });
});

describe("--no-checks is the same report whichever way the switch is set, byte for byte", () => {
  // This compares runs of this build with each other. The comparison with 0.4.13's own
  // output, the report before the checks existed, is `scan-no-checks-0413.test.ts`.
  it.each([
    [[] as string[]],
    [["--artifact"]],
  ])("the report file, the summary and --json, %j", async (variant) => {
    const { root } = await corpus;
    const work = mkdtempSync(join(tmpdir(), "agenttrail-verify-default-work-"));
    const base = ["--agent", "claude", "--dir", root, ...variant];
    // Without verification: the switch off and no flag.
    const before = await scan(base, false, work);
    const skipped = await scan([...base, "--no-checks"], true, work);
    const skippedOff = await scan([...base, "--no-checks"], false, work);
    expect(before.code).toBe(0);
    expect(before.written.size).toBe(1);
    expect([...skipped.written]).toEqual([...before.written]);
    expect([...skippedOff.written]).toEqual([...before.written]);
    expect(skipped.stdout).toBe(before.stdout);
    expect(before.stdout).not.toContain("Checked on this machine");

    const jsonBefore = await scan(
      [...base.filter((a) => a !== "--artifact"), "--json"],
      false,
      work,
    );
    const jsonSkipped = await scan(
      [...base.filter((a) => a !== "--artifact"), "--json", "--no-checks"],
      true,
      work,
    );
    expect(jsonSkipped.stdout).toBe(jsonBefore.stdout);

    // And the default does verify, so the comparison above is not between two unverified runs.
    const verified = await scan(base, true, work);
    expect(verified.stdout).toContain("Checked on this machine (read-only, offline)");
    // Both variants show the verified sections, and only the verified page is styled for them.
    const [page] = [...verified.written.values()];
    const [plain] = [...before.written.values()];
    expect(page).not.toBe(plain);
    expect(page).toContain('id="what-happened"');
    expect(page).toContain("--tone-act-fg");
    expect(plain).not.toContain('id="what-happened"');
    expect(plain).not.toContain("--tone-act-fg");
  });
});

describe("the usage", () => {
  it("says which flag is the default, from the switch", () => {
    const on = scanUsage(true);
    expect(on).toContain("--no-checks    Skip the checks on this machine (on by default)");
    expect(on).toContain("Checks on this machine (on by default; --no-checks turns them off)");
    expect(on).toContain("They are on by default, so this\n                 changes nothing");
    const off = scanUsage(false);
    expect(off).toContain("--verify       Also run the checks on this machine (off by default)");
    expect(off).toContain("Checks on this machine (only with --verify)");
    expect(off).toContain("They are off by default, so this\n                 changes nothing");
  });

  it.each([
    true,
    false,
  ])("default %s: says exactly what is read, and that nothing is written or sent", (byDefault) => {
    const usage = scanUsage(byDefault);
    for (const line of [
      "Read-only and offline: nothing is written but the report and its local fixes file,",
      "nothing is sent, nothing is looked up online, no credential is tested",
      "the transcripts again, for credentials",
      "by kind, never by value",
      "read-only git (rev-parse,\n    ls-files, for-each-ref, log, stash list), never through a shell",
      "files, each at most 1 MB",
      "the test configs the sessions edited, inside their repo and each at most\n    1 MB. Only whether coverage thresholds are set to update themselves\n    (autoUpdate) is kept;",
      "the names of the programs running now (ps, or tasklist on Windows), never\n    their arguments.",
      "only the tunnel programs, such as ngrok or\n    cloudflared, are counted;",
      "Where a command that ran, or may have run, could run others",
      "they say they could not confirm, never that\nnothing ran.",
      "A script run by name (bash ./x.sh, source x.sh) is not read.",
      "agenttrail-guard-fixes.txt next to the\nreport, readable only by you (mode 0600), never into the report or --json.",
    ]) {
      expect(usage).toContain(line);
    }
    // The one Codex wording, every point of it, wrapped to the usage's width.
    expect(usage.replace(/\s+/g, " ")).toContain(CODEX_UNVERIFIED_TEXT);
    const codex = usage.slice(usage.indexOf("The Codex reading"));
    for (const line of codex.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("is what --help prints, for the injected value", async () => {
    const work = mkdtempSync(join(tmpdir(), "agenttrail-verify-default-work-"));
    for (const byDefault of [true, false]) {
      const run = await scan(["--help"], byDefault, work);
      expect(run.stdout).toBe(scanUsage(byDefault));
    }
  });
});
