// cspell:words devpass
/**
 * `scan --scrub` end to end: synthetic transcripts for all three apps written to a temporary
 * folder, a temporary home for the backups, a temporary git repo for the committed-fixture
 * test, and the real `ScrubIO`.
 *
 * Every credential-shaped string is assembled at runtime from parts, never written whole as a
 * source literal; none of them is real. The running-process list is always faked, so the
 * tests do not depend on what runs on the machine that runs them.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseScanFlags, runScan, SCAN_USAGE } from "../commands/scan.js";
import {
  agentProcessCheck,
  backupFolderName,
  isRecentlyModified,
  PROCESS_NAME_GAP,
  RECENT_WRITE_WINDOW_MS,
  restoreCommand,
  runScrub,
  scrubBackupsRoot,
} from "../commands/scan-scrub.js";
import { scrubPlaceholder, sha256 } from "../core/scrub-transcripts.js";
import type { AgentSource } from "../core/types.js";
import { type VerifyIO, WATCHED_PROCESSES, type WatchedProcess } from "../core/verify/types.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { createRealScrubIO, type ScrubIO } from "../scrub-io.js";
import { createRealVerifyIO, watchedProcessOf } from "../verify-io.js";
import { type SessionEvent, writeCorpus } from "./verify-fixtures.js";

// ── Synthetic values, assembled at runtime ──────────────────────────────────────
const GITHUB = `ghp${"_"}Wn4Lx8Qz2Rk7Tm1Vp5Bc9Hd3Fj6Sa0Ye2Gu7`;
const AWS_ID = `AKIA${"M4XN8QZ2R7KT1VPB"}`;
const DEPLOY = `p7Hc2Wq9${"Nz4Lk8Rv"}`;
const SLACK = `xoxb${"-"}2718281828-QwErTy12AsDf`;
const FIXTURE = `fx2Qm8Lz5${"Np7Kd3Rw9T"}`;
const PLACEHOLDER = "your-api-token-here";
const LOCAL_URL = `postgres://app:${"devpass319"}@localhost:5432/app`;

/** The values that must be replaced, and those that must be left alone. */
const LIKELY_REAL = [GITHUB, AWS_ID, DEPLOY, SLACK];
const LEFT_ALONE = [FIXTURE, PLACEHOLDER, LOCAL_URL];

/**
 * What each app's run must replace and leave. Cursor's session files name no working folder, so
 * no repo can be searched and the committed fixture counts as likely real there.
 */
function expected(agent: AgentSource): { replace: string[]; leave: string[] } {
  return agent === "cursor"
    ? { replace: [...LIKELY_REAL, FIXTURE], leave: [PLACEHOLDER, LOCAL_URL] }
    : { replace: LIKELY_REAL, leave: LEFT_ALONE };
}

/** Every form a value could be printed in. */
function forms(value: string): string[] {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)];
}

/** A temporary git repo with `files` in its index. */
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agenttrail-scrub-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const REPO = repoWith({ "test/fixtures/service.json": JSON.stringify({ SERVICE_TOKEN: FIXTURE }) });

/** One session holding every class of value, in every place a value can sit. */
const SESSION: SessionEvent[] = [
  { kind: "prompt", text: `use this one ${GITHUB}` },
  {
    kind: "call",
    command: "cat ~/.aws/credentials",
    result: { text: `aws_access_key_id = ${AWS_ID}` },
  },
  { kind: "call", command: `export DEPLOY_TOKEN=${DEPLOY}`, result: { text: "" } },
  { kind: "reply", text: `The bot token is ${SLACK}.` },
  { kind: "call", command: `SERVICE_TOKEN=${FIXTURE} pnpm test`, result: { text: "ok" } },
  { kind: "call", command: `export API_TOKEN=${PLACEHOLDER}`, result: { text: "" } },
  { kind: "call", command: `psql ${LOCAL_URL}`, result: { text: "" } },
  { kind: "prompt", text: `once more ${GITHUB}` },
];

/** A second session, so a run covers more than one file. */
const SECOND: SessionEvent[] = [
  { kind: "prompt", text: "hello" },
  { kind: "reply", text: `again ${GITHUB}` },
];

/** An hour ago, so no file counts as recently changed. */
const OLD = (Date.now() - 60 * 60 * 1000) / 1000;

/** Every `.jsonl` file under `root`. */
function transcriptFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

/** Every file under `root`, by path, with its bytes. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(root);
  return out;
}

/**
 * A process list of `names`, read the way the real seam reads them (`watchedProcessOf`), or one
 * that cannot be read. By default it holds no agent.
 */
