// cspell:words gitk popd pushd subshells doas ionice setsid caffeinate runuser gtimeout taskset chrt bunx direnv pipenv
/**
 * The shell reader the git-backed checks use (`core/verify/shell-words.ts`) and the folder each
 * command runs in (`core/verify/shell-calls.ts`).
 */

import { describe, expect, it } from "vitest";
import { programAndArgs, simpleCommands } from "../core/verify/calls.js";
import { commandHidingForms, executedView } from "../core/verify/ran.js";
import { resolvePath, walkCommands } from "../core/verify/shell-calls.js";
import {
  commandStart,
  directoryChange,
  gitCommand,
  operands,
  shellCommands,
  shellItems,
} from "../core/verify/shell-words.js";
import { changesFilesUnread } from "../core/verify/tests.js";
import { readPushes } from "../core/verify/unreviewed.js";
import { callsOf, OK } from "./verify-command-fixtures.js";

/** The words of each simple command, as values. */
const values = (text: string): string[][] =>
  shellCommands(text).map((c) => c.words.map((w) => w.value));

describe("one prefix table for every reader of a command's program", () => {
  // Each form puts a prefix word, with an option and its value, before the program.
  const FORMS = [
    "sudo -D /x",
    "sudo -u root",
    "sudo -n",
    "sudo -E -h host",
    "/usr/bin/sudo -C 3",
    "env --chdir /x",
    "env -C /x",
    "env --unset HOME",
    "env -i X=1",
    "nice -n 5",
    "time -o /tmp/t",
    "exec -a name",
    "timeout -s KILL 5",
    "stdbuf -o L",
    "HUSKY=0 sudo -D /x",
    // Long options with their value as the next word, or after `=`.
    "sudo --user root",
    "sudo --user=root",
    "sudo --group wheel",
    "sudo --chdir /tmp",
    "sudo --host h",
    "sudo --prompt p",
    "sudo --close-from 3",
    "sudo --role r",
    "sudo --type t",
    "sudo --other-user u",
    "sudo --command-timeout 5",
    "sudo --chroot /x",
    "sudo -Eu root",
    "sudo -- ",
    "nice --adjustment 5",
    "nice --adjustment=5",
    "timeout --signal KILL --kill-after 9 5",
    "stdbuf --output L --error L",
    "time --output /tmp/t",
    "env --argv0 x",
    "ionice --class 3",
    // Words that come before a program, and their options.
    "doas",
    "doas -u root",
    "ionice -c3",
    "ionice -c 3 -n 7",
    "setsid",
    "setsid -f",
    "caffeinate -i",
    "caffeinate -t 5",
    "npx --yes",
    "npx -y",
    "npx -p pkg",
    "flock /tmp/x.lock",
    "flock -w 5 /tmp/x.lock",
    "watch -x",
    "watch -n 1 -x",
    // More wrappers, and launchers that run the command after a subcommand.
    "gtimeout 5",
    "gtimeout --signal KILL 5",
    "chronic",
    "chronic -e",
    "unbuffer",
    "unbuffer -p",
    "taskset -c 0",
    "taskset 0x1",
    "chrt -f 10",
    "runuser -u root",
    "runuser -u root --",
    "runuser --user=root -g wheel --",
    "bunx",
    "bunx --bun",
    "aws-vault exec prod --",
    "aws-vault exec prod",
    "aws-vault exec prod --duration 1h --",
    "op run --",
    "op run --env-file .env --",
    "doppler run --",
    "doppler run -p web -c dev --",
    "dotenv --",
    "dotenv -e .env.local --",
    "dotenv -c dev --",
    "dotenv -f .env run",
    "direnv exec .",
    "direnv exec /srv/app",
    "mise exec --",
    "mise exec node@20 --",
    "mise x python@3.12 --",
    "uv run",
    "uv run --with rich --",
    "poetry run",
    "pipenv run",
    "pdm run",
    "bundle exec",
    "bundler exec",
    "pnpm exec",
    "pnpm --filter web exec",
    "pnpm dlx",
    "yarn exec",
    "npm exec --",
    "npm exec",
    "npm -w web exec --",
    "npm x --",
  ];

  it.each(FORMS)("%s git push: every reader names git", (prefix) => {
    const text = `${prefix} git push`;
    // shell-words.ts, the git-backed checks' reader.
    const words = shellCommands(text)[0]?.words ?? [];
    expect(words[commandStart(words).index]?.value).toBe("git");
    // calls.ts, the command checks' reader.
    const simple = simpleCommands(text)[0];
    expect(simple && programAndArgs(simple)).toMatchObject({ program: "git", args: ["push"] });
  });

  it.each(FORMS)("%s echo …: ran.ts blanks what the printer prints", (prefix) => {
    // ran.ts, the reading of what ran: a printer's words are data, so it must find the printer.
    const view = executedView(`${prefix} echo rm -rf build`);
    expect(view.text).not.toMatch(/\brm\b/);
    expect(view.kinds).toContain("doc");
  });

  it("a quote inside a $(…) inside double quotes does not end the string", () => {
    // An odd quote inside the substitution once left the rest of the text in one open string,
    // so the command after it was never read.
    expect(values(`X="$(printf '"')"; git stash drop`)).toEqual([
      [`X=$(printf '"')`],
      ["git", "stash", "drop"],
    ]);
    expect(values(`rm -rf "$(dirname "$f") /build" && git branch -D topic`)).toEqual([
      ["rm", "-rf", `$(dirname "$f") /build`],
      ["git", "branch", "-D", "topic"],
    ]);
  });

  it.each([
    ["env -S", "env -S 'git push'"],
    ["env -S, attached", "env -S'git push'"],
    ["env --split-string=", "env --split-string='git push'"],
    ["env --split-string", "env --split-string 'git push'"],
    ["flock -c", "flock /tmp/x.lock -c 'git push'"],
    ["flock --command", "flock -n /tmp/x.lock --command 'git push'"],
    ["npx -c", "npx -c 'git push'"],
    ["watch", "watch -n 1 'git push'"],
    ["watch, words", "watch -n 1 git push"],
  ])("%s: the command is one string, so the call holds a shell-string form", (_label, text) => {
    expect(commandHidingForms(text)).toContain("shell-string");
  });

  it.each([
    ["su", "su root -c 'git push'"],
    ["su, login", "su - root -c 'git push'"],
    ["su --command=", "su --command='git push' root"],
    ["runuser", "runuser -u root -c 'git push'"],
    ["script", "script -qc 'git push' /dev/null"],
    ["script --command", "script --command 'git push' log.txt"],
  ])("%s -c: the command is one string, so the call holds a shell-string form", (_label, text) => {
    expect(commandHidingForms(text)).toContain("shell-string");
  });

  it.each([
    "su root",
    "script log.txt",
    "watch -x git status",
    "flock /tmp/x.lock git status",
    "npx --yes prettier --check .",
    "env -i git status",
    "runuser -u root -- git status",
    "nix-shell -p git",
    "nix develop",
    "uv run git status",
  ])("%j gives its command as words: no shell-string form", (text) => {
    expect(commandHidingForms(text)).not.toContain("shell-string");
  });

  it.each([
    ["runuser with a user operand", "runuser root -c 'git push'"],
    ["nix-shell --run", "nix-shell -p git --run 'git push'"],
    ["nix-shell --command", "nix-shell --command 'git push'"],
    ["nix develop -c", "nix develop -c git push"],
    ["nix develop --command", "nix develop --command git push"],
    ["doppler run --command", "doppler run --command 'git push'"],
    ["npm exec -c", "npm exec -c 'git push'"],
    ["pnpm exec -c", "pnpm exec -c git push"],
    ["mise exec -c", "mise exec -c 'git push'"],
  ])("%s: the command is one string, so the call holds a shell-string form", (_label, text) => {
    expect(commandHidingForms(text)).toContain("shell-string");
  });

  it.each([
    ["npm install", "npm install git", "npm"],
    ["pnpm add", "pnpm add left-pad", "pnpm"],
    ["yarn", "yarn build", "yarn"],
    ["uv sync", "uv sync", "uv"],
    ["bundle install", "bundle install", "bundle"],
    ["aws-vault list", "aws-vault list", "aws-vault"],
  ])("a launcher with no subcommand that runs a command is the program: %s", (_l, text, name) => {
    const simple = simpleCommands(text)[0];
    expect(simple && programAndArgs(simple).program).toBe(name);
  });

  it("mise exec with no -- runs no command it is given", () => {
    const simple = simpleCommands("mise exec node@20 git push")[0];
    expect(simple && programAndArgs(simple).program).toBe("");
  });

  it("an assignment given to env is the program's, in both readers", () => {
    const text = "env --chdir /x HUSKY=0 git commit -m x";
    const words = shellCommands(text)[0]?.words ?? [];
    const start = commandStart(words);
    expect(words[start.index]?.value).toBe("git");
    expect(start.assignments.map((w) => w.value)).toEqual(["HUSKY=0"]);
    const simple = simpleCommands(text)[0];
    expect(simple && programAndArgs(simple).assignments).toEqual(["HUSKY=0"]);
  });

  it("env -i takes no value: env -i git push names git, and the push is read", () => {
    const text = `env -i git push origin ${"main"}`;
    const words = shellCommands(text)[0]?.words ?? [];
    expect(words[commandStart(words).index]?.value).toBe("git");
    const simple = simpleCommands(text)[0];
    expect(simple && programAndArgs(simple)).toMatchObject({
      program: "git",
      args: ["push", "origin", "main"],
    });
    expect(readPushes(text)).toMatchObject([{ remote: "origin", destinations: ["main"] }]);
  });

  it("a $( inside single quotes is literal text: the command after the quote is read", () => {
    expect(values("echo 'cost $(5' ; git branch -D feature/x")).toEqual([
      ["echo", "cost $(5"],
      ["git", "branch", "-D", "feature/x"],
    ]);
  });
});

