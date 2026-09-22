/**
 * `scan --agent codex`: Codex CLI's session files, read into sessions and evaluated.
 *
 * Driven in-process, over an in-memory folder tree except where the committed fixture is
 * read from disk. Every count is hand-computed against `TEST_CATALOG`, never read back out
 * of the shipped catalog.
 *
 * The extractor gets two blocks of its own. The first states what it reads; the second
 * feeds it the inputs built to break it, because it is the one piece of this reader that
 * parses an undocumented format someone else generates, and the failure that matters is
 * not a crash — it is a plausible-looking command that nobody ran. Every case in it
 * asserts either the exact command or `undefined`; none asserts "something came back".
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapCodexCall } from "../core/codex-mapper.js";
import { codexUsage, readCodexFile } from "../core/codex-transcript/parse.js";
import {
  CODEX_SHIM_TOOL,
  type CodexTranscriptIO,
  codexSessionCalls,
  defaultCodexSessionsRoot,
  mapCodexSessionTool,
  readCodexCorpus,
  readShimCalls,
} from "../core/codex-transcript/scan.js";
import { compileAllowlist } from "../core/evaluate.js";
import { MAX_DETAIL_LEN } from "../core/mapper.js";
import { renderJson, renderReport } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan } from "../core/scan-report.js";
import { EMPTY_TOKEN_TOTALS, totalTokens } from "../core/tokens.js";
import { createRealScanIO } from "../scan-io.js";
import { TEST_CATALOG, toolUse } from "./scan-fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "codex");
const CATALOG = compileCatalog(TEST_CATALOG);
const NO_ALLOWLIST = compileAllowlist([]);
const META = { version: "0.2.0", generatedAt: new Date("2026-09-21T09:00:00.000Z") };

/** The shim fragment Codex writes for one shell command. */
function execSource(command: string, workdir = "/home/user/project"): string {
  return (
    `const r = await tools.exec_command({cmd:${JSON.stringify(command)},` +
    `workdir:${JSON.stringify(workdir)},yield_time_ms:10000,max_output_tokens:1000});` +
    " text(r.output);\n"
  );
}

/** One session-file line. */
function line(
  type: string,
  payload: Record<string, unknown>,
  timestamp = "2026-09-21T09:00:00.000Z",
): string {
  return JSON.stringify({ timestamp, ordinal: 0, type, payload });
}

/** One `response_item` line holding a shim call. */
function callLine(source: string, timestamp?: string): string {
  return line(
    "response_item",
    { type: "custom_tool_call", call_id: "call_1", name: CODEX_SHIM_TOOL, input: source },
    timestamp,
  );
}

/** One `response_item` line holding a message. */
function messageLine(role: string, timestamp?: string): string {
  return line("response_item", { type: "message", role, content: [] }, timestamp);
}

/** One `token_usage_record` line. */
function usageLine(usage: Record<string, number>, timestamp?: string): string {
  return line("token_usage_record", { usage, turn_token_usage: usage }, timestamp);
}

/** One `session_meta` line. */
function metaLine(sessionId: string, cwd: string, timestamp?: string): string {
  return line(
    "session_meta",
    { session_id: sessionId, cwd, cli_version: "0.154.0", originator: "codex_exec" },
    timestamp,
  );
}

/** Lines from memory, the way `readCodexFile` reads a file. */
function linesOf(text: string): { readLines(path: string): AsyncIterable<string> } {
  return {
    async *readLines() {
      for (const item of text.split("\n")) yield item;
    },
  };
}

const OPTIONS = { timestamp: "2026-09-21T08:00:00.000Z", idPrefix: "s" };

// ── An in-memory folder tree ────────────────────────────────────────────────

interface FakeFile {
  readonly text: string;
  readonly mtimeMs?: number;
}

interface FakeTree {
  readonly dirs: Readonly<Record<string, readonly string[]>>;
  readonly files: Readonly<Record<string, string | FakeFile>>;
  /** Files whose reading fails after the first line, as a file that vanishes mid-read. */
  readonly failRead?: readonly string[];
  /** Paths whose `stat` fails, as a file without permission does. */
  readonly failStat?: readonly string[];
}

/** A `CodexTranscriptIO` over a tree, recording which files were opened. */
function treeIO(tree: FakeTree): CodexTranscriptIO & { readonly opened: string[] } {
  const opened: string[] = [];
  const fileAt = (path: string): FakeFile | undefined => {
    const file = tree.files[path];
    return typeof file === "string" ? { text: file } : file;
  };
  return {
    opened,
    readdir(path) {
      const entries = tree.dirs[path];
      if (entries === undefined) throw new Error(`ENOENT: ${path}`);
      return [...entries];
    },
    stat(path) {
      if (tree.failStat?.includes(path)) throw new Error(`EACCES: ${path}`);
      if (tree.dirs[path] !== undefined) return { mtimeMs: 0, isDirectory: () => true };
      const file = fileAt(path);
      if (file === undefined) throw new Error(`ENOENT: ${path}`);
      return { mtimeMs: file.mtimeMs ?? 1_758_000_000_000, isDirectory: () => false };
    },
    async *readLines(path) {
      opened.push(path);
      const file = fileAt(path);
      if (file === undefined) throw new Error(`ENOENT: ${path}`);
      const items = file.text.split("\n");
      if (tree.failRead?.includes(path)) {
        yield items[0] ?? "";
        throw new Error(`EIO: ${path}`);
      }
      for (const item of items) yield item;
    },
  };
}

