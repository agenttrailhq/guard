/**
 * `crash-report` — the only transmitter, and the gates on it.
 *
 * ── The two assertions this file exists for ─────────────────────────────────
 * 1. **Off means off.** A fresh install with no config, and an install with a crash
 *    already spooled, both send nothing. The `fetch` double is a spy that FAILS the
 *    test if it is ever called, rather than one that quietly records — a spy you have
 *    to remember to assert on is a spy that eventually is not asserted on.
 * 2. **No endpoint means no call.** The source carries no default endpoint and no
 *    placeholder URL.
 *
 * Both gates — `config.crashReports` at the call site and `enabled` inside
 * `sendCrashRecord` — are exercised INDEPENDENTLY, so a mutation that removes either
 * one alone goes red. A single test covering both would pass with one deleted.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCrashReport } from "../commands/crash-report.js";
import type { CrashRecord } from "../core/crash-record.js";
import { spoolCrash } from "../core/crash-store.js";
import { configPath, guardDir } from "../core/paths.js";
import { createRealIO, type GuardIO } from "../io.js";
import { resolveEndpoint, sendCrashRecord } from "../net/crash-transport.js";

let home: string;
let out: string[];
let io: GuardIO;

/** A fetch double that fails the test if it is ever called. */
const forbiddenFetch = vi.fn(async () => {
  throw new Error("network call attempted — the whole point is that this cannot happen");
});

const okFetch = vi.fn(async () => ({ ok: true, status: 200 }));

const RECORD: CrashRecord = {
  v: 1,
  ts: "2026-09-07T12:00:00.000Z",
  guardVersion: "0.1.0",
  nodeVersion: "v20.0.0",
  platform: "linux",
  command: "hook",
  errorName: "TypeError",
  frames: "    at f (cli.js:1:1)",
};

function writeConfig(obj: Record<string, unknown>): void {
  mkdirSync(guardDir(home), { recursive: true });
  writeFileSync(configPath(home), JSON.stringify(obj));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "guard-cr-"));
  out = [];
  const real = createRealIO();
  io = { ...real, homedir: () => home, writeStdout: (t) => void out.push(t) };
  forbiddenFetch.mockClear();
  okFetch.mockClear();
});

describe("off by default — a fresh install sends nothing", () => {
  it("--send on a fresh install with no config makes no call", async () => {
    const code = await runCrashReport(["--send"], io, { fetchImpl: forbiddenFetch, env: {} });
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(code).toBe(1);
    expect(out.join("")).toContain("Crash reporting is off");
  });

  it("--send with a crash ALREADY SPOOLED still makes no call", async () => {
    // The case that matters: having something to send is exactly when a missing
    // gate would show up, and a test with an empty spool would pass without one.
    spoolCrash(io, RECORD, Date.now());
    const code = await runCrashReport(["--send"], io, { fetchImpl: forbiddenFetch, env: {} });
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(code).toBe(1);
  });

  it("the spool is left intact after a refusal", async () => {
    spoolCrash(io, RECORD, Date.now());
    await runCrashReport(["--send"], io, { fetchImpl: forbiddenFetch, env: {} });
    out = [];
    const status = await runCrashReport([], io, {});
    expect(out.join("")).toContain("Spooled locally: 1");
    expect(status).toBe(0);
  });

  it("an explicitly enabled config with an endpoint present is what it takes", async () => {
    // The positive control. Without it, every assertion above would also pass on a
    // build where sending was broken outright.
    writeConfig({ crashReports: true, crashEndpoint: "https://crash.example/v1" });
    spoolCrash(io, RECORD, Date.now());
    const code = await runCrashReport(["--send"], io, { fetchImpl: okFetch, env: {} });
    expect(okFetch).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });
});