describe("one table of git's own options for every reader of a git command", () => {
  // Each form puts git's own options, with any value, between `git` and its subcommand.
  const GLOBALS = [
    "-C repo",
    "--git-dir /x/.git",
    "--git-dir=/x/.git",
    "--work-tree /x",
    "--work-tree=/x",
    "--namespace x",
    "--namespace=x",
    "--config-env core.editor=EDITOR",
    "--super-prefix sub/",
    "--attr-source HEAD",
    "--no-pager",
    "--bare",
    "--exec-path=/x",
  ];

  it.each(GLOBALS)("git %s push origin main: every reader names push", (globals) => {
    const text = `git ${globals} push origin main`;
    // shell-words.ts, the git-backed checks' reader.
    expect(gitCommand(shellCommands(text)[0]?.words ?? [])?.sub).toBe("push");
    // unreviewed.ts, through calls.ts.
    expect(readPushes(text)).toMatchObject([{ remote: "origin", destinations: ["main"] }]);
  });

  it.each(GLOBALS)("git %s commit -m …: ran.ts blanks the message", (globals) => {
    const view = executedView(`git ${globals} commit -m "never rm -rf build"`);
    expect(view.kinds).toContain("doc");
    expect(view.text).not.toMatch(/\brm\b/);
  });

  it.each(GLOBALS)("git %s am: the test check reads a patch it cannot see", (globals) => {
    expect(changesFilesUnread(`git ${globals} am fix.patch`)).toBe(true);
  });

  it.each(
    GLOBALS,
  )("git %s commit after a hook was written: calls.ts says git-hook", async (globals) => {
    const { calls } = await callsOf("claude", [
      [
        { kind: "write", path: "/p/.husky/pre-commit", content: "make check", result: OK },
        { kind: "shell", command: `git ${globals} commit -m wip`, result: OK },
      ],
    ]);
    expect(calls[1]?.hidingForms).toContain("git-hook");
  });

  it("--exec-path alone prints a path and exits: no reader sees a push after it", () => {
    const text = "git --exec-path /opt/git/core push origin main";
    expect(gitCommand(shellCommands(text)[0]?.words ?? [])?.sub).toBe("/opt/git/core");
    expect(readPushes(text)).toEqual([]);
  });
});

