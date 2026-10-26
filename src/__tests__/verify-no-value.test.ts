// cspell:words ZEBRAFISH zebrafish CANARYPRNT
/**
 * No credential value leaves `scan --verify`: not in the report, its data block, `--json`,
 * `--review` or the terminal.
 *
 * A canary credential of a different kind is planted in every place the secrets check reads —
 * a prompt, a command, a command's output, the agent's reply — for every app, and one is also
 * committed to a temporary repo so the committed-fixture path runs too. Corpus health is
 * asserted first: each canary is in the transcript files, and the check found them, so an
 * absence below is not the absence of a check that never fired. Then every surface is searched
 * in every decoded form, and the environment-variable NAME a secret was given is searched for
 * too, since the report shows a credential's kind and never its name.
 *
 * Last, a structural fence: every string in the verification is one of its fixed enums. A
 * value, a fingerprint or a path cannot be carried by a field that only holds enums.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../commands/scan.js";
import type { AgentSource } from "../core/types.js";
import {
  FIXTURE_CHECKS,
  RAN_EVIDENCE,
  RUN_STATES,
  SECRET_CLASSES,
  SECRET_KINDS,
  SECRET_PROVENANCES,
  VERIFY_CATEGORIES,
  VERIFY_STATUSES,
} from "../core/verify/types.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { createRealVerifyIO } from "../verify-io.js";
import { decodedSurfaces, stringLeaves } from "./html-text.js";
import { RULE_RM_RF } from "./scan-fixtures.js";
import { type SessionEvent, writeCorpus } from "./verify-fixtures.js";

// Each canary carries a greppable marker and is assembled at runtime, never written whole.
const CANARIES = {
  prompt: `ghp${"_"}CANARYprompt0aB1cD2eF3gH4iJ5kL6mN7oP8`,
  typed: `CANARYtyped${"9Xq2Lw7Rv4"}`,
  printed: `AKIA${"CANARYPRNT234567"}`,
  reply: `xoxb${"-"}CANARYreply-90817263`,
  fixture: `CANARYfixture${"8Hd2Kq7Lm"}`,
} as const;

/** The environment-variable names the canaries are given. None may appear in any output. */
const NAMES = ["ZEBRAFISH_TOKEN", "ZEBRAFISH_FIXTURE_TOKEN"] as const;

const MARKERS = ["CANARY", ...NAMES, "zebrafish"];

/** The sessions, the same for every app. One call matches a guardrail so the report has rows. */
const EVENTS: SessionEvent[] = [
  { kind: "prompt", text: `here is the token ${CANARIES.prompt}` },
  { kind: "call", command: `export ZEBRAFISH_TOKEN=${CANARIES.typed}`, result: { text: "" } },
  {
    kind: "call",
    command: "cat ~/.aws/config",
    result: { text: `aws_access_key_id = ${CANARIES.printed}` },
  },
  { kind: "reply", text: `I used ${CANARIES.reply} for the bot.` },
  {
    kind: "call",
    command: `ZEBRAFISH_FIXTURE_TOKEN=${CANARIES.fixture} make check`,
    result: { text: "" },
  },
  { kind: "call", command: "rm -rf build", result: { text: "" } },
];

/** A temporary repo whose tracked file holds the fixture canary. */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "agenttrail-verify-canary-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "fixture.env"), `ZEBRAFISH_FIXTURE_TOKEN=${CANARIES.fixture}\n`);
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

