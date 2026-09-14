/**
 * The local crash spool — bounded, `0600`, and never fatal.
 *
 * Runs against the REAL `createRealIO` in a temp `HOME`, not a fake filesystem: the
 * atomic-write path (temp file + rename + chmod) is the part most likely to be wrong,
 * and a fake would assert the design rather than the behavior.
 */

import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CrashRecord } from "../core/crash-record.js";
import {
  clearSpool,
  deleteSpooled,
  MAX_AGE_MS,
  MAX_SPOOLED,
  pruneSpool,
  readSpool,
  spoolCrash,
} from "../core/crash-store.js";
import { crashesDir } from "../core/paths.js";
import { createRealIO, type GuardIO } from "../io.js";

let home: string;
let io: GuardIO;

const NOW = 1_800_000_000_000;

function record(name = "TypeError"): CrashRecord {
  return {
    v: 1,
    ts: new Date(NOW).toISOString(),
    guardVersion: "0.1.0",
    nodeVersion: "v20.0.0",
    platform: "linux",
    command: "hook",
    errorName: name,
    frames: "    at f (cli.js:1:1)",
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "guard-spool-"));
  const real = createRealIO();
  io = { ...real, homedir: () => home };
});

describe("writing", () => {
  it("creates the spool directory and writes a readable record", () => {
    expect(spoolCrash(io, record(), NOW)).toBe(true);
    const back = readSpool(io);
    expect(back).toHaveLength(1);
    expect(back[0]?.record.errorName).toBe("TypeError");
  });

  it("writes mode 0600 — these are the user's files", () => {
    spoolCrash(io, record(), NOW);
    const dir = crashesDir(home);
    const file = join(dir, readdirSync(dir)[0] as string);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", () => {
    spoolCrash(io, record(), NOW);
    expect(readdirSync(crashesDir(home)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("returns false rather than throwing when the spool cannot be created", () => {
    const broken: GuardIO = { ...io, mkdirp: () => false };
    expect(spoolCrash(broken, record(), NOW)).toBe(false);
  });

  it("returns false rather than throwing when the write fails", () => {
    const broken: GuardIO = { ...io, writeFileAtomic: () => false };
    expect(spoolCrash(broken, record(), NOW)).toBe(false);
  });
});

describe("bounds — applied on every write, not on a timer", () => {
  it(`keeps at most ${MAX_SPOOLED}, evicting oldest first`, () => {
    for (let i = 0; i < MAX_SPOOLED + 5; i += 1) {
      spoolCrash(io, record(`E${i}`), NOW + i);
    }
    const back = readSpool(io);
    expect(back).toHaveLength(MAX_SPOOLED);
    // The five oldest are the ones gone.
    expect(back.map((b) => b.record.errorName)).not.toContain("E0");
    expect(back.map((b) => b.record.errorName)).toContain(`E${MAX_SPOOLED + 4}`);
  });

  it("drops anything past the age bound", () => {
    spoolCrash(io, record("old"), NOW - MAX_AGE_MS - 1);
    spoolCrash(io, record("new"), NOW);
    pruneSpool(io, NOW);
    expect(readSpool(io).map((b) => b.record.errorName)).toEqual(["new"]);
  });
});

describe("reading is defensive — one bad file must not block the rest", () => {
  beforeEach(() => mkdirSync(crashesDir(home), { recursive: true }));

  it.each([
    ["not JSON", "{{{"],
    ["JSON that is not an object", "[1,2,3]"],
    ["an object missing required fields", '{"hello":"world"}'],
    ["an empty file", ""],
  ])("skips %s and still returns the good record", (_label, bad) => {
    writeFileSync(join(crashesDir(home), `crash-${NOW}-aaaaaaaa.json`), bad);
    spoolCrash(io, record("good"), NOW + 1);
    expect(readSpool(io).map((b) => b.record.errorName)).toEqual(["good"]);
  });

  it("ignores files that are not ours", () => {
    writeFileSync(join(crashesDir(home), "notes.txt"), "hello");
    writeFileSync(join(crashesDir(home), "crash-nonsense.json"), "{}");
    spoolCrash(io, record("ours"), NOW);
    expect(readSpool(io)).toHaveLength(1);
  });

  it("returns [] when the directory does not exist at all", () => {
    const fresh = mkdtempSync(join(tmpdir(), "guard-empty-"));
    expect(readSpool({ ...io, homedir: () => fresh })).toEqual([]);
  });
});

describe("deleting", () => {
  it("removes one spooled crash by name", () => {
    spoolCrash(io, record(), NOW);
    const name = readSpool(io)[0]?.name as string;
    expect(deleteSpooled(io, name)).toBe(true);
    expect(readSpool(io)).toEqual([]);
  });

  it("refuses to delete a foreign filename", () => {
    // `--send` and `--clear` both walk names off disk, but the guard is cheap and
    // the failure mode — deleting something we did not write — is not.
    mkdirSync(crashesDir(home), { recursive: true });
    writeFileSync(join(crashesDir(home), "important.txt"), "x");
    expect(deleteSpooled(io, "important.txt")).toBe(false);
    expect(deleteSpooled(io, "../../../etc/passwd")).toBe(false);
  });

  it("clearSpool removes only our files and reports the count", () => {
    mkdirSync(crashesDir(home), { recursive: true });
    writeFileSync(join(crashesDir(home), "keep-me.txt"), "x");
    spoolCrash(io, record(), NOW);
    spoolCrash(io, record(), NOW + 1);
    expect(clearSpool(io)).toBe(2);
    expect(readdirSync(crashesDir(home))).toEqual(["keep-me.txt"]);
  });
});