describe("shellItems", () => {
  it("splits on every control operator and keeps quoted text in one word", () => {
    expect(values(`a 'b c' && d "e f" || g; h | i & j`)).toEqual([
      ["a", "b c"],
      ["d", "e f"],
      ["g"],
      ["h"],
      ["i"],
      ["j"],
    ]);
  });

  it("marks subshells, and keeps $(…) and backticks inside the word", () => {
    const items = shellItems("(cd x && make) && echo $(date +%s) `id`");
    expect(items.map((i) => i.kind)).toEqual(["open", "command", "command", "close", "command"]);
    const last = items[4];
    expect(last?.kind === "command" && last.words.map((w) => [w.value, w.expands])).toEqual([
      ["echo", false],
      ["$(date +%s)", true],
      ["`id`", true],
    ]);
  });

  it("tells expanding words from literal ones", () => {
    const [cmd] = shellCommands(`x "$A/b" '$B' \${C:?} plain`);
    expect(cmd?.words.map((w) => w.expands)).toEqual([false, true, false, true, false]);
  });

  it("drops redirection targets from the words, and lists the files written", () => {
    const [cmd] = shellCommands("make 2>/dev/null >out.log >>more.log <in.txt 2>&1");
    expect(cmd?.words.map((w) => w.value)).toEqual(["make"]);
    expect(cmd?.writes.map((w) => w.value)).toEqual(["/dev/null", "out.log", "more.log"]);
    expect(shellCommands("x &> all.log")[0]?.writes.map((w) => w.value)).toEqual(["all.log"]);
  });

  it("skips a heredoc fed to a program, and reads one fed to a shell as commands", () => {
    expect(values("cat > notes.md <<EOF\nrm -rf /\nEOF\nls")).toEqual([["cat"], ["ls"]]);
    expect(values("bash <<'EOF'\nrm -rf build\nEOF")).toEqual([
      ["bash"],
      ["rm", "-rf", "build"],
      ["EOF"],
    ]);
    expect(values("cat <<-EOF\n\tx\n\tEOF\nls")).toEqual([["cat"], ["ls"]]);
  });

  it("skips comments and joins escaped line breaks", () => {
    expect(values("# rm -rf /\nls a\\\nb")).toEqual([["ls", "ab"]]);
  });

  it("never fails on unbalanced text", () => {
    expect(() => shellItems(`echo "unterminated $(x 'y`)).not.toThrow();
    expect(() => shellItems("echo $'unterminated \\'")).not.toThrow();
    expect(shellItems("")).toEqual([]);
  });

  it("reads an ANSI-C string to its real end: an escaped quote does not close it", () => {
    expect(values("echo $'a\\'b'; git stash drop")).toEqual([
      ["echo", "a'b"],
      ["git", "stash", "drop"],
    ]);
    // Inside a substitution too.
    expect(values("X=$(printf $'it\\'s'); git stash drop")).toEqual([
      ["X=$(printf $'it\\'s')"],
      ["git", "stash", "drop"],
    ]);
  });

  it("decodes an ANSI-C string's escapes, and nothing in it expands", () => {
    const [cmd] = shellCommands("x $'a\\tb' $'\\x72m' $'$HOME' $\"c d\"");
    expect(cmd?.words.map((w) => w.value)).toEqual(["x", "a\tb", "rm", "$HOME", "c d"]);
    expect(cmd?.words.map((w) => w.expands)).toEqual([false, false, false, false, false]);
  });

  it("follows a cd that comes after an ANSI-C string", () => {
    const seen: string[] = [];
    walkCommands("echo $'it\\'s' && cd /x && make", "/repo", "/home/u", (command, folder) => {
      if (command.words[0]?.value === "make") seen.push(folder ?? "");
    });
    expect(seen).toEqual(["/x"]);
  });
});

