// cspell:words goldens
/**
 * `scan --no-checks` writes and prints exactly what guard 0.4.13 did, before the checks existed.
 *
 * The golden files in `__snapshots__/no-checks-0.4.13/` are 0.4.13's own output: its
 * `plugin/scripts/guard-scan.mjs`, run over the synthetic corpora in `fixtures/no-checks/`
 * with the clock fixed at `FIXED`, an empty HOME and no terminal, with the folder it ran in
 * written as `<work>`. Nothing else in them was changed.
 *
 * This file runs the scan the plugin runs (no scrub, no AgentTrail OS line), with `--no-checks`,
 * the same flags and the same clock, and compares the page, the artifact, `--json` and what
 * each printed, byte for byte, for Claude Code, Cursor and Codex. The only text replaced is
 * this package's own version, which the goldens carry as 0.4.13.
 *
 * The goldens were made with guardrail library 0.2.6, which 0.4.13 bundles. With another
 * library the guardrails that match differ, so the first test says so rather than reporting
 * a page difference.
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runScan } from "../commands/scan.js";
import { catalogStamp } from "../core/catalog-stamp.js";
import { VERSION } from "../core/version.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { filesUnder, LEAKS, scanned } from "./fixture-hygiene.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "no-checks");
const GOLDENS = join(HERE, "__snapshots__", "no-checks-0.4.13");

/** The clock the goldens were made at. */
const FIXED = new Date("2026-10-25T12:00:00.000Z");
/** The version the goldens carry, and the guardrail library they were made with. */
const GOLDEN_VERSION = "0.4.13";
const GOLDEN_LIBRARY = "0.2.6";

const AGENTS = ["claude", "cursor", "codex"] as const;

/** Each mode's flags, and the file it writes. */
const MODES = {
  document: { flags: ["--no-open"], file: "agenttrail-guard-report.html" },
  artifact: { flags: ["--artifact", "--no-open"], file: "agenttrail-guard-artifact.html" },
  json: { flags: ["--json"], file: undefined },
} as const;

type Mode = keyof typeof MODES;

/** One run, as the plugin's scan entry runs it, with what it printed and wrote. */
async function scanNoChecks(
  agent: (typeof AGENTS)[number],
  mode: Mode,
): Promise<{ code: number; stdout: string; written: Map<string, string>; checks: number }> {
  const work = mkdtempSync(join(tmpdir(), "agenttrail-no-checks-work-"));
  const home = mkdtempSync(join(tmpdir(), "agenttrail-no-checks-home-"));
  const out: string[] = [];
  const written = new Map<string, string>();
  let checks = 0;
  const io: ScanIO = {
    ...createRealScanIO(),
    homedir: () => home,
    cwd: () => work,
    env: {},
    isTTY: () => false,
    writeStdout: (text) => {
      out.push(text);
    },
    writeFile: (path, text) => {
      written.set(path, text);
      return true;
    },
    openInBrowser: () => {
      throw new Error("--no-open was given");
    },
  };
  const code = await runScan(
    ["--agent", agent, "--dir", join(FIXTURES, agent), ...MODES[mode].flags, "--no-checks"],
    io,
    {
      productLine: false,
      createVerifyIO: () => {
        checks += 1;
        throw new Error("--no-checks was given");
      },
    },
  );
  // The folder it ran in, as the goldens write it, and the package's version as theirs.
  const normal = (text: string): string =>
    text.replaceAll(work, "<work>").replaceAll(VERSION, GOLDEN_VERSION);
  return {
    code,
    stdout: normal(out.join("")),
    written: new Map([...written].map(([path, text]) => [normal(path), normal(text)])),
    checks,
  };
}

/** A golden file's text. */
const golden = (name: string): string => readFileSync(join(GOLDENS, name), "utf8");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("scan --no-checks is 0.4.13's scan, byte for byte", () => {
  it("the goldens were made with the guardrail library this build bundles", () => {
    expect(
      catalogStamp().version,
      `The goldens are 0.4.13's output over guardrail library ${GOLDEN_LIBRARY}. Another library matches other guardrails, so this comparison no longer holds: pin --no-checks against a release built with it.`,
    ).toBe(GOLDEN_LIBRARY);
  });

  it("there is a golden for every app and mode, and nothing else", () => {
    const expected = AGENTS.flatMap((agent) =>
      (Object.keys(MODES) as Mode[]).flatMap((mode) => [
        `${agent}-${mode}.stdout.txt`,
        ...(MODES[mode].file === undefined ? [] : [`${agent}-${mode}.html`]),
      ]),
    );
    expect(readdirSync(GOLDENS).sort()).toEqual(expected.sort());
  });

  it.each(
    AGENTS.flatMap((agent) => (Object.keys(MODES) as Mode[]).map((mode) => [agent, mode] as const)),
  )("%s, %s: what it writes and prints", async (agent, mode) => {
    const run = await scanNoChecks(agent, mode);
    expect(run.code).toBe(0);
    expect(run.checks, "no check ran").toBe(0);
    expect(run.stdout).toBe(golden(`${agent}-${mode}.stdout.txt`));
    const file = MODES[mode].file;
    if (file === undefined) {
      expect(run.written.size, "--json writes no file").toBe(0);
    } else {
      expect([...run.written.keys()]).toEqual([`<work>/${file}`]);
      expect(run.written.get(`<work>/${file}`)).toBe(golden(`${agent}-${mode}.html`));
    }
  });

  it("negative control: the comparison sees one changed byte of a page", async () => {
    const run = await scanNoChecks("codex", "document");
    const page = run.written.get(`<work>/${MODES.document.file}`) ?? "";
    expect(page).toBe(golden("codex-document.html"));
    expect(page.replace("</style>", " </style>")).not.toBe(golden("codex-document.html"));
  });
});

describe("the corpora and goldens are synthetic and carry nothing they should not", () => {
  const files = [
    ...filesUnder(FIXTURES).map((f) => join(FIXTURES, f)),
    ...filesUnder(GOLDENS).map((f) => join(GOLDENS, f)),
  ];

  it.each(LEAKS.map((leak) => [leak.name, leak] as const))("no %s", (_name, leak) => {
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      expect(scanned(readFileSync(file, "utf8")), file).not.toMatch(leak.pattern);
    }
  });

  it("the planted example credential is redacted in every golden", () => {
    const corpus = readFileSync(
      join(FIXTURES, "claude", "-home-user-project", "00000000-0000-4000-8000-000000000041.jsonl"),
      "utf8",
    );
    const planted = corpus.match(/AKIA[0-9A-Z]{16}/)?.[0];
    expect(planted).toBeDefined();
    for (const name of readdirSync(GOLDENS)) {
      expect(golden(name), name).not.toContain(planted);
    }
    expect(golden("claude-document.html")).toContain("[REDACTED:");
  });
});
