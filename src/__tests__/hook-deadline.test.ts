// cspell:words mkfifo
/**
 * The hook's deadline: a check that cannot finish in time is answered, never let through.
 *
 * Three layers:
 * - `deadlineAnswer`, the answer written at the deadline, for every app and case;
 * - `superviseHook` with a fake worker and a fake clock: one answer only, and how the hook
 *   ends when the worker will not stop;
 * - the BUILT bundle as a process, hung on purpose through the real input path: a user rule
 *   whose pattern backtracks for minutes, a stdin nobody closes, a config file that blocks
 *   the read. No switch in the shipped bundle makes it fail; the inputs do.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { beforeAll, describe, expect, it } from "vitest";
import { NOT_CHECKED_MESSAGE, runHook } from "../commands/hook.js";
import { codexCheckedEvent, mapCodexCall } from "../core/codex-mapper.js";
import { NO_OPINION } from "../core/cursor-emit.js";
import { cursorCheckedCall, mapCursorCall } from "../core/cursor-mapper.js";
import { joinSearchPath, trimTrailingSeparators } from "../core/mapper.js";
import { enforcedProjectsPath, OS_PLUGIN_ID, tokenFingerprint } from "../core/os-step-aside.js";
import type { CodexHookPayload, CursorHookPayload } from "../core/types.js";
import {
  DEADLINE_REASON,
  deadlineAnswer,
  HOOK_DEADLINE_MS,
  HOOK_WORKER_ROLE,
  type HookWorkerInput,
  superviseHook,
  type WorkerHandle,
} from "../hook-deadline.js";
import type { GuardIO } from "../io.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const HOOK_BUNDLE = join(PKG_ROOT, "plugin", "scripts", "guard-hook.mjs");
const CLI_BUNDLE = join(PKG_ROOT, "dist", "cli.js");
const TSUP_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsup");

const CLAUDE_ASK = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: DEADLINE_REASON,
  },
});

const claude = (command: string) => ({
  tool_name: "Bash",
  tool_input: { command },
  hook_event_name: "PreToolUse",
  session_id: "s",
  cwd: "/tmp",
});
const cursor = (fields: Record<string, unknown>) => ({ cursor_version: "3.21.16", ...fields });
const codex = (event: string, tool: string, input: Record<string, unknown>) => ({
  hook_event_name: event,
  turn_id: "t",
  model: "gpt",
  tool_name: tool,
  tool_input: input,
  session_id: "s",
  cwd: "/tmp",
});

function parsed(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

// ── deadlineAnswer ──────────────────────────────────────────────────────────

describe("deadlineAnswer: what the hook says when the check did not finish", () => {
  it("no payload, Claude Code: ask", () => {
    expect(deadlineAnswer({ agent: "claude", standDown: false })).toBe(CLAUDE_ASK);
    expect(deadlineAnswer({ standDown: false })).toBe(CLAUDE_ASK);
  });

  it("no payload, Cursor: a deny that is valid on both of guard's Cursor events", () => {
    const answer = parsed(deadlineAnswer({ agent: "cursor", standDown: false }));
    expect(answer.permission).toBe("deny");
    expect(String(answer.user_message)).toContain(DEADLINE_REASON);
  });

  it("no payload, Codex: the PreToolUse deny shape", () => {
    const answer = parsed(deadlineAnswer({ agent: "codex", standDown: false }));
    expect(answer.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
  });

  it("a call guard does not check keeps today's no-opinion answer", () => {
    expect(
      deadlineAnswer({
        agent: "cursor",
        payload: cursor({ hook_event_name: "afterFileEdit", file_path: "/x" }),
        standDown: false,
      }),
    ).toBe(NO_OPINION);
    expect(
      deadlineAnswer({
        agent: "codex",
        payload: codex("PreToolUse", "view_image", { path: "/x" }),
        standDown: false,
      }),
    ).toBe("");
  });

  it("a payload no app claims, with no --agent, gets today's not-checked note", () => {
    expect(deadlineAnswer({ payload: { hello: 1 }, standDown: false })).toBe(
      JSON.stringify({ systemMessage: NOT_CHECKED_MESSAGE }),
    );
  });

  it("Claude Code: silent only after a reported stand-down; otherwise ask", () => {
    expect(deadlineAnswer({ agent: "claude", payload: claude("ls"), standDown: true })).toBe("");
    expect(deadlineAnswer({ agent: "claude", payload: claude("ls"), standDown: false })).toBe(
      CLAUDE_ASK,
    );
  });

  it("Cursor: approval-deny at preToolUse, ask at beforeShellExecution, Shell defers", () => {
    const pre = parsed(
      deadlineAnswer({
        agent: "cursor",
        payload: cursor({ hook_event_name: "preToolUse", tool_name: "MCP:run", tool_input: {} }),
        standDown: false,
      }),
    );
    expect(pre.permission).toBe("deny");
    const shell = parsed(
      deadlineAnswer({
        agent: "cursor",
        payload: cursor({ hook_event_name: "beforeShellExecution", command: "ls" }),
        standDown: false,
      }),
    );
    expect(shell.permission).toBe("ask");
    expect(
      deadlineAnswer({
        agent: "cursor",
        payload: cursor({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: {} }),
        standDown: false,
      }),
    ).toBe(NO_OPINION);
  });

  it("Cursor under guard's Claude Code plugin: the only checkpoint, so it refuses", () => {
    const answer = parsed(
      deadlineAnswer({
        agent: "claude",
        payload: cursor({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: {} }),
        standDown: false,
      }),
    );
    expect(answer.permission).toBe("deny");
  });

  it("Codex: the deny shape of the payload's own event", () => {
    for (const event of ["PreToolUse", "PermissionRequest"] as const) {
      const answer = parsed(
        deadlineAnswer({
          agent: "codex",
          payload: codex(event, "Bash", { command: "ls" }),
          standDown: false,
        }),
      );
      expect((answer.hookSpecificOutput as Record<string, unknown>).hookEventName).toBe(event);
      expect(JSON.stringify(answer)).toContain('"deny"');
    }
  });

  it("never answers allow", () => {
    const cases = [
      deadlineAnswer({ agent: "claude", payload: claude("ls"), standDown: false }),
      deadlineAnswer({ agent: "cursor", standDown: false }),
      deadlineAnswer({ agent: "codex", standDown: false }),
    ];
    for (const text of cases) expect(text).not.toMatch(/"allow"/);
  });
});

// ── The checked-call lookups agree with the mappers ─────────────────────────

describe("the deadline's checked-call lookups agree with the mappers", () => {
  const cursorEvents = [
    "preToolUse",
    "beforeShellExecution",
    "afterFileEdit",
    "beforeMCPExecution",
    "beforeReadFile",
    "stop",
    undefined,
  ];
  const cursorTools = ["Shell", "Read", "Write", "Delete", "Grep", "MCP:run", "", undefined, 7];
  it("Cursor: not checked exactly when mapCursorCall is undefined", () => {
    for (const hook_event_name of cursorEvents) {
      for (const tool_name of cursorTools) {
        const payload = cursor({
          hook_event_name,
          tool_name,
          tool_input: { command: "ls", file_path: "/x", path: "/x", pattern: "a" },
          command: "ls",
        }) as unknown as CursorHookPayload;
        expect(cursorCheckedCall(payload) === undefined).toBe(mapCursorCall(payload) === undefined);
      }
    }
  });

  const codexEvents = ["PreToolUse", "PermissionRequest", "PostToolUse", "SessionStart", undefined];
  const codexTools = ["Bash", "apply_patch", "mcp__a__b", "view_image", "shell_command", "", 7];
  const patches = [
    "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch",
    "*** Begin Patch\n*** End Patch",
  ];
  it("Codex: undefined only where mapCodexCall is; apply_patch with no path is the one gap", () => {
    for (const hook_event_name of codexEvents) {
      for (const tool_name of codexTools) {
        for (const patch of patches) {
          const payload = {
            ...codex(String(hook_event_name), String(tool_name), { command: patch }),
            hook_event_name,
            tool_name,
          } as unknown as CodexHookPayload;
          const lookup = codexCheckedEvent(payload);
          const mapped = mapCodexCall(payload);
          if (lookup === undefined) expect(mapped).toBeUndefined();
          if (mapped === undefined && lookup !== undefined) expect(tool_name).toBe("apply_patch");
          if (mapped !== undefined) expect(lookup).toBe(mapped.event);
        }
      }
    }
  });
});

// ── The Grep folder trim ────────────────────────────────────────────────────

describe("trimTrailingSeparators", () => {
  it("equals the regex it replaced, on random strings of separators and letters", () => {
    const alphabet = ["/", "\\", "a", "b", ".", " "];
    let seed = 1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 2_000; i += 1) {
      const length = next() % 64;
      let value = "";
      for (let j = 0; j < length; j += 1) value += alphabet[next() % alphabet.length];
      expect(trimTrailingSeparators(value)).toBe(value.replace(/[\\/]+$/, ""));
    }
  });

  it("is linear: 262,144 separators then a letter take well under a second", () => {
    const dir = `${"/".repeat(262_144)}x`;
    const started = performance.now();
    expect(joinSearchPath(dir, "*.ts")).toBe(`${dir}/*.ts`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

// ── superviseHook with a fake worker and a fake clock ───────────────────────

interface FakeWorker extends WorkerHandle {
  emit(event: "message", value: unknown): void;
  emit(event: "error", value: unknown): void;
  emit(event: "exit", value: number): void;
  terminated: number;
}

function fakeWorker(terminate: "resolves" | "hangs" = "resolves"): FakeWorker {
  const listeners: Record<string, ((value: never) => void)[]> = {};
  const worker: FakeWorker = {
    terminated: 0,
    on(event: string, listener: (value: never) => void) {
      listeners[event] = [...(listeners[event] ?? []), listener];
      return worker;
    },
    emit(event: string, value: unknown) {
      for (const listener of listeners[event] ?? []) listener(value as never);
    },
    terminate() {
      worker.terminated += 1;
      return terminate === "resolves" ? Promise.resolve(1) : new Promise(() => {});
    },
  } as FakeWorker;
  return worker;
}

function harness(opts: { stdin?: Promise<string>; worker?: FakeWorker; startThrows?: boolean }) {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const writes: string[] = [];
  const started: HookWorkerInput[] = [];
  const state = { killed: 0, released: 0 };
  const worker = opts.worker ?? fakeWorker();
  const run = superviseHook({
    agent: "claude",
    cwd: "/w",
    home: "/h",
    readStdin: () => opts.stdin ?? Promise.resolve(JSON.stringify(claude("ls"))),
    write: async (text) => {
      writes.push(text);
    },
    startWorker: (input) => {
      if (opts.startThrows) throw new Error("EAGAIN");
      started.push(input);
      return worker;
    },
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    releaseStdin: () => {
      state.released += 1;
    },
    killSelf: () => {
      state.killed += 1;
    },
  });
  const fire = async (ms: number) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cancelled)) timer.fn();
    await new Promise((r) => setImmediate(r));
  };
  const settle = () => new Promise((r) => setImmediate(r));
  return { run, writes, started, state, worker, timers, fire, settle };
}

describe("superviseHook: one answer, and the hook always ends", () => {
  it("hands the worker the payload, cwd and home, and writes the worker's answer once", async () => {
    const h = harness({});
    await h.settle();
    expect(h.started[0]).toMatchObject({ agent: "claude", cwd: "/w", home: "/h" });
    h.worker.emit("message", { kind: "answer", text: "ANSWER" });
    h.worker.emit("exit", 0);
    await h.run;
    expect(h.writes).toEqual(["ANSWER"]);
    expect(h.state.killed).toBe(0);
    expect(h.timers.find((t) => t.ms === HOOK_DEADLINE_MS)?.cancelled).toBe(true);
  });

  it("at the deadline: the fail-safe answer, the worker stopped, no kill", async () => {
    const h = harness({});
    await h.settle();
    await h.fire(HOOK_DEADLINE_MS);
    await h.run;
    expect(h.writes).toEqual([CLAUDE_ASK]);
    expect(h.worker.terminated).toBe(1);
    expect(h.state.killed).toBe(0);
    // A late answer from the worker is dropped.
    h.worker.emit("message", { kind: "answer", text: "LATE" });
    await h.settle();
    expect(h.writes).toEqual([CLAUDE_ASK]);
  });

  it("a worker that will not stop: the hook ends itself after the grace", async () => {
    const h = harness({ worker: fakeWorker("hangs") });
    await h.settle();
    await h.fire(HOOK_DEADLINE_MS);
    expect(h.writes).toEqual([CLAUDE_ASK]);
    expect(h.state.killed).toBe(0);
    await h.fire(250);
    expect(h.state.killed).toBe(1);
  });

  it("the worker answered, then hung while recording: no second answer, then it ends", async () => {
    const h = harness({ worker: fakeWorker("hangs") });
    await h.settle();
    h.worker.emit("message", { kind: "answer", text: "ANSWER" });
    await h.settle();
    await h.fire(HOOK_DEADLINE_MS);
    await h.fire(250);
    expect(h.writes).toEqual(["ANSWER"]);
    expect(h.state.killed).toBe(1);
  });

  it("an empty answer still counts: the deadline does not add one", async () => {
    const h = harness({});
    await h.settle();
    h.worker.emit("message", { kind: "answer", text: "" });
    await h.fire(HOOK_DEADLINE_MS);
    await h.run;
    expect(h.writes).toEqual([]);
  });

  it("a worker error (out of memory) is answered as the deadline, not as not-checked", async () => {
    const h = harness({});
    await h.settle();
    h.worker.emit("error", Object.assign(new Error("oom"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
    await h.run;
    expect(h.writes).toEqual([CLAUDE_ASK]);
  });

  it("a worker that ends without answering is answered as the deadline", async () => {
    const h = harness({});
    await h.settle();
    h.worker.emit("exit", 1);
    await h.run;
    expect(h.writes).toEqual([CLAUDE_ASK]);
  });

  it("a worker that cannot start is answered as the deadline", async () => {
    const h = harness({ startThrows: true });
    await h.run;
    expect(h.writes).toEqual([CLAUDE_ASK]);
  });

  it("a stdin nobody closes: answered at the deadline, stdin released", async () => {
    const h = harness({ stdin: new Promise(() => {}) });
    await h.fire(HOOK_DEADLINE_MS);
    await h.run;
    expect(h.writes).toEqual([CLAUDE_ASK]);
    expect(h.state.released).toBe(1);
    expect(h.started).toEqual([]);
  });

  it("step-aside: silent only after the worker reports a stand-down", async () => {
    const down = harness({});
    await down.settle();
    down.worker.emit("message", { kind: "stepAside", standDown: true });
    await down.fire(HOOK_DEADLINE_MS);
    await down.run;
    expect(down.writes).toEqual([]);

    const enforce = harness({});
    await enforce.settle();
    enforce.worker.emit("message", { kind: "stepAside", standDown: false });
    await enforce.fire(HOOK_DEADLINE_MS);
    await enforce.run;
    expect(enforce.writes).toEqual([CLAUDE_ASK]);

    const silent = harness({});
    await silent.settle();
    await silent.fire(HOOK_DEADLINE_MS);
    await silent.run;
    expect(silent.writes).toEqual([CLAUDE_ASK]);
  });
});

// ── runHook reports the answer and the step-aside result ────────────────────

function memoryIO(input: string, files: Record<string, string> = {}): GuardIO {
  return {
    readStdin: async () => input,
    writeStdout: () => {},
    readFile: (p) => files[p],
    homedir: () => "/home/dev",
    mkdirp: () => true,
    writeFileAtomic: () => true,
    listDir: () => [],
    deleteFile: () => true,
    appendFile: () => true,
    fileSize: () => 0,
  };
}

describe("runHook's reports to the main thread", () => {
  it("reports the answer even when it writes nothing", async () => {
    const answers: string[] = [];
    await runHook(memoryIO(JSON.stringify(claude("ls"))), {
      agent: "claude",
      onAnswered: (text) => answers.push(text),
    });
    expect(answers).toEqual([""]);
  });

  it("reports step-aside false when the sentinel is set but no record matches", async () => {
    const reports: boolean[] = [];
    await runHook(memoryIO(JSON.stringify(claude("ls"))), {
      agent: "claude",
      env: { AGENTTRAIL_PEP_ENFORCE: "1" },
      realpath: (p) => p,
      onStepAside: (standDown) => reports.push(standDown),
    });
    expect(reports).toEqual([false]);
  });
});

// ── The built bundle, hung on purpose ───────────────────────────────────────

/** A user rule whose pattern backtracks for minutes on a run of `a` that does not end the input. */
const SLOW_RULE = JSON.stringify([
  {
    id: "test.slow",
    category: "prod-infra",
    defaultAction: "warn",
    match: { any_of: [{ kind: "execute_tool", detail_matches: ["(a+)+$"] }] },
  },
]);
const SLOW_TEXT = `echo ${"a".repeat(40)}!`;