describe("commandStart and gitCommand", () => {
  it("skips assignments, sudo, env and their options", () => {
    const [cmd] = shellCommands("HUSKY=0 sudo -u bob env A=1 git commit");
    const start = commandStart(cmd?.words ?? []);
    expect(cmd?.words[start.index]?.value).toBe("git");
    expect(start.assignments.map((w) => w.value)).toEqual(["HUSKY=0", "A=1"]);
  });

  it("reads git's own options and the folders -C moves to", () => {
    const [cmd] = shellCommands("git -C repo -c core.pager=cat --no-pager -C sub branch -D x");
    const git = gitCommand(cmd?.words ?? []);
    expect(git?.sub).toBe("branch");
    expect(git?.args.map((w) => w.value)).toEqual(["-D", "x"]);
    expect(git?.folders.map((w) => w.value)).toEqual(["repo", "sub"]);
    expect(git?.elsewhere).toBe(false);
    expect(gitCommand(shellCommands("git --git-dir=/x/.git log")[0]?.words ?? [])?.elsewhere).toBe(
      true,
    );
    expect(gitCommand(shellCommands("gitk --all")[0]?.words ?? [])).toBeUndefined();
  });

  it("operands skip option values and take everything after --", () => {
    const [cmd] = shellCommands("x -s src a --flag -- -b c");
    expect(operands(cmd?.words.slice(1) ?? [], new Set(["-s"])).map((w) => w.value)).toEqual([
      "a",
      "-b",
      "c",
    ]);
  });

  it("directoryChange", () => {
    const change = (text: string) => directoryChange(shellCommands(text)[0]?.words ?? []);
    expect(change("cd sub")).toEqual({ kind: "to", path: "sub" });
    expect(change("pushd /abs")).toEqual({ kind: "to", path: "/abs" });
    expect(change("cd")).toEqual({ kind: "home" });
    expect(change("cd $DIR")).toEqual({ kind: "unknown" });
    expect(change("cd -")).toEqual({ kind: "unknown" });
    expect(change("popd")).toEqual({ kind: "unknown" });
    expect(change("ls")).toEqual({ kind: "none" });
  });
});

