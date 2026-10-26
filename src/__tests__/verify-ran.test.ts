// cspell:words pytest oneline
/**
 * Ran, or only mentioned (`core/verify/ran.ts`).
 *
 * Two halves. `executedView` decides which parts of a shell command are only data, and is
 * tested on the command text alone. `runVerdict` and `tallyMatchedCalls` decide whether a
 * matched call ran, and are tested on synthetic transcripts for each app, read back through
 * the app's real reader, with one case per place a match can sit.
 */

import { describe, expect, it } from "vitest";
import { readCodexFile } from "../core/codex-transcript/parse.js";
import { compileAllowlist } from "../core/evaluate.js";
import { compileCatalog } from "../core/rules.js";
import { evaluateAction } from "../core/scan-report.js";
import type { AgentSource, MappedCall } from "../core/types.js";
import {
  AGENT_REPLY,
  executedView,
  ranEvidenceOf,
  recordsToolResults,
  runVerdict,
  tallyMatchedCalls,
} from "../core/verify/ran.js";
import { RULE_RM_RF } from "./scan-fixtures.js";
import { codexExec, type SessionEvent, writeCorpus } from "./verify-fixtures.js";

const CATALOG = compileCatalog([RULE_RM_RF]);
const NO_ALLOWLIST = compileAllowlist([]);

/** Does the rm rule match this call? */
const stillMatches = (call: MappedCall): boolean =>
  evaluateAction(CATALOG, NO_ALLOWLIST, [call]).decision.matches.length > 0;

/** A Bash call. */
const bash = (command: string): MappedCall => ({ tool: "Bash", args: { full_command: command } });

/** An ok result. */
const ok = { toolUseId: "t", isError: false, content: "done", timestamp: "" };

describe("executedView blanks only what is data", () => {
  it.each([
    ["a grep pattern", 'grep -rn "rm -rf /" src', "search"],
    ["an rg pattern after -e", "rg -e 'rm -rf' -g '*.sh' .", "search"],
    ["git grep", "git grep 'rm -rf'", "search"],
    ["git log -S", "git log -S'rm -rf' --oneline", "search"],
    ["git log --grep=", "git log --grep='rm -rf build'", "search"],
    ["a lookup", "man rm -rf", "search"],
    ["echo", 'echo "never rm -rf build"', "doc"],
    ["printf", "printf '%s' rm -rf build", "doc"],
    ["a commit message", 'git commit -m "stop rm -rf build"', "doc"],
    ["a commit message attached", 'git commit -m"rm -rf"', "doc"],
    ["a PR body", 'gh pr create --title t --body "rm -rf build"', "doc"],
    ["a comment", "ls # rm -rf build", "doc"],
    ["a vitest name filter", 'pnpm vitest run -t "rm -rf build"', "test-string"],
    ["a pytest -k filter", 'pytest -k "rm -rf"', "test-string"],
    ["a heredoc into a file", "cat > notes.md <<'EOF'\nrm -rf build\nEOF", "heredoc"],
    ["a tab-stripped heredoc", "cat <<-EOF > n.md\n\trm -rf build\n\tEOF", "heredoc"],
    ["a here-string into tee", "tee notes.md <<< 'rm -rf build'", "heredoc"],
  ])("%s", (_label, command, kind) => {
    const view = executedView(command);
    expect(view.kinds).toContain(kind);
    expect(view.text).not.toMatch(/\brm\s+-rf\b/);
    expect(view.text.length).toBe(command.length);
  });

  it.each([
    ["the command itself", "rm -rf build"],
    ["a later segment", "cd app && rm -rf build"],
    ["a pipeline target", "find . -name x | xargs rm -rf"],
    ["a heredoc fed to a shell", "bash <<'EOF'\nrm -rf build\nEOF"],
    ["text a program runs", 'psql -c "rm -rf"'],
    ["bash -c", 'bash -c "rm -rf build"'],
    ["a substitution inside echo", 'echo "$(rm -rf build)"'],
    ["backticks inside echo", "echo `rm -rf build`"],
    ["a substitution as a grep pattern", 'grep "$(rm -rf build)" f'],
    ["after sudo and an assignment", "HUSKY=0 sudo -u root rm -rf build"],
    ["find -exec", "find . -name x -exec rm -rf {} +"],
  ])("keeps %s", (_label, command) => {
    expect(executedView(command).text).toMatch(/\brm\s+-rf\b/);
  });

  it("keeps a redirection target that echo writes to", () => {
    const view = executedView("echo x > .env");
    expect(view.text).toContain(".env");
    expect(view.text).not.toContain(" x ");
  });

  it("keeps a grep's file operands, which it reads", () => {
    expect(executedView("grep KEY .env").text).toContain(".env");
  });

  it("returns a command with nothing to blank exactly as it is", () => {
    const command = "ls -la && pwd";
    expect(executedView(command)).toEqual({ text: command, kinds: [] });
  });

  it("keeps line breaks, and blanks every other character of a region", () => {
    const view = executedView("cat > n <<EOF\nab\ncd\nEOF");
    expect(view.text).toBe("cat > n <<EOF\n  \n  \nEOF");
  });

  it("survives text it cannot parse", () => {
    for (const command of ['echo "unterminated', "cat <<EOF", "$((", "`", "\\", "a 2>&1 |& b"]) {
      expect(() => executedView(command)).not.toThrow();
    }
  });

  it("negative control — the rm rule matches each of the blanked commands before blanking", () => {
    for (const command of [
      'grep -rn "rm -rf /" src',
      'echo "rm -rf"',
      "cat <<EOF\nrm -rf x\nEOF",
    ]) {
      expect(stillMatches(bash(command))).toBe(true);
    }
  });
});

