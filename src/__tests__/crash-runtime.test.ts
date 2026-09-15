/**
 * The RELEASED BYTES make no network call — including while crashing.
 *
 * ── What this test is, and what it is not ───────────────────────────────────
 * **A runtime trial is evidence about one execution; the fence is a statement about
 * all of them.** The guarantee that `hook` cannot reach the network comes from
 * `no-network.test.ts`, which proves over every reachable module, with a parser, that
 * `src/net/**` is absent from the hook's import graph. This file corroborates that on
 * the real artifacts. It does not replace it.
 *
 * **Do not delete the static fence because "we test it at runtime now."** This suite
 * would pass on a build where the sender sat one un-taken branch away from the hook
 * path; the fence could not. If you are here because the fence feels redundant, that
 * is the redundancy working.
 *
 * ── Nothing in the shipped binary can be told to fail ───────────────────────
 * The fault is injected by `preload/net-recorder.mjs`, a test file the user never
 * receives, loaded with `--import` before the bundle. The released binary contains no
 * `AGENTTRAIL_GUARD_FORCE_CRASH` and no lever of any kind, because a switch that
 * makes the guard fail on command is a way to turn the guard off.
 *
 * The fault is a patched `JSON.parse`, which is **artificial** — say so plainly. It
 * proves the real bytes, crashing for real, write no packet; it does not prove that a
 * naturally-arising crash takes the same path. The hook is deliberately built so that
 * no input produces an uncaught throw (that is what the fail-open suite asserts),
 * which is precisely why a natural one cannot be produced from outside.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const HOOK_BUNDLE = join(PKG_ROOT, "plugin", "scripts", "guard-hook.mjs");
const CLI_BUNDLE = join(PKG_ROOT, "dist", "cli.js");
const PRELOAD = join(HERE, "preload", "net-recorder.mjs");
const TSUP_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsup");

beforeAll(() => {
  execFileSync(TSUP_BIN, [], { cwd: PKG_ROOT, stdio: "pipe" });
}, 180_000);

/** Run a bundle under the recorder. Returns its result plus anything recorded. */
function runRecorded(
  bundle: string,
  args: readonly string[],
  input: string,
  opts: { fault?: boolean; home?: string } = {},
): { status: number | null; stdout: string; stderr: string; net: string } {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "guard-rt-home-"));
  const log = join(mkdtempSync(join(tmpdir(), "guard-rt-log-")), "net.log");
  writeFileSync(log, "");
  const r = spawnSync("node", ["--import", PRELOAD, bundle, ...args], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTTRAIL_TEST_NET_LOG: log,
      ...(opts.fault === true ? { AGENTTRAIL_TEST_FAULT: "1" } : {}),
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, net: readFileSync(log, "utf8") };
}

describe("the preload itself works — otherwise every assertion below is vacuous", () => {
  it("records and blocks a fetch made by an ordinary script", () => {
    const script = join(mkdtempSync(join(tmpdir(), "guard-rt-probe-")), "probe.mjs");
    writeFileSync(script, `try { await fetch("https://example.test"); } catch {}\n`);
    const r = runRecorded(script, [], "");
    expect(r.net).toContain("fetch https://example.test");
  });

  it("the fault injector actually makes JSON.parse throw", () => {
    const script = join(mkdtempSync(join(tmpdir(), "guard-rt-probe2-")), "probe.mjs");
    writeFileSync(
      script,
      `try { JSON.parse("{}"); console.log("NO-THROW"); } catch { console.log("THREW"); }\n`,
    );
    expect(runRecorded(script, [], "", { fault: true }).stdout.trim()).toBe("THREW");
  });
});

describe("the hook bundle — the file Claude Code runs on every tool call", () => {
  const inputs = [
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/a/.env" } }),
    "not json at all",
    "",
    "[]",
  ];

  it.each(inputs)("makes no network call for: %s", (input) => {
    const r = runRecorded(HOOK_BUNDLE, [], input);
    expect(r.net).toBe("");
    expect(r.status).toBe(0);
  });

  it("makes no network call WHILE CRASHING, on a fresh install with no config", () => {
    // The case the whole feature is about: a crash, on a machine that has never
    // configured anything, in the released bytes.
    const r = runRecorded(HOOK_BUNDLE, [], inputs[0] as string, { fault: true });
    expect(r.net).toBe("");
    expect(r.status).toBe(0);
  });

  it("still emits one message and no decision while crashing — fail-open holds", () => {
    const r = runRecorded(HOOK_BUNDLE, [], inputs[0] as string, { fault: true });
    const trimmed = r.stdout.trim();
    expect(trimmed.startsWith("{")).toBe(true);
    expect(trimmed.endsWith("}")).toBe(true);
    expect(JSON.parse(trimmed)).toEqual({
      systemMessage: expect.stringContaining("could not evaluate this action"),
    });
    expect(r.stderr).toBe("");
  });

  it("spools the crash locally — capture works in the shipped bundle", () => {
    // The specific thing the module-layer test cannot see: that `tsup` did not
    // mangle the capture path on its way into the bundle.
    const home = mkdtempSync(join(tmpdir(), "guard-rt-spool-"));
    const r = runRecorded(HOOK_BUNDLE, [], inputs[0] as string, { fault: true, home });
    expect(r.net).toBe("");
    const dir = join(home, ".agenttrail", "guard", "crashes");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("the CLI bundle — which DOES contain the one fetch", () => {
  it("`hook` through the CLI makes no network call, crashing or not", () => {
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    expect(runRecorded(CLI_BUNDLE, ["hook"], payload).net).toBe("");
    expect(runRecorded(CLI_BUNDLE, ["hook"], payload, { fault: true }).net).toBe("");
  });

  it("`crash-report --send` on a fresh install makes no network call", () => {
    // Off by default, end to end, against the real binary.
    const r = runRecorded(CLI_BUNDLE, ["crash-report", "--send"], "");
    expect(r.net).toBe("");
    expect(r.stdout).toContain("Crash reporting is off");
  });

  it("`crash-report --send`, enabled but unconfigured, still makes none", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-rt-cfg-"));
    execFileSync("node", [CLI_BUNDLE, "crash-report", "--enable"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: "pipe",
    });
    const r = runRecorded(CLI_BUNDLE, ["crash-report", "--send"], "", { home });
    expect(r.net).toBe("");
    expect(r.stdout).toContain("No crash-report endpoint configured");
  });

  it("but WOULD call when enabled and pointed somewhere — the positive control", () => {
    // Without this, every assertion above would also pass on a build where the
    // sender had silently stopped working.
    const home = mkdtempSync(join(tmpdir(), "guard-rt-pos-"));
    execFileSync("node", [CLI_BUNDLE, "crash-report", "--enable"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: "pipe",
    });
    // Produce a spooled crash to send.
    runRecorded(HOOK_BUNDLE, [], "{bad", { fault: true, home });
    const r = runRecorded(
      CLI_BUNDLE,
      ["crash-report", "--send", "--endpoint", "https://crash.test/v1"],
      "",
      {
        home,
      },
    );
    expect(r.net).toContain("fetch https://crash.test/v1");
  });
});
