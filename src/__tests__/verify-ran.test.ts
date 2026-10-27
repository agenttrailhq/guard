// cspell:words pytest oneline BLANKERS pipefail execdir mktemp osascript
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
  commandHidingForms,
  executedView,
  hidingFormsOf,
  isResultBackedRun,
  ranEvidenceOf,
  recordsToolResults,
  runVerdict,
  tallyMatchedCalls,
} from "../core/verify/ran.js";
import { HIDING_FORMS } from "../core/verify/types.js";
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

/** The command the rm rule catches, as a command that runs. */
const RUN = "rm -rf build";

/** How many times the rm rule's text is left in the executed view. */
const leftToRun = (command: string): number =>
  executedView(command).text.match(/\brm\s+-rf\s+build\b/g)?.length ?? 0;

describe("a command that ran is never hidden as mentioned", () => {
  // Each blanking program, then each control operator, then a command that runs. Whatever
  // the first part blanks, the command after the operator must stay.
  const OPERATORS = [";", "&&", "||", "|", "&", "\n"] as const;
  const BLANKERS: readonly (readonly [string, (op: string) => string])[] = [
    ["echo", (op) => `echo "${RUN}" ${op} ${RUN}`],
    ["printf", (op) => `printf '%s' '${RUN}' ${op} ${RUN}`],
    ["grep", (op) => `grep -rn "${RUN}" scripts ${op} ${RUN}`],
    ["git commit -m", (op) => `git commit -m "stop ${RUN}" ${op} ${RUN}`],
    ["a man page", (op) => `man rm ${op} ${RUN}`],
    [
      "a cat heredoc",
      (op) =>
        op === "\n"
          ? `cat > notes.md <<'EOF'\n${RUN}\nEOF\n${RUN}`
          : `cat > notes.md <<'EOF' ${op} ${RUN}\n${RUN}\nEOF`,
    ],
    [
      "a tee heredoc",
      (op) =>
        op === "\n"
          ? `tee notes.md <<'EOF'\n${RUN}\nEOF\n${RUN}`
          : `tee notes.md <<'EOF' ${op} ${RUN}\n${RUN}\nEOF`,
    ],
    [
      "a tab-stripped heredoc",
      (op) =>
        op === "\n"
          ? `cat <<-EOF > notes.md\n\t${RUN}\n\tEOF\n${RUN}`
          : `cat <<-EOF > notes.md ${op} ${RUN}\n\t${RUN}\n\tEOF`,
    ],
  ];

  for (const [label, build] of BLANKERS) {
    it.each(OPERATORS)(`${label}, then %j, then a command`, (op) => {
      const command = build(op);
      expect(leftToRun(command), JSON.stringify(command)).toBeGreaterThanOrEqual(1);
      expect(runVerdict("claude", bash(command), ok, stillMatches).state).toBe("ran");
    });
  }

  it.each([
    ["printed text piped into a shell", `echo "${RUN}" | sh`],
    ["printf piped into bash", `printf '${RUN}\\n' | bash`],
    ["printed text piped with stderr", `echo "${RUN}" |& sh`],
    ["a heredoc printed into bash", `cat <<'EOF' | bash\n${RUN}\nEOF`],
    ["a heredoc teed into sh", `tee run.sh <<'EOF' | sh\n${RUN}\nEOF`],
    ["a heredoc written, then run with bash", `cat > run.sh <<'EOF'\n${RUN}\nEOF\nbash run.sh`],
    [
      "a heredoc written, then run by path",
      `cat > run.sh <<'EOF'\n${RUN}\nEOF\nchmod +x run.sh && ./run.sh`,
    ],
    ["a heredoc teed, then sourced", `tee run.sh <<'EOF'\n${RUN}\nEOF\nsource run.sh`],
    ["printed into a file, then run by path", `echo "${RUN}" > run.sh; ./run.sh`],
    ["printed into a file, then run with python", `echo "${RUN}" > run.py && python3 run.py`],
    ["a subshell piped into sh", `(echo "${RUN}") | sh`],
    ["a brace group piped into sh", `{ echo "${RUN}"; } | sh`],
    ["a man page piped into sh", `man ${RUN} | sh`],
    ["a substitution as a commit message", `git commit -m "$(${RUN})"`],
    ["a heredoc substitution that pipes", `git commit -m "$(cat <<'EOF' | sh\n${RUN}\nEOF\n)"`],
    ["a hash inside a word", `echo a#b; ${RUN}`],
    ["a command after a semicolon", `echo done; ${RUN}`],
    ["a command after a tab-stripped heredoc", `cat <<-EOF > notes.md\n\tnotes\n\tEOF\n${RUN}`],
  ])("%s is ran", (_label, command) => {
    expect(leftToRun(command), JSON.stringify(command)).toBeGreaterThanOrEqual(1);
    expect(runVerdict("claude", bash(command), ok, stillMatches).state).toBe("ran");
  });

  it("a heredoc written to a file that nothing runs stays a mention", () => {
    const command = `cat > notes.md <<'EOF'\n${RUN}\nEOF\ngit add notes.md`;
    expect(runVerdict("claude", bash(command), ok, stillMatches)).toEqual({
      state: "mentioned",
      why: "heredoc",
    });
  });

  it("printed text that stays on the terminal stays a mention, even when a shell runs later", () => {
    expect(runVerdict("claude", bash(`echo "${RUN}"; bash ci.sh`), ok, stillMatches).state).toBe(
      "mentioned",
    );
  });
});