function processes(names: readonly string[] | "unreadable" = ["zsh", "node"]): VerifyIO {
  const real = createRealVerifyIO();
  const running = WATCHED_PROCESSES.filter((id) =>
    names === "unreadable" ? false : names.some((name) => watchedProcessOf(name) === id),
  );
  return {
    ...real,
    processNames: () =>
      Promise.resolve(
        names === "unreadable" ? { ok: false, reason: "failed" } : { ok: true, running },
      ),
  };
}

/** A `ScrubIO` that records every write call. */
function recording(base: ScrubIO = createRealScrubIO()): { io: ScrubIO; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    io: {
      read: (path) => base.read(path),
      createBackupDir: (root, name) => {
        writes.push("createBackupDir");
        return base.createBackupDir(root, name);
      },
      writeBackupFile: (path, bytes) => {
        writes.push("writeBackupFile");
        return base.writeBackupFile(path, bytes);
      },
      replaceFile: (path, bytes, expected) => {
        writes.push("replaceFile");
        return base.replaceFile(path, bytes, expected);
      },
      discardBackup: (dir, files) => {
        writes.push("discardBackup");
        base.discardBackup(dir, files);
      },
    },
  };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Setup {
  readonly root: string;
  readonly home: string;
  readonly files: string[];
}

/** Write a corpus for `agent`, with old modification times. */
async function setup(
  agent: AgentSource,
  sessions: readonly (readonly SessionEvent[])[] = [SESSION, SECOND],
): Promise<Setup> {
  const { root } = await writeCorpus(agent, sessions, { cwd: REPO });
  const files = transcriptFiles(root);
  for (const file of files) utimesSync(file, OLD, OLD);
  const home = mkdtempSync(join(tmpdir(), "agenttrail-scrub-home-"));
  return { root, home, files };
}

/** One in-process `scan` run. */
async function scan(
  s: Setup,
  agent: AgentSource,
  argv: readonly string[],
  deps: { verify?: VerifyIO; scrub?: ScrubIO | null } = {},
): Promise<Run> {
  const real = createRealScanIO();
  const out: string[] = [];
  const err: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  const io: ScanIO = {
    ...real,
    homedir: () => s.home,
    cwd: () => s.home,
    writeStdout: (text) => {
      out.push(text);
    },
    writeFile: () => true,
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  try {
    const code = await runScan(["--agent", agent, "--dir", s.root, ...argv], io, {
      createVerifyIO: () => deps.verify ?? processes(),
      ...(deps.scrub === null ? {} : { createScrubIO: () => deps.scrub ?? createRealScrubIO() }),
      platform: "linux",
    });
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    stderr.mockRestore();
  }
}

/** The backup folders made under the home. */
function backupFolders(home: string): string[] {
  const root = scrubBackupsRoot(home);
  return existsSync(root) ? readdirSync(root).map((name) => join(root, name)) : [];
}

/** Asserts no value of any class appears in `text`, in any printed form. */
function expectNoValue(text: string): void {
  for (const value of [...LIKELY_REAL, ...LEFT_ALONE]) {
    for (const form of forms(value)) expect(text).not.toContain(form);
  }
}

const AGENTS: readonly AgentSource[] = ["claude", "codex", "cursor"];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the dry run", () => {
  it.each(AGENTS)("%s: changes no byte, writes no backup and calls no write", async (agent) => {
    const s = await setup(agent);
    const before = snapshot(s.root);
    const { io, writes } = recording();
    const run = await scan(s, agent, ["--scrub"], { scrub: io });
    expect(run.code).toBe(0);
    expect(snapshot(s.root)).toEqual(before);
    expect(existsSync(join(s.home, ".agenttrail"))).toBe(false);
    expect(writes).toEqual([]);
    expect(run.stdout).toContain("Nothing is changed without --apply.");
    expect(run.stdout).toContain("Would scrub:");
  });

  it("says per file what it would replace, by kind", async () => {
    const s = await setup("claude");
    const run = await scan(s, "claude", ["--scrub"]);
    expect(run.stdout).toContain("4 likely-real credentials in 2 transcript files.");
    expect(run.stdout).toContain(
      "session-0.jsonl  5 replacements: 1 aws-access-key, 2 github-token, 1 named-secret, 1 slack-token",
    );
    expect(run.stdout).toContain("session-1.jsonl  1 replacement: 1 github-token");
    expect(run.stdout).toContain(
      "Left alone: 1 committed fixture, 1 placeholder or false positive, 1 local dev value.",
    );
  });

  it("says when no repo could be searched for committed fixtures", async () => {
    const s = await setup("cursor");
    const run = await scan(s, "cursor", ["--scrub"]);
    expect(run.stdout).toContain(
      "No repo was found to search for committed fixtures, so a fixture counts as likely real.",
    );
    const claude = await scan(await setup("claude"), "claude", ["--scrub"]);
    expect(claude.stdout).not.toContain("No repo was found");
  });

  it("tells the user to rotate first and to close the agent's sessions", async () => {
    const s = await setup("codex");
    const run = await scan(s, "codex", ["--scrub"]);
    expect(run.stdout).toContain("Rotate each credential first.");
    expect(run.stdout).toContain(
      "Close every Codex CLI session. A running session keeps appending to its transcript.",
    );
    expect(run.stdout).toContain("Not scrubbed by this command:");
  });

  it("says --apply would refuse while the agent runs, and which files it would skip", async () => {
    const s = await setup("claude");
    const recent = s.files[0] as string;
    utimesSync(recent, new Date(), new Date());
    const run = await scan(s, "claude", ["--scrub"], { verify: processes(["claude"]) });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("It would refuse to run now: Claude Code is running.");
    expect(run.stdout).toContain("It would skip");
    expect(run.stdout).toContain("changed in the last 5 minutes");
  });
});

