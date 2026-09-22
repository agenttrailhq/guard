/**
 * The mapper: two channels, and the deliberate absences.
 *
 * The absences matter as much as the mappings here. `WebFetch` yielding no channel
 * and no `url` key ever being emitted are BOTH deliberate, and a future reader "fixing"
 * either would silently reintroduce a channel the engine cannot read.
 */

import { describe, expect, it } from "vitest";
import {
  capEnd,
  capMiddle,
  MAX_DETAIL_LEN,
  mapToolCall,
  TRUNCATION_MARKER,
} from "../core/mapper.js";

describe("mapper — the channel table", () => {
  it.each(["Bash", "PowerShell"])("%s.command → full_command", (tool) => {
    expect(mapToolCall({ tool_name: tool, tool_input: { command: "rm -rf /" } })).toEqual({
      tool,
      args: { full_command: "rm -rf /" },
    });
  });

  it.each(["Edit", "Write", "Read", "MultiEdit"])("%s.file_path → file_path", (tool) => {
    expect(mapToolCall({ tool_name: tool, tool_input: { file_path: "/a/.env" } })).toEqual({
      tool,
      args: { file_path: "/a/.env" },
    });
  });

  it("NotebookEdit.notebook_path → file_path", () => {
    expect(
      mapToolCall({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/a/n.ipynb" } }),
    ).toEqual({ tool: "NotebookEdit", args: { file_path: "/a/n.ipynb" } });
  });

  it("WebSearch.query → full_command (a query is text, not a website)", () => {
    expect(
      mapToolCall({ tool_name: "WebSearch", tool_input: { query: "how to drop a table" } }),
    ).toEqual({ tool: "WebSearch", args: { full_command: "how to drop a table" } });
  });

  it("mcp__* → full_command from the serialized input", () => {
    const out = mapToolCall({
      tool_name: "mcp__server__tool",
      tool_input: { a: 1, b: "x" },
    });
    expect(out.tool).toBe("mcp__server__tool");
    expect(out.args.full_command).toBe('{"a":1,"b":"x"}');
    expect(out.args.file_path).toBeUndefined();
  });
});

describe("mapper — Grep and Glob reach files, so they map to file_path", () => {
  it.each([
    ["Grep with a folder and a glob", { path: "/repo", glob: "*.env" }, "/repo/*.env"],
    ["Glob with a folder and a pattern", { path: "/repo", pattern: "**/.env" }, "/repo/**/.env"],
    ["a folder with no glob", { path: "/repo/secrets" }, "/repo/secrets"],
    ["a glob with no folder", { glob: "**/.env" }, "**/.env"],
    ["an absolute glob, which a folder cannot prefix", { path: "/repo", glob: "/etc/*" }, "/etc/*"],
    ["a trailing separator, collapsed to one", { path: "/repo/", glob: "*.env" }, "/repo/*.env"],
    ["an empty folder, which counts as absent", { path: "", glob: "*.env" }, "*.env"],
  ])("%s", (_label, input, expected) => {
    // One call, most specific form: this mapper yields a single call, unlike Cursor's,
    // which carries candidates. See the header's stated residual.
    const tool = "glob" in input ? "Grep" : "Glob";
    expect(mapToolCall({ tool_name: tool, tool_input: input })).toEqual({
      tool,
      args: { file_path: expected },
    });
  });

  it("never reads Grep's own pattern, which is a regex over file CONTENT", () => {
    // `pattern` is the glob for `Glob` and the search expression for `Grep`. Reading
    // Grep's as a path would evaluate the user's search string against file rules.
    const out = mapToolCall({
      tool_name: "Grep",
      tool_input: { pattern: "AWS_SECRET_ACCESS_KEY", path: "/repo" },
    });
    expect(out.args.file_path).toBe("/repo");
  });

  it("carries no command channel, whatever else is in the payload", () => {
    const out = mapToolCall({
      tool_name: "Grep",
      tool_input: { path: "/repo", glob: "*.env", command: "rm -rf /" },
    });
    expect(out.args.full_command).toBeUndefined();
  });

  it.each(["Grep", "Glob"])("%s with neither field yields no channel", (tool) => {
    expect(mapToolCall({ tool_name: tool, tool_input: {} }).args).toEqual({});
  });

  it("is intercepted by the shipped matcher — mapping without that changes nothing", () => {
    // The mapper and the matcher are two halves of one fix: a branch here for a tool the
    // hook never receives is dead code. `plugin.test.ts` pins the matcher itself.
    const matcher = /Bash|PowerShell|Edit|Write|Read|NotebookEdit|Grep|Glob|WebSearch|mcp__.*/;
    expect(matcher.test("Grep")).toBe(true);
    expect(matcher.test("Glob")).toBe(true);
  });
});

describe("mapper — WebFetch is NOT intercepted", () => {
  it("yields no channel at all, so nothing can match and the call is allowed", () => {
    expect(mapToolCall({ tool_name: "WebFetch", tool_input: { url: "http://x.test/" } })).toEqual({
      tool: "WebFetch",
      args: {},
    });
  });

  it("does not route the url onto the command channel", () => {
    const out = mapToolCall({ tool_name: "WebFetch", tool_input: { url: "rm -rf /" } });
    expect(out.args.full_command).toBeUndefined();
  });
});

describe("mapper — no `url` key is ever emitted (the engine cannot read one)", () => {
  const payloads = [
    { tool_name: "Bash", tool_input: { command: "curl http://x.test", url: "http://x.test" } },
    { tool_name: "WebFetch", tool_input: { url: "http://x.test" } },
    { tool_name: "Read", tool_input: { file_path: "/a", url: "http://x.test" } },
    { tool_name: "mcp__s__t", tool_input: { url: "http://x.test" } },
    { tool_name: "Unknown", tool_input: { url: "http://x.test" } },
  ];

  it.each(payloads)("no url key for $tool_name", (payload) => {
    expect(Object.keys(mapToolCall(payload).args)).not.toContain("url");
  });

  it("an MCP field literally NAMED url is just serialized text, not a routed channel", () => {
    const out = mapToolCall({ tool_name: "mcp__s__t", tool_input: { url: "http://x.test" } });
    expect(out.args.full_command).toBe('{"url":"http://x.test"}');
  });
});

describe("mapper — MultiEdit stays classified as a file tool", () => {
  it("maps to file_path and never opens a command channel", () => {
    const out = mapToolCall({
      tool_name: "MultiEdit",
      tool_input: { file_path: "/a/.env", command: "rm -rf /" },
    });
    expect(out.args).toEqual({ file_path: "/a/.env" });
  });

  it("is still intercepted by the matcher, because Edit substring-matches it", () => {
    // This is why dropping MultiEdit from FILE_TOOLS would be a bug even though it
    // is absent from the matcher's literal alternatives.
    expect(
      /Bash|PowerShell|Edit|Write|Read|NotebookEdit|Grep|Glob|WebSearch|mcp__.*/.test("MultiEdit"),
    ).toBe(true);
  });
});

describe("mapper — malformed payloads yield no channel (fail-open starts here)", () => {
  it.each([
    ["no tool_name", {}],
    ["null tool_input", { tool_name: "Bash", tool_input: null }],
    ["tool_input not an object", { tool_name: "Bash", tool_input: "oops" }],
    ["command not a string", { tool_name: "Bash", tool_input: { command: 42 } }],
  ])("%s", (_label, payload) => {
    expect(mapToolCall(payload as never).args).toEqual({});
  });

  it("a non-string tool_name falls to the FALLBACK, which still carries a command", () => {
    // Not a bug and not fail-closed: the fallback is best-effort, and erring toward
    // evaluating MORE is the safe direction — the failure this package guards against is
    // a call that is silently NOT evaluated.
    const out = mapToolCall({ tool_name: 7, tool_input: { command: "rm -rf /" } } as never);
    expect(out.tool).toBe("");
    expect(out.args).toEqual({ full_command: "rm -rf /" });
  });

  it("never throws on a cyclic MCP payload", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => mapToolCall({ tool_name: "mcp__s__t", tool_input: cyclic })).not.toThrow();
    expect(mapToolCall({ tool_name: "mcp__s__t", tool_input: cyclic }).args.full_command).toBe("");
  });
});

describe("truncation", () => {
  it("capEnd keeps the FIRST MAX_DETAIL_LEN chars", () => {
    const s = `${"a".repeat(MAX_DETAIL_LEN)}TAIL`;
    expect(capEnd(s)).toHaveLength(MAX_DETAIL_LEN);
    expect(capEnd(s).endsWith("TAIL")).toBe(false);
  });

  it("capMiddle keeps BOTH the head and the tail", () => {
    const s = `HEAD${"a".repeat(MAX_DETAIL_LEN)}TAIL`;
    const out = capMiddle(s);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out.length).toBeLessThanOrEqual(MAX_DETAIL_LEN);
  });

  it("both are identity below the cap", () => {
    expect(capEnd("short")).toBe("short");
    expect(capMiddle("short")).toBe("short");
  });

  it("an oversized MCP payload keeps its tail, which capEnd would have dropped", () => {
    const big = { pad: "a".repeat(MAX_DETAIL_LEN), last: "SENTINEL" };
    const out = mapToolCall({ tool_name: "mcp__s__t", tool_input: big });
    expect(out.args.full_command).toContain("SENTINEL");
    expect(capEnd(JSON.stringify(big))).not.toContain("SENTINEL");
  });
});