describe("runVerdict", () => {
  it("a command that ran, with a result", () => {
    expect(runVerdict("claude", bash("rm -rf build"), ok, stillMatches)).toEqual({
      state: "ran",
      why: "result",
    });
  });

  it("a command whose match sits only in a search pattern is mentioned, result or not", () => {
    expect(runVerdict("claude", bash('grep "rm -rf" s'), ok, stillMatches)).toEqual({
      state: "mentioned",
      why: "search",
    });
  });

  it("a command with a mention and a real run is ran", () => {
    const command = 'grep "rm -rf" s && rm -rf build';
    expect(runVerdict("claude", bash(command), ok, stillMatches).state).toBe("ran");
  });

  it("an error result that reports an exit code ran", () => {
    const failed = { ...ok, isError: true, content: "Exit code 1\nrm: build: Permission denied" };
    expect(runVerdict("claude", bash("rm -rf build"), failed, stillMatches)).toEqual({
      state: "ran",
      why: "exit-code",
    });
  });

  it("an error result with no exit code did not run", () => {
    const refused = {
      ...ok,
      isError: true,
      content: "The user doesn't want to proceed with this tool use.",
    };
    expect(runVerdict("claude", bash("rm -rf build"), refused, stillMatches)).toEqual({
      state: "unknown",
      why: "error-result",
    });
  });

  it("no result is unknown, never ran", () => {
    expect(runVerdict("codex", bash("rm -rf build"), undefined, stillMatches)).toEqual({
      state: "unknown",
      why: "no-result",
    });
  });

  it("Cursor records no results, so its executed calls are unknown", () => {
    expect(runVerdict("cursor", bash("rm -rf build"), ok, stillMatches)).toEqual({
      state: "unknown",
      why: "not-recorded",
    });
  });

  it("a web search is a search", () => {
    const search: MappedCall = { tool: "WebSearch", args: { full_command: "rm -rf safely" } };
    expect(runVerdict("claude", search, ok, stillMatches).why).toBe("search");
  });

  it("a PowerShell command is judged by its result alone", () => {
    const ps: MappedCall = { tool: "PowerShell", args: { full_command: 'echo "rm -rf"' } };
    expect(runVerdict("claude", ps, ok, stillMatches).state).toBe("ran");
  });

  it("text in the agent's reply is mentioned", () => {
    expect(AGENT_REPLY).toEqual({ state: "mentioned", why: "agent-reply" });
  });

  it("states what a ran verdict rests on, per app", () => {
    expect((["claude", "codex", "cursor"] as const).map(ranEvidenceOf)).toEqual([
      "tool-result",
      "output-record",
      "none",
    ]);
  });

  it("states which apps record results", () => {
    expect((["claude", "codex", "cursor"] as const).map(recordsToolResults)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

/** A session of one call. */
const oneCall = (command: string, result?: { text: string; isError?: boolean }): SessionEvent[] => [
  { kind: "prompt", text: "tidy the build folder" },
  result === undefined ? { kind: "call", command } : { kind: "call", command, result },
];

/** The tally for one session in one app. */
async function tallyOf(agent: AgentSource, events: readonly SessionEvent[]) {
  const { corpus } = await writeCorpus(agent, [events]);
  return tallyMatchedCalls(corpus, CATALOG, NO_ALLOWLIST);
}

describe("the ran-or-mentioned split, per app and per place a match can sit", () => {
  /** What each app reports for a call with a result whose match sits where the shell runs it. */
  const EXECUTED: Record<AgentSource, "ran" | "unknown"> = {
    claude: "ran",
    codex: "ran",
    cursor: "unknown",
  };

  const CONTEXTS: readonly (readonly [string, string, "mentioned" | "executed"])[] = [
    ["a command that ran", "rm -rf build", "executed"],
    ["a search", 'grep -rn "rm -rf build" scripts', "mentioned"],
    ["a doc", 'echo "do not rm -rf build" >> NOTES.md', "mentioned"],
    ["a message", 'git commit -m "replace rm -rf build"', "mentioned"],
    ["a test string", 'pnpm vitest run -t "rm -rf build"', "mentioned"],
    ["a heredoc", "cat > notes.md <<'EOF'\nrm -rf build\nEOF", "mentioned"],
  ];

  for (const agent of ["claude", "codex", "cursor"] as const) {
    it.each(CONTEXTS)(`${agent}: %s`, async (_label, command, where) => {
      const { tally } = await tallyOf(agent, oneCall(command, { text: "ok" }));
      const expected = where === "mentioned" ? "mentioned" : EXECUTED[agent];
      expect(tally).toEqual({
        ran: expected === "ran" ? 1 : 0,
        mentioned: expected === "mentioned" ? 1 : 0,
        unknown: expected === "unknown" ? 1 : 0,
      });
    });

    it(`${agent}: text only in an agent reply is not a call at all`, async () => {
      const { tally } = await tallyOf(agent, [{ kind: "reply", text: "I will run rm -rf build" }]);
      expect(tally).toEqual({ ran: 0, mentioned: 0, unknown: 0 });
    });
  }

  it("claude: an error result without an exit code is unknown", async () => {
    const { tally } = await tallyOf(
      "claude",
      oneCall("rm -rf build", { text: "Blocked by a hook", isError: true }),
    );
    expect(tally).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
  });

  it("claude: an error result with an exit code ran", async () => {
    const { tally } = await tallyOf(
      "claude",
      oneCall("rm -rf build", { text: "Exit code 1\nfailed", isError: true }),
    );
    expect(tally).toEqual({ ran: 1, mentioned: 0, unknown: 0 });
  });

  it.each(["claude", "codex"] as const)("%s: a call with no result is unknown", async (agent) => {
    const { tally } = await tallyOf(agent, oneCall("rm -rf build"));
    expect(tally).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
  });

  it("codex: PINNED — a call counts as ran exactly when it has an output record, whatever it says", async () => {
    // Today's behaviour, pinned rather than guessed at. Whether Codex writes an output record
    // for a call a pre-tool hook blocked is not known from the recorded sessions; if it does,
    // such a call is counted as ran. This test changes deliberately when that is settled.
    const blocked = await tallyOf("codex", oneCall("rm -rf build", { text: "blocked by policy" }));
    expect(blocked.tally).toEqual({ ran: 1, mentioned: 0, unknown: 0 });
    const none = await tallyOf("codex", oneCall("rm -rf build"));
    expect(none.tally).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
  });

  it("codex: the parser matches an output to its call by call_id, and ignores one that names no call", async () => {
    const record = (payload: Record<string, unknown>) =>
      JSON.stringify({ timestamp: "2026-10-01T00:00:00.000Z", type: "response_item", payload });
    const lines = [
      record({ type: "custom_tool_call", call_id: "c1", name: "exec", input: codexExec("ls") }),
      record({ type: "custom_tool_call", name: "exec", input: codexExec("pwd") }),
      record({ type: "custom_tool_call_output", call_id: "c1", output: [{ text: "a" }] }),
      record({ type: "custom_tool_call_output", call_id: "nobody", output: [{ text: "b" }] }),
      record({ type: "custom_tool_call_output", output: [{ text: "c" }] }),
    ];
    const source = {
      async *readLines() {
        for (const line of lines) yield line;
      },
    };
    const records = await readCodexFile("f", source, { timestamp: "t", idPrefix: "p" });
    expect([...records.toolResults.keys()]).toEqual(["p:1"]);
    expect(records.toolResults.get("p:1")).toEqual({
      toolUseId: "p:1",
      isError: false,
      content: "",
      timestamp: "2026-10-01T00:00:00.000Z",
    });
  });

  it("reports whether the app records results", async () => {
    expect((await tallyOf("cursor", oneCall("rm -rf build"))).resultsRecorded).toBe(false);
    expect((await tallyOf("codex", oneCall("rm -rf build"))).resultsRecorded).toBe(true);
  });

  it("counts only calls that matched a guardrail", async () => {
    const { tally } = await tallyOf("claude", [
      { kind: "call", command: "ls", result: { text: "a" } },
      { kind: "call", command: "rm -rf build", result: { text: "" } },
    ]);
    expect(tally).toEqual({ ran: 1, mentioned: 0, unknown: 0 });
  });

  it("claude: one call carried twice in a session counts once, as the report counts it", async () => {
    const { corpus } = await writeCorpus("claude", [oneCall("rm -rf build", { text: "" })]);
    const session = corpus.sessions[0];
    if (session === undefined) throw new Error("no session");
    const doubled = {
      ...corpus,
      sessions: [{ ...session, turns: [...session.turns, ...session.turns] }],
    };
    expect(tallyMatchedCalls(doubled, CATALOG, NO_ALLOWLIST).tally.ran).toBe(1);
  });
});