describe("--apply", () => {
  it.each(AGENTS)("%s: replaces exactly the likely-real values", async (agent) => {
    const s = await setup(agent);
    const run = await scan(s, agent, ["--scrub", "--apply"]);
    expect(run.code).toBe(0);
    const text = s.files.map((f) => readFileSync(f, "utf8")).join("\n");
    const { replace, leave } = expected(agent);
    for (const value of replace) expect(text).not.toContain(value);
    for (const value of leave) expect(text).toContain(value);
    // Cursor records no command output, so the key printed by a command is not in its files.
    const kinds = ["github-token", "named-secret", "slack-token"] as const;
    for (const kind of agent === "cursor" ? kinds : [...kinds, "aws-access-key" as const]) {
      expect(text).toContain(scrubPlaceholder(kind));
    }
  });

  it.each(
    AGENTS,
  )("%s: every file is still valid JSON Lines, other lines byte for byte", async (agent) => {
    const s = await setup(agent);
    const before = new Map(s.files.map((f) => [f, readFileSync(f, "utf8")]));
    await scan(s, agent, ["--scrub", "--apply"]);
    for (const file of s.files) {
      const old = (before.get(file) as string).split("\n");
      const now = readFileSync(file, "utf8").split("\n");
      expect(now).toHaveLength(old.length);
      now.forEach((line, i) => {
        if (line !== "") expect(() => JSON.parse(line)).not.toThrow();
        const held = expected(agent).replace.some((v) => (old[i] as string).includes(v));
        if (!held) expect(line).toBe(old[i]);
      });
    }
  });

  it("backs up first, privately, with the original bytes, a manifest and restore commands", async () => {
    const s = await setup("claude");
    const originals = new Map(s.files.map((f) => [f, readFileSync(f)]));
    const run = await scan(s, "claude", ["--scrub", "--apply"]);
    const [folder] = backupFolders(s.home);
    expect(folder).toBeDefined();
    const dir = folder as string;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(dir)) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.files).toHaveLength(2);
    for (const entry of manifest.files) {
      const original = originals.get(entry.original) as Buffer;
      expect(readFileSync(entry.backup).equals(original)).toBe(true);
      expect(entry.sha256Before).toBe(sha256(original));
      expect(entry.sha256After).toBe(sha256(readFileSync(entry.original)));
      expect(entry.size).toBe(original.length);
    }
    expect(readFileSync(join(dir, "restore.txt"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(run.stdout).toContain(`Backed up 2 files to ${dir} (readable only by you).`);
    expect(run.stdout).toContain(
      "That backup still holds the credentials. Delete it once you have checked the scrubbed files.",
    );
  });

  it("the printed restore command puts the original bytes back", async () => {
    if (process.platform === "win32") return;
    const s = await setup("claude");
    const original = readFileSync(s.files[0] as string);
    const run = await scan(s, "claude", ["--scrub", "--apply"]);
    const command = run.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("cp -p ") && l.endsWith(`'${s.files[0]}'`));
    expect(command).toBeDefined();
    expect(readFileSync(s.files[0] as string).equals(original)).toBe(false);
    execFileSync("/bin/sh", ["-c", command as string]);
    expect(readFileSync(s.files[0] as string).equals(original)).toBe(true);
  });

  it("is idempotent: a second run finds nothing and changes nothing", async () => {
    const s = await setup("claude");
    await scan(s, "claude", ["--scrub", "--apply"]);
    const after = snapshot(s.root);
    const { io, writes } = recording();
    const again = await scan(s, "claude", ["--scrub", "--apply"], { scrub: io });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("0 likely-real credentials");
    expect(again.stdout).toContain("Nothing to scrub.");
    expect(snapshot(s.root)).toEqual(after);
    expect(writes).toEqual([]);
    expect(backupFolders(s.home)).toHaveLength(1);
  });
});