describe("a message given as a printed heredoc is data", () => {
  it.each([
    [
      "a commit message",
      `git commit -m "$(cat <<'EOF'\nStop the ${RUN} step.\n\nIt's gone.\nEOF\n)"`,
    ],
    [
      "a commit message holding double quotes",
      `git commit -m "$(cat <<'EOF'\nReplace "${RUN}" with a clean step.\nEOF\n)"`,
    ],
    ["an attached message", `git commit -m"$(cat <<'EOF'\n${RUN}\nEOF\n)"`],
    [
      "a PR body",
      `gh pr create --title t --body "$(cat <<'EOF'\n## Summary\n- drop ${RUN}\nEOF\n)"`,
    ],
    ["a PR body after =", `gh pr create --title t --body="$(cat <<'EOF'\n${RUN}\nEOF\n)"`],
  ])("%s is mentioned", (_label, command) => {
    expect(runVerdict("claude", bash(command), ok, stillMatches)).toEqual({
      state: "mentioned",
      why: "doc",
    });
  });

  it("and a command after it still runs", () => {
    const command = `git commit -m "$(cat <<'EOF'\nnotes\nEOF\n)" && ${RUN}`;
    expect(runVerdict("claude", bash(command), ok, stillMatches).state).toBe("ran");
  });
});

describe("result edge cases", () => {
  it.each([
    "Blocked by a hook. Exit code 2 would have followed.",
    "PreToolUse hook said no\nExit code 2",
  ])("an error result that only mentions an exit code mid-text stays unknown: %j", (content) => {
    expect(
      runVerdict("claude", bash(RUN), { ...ok, isError: true, content }, stillMatches),
    ).toEqual({ state: "unknown", why: "error-result" });
  });

  it("an assignment before a printer still makes it a printer", () => {
    expect(runVerdict("claude", bash(`FOO=1 echo "${RUN}"`), ok, stillMatches).state).toBe(
      "mentioned",
    );
  });
});