describe("no endpoint means no call — the shipped state", () => {
  it("enabled but unconfigured refuses by name and does not call", async () => {
    writeConfig({ crashReports: true });
    spoolCrash(io, RECORD, Date.now());
    const code = await runCrashReport(["--send"], io, { fetchImpl: forbiddenFetch, env: {} });
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(code).toBe(1);
    expect(out.join("")).toContain("No crash-report endpoint configured");
  });

  it("resolves --endpoint, then env, then config, then nothing", () => {
    expect(resolveEndpoint("https://a.test", "https://b.test", "https://c.test")).toBe(
      "https://a.test",
    );
    expect(resolveEndpoint(undefined, "https://b.test", "https://c.test")).toBe("https://b.test");
    expect(resolveEndpoint(undefined, undefined, "https://c.test")).toBe("https://c.test");
    expect(resolveEndpoint(undefined, undefined, undefined)).toBeUndefined();
  });

  it("refuses a non-http scheme rather than treating it as a destination", () => {
    // A `file:` URL in a config file must not become a write primitive.
    expect(resolveEndpoint("file:///etc/passwd", undefined, undefined)).toBeUndefined();
    expect(resolveEndpoint("data:text/plain,x", undefined, undefined)).toBeUndefined();
    expect(resolveEndpoint("not a url", undefined, undefined)).toBeUndefined();
    expect(resolveEndpoint("", undefined, undefined)).toBeUndefined();
  });

  it("takes the endpoint from the env var", async () => {
    writeConfig({ crashReports: true });
    spoolCrash(io, RECORD, Date.now());
    await runCrashReport(["--send"], io, {
      fetchImpl: okFetch,
      env: { AGENTTRAIL_GUARD_CRASH_ENDPOINT: "https://crash.example/v1" },
    });
    expect(okFetch).toHaveBeenCalledTimes(1);
  });
});