const ROOT = "/home/test/.codex/sessions";
const DAY = `${ROOT}/2026/09/21`;
const NAME = "rollout-2026-09-21T09-44-38-00000000-0000-4000-8000-000000000041.jsonl";
const FILE = `${DAY}/${NAME}`;

/** A sessions root holding one day's folder with one session file in it. */
function sessionTree(main: string | FakeFile, extra: Partial<FakeTree> = {}): FakeTree {
  return {
    dirs: {
      [ROOT]: ["2026"],
      [`${ROOT}/2026`]: ["09"],
      [`${ROOT}/2026/09`]: ["21"],
      [DAY]: [NAME],
      ...extra.dirs,
    },
    files: { [FILE]: main, ...extra.files },
    failRead: extra.failRead,
    failStat: extra.failStat,
  };
}

// ── The tool mapping ────────────────────────────────────────────────────────

describe("each tool call in a session file is evaluated as the table says", () => {
  const map = (source: unknown, name: string = CODEX_SHIM_TOOL) =>
    mapCodexSessionTool(toolUse(name, { input: source }));

  it("a shell command is evaluated as Bash on the command it ran", () => {
    expect(map(execSource("rm -rf build"))).toEqual([
      { kind: "action", candidates: [{ tool: "Bash", args: { full_command: "rm -rf build" } }] },
    ]);
  });

  it("a patch is evaluated on the paths it names, as the live hook evaluates it", () => {
    const source =
      'const r = await tools.apply_patch("*** Begin Patch\\n' +
      '*** Add File: /home/user/a.txt\\n+hi\\n*** End Patch");\ntext(r);\n';
    expect(map(source)).toEqual([
      { kind: "action", candidates: [{ tool: "Write", args: { file_path: "/home/user/a.txt" } }] },
    ]);
  });

  it("a patch passed as an object names no path, so it is unmapped rather than unchecked", () => {
    // The object form carries the patch under a key the reader does not read, so there is
    // no text to take paths from. Unmapped says that plainly; an edit with an empty
    // channel would match nothing and read as though it had been checked.
    expect(map('await tools.apply_patch({patch:"*** Begin Patch"});')).toEqual([
      { kind: "unmapped", name: "apply_patch" },
    ]);
  });

  it("two calls in one fragment are two tool calls, so the second is not lost", () => {
    const source = `${execSource("ls")}${execSource("rm -rf build")}`;
    expect(map(source)).toEqual([
      { kind: "action", candidates: [{ tool: "Bash", args: { full_command: "ls" } }] },
      { kind: "action", candidates: [{ tool: "Bash", args: { full_command: "rm -rf build" } }] },
    ]);
  });

  it("a long command is end-capped, as the hook caps it", () => {
    const [call] = map(execSource("a".repeat(MAX_DETAIL_LEN + 500)));
    expect(call?.kind === "action" && call.candidates[0].args.full_command).toBe(
      "a".repeat(MAX_DETAIL_LEN),
    );
  });

  it.each([
    [
      "a shim function this reader does not know",
      'const r = await tools.launch_browser({url:"https://example.com"});',
      "launch_browser",
    ],
    [
      "a shell call with no command in its argument",
      'const r = await tools.exec_command({workdir:"/w"});',
      "exec_command",
    ],
    // Below here the FRAGMENT could not be read, so the function it named is not known to
    // have been the one that ran, and the call is counted under the shim's own name.
    [
      "a fragment whose argument is a variable",
      "const r = await tools.exec_command(options); text(r.output);",
      CODEX_SHIM_TOOL,
    ],
    [
      "a fragment whose command is not a string literal",
      'const r = await tools.exec_command({cmd:argv,workdir:"/w"});',
      CODEX_SHIM_TOOL,
    ],
    ["a fragment cut off mid-word", "const r = await tools.exec_comm", CODEX_SHIM_TOOL],
    ["a fragment that calls no tool", 'text("nothing to do");', CODEX_SHIM_TOOL],
  ])("%s is not recognized, and is counted under its own name", (_label, source, name) => {
    expect(map(source)).toEqual([{ kind: "unmapped", name }]);
  });

  it("a call whose input is not a string is not recognized", () => {
    expect(map({ cmd: "rm -rf /" })).toEqual([{ kind: "unmapped", name: CODEX_SHIM_TOOL }]);
    expect(map(undefined)).toEqual([{ kind: "unmapped", name: CODEX_SHIM_TOOL }]);
  });

  it("a tool that is not the shim is counted under the name the file gives it", () => {
    expect(map("", "shell_command")).toEqual([{ kind: "unmapped", name: "shell_command" }]);
    expect(map("", "")).toEqual([{ kind: "unmapped", name: "" }]);
  });

  it("nothing in this reader is ever a not-action, so nothing is silently dropped", () => {
    const sources = [execSource("ls"), 'tools.apply_patch("x")', "tools.nope({})", "??"];
    for (const source of sources) {
      for (const call of map(source)) expect(call.kind).not.toBe("not-action");
    }
  });
});

