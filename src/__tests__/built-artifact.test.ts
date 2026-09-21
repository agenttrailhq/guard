/**
 * The BUILT ARTIFACT — greps over the bundle, and the acceptance criteria run
 * against the real file Claude Code executes.
 *
 * Source-only tests cannot see the two failures that matter most here. The bundle is
 * a CHECKED-IN artifact (Claude Code needs a real file to invoke), so a source fix
 * without a rebuild would leave every source test green while the stale bytes keep
 * running on a user's machine. And
 * the exit-code invariant is a property of the emitted JavaScript, not of the TS.
 *
 * So the bundle is REBUILT from current source in `beforeAll` and the assertions
 * bind to those bytes. If this suite reds, run `pnpm build`.
 *
 * ── This suite does NOT detect a stale checked-in bundle ────────────────────
 * Read the paragraph above carefully before relying on it for that: rebuilding
 * in `beforeAll` OVERWRITES the committed bytes before any assertion runs, so
 * the staleness it names as the motivating failure is precisely the one thing
 * it cannot see. It proves the SOURCE is right. What proves the committed bytes
 * are right is the `bundle-freshness` CI job (`scripts/bundle-freshness-gate.sh`),
 * which builds and then `git diff`s the artifact.
 *
 * ── Why the grep is `process.exit(` rather than `exit(2)` ────────────────────
 * Exit 2 is Claude Code's blocking signal and overrides the JSON decision, including
 * `allow` (`hooks.md:798`). A literal `exit(2)` grep would miss `process.exit(code)`
 * behind a variable and `process.exitCode = 2` — both of which reach the same place.
 * Asserting the bundle contains NO exit call at all is a structural guarantee rather
 * than a pattern someone has to remember to extend.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { NOT_CHECKED_MESSAGE } from "../commands/hook.js";
import { silenceCommand } from "../commands/status.js";
import { RELAY_INSTRUCTION } from "../core/cursor-emit.js";
import { PRODUCT_NOTE } from "../core/report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const HOOK_BUNDLE = join(PKG_ROOT, "plugin", "scripts", "guard-hook.mjs");
const CLI_BUNDLE = join(PKG_ROOT, "dist", "cli.js");
const SCAN_BUNDLE = join(PKG_ROOT, "plugin", "scripts", "guard-scan.mjs");
const TSUP_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsup");

beforeAll(() => {
  execFileSync(TSUP_BIN, [], { cwd: PKG_ROOT, stdio: "pipe" });
}, 180_000);

/**
 * A new, empty HOME for one run of the hook.
 *
 * The hook writes a decision-log line for every matched decision and a crash record for
 * input it cannot read, both under HOME. Each run gets its own, so no run writes to the
 * home of the process running the tests, and no two runs share a log.
 */
function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "agenttrail-guard-hook-home-"));
}

/** The environment for a child process whose home folder is `home`, on every platform. */
function envWithHome(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

/** One run of the hook, and the HOME it ran in. */
interface HookRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly home: string;
}

/**
 * Run the hook bundle with a payload on stdin, and any arguments after the script, in
 * `home` (a new scratch HOME unless one is given).
 */
