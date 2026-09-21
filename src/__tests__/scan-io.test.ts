/**
 * `scan-io.ts` — the real seam, against a real temporary directory.
 *
 * `commands/scan.ts` is driven with a fake everywhere else, which proves the command's
 * logic and proves nothing about the implementation the shipped binary actually runs.
 * These tests use the genuine `node:fs` members on files this suite creates and
 * removes.
 *
 * ── What is deliberately NOT exercised, and why ──────────────────────────────
 * `openInBrowser` spawns the desktop's file handler. Calling it for real would open a
 * browser window on the machine running the tests, including CI. Making it testable
 * would mean adding an override to the SHIPPED binary that changes which command it
 * runs — a lever inside the released bytes that redirects a process launch. So the
 * DECISION is tested exhaustively
 * through the exported `openCommand`, and the four lines that hand that decision to
 * `spawn` are kept out of `built-artifact.test.ts`, which runs the real binary with
 * `--no-open`. `commands/scan.ts` covers both outcomes of the boolean it returns.
 */

import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRealScanIO, openCommand } from "../scan-io.js";

const io = createRealScanIO();

/** A temp directory holding one two-line file. */
function fixture(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "guard-scan-io-"));
  const file = join(dir, "a.jsonl");
  writeFileSync(file, "line one\nline two\n", "utf8");
  return { dir, file };
}

describe("reading", () => {
  it("lists a directory", () => {
    const { dir } = fixture();
    expect(io.readdir(dir)).toEqual(["a.jsonl"]);
  });

  it("THROWS on a missing directory — the transcript walker relies on it", () => {
    // A seam that returned `[]` here would leave `scanTranscripts`'s own try/catch
    // unreachable, and "the projects directory does not exist" is the normal state for
    // anyone who has not run Claude Code.
    expect(() => io.readdir(join(tmpdir(), "guard-scan-io-nope-nope"))).toThrow();
  });

  it("stats a file and a directory, and distinguishes them", () => {
    const { dir, file } = fixture();
    expect(io.stat(dir).isDirectory()).toBe(true);
    const stat = io.stat(file);
    expect(stat.isDirectory()).toBe(false);
    expect(stat.size).toBeGreaterThan(0);
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  it("THROWS on a missing path, for the same reason", () => {
    expect(() => io.stat(join(tmpdir(), "guard-scan-io-nope", "x"))).toThrow();
  });

  it("streams a file line by line", async () => {
    const { file } = fixture();
    const lines: string[] = [];
    for await (const line of io.readLines(file)) lines.push(line);
    expect(lines).toEqual(["line one", "line two"]);
  });

  it("reads a whole file, and returns undefined rather than throwing when it is absent", () => {
    const { file } = fixture();
    expect(io.readFile(file)).toContain("line one");
    // Config and rules files are usually absent on a fresh install; that is not an
    // error path, so it does not throw.
    expect(io.readFile(join(tmpdir(), "guard-scan-io-nope", "config.json"))).toBeUndefined();
  });
});

describe("writing", () => {
  it("writes the report and returns true", () => {
    const { dir } = fixture();
    const target = join(dir, "report.html");
    expect(io.writeFile(target, "<!doctype html>")).toBe(true);
    expect(io.readFile(target)).toBe("<!doctype html>");
  });

  it("writes at mode 0600, like every other file this tool creates", () => {
    const { dir } = fixture();
    const target = join(dir, "modes.html");
    io.writeFile(target, "x");
    // The report is MEANT to be shared — but sharing it should be something the user
    // does deliberately, not something the default mode does on a shared machine.
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("returns FALSE rather than throwing when the path cannot be written", () => {
    // `commands/scan.ts` turns this into "print the summary anyway and name the
    // failure". A throw here would lose the summary, which is the payoff.
    const { dir } = fixture();
    expect(io.writeFile(join(dir, "no-such-subdir", "x.html"), "x")).toBe(false);
    expect(existsSync(join(dir, "no-such-subdir"))).toBe(false);
  });
});

describe("the environment", () => {
  it("reports a home directory, a working directory and the environment", () => {
    expect(io.homedir().length).toBeGreaterThan(0);
    expect(io.cwd().length).toBeGreaterThan(0);
    expect(typeof io.env).toBe("object");
  });

  it("answers the TTY question with a boolean, whichever way the suite runs", () => {
    expect(typeof io.isTTY()).toBe("boolean");
  });

  it("writes to stdout without throwing", () => {
    expect(() => io.writeStdout("")).not.toThrow();
  });
});

describe("openCommand — the platform decision, tested without launching anything", () => {
  it("uses `open` on macOS", () => {
    expect(openCommand("darwin", "/tmp/r.html")).toEqual(["open", "/tmp/r.html"]);
  });

  it("uses `xdg-open` on Linux and on any platform we do not name", () => {
    expect(openCommand("linux", "/tmp/r.html")).toEqual(["xdg-open", "/tmp/r.html"]);
    expect(openCommand("freebsd", "/tmp/r.html")).toEqual(["xdg-open", "/tmp/r.html"]);
  });

  it("passes an EMPTY TITLE on Windows, which is the whole trap", () => {
    // `start "C:\\some path\\x.html"` treats the quoted path as the window TITLE and
    // opens nothing at all. The empty string occupies that slot so the path is read as
    // the file. Silent, and only reproducible on Windows — hence the unit test.
    expect(openCommand("win32", "C:\\some path\\r.html")).toEqual([
      "cmd",
      "/c",
      "start",
      "",
      "C:\\some path\\r.html",
    ]);
  });

  it("never puts the path anywhere but its own argv slot", () => {
    // No shell on any branch: a directory name containing a space, a quote or a `;`
    // has to arrive as an argument rather than as syntax.
    const nasty = `/tmp/a b'; rm -rf /;.html`;
    for (const platform of ["darwin", "linux", "win32"]) {
      const argv = openCommand(platform, nasty);
      expect(argv.filter((a) => a === nasty)).toHaveLength(1);
      expect(argv[0]).not.toContain(nasty);
    }
  });
});