// ── The extractor: what it reads ────────────────────────────────────────────

describe("recovering the command from the shim's JavaScript", () => {
  it("reads the recorded form, and the workdir does not confuse it", () => {
    expect(readShimCalls(execSource("echo hello"))).toEqual([
      { fn: "exec_command", cmd: "echo hello" },
    ]);
  });

  it.each([
    ["an escaped quote", String.raw`tools.exec_command({cmd:"echo \"hi\""})`, 'echo "hi"'],
    ["an escaped backslash", String.raw`tools.exec_command({cmd:"grep \\d"})`, String.raw`grep \d`],
    ["a newline escape", String.raw`tools.exec_command({cmd:"a\nb"})`, "a\nb"],
    ["a tab escape", String.raw`tools.exec_command({cmd:"a\tb"})`, "a\tb"],
    ["a four-digit unicode escape", 'tools.exec_command({cmd:"caf\\u00e9"})', "café"],
    ["a braced unicode escape", String.raw`tools.exec_command({cmd:"\u{1f600}"})`, "\u{1f600}"],
    ["a raw non-ASCII character", 'tools.exec_command({cmd:"café ✓"})', "café ✓"],
    ["a quoted key", 'tools.exec_command({"cmd":"ls"})', "ls"],
    ["single quotes", "tools.exec_command({cmd:'ls'})", "ls"],
    ["whitespace everywhere", 'tools.exec_command(  {  cmd :  "ls"  ,  a : 1  }  )', "ls"],
    ["a trailing comma", 'tools.exec_command({cmd:"ls",})', "ls"],
    ["a nested object before it", 'tools.exec_command({opts:{a:1,b:"}"},cmd:"ls"})', "ls"],
    ["an array before it", 'tools.exec_command({env:[1,2,"}"],cmd:"ls"})', "ls"],
    ["a call as another value", 'tools.exec_command({at:now(1,2),cmd:"ls"})', "ls"],
    ["a line comment inside", 'tools.exec_command({\n// why\ncmd:"ls"})', "ls"],
    ["a block comment inside", 'tools.exec_command({/* why */cmd:"ls"})', "ls"],
  ])("%s", (_label, source, cmd) => {
    expect(readShimCalls(source)).toEqual([{ fn: "exec_command", cmd }]);
  });

  it("a bare property access is not a call", () => {
    expect(readShimCalls('const f = tools.exec_command; f({cmd:"ls"});')).toEqual([]);
  });

  it("a call with no argument is a call with no command", () => {
    expect(readShimCalls("tools.list_tools()")).toEqual([{ fn: "list_tools" }]);
  });

  it.each([
    ["another object's method", 'myTools.exec_command({cmd:"ls"})'],
    ["a nested property", 'shim.tools.exec_command({cmd:"ls"})'],
    ["a line comment", '// tools.exec_command({cmd:"ls"})'],
    ["a block comment", '/* tools.exec_command({cmd:"ls"}) */'],
    ["a string that looks like a call", 'text("tools.exec_command({cmd:\\"ls\\"})")'],
  ])("%s is not a shim call", (_label, source) => {
    expect(readShimCalls(source)).toEqual([]);
  });
});

// ── The extractor: what it refuses ──────────────────────────────────────────

describe("the extractor fails closed on every input it cannot read", () => {
  it.each([
    ["an unterminated string", 'tools.exec_command({cmd:"ls'],
    ["a string ending in a backslash", 'tools.exec_command({cmd:"ls\\'],
    ["an unterminated object", 'tools.exec_command({cmd:"ls"'],
    ["a template literal argument", "tools.exec_command({cmd:`ls`})"],
    ["a template literal elsewhere", 'const a = `x`; tools.exec_command({cmd:"ls"})'],
    ["a variable argument", "tools.exec_command(options)"],
    ["a spread", 'tools.exec_command({...base, cmd:"ls"})'],
    ["a computed key", 'tools.exec_command({[key]:1, cmd:"ls"})'],
    ["a missing colon", 'tools.exec_command({cmd "ls"})'],
    ["a missing comma", 'tools.exec_command({cmd:"ls" workdir:"/w"})'],
    ["the command given twice", 'tools.exec_command({cmd:"ls",cmd:"rm -rf /"})'],
    ["a command that is a call", "tools.exec_command({cmd:build()})"],
    ["a command that is a number", "tools.exec_command({cmd:1})"],
    ["a malformed unicode escape", String.raw`tools.exec_command({cmd:"\u00zz"})`],
    ["an unterminated braced escape", String.raw`tools.exec_command({cmd:"\u{1f600"})`],
    ["an out-of-range code point", String.raw`tools.exec_command({cmd:"\u{110000}"})`],
    ["a malformed hex escape", String.raw`tools.exec_command({cmd:"\xZZ"})`],
    ["an unterminated block comment", 'tools.exec_command({cmd:"ls"}); /* wait'],
  ])("%s", (_label, source) => {
    expect(readShimCalls(source)).toBeUndefined();
  });

  it("a command containing the shim's own syntax is one command, not two calls", () => {
    // The over-report this guards: a naive search would find the text inside the string
    // and report a second command that never ran.
    const source = execSource('echo "tools.exec_command({cmd:\\"rm -rf /\\"})"');
    expect(readShimCalls(source)).toEqual([
      { fn: "exec_command", cmd: 'echo "tools.exec_command({cmd:\\"rm -rf /\\"})"' },
    ]);
  });

  it("a command containing a closing brace and paren does not end the object early", () => {
    const source = 'tools.exec_command({cmd:"awk \'{print})\'",workdir:"/w"})';
    expect(readShimCalls(source)).toEqual([{ fn: "exec_command", cmd: "awk '{print})'" }]);
  });

  it("a fragment cut off mid-word names no call, so nothing is invented from half a name", () => {
    expect(readShimCalls("const r = await tools.exec_comm")).toEqual([]);
  });

  it("a fragment past the length cap is unreadable rather than slow", () => {
    const big = `${execSource("ls")}${"/* pad */".repeat(120_000)}`;
    expect(big.length).toBeGreaterThan(1_000_000);
    expect(readShimCalls(big)).toBeUndefined();
  });

  it("a long but readable fragment is still read, so the cap is not the reason above", () => {
    const padded = `${"// pad\n".repeat(1000)}${execSource("ls")}`;
    expect(padded.length).toBeLessThan(128 * 1024);
    expect(readShimCalls(padded)).toEqual([{ fn: "exec_command", cmd: "ls" }]);
  });

  it("never throws, whatever it is given", () => {
    const inputs = [
      "",
      "{",
      "}",
      '"',
      "\\",
      "tools.",
      "tools..x()",
      "tools.x(",
      "tools.x({",
      "tools.x({}",
      " ",
      "tools.exec_command({cmd:".repeat(500),
      "})".repeat(500),
    ];
    for (const input of inputs) expect(() => readShimCalls(input)).not.toThrow();
  });
});