describe("text the shell expands, or a later program may run, is never hidden", () => {
  it.each([
    // An unquoted delimiter: the shell runs substitutions in the body before `cat` reads it.
    ["a substitution in an unquoted heredoc", `cat > notes.md <<EOF\n$(${RUN})\nEOF`],
    ["backticks in an unquoted heredoc", `cat > notes.md <<EOF\n\`${RUN}\`\nEOF`],
    [
      "a substitution in a tab-stripped unquoted heredoc",
      `cat <<-EOF > notes.md\n\t$(${RUN})\n\tEOF`,
    ],
    [
      "an unquoted heredoc message with a substitution",
      `git commit -m "$(cat <<EOF\n$(${RUN})\nEOF\n)"`,
    ],
    ["a here-string with a substitution", `cat <<< "$(${RUN})"`],
    // A file written, then something not known to be inert runs.
    ["a heredoc run with npx tsx", `cat > run.ts <<'EOF'\n${RUN}\nEOF\nnpx tsx run.ts`],
    ["a heredoc run with uv", `cat > run.py <<'EOF'\n${RUN}\nEOF\nuv run run.py`],
    ["a heredoc run with go run", `cat > main.go <<'EOF'\n${RUN}\nEOF\ngo run main.go`],
    ["a heredoc fed over ssh", `cat > run.sh <<'EOF'\n${RUN}\nEOF\nssh host bash < run.sh`],
    ["a crontab line", `echo "* * * * * ${RUN}" > cron.txt && crontab cron.txt`],
    ["a teed file then a package script", `echo "${RUN}" | tee run.sh && pnpm run task`],
    [
      "a search piped into a file a shell then runs",
      `grep -h "${RUN}" notes | head > run.sh && sh run.sh`,
    ],
    // Groups and substitutions that are not a printed heredoc.
    ["a two-command group piped into sh", `(echo "${RUN}"; echo a) | sh`],
    ["a heredoc given to bash as a message", `git commit -m "$(bash <<'EOF'\n${RUN}\nEOF\n)"`],
    ["printed text piped through a consumer into sh", `echo "${RUN}" | head -1 | sh`],
    // Git runs what a config value, an exec option or an external diff names.
    ["a git alias set with -c", `echo "${RUN}" > x.sh && git -c alias.x='!sh x.sh' x`],
    ["git rebase --exec", `echo "${RUN}" > x.sh && git rebase --exec ./x.sh main`],
    ["git rebase -x", `echo "${RUN}" > x.sh && git rebase -x ./x.sh main`],
    ["a diff driver set with -c", `echo "${RUN}" > x.sh && git -c diff.external=./x.sh diff`],
    ["a config set from the environment", `echo "${RUN}" > x.sh && git --config-env=a.b=C diff`],
    ["an exec path", `echo "${RUN}" > git-x && git --exec-path=. status`],
    ["git diff --ext-diff", `echo "${RUN}" > x.sh && git diff --ext-diff`],
    // A commit runs hooks; git reads its own config and attributes.
    ["a git hook, then a commit", `echo "${RUN}" > .git/hooks/pre-commit && git commit -m wip`],
    ["a husky hook, then a commit", `echo "${RUN}" > .husky/pre-commit && git commit -m wip`],
    ["a .githooks hook, then a commit", `echo "${RUN}" > .githooks/pre-commit; git commit -m wip`],
    ["a hooks folder, then a commit", `echo "${RUN}" | tee hooks/pre-commit && git commit -m x`],
    [
      "a hook in a folder the call names as core.hooksPath",
      `git config core.hooksPath ci && echo "${RUN}" > ci/pre-commit && git commit -m wip`,
    ],
    ["git's config, then a diff", `echo "${RUN}" >> .git/config && git diff`],
    ["attributes, then a diff", `echo "${RUN}" > .gitattributes && git diff`],
    // Process substitution hands text to a command.
    ["printed text into an output substitution", `echo "${RUN}" > >(sh)`],
    ["a heredoc into an output substitution", `cat <<'EOF' > >(bash)\n${RUN}\nEOF`],
    ["printed text teed into an output substitution", `echo "${RUN}" | tee >(sh)`],
    // Options that make an otherwise inert program run another.
    ["rg --pre", `echo "${RUN}" > pre.sh && rg --pre ./pre.sh x`],
    ["sort --compress-program", `echo "${RUN}" > z.sh && sort --compress-program=./z.sh a`],
    ["a search piped into rg --pre", `grep -h "${RUN}" notes | rg --pre=sh x`],
  ])("%s is ran", (_label, command) => {
    expect(leftToRun(command), JSON.stringify(command)).toBeGreaterThanOrEqual(1);
    expect(runVerdict("claude", bash(command), ok, stillMatches).state).toBe("ran");
  });

  it.each([
    ["a quoted heredoc written to a file", `cat > notes.md <<'EOF'\n$(${RUN})\nEOF`],
    ["a backslash-quoted delimiter", `cat > notes.md <<\\EOF\n$(${RUN})\nEOF`],
    ["an unquoted heredoc with no substitution", `cat > notes.md <<EOF\n${RUN}\nEOF`],
    [
      "a file written, then only inert commands",
      `cat > notes.md <<'EOF'\n${RUN}\nEOF\ngit add notes.md && git status`,
    ],
    ["a search piped into head", `grep -rn "${RUN}" src | head -20`],
    ["a history search piped into head", `git log --grep "${RUN}" | head`],
    ["printed text counted", `echo "${RUN}" | wc -l`],
    ["a search piped through two consumers", `rg "${RUN}" | sort | uniq -c`],
    ["a group of printers piped into head", `(echo "${RUN}"; echo a) | head`],
    ["a quoted heredoc message", `git commit -m "$(cat <<'EOF'\n$(${RUN})\nEOF\n)"`],
    [
      "a file written, then added and committed",
      `cat > notes.md <<'EOF'\n${RUN}\nEOF\ngit add notes.md && git commit -m "notes"`,
    ],
    [
      "a file written, then committed in another folder",
      `echo "${RUN}" > notes.md && git -C docs add notes.md && git -C docs commit -m notes`,
    ],
    ["a hook-like name outside a hooks folder", `echo "${RUN}" > ci/pre-commit && git commit -m x`],
  ])("%s stays mentioned", (_label, command) => {
    expect(runVerdict("claude", bash(command), ok, stillMatches).state).toBe("mentioned");
  });
});

