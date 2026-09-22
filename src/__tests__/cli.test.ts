/**
 * `runCli` — dispatch, and the rule that `hook` can never return non-zero.
 *
 * `runCli` RETURNS a code instead of calling `process.exit`, which is what makes it
 * testable in-process at all — and, more importantly, means no CLI path can stumble
 * into Claude Code's blocking signal.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCli, VERSION } from "../cli.js";
import { NOT_CHECKED_MESSAGE } from "../commands/hook.js";
import { hasGuardCursorEntry } from "../core/cursor-entry.js";
import type { GuardIO } from "../io.js";
import { resolvePluginScaffoldDir } from "../plugin/install.js";
import type { SetupIO } from "../setup-io.js";
import { fakeCodexFiles } from "./codex-files.js";
import { fakeCursorFiles } from "./cursor-files.js";

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
    "init --agent claude",
    "status",
    "uninstall --agent claude",
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
    await runCli(command.split(" "), h.io, setupIo);
    expect(h.out()).not.toContain("not implemented yet");
    expect(h.out()).not.toContain("unknown command");
    expect(h.out()).not.toContain("choose --agent");
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
              agent: "claude",
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

  it("gives status the app file seams and the hook IO it was handed", async () => {
    // `status` reads `~/.cursor/hooks.json` through `cursorIo`, `~/.codex/hooks.json`
    // through `codexIo`, and the crash spool through the hook's `GuardIO`. Checked by what
    // each seam was asked to read, not by the output.
    const h = harness();
    const listed: string[] = [];
    const io: GuardIO = {
      ...h.io,
      listDir: (path) => {
        listed.push(path);
        return [];
      },
    };
    const cursor = fakeCursorFiles();
    const setupIo: SetupIO = {
      writeStdout: h.io.writeStdout,
      readFile: () => undefined,
      exists: () => true,
      writeFileAtomic: () => {},
      homedir: () => "/home/test",
      runClaude: (args) => ({
        code: 0,
        stdout: args.join(" ").endsWith("--json") ? "[]" : "2.1.263 (Claude Code)",
        stderr: "",
      }),
    };
    const codex = fakeCodexFiles();
    expect(await runCli(["status"], io, setupIo, undefined, cursor.io, codex.io)).toBe(0);
    expect(cursor.reads).toContain(join("/home/test", ".cursor", "hooks.json"));
    expect(codex.reads).toContain(join("/home/test", ".codex", "hooks.json"));
    expect(listed).toEqual([join("/home/test", ".agenttrail", "guard", "crashes")]);
    expect(h.out()).toContain(
      "Enforcement: NOT INSTALLED — run `agenttrail-guard init --agent cursor`.",
    );
    expect(h.out()).toContain(
      "Enforcement: NOT INSTALLED — run `agenttrail-guard init --agent codex`.",
    );
  });

  it("usage advertises --clear-history", async () => {
    const h = harness();
    await runCli(["--help"], h.io);
    expect(h.out()).toContain("--clear-history");
  });

  it("scan is dispatched through its own IO seam, not the setup one", async () => {
    // `scan` takes a THIRD IO object (`ScanIO`) because it needs a process spawner to open
    // the report, which may not exist on the hook path. Passing a fake proves the wiring
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
    expect(await runCli(["scan", "--agent", "claude"], h.io, undefined, scanIo)).toBe(0);
    expect(h.out()).toContain("No sessions found");
    expect(h.out()).not.toContain("unknown command");
  });

  it("scan without --agent says to choose one, reads nothing and exits 1", async () => {
    // `scan` takes its raw arguments, bypassing the parser above, so its own check is the
    // only one. It has to hold through `runCli` too.
    const h = harness();
    const touched: string[] = [];
    const scanIo = {
      readdir: (path: string): string[] => {
        touched.push(path);
        return [];
      },
      stat: (path: string) => {
        touched.push(path);
        return { size: 0, mtimeMs: 0, isDirectory: () => false };
      },
      readLines: async function* (path: string): AsyncIterable<string> {
        touched.push(path);
        yield* [];
      },
      readFile: (path: string) => {
        touched.push(path);
        return undefined;
      },
      homedir: () => "/home/test",
      cwd: () => "/work",
      writeStdout: h.io.writeStdout,
      readLine: (): Promise<string | undefined> => Promise.resolve(undefined),
      writeFile: (path: string) => {
        touched.push(path);
        return true;
      },
      openInBrowser: () => true,
      env: {},
      isTTY: () => false,
    };
    expect(await runCli(["scan"], h.io, undefined, scanIo)).toBe(1);
    expect(h.out()).toContain(
      "agenttrail-guard scan: choose --agent claude, --agent cursor or --agent codex.",
    );
    expect(touched).toEqual([]);
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

describe("usage and the README name the same commands that take --agent", () => {
  /** The three commands `--agent` is required on, as usage spells them. */
  const SPELLINGS = [
    "init --agent <claude|cursor|codex>",
    "scan --agent <claude|cursor|codex>",
    "uninstall --agent <claude|cursor|codex>",
  ];

  /** `<command> --agent <claude|cursor|codex>`, wherever a line starts with `start` then the bin name. */
  function agentCommands(lines: readonly string[], start: string): string[] {
    const prefix = `${start}agenttrail-guard `;
    return lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length))
      .flatMap((rest) => /^(\S+ --agent <claude\|cursor\|codex>)/.exec(rest)?.[1] ?? [])
      .sort();
  }

  it("--help lists init, uninstall and scan with --agent <claude|cursor|codex>", async () => {
    const h = harness();
    await runCli(["--help"], h.io);
    expect(agentCommands(h.out().split("\n"), "  ")).toEqual(SPELLINGS);
  });

  it("the README commands table names the same three", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
    const start = readme.indexOf("\n## The commands\n");
    expect(start).toBeGreaterThan(-1);
    const end = readme.indexOf("\n## ", start + 1);
    // A Markdown table cell needs its `|` escaped as `\|`, including inside a code span.
    const rows = readme
      .slice(start, end === -1 ? undefined : end)
      .split("\n")
      .map((line) => line.replace(/\\\|/g, "|"));
    expect(agentCommands(rows, "| `")).toEqual(SPELLINGS);
  });
});