// ── One file's lines ────────────────────────────────────────────────────────

describe("reading one session file", () => {
  it("keeps the session's own details, its prompts and its tool calls", async () => {
    const text = [
      metaLine("s-1", "/home/user/project", "2026-09-21T09:44:38.000Z"),
      messageLine("user", "2026-09-21T09:44:39.000Z"),
      messageLine("developer", "2026-09-21T09:44:39.000Z"),
      messageLine("assistant", "2026-09-21T09:44:40.000Z"),
      callLine(execSource("ls"), "2026-09-21T09:44:41.000Z"),
      usageLine(
        {
          input_tokens: 1200,
          cached_input_tokens: 900,
          cache_write_input_tokens: 100,
          output_tokens: 50,
        },
        "2026-09-21T09:44:42.000Z",
      ),
    ].join("\n");
    const records = await readCodexFile("x", linesOf(text), OPTIONS);

    expect(records.sessionId).toBe("s-1");
    expect(records.version).toBe("0.154.0");
    expect(records.cwd).toBe("/home/user/project");
    expect(records.firstTimestamp).toBe("2026-09-21T09:44:38.000Z");
    expect(records.lastTimestamp).toBe("2026-09-21T09:44:42.000Z");
    // Only the person's own message is a prompt: `developer` is the harness's instructions.
    expect(records.userPrompts).toHaveLength(1);
    expect(records.turns).toHaveLength(1);
    expect(records.turns[0]?.toolUses.map((u) => u.name)).toEqual([CODEX_SHIM_TOOL]);
    expect(records.turns[0]?.timestamp).toBe("2026-09-21T09:44:42.000Z");
    expect(records.turns[0]?.text).toBe("");
    expect(records.counts).toEqual({
      unparseableLines: 0,
      truncatedLastLines: 0,
      unknownRecords: 0,
      turnsEndedWithError: 0,
    });
  });

  it("closes a turn on the usage record that follows its calls, and flushes the rest at the end", async () => {
    const text = [
      callLine(execSource("one")),
      usageLine({ input_tokens: 100, output_tokens: 10 }),
      callLine(execSource("two")),
    ].join("\n");
    const records = await readCodexFile("x", linesOf(text), OPTIONS);
    expect(records.turns).toHaveLength(2);
    expect(records.turns[0]?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    // The trailing call is still read; a file cut off before its usage record loses nothing.
    expect(records.turns[1]?.usage).toEqual({});
    expect(records.turns[1]?.toolUses).toHaveLength(1);
  });

  it("reads the per-response usage and never the running totals", () => {
    // Measured: `usage` is one response's, `turn_token_usage` and `thread_token_usage` are
    // cumulative. Summing either would multiply the total by the number of responses.
    expect(
      codexUsage({
        input_tokens: 11_231,
        cached_input_tokens: 8960,
        cache_write_input_tokens: 0,
        output_tokens: 89,
        reasoning_output_tokens: 14,
        total_tokens: 11_320,
      }),
    ).toEqual({
      // The cached prefix is inside `input_tokens` there and is a category of its own here.
      input_tokens: 2271,
      output_tokens: 89,
      cache_read_input_tokens: 8960,
      cache_creation_input_tokens: 0,
    });
  });

  it("the token categories add up to the total Codex reported", () => {
    const usage = codexUsage({
      input_tokens: 11_231,
      cached_input_tokens: 8960,
      cache_write_input_tokens: 0,
      output_tokens: 89,
      reasoning_output_tokens: 14,
      total_tokens: 11_320,
    });
    const totals = {
      ...EMPTY_TOKEN_TOTALS,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
    };
    expect(totalTokens(totals)).toBe(11_320);
  });

  it.each([
    ["a missing usage object", undefined, {}],
    ["a usage that is not an object", "lots", {}],
    [
      "counts that are negative or not numbers",
      { input_tokens: -5, cached_input_tokens: "9", output_tokens: Number.NaN },
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ],
    [
      "a cached count larger than the input",
      { input_tokens: 10, cached_input_tokens: 40 },
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 0,
      },
    ],
  ])("%s yields no negative count", (_label, usage, expected) => {
    expect(codexUsage(usage)).toEqual(expected);
  });

  it("counts a cut-off last line apart from a bad line in the middle", async () => {
    const truncated = await readCodexFile(
      "x",
      linesOf(
        [messageLine("user"), callLine(execSource("ls")), '{"timestamp":"2026', ""].join("\n"),
      ),
      OPTIONS,
    );
    expect(truncated.counts).toMatchObject({ truncatedLastLines: 1, unparseableLines: 0 });

    const middle = await readCodexFile(
      "x",
      linesOf([messageLine("user"), "not json", callLine(execSource("ls"))].join("\n")),
      OPTIONS,
    );
    expect(middle.counts).toMatchObject({ truncatedLastLines: 0, unparseableLines: 1 });
    expect(middle.turns).toHaveLength(1);
  });

  it("counts every record of a kind it does not know, and no record it knows", async () => {
    const unknown = [
      line("some_future_record", {}),
      line("response_item", { type: "some_future_item" }),
      "[1,2]",
      "42",
      JSON.stringify({ timestamp: "x", payload: {} }),
    ];
    const known = [
      line("event_msg", { type: "item_completed", item: { type: "CommandExecution" } }),
      line("world_state", { full: true }),
      line("turn_context", { model: "test-model" }),
      line("response_item", { type: "reasoning", id: "r" }),
      line("response_item", { type: "custom_tool_call_output", call_id: "call_1", output: [] }),
      line("response_item", { type: "message", role: "assistant", content: [] }),
    ];
    const records = await readCodexFile("x", linesOf([...unknown, ...known].join("\n")), OPTIONS);
    expect(records.counts.unknownRecords).toBe(unknown.length);
    expect(records.turns).toEqual([]);
  });

  it("does not read a completed command, which would double-count the call that made it", async () => {
    // Measured: a call a hook blocked writes a `custom_tool_call` and no `item_completed`,
    // so the attempt is the record of the action and the completed item is a duplicate.
    const text = [
      callLine(execSource("rm -rf build")),
      line("event_msg", {
        type: "item_completed",
        item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "rm -rf build"] },
      }),
    ].join("\n");
    const records = await readCodexFile("x", linesOf(text), OPTIONS);
    const calls = [...codexSessionCalls({ ...emptySession(), turns: records.turns })];
    expect(calls).toHaveLength(1);
  });

  it("stamps a record that carries no time, and never fails the file for it", async () => {
    const records = await readCodexFile(
      "x",
      linesOf(
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
      ),
      OPTIONS,
    );
    expect(records.userPrompts[0]?.timestamp).toBe(OPTIONS.timestamp);
  });

  it("lets a failure of the file itself reach the caller", async () => {
    const failing = {
      // biome-ignore lint/correctness/useYield: the source fails before any line.
      async *readLines(): AsyncIterable<string> {
        throw new Error("EACCES");
      },
    };
    await expect(readCodexFile("x", failing, OPTIONS)).rejects.toThrow("EACCES");
  });
});