function home(rule = true): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenttrail-guard-deadline-")));
  mkdirSync(join(dir, ".agenttrail", "guard"), { recursive: true });
  if (rule) writeFileSync(join(dir, ".agenttrail", "guard", "guardrails.json"), SLOW_RULE);
  return dir;
}

/** This process's environment without anything an agent or AgentTrail set in it. */
function hermeticEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(AGENTTRAIL_|CLAUDE_)/.test(key)),
  );
}

interface ProcessRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly ms: number;
}

function run(
  args: readonly string[],
  input: string | undefined,
  dir: string,
  env: Record<string, string> = {},
  bundle = HOOK_BUNDLE,
): Promise<ProcessRun> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn("node", [bundle, ...args], {
      env: { ...hermeticEnv(), HOME: dir, USERPROFILE: dir, ...env },
      cwd: dir,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    // A stdin nobody closes is the case under test when `input` is undefined.
    if (input !== undefined) child.stdin.end(input);
    const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("exit", (status, signal) => {
      clearTimeout(guard);
      if (input === undefined) child.stdin.destroy();
      resolve({ status, signal, stdout, ms: performance.now() - started });
    });
  });
}

const IN_TIME_MS = HOOK_DEADLINE_MS + 1_500;

describe.concurrent("the built hook, hung on purpose, is decided and never allowed", () => {
  beforeAll(() => {
    execFileSync(TSUP_BIN, [], { cwd: PKG_ROOT, stdio: "pipe" });
  }, 180_000);

  it("Claude Code, a slow rule: ask, exit 0, in time", async () => {
    const r = await run(["--agent", "claude"], JSON.stringify(claude(SLOW_TEXT)), home());
    expect(r.stdout).toBe(CLAUDE_ASK);
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(IN_TIME_MS);
    expect(r.ms).toBeGreaterThan(HOOK_DEADLINE_MS - 500);
  });

  it("agenttrail-guard hook, a slow rule: the same ask", async () => {
    const r = await run(
      ["hook", "--agent", "claude"],
      JSON.stringify(claude(SLOW_TEXT)),
      home(),
      {},
      CLI_BUNDLE,
    );
    expect(r.stdout).toBe(CLAUDE_ASK);
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(IN_TIME_MS);
  });

  it("agenttrail-guard hook with a flag before the command: the same deadline", async () => {
    const [flagFirst, quiet] = await Promise.all([
      run(["--agent", "claude", "hook"], JSON.stringify(claude(SLOW_TEXT)), home(), {}, CLI_BUNDLE),
      run(
        ["--quiet", "hook", "--agent", "claude"],
        JSON.stringify(claude(SLOW_TEXT)),
        home(),
        {},
        CLI_BUNDLE,
      ),
    ]);
    for (const r of [flagFirst, quiet]) {
      expect(r.stdout).toBe(CLAUDE_ASK);
      expect(r.status).toBe(0);
      expect(r.ms).toBeLessThan(IN_TIME_MS);
    }
  });

  it("Cursor preToolUse (MCP), a slow rule: approval-deny", async () => {
    const payload = cursor({
      hook_event_name: "preToolUse",
      tool_name: "MCP:run",
      tool_input: { query: SLOW_TEXT },
    });
    const r = await run(["--agent", "cursor"], JSON.stringify(payload), home());
    expect(parsed(r.stdout).permission).toBe("deny");
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(IN_TIME_MS);
  });

  it("Cursor beforeShellExecution, a slow rule: ask", async () => {
    const payload = cursor({ hook_event_name: "beforeShellExecution", command: SLOW_TEXT });
    const r = await run(["--agent", "cursor"], JSON.stringify(payload), home());
    expect(parsed(r.stdout).permission).toBe("ask");
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(IN_TIME_MS);
  });

  it("Codex PreToolUse and PermissionRequest, a slow rule: each event's deny", async () => {
    const [pre, perm] = await Promise.all(
      (["PreToolUse", "PermissionRequest"] as const).map((event) =>
        run(
          ["--agent", "codex"],
          JSON.stringify(codex(event, "Bash", { command: SLOW_TEXT })),
          home(),
        ),
      ),
    );
    expect(parsed(pre.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(parsed(perm.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny" },
    });
    for (const r of [pre, perm]) {
      expect(r.status).toBe(0);
      expect(r.ms).toBeLessThan(IN_TIME_MS);
    }
  });

  it("calls guard does not check stay no-opinion, fast", async () => {
    const [after, view] = await Promise.all([
      run(
        ["--agent", "cursor"],
        JSON.stringify(cursor({ hook_event_name: "afterFileEdit", file_path: `/${SLOW_TEXT}` })),
        home(),
      ),
      run(
        ["--agent", "codex"],
        JSON.stringify(codex("PreToolUse", "view_image", { path: SLOW_TEXT })),
        home(),
      ),
    ]);
    expect(after.stdout).toBe("{}");
    expect(view.stdout).toBe("");
    for (const r of [after, view]) expect(r.ms).toBeLessThan(HOOK_DEADLINE_MS);
  });

  it("a stdin nobody closes: each protocol's no-payload answer, exit 0, in time", async () => {
    const [c, cu, co] = await Promise.all(
      ["claude", "cursor", "codex"].map((agent) => run(["--agent", agent], undefined, home(false))),
    );
    expect(c?.stdout).toBe(CLAUDE_ASK);
    expect(parsed(cu?.stdout ?? "").permission).toBe("deny");
    expect(parsed(co?.stdout ?? "").hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    for (const r of [c, cu, co]) {
      expect(r?.status).toBe(0);
      expect(r?.ms).toBeLessThan(IN_TIME_MS);
    }
  });

  it.skipIf(process.platform === "win32")(
    "a config read that blocks: the answer is out, then the hook kills itself",
    async () => {
      const dir = home(false);
      execFileSync("mkfifo", [join(dir, ".agenttrail", "guard", "config.json")]);
      const r = await run(["--agent", "claude"], JSON.stringify(claude("ls")), dir);
      expect(r.stdout).toBe(CLAUDE_ASK);
      expect(r.signal).toBe("SIGKILL");
      expect(r.ms).toBeLessThan(IN_TIME_MS);
    },
  );

  it("step-aside: the sentinel from a repository's settings does not silence it", async () => {
    // The sentinel is set, but no AgentTrail OS record exists, so the worker reports that
    // guard enforces, and the slow rule then hangs the check.
    const r = await run(["--agent", "claude"], JSON.stringify(claude(SLOW_TEXT)), home(), {
      AGENTTRAIL_PEP_ENFORCE: "1",
    });
    expect(r.stdout).toBe(CLAUDE_ASK);
  });

  it("step-aside: every check passes, so guard stands down, even with a slow rule", async () => {
    const dir = home();
    const project = join(dir, "work", "app");
    mkdirSync(join(project, ".claude"), { recursive: true });
    const origin = "https://api.agenttrail.sh";
    const token = "dlv_ingest_test";
    const source = { source: "directory", path: join(dir, "npm", "cli", "plugin") };
    const files: Record<string, unknown> = {
      [enforcedProjectsPath(dir)]: {
        version: 1,
        entries: [
          {
            projectRoot: project,
            scope: "project",
            apiOrigin: origin,
            pluginId: OS_PLUGIN_ID,
            marketplaceSource: source,
            tokenFingerprint: tokenFingerprint(token),
            writtenAt: "2026-10-26T20:00:00.000Z",
          },
        ],
      },
      // What AgentTrail OS's setup writes: this machine's sentinel, in the project's local
      // settings.
      [join(project, ".claude", "settings.local.json")]: { env: { AGENTTRAIL_PEP_ENFORCE: "1" } },
      [join(dir, ".claude", "settings.json")]: { enabledPlugins: { [OS_PLUGIN_ID]: true } },
      [join(dir, ".claude", "plugins", "installed_plugins.json")]: {
        version: 2,
        plugins: { [OS_PLUGIN_ID]: [{ scope: "user", version: "0.2.4" }] },
      },
      [join(dir, ".claude", "plugins", "known_marketplaces.json")]: {
        agenttrail: {
          source: { path: source.path, source: "directory" },
          installLocation: source.path,
        },
      },
    };
    mkdirSync(source.path, { recursive: true });
    for (const [path, value] of Object.entries(files)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value));
    }
    const r = await run(
      ["--agent", "claude"],
      JSON.stringify({ ...claude(SLOW_TEXT), cwd: project }),
      dir,
      {
        AGENTTRAIL_PEP_ENFORCE: "1",
        AGENTTRAIL_PEP_URL: `${origin}/api/v1/policies/evaluate`,
        AGENTTRAIL_PEP_TOKEN: token,
        CLAUDE_PROJECT_DIR: project,
      },
    );
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(HOOK_DEADLINE_MS);
  });

  it("the bundle started as the hook's worker runs the check only, and prints nothing", async () => {
    const dir = home(false);
    const worker = new Worker(HOOK_BUNDLE, {
      workerData: {
        role: HOOK_WORKER_ROLE,
        input: JSON.stringify(claude(DENIED_COMMAND)),
        agent: "claude",
        cwd: dir,
        home: dir,
      } satisfies HookWorkerInput,
      stdout: true,
      stderr: true,
    });
    let printed = "";
    worker.stdout.on("data", (chunk) => {
      printed += String(chunk);
    });
    const messages: unknown[] = [];
    worker.on("message", (message) => messages.push(message));
    await new Promise((resolve) => worker.on("exit", resolve));
    const answers = messages.filter((m) => (m as { kind?: string }).kind === "answer");
    expect(answers).toHaveLength(1);
    expect(String((answers[0] as { text: string }).text)).toContain('"permissionDecision":"deny"');
    expect(printed).toBe("");
  });
});

/** A force-push, assembled so no destructive command appears whole in this file. */
const DENIED_COMMAND = ["git", "push", "--force", "origin", "main"].join(" ");