/** One in-process run of `scan`, over real files, with what it wrote and printed. */
async function scan(
  argv: readonly string[],
  work: string,
  answer?: string,
): Promise<{ code: number; stdout: string; written: Map<string, string> }> {
  const real = createRealScanIO();
  const out: string[] = [];
  const written = new Map<string, string>();
  const io: ScanIO = {
    ...real,
    homedir: () => mkdtempSync(join(tmpdir(), "agenttrail-verify-home-")),
    cwd: () => work,
    writeStdout: (text) => {
      out.push(text);
    },
    readLine: () => Promise.resolve(answer),
    writeFile: (path, text) => {
      written.set(path, text);
      return true;
    },
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  const code = await runScan(argv, io, {
    catalog: [RULE_RM_RF],
    now: new Date("2026-10-01T00:00:00.000Z"),
    createVerifyIO: () => createRealVerifyIO(),
  });
  return { code, stdout: out.join(""), written };
}

/** Every string in a value: its keys and its leaves. */
const leaves = (value: unknown): string[] => stringLeaves(value);

/** Every string the verification may hold: its enums, its category names and its keys. */
const ALLOWED = new Set<string>([
  ...VERIFY_CATEGORIES,
  ...SECRET_CLASSES,
  ...SECRET_KINDS,
  ...SECRET_PROVENANCES,
  ...RUN_STATES,
  ...RAN_EVIDENCE,
  ...VERIFY_STATUSES,
  ...FIXTURE_CHECKS,
  // Keys.
  "matchedCalls",
  "resultsRecorded",
  "ranEvidence",
  "categories",
  "status",
  "matches",
  "facts",
  "classes",
  "items",
  "moreItems",
  "filesRead",
  "filesNotRead",
  "unplaced",
  "setAside",
  "unnamedOutputOnly",
  "namedNotCredentialShaped",
  "fixtureCheck",
  "reposChecked",
  "reposNotChecked",
  "kind",
  "via",
  "files",
]);

describe.each([
  "claude",
  "codex",
  "cursor",
] as const)("%s: no value leaves --verify", (agent: AgentSource) => {
  const repo = fixtureRepo();
  const work = mkdtempSync(join(tmpdir(), "agenttrail-verify-work-"));
  const written = writeCorpus(agent, [EVENTS, [{ kind: "prompt", text: CANARIES.prompt }]], {
    cwd: repo,
  });

  it("health: every canary is in the transcript files, and the check found them", async () => {
    const { root, corpus } = await written;
    const raw = (corpus.files ?? []).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const [where, value] of Object.entries(CANARIES)) {
      // Cursor records no tool output, so nothing printed is in its files.
      if (agent === "cursor" && where === "printed") expect(raw).not.toContain(value);
      else expect(raw).toContain(value);
    }
    for (const name of NAMES) expect(raw).toContain(name);

    const { stdout } = await scan(["--agent", agent, "--dir", root, "--verify", "--json"], work);
    const verification = JSON.parse(stdout).result.verification;
    const facts = verification.categories.secrets.facts;
    // Cursor has no printed canary, and names no repo, so its fixture canary stays likely real:
    // four either way.
    expect(facts.classes["likely-real"]).toBe(4);
    // Codex and Claude Code name the repo; Cursor's files name no working directory.
    expect(facts.classes["committed-fixture"]).toBe(agent === "cursor" ? 0 : 1);
    expect(verification.matchedCalls.ran + verification.matchedCalls.unknown).toBe(1);
  });

  it("no canary and no name reaches --json", async () => {
    const { root } = await written;
    const { stdout } = await scan(["--agent", agent, "--dir", root, "--verify", "--json"], work);
    for (const marker of MARKERS) expect(stdout.toLowerCase()).not.toContain(marker.toLowerCase());
    for (const text of leaves(JSON.parse(stdout))) {
      for (const marker of MARKERS) expect(text.toLowerCase()).not.toContain(marker.toLowerCase());
    }
  });

  it("no canary and no name reaches the report in any decoded form, either variant", async () => {
    const { root } = await written;
    for (const variant of [[], ["--artifact"]]) {
      const out = join(work, `report-${variant.length}.html`);
      const run = await scan(
        ["--agent", agent, "--dir", root, "--verify", "--out", out, ...variant],
        work,
      );
      expect(run.code).toBe(0);
      const html = run.written.get(out) ?? "";
      expect(html.length).toBeGreaterThan(1000);
      for (const [surface, text] of Object.entries({ raw: html, ...decodedSurfaces(html) })) {
        for (const marker of MARKERS) {
          expect(text.toLowerCase(), `${marker} in ${surface}`).not.toContain(marker.toLowerCase());
        }
      }
      for (const marker of MARKERS) {
        expect(run.stdout.toLowerCase()).not.toContain(marker.toLowerCase());
      }
    }
  });

  it("the data block carries the verification, so the check above searched it", async () => {
    const { root } = await written;
    const out = join(work, "with-data.html");
    const run = await scan(["--agent", agent, "--dir", root, "--verify", "--out", out], work);
    expect(decodedSurfaces(run.written.get(out) ?? "").data).toContain("likely-real");
  });

  it("no canary and no name reaches --review or the summary", async () => {
    const { root } = await written;
    const run = await scan(["--agent", agent, "--dir", root, "--verify", "--review"], work, "y");
    expect(run.stdout).toContain("Checked on this machine (read-only, offline)");
    for (const marker of MARKERS) {
      expect(run.stdout.toLowerCase()).not.toContain(marker.toLowerCase());
    }
  });

  it("every string in the verification is one of its fixed enums", async () => {
    const { root } = await written;
    const { stdout } = await scan(["--agent", agent, "--dir", root, "--verify", "--json"], work);
    const strings = leaves(JSON.parse(stdout).result.verification);
    expect(strings.length).toBeGreaterThan(20);
    expect(strings.filter((s) => !ALLOWED.has(s))).toEqual([]);
  });

  it("writes nothing: no log, no file in the repo, no file in the working folder", async () => {
    const { root } = await written;
    const before = readdirSync(repo).sort();
    const index = statSync(join(repo, ".git", "index")).mtimeMs;
    const { written: files } = await scan(
      ["--agent", agent, "--dir", root, "--verify", "--json"],
      work,
    );
    expect(files.size).toBe(0);
    expect(readdirSync(repo).sort()).toEqual(before);
    // No index refresh was written.
    expect(statSync(join(repo, ".git", "index")).mtimeMs).toBe(index);
    expect(readdirSync(work).filter((f) => statSync(join(work, f)).isFile())).toEqual([]);
  });
});

describe("negative control — the search finds a planted value", () => {
  it("a canary written into the output is found by the same checks", () => {
    const html = `<p>${CANARIES.typed}</p><script type="application/json" id="report-data">{"x":"${CANARIES.fixture}"}</script>`;
    const surfaces = decodedSurfaces(html);
    expect(surfaces.text).toContain("CANARY");
    expect(surfaces.data).toContain("CANARY");
  });

  it("a value would be outside the fence", () => {
    expect(ALLOWED.has(CANARIES.typed)).toBe(false);
    expect(ALLOWED.has("0123456789abcdef0123456789abcdef")).toBe(false);
  });
});