describe("a run kept only because a later command may run a written file", () => {
  const WRITTEN_THEN_RUN = `cat > run.sh <<'EOF'\n${RUN}\nEOF\nbash run.sh`;

  it("is ran, with its own reason, and is not result-backed", () => {
    const run = runVerdict("claude", bash(WRITTEN_THEN_RUN), ok, stillMatches);
    expect(run).toEqual({ state: "ran", why: "may-run-written-file" });
    expect(isResultBackedRun(run)).toBe(false);
  });

  it("keeps that reason with an exit-code result, and needs a result to be ran at all", () => {
    const failed = { ...ok, isError: true, content: "Exit code 2\nfailed" };
    expect(runVerdict("claude", bash(WRITTEN_THEN_RUN), failed, stillMatches).why).toBe(
      "may-run-written-file",
    );
    expect(runVerdict("claude", bash(WRITTEN_THEN_RUN), undefined, stillMatches)).toEqual({
      state: "unknown",
      why: "no-result",
    });
    const blocked = { ...ok, isError: true, content: "Blocked by a hook" };
    expect(runVerdict("claude", bash(WRITTEN_THEN_RUN), blocked, stillMatches)).toEqual({
      state: "unknown",
      why: "error-result",
    });
  });

  it.each([
    ["a command that runs it directly", RUN],
    ["a written file and a direct run", `echo "${RUN}" > run.sh; ${RUN}`],
    ["text piped into a shell", `echo "${RUN}" | sh`],
    ["a substitution", `echo "$(${RUN})"`],
  ])("a run that does not rest on that rule is result-backed: %s", (_label, command) => {
    const run = runVerdict("claude", bash(command), ok, stillMatches);
    expect(run).toEqual({ state: "ran", why: "result" });
    expect(isResultBackedRun(run)).toBe(true);
  });

  it("an exit-code run is result-backed; mentioned and unknown never are", () => {
    expect(isResultBackedRun({ state: "ran", why: "exit-code" })).toBe(true);
    expect(isResultBackedRun({ state: "mentioned", why: "heredoc" })).toBe(false);
    expect(isResultBackedRun({ state: "unknown", why: "no-result" })).toBe(false);
  });

  it.each([
    "claude",
    "codex",
  ] as const)("%s: the tally counts it as unknown, not ran", async (agent) => {
    const { tally } = await tallyOf(agent, oneCall(WRITTEN_THEN_RUN, { text: "ok" }));
    expect(tally).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    const direct = await tallyOf(agent, oneCall(RUN, { text: "ok" }));
    expect(direct.tally).toEqual({ ran: 1, mentioned: 0, unknown: 0 });
  });
});

