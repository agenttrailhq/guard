/**
 * `ScanIO` — the side-effect seam for `scan`.
 *
 * ── Why a THIRD seam, and not a member added to one of the two that exist ────
 * `io.ts` is inside the HOOK BUNDLE GRAPH: `hook-entry.ts` imports it, so anything
 * reachable from it is inlined into `plugin/scripts/guard-hook.mjs`, the file Claude
 * Code executes before every tool call. `scan` needs to open a browser, so teaching
 * `GuardIO` to do it would ship a process spawner into the hot enforcement path.
 * `bundle-graph.test.ts` fails the build if any module in that graph imports
 * `node:child_process`, which is the durable form of the rule.
 *
 * `setup-io.ts` is the other candidate and is rejected for a smaller, real reason:
 * every existing test builds a `SetupIO` object literal, so adding required members
 * there turns suites red across files that have nothing to do with this module.
 *
 * ── The name collides with the transcript reader's `ScanIO` ─────────────────
 * `core/transcript/scan.ts` exports its own `ScanIO` — a three-member
 * `{readdir?, stat?, lineSource?}` for `scanTranscripts`. The collision is resolved by
 * never importing that type: `commands/scan.ts` builds that object inline from the
 * members below. This name matches `setup-io.ts` → `SetupIO`.
 *
 * ── `readdir` and `stat` THROW, and that is on purpose ──────────────────────
 * `scanTranscripts` wraps every call in its own try/catch and turns a failure into
 * "skip this entry" — a missing projects directory is a normal state for someone who
 * has not run Claude Code. Making these return `undefined` instead would mean that
 * error handling silently never runs, so the seam matches the shape the reader
 * expects rather than the shape the rest of this package uses.
 */

import { spawn } from "node:child_process";
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

/** What `scanTranscripts` and `parseSession` need from a `stat` call. */
export interface ScanStat {
  readonly size: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
}

/** Everything `scan` needs from outside the process. */
export interface ScanIO {
  /** Entry names in a directory. THROWS when it cannot be read — see the header. */
  readdir(path: string): string[];
  /** Stat one path. THROWS when it cannot be read — see the header. */
  stat(path: string): ScanStat;
  /** Stream a file's lines. Never buffers a whole transcript; a session can be huge. */
  readLines(path: string): AsyncIterable<string>;
  /** Read a UTF-8 file, or `undefined` when missing or unreadable. */
  readFile(path: string): string | undefined;
  /** The user's home directory; `~/.claude/projects` and `~/.agenttrail` hang off it. */
  homedir(): string;
  /** The working directory. The report is written here. */
  cwd(): string;
  /** Write to stdout. `scan` is for humans and pipes; multi-line output is expected. */
  writeStdout(text: string): void;
  /**
   * Read ONE line from stdin, or `undefined` at end of input.
   *
   * Only `--review` uses it. It returns the raw line rather than a yes/no, so the
   * seam stays dumb and the policy — what counts as consent, and what an unattended
   * run means — stays in `commands/scan.ts` where it is unit-testable. The
   * `undefined` case is load-bearing and is NOT the same as "no": a piped `y` is a
   * deliberate confirmation, while closed stdin is nobody answering at all, and the
   * command has to tell those apart before it writes a file the user has not seen.
   */
  readLine(): Promise<string | undefined>;
  /** Write `text` to `path` at mode `0600`. `false` on any failure; never throws. */
  writeFile(path: string, text: string): boolean;
  /** Open a local file in the desktop's default handler. `false` if it could not. */
  openInBrowser(path: string): boolean;
  /** The environment, for the colour decision. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Is stdout a terminal? Drives colour and nothing else. */
  isTTY(): boolean;
}

/**
 * The platform's "open this file" command, as `[command, ...args]`.
 *
 * NO SHELL on any branch: the path is passed as an argv element, so a directory name
 * containing a space, a quote or a `;` is an argument rather than syntax. `scan` writes
 * this file itself, so the path is not attacker-controlled today — but "the input is
 * trusted" is the assumption that stops being true first, and `shell: true` in a
 * security tool is not a thing to leave lying around.
 */
export function openCommand(platform: string, path: string): readonly string[] {
  if (platform === "darwin") return ["open", path];
  // `start` is a cmd builtin, so it cannot be spawned directly. The empty string is
  // its title argument: without it, `start "C:\some path\x.html"` treats the quoted
  // path AS the window title and opens nothing.
  if (platform === "win32") return ["cmd", "/c", "start", "", path];
  return ["xdg-open", path];
}

/** The real scan IO. Imported only by the CLI entry, never from `core/` or the hook. */
export function createRealScanIO(): ScanIO {
  return {
    readdir(path: string): string[] {
      return readdirSync(path);
    },

    stat(path: string): ScanStat {
      return statSync(path);
    },

    async *readLines(path: string): AsyncIterable<string> {
      const rl = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      try {
        for await (const line of rl) yield line;
      } finally {
        rl.close();
      }
    },

    readFile(path: string): string | undefined {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },

    homedir(): string {
      return homedir();
    },

    cwd(): string {
      return process.cwd();
    },

    writeStdout(text: string): void {
      process.stdout.write(text);
    },

    readLine(): Promise<string | undefined> {
      return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin });
        // `close` fires on EOF as well as after a line, so both listeners are needed
        // and the first one to fire wins. Without the `close` branch a `scan --review
        // < /dev/null` would hang forever holding stdin open, which is worse than
        // either answer.
        let settled = false;
        const done = (value: string | undefined): void => {
          if (settled) return;
          settled = true;
          rl.close();
          // Readline leaves stdin flowing; without this a `scan --review` that has
          // already written its report keeps the event loop alive and the CLI hangs
          // after doing its job.
          process.stdin.pause();
          resolve(value);
        };
        rl.once("line", (line: string) => done(line));
        rl.once("close", () => done(undefined));
      });
    },

    writeFile(path: string, text: string): boolean {
      try {
        // `0600`, like every other file this tool writes. The report is MEANT to be
        // shared — but sharing it should be a thing the user does deliberately, not
        // something the default mode does for them on a shared machine.
        writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    },

    openInBrowser(path: string): boolean {
      try {
        const [command, ...args] = openCommand(process.platform, path);
        if (command === undefined) return false;
        // Detached and fully redirected: the opener must not hold the CLI open, and it
        // must not print into the summary we just wrote. `unref` lets node exit.
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        // An ENOENT arrives asynchronously as an `error` event, which is an unhandled
        // throw without this listener — a missing `xdg-open` would then crash a command
        // that had already done its job and written the report.
        child.on("error", () => {});
        child.unref();
        return true;
      } catch {
        return false;
      }
    },

    env: process.env,

    isTTY(): boolean {
      return process.stdout.isTTY === true;
    },
  };
}