/** A parsed session with nothing in it, for tests that replace one field. */
function emptySession() {
  return {
    sessionId: "s",
    version: null,
    gitBranch: null,
    cwd: null,
    turns: [],
    userPrompts: [],
    toolResults: new Map(),
    firstTimestamp: "",
    lastTimestamp: "",
    skippedLines: 0,
  };
}

// ── The folder walk ─────────────────────────────────────────────────────────

describe("finding and reading sessions", () => {
  const SESSION = [
    metaLine("s-1", "/home/user/project"),
    messageLine("user"),
    callLine(execSource("rm -rf /home/user/project/build")),
    usageLine({ input_tokens: 500, cached_input_tokens: 200, output_tokens: 40 }),
  ].join("\n");

  it("defaults to ~/.codex/sessions", () => {
    expect(defaultCodexSessionsRoot("/home/test")).toBe(join("/home/test", ".codex", "sessions"));
  });

  it("reads one file as one session, named and dated by what the file says", async () => {
    const io = treeIO(sessionTree({ text: SESSION, mtimeMs: 1_758_000_000_000 }));
    const corpus = await readCodexCorpus(ROOT, io);

    expect(io.opened).toEqual([FILE]);
    expect(corpus).toMatchObject({ agent: "codex", quarantined: 0, notRead: 0, projects: 1 });
    expect(corpus.capabilities).toEqual({ tokens: true, skips: true });
    expect(corpus.sessions).toHaveLength(1);
    const [session] = corpus.sessions;
    expect(session?.sessionId).toBe("s-1");
    expect(session?.version).toBe("0.154.0");
    expect(session?.cwd).toBe("/home/user/project");
    expect(session?.firstTimestamp).toBe("2026-09-21T09:00:00.000Z");
  });

  it("falls back to the file's name and time when the file carries neither", async () => {
    const text = [messageLine("user"), callLine(execSource("ls"))]
      .map((l) => l.replace(/"timestamp":"[^"]*",/, ""))
      .join("\n");
    const corpus = await readCodexCorpus(
      ROOT,
      treeIO(sessionTree({ text, mtimeMs: 1_758_000_000_000 })),
    );
    const [session] = corpus.sessions;
    expect(session?.sessionId).toBe(NAME.slice(0, -".jsonl".length));
    expect(session?.firstTimestamp).toBe(new Date(1_758_000_000_000).toISOString());
  });

  it("counts distinct working directories as the project count, never their names", async () => {
    const tree: FakeTree = {
      dirs: {
        [ROOT]: ["2026"],
        [`${ROOT}/2026`]: ["09"],
        [`${ROOT}/2026/09`]: ["20", "21"],
        [`${ROOT}/2026/09/20`]: ["a.jsonl", "b.jsonl"],
        [`${ROOT}/2026/09/21`]: ["c.jsonl"],
      },
      files: {
        [`${ROOT}/2026/09/20/a.jsonl`]: SESSION,
        // The same working directory again: one project, not two.
        [`${ROOT}/2026/09/20/b.jsonl`]: SESSION,
        [`${ROOT}/2026/09/21/c.jsonl`]: [
          metaLine("s-3", "/home/user/other"),
          messageLine("user"),
        ].join("\n"),
      },
    };
    const corpus = await readCodexCorpus(ROOT, treeIO(tree));
    expect(corpus.sessions).toHaveLength(3);
    expect(corpus.projects).toBe(2);
    expect(JSON.stringify(corpus.projects)).not.toContain("home");
  });

  it("counts a file it cannot read, and keeps the sessions it could", async () => {
    const tree = sessionTree(SESSION, {
      dirs: { [DAY]: [NAME, "other.jsonl"] },
      files: { [`${DAY}/other.jsonl`]: SESSION },
      failRead: [`${DAY}/other.jsonl`],
    });
    const corpus = await readCodexCorpus(ROOT, treeIO(tree));
    expect(corpus.skipped?.unreadableFiles).toBe(1);
    expect(corpus.sessions).toHaveLength(1);
  });

  it("counts a session file whose details cannot be read", async () => {
    const corpus = await readCodexCorpus(ROOT, treeIO(sessionTree(SESSION, { failStat: [FILE] })));
    expect(corpus.sessions).toEqual([]);
    expect(corpus.skipped?.unreadableFiles).toBe(1);
  });

  it("counts a readable file holding no message as yielding no session", async () => {
    const corpus = await readCodexCorpus(
      ROOT,
      treeIO(sessionTree(["not json", metaLine("s-1", "/home/user/project")].join("\n"))),
    );
    expect(corpus.sessions).toEqual([]);
    expect(corpus.quarantined).toBe(1);
    expect(corpus.projects).toBe(0);
    expect(corpus.skipped?.unparseableLines).toBe(1);
  });

  it.each([
    ["an empty sessions folder", { dirs: { [ROOT]: [] }, files: {} }],
    ["a missing sessions folder", { dirs: {}, files: {} }],
    [
      "a year folder with no days in it",
      { dirs: { [ROOT]: ["2026"], [`${ROOT}/2026`]: ["09"], [`${ROOT}/2026/09`]: [] }, files: {} },
    ],
  ])("%s is an empty corpus, not an error", async (_label, tree) => {
    const corpus = await readCodexCorpus(ROOT, treeIO(tree));
    expect(corpus).toMatchObject({ sessions: [], quarantined: 0, notRead: 0, projects: 0 });
  });

  it("does not open a .jsonl file outside the layout, and counts it as not read", async () => {
    const tree = sessionTree(SESSION, {
      dirs: {
        [ROOT]: ["2026", "loose.jsonl"],
        [`${ROOT}/2026`]: ["09", "stray.jsonl"],
        [DAY]: [NAME, "deeper"],
        [`${DAY}/deeper`]: ["nested.jsonl"],
      },
      files: {
        [`${ROOT}/loose.jsonl`]: SESSION,
        [`${ROOT}/2026/stray.jsonl`]: SESSION,
        [`${DAY}/deeper/nested.jsonl`]: SESSION,
      },
    });
    const io = treeIO(tree);
    const corpus = await readCodexCorpus(ROOT, io);
    expect(io.opened).toEqual([FILE]);
    expect(corpus.sessions).toHaveLength(1);
    expect(corpus.notRead).toBe(3);
  });
});

// ── What is not evaluated ───────────────────────────────────────────────────

describe("the skipped count and list, and the token totals", () => {
  it("counts every kind, lists unrecognized tools by name, and reports real tokens", async () => {
    const text = [
      metaLine("s-1", "/home/user/project"),
      "not json",
      line("some_future_record", {}),
      callLine(execSource("rm -rf /home/user/project/build")),
      callLine("const r = await tools.unknown_tool({});"),
      callLine("const r = await tools.unknown_tool({});"),
      callLine("const r = await tools.exec_command(options);"),
      usageLine({
        input_tokens: 1200,
        cached_input_tokens: 900,
        cache_write_input_tokens: 100,
        output_tokens: 50,
      }),
      '{"timestamp":"2026',
    ].join("\n");
    const corpus = await readCodexCorpus(ROOT, treeIO(sessionTree(text)));
    const result = aggregateScan(corpus, CATALOG, NO_ALLOWLIST);

    expect(result.agent).toBe("codex");
    expect(result.toolCalls).toBe(1);
    expect(result.riskyActions).toBe(1);
    expect(result.skippedLines).toBe(2);
    expect(result.skipped).toMatchObject({
      unparseableLines: 1,
      truncatedLastLines: 1,
      unknownRecords: 1,
      turnsEndedWithError: 0,
      unreadableFiles: 0,
      notActions: 0,
    });
    expect(result.skipped?.unmappedTools).toEqual([
      { name: "unknown_tool", count: 2 },
      { name: "exec", count: 1 },
    ]);
    // Codex's files record token counts, so the totals are real rather than withheld.
    // 1200 input tokens, of which 900 were cache reads and 100 cache writes.
    expect(result.tokens).toMatchObject({
      input: 200,
      output: 50,
      cacheRead: 900,
      cacheCreation: 100,
    });
    expect(totalTokens(result.tokens ?? EMPTY_TOKEN_TOTALS)).toBe(1250);
  });

  it("a patch is counted among the tool calls and matches nothing", async () => {
    const text = [
      metaLine("s-1", "/home/user/project"),
      callLine(
        'await tools.apply_patch("*** Begin Patch\\n*** Add File: /home/user/x\\n+rm -rf /\\n*** End Patch");',
      ),
      usageLine({ input_tokens: 10, output_tokens: 1 }),
    ].join("\n");
    const result = aggregateScan(
      await readCodexCorpus(ROOT, treeIO(sessionTree(text))),
      CATALOG,
      NO_ALLOWLIST,
    );
    expect(result.toolCalls).toBe(1);
    expect(result.riskyActions).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

// ── The report ──────────────────────────────────────────────────────────────

describe("a Codex report", () => {
  const text = [
    metaLine("s-1", "/home/user/clients/acme"),
    messageLine("user"),
    callLine(execSource("rm -rf /Users/priya/clients/acme/build", "/Users/priya/clients/acme")),
    usageLine({ input_tokens: 900, cached_input_tokens: 400, output_tokens: 60 }),
    callLine(execSource("rm -rf /Users/priya/clients/beta/dist", "/Users/priya/clients/beta")),
    callLine("const r = await tools.unknown_tool({});"),
    '{"timestamp":"2026',
  ].join("\n");

  async function codexResult(tree: FakeTree = sessionTree(text)) {
    return aggregateScan(await readCodexCorpus(ROOT, treeIO(tree)), CATALOG, NO_ALLOWLIST);
  }

  it("names Codex CLI, and its review hint names --agent codex", async () => {
    const html = renderReport(await codexResult(), META);
    expect(html).toContain('<p class="agent">Agent: Codex CLI</p>');
    expect(html).toContain("<code>agenttrail-guard scan --agent codex --review</code>");
  });

  it("keeps its token section, because Codex's files record token counts", async () => {
    const html = renderReport(await codexResult(), META);
    expect(html).toContain("<h2>Tokens</h2>");
    expect(html).not.toContain("record no token counts");
  });

  it("lists what was not evaluated, by kind and by tool name", async () => {
    const html = renderReport(await codexResult(), META);
    expect(html).toContain("<h2>What was not evaluated</h2>");
    expect(html).toContain("<li>1 file whose last line was cut off</li>");
    expect(html).toContain("<code>unknown_tool</code>");
  });

  it("states its own coverage limit, naming the folders Codex files sessions in", async () => {
    const tree = sessionTree(text, {
      dirs: { [ROOT]: ["2026", "loose.jsonl"] },
      files: { [`${ROOT}/loose.jsonl`]: text },
    });
    const html = renderReport(await codexResult(tree), META);
    expect(html).toContain("<strong>Coverage limit.</strong>");
    expect(html).toContain(
      "<code>~/.codex/sessions/&lt;year&gt;/&lt;month&gt;/&lt;day&gt;/</code>",
    );
    expect(html).toContain(
      "1 further transcript file elsewhere under the sessions root was not read.",
    );
  });

  it("carries no path or working directory, in the HTML or the JSON", async () => {
    const result = await codexResult();
    const json = JSON.parse(renderJson(result, META));
    expect(json.result.recurring[0]).toMatchObject({ text: "rm -rf <path>", count: 2 });
    for (const out of [renderReport(result, META), renderJson(result, META)]) {
      for (const leak of ["priya", "acme", "/Users/", "/home/user/"]) {
        expect(out).not.toContain(leak);
      }
    }
  });
});

// ── The committed fixture, from disk ────────────────────────────────────────

describe("the committed session fixture, read from disk", () => {
  const FIXTURE_ROOT = join(FIXTURES, "sessions");

  it("is one session per file, across two days and two working directories", async () => {
    const corpus = await readCodexCorpus(FIXTURE_ROOT, createRealScanIO());
    expect(corpus).toMatchObject({ agent: "codex", quarantined: 0, notRead: 0, projects: 2 });
    expect(corpus.sessions).toHaveLength(2);
    expect(corpus.sessions.map((s) => s.version)).toEqual(["0.154.0", "0.154.0"]);
    // Read in folder order, oldest day first.
    expect(corpus.sessions[0]?.firstTimestamp).toBe("2026-09-20T11:02:10.000Z");
  });

  it("gives the hand-computed findings", async () => {
    const result = aggregateScan(
      await readCodexCorpus(FIXTURE_ROOT, createRealScanIO()),
      CATALOG,
      NO_ALLOWLIST,
    );
    // Two deletes, a patch and a discard of uncommitted work. The shim function this
    // reader does not know, and the fragment it cannot read, are not tool calls.
    expect(result.toolCalls).toBe(4);
    expect(result.riskyActions).toBe(3);
    expect(result.findings.map((f) => [f.ruleId, f.count])).toEqual([
      ["t.rm-rf", 2],
      ["t.git-checkout", 1],
    ]);
    expect(result.recurring.map((r) => [r.text, r.count])).toEqual([["rm -rf <path>", 2]]);
    expect(result.skipped).toMatchObject({
      unparseableLines: 1,
      truncatedLastLines: 1,
      unknownRecords: 1,
      turnsEndedWithError: 0,
      unreadableFiles: 0,
      notActions: 0,
      unmappedTools: [
        { name: "exec", count: 1 },
        { name: "unknown_tool", count: 1 },
      ],
    });
  });

  it("gives the hand-computed token totals, summed from the per-response usage only", async () => {
    const result = aggregateScan(
      await readCodexCorpus(FIXTURE_ROOT, createRealScanIO()),
      CATALOG,
      NO_ALLOWLIST,
    );
    // Uncached input is what is left of each response's input after its cache reads and
    // cache writes: (1200-900-100) + (800-600) + (400-300). The running totals beside each
    // record are not added, and the four categories come to the totals Codex reported
    // (1250 + 840 + 420).
    expect(result.tokens).toMatchObject({
      input: 500,
      output: 110,
      cacheRead: 1800,
      cacheCreation: 100,
      turnsWithSplit: 0,
    });
    expect(totalTokens(result.tokens ?? EMPTY_TOKEN_TOTALS)).toBe(2510);
  });

  it("the files on disk are the ones these counts were computed from", () => {
    // A fixture replaced wholesale would otherwise pass every count above by accident.
    const files = [
      join(
        FIXTURE_ROOT,
        "2026",
        "09",
        "20",
        "rollout-2026-09-20T11-02-10-00000000-0000-4000-8000-000000000032.jsonl",
      ),
      join(
        FIXTURE_ROOT,
        "2026",
        "09",
        "21",
        "rollout-2026-09-21T09-44-38-00000000-0000-4000-8000-000000000031.jsonl",
      ),
    ];
    for (const file of files) expect(statSync(file).isFile()).toBe(true);
  });
});

describe("an edit reads the same way in a report as it did when it was attempted", () => {
  // The live hook is given the patch as `tool_input.command`; a session file holds the
  // same patch inside the shim's `tools.apply_patch("…")`. Both sides parse it with
  // `patchCandidates`, so a guardrail written against a file path cannot fire in one and
  // stay silent in the other — which would make a report read as "nothing happened".
  const PATCH =
    "*** Begin Patch\n" +
    "*** Add File: /home/user/project/.env\n" +
    "+SECRET=1\n" +
    "*** Update File: /home/user/project/src/app.ts\n" +
    "+// edited\n" +
    "*** End Patch";

  /** The shim fragment Codex writes for one patch. */
  function patchSource(patch: string): string {
    return `await tools.apply_patch(${JSON.stringify(patch)});\n`;
  }

  it("names every path the patch touches, as the hook's mapper does", () => {
    const call = mapCodexSessionTool(toolUse(CODEX_SHIM_TOOL, { input: patchSource(PATCH) }))[0];
    expect(call?.kind).toBe("action");
    const paths =
      call?.kind === "action" ? call.candidates.map((candidate) => candidate.args.file_path) : [];
    expect(paths).toEqual(["/home/user/project/.env", "/home/user/project/src/app.ts"]);
  });

  it("agrees with the live hook's mapper on the same patch", () => {
    const scanned = mapCodexSessionTool(toolUse(CODEX_SHIM_TOOL, { input: patchSource(PATCH) }))[0];
    const live = mapCodexCall({
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: PATCH },
      turn_id: "turn_1",
      model: "gpt-5",
    } as never);
    expect(scanned?.kind).toBe("action");
    expect(live).toBeDefined();
    const scannedCandidates = scanned?.kind === "action" ? scanned.candidates : [];
    expect(scannedCandidates).toEqual([...(live?.candidates ?? [])]);
  });

  it("is unmapped, not an edit with nothing to check, when the patch names no path", () => {
    const empty = patchSource("*** Begin Patch\n+just content\n*** End Patch");
    const call = mapCodexSessionTool(toolUse(CODEX_SHIM_TOOL, { input: empty }))[0];
    expect(call).toEqual({ kind: "unmapped", name: "apply_patch" });
  });
});
