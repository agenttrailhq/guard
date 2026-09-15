/**
 * `runCli` — dispatch, and the rule that `hook` can never return non-zero.
 *
 * `runCli` RETURNS a code instead of calling `process.exit`, which is what makes it
 * testable in-process at all — and, more importantly, means no CLI path can stumble
 * into Claude Code's blocking signal.
 */

import { describe, expect, it, vi } from "vitest";
import { runCli, VERSION } from "../cli.js";
import { NOT_CHECKED_MESSAGE } from "../commands/hook.js";
import type { GuardIO } from "../io.js";

function harness(stdin = "{}") {
  const written: string[] = [];
  const io: GuardIO = {
    readStdin: async () => stdin,
    writeStdout: (t) => {
      written.push(t);
    },
    readFile: () => undefined,
    homedir: () => "/home/test",
    // The crash spool's write primitives, plus the decision log's two. Stubbed rather
    // than omitted so a caller cannot silently no-op against an incomplete double.
    //
    // `appendFile`/`fileSize` are NOT inert: `runHook` now wires the real decision
    // recorder by default, so every hook call that matches a rule goes through
    // them. They are stubbed here precisely so no suite writes to a real home
    // directory; `events.test.ts` drives the recorder against a fake filesystem.
    mkdirp: () => true,
    writeFileAtomic: () => true,
    listDir: () => [],
    deleteFile: () => true,
    appendFile: () => true,
    fileSize: () => 0,
  };
  return { io, written, out: () => written.join("") };
}

describe("hook dispatch", () => {
  it("returns 0 for a deny — the decision rides on stdout, never the exit code", () => {
    const h = harness(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }));
    return runCli(["hook"], h.io).then((code) => {
      expect(code).toBe(0);
      expect(JSON.parse(h.out()).hookSpecificOutput.permissionDecision).toBe("deny");
    });
  });

  it("returns 0 even when the payload is garbage", async () => {
    const h = harness("not json");
    expect(await runCli(["hook"], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ systemMessage: NOT_CHECKED_MESSAGE });
  });

  it("writes ONLY the decision object — no usage text, no banner", async () => {
    const h = harness(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }));
    await runCli(["hook"], h.io);
    expect(h.written).toHaveLength(1);
    expect(() => JSON.parse(h.out())).not.toThrow();
  });

  it("writes nothing at all for a call no guardrail matches", async () => {
    const h = harness(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }));
    await runCli(["hook"], h.io);
    expect(h.written).toEqual([]);
  });

  it("still runs the hook when a stray flag follows it", async () => {
    // A flag in a hooks.json command line must never turn an enforcement call into a
    // usage dump — that would put non-JSON on stdout and silently allow the action.
    const h = harness(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }));
    expect(await runCli(["hook", "--verbose"], h.io)).toBe(0);
    expect(JSON.parse(h.out()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("prefers hook over --help when both appear", async () => {
    const h = harness(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }));
    await runCli(["hook", "--help"], h.io);
    expect(h.out()).not.toContain("Usage:");
  });
});

