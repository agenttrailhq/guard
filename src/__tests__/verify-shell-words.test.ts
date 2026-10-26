// cspell:words gitk popd pushd subshells
/**
 * The shell reader the git-backed checks use (`core/verify/shell-words.ts`) and the folder each
 * command runs in (`core/verify/shell-calls.ts`).
 */

import { describe, expect, it } from "vitest";
import { resolvePath, walkCommands } from "../core/verify/shell-calls.js";
import {
  commandStart,
  directoryChange,
  gitCommand,
  operands,
  shellCommands,
  shellItems,
} from "../core/verify/shell-words.js";

/** The words of each simple command, as values. */
const values = (text: string): string[][] =>
  shellCommands(text).map((c) => c.words.map((w) => w.value));

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
    expect(shellItems("")).toEqual([]);
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