describe("the folder each command runs in", () => {
  const folders = (text: string, cwd: string | undefined): (string | undefined)[] => {
    const out: (string | undefined)[] = [];
    walkCommands(text, cwd, "/home/u", (command, folder) => {
      if (command.words[0]?.value === "x") out.push(folder);
    });
    return out;
  };

  it("follows cd within the command and undoes a subshell's cd at its end", () => {
    expect(folders("x && cd sub && x && (cd /other && x) && x", "/repo")).toEqual([
      "/repo",
      "/repo/sub",
      "/other",
      "/repo/sub",
    ]);
  });

  it("forgets the folder after a cd it cannot follow, and knows none without a cwd", () => {
    expect(folders("cd $X && x", "/repo")).toEqual([undefined]);
    expect(folders("x", undefined)).toEqual([undefined]);
    expect(folders("cd ~ && x", undefined)).toEqual(["/home/u"]);
  });

  it("resolvePath", () => {
    expect(resolvePath("/repo", "a/../b", "/home/u")).toBe("/repo/b");
    expect(resolvePath(undefined, "/abs/x", "/home/u")).toBe("/abs/x");
    expect(resolvePath(undefined, "rel", "/home/u")).toBeUndefined();
    expect(resolvePath("/repo", "~/x", "/home/u")).toBe("/home/u/x");
    expect(resolvePath("/repo", "~other/x", "/home/u")).toBeUndefined();
    expect(resolvePath("/repo", "", "/home/u")).toBeUndefined();
  });
});