describe("what a call could hide", () => {
  it.each([
    ["bash -c", `bash -c "make all"`, ["shell-string"]],
    ["sh -lc", `sh -lc 'make all'`, ["shell-string"]],
    ["a shell option before -c", `bash -o pipefail -c 'make | tee log'`, ["shell-string"]],
    ["sudo zsh --command", `sudo zsh --command 'make'`, ["shell-string"]],
    ["find -exec", `find . -name '*.log' -exec wc -l {} +`, ["find-exec"]],
    ["find -execdir", `find . -execdir ls {} \\;`, ["find-exec"]],
    ["fd --exec", `fd -e ts --exec wc -l`, ["find-exec"]],
    ["xargs", `ls | xargs wc -l`, ["xargs"]],
    ["an input substitution", `diff <(sort a) <(sort b)`, ["process-substitution"]],
    ["an output substitution", `make > >(tee log)`, ["process-substitution"]],
    ["a substitution in a word", `echo "$(date)"`, ["command-substitution"]],
    ["backticks", "echo `date`", ["command-substitution"]],
    ["a substitution in a redirect target", `echo hi > "$(mktemp)"`, ["command-substitution"]],
    [
      "an unquoted heredoc that expands",
      `cat > x.md <<EOF\n$(date)\nEOF`,
      ["command-substitution"],
    ],
    ["a here-string that expands", `cat <<< "$(date)"`, ["command-substitution"]],
    ["eval", `eval "$TASK"`, ["eval"]],
    ["git -c", `git -c core.pager=cat log`, ["git-config"]],
    ["git --config-env", `git --config-env=a.b=C status`, ["git-config"]],
    ["git after git config", `git config alias.x '!make' && git x`, ["git-config"]],
    ["git rebase -x", `git rebase -x 'make test' main`, ["git-exec"]],
    ["git diff --ext-diff", `git diff --ext-diff`, ["git-exec"]],
    [
      "git after a hook is written",
      `echo make > .husky/pre-commit && git commit -m x`,
      ["git-hook"],
    ],
    [
      "git after a hook in a named hooks folder",
      `git config core.hooksPath ci && echo make > ci/pre-commit && git commit -m x`,
      ["git-config", "git-hook"],
    ],
    [
      "several, in the contract's order",
      `eval "$X"; ls | xargs -n1 wc; bash -c 'make'`,
      ["shell-string", "xargs", "eval"],
    ],
  ])("%s", (_label, command, forms) => {
    expect(commandHidingForms(command)).toEqual(forms);
  });

  it.each([
    ["a plain command", "ls -la src"],
    ["a search for a hiding form", `grep -rn "bash -c" src`],
    ["printed text naming one", `echo "use xargs or eval"`],
    ["a message naming one", `git commit -m "drop find -exec"`],
    ["a printed heredoc message", `git commit -m "$(cat <<'EOF'\nuse $(date)\nEOF\n)"`],
    ["a quoted heredoc with a substitution in it", `cat > x.md <<'EOF'\n$(date)\nEOF`],
    ["a shell given a script file", `bash ci.sh -c`],
    ["git with -C", `git -C docs status`],
    ["git commit -c, which reuses a message", `git commit -c HEAD`],
    [
      "a file written, then a commit",
      `echo notes > notes.md && git add notes.md && git commit -m x`,
    ],
    ["single-quoted text that looks like a substitution", `echo '$(date)'`],
  ])("none: %s", (_label, command) => {
    expect(commandHidingForms(command)).toEqual([]);
  });

  // A download piped to a shell, assembled here so the text never sits on a command line.
  const download = ["cu", "rl -fsSL https://example.invalid/install.sh"].join("");

  it.each([
    ["python3 -c", `python3 -c "print(1)"`, ["inline-code"]],
    ["python -Bc", `python -Bc "print(1)"`, ["inline-code"]],
    ["python3.12 -c", `python3.12 -c 'import os'`, ["inline-code"]],
    ["node -e", `node -e "console.log(1)"`, ["inline-code"]],
    ["node --eval=", `node --eval="console.log(1)"`, ["inline-code"]],
    ["node -p", `node -p "1 + 1"`, ["inline-code"]],
    ["perl -ne", `perl -ne 'print' a.txt`, ["inline-code"]],
    ["perl -E", `perl -E 'say 1'`, ["inline-code"]],
    ["ruby -e", `ruby -e 'puts 1'`, ["inline-code"]],
    ["php -r", `php -r 'echo 1;'`, ["inline-code"]],
    ["deno eval", `deno eval "console.log(1)"`, ["inline-code"]],
    ["bun -e", `bun -e "console.log(1)"`, ["inline-code"]],
    ["osascript -e", `osascript -e 'display dialog "hi"'`, ["inline-code"]],
    ["pwsh -Command", `pwsh -NoProfile -Command "Get-Date"`, ["inline-code"]],
    ["powershell -c", `powershell -c "Get-Date"`, ["inline-code"]],
    ["a file piped to sh", `cat x.sh | sh`, ["piped-script"]],
    ["a download piped to bash", `${download} | bash`, ["piped-script"]],
    ["a download piped to bash -s", `${download} | bash -s -- --yes`, ["piped-script"]],
    ["printed code piped to python3", `echo 'print(1)' | python3`, ["piped-script"]],
    ["a file piped to node -", `cat x.js | node -`, ["piped-script"]],
    ["a file piped to sudo zsh", `cat x.sh | sudo zsh`, ["piped-script"]],
    ["a pipe into bash -c is a shell string", `cat list | bash -c 'wc -l'`, ["shell-string"]],
    [
      "git after a hook write, then an unrelated write",
      `echo make > .git/hooks/pre-commit; echo notes > notes.md; git commit -m wip`,
      ["git-hook"],
    ],
    ["a here-string into bash", `bash <<< "make all"`, ["piped-script"]],
    ["a here-string into python3", `python3 <<< 'print(1)'`, ["piped-script"]],
    ["a heredoc into sh", `sh <<'EOF'\nmake all\nEOF`, ["piped-script"]],
    ["a heredoc into node with -", `node - <<'EOF'\nconsole.log(1)\nEOF`, ["piped-script"]],
  ])("%s", (_label, command, forms) => {
    expect(commandHidingForms(command)).toEqual(forms);
  });

  it.each([
    ["a python script with its own -c", "python3 script.py -c 1"],
    ["a python module", "python3 -m pytest -k c"],
    ["a node script with its own -e", "node app.js -e x"],
    ["a perl script", "perl script.pl -e"],
    ["deno run", "deno run x.ts"],
    ["printed text naming one", `echo "python -c x; node -e y"`],
    ["a search for one", `grep -rn "| bash" docs`],
    ["a pipe into a consumer", "cat x.sh | grep sh"],
    ["a pipe into a python script", "cat data.json | python3 tool.py"],
    ["a local script run by name", "./x.sh"],
    ["a local script given to bash", "bash x.sh"],
    ["a local script sourced", "source x.sh"],
    ["a local script dotted", ". ./x.sh"],
    ["a shell with no pipe", "bash"],
    ["a here-string into a printer", `cat <<< "make all"`],
    ["a here-string into a search", `grep make <<< "make all"`],
    ["a here-string to a script given by name", `bash ci.sh <<< "yes"`],
    ["a heredoc written to a file", `cat > notes.md <<'EOF'\nmake all\nEOF`],
  ])("none: %s", (_label, command) => {
    expect(commandHidingForms(command)).toEqual([]);
  });

  it.each([
    ["inline code", `python3 -c "import os; os.system('${RUN}')"`],
    ["printed text piped to python3", `echo "import os; os.system('${RUN}')" | python3`],
    ["a heredoc piped to bash -s", `cat <<'EOF' | bash -s\n${RUN}\nEOF`],
  ])("a call holding %s is ran", (_label, command) => {
    expect(leftToRun(command), JSON.stringify(command)).toBeGreaterThanOrEqual(1);
    expect(runVerdict("claude", bash(command), ok, stillMatches).state).toBe("ran");
  });

  it("per call: a shell call's forms, every PowerShell command, nothing for other tools", () => {
    expect(hidingFormsOf(bash("ls | xargs wc -l"))).toEqual(["xargs"]);
    expect(hidingFormsOf({ tool: "PowerShell", args: { full_command: "Get-ChildItem" } })).toEqual([
      "unread-shell",
    ]);
    expect(hidingFormsOf({ tool: "Read", args: { file_path: "a.md" } })).toEqual([]);
    expect(hidingFormsOf({ tool: "Bash", args: {} })).toEqual([]);
  });

  it("is an enum list only: every form is one of the contract's", () => {
    const all = commandHidingForms(
      `eval "$X"; bash -c a; find . -exec b {} +; ls | xargs c; diff <(d) e; git -c f=g h; git rebase -x i j; echo k > .git/hooks/l && git commit`,
    );
    for (const form of all) expect(HIDING_FORMS).toContain(form);
    expect(all.length).toBeGreaterThan(5);
  });
});