describe("the transport's own gate is independent of the call site's", () => {
  // Both guards are exercised alone, so a mutation removing either one goes red.
  it("sendCrashRecord refuses when disabled, even with an endpoint", async () => {
    const r = await sendCrashRecord(RECORD, {
      enabled: false,
      endpoint: "https://crash.example/v1",
      fetchImpl: forbiddenFetch,
    });
    expect(r).toEqual({ kind: "disabled" });
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it("sendCrashRecord refuses with no endpoint, even when enabled", async () => {
    const r = await sendCrashRecord(RECORD, {
      enabled: true,
      endpoint: undefined,
      fetchImpl: forbiddenFetch,
    });
    expect(r).toEqual({ kind: "no-endpoint" });
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it("posts JSON with the record as the body when both hold", async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200 }));
    await sendCrashRecord(RECORD, {
      enabled: true,
      endpoint: "https://crash.example/v1",
      fetchImpl: spy,
    });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crash.example/v1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(RECORD);
  });

  it("a non-ok response is a failure, not a silent success", async () => {
    const r = await sendCrashRecord(RECORD, {
      enabled: true,
      endpoint: "https://crash.example/v1",
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    expect(r).toEqual({ kind: "failed", detail: "HTTP 503" });
  });

  it("a throwing transport is a normal outcome, not an exception", async () => {
    const r = await sendCrashRecord(RECORD, {
      enabled: true,
      endpoint: "https://crash.example/v1",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(r.kind).toBe("failed");
  });
});

describe("send leaves the spool consistent", () => {
  it("deletes each record only after its own successful post", async () => {
    writeConfig({ crashReports: true, crashEndpoint: "https://crash.example/v1" });
    spoolCrash(io, RECORD, Date.now());
    spoolCrash(io, RECORD, Date.now() + 1);
    await runCrashReport(["--send"], io, { fetchImpl: okFetch, env: {} });
    await runCrashReport([], io, {});
    expect(out.join("")).toContain("Spooled locally: 0");
  });

  it("stops at the first failure and keeps the rest on disk", async () => {
    writeConfig({ crashReports: true, crashEndpoint: "https://crash.example/v1" });
    spoolCrash(io, RECORD, Date.now());
    spoolCrash(io, RECORD, Date.now() + 1);
    let n = 0;
    const flaky = vi.fn(async () => {
      n += 1;
      return { ok: n === 1, status: n === 1 ? 200 : 500 };
    });
    const code = await runCrashReport(["--send"], io, { fetchImpl: flaky, env: {} });
    expect(code).toBe(1);
    out = [];
    await runCrashReport([], io, {});
    expect(out.join("")).toContain("Spooled locally: 1");
  });
});

describe("enable / disable / clear / status", () => {
  it("--enable writes the flag and --disable clears it", async () => {
    await runCrashReport(["--enable"], io, {});
    expect(JSON.parse(readFileSync(configPath(home), "utf8")).crashReports).toBe(true);
    await runCrashReport(["--disable"], io, {});
    expect(JSON.parse(readFileSync(configPath(home), "utf8")).crashReports).toBe(false);
  });

  it("--enable preserves keys it does not own, including ones the parser drops", async () => {
    // `parseConfig` does not read `version`, so round-tripping through
    // it would silently delete the field. The raw object is edited instead.
    writeConfig({ version: 1, failOpen: false, disabledPacks: ["working-tree"] });
    await runCrashReport(["--enable"], io, {});
    const back = JSON.parse(readFileSync(configPath(home), "utf8"));
    expect(back.version).toBe(1);
    expect(back.failOpen).toBe(false);
    expect(back.disabledPacks).toEqual(["working-tree"]);
    expect(back.crashReports).toBe(true);
  });

  it("--enable on a corrupt config replaces it rather than refusing", async () => {
    mkdirSync(guardDir(home), { recursive: true });
    writeFileSync(configPath(home), "{{{ not json");
    expect(await runCrashReport(["--enable"], io, {})).toBe(0);
    expect(JSON.parse(readFileSync(configPath(home), "utf8")).crashReports).toBe(true);
  });

  it("--clear empties the spool and says how many", async () => {
    spoolCrash(io, RECORD, Date.now());
    await runCrashReport(["--clear"], io, {});
    expect(out.join("")).toContain("Deleted 1");
  });

  it("status is the default and states the guarantee in both halves", async () => {
    const code = await runCrashReport([], io, {});
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toContain("OFF (default)");
    expect(text).toContain("Stack traces only");
    expect(text).toContain("explicit `--send`");
    // The second requirement `--send` has: an endpoint, which no default install carries.
    expect(text).toContain("Send endpoint: none configured");
    expect(text).toContain("none ships by default");
  });

  it("reports a write failure rather than claiming success", async () => {
    const broken: GuardIO = { ...io, writeFileAtomic: () => false };
    expect(await runCrashReport(["--enable"], broken, {})).toBe(1);
    expect(out.join("")).toContain("could not write");
  });
});

describe("send with an empty spool, and flag parsing", () => {
  it("reports there is nothing to send rather than calling", async () => {
    writeConfig({ crashReports: true, crashEndpoint: "https://crash.example/v1" });
    const code = await runCrashReport(["--send"], io, { fetchImpl: forbiddenFetch, env: {} });
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(code).toBe(0);
    expect(out.join("")).toContain("No crash reports to send");
  });

  it("`--endpoint` with no value, or followed by another flag, is not a value", async () => {
    // Otherwise `--send --endpoint --clear` would post to the string "--clear".
    writeConfig({ crashReports: true });
    spoolCrash(io, RECORD, Date.now());
    expect(
      await runCrashReport(["--send", "--endpoint"], io, { fetchImpl: forbiddenFetch, env: {} }),
    ).toBe(1);
    out = [];
    // A following flag is not a value either — otherwise `--endpoint --json` would
    // post to the literal string "--json".
    expect(
      await runCrashReport(["--send", "--endpoint", "--json"], io, {
        fetchImpl: forbiddenFetch,
        env: {},
      }),
    ).toBe(1);
    expect(out.join("")).toContain("No crash-report endpoint configured");
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it("refuses two modes at once rather than silently picking one", async () => {
    // Found while testing flag parsing: `--clear` was checked before `--send`, so
    // `--send --clear` destroyed the spool and reported success without sending.
    // One transmits and one destroys; a user who typed both did not mean either.
    writeConfig({ crashReports: true, crashEndpoint: "https://crash.example/v1" });
    spoolCrash(io, RECORD, Date.now());
    const code = await runCrashReport(["--send", "--clear"], io, {
      fetchImpl: forbiddenFetch,
      env: {},
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("pick one of");
    expect(forbiddenFetch).not.toHaveBeenCalled();
    // And the spool is untouched by the refusal.
    out = [];
    await runCrashReport([], io, {});
    expect(out.join("")).toContain("Spooled locally: 1");
  });

  it("falls back to process.env when no env is injected", async () => {
    // The `deps.env ?? process.env` branch, which every other test bypasses.
    writeConfig({ crashReports: true });
    spoolCrash(io, RECORD, Date.now());
    const prev = process.env.AGENTTRAIL_GUARD_CRASH_ENDPOINT;
    process.env.AGENTTRAIL_GUARD_CRASH_ENDPOINT = "https://crash.example/v1";
    try {
      await runCrashReport(["--send"], io, { fetchImpl: okFetch });
      expect(okFetch).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.AGENTTRAIL_GUARD_CRASH_ENDPOINT;
      else process.env.AGENTTRAIL_GUARD_CRASH_ENDPOINT = prev;
    }
  });
});