describe("other commands", () => {
  it("--version prints the version and exits 0", async () => {
    const h = harness();
    expect(await runCli(["--version"], h.io)).toBe(0);
    expect(h.out().trim()).toBe(VERSION);
  });

  it("VERSION is kept in step with package.json", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    );
    expect(VERSION).toBe(pkg.version);
  });

  it("--help prints usage and exits 0", async () => {
    const h = harness();
    expect(await runCli(["--help"], h.io)).toBe(0);
    expect(h.out()).toContain("Usage:");
  });

  it("no arguments prints usage and exits 0", async () => {
    const h = harness();
    expect(await runCli([], h.io)).toBe(0);
    expect(h.out()).toContain("Usage:");
  });

  // A reintroduced "not implemented" branch would otherwise be invisible to this suite.
  it("no command reports itself as not implemented", async () => {
    const h = harness();
    await runCli(["--help"], h.io);
    expect(h.out()).not.toContain("Not yet implemented");
    expect(h.out()).toContain("agenttrail-guard scan");
  });

  it.each([
    "init",
    "status",
    "uninstall",
    "guardrails",
    // The unlisted alias, which dispatches too, so it is listed HERE — beside the
    // commands that are supported — rather than left to the one alias test below.
    "rules",
  ])("%s is dispatched, not reported as planned", async (command) => {
    // A fake SetupIO, so nothing here touches a real `claude` or a real home directory.
    const h = harness();
    const setupIo = {
      writeStdout: h.io.writeStdout,
      readFile: () => undefined,
      exists: () => true,
      writeFileAtomic: () => {},
      homedir: () => "/home/test",
      // `--version` succeeds; every list is empty; so `status`/`uninstall` reach their
      // "nothing installed" paths and `init` reaches its scaffold lookup.
      runClaude: (args: readonly string[]) => ({
        code: 0,
        stdout: args.join(" ").endsWith("--json") ? "[]" : "2.1.263 (Claude Code)",
        stderr: "",
      }),
    };
    await runCli([command], h.io, setupIo);
    expect(h.out()).not.toContain("not implemented yet");
    expect(h.out()).not.toContain("unknown command");
  });

  it("`rules` is a WORKING alias for `guardrails`, and usage teaches only `guardrails`", async () => {
    // Two halves: the alias works, and usage never lists it. The same argv is run under
    // both spellings and the outputs must be identical — a copy of the dispatch table would
    // pass a "does it run?" test and still drift.
    const setupIo = (out: (t: string) => void) => ({
      writeStdout: out,
      readFile: () => undefined,
      exists: () => true,
      writeFileAtomic: () => {},
      homedir: () => "/home/test",
      runClaude: () => ({ code: 0, stdout: "[]", stderr: "" }),
    });

    const viaGuardrails = harness();
    const viaAlias = harness();
    expect(
      await runCli(["guardrails", "list"], viaGuardrails.io, setupIo(viaGuardrails.io.writeStdout)),
    ).toBe(0);
    expect(await runCli(["rules", "list"], viaAlias.io, setupIo(viaAlias.io.writeStdout))).toBe(0);
    expect(viaAlias.out()).toBe(viaGuardrails.out());
    expect(viaGuardrails.out()).toContain("guardrails across");

    const help = harness();
    await runCli(["--help"], help.io);
    expect(help.out()).toContain("agenttrail-guard guardrails");
    // Deliberately narrower than `not.toContain("rules")`. The bare word is still legal
    // in a sentence — "the guardrail library", "the rules it lives by" — and pinning its
    // absence would make an unrelated copy edit fail this test. The claim that matters is
    // that usage never presents the `rules` alias as a command you could type.
    expect(help.out()).not.toContain("agenttrail-guard rules");
  });

  it("routes --clear-history through to status, and only with it", async () => {
    // The flag has to survive `parseArgs`. The `guardrails` dispatch runs before it,
    // but `status` still routes through it, so an option declared there is reached —
    // this is the assertion that keeps that true.
    const writes: Array<{ path: string; text: string }> = [];
    const setupIo = (out: (t: string) => void) => ({
      writeStdout: out,
      readFile: (p: string) =>
        p.endsWith("events.jsonl")
          ? `${JSON.stringify({
              ts: "2026-09-07T00:00:00Z",
              tool: "Bash",
              decision: "deny",
              ruleId: "t.rule",
              command: "danger",
            })}\n`
          : undefined,
      exists: () => true,
      writeFileAtomic: (path: string, text: string) => {
        writes.push({ path, text });
      },
      homedir: () => "/home/test",
      runClaude: (args: readonly string[]) => ({
        code: 0,
        stdout: args.join(" ").endsWith("--json") ? "[]" : "2.1.263 (Claude Code)",
        stderr: "",
      }),
    });

    const cleared = harness();
    expect(
      await runCli(["status", "--clear-history"], cleared.io, setupIo(cleared.io.writeStdout)),
    ).toBe(0);
    expect(cleared.out()).toContain("Decision log cleared");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toBe("");

    // Without the flag, `status` reports as usual and clears nothing.
    writes.length = 0;
    const plain = harness();
    expect(await runCli(["status"], plain.io, setupIo(plain.io.writeStdout))).toBe(0);
    expect(plain.out()).not.toContain("Decision log cleared");
    expect(writes).toHaveLength(0);
  });

  it("usage advertises --clear-history", async () => {
    const h = harness();
    await runCli(["--help"], h.io);
    expect(h.out()).toContain("--clear-history");
  });

  it("scan is dispatched through its own IO seam, not the setup one", async () => {
    // `scan` takes a THIRD IO object (`ScanIO`) because it needs a process spawner for
    // `--open`, which may not exist on the hook path. Passing a fake proves the wiring
    // without touching a real home directory or a real browser.
    const h = harness();
    const scanIo = {
      readdir: (): string[] => {
        throw new Error("ENOENT");
      },
      stat: () => ({ size: 0, mtimeMs: 0, isDirectory: () => false }),
      // An empty async generator: no file is ever opened, because `readdir` throws.
      readLines: async function* (): AsyncIterable<string> {},
      readFile: () => undefined,
      homedir: () => "/home/test",
      cwd: () => "/work",
      writeStdout: h.io.writeStdout,
      // Never called: `--review` is the only consumer and this run does not pass it.
      readLine: (): Promise<string | undefined> => Promise.resolve(undefined),
      writeFile: () => true,
      openInBrowser: () => true,
      env: {},
      isTTY: () => false,
    };
    expect(await runCli(["scan"], h.io, undefined, scanIo)).toBe(0);
    expect(h.out()).toContain("No sessions found");
    expect(h.out()).not.toContain("unknown command");
  });

  it("an unknown command says so and prints usage", async () => {
    const h = harness();
    expect(await runCli(["definitely-not-a-command"], h.io)).toBe(1);
    expect(h.out()).toContain('unknown command "definitely-not-a-command"');
    expect(h.out()).toContain("Usage:");
  });

  it("never throws, whatever the arguments", async () => {
    for (const argv of [["--"], ["-x"], ["--=", "--"], ["hook", "extra"]]) {
      await expect(runCli(argv, harness().io)).resolves.toBeTypeOf("number");
    }
  });
});

describe("runCli never calls process.exit", () => {
  it("leaves the process alone", async () => {
    const spy = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit was called");
    }) as never);
    for (const argv of [["hook"], ["--help"], ["init"], ["nonsense"]]) {
      const h = harness();
      // A fake SetupIO, so `init` runs no real `claude` command.
      await runCli(argv, h.io, {
        writeStdout: h.io.writeStdout,
        readFile: () => undefined,
        exists: () => true,
        writeFileAtomic: () => {},
        homedir: () => "/home/test",
        runClaude: () => ({ code: 0, stdout: "[]", stderr: "" }),
      });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