describe("--apply refuses or skips", () => {
  it.each([
    ["claude", "Claude"],
    ["codex", "codex.exe"],
    ["cursor", "Cursor"],
  ] as const)("%s: refuses the whole run while the app is running", async (agent, name) => {
    const s = await setup(agent);
    const before = snapshot(s.root);
    const run = await scan(s, agent, ["--scrub", "--apply"], { verify: processes(["zsh", name]) });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("Refused:");
    expect(run.stdout).toContain("is running");
    expect(run.stdout).toContain("Nothing was changed.");
    expect(snapshot(s.root)).toEqual(before);
    expect(existsSync(join(s.home, ".agenttrail"))).toBe(false);
  });

  it("refuses when the process list cannot be read", async () => {
    const s = await setup("claude");
    const before = snapshot(s.root);
    const run = await scan(s, "claude", ["--scrub", "--apply"], {
      verify: processes("unreadable"),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("the list of running programs could not be read");
    expect(snapshot(s.root)).toEqual(before);
  });

  it("skips a file changed in the last five minutes and scrubs the rest", async () => {
    const s = await setup("claude");
    const [recent, old] = s.files as [string, string];
    utimesSync(recent, new Date(), new Date());
    const recentBefore = readFileSync(recent, "utf8");
    const run = await scan(s, "claude", ["--scrub", "--apply"]);
    expect(run.code).toBe(1);
    expect(readFileSync(recent, "utf8")).toBe(recentBefore);
    expect(readFileSync(old, "utf8")).not.toContain(GITHUB);
    expect(run.stdout).toContain("changed in the last 5 minutes");
  });

  it("refuses a file that changed between the read and the replace, and leaves no temp file", async () => {
    const s = await setup("claude");
    const target = s.files[0] as string;
    const real = createRealScrubIO();
    const appended = `${JSON.stringify({ type: "user", message: { content: "late line" } })}\n`;
    const racing: ScrubIO = {
      ...real,
      replaceFile: (path, bytes, expected) => {
        if (path === target) writeFileSync(path, appended, { flag: "a" });
        return real.replaceFile(path, bytes, expected);
      },
    };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub: racing });
    expect(run.code).toBe(1);
    const now = readFileSync(target, "utf8");
    expect(now).toContain(GITHUB);
    expect(now.endsWith(appended)).toBe(true);
    expect(run.stdout).toContain("changed since it was read; left as it is");
    expect(readdirSync(dirname(target)).filter((n) => n.endsWith(".scrub-tmp"))).toEqual([]);
    expect(readFileSync(s.files[1] as string, "utf8")).not.toContain(GITHUB);
  });

  it("a failed backup aborts with nothing changed and the partial backup removed", async () => {
    const s = await setup("claude");
    const before = snapshot(s.root);
    const real = createRealScrubIO();
    let calls = 0;
    const failing: ScrubIO = {
      ...real,
      writeBackupFile: (path, bytes) => {
        calls += 1;
        return calls === 2 ? false : real.writeBackupFile(path, bytes);
      },
    };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub: failing });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("the backup could not be written in full. Nothing was changed");
    expect(snapshot(s.root)).toEqual(before);
    expect(backupFolders(s.home)).toEqual([]);
  });

  it.each([
    "EPERM",
    "EBUSY",
  ])("a rename refused with %s leaves the original as it was", async (code) => {
    const s = await setup("claude");
    const before = snapshot(s.root);
    const scrub = createRealScrubIO({
      fs: {
        renameSync: () => {
          throw Object.assign(new Error("held open"), { code });
        },
      },
    });
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`could not be replaced (${code})`);
    expect(snapshot(s.root)).toEqual(before);
  });
});

