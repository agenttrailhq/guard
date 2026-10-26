// cspell:words gpgsign NOSYSTEM
/**
 * Synthetic sessions and temporary repositories for the git-backed check suites.
 *
 * Sessions are built in memory in the shape each app's reader produces, so a suite can name a
 * working directory per session, a result per call and the files the agent wrote. Repositories
 * are real, made in a temporary folder by running `git` from the test, never from a shell.
 * Every name, path and message here is made up.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ScanCorpus } from "../core/scan-report.js";
import type {
  ParsedSession,
  ToolResult,
  ToolUse,
  Turn,
} from "../core/transcript/transcript-types.js";
import type { AgentSource } from "../core/types.js";
import { checkGitBacked, type GitChecksOutcome } from "../core/verify/git-checks.js";
import type { CheckedCategory, CouldNotCheckResult, VerifyIO } from "../core/verify/types.js";
import { createRealVerifyIO } from "../verify-io.js";

/** One thing the agent did. */
export type GitEvent =
  | {
      readonly kind: "bash";
      readonly command: string;
      /** What the command printed. */
      readonly output?: string;
      readonly error?: boolean;
      /** The transcript records no result for the call. */
      readonly noResult?: boolean;
      /** Codex only: the folder the call names. Absent: the session's. */
      readonly workdir?: string;
    }
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly newString: string;
      readonly oldString?: string;
    };

/** One session: its working directory and what happened in it. */
export interface GitSession {
  readonly cwd: string | null;
  readonly events: readonly GitEvent[];
}

/** The shim fragment Codex writes for one shell command, with the folder it names if any. */
export function codexShim(command: string, workdir?: string): string {
  const dir = workdir === undefined ? "" : `,workdir:${JSON.stringify(workdir)}`;
  return `const r = await tools.exec_command({cmd:${JSON.stringify(command)}${dir}}); text(r.output);\n`;
}

/** One tool use for an app, in the shape its reader produces. */
function toolUse(agent: AgentSource, id: string, event: GitEvent): ToolUse {
  if (event.kind === "bash") {
    if (agent === "codex")
      return {
        toolUseId: id,
        name: "exec",
        input: { input: codexShim(event.command, event.workdir) },
      };
    if (agent === "cursor")
      return { toolUseId: "", name: "Shell", input: { command: event.command } };
    return { toolUseId: id, name: "Bash", input: { command: event.command } };
  }
  if (agent === "codex") throw new Error("the Codex fixture writes no files");
  if (event.kind === "write") {
    return agent === "cursor"
      ? { toolUseId: "", name: "Write", input: { path: event.path, contents: event.content } }
      : { toolUseId: id, name: "Write", input: { file_path: event.path, content: event.content } };
  }
  const input = { old_string: event.oldString ?? "", new_string: event.newString };
  return agent === "cursor"
    ? { toolUseId: "", name: "StrReplace", input: { path: event.path, ...input } }
    : { toolUseId: id, name: "Edit", input: { file_path: event.path, ...input } };
}

/** A corpus for one app, read as its reader would leave it. */
export function corpusOf(agent: AgentSource, sessions: readonly GitSession[]): ScanCorpus {
  const parsed: ParsedSession[] = sessions.map((session, s) => {
    const results = new Map<string, ToolResult>();
    const turns: Turn[] = session.events.map((event, i) => {
      const id = `s${s}-t${i}`;
      const use = toolUse(agent, id, event);
      // Cursor records no results. Codex's reader keeps that an output exists, not its text.
      const recorded = agent !== "cursor" && !(event.kind === "bash" && event.noResult === true);
      if (recorded) {
        results.set(id, {
          toolUseId: id,
          isError: event.kind === "bash" && event.error === true,
          content: agent === "codex" ? "" : event.kind === "bash" ? (event.output ?? "") : "ok",
          timestamp: "2026-10-01T00:00:00.000Z",
        });
      }
      return {
        messageUuid: `m${s}-${i}`,
        timestamp: "2026-10-01T00:00:00.000Z",
        model: "synthetic",
        usage: {},
        text: "",
        toolUses: [use],
        isSidechain: false,
        promptUuid: "",
      };
    });
    return {
      sessionId: `session-${s}`,
      version: null,
      gitBranch: null,
      cwd: session.cwd,
      turns,
      userPrompts: [],
      toolResults: results,
      firstTimestamp: "2026-10-01T00:00:00.000Z",
      lastTimestamp: "2026-10-01T00:00:00.000Z",
      skippedLines: 0,
    };
  });
  return { agent, sessions: parsed, quarantined: 0, notRead: 0, projects: 1 };
}

/** A new temporary folder, by its real path. */
export function tempFolder(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `agenttrail-git-check-${label}-`)));
}

/** The environment test `git` runs in: a fixed identity, no signing. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Run `git` in a test repository, from the test: never through a shell. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Options for a test repository. */
export interface RepoOptions {
  /** Files to commit first. */
  readonly files?: Readonly<Record<string, string>>;
  /** Hook files to put in `.git/hooks`. */
  readonly hooks?: readonly string[];
}

/** A temporary repository on `main` with one commit. */
export function makeRepo(label: string, options: RepoOptions = {}): string {
  const root = tempFolder(label);
  git(root, "init", "-q", "-b", "main");
  const files = options.files ?? { "README.md": "synthetic\n" };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  for (const hook of options.hooks ?? []) {
    const path = join(root, ".git", "hooks", hook);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  return root;
}

/** Point `refs/remotes/origin/<branch>` at a commit, as a fetch would. */
export function setRemoteBranch(root: string, branch: string, commit: string): void {
  git(root, "update-ref", `refs/remotes/origin/${branch}`, commit);
}

/** Make a commit on the current branch and return the line `git commit` printed. */
export function commitLine(
  root: string,
  file: string,
  message: string,
  extra: string[] = [],
): string {
  writeFileSync(join(root, file), `${message}\n`);
  git(root, "add", file);
  return git(root, "commit", ...extra, "-m", message);
}

/** The full id of a revision. */
export function rev(root: string, revision: string): string {
  return git(root, "rev-parse", revision).trim();
}

/** A check's result with its facts: a check that failed outright fails the test. */
export function checkedOf<F>(result: CheckedCategory<F> | CouldNotCheckResult): CheckedCategory<F> {
  if (!("facts" in result)) throw new Error("the check failed outright, with no facts");
  return result;
}

/** An exact fix command as `localFixCommand` writes it: every argument single-quoted. */
export function quoted(...args: readonly string[]): string {
  return args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
}

/** A real `VerifyIO` whose home is `home`. */
export function verifyIO(home: string): VerifyIO {
  return createRealVerifyIO({ env: { ...process.env, HOME: home, USERPROFILE: home } });
}

/** Run the git-backed checks over a corpus with a real `VerifyIO`. */
export function runChecks(
  agent: AgentSource,
  sessions: readonly GitSession[],
  home: string,
  options: { readonly scratchRoots?: readonly string[]; readonly io?: VerifyIO } = {},
): Promise<GitChecksOutcome> {
  return checkGitBacked({
    corpus: corpusOf(agent, sessions),
    io: options.io ?? verifyIO(home),
    home,
    scratchRoots: options.scratchRoots ?? [],
  });
}