function runHook(input: string, args: readonly string[] = [], home = scratchHome()): HookRun {
  const r = spawnSync("node", [HOOK_BUNDLE, ...args], {
    input,
    encoding: "utf8",
    env: envWithHome(home),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, home };
}

/** Run `agenttrail-guard hook` from the built CLI, in `home` (a new scratch HOME unless given). */
function runCliHook(input: string, home = scratchHome()): HookRun {
  const r = spawnSync("node", [CLI_BUNDLE, "hook"], {
    input,
    encoding: "utf8",
    env: envWithHome(home),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, home };
}

/** The decision-log lines a run wrote under `home`. */
function loggedLines(home: string): Record<string, unknown>[] {
  const log = join(home, ".agenttrail", "guard", "events.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/** The crash records a run spooled under `home`. */
function spooledCrashes(home: string): string[] {
  const dir = join(home, ".agenttrail", "guard", "crashes");
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** The permission decision on stdout, or `none` when there is none. */
function decisionOf(stdout: string): string {
  if (stdout === "") return "none";
  return JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? "none";
}

/** The `systemMessage` on stdout, if any. */
function messageOf(stdout: string): string | undefined {
  return stdout === "" ? undefined : JSON.parse(stdout).systemMessage;
}

describe("the shipped bundles exist and are self-contained", () => {
  it("every artifact is built", () => {
    expect(existsSync(HOOK_BUNDLE)).toBe(true);
    expect(existsSync(CLI_BUNDLE)).toBe(true);
    expect(existsSync(SCAN_BUNDLE)).toBe(true);
  });

  it("the hook bundle inlines picomatch, so it runs with zero node_modules", () => {
    expect(readFileSync(HOOK_BUNDLE, "utf8")).toContain("picomatch");
  });

  it("the hook bundle carries NO zod — the whole point of not importing ./context", () => {
    // The hook path imports schema modules for types only (`bundle-graph.test.ts`), so
    // esbuild erases them and zod never reaches this bundle.
    const bundle = readFileSync(HOOK_BUNDLE, "utf8");
    expect(bundle).not.toContain("ZodError");
    expect(bundle).not.toContain("ZodType");
  });

  it("the hook bundle DOES carry the real 74-rule corpus", () => {
    // The other half of the wiring, asserted against the shipped bytes: without
    // this, deleting the `@agenttrail/guardrails` import would leave every source
    // test green and ship a guard that enforces nothing.
    const bundle = readFileSync(HOOK_BUNDLE, "utf8");
    for (const id of [
      "wt.reset-hard",
      "dd.rm-rf-absolute",
      "block-env-file-read",
      "fs.system-paths",
    ]) {
      expect(bundle, `${id} is missing from the bundle`).toContain(id);
    }
  });
});

describe("always exit 0, never exit 2 (structural, over the bundle)", () => {
  // Rule fixtures ship in the catalog as command strings, and one legitimately reads
  // `sed -i 's/process.exit(1)/process.exit(0)/'`. That is DATA, not a call. Strip string
  // literals before scanning for an exit call — real code never puts one inside quotes,
  // so a genuine `process.exit(` in guard's own code still survives and is caught.
  const codeOf = (bundle: string): string =>
    bundle.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "");

  it("the HOOK bundle contains no process.exit call at all", () => {
    expect(codeOf(readFileSync(HOOK_BUNDLE, "utf8"))).not.toMatch(/process\s*\.\s*exit\s*\(/);
  });

  it("the HOOK bundle never assigns process.exitCode", () => {
    expect(codeOf(readFileSync(HOOK_BUNDLE, "utf8"))).not.toMatch(/exitCode/);
  });

  it("the HOOK bundle contains no literal exit(2) in any spelling", () => {
    const bundle = codeOf(readFileSync(HOOK_BUNDLE, "utf8"));
    expect(bundle).not.toMatch(/exit\s*\(\s*2\s*\)/);
    expect(bundle).not.toMatch(/exitCode\s*=\s*2/);
  });

  it("the CLI bundle never calls process.exit either", () => {
    // The CLI may set a non-zero exitCode for a genuine usage error, but it must
    // never call `exit()` — that is the call that can carry a 2.
    expect(codeOf(readFileSync(CLI_BUNDLE, "utf8"))).not.toMatch(/process\s*\.\s*exit\s*\(/);
  });
});

describe("at most one JSON object on stdout, nothing else", () => {
  // Each input with what it must produce: a decision, a message with no decision, or
  // no output at all.
  const cases: [string, "decision" | "message" | "none"][] = [
    [JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }), "decision"],
    [JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), "none"],
    [JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/a/.env" } }), "message"],
    [JSON.stringify({ tool_name: "WebFetch", tool_input: { url: "http://x.test" } }), "none"],
    ["not json at all", "message"],
    ["", "message"],
    ["[]", "message"],
  ];

  it.each(cases)("stdout for %s is: %s", (input, expected) => {
    const { stdout } = runHook(input);
    if (expected === "none") {
      expect(stdout).toBe("");
      return;
    }
    const trimmed = stdout.trim();
    expect(trimmed.startsWith("{")).toBe(true);
    expect(trimmed.endsWith("}")).toBe(true);
    // Anything appended would still start `{` and end `}` yet fail to parse, and
    // Claude Code would treat the whole thing as plain text and run the tool.
    expect(() => JSON.parse(trimmed)).not.toThrow();
    expect(stdout).toBe(trimmed);
    const parsed = JSON.parse(trimmed);
    if (expected === "decision") {
      expect(parsed).toHaveProperty("hookSpecificOutput.permissionDecision");
    } else {
      expect(parsed).toEqual({ systemMessage: expect.any(String) });
    }
  });

  it("never answers allow, which would skip Claude Code's own permission prompt", () => {
    for (const [input] of cases) {
      expect(runHook(input).stdout).not.toContain('"permissionDecision":"allow"');
    }
  });

  it("writes nothing to stderr", () => {
    // stderr from a hook that exits 0 goes to a debug log the user never sees
    // (`hooks.md:794`), so it is not a channel — it is just noise risk.
    for (const [input] of cases) {
      expect(runHook(input).stderr).toBe("");
    }
  });

  it.each(cases)("with --agent claude, stdout for %s is unchanged", (input) => {
    // `plugin/hooks/hooks.json` runs the bundle with `--agent claude`. The flag must
    // change nothing Claude Code sees: not the answer, the exit code, or stderr.
    const withFlag = runHook(input, ["--agent", "claude"]);
    expect(withFlag.stdout).toBe(runHook(input).stdout);
    expect(withFlag.status).toBe(0);
    expect(withFlag.stderr).toBe("");
  });
});

describe("acceptance criteria, against the file Claude Code actually runs", () => {
  it("`rm -rf /` → deny, exit 0", () => {
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }));
    expect(decisionOf(r.stdout)).toBe("deny");
    expect(r.status).toBe(0);
  });

  it("`rm -rf ./node_modules` → no output, exit 0", () => {
    const r = runHook(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf ./node_modules" } }),
    );
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it.each([
    ["malformed stdin", "not json"],
    ["empty stdin", ""],
    ["array payload", "[]"],
    ["truncated json", '{"tool_name":'],
  ])("%s → no decision, a not-checked message, exit 0 and never 2", (_l, input) => {
    const r = runHook(input);
    expect(decisionOf(r.stdout)).toBe("none");
    expect(messageOf(r.stdout)).toBe(NOT_CHECKED_MESSAGE);
    expect(r.status).toBe(0);
    expect(r.status).not.toBe(2);
  });

  it("a Windows-shaped path matches a forward-slash guardrail", () => {
    // The probe needs a file rule that produces a decision: `block-env-file-read` is
    // `warn`, which produces none, and asserting "no decision" would pass whether or not
    // separator normalization worked at all.
    //
    // `se.credential-file` is a file rule at `require_approval`, so the probe proves a
    // backslash path reaching a forward-slash glob, and fails if `normalizePathSeparators`
    // stops.
    const r = runHook(
      JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "C:\\Users\\dev\\.ssh\\id_rsa" },
      }),
    );
    expect(decisionOf(r.stdout)).toBe("ask");
    expect(r.status).toBe(0);
  });

  it("NEGATIVE CONTROL — the same guardrail gives no decision on a path it should not match", () => {
    // Without this, the assertion above would also pass for a rule that asked on everything.
    const r = runHook(
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "C:\\project\\src\\main.ts" } }),
    );
    expect(decisionOf(r.stdout)).toBe("none");
    expect(r.status).toBe(0);
  });

  it("a PowerShell call is intercepted and evaluated", () => {
    const r = runHook(
      JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "git reset --hard" } }),
    );
    expect(decisionOf(r.stdout)).toBe("deny");
    expect(r.status).toBe(0);
  });

  it("a WebFetch call gets no decision — v1 ships no website guardrails", () => {
    const r = runHook(
      JSON.stringify({ tool_name: "WebFetch", tool_input: { url: "http://x.test/rm -rf /" } }),
    );
    expect(decisionOf(r.stdout)).toBe("none");
    expect(r.status).toBe(0);
  });

  it("exits 0 on EVERY input shape, including ones designed to break it", () => {
    const nasty = [
      "",
      "null",
      "[]",
      '{"tool_name":{"$":1}}',
      `{"tool_name":"Bash","tool_input":{"command":"${"x".repeat(200_000)}"}}`,
      '{"tool_name":"mcp__a__b","tool_input":{"deep":{"deep":{"deep":"danger"}}}}',
    ];
    for (const input of nasty) {
      expect(runHook(input).status).toBe(0);
    }
  });
});