describe("--apply when the machine gets in the way", () => {
  it("refuses when a private backup folder cannot be made", async () => {
    const s = await setup("claude");
    const before = snapshot(s.root);
    const scrub: ScrubIO = { ...createRealScrubIO(), createBackupDir: () => undefined };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("a private backup folder could not be made");
    expect(snapshot(s.root)).toEqual(before);
  });

  it("says to restore from the backup when a file does not read back as written", async () => {
    const s = await setup("claude", [SESSION]);
    const real = createRealScrubIO();
    let replaced = false;
    const scrub: ScrubIO = {
      ...real,
      replaceFile: (path, bytes, expected) => {
        const result = real.replaceFile(path, bytes, expected);
        replaced = result.ok;
        return result;
      },
      read: (path) => {
        const read = real.read(path);
        return replaced && read.ok ? { ...read, bytes: new Uint8Array([0x7b, 0x7d]) } : read;
      },
    };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("did not read back as written; restore it from the backup");
    expect(run.stdout).toContain("cp -p ");
  });

  it("names a scrubbed copy that could not be written", async () => {
    const s = await setup("claude", [SESSION]);
    const scrub: ScrubIO = {
      ...createRealScrubIO(),
      replaceFile: () => ({ ok: false, reason: "write-failed" }),
    };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("the scrubbed copy could not be written beside it; left as it is");
  });

  it("changes nothing when every file to scrub changed in the last five minutes", async () => {
    const s = await setup("claude", [SESSION]);
    for (const file of s.files) utimesSync(file, new Date(), new Date());
    const before = snapshot(s.root);
    const run = await scan(s, "claude", ["--scrub", "--apply"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("Nothing was changed.");
    expect(snapshot(s.root)).toEqual(before);
    expect(backupFolders(s.home)).toEqual([]);
  });
});

/** A third session, so a backup can fail after more than one file. */
const THIRD: SessionEvent[] = [{ kind: "prompt", text: `a third time ${GITHUB}` }];

/** A `ScrubIO` whose `writeBackupFile` fails on the call `when` picks. */
function failingBackup(when: (path: string, call: number) => boolean): ScrubIO {
  const real = createRealScrubIO();
  let calls = 0;
  return {
    ...real,
    writeBackupFile: (path, bytes) => {
      calls += 1;
      return when(path, calls) ? false : real.writeBackupFile(path, bytes);
    },
  };
}

/** A real `ScrubIO` whose writes to files matching `match` fail at `op`. */
function failingWrites(match: (path: string) => boolean, op: "writeSync" | "fsyncSync"): ScrubIO {
  const marked = new Set<number>();
  return createRealScrubIO({
    fs: {
      openSync: (path, flags, mode) => {
        const fd = openSync(path, flags, mode);
        if (match(path)) marked.add(fd);
        else marked.delete(fd);
        return fd;
      },
      [op]: (fd: number, ...rest: [Uint8Array, number, number]) => {
        if (marked.has(fd)) throw Object.assign(new Error("EIO"), { code: "EIO" });
        return op === "writeSync" ? writeSync(fd, ...rest) : fsyncSync(fd);
      },
    },
  });
}

describe("--apply when a backup fails part-way", () => {
  it("a failure on the third of three files removes the two written, and changes nothing", async () => {
    const s = await setup("claude", [SESSION, SECOND, THIRD]);
    expect(s.files).toHaveLength(3);
    const before = snapshot(s.root);
    const run = await scan(s, "claude", ["--scrub", "--apply"], {
      scrub: failingBackup((_path, call) => call === 3),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("the backup could not be written in full. Nothing was changed");
    expect(snapshot(s.root)).toEqual(before);
    expect(backupFolders(s.home)).toEqual([]);
  });

  it("cleans up only the files it wrote, and keeps a folder holding anything else", async () => {
    const s = await setup("claude");
    const real = createRealScrubIO();
    let dir = "";
    const scrub: ScrubIO = {
      ...failingBackup((_path, call) => call === 2),
      createBackupDir: (root, name) => {
        dir = real.createBackupDir(root, name) as string;
        writeFileSync(join(dir, "not-ours.txt"), "kept");
        return dir;
      },
    };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub });
    expect(run.code).toBe(1);
    expect(readdirSync(dir)).toEqual(["not-ours.txt"]);
  });

  it("refuses when a backup file's name is already taken (exclusive create)", async () => {
    const s = await setup("claude");
    const before = snapshot(s.root);
    const real = createRealScrubIO();
    let dir = "";
    const scrub: ScrubIO = {
      ...real,
      createBackupDir: (root, name) => {
        dir = real.createBackupDir(root, name) as string;
        writeFileSync(join(dir, "1-session-0.jsonl"), "someone else's");
        return dir;
      },
    };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub });
    expect(run.code).toBe(1);
    expect(snapshot(s.root)).toEqual(before);
    expect(readdirSync(dir)).toEqual(["1-session-0.jsonl"]);
    expect(readFileSync(join(dir, "1-session-0.jsonl"), "utf8")).toBe("someone else's");
  });

  it.each([
    "manifest.json",
    "restore.txt",
  ])("refuses, and removes the backup, when %s cannot be written", async (file) => {
    const s = await setup("claude");
    const before = snapshot(s.root);
    const run = await scan(s, "claude", ["--scrub", "--apply"], {
      scrub: failingBackup((path) => path.endsWith(file)),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("the backup could not be written in full");
    expect(snapshot(s.root)).toEqual(before);
    expect(backupFolders(s.home)).toEqual([]);
  });

  it.each([
    "writeSync",
    "fsyncSync",
  ] as const)("a backup file whose %s fails aborts with nothing changed", async (op) => {
    const s = await setup("claude");
    const before = snapshot(s.root);
    const run = await scan(s, "claude", ["--scrub", "--apply"], {
      scrub: failingWrites((path) => path.includes("scrub-backups"), op),
    });
    expect(run.code).toBe(1);
    expect(snapshot(s.root)).toEqual(before);
    expect(backupFolders(s.home)).toEqual([]);
  });

  it("refuses when ~/.agenttrail is a file, so no backup folder can be made", async () => {
    const s = await setup("claude");
    writeFileSync(join(s.home, ".agenttrail"), "not a folder");
    const before = snapshot(s.root);
    const run = await scan(s, "claude", ["--scrub", "--apply"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("a private backup folder could not be made");
    expect(snapshot(s.root)).toEqual(before);
  });
});

describe("--apply when a replace fails part-way", () => {
  it.each([
    "writeSync",
    "fsyncSync",
  ] as const)("a temporary file whose %s fails leaves every original, and the backup", async (op) => {
    const s = await setup("claude");
    const before = snapshot(s.root);
    const run = await scan(s, "claude", ["--scrub", "--apply"], {
      scrub: failingWrites((path) => path.endsWith(".scrub-tmp"), op),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("the scrubbed copy could not be written beside it; left as it is");
    expect(snapshot(s.root)).toEqual(before);
    const [dir] = backupFolders(s.home);
    expect(readdirSync(dir as string).sort()).toEqual([
      "1-session-0.jsonl",
      "2-session-1.jsonl",
      "manifest.json",
      "restore.txt",
    ]);
  });

  it("a file that changed between planning and backup is left, and the rest scrubbed", async () => {
    const s = await setup("claude");
    const [first, second] = s.files as [string, string];
    const real = createRealScrubIO();
    const scrub: ScrubIO = {
      ...real,
      createBackupDir: (root, name) => {
        writeFileSync(
          first,
          `${JSON.stringify({ type: "user", message: { content: "late" } })}\n`,
          {
            flag: "a",
          },
        );
        return real.createBackupDir(root, name);
      },
    };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub });
    expect(run.code).toBe(1);
    expect(readFileSync(first, "utf8")).toContain(GITHUB);
    expect(readFileSync(second, "utf8")).not.toContain(GITHUB);
    expect(run.stdout).toContain("session-0.jsonl: changed since it was read; left as it is.");
  });

  it("a file that reads back unreadable after the replace says to restore it", async () => {
    const s = await setup("claude", [SESSION]);
    const real = createRealScrubIO();
    let replaced = false;
    const scrub: ScrubIO = {
      ...real,
      replaceFile: (path, bytes, expected) => {
        const result = real.replaceFile(path, bytes, expected);
        replaced = result.ok;
        return result;
      },
      read: (path) => (replaced ? { ok: false, reason: "missing" } : real.read(path)),
    };
    const run = await scan(s, "claude", ["--scrub", "--apply"], { scrub });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("did not read back as written; restore it from the backup");
  });

  it("a file that shrinks while it is planned is skipped as changed", async () => {
    const s = await setup("claude", [SESSION]);
    const scrub: ScrubIO = {
      ...createRealScrubIO(),
      read: () => ({ ok: false, reason: "changed" }),
    };
    const run = await scan(s, "claude", ["--scrub"], { scrub });
    expect(run.stdout).toContain("session-0.jsonl: changed since it was read; left as it is");
  });

  it("a file too large to scrub is skipped and named", async () => {
    const s = await setup("claude", [SESSION]);
    const run = await scan(s, "claude", ["--scrub"], {
      scrub: createRealScrubIO({ maxFileBytes: 10 }),
    });
    expect(run.stdout).toContain("session-0.jsonl: too large to scrub safely; left alone");
  });

  it("a file that cannot be read is skipped and named", async () => {
    const s = await setup("claude", [SESSION]);
    const scrub: ScrubIO = {
      ...createRealScrubIO(),
      read: () => ({ ok: false, reason: "missing" }),
    };
    const run = await scan(s, "claude", ["--scrub"], { scrub });
    expect(run.stdout).toContain("session-0.jsonl: could not be read; left alone");
  });
});

describe("formats it does not edit", () => {
  /** A corpus with extra files beside one real transcript, run through `runScrub` itself. */
  async function runWith(extra: Record<string, Uint8Array | string>): Promise<Run & Setup> {
    const s = await setup("claude", [SESSION]);
    const added: string[] = [];
    for (const [name, content] of Object.entries(extra)) {
      const path = join(s.root, name);
      writeFileSync(path, content);
      utimesSync(path, OLD, OLD);
      added.push(path);
    }
    const out: string[] = [];
    const io: ScanIO = {
      ...createRealScanIO(),
      homedir: () => s.home,
      writeStdout: (t) => void out.push(t),
    };
    const code = await runScrub({
      agent: "claude",
      root: s.root,
      corpus: {
        agent: "claude",
        sessions: [],
        quarantined: 0,
        notRead: 0,
        projects: 1,
        files: [...s.files, ...added],
      },
      apply: true,
      io,
      verifyIO: processes(),
      scrubIO: createRealScrubIO(),
      now: new Date(),
      platform: "linux",
      colors: false,
    });
    return { ...s, code, stdout: out.join(""), stderr: "" };
  }

  it("skips and reports a file that is not JSON Lines", async () => {
    const run = await runWith({ "notes.txt": `token ${GITHUB}\n` });
    expect(run.stdout).toContain(
      "notes.txt: not a supported transcript format (JSON Lines); left alone",
    );
    expect(readFileSync(join(run.root, "notes.txt"), "utf8")).toContain(GITHUB);
    // Nothing known to be in it went unscrubbed: the run itself is complete.
    expect(run.code).toBe(0);
  });

  it("skips and reports a file that is not UTF-8", async () => {
    const bytes = Buffer.concat([
      Buffer.from(`${JSON.stringify({ type: "user", message: { content: `x ${GITHUB}` } })}\n`),
      Buffer.from([0xff, 0xfe, 0x0a]),
    ]);
    const run = await runWith({ "binary.jsonl": bytes });
    expect(run.stdout).toContain("binary.jsonl: not UTF-8 text");
    expect(readFileSync(join(run.root, "binary.jsonl")).equals(bytes)).toBe(true);
  });

  it("leaves a line that is not JSON and says the file was not fully cleaned", async () => {
    const line = `{"type":"user","message":{"content":"x ${GITHUB}"}`;
    const run = await runWith({ "torn.jsonl": `${line}\n` });
    expect(readFileSync(join(run.root, "torn.jsonl"), "utf8")).toBe(`${line}\n`);
    expect(run.stdout).toContain(
      "torn.jsonl: 1 line holding a value could not be edited and still parse",
    );
    expect(run.code).toBe(1);
  });
});

describe("never the value", () => {
  it.each(AGENTS)("%s: no value in stdout or stderr, dry run or --apply", async (agent) => {
    const s = await setup(agent);
    const dry = await scan(s, agent, ["--scrub"]);
    const applied = await scan(s, agent, ["--scrub", "--apply"]);
    const again = await scan(s, agent, ["--scrub", "--apply"]);
    for (const run of [dry, applied, again]) {
      expectNoValue(run.stdout);
      expect(run.stderr).toBe("");
    }
  });

  it("no value in the manifest or the restore commands", async () => {
    const s = await setup("claude");
    await scan(s, "claude", ["--scrub", "--apply"]);
    const dir = backupFolders(s.home)[0] as string;
    expectNoValue(readFileSync(join(dir, "manifest.json"), "utf8"));
    expectNoValue(readFileSync(join(dir, "restore.txt"), "utf8"));
  });
});

describe("the flags", () => {
  it("--apply without --scrub is refused", async () => {
    const s = await setup("claude");
    const run = await scan(s, "claude", ["--apply"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("--apply only works with --scrub");
  });

  it.each([
    ["--json"],
    ["--review"],
    ["--verify"],
    ["--artifact"],
    ["--out", "x.html"],
  ])("--scrub with %s is refused", async (...flag) => {
    const s = await setup("claude");
    const run = await scan(s, "claude", ["--scrub", ...flag]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("--scrub writes no report");
  });

  it("a plain scan never makes the scrub seam", async () => {
    const s = await setup("claude");
    const make = vi.fn(() => createRealScrubIO());
    const real = createRealScanIO();
    const code = await runScan(
      ["--agent", "claude", "--dir", s.root, "--no-open"],
      {
        ...real,
        homedir: () => s.home,
        cwd: () => s.home,
        writeStdout: () => {},
        writeFile: () => true,
        env: { CI: "1" },
        isTTY: () => false,
      },
      { createScrubIO: make, createVerifyIO: () => processes() },
    );
    expect(code).toBe(0);
    expect(make).not.toHaveBeenCalled();
  });

  it("--scrub with no scrub seam refuses", async () => {
    const s = await setup("claude");
    const run = await scan(s, "claude", ["--scrub"], { scrub: null });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("--scrub is not available in this build");
  });
});

describe("what the process check cannot see", () => {
  it("is one fixed sentence", () => {
    expect(PROCESS_NAME_GAP).toBe(
      'If an agent is running under a generic name (for example "node"), this check can\'t see it; files changed in the last 5 minutes are skipped for that reason.',
    );
  });

  it("is said in the dry run, beside the check it qualifies", async () => {
    const s = await setup("claude");
    const run = await scan(s, "claude", ["--scrub"]);
    expect(run.stdout).toContain(
      `  It refuses while Claude Code is running, which it finds by process name.\n  ${PROCESS_NAME_GAP}\n`,
    );
  });

  it("is said by --apply once the check has passed", async () => {
    const s = await setup("cursor");
    const run = await scan(s, "cursor", ["--scrub", "--apply"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`No Cursor process is running, by name. ${PROCESS_NAME_GAP}\n`);
  });

  it("a session run as node is not seen by name, so only the 5-minute check holds it back", async () => {
    const s = await setup("claude");
    for (const file of s.files) utimesSync(file, new Date(), new Date());
    const before = snapshot(s.root);
    const run = await scan(s, "claude", ["--scrub", "--apply"], { verify: processes(["node"]) });
    expect(run.stdout).not.toContain("Refused:");
    expect(run.stdout).toContain(PROCESS_NAME_GAP);
    expect(run.stdout).toContain("changed in the last 5 minutes");
    expect(snapshot(s.root)).toEqual(before);
  });
});

describe("the two checks, on their own", () => {
  it("refuses on the app's own id only, and when the list cannot be read", async () => {
    /** The seam answering with `running` ids. */
    const ids = (running: WatchedProcess[]): VerifyIO => ({
      ...createRealVerifyIO(),
      processNames: () => Promise.resolve({ ok: true, running }),
    });
    expect(await agentProcessCheck(ids(["claude"]), "claude")).toEqual({ state: "running" });
    expect(await agentProcessCheck(ids(["cursor", "codex"]), "claude")).toEqual({
      state: "not-running",
    });
    expect(await agentProcessCheck(ids([]), "codex")).toEqual({ state: "not-running" });
    expect(await agentProcessCheck(processes("unreadable"), "claude")).toEqual({
      state: "could-not-check",
    });
  });

  it("calls a file recent for five minutes after its last change", () => {
    const now = 1_000_000_000;
    expect(RECENT_WRITE_WINDOW_MS).toBe(300_000);
    expect(isRecentlyModified(now - 299_999, now)).toBe(true);
    expect(isRecentlyModified(now - 300_000, now)).toBe(false);
    expect(isRecentlyModified(now + 1_000, now)).toBe(true);
  });
});

describe("paths and commands", () => {
  it("keeps backups under ~/.agenttrail/scrub-backups/, in a folder named by the time", () => {
    expect(scrubBackupsRoot("/home/dev")).toBe("/home/dev/.agenttrail/scrub-backups");
    expect(backupFolderName(new Date("2026-10-01T12:34:56.789Z"))).toBe("2026-10-01T12-34-56-789Z");
  });

  it("quotes restore commands for a POSIX shell and for PowerShell", () => {
    expect(restoreCommand("linux", "/b/it's.jsonl", "/t/a b.jsonl")).toBe(
      `cp -p '/b/it'\\''s.jsonl' '/t/a b.jsonl'`,
    );
    expect(restoreCommand("win32", "C:\\b\\it's.jsonl", "C:\\t\\a.jsonl")).toBe(
      "Copy-Item -LiteralPath 'C:\\b\\it''s.jsonl' -Destination 'C:\\t\\a.jsonl' -Force",
    );
  });
});

describe("the usage", () => {
  it("documents --scrub and --apply, and parses them", () => {
    expect(SCAN_USAGE).toContain("--scrub");
    expect(SCAN_USAGE).toContain("--apply");
    expect(SCAN_USAGE).toContain("Rotate each credential first, then scrub.");
    expect(SCAN_USAGE).toContain("~/.agenttrail/scrub-backups/");
    expect(parseScanFlags(["--agent", "claude"]).scrub).toBe(false);
    expect(parseScanFlags(["--agent", "claude"]).apply).toBe(false);
    const flags = parseScanFlags(["--agent", "claude", "--scrub", "--apply"]);
    expect(flags.scrub).toBe(true);
    expect(flags.apply).toBe(true);
    expect(flags.unknown).toBeUndefined();
  });
});