describe("the README says how to update", () => {
  const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

  /** The text of one `###` section, up to the next heading of any level. */
  function section(heading: string): string {
    const start = readme.indexOf(`\n### ${heading}\n`);
    expect(start, heading).toBeGreaterThan(-1);
    const end = readme.slice(start + 1).search(/\n#{2,3} /);
    return end === -1 ? readme.slice(start) : readme.slice(start, start + 1 + end);
  }

  it("names every step an update needs, for both apps", () => {
    // Skipping any one leaves the old hook enforcing: a cached `npx` copy, a plugin
    // never refreshed, or a running Claude Code still holding the old cached copy.
    const updating = section("Updating");
    expect(updating).toContain("@agenttrail/guard@latest");
    expect(updating).toContain("init --agent claude");
    expect(updating).toContain("init --agent cursor");
    expect(updating).toMatch(/restart/i);
  });

  it("every npx command it prints asks for @latest", () => {
    const npx = readme.match(/npx @agenttrail\/guard\S*/g) ?? [];
    expect(npx.length).toBeGreaterThan(0);
    for (const command of npx) expect(command).toBe("npx @agenttrail/guard@latest");
  });
});

describe("--agent on init and uninstall, through the CLI's own parser", () => {
  /** A `SetupIO` and a Cursor file seam that record everything done through them. */
  function recordingSeams(out: (text: string) => void) {
    const touched: string[] = [];
    const setupIo: SetupIO = {
      writeStdout: out,
      readFile: (p) => {
        touched.push(`read ${p}`);
        return undefined;
      },
      exists: (p) => {
        touched.push(`exists ${p}`);
        return true;
      },
      writeFileAtomic: (p) => {
        touched.push(`write ${p}`);
      },
      homedir: () => {
        touched.push("homedir");
        return "/home/test";
      },
      runClaude: (args) => {
        touched.push(`claude ${args.join(" ")}`);
        return { code: 0, stdout: "[]", stderr: "" };
      },
    };
    return { setupIo, cursor: fakeCursorFiles(), touched };
  }

  it.each(
    ["init", "uninstall"].flatMap((command) =>
      [[], ["--agent"], ["--agent", "x"], ["--agent", "--print"]].map((flags) => ({
        line: [command, ...flags].join(" "),
        argv: [command, ...flags],
      })),
    ),
  )("`$line` prints the choice, exits 1, and reads, writes and runs nothing", async ({ argv }) => {
    const h = harness();
    const { setupIo, cursor, touched } = recordingSeams(h.io.writeStdout);
    expect(await runCli(argv, h.io, setupIo, undefined, cursor.io)).toBe(1);
    expect(h.out()).toContain("choose --agent claude, --agent cursor or --agent codex");
    expect(touched).toEqual([]);
    expect(cursor.reads).toEqual([]);
    expect(cursor.writes).toEqual([]);
    expect(cursor.deletes).toEqual([]);
  });

  it("`init --agent cursor` writes guard's entries, and `uninstall --agent=cursor` removes them", async () => {
    const hookSource = join(resolvePluginScaffoldDir(), "scripts", "guard-hook.mjs");
    const hooksPath = join("/home/test", ".cursor", "hooks.json");
    const cursor = fakeCursorFiles({ files: { [hookSource]: "// hook\n" } });
    const claudeCalls: string[][] = [];
    const seams = (out: (text: string) => void): SetupIO => ({
      writeStdout: out,
      readFile: () => undefined,
      exists: () => true,
      writeFileAtomic: () => {},
      homedir: () => "/home/test",
      runClaude: (args) => {
        claudeCalls.push([...args]);
        return { code: 0, stdout: "[]", stderr: "" };
      },
    });

    const installed = harness();
    const installIo = seams(installed.io.writeStdout);
    expect(
      await runCli(["init", "--agent", "cursor"], installed.io, installIo, undefined, cursor.io),
    ).toBe(0);
    expect(hasGuardCursorEntry(cursor.files.get(hooksPath)?.text)).toBe(true);

    const removed = harness();
    const removeIo = seams(removed.io.writeStdout);
    expect(
      await runCli(["uninstall", "--agent=cursor"], removed.io, removeIo, undefined, cursor.io),
    ).toBe(0);
    expect(hasGuardCursorEntry(cursor.files.get(hooksPath)?.text)).toBe(false);
    expect(claudeCalls).toEqual([]);
  });

  it("`init --agent cursor --print` reaches the plan and writes nothing", async () => {
    const hookSource = join(resolvePluginScaffoldDir(), "scripts", "guard-hook.mjs");
    const h = harness();
    const { setupIo, cursor, touched } = recordingSeams(h.io.writeStdout);
    cursor.files.set(hookSource, { text: "// hook\n", mode: 0o644 });
    expect(
      await runCli(["init", "--agent", "cursor", "--print"], h.io, setupIo, undefined, cursor.io),
    ).toBe(0);
    expect(h.out()).toContain("init --agent cursor --print — this is what would happen");
    expect(cursor.writes).toEqual([]);
    expect(touched.filter((t) => t.startsWith("write ") || t.startsWith("claude "))).toEqual([]);
  });

  it("`init --agent codex` writes guard's entries, and `uninstall --agent=codex` removes them", async () => {
    // Also the proof that the Codex seam is threaded through: with it not passed on, these
    // would reach for the real `~/.codex/hooks.json`.
    const hookSource = join(resolvePluginScaffoldDir(), "scripts", "guard-hook.mjs");
    const hooksPath = join("/home/test", ".codex", "hooks.json");
    const codex = fakeCodexFiles({ files: { [hookSource]: "// hook\n" } });
    const claudeCalls: string[][] = [];
    const seams = (out: (text: string) => void): SetupIO => ({
      writeStdout: out,
      readFile: () => undefined,
      exists: () => true,
      writeFileAtomic: () => {},
      homedir: () => "/home/test",
      runClaude: (args) => {
        claudeCalls.push([...args]);
        return { code: 0, stdout: "[]", stderr: "" };
      },
    });

    const installed = harness();
    expect(
      await runCli(
        ["init", "--agent", "codex"],
        installed.io,
        seams(installed.io.writeStdout),
        undefined,
        undefined,
        codex.io,
      ),
    ).toBe(0);
    expect(codex.files.get(hooksPath)?.text).toContain("--agent codex");

    const removed = harness();
    expect(
      await runCli(
        ["uninstall", "--agent=codex"],
        removed.io,
        seams(removed.io.writeStdout),
        undefined,
        undefined,
        codex.io,
      ),
    ).toBe(0);
    expect(codex.files.has(hooksPath)).toBe(false);
    expect(claudeCalls).toEqual([]);
  });
});

describe("runCli never calls process.exit", () => {
  it("leaves the process alone", async () => {
    const spy = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit was called");
    }) as never);
    for (const argv of [
      ["hook"],
      ["--help"],
      ["init"],
      ["init", "--agent", "claude"],
      ["nonsense"],
    ]) {
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