describe("Cursor calls, against the built hook run with --agent cursor", () => {
  const CURSOR_FIXTURES = join(HERE, "fixtures", "cursor");
  const FIXTURE_FILES = readdirSync(CURSOR_FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort();

  /** A recorded Cursor payload, by file name without `.json`. */
  const recorded = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(CURSOR_FIXTURES, `${name}.json`), "utf8"));

  /** The recorded `preToolUse` `Shell` payload, with another command. */
  const shellCall = (command: string): string => {
    const payload = recorded("pre-tool-use-shell");
    return JSON.stringify({
      ...payload,
      tool_input: { ...(payload.tool_input as object), command },
    });
  };

  /** The recorded `beforeShellExecution` payload, with another command. */
  const shellExecution = (command: string): string =>
    JSON.stringify({ ...recorded("before-shell-execution"), command });

  /** A recorded `preToolUse` payload, with another `tool_input.file_path`. */
  const withPath = (name: string, file_path: string): string => {
    const payload = recorded(name);
    return JSON.stringify({
      ...payload,
      tool_input: { ...(payload.tool_input as object), file_path },
    });
  };

  /**
   * Run the bundle the way a Cursor hook entry runs it, in `home` (a new scratch HOME when
   * none is given).
   */
  function cursorHook(
    input: string,
    home = scratchHome(),
    flag: readonly string[] = ["--agent", "cursor"],
  ): HookRun {
    return runHook(input, flag, home);
  }

  /** Cursor's answer: one object and nothing around it, exit 0, stderr empty, never allow. */
  function answerOf(r: {
    status: number | null;
    stdout: string;
    stderr: string;
  }): Record<string, unknown> {
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.startsWith("{")).toBe(true);
    expect(r.stdout.endsWith("}")).toBe(true);
    expect(r.stdout).not.toContain('"permission":"allow"');
    expect(r.stdout).not.toMatch(/hookSpecificOutput|systemMessage/);
    const parsed = JSON.parse(r.stdout);
    expect(r.stdout).toBe(JSON.stringify(parsed));
    return parsed;
  }

  it("there are recorded payloads to run", () => {
    expect(FIXTURE_FILES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(FIXTURE_FILES)("the recorded %s, unchanged → {}, nothing logged", (file) => {
    const home = scratchHome();
    const r = cursorHook(readFileSync(join(CURSOR_FIXTURES, file), "utf8"), home);
    expect(answerOf(r)).toEqual({});
    expect(loggedLines(home)).toEqual([]);
    expect(spooledCrashes(home)).toEqual([]);
  });

  it("a recursive force-delete of / is denied at both checkpoints, and logged as cursor", () => {
    for (const input of [shellCall("rm -rf /"), shellExecution("rm -rf /")]) {
      const home = scratchHome();
      const answer = answerOf(cursorHook(input, home));
      expect(answer.permission).toBe("deny");
      expect(answer.agent_message).not.toBe(answer.user_message);
      expect(answer.agent_message).toBe(`${answer.user_message}${RELAY_INSTRUCTION}`);
      expect(String(answer.user_message)).toMatch(/^agenttrail-guard blocked this: /);
      expect(String(answer.user_message)).toMatch(/ \(guardrail [\w.-]+\)$/);
      const lines = loggedLines(home);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ tool: "Bash", decision: "deny", agent: "cursor" });
    }
  });

  it("`rm -rf ./node_modules` keeps Cursor's own approval: {} at both checkpoints", () => {
    expect(answerOf(cursorHook(shellCall("rm -rf ./node_modules")))).toEqual({});
    expect(answerOf(cursorHook(shellExecution("rm -rf ./node_modules")))).toEqual({});
  });

  it("a shell approval rule: {} at preToolUse, Cursor's ask at beforeShellExecution, one line", () => {
    const home = scratchHome();
    expect(answerOf(cursorHook(shellCall("rm -rf ./src"), home))).toEqual({});
    const ask = answerOf(cursorHook(shellExecution("rm -rf ./src"), home));
    expect(ask.permission).toBe("ask");
    expect(String(ask.user_message)).toMatch(/^agenttrail-guard needs a person to approve this: /);
    expect(String(ask.user_message)).toMatch(/ \(guardrail [\w.-]+\)$/);
    expect(loggedLines(home).map((line) => [line.decision, line.agent])).toEqual([
      ["ask", "cursor"],
    ]);
  });

  it("a non-shell approval rule is denied with the approval message", () => {
    for (const name of ["pre-tool-use-read", "pre-tool-use-write"]) {
      const answer = answerOf(cursorHook(withPath(name, "/home/user/.ssh/id_rsa")));
      expect(answer.permission).toBe("deny");
      expect(String(answer.user_message)).toMatch(
        /^agenttrail-guard needs a person to approve this, and Cursor cannot ask: /,
      );
      expect(String(answer.user_message)).toMatch(/ \(guardrail [\w.-]+\)$/);
      // The agent is told to relay the sentence, and NEITHER message echoes the path it
      // judged — the message carries the guardrail's title and id and nothing else.
      expect(answer.agent_message).toBe(`${answer.user_message}${RELAY_INSTRUCTION}`);
      for (const text of [answer.user_message, answer.agent_message]) {
        expect(String(text)).not.toContain("/home/user/.ssh/id_rsa");
        expect(String(text)).not.toContain("/home/user/.ssh");
      }
    }
  });

  it("a Delete reaches the file rules: a system path is denied, the recorded path is not", () => {
    const home = scratchHome();
    expect(
      answerOf(cursorHook(withPath("pre-tool-use-delete", "/etc/hosts"), home)).permission,
    ).toBe("deny");
    expect(loggedLines(home).map((line) => [line.tool, line.agent])).toEqual([
      ["Delete", "cursor"],
    ]);
    expect(answerOf(cursorHook(JSON.stringify(recorded("pre-tool-use-delete"))))).toEqual({});
  });

  it("a .env Read is answered {} and logged once, as cursor", () => {
    const home = scratchHome();
    expect(
      answerOf(cursorHook(withPath("pre-tool-use-read", "/home/user/project/.env"), home)),
    ).toEqual({});
    const lines = loggedLines(home);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "Read", decision: "allow", agent: "cursor" });
  });

  it("a Grep for **/.env under the recorded folder is logged once, naming the joined path", () => {
    const home = scratchHome();
    const payload = recorded("pre-tool-use-grep-folder");
    const input = JSON.stringify({
      ...payload,
      tool_input: { ...(payload.tool_input as object), glob: "**/.env" },
    });
    expect(answerOf(cursorHook(input, home))).toEqual({});
    const lines = loggedLines(home);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: "Grep",
      agent: "cursor",
      command: "/home/user/project/**/.env",
    });
  });

  it("unreadable input → {}, exit 0, and a crash record in the local spool", () => {
    for (const input of ["not json at all", "", "[]"]) {
      const home = scratchHome();
      expect(answerOf(cursorHook(input, home))).toEqual({});
      expect(spooledCrashes(home)).toHaveLength(1);
      expect(loggedLines(home)).toEqual([]);
    }
  });

  it("an event the guard does not check → {}, nothing logged, no crash record", () => {
    const home = scratchHome();
    const input = JSON.stringify({
      ...recorded("before-read-file"),
      file_path: "/home/user/.ssh/id_rsa",
    });
    expect(answerOf(cursorHook(input, home))).toEqual({});
    expect(loggedLines(home)).toEqual([]);
    expect(spooledCrashes(home)).toEqual([]);
  });

  it("--agent=cursor is read the same way", () => {
    expect(
      answerOf(cursorHook(shellCall("rm -rf /"), undefined, ["--agent=cursor"])).permission,
    ).toBe("deny");
  });

  it("exits 0 with one object on every input shape, including ones designed to break it", () => {
    const nasty = [
      "",
      "null",
      "[]",
      '{"hook_event_name":{"$":1}}',
      JSON.stringify({ hook_event_name: "beforeShellExecution", command: "x".repeat(200_000) }),
      JSON.stringify({
        hook_event_name: "preToolUse",
        tool_name: "MCP:a",
        tool_input: { deep: { deep: { deep: "danger" } } },
      }),
      JSON.stringify({
        hook_event_name: "preToolUse",
        tool_name: "Grep",
        tool_input: { file_path: "", glob: "" },
      }),
    ];
    for (const input of nasty) answerOf(cursorHook(input));
  });

  // ── The same bundle run as guard's Claude Code plugin, handed Cursor's payload ──
  // Every case runs in a scratch HOME, so this machine's own `~/.cursor/hooks.json` and
  // decision log are never read or written.

  /** Run the bundle the way guard's Claude Code plugin runs it, in `home`. */
  const claudeCopy = (input: string, home: string) =>
    cursorHook(input, home, ["--agent", "claude"]);

  /** Write `<home>/.cursor/hooks.json` with a guard entry under each of `events`. */
  function writeCursorHooks(home: string, events: readonly string[]): void {
    const copy = join(home, ".agenttrail", "guard", "cursor", "guard-hook.mjs");
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(copy)} --agent cursor`;
    const hooks: Record<string, unknown> = { afterFileEdit: [{ command: "./format.sh" }] };
    for (const event of events) hooks[event] = [{ command, timeout: 10 }];
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks }));
  }

  /** Approval rules: a terminal command at both checkpoints, and a file read. */
  const APPROVALS: [string, () => string][] = [
    ["preToolUse Shell", () => shellCall("rm -rf ./src")],
    ["beforeShellExecution", () => shellExecution("rm -rf ./src")],
    ["preToolUse Read", () => withPath("pre-tool-use-read", "/home/user/.ssh/id_rsa")],
  ];

  it.each(
    APPROVALS,
  )("--agent claude, no ~/.cursor/hooks.json: a %s approval → the approval deny, logged once as cursor", (_label, input) => {
    const home = scratchHome();
    const answer = answerOf(claudeCopy(input(), home));
    expect(answer.permission).toBe("deny");
    expect(answer.agent_message).not.toBe(answer.user_message);
    expect(answer.agent_message).toBe(`${answer.user_message}${RELAY_INSTRUCTION}`);
    expect(String(answer.user_message)).toMatch(
      /^agenttrail-guard needs a person to approve this, and Cursor cannot ask: /,
    );
    expect(String(answer.user_message)).toMatch(/ \(guardrail [\w.-]+\)$/);
    expect(loggedLines(home).map((line) => [line.decision, line.agent])).toEqual([
      ["ask", "cursor"],
    ]);
    expect(spooledCrashes(home)).toEqual([]);
  });

  it.each(
    APPROVALS,
  )("--agent claude, both guard entries in hooks.json: a %s approval → {}, nothing logged", (_label, input) => {
    const home = scratchHome();
    writeCursorHooks(home, ["preToolUse", "beforeShellExecution"]);
    expect(answerOf(claudeCopy(input(), home))).toEqual({});
    expect(loggedLines(home)).toEqual([]);
    expect(spooledCrashes(home)).toEqual([]);
  });

  it.each([
    "preToolUse",
    "beforeShellExecution",
  ])("--agent claude, only the %s guard entry counts as absent: the approval is denied", (event) => {
    const home = scratchHome();
    writeCursorHooks(home, [event]);
    const answer = answerOf(claudeCopy(shellCall("rm -rf ./src"), home));
    expect(answer.permission).toBe("deny");
    expect(String(answer.user_message)).toMatch(
      /^agenttrail-guard needs a person to approve this, and Cursor cannot ask: /,
    );
    expect(loggedLines(home)).toHaveLength(1);
  });

  it("--agent claude: a recursive force-delete of / is denied either way, logged only without the Cursor entry", () => {
    const absent = scratchHome();
    expect(answerOf(claudeCopy(shellCall("rm -rf /"), absent)).permission).toBe("deny");
    expect(loggedLines(absent).map((line) => [line.decision, line.agent])).toEqual([
      ["deny", "cursor"],
    ]);

    const present = scratchHome();
    writeCursorHooks(present, ["preToolUse", "beforeShellExecution"]);
    expect(answerOf(claudeCopy(shellCall("rm -rf /"), present)).permission).toBe("deny");
    expect(loggedLines(present)).toEqual([]);
  });

  it("both installed, one approval: the Cursor entry asks, the Claude Code plugin answers {}, one line", () => {
    const home = scratchHome();
    writeCursorHooks(home, ["preToolUse", "beforeShellExecution"]);
    expect(answerOf(cursorHook(shellExecution("rm -rf ./src"), home)).permission).toBe("ask");
    expect(answerOf(claudeCopy(shellExecution("rm -rf ./src"), home))).toEqual({});
    expect(loggedLines(home).map((line) => [line.decision, line.agent])).toEqual([
      ["ask", "cursor"],
    ]);
  });

  it.each(
    FIXTURE_FILES,
  )("--agent claude, the recorded %s unchanged → {}, nothing logged", (file) => {
    const home = scratchHome();
    expect(answerOf(claudeCopy(readFileSync(join(CURSOR_FIXTURES, file), "utf8"), home))).toEqual(
      {},
    );
    expect(loggedLines(home)).toEqual([]);
    expect(spooledCrashes(home)).toEqual([]);
  });

  it("--agent claude: unreadable input keeps Claude Code's not-checked message", () => {
    for (const input of ["not json at all", "", "[]"]) {
      const home = scratchHome();
      const r = claudeCopy(input, home);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).not.toContain('"permission"');
      expect(messageOf(r.stdout)).toBe(NOT_CHECKED_MESSAGE);
      expect(spooledCrashes(home)).toHaveLength(1);
    }
  });
});

describe("the CLI honours the same contract for `hook`", () => {
  it("`rm -rf /` via `agenttrail-guard hook` → deny, exit 0", () => {
    const r = runCliHook(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    );
    expect(decisionOf(r.stdout)).toBe("deny");
    expect(r.status).toBe(0);
  });

  it("a malformed payload through the CLI still exits 0", () => {
    const r = runCliHook("garbage");
    expect(decisionOf(r.stdout)).toBe("none");
    expect(messageOf(r.stdout)).toBe(NOT_CHECKED_MESSAGE);
    expect(r.status).toBe(0);
  });

  it("no command reports itself as unimplemented — the list is empty", () => {
    // Kept inverted, so a reintroduced "not yet implemented" branch is visible here.
    const r = spawnSync("node", [CLI_BUNDLE, "--help"], { encoding: "utf8" });
    expect(r.stdout).not.toContain("Not yet implemented");
    expect(r.stdout).toContain("agenttrail-guard scan");
    expect(r.status).toBe(0);
  });

  it("`guardrails` is dispatched by the shipped binary, not reported as planned", () => {
    const r = spawnSync("node", [CLI_BUNDLE, "guardrails", "list"], { encoding: "utf8" });
    expect(r.stdout).not.toContain("not implemented yet");
    expect(r.stdout).toContain("guardrails across");
    expect(r.status).toBe(0);
  });

  it("the older `rules` spelling still reaches the same command, in the shipped bytes", () => {
    // The alias is only worth keeping if it survives the bundler, and this is the one
    // place that can say so — `cli.test.ts` proves the branch, not the artifact.
    const r = spawnSync("node", [CLI_BUNDLE, "rules", "list"], { encoding: "utf8" });
    expect(r.stdout).toContain("guardrails across");
    expect(r.status).toBe(0);
  });
});

/**
 * A finding worth pinning to the shipped bytes.
 *
 * The hook once never read `guardrails.json`: `init` seeded it, `status` counted it and
 * printed "(N of them yours)", the README documented it — and a rule a user wrote
 * enforced nothing. In-process reasoning said it worked, which is exactly why
 * this is asserted against the built bundle in a child process instead.
 */
describe("a guardrail the user wrote actually enforces", () => {
  /** A throwaway HOME with a guard directory in it. */
  function scratchHome(): string {
    const home = mkdtempSync(join(tmpdir(), "agenttrail-guard-rules-"));
    mkdirSync(join(home, ".agenttrail", "guard"), { recursive: true });
    return home;
  }

  const FRIDAY = {
    id: "local.no-deploy-friday",
    category: "prod-infra",
    severity: "medium",
    defaultAction: "block",
    title: "Confirm before deploying",
    match: {
      any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./deploy.sh"] }],
    },
  };

  function hookIn(home: string, command: string) {
    const r = spawnSync("node", [HOOK_BUNDLE], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      env: envWithHome(home),
    });
    return { decision: decisionOf(r.stdout), status: r.status };
  }

  it("blocks the command the guardrail names, through the built hook bundle", () => {
    const home = scratchHome();
    writeFileSync(join(home, ".agenttrail", "guard", "guardrails.json"), JSON.stringify([FRIDAY]));
    const r = hookIn(home, "./deploy.sh prod");
    expect(r.decision).toBe("deny");
    // Still exit 0 — the invariant the rest of this file guards.
    expect(r.status).toBe(0);
  });

  it("NEGATIVE CONTROL: does not stop an unrelated command with the same guardrail installed", () => {
    // Without this, the assertion above would pass for a rule that denied everything.
    const home = scratchHome();
    writeFileSync(join(home, ".agenttrail", "guard", "guardrails.json"), JSON.stringify([FRIDAY]));
    expect(hookIn(home, "ls -la").decision).toBe("none");
  });

  it("NEGATIVE CONTROL: does not stop that same command when the guardrail is NOT installed", () => {
    // Proves the deny above came from the user's rule and not from a shipped one.
    const home = scratchHome();
    expect(hookIn(home, "./deploy.sh prod").decision).toBe("none");
  });

  it.each([
    ["an empty match object", {}],
    ["top-level conditions instead of any_of", { tool_in: ["Bash"], detail_contains: ["deploy"] }],
  ])("REGRESSION: a rule with %s does not block everything", (_name, match) => {
    // `evaluate` ANDs the arms it recognizes, so a match carrying none of them has nothing
    // to fail and would be satisfied by every call: a rule meant to catch one command would
    // become "block every Bash command on this machine". Fail-DANGEROUS in a package whose
    // every other failure mode is fail-open.
    //
    // Asserted against the shipped bytes.
    const home = scratchHome();
    writeFileSync(
      join(home, ".agenttrail", "guard", "guardrails.json"),
      JSON.stringify([
        { id: "usr.unreadable", category: "prod-infra", defaultAction: "block", title: "t", match },
      ]),
    );
    expect(hookIn(home, "echo hello").decision).toBe("none");
    expect(hookIn(home, "ls -la").decision).toBe("none");
  });

  it("REGRESSION: the shipped catalog still enforces alongside a discarded user guardrail", () => {
    // The discard must not become a way to disable the guard: dropping the user's rule
    // leaves everything else running.
    const home = scratchHome();
    writeFileSync(
      join(home, ".agenttrail", "guard", "guardrails.json"),
      JSON.stringify([
        {
          id: "usr.unreadable",
          category: "prod-infra",
          defaultAction: "block",
          title: "t",
          match: {},
        },
      ]),
    );
    expect(hookIn(home, "rm -rf /").decision).toBe("deny");
  });

  it("a broken guardrails.json does not take the shipped catalog down with it", () => {
    const home = scratchHome();
    writeFileSync(join(home, ".agenttrail", "guard", "guardrails.json"), "{not json at all");
    // The shipped rule still fires, and the hook still exits 0.
    const r = hookIn(home, "rm -rf /");
    expect(r.decision).toBe("deny");
    expect(r.status).toBe(0);
  });

  it("`guardrails add` then the hook — the whole path, end to end", () => {
    const home = scratchHome();
    const dir = join(home, ".agenttrail", "guard");
    const file = join(home, "friday.json");
    writeFileSync(file, JSON.stringify(FRIDAY));

    const add = spawnSync("node", [CLI_BUNDLE, "rules", "add", file, "--config", dir], {
      encoding: "utf8",
    });
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("Validated. Added local.no-deploy-friday");

    // The claim `add` prints — "N rules active" — is only true if the hook reads it.
    expect(hookIn(home, "./deploy.sh prod").decision).toBe("deny");
  });

  /**
   * The per-rule allowlist, against the shipped bytes — and a consequence of the
   * 56-rule catalog.
   *
   * `rm -rf /var/tmp/scratch` is matched by TWO rules: `dd.rm-rf-absolute`
   * denies an absolute-rooted recursive delete, and `require-approval-rm-rf` holds the
   * broader shape for approval. They are not duplicates — the second is a superset that
   * the first ESCALATES from ask to deny — but the allowlist is per-RULE, so silencing
   * one leaves the other firing, and the developer who ran the command `status`
   * suggested still gets a prompt.
   *
   * That is asserted here rather than smoothed over: `silenceCommand` names one rule id,
   * and one rule id is not always enough. Narrowing either rule to make this go away
   * would cost the `rm -rf /` deny.
   */
  it("`guardrails allow` silences ONE guardrail on ONE shape and leaves the rest firing", () => {
    const home = scratchHome();
    const dir = join(home, ".agenttrail", "guard");
    const silence = (rule: string, pattern: string) =>
      spawnSync("node", [CLI_BUNDLE, "rules", "allow", rule, pattern, "--config", dir], {
        encoding: "utf8",
      });

    expect(silence("dd.rm-rf-absolute", "rm -rf /var/tmp/scratch").status).toBe(0);
    // The DENY is gone — but the second rule still holds the same shape for
    // approval, which is exactly what "silences ONE rule" means.
    expect(hookIn(home, "rm -rf /var/tmp/scratch").decision).toBe("ask");

    expect(silence("require-approval-rm-rf", "rm -rf /var/tmp/scratch").status).toBe(0);
    // With both silenced, the shape is genuinely let through.
    expect(hookIn(home, "rm -rf /var/tmp/scratch").decision).toBe("none");

    // ...and the same rules still deny a different one. Per-SHAPE, not per-rule.
    expect(hookIn(home, "rm -rf /etc").decision).toBe("deny");
  });
});

describe("the line `status` prints survives a REAL shell", () => {
  /**
   * The authoritative round trip. `rules-command.test.ts` splits the line with a
   * hand-written helper; this feeds it to `/bin/sh` and compares what the CLI stored
   * against the command that went in. A quoting scheme can be self-consistent and
   * still wrong, and only a real shell settles it.
   */
  it.each([
    ["a plain command", "git reset --hard ./x"],
    ["a double quote", 'echo "hi"'],
    ["a shell variable", "rm -rf $DIR"],
    ["a single quote", "echo it's"],
    ["a backtick", "echo `date`"],
  ])("%s", (_name, command) => {
    const home = mkdtempSync(join(tmpdir(), "agenttrail-guard-quote-"));
    const dir = join(home, "guard");
    mkdirSync(dir, { recursive: true });

    // Exactly the line a user would copy out of `status`, run by a real shell.
    const line = silenceCommand("dd.rm-rf-absolute", command);
    const argv = line.replace(/^agenttrail-guard /, "");
    const r = spawnSync(
      "/bin/sh",
      ["-c", `node ${JSON.stringify(CLI_BUNDLE)} ${argv} --config ${JSON.stringify(dir)}`],
      {
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    // Byte for byte: the pattern stored is the command that was recorded.
    expect(config.allowlist[0].pattern).toBe(command);
  });

  it("--version prints the package version", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    const r = spawnSync("node", [CLI_BUNDLE, "--version"], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe(pkg.version);
    expect(r.status).toBe(0);
  });
});

/**
 * `scan` end to end, against the SHIPPED binary.
 *
 * The unit suites drive `runScan` in-process with a fake IO. This one runs the real
 * `dist/cli.js` against a real directory of real files and checks the artifact it
 * leaves behind — the only layer that can catch a bundling failure, a `node:` import
 * that does not survive tsup, or a report written to the wrong place.
 *
 * It lives in THIS file rather than a suite of its own on purpose: two suites already
 * rebuild the shared bundles in `beforeAll`, and `vitest.config.ts` serializes this
 * package's files because a third builder racing the others can break an unrelated
 * test. Reusing this file's build adds no builder.
 */
describe("scan, against the built binary", () => {
  /** A transcript with a repeat, a planted secret, and a real home-shaped path. */
  const TRANSCRIPT_LINES = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-09-08T00:00:00.000Z",
      sessionId: "built-1",
      cwd: "/Users/priya/clients/acme-secret-client/app",
      message: { role: "user", content: "tidy up" },
    }),
    ...["build", "dist"].map((dir, i) =>
      JSON.stringify({
        type: "assistant",
        uuid: `a${i}`,
        timestamp: "2026-09-08T00:00:01.000Z",
        sessionId: "built-1",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 },
          content: [
            {
              type: "tool_use",
              id: `t${i}`,
              name: "Bash",
              input: { command: `rm -rf /Users/priya/clients/acme-secret-client/${dir}` },
            },
          ],
        },
      }),
    ),
    JSON.stringify({
      type: "assistant",
      uuid: "a9",
      timestamp: "2026-09-08T00:00:02.000Z",
      sessionId: "built-1",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        usage: {},
        content: [
          {
            type: "tool_use",
            id: "t9",
            name: "Bash",
            input: { command: "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE" },
          },
        ],
      },
    }),
  ];

  /** Build a projects root plus an empty working directory, and return both. */
  function fixture(): { projects: string; work: string } {
    const base = mkdtempSync(join(tmpdir(), "agenttrail-guard-scan-"));
    const projects = join(base, "projects", "-Users-priya-clients-acme-secret-client-app");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "built-1.jsonl"), `${TRANSCRIPT_LINES.join("\n")}\n`, "utf8");
    const work = join(base, "work");
    mkdirSync(work, { recursive: true });
    return { projects: join(base, "projects"), work };
  }

  it("writes a report, prints a summary, and exits 0", () => {
    const { projects, work } = fixture();
    const r = spawnSync(
      "node",
      [CLI_BUNDLE, "scan", "--agent", "claude", "--dir", projects, "--no-open"],
      {
        cwd: work,
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("1 session");
    expect(r.stdout).toContain("Full report:");

    const report = join(work, "agenttrail-guard-report.html");
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, "utf8").startsWith("<!doctype html>")).toBe(true);
  });

  it("the written report carries no secret, no path and no project name", () => {
    // A planted secret appears as `[REDACTED]`, asserted on the bytes that actually reach
    // the disk rather than on a string in memory.
    const { projects, work } = fixture();
    spawnSync("node", [CLI_BUNDLE, "scan", "--agent", "claude", "--dir", projects, "--no-open"], {
      cwd: work,
      encoding: "utf8",
    });
    const html = readFileSync(join(work, "agenttrail-guard-report.html"), "utf8");

    expect(html).toContain("[REDACTED:");
    for (const leak of ["AKIAIOSFODNN7EXAMPLE", "priya", "acme-secret-client", "/Users/"]) {
      expect(html).not.toContain(leak);
    }
  });

  it("the written report references nothing outside itself and quotes no currency", () => {
    const { projects, work } = fixture();
    spawnSync("node", [CLI_BUNDLE, "scan", "--agent", "claude", "--dir", projects, "--no-open"], {
      cwd: work,
      encoding: "utf8",
    });
    const html = readFileSync(join(work, "agenttrail-guard-report.html"), "utf8");

    for (const banned of [/<script/i, /\ssrc\s*=/i, /@import/i, /url\s*\(/i]) {
      expect(html).not.toMatch(banned);
    }
    // A Claude Code report's one link is the product note's, and the set is exact.
    const links = [...html.matchAll(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );
    expect(links).toEqual([PRODUCT_NOTE.url]);
    // A currency WORD is banned everywhere; a currency SYMBOL only in the guard's own
    // chrome, because a real command legitimately contains `$?` or `${DB}` and
    // `redactPaths` preserves a shell variable on purpose. See `report.test.ts`.
    expect(html).not.toMatch(/\bUSD\b|\bdollars?\b|\bestimated\b|\brisk avoided\b/i);
    expect(html.replace(/<code>[\s\S]*?<\/code>/g, "")).not.toMatch(/[$£€¥]/);
  });

  it("--json prints a parseable payload and writes no file", () => {
    const { projects, work } = fixture();
    const r = spawnSync(
      "node",
      [CLI_BUNDLE, "scan", "--agent", "claude", "--dir", projects, "--json"],
      {
        cwd: work,
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(work, "agenttrail-guard-report.html"))).toBe(false);

    const payload = JSON.parse(r.stdout);
    expect(payload.tool).toBe("agenttrail-guard");
    expect(payload.result.sessions).toBe(1);
    // The two `rm -rf` calls differ only by path, so they are one shape seen twice.
    expect(payload.result.recurring[0].count).toBe(2);
    expect(payload.result.recurring[0].text).toBe("rm -rf <path>");
  });

  it("an empty projects root is an empty report, not an error", () => {
    const base = mkdtempSync(join(tmpdir(), "agenttrail-guard-empty-"));
    const r = spawnSync(
      "node",
      [CLI_BUNDLE, "scan", "--agent", "claude", "--dir", join(base, "nothing-here"), "--no-open"],
      { cwd: base, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No sessions found");
    expect(existsSync(join(base, "agenttrail-guard-report.html"))).toBe(true);
  });

  it("--agent cursor reads Cursor's session files and prints a parseable payload", () => {
    // The committed session fixture, copied to a scratch root, read by the built CLI with a
    // scratch HOME.
    const base = mkdtempSync(join(tmpdir(), "agenttrail-guard-cursor-scan-"));
    const projects = join(base, "projects");
    cpSync(join(HERE, "fixtures", "cursor", "projects"), projects, { recursive: true });
    const work = join(base, "work");
    mkdirSync(work, { recursive: true });
    const home = scratchHome();

    const r = spawnSync(
      "node",
      [CLI_BUNDLE, "scan", "--agent", "cursor", "--dir", projects, "--json"],
      { cwd: work, encoding: "utf8", env: envWithHome(home) },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(work, "agenttrail-guard-report.html"))).toBe(false);

    const payload = JSON.parse(r.stdout);
    expect(payload.tool).toBe("agenttrail-guard");
    expect(payload.result.agent).toBe("cursor");
    expect(payload.result.sessions).toBe(1);
    expect(payload.result.projects).toBe(1);
    // Seven actions in the session file and two in its sub-agent's; the to-do list is not one.
    expect(payload.result.toolCalls).toBe(9);
    expect(payload.result.tokens).toBeNull();
    expect(payload.result.skipped).toEqual({
      unparseableLines: 0,
      truncatedLastLines: 0,
      unknownRecords: 0,
      turnsEndedWithError: 1,
      unreadableFiles: 0,
      notActions: 1,
      unmappedTools: [],
    });
    expect(r.stdout).not.toContain("/home/user");
    // A scan writes nothing into HOME.
    expect(readdirSync(home)).toEqual([]);
  });

  it("makes no network call — proven on the bytes, not by inspection", () => {
    // `no-network.test.ts` proves it over the import graph, which is the statement
    // about ALL executions. This is the runtime corroboration on the shipped bundle:
    // the whole scan path runs with `fetch`, `http`, `https` and `net` replaced by
    // recorders that log and throw. `crash-runtime.test.ts` already proves that
    // preload catches a real `fetch`, so an empty log here is evidence and not just
    // an absence.
    const { projects, work } = fixture();
    const log = join(work, "net.log");
    writeFileSync(log, "");
    const r = spawnSync(
      "node",
      [
        "--import",
        join(HERE, "preload", "net-recorder.mjs"),
        CLI_BUNDLE,
        "scan",
        "--agent",
        "claude",
        "--dir",
        projects,
        "--no-open",
      ],
      { cwd: work, encoding: "utf8", env: { ...process.env, AGENTTRAIL_TEST_NET_LOG: log } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("");
  });

  // ── The plugin's scan-only bundle, as the share-report skill runs it ──────────
  const stripTimes = (path: string): string =>
    readFileSync(path, "utf8").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>");

  it("the plugin's scan bundle writes the same page content as the CLI", () => {
    const { projects, work } = fixture();
    const fromBundle = join(work, "bundle.html");
    const fromCli = join(work, "cli.html");
    const a = spawnSync(
      "node",
      [SCAN_BUNDLE, "--agent", "claude", "--dir", projects, "--artifact", "--out", fromBundle],
      { cwd: work, encoding: "utf8" },
    );
    const b = spawnSync(
      "node",
      [CLI_BUNDLE, "scan", "--agent", "claude", "--dir", projects, "--artifact", "--out", fromCli],
      { cwd: work, encoding: "utf8" },
    );
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    const page = stripTimes(fromBundle);
    expect(page.startsWith("<title>")).toBe(true);
    expect(page).not.toMatch(/<!doctype|<html\b|<head\b|<body\b/i);
    expect(page).toBe(stripTimes(fromCli));
  });

  it("the plugin's scan bundle takes a --review answer from stdin, as a terminal user gives it", () => {
    const { projects, work } = fixture();
    const out = join(work, "reviewed.html");
    const r = spawnSync(
      "node",
      [SCAN_BUNDLE, "--agent", "claude", "--dir", projects, "--review", "--artifact", "--out", out],
      { cwd: work, encoding: "utf8", input: "y\n" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Review — everything this report will contain.");
    expect(readFileSync(out, "utf8").startsWith("<title>")).toBe(true);
  });

  it("the plugin's scan bundle makes no network call either", () => {
    const { projects, work } = fixture();
    const log = join(work, "net.log");
    writeFileSync(log, "");
    const r = spawnSync(
      "node",
      [
        "--import",
        join(HERE, "preload", "net-recorder.mjs"),
        SCAN_BUNDLE,
        "--agent",
        "claude",
        "--dir",
        projects,
        "--no-open",
      ],
      { cwd: work, encoding: "utf8", env: { ...process.env, AGENTTRAIL_TEST_NET_LOG: log } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("");
  });
});

/**
 * Every run of the hook in this file gets its own scratch HOME, so a matched decision or a
 * crash record never lands in the home of the process running the tests.
 *
 * Kept last in the file on purpose: the check on `os.homedir()` then also covers every
 * earlier case, not just the runs made here.
 */
describe("hook runs in this file write only to their own scratch home", () => {
  it("a matched decision and a crash record land in the run's home, and nothing lands in os.homedir()", () => {
    const claudeDeny = JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    const cursorDeny = JSON.stringify({
      hook_event_name: "beforeShellExecution",
      cursor_version: "0.0.0",
      command: "rm -rf /",
    });
    const decisions = [
      runHook(claudeDeny),
      runHook(claudeDeny, ["--agent", "claude"]),
      runHook(cursorDeny, ["--agent", "cursor"]),
      runHook(cursorDeny, ["--agent", "claude"]),
      runCliHook(claudeDeny),
    ];
    for (const run of decisions) {
      expect(run.status).toBe(0);
      expect(run.home).not.toBe(homedir());
      expect(run.home).not.toBe(userInfo().homedir);
      // The positive half: without it, an empty os.homedir() would also pass for a hook
      // that logged nothing at all.
      expect(loggedLines(run.home).map((line) => line.decision)).toEqual(["deny"]);
    }

    const crash = runHook("not json at all");
    expect(spooledCrashes(crash.home)).toHaveLength(1);

    expect(existsSync(join(homedir(), ".agenttrail"))).toBe(false);
  });
});
