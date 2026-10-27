// cspell:words egrep fgrep zgrep apropos whatis tldr whereis stdbuf bunx herestring heredocs redirections whatchanged shortlog pytest nohup iglob mtext Stext ovalue osascript hookspath mksh execdir okdir fdfind encodedcommand
/**
 * Ran, or only mentioned: did a matched tool call actually run on this machine?
 *
 * Every check counts commands that ran, so this module decides it, in two halves.
 *
 * ── Where the matched text sits ──────────────────────────────────────────────
 * A guardrail matches text, and the same text can sit where nothing runs it:
 *
 *     grep -rn "rm -rf /" src          a search pattern
 *     echo "never run rm -rf /"        printed text
 *     git commit -m "stop rm -rf /"    a message
 *     cat > notes.md <<EOF … EOF        a heredoc written to a file
 *     vitest run -t "rm -rf /"         a test-name filter
 *     # rm -rf /                        a comment
 *
 * `executedView` returns the command with those regions blanked out, and `runVerdict`
 * evaluates the guardrails again on it. If nothing matches any more, the match came only from
 * text that was never run, and the call is `mentioned`. If something still matches, the
 * matched text sits where the shell runs it.
 *
 * The reading is deliberately one-sided. A region is blanked only when the program that takes
 * it is known to treat it as data: `grep`'s pattern, `echo`'s arguments, a `-m` message. Any
 * other program's argument is kept, because `psql -c "DROP TABLE t"` runs the text it is
 * given, and so do `bash -c`, `ssh`, `xargs` and a heredoc fed to `psql`. A text inside a
 * `$(…)` or backticks is kept too: `echo "$(rm -rf x)"` runs `rm`. Getting it wrong in that
 * direction counts a mention as a command, which overstates; the other direction would hide a
 * command that ran.
 *
 * Printed text is data only while it stays printed:
 *  - a command whose output goes into a pipe blanks nothing (`echo "…" | sh`,
 *    `cat <<EOF | bash`, `(echo …) | sh`), unless every program down the pipe only prints a
 *    part of what it gets (`grep … | head`);
 *  - a command that writes a file blanks nothing unless every later command in the call is on
 *    a short list of programs that cannot run it (`git add`, `ls`, `wc`, …), since any other
 *    program might (`npx tsx x.ts`, `uv run x.py`, `ssh host bash < x.sh`, `crontab x`, `./x`).
 *    `git` is on it only with no global `-c`, `--config-env` or `--exec-path`, no `--ext-diff`
 *    or `rebase --exec`, and only while the call has written no hook or git config. A call
 *    kept only by this rule is `ran` with `why: "may-run-written-file"`, which no count uses.
 *    A file written in one call and run in a later call is not seen: each call is read alone;
 *  - the body of a heredoc whose delimiter is not quoted (`<<EOF`) is expanded by the shell,
 *    so one holding `$(…)` or backticks is never blanked.
 * The one substitution read as data is a value that only prints a heredoc with a quoted
 * delimiter or no substitution in its body, `-m "$(cat <<'EOF' … EOF)"`, which is how agents
 * pass a commit message or a PR body.
 *
 * ── Whether it ran ───────────────────────────────────────────────────────────
 * A call whose matched text sits where the shell runs it is `ran` only when the transcript
 * records a result for it:
 *
 *   Claude Code   a `tool_result` for the call's id. An error result counts as `ran` only
 *                 when it reports the command's exit code; otherwise it was refused, blocked
 *                 or failed before it started.
 *   Codex         a `custom_tool_call_output` for the call's `call_id`. Whether Codex also
 *                 writes one for a call a hook blocked is not established, so a Codex `ran`
 *                 may include blocked calls (`ranEvidence: "output-record"`). This reading is
 *                 tested on synthetic sessions built from the documented rollout format only.
 *   Cursor        session files record no results and no tool-use ids, so no Cursor call is
 *                 ever `ran`: it is `unknown`, or `mentioned` when the text says so.
 *
 * ── What a call could hide ───────────────────────────────────────────────────
 * `hidingFormsOf` reports, per call, the forms that run something this reading does not take
 * apart: `bash -c`, `find -exec`, `xargs`, `<(…)`/`>(…)`, a `$(…)`, `eval`, `git` with a `-c`
 * or after the call wrote a hook, and a PowerShell command. A check may not report a category
 * clean while a call that ran holds one that could hide what it looks for. See `HIDING_FORMS`.
 */

import { unhandledAgent } from "../agent.js";
import type { CompiledAllowlist } from "../evaluate.js";
import type { CompiledRule } from "../rules.js";
import { evaluateAction, type ScanCorpus, toolUseCalls } from "../scan-report.js";
import type { ToolResult } from "../transcript/transcript-types.js";
import type { AgentSource, MappedCall } from "../types.js";
import {
  HIDING_FORMS,
  type HidingForm,
  type RanEvidence,
  type RunTally,
  type RunVerdict,
  type RunWhy,
} from "./types.js";

/** Why a region was blanked. */
export type MentionKind = "search" | "doc" | "test-string" | "heredoc";

/** A command with every region that is only data blanked out. */
export interface ExecutedView {
  /** The command, with each data region replaced by spaces. Line breaks are kept. */
  readonly text: string;
  /** The kinds of region blanked, in the order they appear. Empty when nothing was. */
  readonly kinds: readonly MentionKind[];
}

/** One word of a command, with where it sits in the original text. */
interface Word {
  readonly start: number;
  readonly end: number;
  /** The word with its quotes and escapes removed. */
  readonly value: string;
  /** It holds a `$(…)` or a backtick substitution, so part of it runs. */
  readonly runs: boolean;
}

/** A heredoc's body, a here-string or a comment, as a range of the original text. */
interface Body {
  readonly start: number;
  readonly end: number;
}

/** Data fed to a command's standard input: a heredoc body or a here-string. */
interface Input extends Body {
  /**
   * The shell expands it before the command reads it, and it holds a `$(…)` or backticks, so
   * part of it runs: a heredoc with an unquoted delimiter (`<<EOF`, not `<<'EOF'`), or a
   * here-string word with a substitution.
   */
  readonly expands: boolean;
}

/** One simple command: its words, the data fed to its standard input, and where its output goes. */
interface Segment {
  /** Words other than redirection targets, in order. */
  readonly words: Word[];
  /** Heredoc bodies and here-strings fed to this command. */
  readonly inputs: Input[];
  /** Its output goes into a pipe (`|`, `|&`), alone or as part of a `( … )` or `{ … }` group. */
  pipedOut: boolean;
  /** It redirects its output into a file (`>`, `>>`, `&>`). */
  writesFile: boolean;
  /** The files its output redirects name, as written. */
  readonly written: string[];
  /** Its standard input is redirected from a file (`< file`). */
  readsFile: boolean;
}

/** A segment with nothing in it yet. */
function emptySegment(): Segment {
  return {
    words: [],
    inputs: [],
    pipedOut: false,
    writesFile: false,
    written: [],
    readsFile: false,
  };
}

/** A heredoc whose delimiter has been read and whose body starts after the next line break. */
interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  /** Any part of the delimiter word was quoted or escaped, so the body is not expanded. */
  readonly quoted: boolean;
  readonly segment: Segment;
}

/** Does this text hold a command substitution, which runs when the shell expands it? */
function holdsSubstitution(text: string): boolean {
  return text.includes("$(") || text.includes("`");
}

/** One blanked range, and why. */
interface Region {
  readonly start: number;
  readonly end: number;
  readonly kind: MentionKind;
}

/** A command split into simple commands, with its comments. */
interface Parsed {
  readonly segments: readonly Segment[];
  readonly comments: readonly Body[];
  /** It holds a process substitution, `<(…)` or `>(…)`. */
  readonly processSubstitution: boolean;
  /** A redirection target holds a `$(…)` or backticks, which run. */
  readonly targetRuns: boolean;
}

/**
 * Where a quoted string ends, starting at its opening character. Inside double quotes a
 * `$(…)` is skipped whole, so a quote inside the substitution does not end the string.
 */
function skipQuoted(text: string, at: number, quote: string): number {
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote !== "'" && ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === '"' && ch === "$" && text[i + 1] === "(") {
      i = skipSubstitution(text, i + 1);
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

/** A heredoc delimiter at `at` (just past `<<` or `<<-`): its text, and where it ends. */
function readDelimiter(text: string, at: number): { delimiter: string; end: number } | undefined {
  let i = at;
  while (text[i] === " " || text[i] === "\t") i += 1;
  const quote = text[i];
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, i + 1);
    if (close < 0) return undefined;
    return { delimiter: text.slice(i + 1, close), end: close + 1 };
  }
  const match = /^[^\s;&|<>()]+/.exec(text.slice(i));
  if (match === null) return undefined;
  return { delimiter: match[0].replace(/\\/g, ""), end: i + match[0].length };
}

/**
 * Where a `$(…)` ends, counting nested parentheses, skipping quoted text and skipping the body
 * of any heredoc opened inside it, so an apostrophe in a heredoc message is not a quote.
 */
function skipSubstitution(text: string, at: number): number {
  let depth = 0;
  let i = at;
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n" && pending.length > 0) {
      i += 1;
      for (const doc of pending.splice(0)) {
        while (i < text.length) {
          const lineEnd = text.indexOf("\n", i);
          const stop = lineEnd < 0 ? text.length : lineEnd;
          const line = text.slice(i, stop);
          i = lineEnd < 0 ? text.length : lineEnd + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
        }
      }
      continue;
    }
    if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const stripTabs = text[i + 2] === "-";
      const read = readDelimiter(text, i + (stripTabs ? 3 : 2));
      if (read !== undefined) {
        pending.push({ delimiter: read.delimiter, stripTabs });
        i = read.end;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(text, i, ch);
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/**
 * Split a shell command into simple commands.
 *
 * A best-effort reading of POSIX shell: quotes, escapes, `$(…)` and backticks, the control
 * operators, redirections, here-strings, heredocs and comments. It never fails; text it cannot
 * place stays in a word, which keeps it on the "runs" side.
 */
function parseShell(text: string): Parsed {
  const segments: Segment[] = [];
  const comments: Body[] = [];
  const pending: PendingHeredoc[] = [];
  // Each open `(` group: where it starts in `segments`, and whether its output is read by the
  // command around it (an input process substitution, `<(…)`).
  const groups: { readonly from: number; readonly read: boolean }[] = [];
  // A `<(` or `>(` was just read, so the next `(` opens a process substitution.
  let substitution: "input" | "output" | undefined;
  // The redirect target being read is a file the output goes to.
  let targetWrites = false;
  let processSubstitution = false;
  let targetRuns = false;
  let segment: Segment = emptySegment();
  // What the next completed word is: an ordinary word, a redirection target, a heredoc
  // delimiter or a here-string.
  let next: "word" | "target" | "heredoc" | "herestring" | "heredoc-tabs" = "word";
  let wordStart = -1;
  let value = "";
  let runs = false;
  // Any part of the current word was quoted or escaped.
  let quotedWord = false;

  const endWord = (end: number): void => {
    if (wordStart < 0) return;
    const word: Word = { start: wordStart, end, value, runs };
    if (next === "word") segment.words.push(word);
    else if (next === "heredoc" || next === "heredoc-tabs") {
      pending.push({
        delimiter: value,
        stripTabs: next === "heredoc-tabs",
        quoted: quotedWord,
        segment,
      });
    } else if (next === "herestring") {
      segment.inputs.push({ start: word.start, end: word.end, expands: runs });
    } else if (next === "target") {
      if (targetWrites) segment.written.push(value);
      if (runs) targetRuns = true;
    }
    targetWrites = false;
    next = "word";
    wordStart = -1;
    value = "";
    runs = false;
    quotedWord = false;
  };
  const endSegment = (end: number): void => {
    endWord(end);
    if (segment.words.length > 0 || segment.inputs.length > 0) segments.push(segment);
    segment = emptySegment();
  };
  /** Mark segments from `from` on as writing into a pipe. */
  const pipeFrom = (from: number): void => {
    for (let k = Math.max(0, from); k < segments.length; k++)
      (segments[k] as Segment).pipedOut = true;
  };
  /**
   * The segment just ended went into a pipe. A `{ … }` group ends in a segment that is only
   * `}`, and then the whole group goes into the pipe.
   */
  const pipeLast = (): void => {
    const last = segments[segments.length - 1];
    if (last === undefined) return;
    last.pipedOut = true;
    if (last.words.length === 1 && last.words[0]?.value === "}") {
      for (let k = segments.length - 1; k >= 0; k--) {
        const seg = segments[k] as Segment;
        seg.pipedOut = true;
        if (seg.words[0]?.value === "{") break;
      }
    }
  };
  const startWord = (at: number): void => {
    if (wordStart < 0) wordStart = at;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;

    if (ch === "\n") {
      endSegment(i);
      i += 1;
      // Heredoc bodies start on the line after the one that declared them, in order.
      while (pending.length > 0 && i <= text.length) {
        const doc = pending.shift() as PendingHeredoc;
        const start = i;
        let end = text.length;
        let after = text.length;
        while (i < text.length) {
          const lineEnd = text.indexOf("\n", i);
          const stop = lineEnd < 0 ? text.length : lineEnd;
          const line = text.slice(i, stop);
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
            end = i;
            after = lineEnd < 0 ? text.length : lineEnd + 1;
            break;
          }
          i = lineEnd < 0 ? text.length : lineEnd + 1;
        }
        // An unquoted delimiter means the shell expands the body, running any substitution.
        doc.segment.inputs.push({
          start,
          end,
          expands: !doc.quoted && holdsSubstitution(text.slice(start, end)),
        });
        i = after;
      }
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord(i);
      i += 1;
      continue;
    }

    if (ch === "#" && wordStart < 0) {
      const lineEnd = text.indexOf("\n", i);
      const stop = lineEnd < 0 ? text.length : lineEnd;
      comments.push({ start: i, end: stop });
      i = stop;
      continue;
    }

    if (ch === "'" || ch === '"') {
      startWord(i);
      quotedWord = true;
      const end = skipQuoted(text, i, ch);
      const inner = text.slice(i + 1, Math.max(i + 1, end - 1));
      if (ch === '"' && (inner.includes("$(") || inner.includes("`"))) runs = true;
      value += ch === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
      i = end;
      continue;
    }

    if (ch === "\\") {
      startWord(i);
      quotedWord = true;
      // A backslash before a line break joins the two lines.
      if (text[i + 1] !== "\n") value += text[i + 1] ?? "";
      i += 2;
      continue;
    }

    if (ch === "$" && text[i + 1] === "(") {
      startWord(i);
      const end = skipSubstitution(text, i + 1);
      value += text.slice(i, end);
      runs = true;
      i = end;
      continue;
    }

    if (ch === "`") {
      startWord(i);
      const end = skipQuoted(text, i, "`");
      value += text.slice(i, end);
      runs = true;
      i = end;
      continue;
    }

    if ((ch === "<" || ch === ">") && text[i + 1] === "(") {
      // Process substitution. `>(cmd)` hands this command's output to `cmd`, so it is piped;
      // `<(cmd)` hands `cmd`'s output to this command. Either way the text inside is commands,
      // read as a group of their own.
      endWord(i);
      next = "word";
      if (ch === ">") segment.pipedOut = true;
      substitution = ch === "<" ? "input" : "output";
      processSubstitution = true;
      i += 1;
      continue;
    }

    if (ch === "<" || ch === ">") {
      // A word of digits right before is the file descriptor, not an argument.
      if (wordStart >= 0 && /^\d+$/.test(value)) {
        wordStart = -1;
        value = "";
      } else endWord(i);
      if (text.startsWith("<<<", i)) {
        next = "herestring";
        i += 3;
      } else if (text.startsWith("<<-", i)) {
        next = "heredoc-tabs";
        i += 3;
      } else if (text.startsWith("<<", i)) {
        next = "heredoc";
        i += 2;
      } else {
        // `>`, `>>`, `<`, `>|`, `<>`, and `>&` / `<&` with a descriptor. An output redirect
        // to anything but a descriptor (`2>&1`) writes a file.
        const start = i;
        i += 1;
        while (i < text.length && /[>|&<]/.test(text[i] as string)) i += 1;
        const operator = text.slice(start, i);
        const toDescriptor = operator.endsWith("&") && /^\s*(?:\d|-)/.test(text.slice(i));
        if (operator.startsWith(">") && !toDescriptor) segment.writesFile = true;
        if (operator.startsWith("<") && !toDescriptor) segment.readsFile = true;
        targetWrites = operator.startsWith(">") && !toDescriptor;
        next = "target";
      }
      continue;
    }

    if (ch === "&" && text[i + 1] === ">") {
      endWord(i);
      i += 2;
      if (text[i] === ">") i += 1;
      segment.writesFile = true;
      next = "target";
      targetWrites = true;
      continue;
    }

    if (ch === "(") {
      endSegment(i);
      groups.push({ from: segments.length, read: substitution === "input" });
      substitution = undefined;
      i += 1;
      continue;
    }

    if (ch === ")") {
      endSegment(i);
      const group = groups.pop();
      const from = group?.from ?? 0;
      i += 1;
      // What an input process substitution prints is read by the command around it.
      if (group?.read === true) pipeFrom(from);
      // A group whose output goes into a pipe pipes every command in it.
      const after = /^[ \t]*\|(?!\|)/.exec(text.slice(i));
      if (after !== null) pipeFrom(from);
      continue;
    }

    if (ch === ";" || ch === "&" || ch === "|") {
      endSegment(i);
      i += 1;
      const pipe = ch === "|" && text[i] !== "|";
      // `&&`, `||`, `|&` and `;;` are one operator.
      if (/[&|;]/.test(text[i] ?? "")) i += 1;
      if (pipe) pipeLast();
      continue;
    }

    startWord(i);
    value += ch;
    i += 1;
  }
  endSegment(text.length);
  return { segments, comments, processSubstitution, targetRuns };
}

/** Words that come before the program and are not it. */
const PREFIX_WORDS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "command",
  "builtin",
  "exec",
  "time",
  "nohup",
  "nice",
  "stdbuf",
  "timeout",
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
]);

/** Options of a prefix word that take the next word as their value. */
const PREFIX_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-u", "-g", "-n", "-s", "-k"]);

/** A shell variable assignment before the program, such as `HUSKY=0`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program's name: its file name, lower-cased, without `.exe`. */
function programName(word: Word): string {
  const base = word.value.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** The index of the program word, past assignments and prefix words such as `sudo`. */
function programIndex(words: readonly Word[]): number {
  let k = 0;
  while (k < words.length) {
    const word = words[k] as Word;
    if (ASSIGNMENT.test(word.value)) {
      k += 1;
      continue;
    }
    const name = programName(word);
    if (!PREFIX_WORDS.has(name)) return k;
    k += 1;
    // A prefix word's own options, and `timeout`'s duration.
    while (k < words.length && (words[k] as Word).value.startsWith("-")) {
      const option = (words[k] as Word).value;
      k += PREFIX_VALUE_OPTIONS.has(option) ? 2 : 1;
    }
    if (name === "timeout" && k < words.length) k += 1;
  }
  return k;
}

/** Programs whose arguments are printed, not run. */
const PRINTERS: ReadonlySet<string> = new Set(["echo", "printf"]);

/** Programs that look a word up. Their arguments are searched for, not run. */
const LOOKUPS: ReadonlySet<string> = new Set([
  "man",
  "which",
  "type",
  "apropos",
  "whatis",
  "tldr",
  "whereis",
  "help",
]);

/** Programs that search for a pattern. */
const SEARCHERS: ReadonlySet<string> = new Set([
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "ag",
  "ack",
]);

/** A searcher's options that take the next word as their value, which is not the pattern. */
const SEARCH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "-f",
  "-d",
  "-D",
  "-g",
  "-t",
  "-T",
  "-j",
  "-M",
  "-E",
  "--glob",
  "--iglob",
  "--type",
  "--type-not",
  "--max-count",
  "--file",
  "--context",
  "--after-context",
  "--before-context",
  "--max-columns",
  "--encoding",
]);

/** Programs that feed a heredoc or a here-string into a file or the terminal. */
const INPUT_SINKS: ReadonlySet<string> = new Set(["cat", "tee", "echo", "printf"]);

/**
 * Programs that cannot run a file written earlier in the same command, nor the text they are
 * given. After a command writes a file, its data is blanked only when every later command is
 * one of these: any other program might run what was written (`bash x.sh`, `npx tsx x.ts`,
 * `uv run x.py`, `go run main.go`, `ssh host bash < x.sh`, `crontab cron.txt`, `./x.sh`). The
 * list is short on purpose; a program missing from it errs towards `ran`.
 */
const INERT_PROGRAMS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "wc",
  "head",
  "tail",
  "diff",
  "chmod",
  "echo",
  "printf",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
  "stat",
  "file",
  "du",
  "mkdir",
  "touch",
  "pwd",
  "cd",
  "true",
  "false",
]);

/** `git` subcommands that do not run a file from the working tree. */
const INERT_GIT: ReadonlySet<string> = new Set(["add", "commit", "status", "diff", "log", "show"]);

/**
 * Programs that only consume what is piped into them and print a part of it. A search piped
 * into one (`grep … | head`) still only mentions what it searched for.
 */
const PURE_CONSUMERS: ReadonlySet<string> = new Set([
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "less",
  "more",
  "cut",
  "tr",
  "nl",
  "column",
  "jq",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "cat",
  "tee",
  // A group such as `(echo a; echo b) | head` reaches the pipe through each of its members.
  "echo",
  "printf",
]);

/**
 * The program a segment starts: `{ name: "ls" }`, or for `git` its subcommand, the global
 * options before it, and the words after it.
 */
interface Command {
  readonly name: string;
  /** The `git` subcommand; empty for any other program. */
  readonly sub: string;
  /** `git`'s global options, before the subcommand, with their values. */
  readonly globals: readonly Word[];
  /** The words after the program, or after a `git` subcommand. */
  readonly args: readonly Word[];
}

/** The program a segment starts, with any `git` subcommand: `["git", "add"]`, `["ls"]`. */
function commandOf(segment: Segment): Command | undefined {
  const at = programIndex(segment.words);
  const program = segment.words[at];
  if (program === undefined) return undefined;
  const name = programName(program);
  const rest = segment.words.slice(at + 1);
  if (name !== "git") return { name, sub: "", globals: [], args: rest };
  let k = 0;
  while (k < rest.length && (rest[k] as Word).value.startsWith("-")) {
    k += GIT_GLOBAL_VALUE_OPTIONS.has((rest[k] as Word).value) ? 2 : 1;
  }
  return {
    name,
    sub: rest[k]?.value ?? "",
    globals: rest.slice(0, k),
    args: rest.slice(k + 1),
  };
}

/** `git` global options that make it run a program: a config value or an exec path. */
const GIT_CONFIG_OPTIONS = /^(?:-c|--config-env(?:=.*)?|--exec-path(?:=.*)?)$/;

/** Does this `git` command carry a global `-c`, `--config-env` or `--exec-path`? */
function setsGitConfig(command: Command): boolean {
  return command.globals.some((w) => GIT_CONFIG_OPTIONS.test(w.value));
}

/** Does this `git` command run a program it names: `rebase --exec`/`-x`, or `--ext-diff`? */
function runsGitProgram(command: Command): boolean {
  return command.args.some(
    (w) =>
      w.value === "--ext-diff" ||
      (command.sub === "rebase" && /^(?:--exec(?:=.*)?|-x.*)$/.test(w.value)),
  );
}

/**
 * A path whose content git runs or reads its configuration from: a hook (`.git/hooks/…`,
 * `.husky/…`, `.githooks/…`, any `hooks/…`), a repository's or the user's config, or the
 * attributes and modules files.
 */
const GIT_RUNNABLE_PATH =
  /(?:^|[\\/])(?:\.git[\\/]|\.husky[\\/]|\.githooks[\\/]|hooks[\\/])|(?:^|[\\/])(?:\.git(?:attributes|config|modules)|git[\\/]config)$/;

/** A path with any leading `./` and trailing separators removed, for comparing. */
function plainPath(path: string): string {
  return path.replace(/^(?:\.[\\/])+/, "").replace(/[\\/]+$/, "");
}

/**
 * The folders the call names as `core.hooksPath`: `git config core.hooksPath x`, or
 * `-c core.hooksPath=x`.
 */
function hooksPathsNamed(segments: readonly Segment[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    segment.words.forEach((word, k) => {
      const named = /^core\.hookspath(?:=(.*))?$/i.exec(word.value);
      if (named === null) return;
      const value = named[1] ?? segment.words[k + 1]?.value;
      if (value !== undefined && value !== "") out.push(plainPath(value));
    });
  }
  return out;
}

/** Would git run, or read its configuration from, this written file? */
function gitMayRun(path: string, hooksPaths: readonly string[]): boolean {
  if (GIT_RUNNABLE_PATH.test(path)) return true;
  const plain = plainPath(path);
  return hooksPaths.some(
    (dir) => plain === dir || plain.startsWith(`${dir}/`) || plain.startsWith(`${dir}\\`),
  );
}

/** Options of an otherwise inert program that make it run another program. */
function runsAProgramOption(command: Command): boolean {
  if (command.name === "rg") return command.args.some((w) => /^--pre(?:=|$)/.test(w.value));
  if (command.name === "sort") {
    return command.args.some((w) => /^--compress-program(?:=|$)/.test(w.value));
  }
  return false;
}

/**
 * Can this segment not run a file written before it? `gitRunnableWritten` says the call wrote,
 * before this command, a file git runs or reads its configuration from (`gitMayRun`). A
 * segment with no program can't.
 */
function isInert(segment: Segment, gitRunnableWritten: boolean): boolean {
  const command = commandOf(segment);
  if (command === undefined) return true;
  // A program named by a path (`./run.sh`, `bin/task`) may be a file just written.
  if (segment.words[programIndex(segment.words)]?.value.includes("/")) return false;
  if (command.name === "git") {
    // Git runs what a `-c`, an exec path or an external diff names, and a commit runs hooks:
    // with any of those, or after the call wrote a hook or git's own config, it is not inert.
    if (setsGitConfig(command) || runsGitProgram(command)) return false;
    if (gitRunnableWritten) return false;
    return INERT_GIT.has(command.sub);
  }
  if (runsAProgramOption(command)) return false;
  return INERT_PROGRAMS.has(command.name);
}

/** The files this segment writes: its output redirect targets and `tee`'s file operands. */
function writtenBy(segment: Segment): string[] {
  const paths = [...segment.written];
  const command = commandOf(segment);
  if (command?.name === "tee") {
    for (const w of command.args) if (!w.value.startsWith("-")) paths.push(w.value);
  }
  return paths;
}

/** Does this segment write a file: an output redirect, or `tee` with a file operand? */
function writesAFile(segment: Segment): boolean {
  return segment.writesFile || writtenBy(segment).length > 0;
}

/**
 * Is `raw` exactly one `$(cat <<DELIM … DELIM)`: a heredoc printed as a value, which is how
 * agents pass a multi-line commit message or PR body? Its text is data. Anything more inside
 * the substitution — a pipe, a second command, a different program, or an unquoted delimiter
 * whose body holds a substitution the shell would run — and part of it runs.
 */
function isHeredocValue(raw: string): boolean {
  if (!raw.startsWith("$(") || skipSubstitution(raw, 1) !== raw.length) return false;
  const inner = parseShell(raw.slice(2, -1));
  if (inner.segments.length !== 1 || inner.comments.length > 0) return false;
  const only = inner.segments[0] as Segment;
  return (
    only.words.length === 1 &&
    programName(only.words[0] as Word) === "cat" &&
    only.inputs.length === 1 &&
    only.inputs[0]?.expands === false &&
    !only.pipedOut &&
    !only.writesFile
  );
}

/** Is this option value data: no substitution, or only a printed heredoc? */
function isDataValue(word: Word, value: string = word.value): boolean {
  return !word.runs || isHeredocValue(value);
}

/** Test runners, and the words that start one through a package manager. */
const TEST_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest", "mocha", "pytest", "test"]);

/** Package managers and launchers a test runner is started through. */
const LAUNCHERS: ReadonlySet<string> = new Set(["npx", "pnpm", "npm", "yarn", "bun", "bunx"]);

/** A test runner's options whose value names tests to run. */
const TEST_FILTER_OPTIONS: ReadonlySet<string> = new Set([
  "-t",
  "--testNamePattern",
  "-k",
  "--grep",
  "-g",
]);

/** `git` options that come before the subcommand and take the next word. */
const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

/** `git` subcommands that search history for a string. */
const GIT_HISTORY: ReadonlySet<string> = new Set([
  "log",
  "show",
  "whatchanged",
  "shortlog",
  "rev-list",
]);

/** `git` subcommands that take a message. */
const GIT_MESSAGE: ReadonlySet<string> = new Set(["commit", "tag", "merge", "notes", "stash"]);

/** `gh` command groups whose text options are a title or a body. */
const GH_TEXT_GROUPS: ReadonlySet<string> = new Set([
  "pr",
  "issue",
  "release",
  "api",
  "gist",
  "repo",
]);

/** `gh` options whose value is text for a page, not something to run. */
const GH_TEXT_OPTIONS: ReadonlySet<string> = new Set([
  "-t",
  "--title",
  "-b",
  "--body",
  "-n",
  "--notes",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "-d",
  "--description",
]);

/**
 * The values of `options` among `words`, as `--opt value`, `--opt=value` or `-ovalue`.
 *
 * A value that holds a substitution is left out — part of it runs — unless the substitution
 * only prints a heredoc (`-m "$(cat <<'EOF' … EOF)"`).
 */
function optionValues(words: readonly Word[], options: ReadonlySet<string>): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < words.length; k++) {
    const word = words[k] as Word;
    if (options.has(word.value)) {
      const value = words[k + 1];
      if (value !== undefined && isDataValue(value)) out.push(value);
      k += 1;
      continue;
    }
    const eq = word.value.indexOf("=");
    if (word.value.startsWith("--") && eq > 0 && options.has(word.value.slice(0, eq))) {
      if (isDataValue(word, word.value.slice(eq + 1))) out.push(word);
      continue;
    }
    // `-mtext`, `-Stext`: a short option with its value attached.
    if (/^-[A-Za-z]./.test(word.value) && !word.value.startsWith("--")) {
      if (options.has(word.value.slice(0, 2)) && isDataValue(word, word.value.slice(2))) {
        out.push(word);
      }
    }
  }
  return out;
}

/** A searcher's pattern words: every `-e` value, or else the first operand. */
function searchPatterns(words: readonly Word[]): Word[] {
  const explicit = optionValues(words, new Set(["-e", "--regexp"]));
  if (explicit.length > 0) return explicit;
  for (let k = 0; k < words.length; k++) {
    const word = words[k] as Word;
    if (word.value === "--") {
      const operand = words[k + 1];
      return operand === undefined || operand.runs ? [] : [operand];
    }
    if (word.value.startsWith("-")) {
      if (SEARCH_VALUE_OPTIONS.has(word.value)) k += 1;
      continue;
    }
    return word.runs ? [] : [word];
  }
  return [];
}

/**
 * The regions of one simple command that are only data. `keep` is set when what the command
 * outputs may be run (see `executedView`), and then nothing in it is blanked.
 */
function segmentRegions(segment: Segment, keep: boolean): Region[] {
  if (keep) return [];
  const words = segment.words;
  const at = programIndex(words);
  const program = words[at];
  if (program === undefined) return [];
  const name = programName(program);
  const rest = words.slice(at + 1);
  const regions: Region[] = [];
  const blank = (list: readonly Word[], kind: MentionKind): void => {
    for (const word of list) regions.push({ start: word.start, end: word.end, kind });
  };

  if (PRINTERS.has(name))
    blank(
      rest.filter((w) => !w.runs),
      "doc",
    );
  else if (LOOKUPS.has(name))
    blank(
      rest.filter((w) => !w.runs),
      "search",
    );
  else if (SEARCHERS.has(name)) blank(searchPatterns(rest), "search");
  else if (name === "git") {
    let k = 0;
    while (k < rest.length && (rest[k] as Word).value.startsWith("-")) {
      k += GIT_GLOBAL_VALUE_OPTIONS.has((rest[k] as Word).value) ? 2 : 1;
    }
    const sub = rest[k]?.value ?? "";
    const args = rest.slice(k + 1);
    if (sub === "grep") blank(searchPatterns(args), "search");
    else if (GIT_HISTORY.has(sub)) {
      blank(optionValues(args, new Set(["-S", "-G", "--grep"])), "search");
    } else if (GIT_MESSAGE.has(sub)) {
      blank(optionValues(args, new Set(["-m", "--message"])), "doc");
    }
  } else if (name === "gh" && GH_TEXT_GROUPS.has(rest[0]?.value ?? "")) {
    blank(optionValues(rest, GH_TEXT_OPTIONS), "doc");
  }

  const startsTests =
    TEST_RUNNERS.has(name) || (LAUNCHERS.has(name) && rest.some((w) => TEST_RUNNERS.has(w.value)));
  if (startsTests && name !== "test") {
    blank(optionValues(rest, TEST_FILTER_OPTIONS), "test-string");
  }

  if (INPUT_SINKS.has(name)) {
    // A heredoc whose body the shell expands runs its substitutions before `cat` sees it.
    for (const input of segment.inputs) {
      if (!input.expands) regions.push({ start: input.start, end: input.end, kind: "heredoc" });
    }
  }
  return regions;
}

/** Shells that run a string given with `-c`. */
const SHELLS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "fish",
]);

/** Does this shell get a string to run: `-c`, a cluster holding `c` (`-lc`), `--command`? */
function runsAString(args: readonly Word[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const value = (args[k] as Word).value;
    if (value === "-o" || value === "+o") {
      k += 1;
      continue;
    }
    if (value === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(value)) return true;
    // The first operand is a script file; what follows is its arguments.
    if (!value.startsWith("-") && !value.startsWith("+")) return false;
  }
  return false;
}

/** Interpreters by name pattern, and the options that give them code on the command line. */
const INLINE_CODE: readonly (readonly [RegExp, RegExp])[] = [
  [/^python[0-9.]*$/, /^-[A-Za-z]*c$/],
  [/^(?:node|nodejs|bun)$/, /^(?:-e|-p|--eval|--print)(?:=.*)?$/],
  [/^perl$/, /^-[A-Za-z]*[eE]$/],
  [/^ruby$/, /^-[A-Za-z]*e$/],
  [/^php$/, /^-r$/],
  [/^osascript$/, /^-e$/],
  [/^(?:pwsh|powershell)$/, /^-(?:c|command|encodedcommand|ec|e)$/i],
];

/** Does this program get code to run as an argument: `python -c`, `node -e`, `deno eval`? */
function runsInlineCode(name: string, args: readonly Word[]): boolean {
  if (name === "deno") return args[0]?.value === "eval";
  const entry = INLINE_CODE.find(([program]) => program.test(name));
  if (entry === undefined) return false;
  for (const word of args) {
    if (entry[1].test(word.value)) return true;
    // The first operand is a script file (or `-m module`'s module); what follows is its own.
    if (!word.value.startsWith("-") || word.value === "-m") return false;
  }
  return false;
}

/** Interpreters that run a script read from standard input when given no script file. */
const STDIN_INTERPRETER = /^(?:python[0-9.]*|node|nodejs|perl|ruby|php|pwsh|powershell)$/;

/**
 * Does this program, fed by a pipe, run what the pipe carries: a shell or an interpreter with
 * no script file operand, a `-` operand, or a shell's `-s`?
 */
function runsPipedScript(name: string, args: readonly Word[]): boolean {
  const shell = SHELLS.has(name);
  if (!shell && !STDIN_INTERPRETER.test(name)) return false;
  for (const word of args) {
    if (word.value === "-" || (shell && /^-[A-Za-z]*s[A-Za-z]*$/.test(word.value))) return true;
    if (word.value === "--") continue;
    if (!word.value.startsWith("-")) return false;
  }
  return true;
}

/** Is this word a `$(…)` or backticks that runs, rather than a value that prints a heredoc? */
function runsASubstitution(word: Word): boolean {
  if (isDataValue(word)) return false;
  const eq = word.value.indexOf("=");
  return eq < 0 || !isDataValue(word, word.value.slice(eq + 1));
}

/**
 * The hiding forms one segment holds, given what the call did before it: whether it ran
 * `git config`, and whether it wrote a file git runs or reads its configuration from.
 */
function segmentHidingForms(
  segment: Segment,
  command: Command | undefined,
  gitConfigured: boolean,
  gitRunnableWritten: boolean,
  fedByPipe: boolean,
): HidingForm[] {
  const forms: HidingForm[] = [];
  if (segment.words.some(runsASubstitution) || segment.inputs.some((input) => input.expands)) {
    forms.push("command-substitution");
  }
  if (command === undefined) return forms;
  const { name, args } = command;
  if (SHELLS.has(name) && runsAString(args)) forms.push("shell-string");
  if (runsInlineCode(name, args)) forms.push("inline-code");
  // A pipe, a heredoc or a here-string fed to a shell or interpreter with no script file.
  const fed = fedByPipe || segment.inputs.length > 0;
  if (fed && !(SHELLS.has(name) && runsAString(args)) && runsPipedScript(name, args)) {
    forms.push("piped-script");
  }
  if (name === "eval") forms.push("eval");
  if (name === "xargs") forms.push("xargs");
  if (name === "find" && args.some((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w.value))) {
    forms.push("find-exec");
  }
  if (
    (name === "fd" || name === "fdfind") &&
    args.some((w) => /^(?:-x|-X|--exec|--exec-batch)(?:=.*)?$/.test(w.value))
  ) {
    forms.push("find-exec");
  }
  if (name === "git") {
    if (setsGitConfig(command) || gitConfigured) forms.push("git-config");
    if (runsGitProgram(command)) forms.push("git-exec");
    if (gitRunnableWritten) forms.push("git-hook");
  }
  return forms;
}

/** A command read once: its view with data blanked, and the hiding forms it holds. */
interface Reading {
  readonly view: ExecutedView;
  readonly hidingForms: readonly HidingForm[];
}

/**
 * Read a command. With `trustWrites`, a file the command writes is taken as never run by a
 * later command in it, so its printed text and heredocs are blanked whatever follows; that view
 * only tells a `may-run-written-file` call apart, and never decides `mentioned`.
 */
function readCommand(command: string, trustWrites: boolean): Reading {
  const parsed = parseShell(command);
  const regions: Region[] = parsed.comments.map((c) => ({ ...c, kind: "doc" as const }));
  const segments = parsed.segments;
  const count = segments.length;
  const hooksPaths = [...new Set(hooksPathsNamed(segments))];
  const commands = segments.map(commandOf);
  // Each table below is filled in one pass, so the whole reading stays linear in the length of
  // the command, however many simple commands it holds.
  //
  // `gitRunnableBefore[j]`: a command before `j` wrote a file git runs or reads its
  // configuration from. Once one has, every later command sees it, so no later path is tested.
  const gitRunnableBefore: boolean[] = new Array(count).fill(false);
  let gitRunnable = false;
  for (let j = 0; j < count; j++) {
    gitRunnableBefore[j] = gitRunnable;
    if (!gitRunnable) {
      gitRunnable = writtenBy(segments[j] as Segment).some((path) => gitMayRun(path, hooksPaths));
    }
  }
  // `mayRunAfter[j]`: a command after `j` could run a file written before it.
  const mayRunAfter: boolean[] = new Array(count).fill(false);
  if (!trustWrites) {
    for (let j = count - 2; j >= 0; j--) {
      mayRunAfter[j] =
        (mayRunAfter[j + 1] as boolean) ||
        !isInert(segments[j + 1] as Segment, gitRunnableBefore[j + 1] as boolean);
    }
  }
  /** Could a command after `index` run a file written before it? */
  const laterMayRun = (index: number): boolean => mayRunAfter[index] as boolean;
  // `consumersFrom[j]`: following the pipeline from `j` on, every program only prints a part of
  // what it is fed, up to the end of the pipeline. A consumer that writes a file a later
  // command may run is not one.
  const consumersFrom: boolean[] = new Array(count + 1).fill(true);
  for (let j = count - 1; j >= 0; j--) {
    const seg = segments[j] as Segment;
    const command = commands[j];
    const consumer =
      command === undefined ||
      (PURE_CONSUMERS.has(command.name) &&
        !runsAProgramOption(command) &&
        !(writesAFile(seg) && laterMayRun(j)));
    consumersFrom[j] = consumer && (!seg.pipedOut || (consumersFrom[j + 1] as boolean));
  }
  /** Does what `index` pipes go only to programs that print a part of it? */
  const pipesOnlyToConsumers = (index: number): boolean => consumersFrom[index + 1] as boolean;

  const forms = new Set<HidingForm>();
  if (parsed.processSubstitution) forms.add("process-substitution");
  if (parsed.targetRuns) forms.add("command-substitution");
  let gitConfigured = false;
  segments.forEach((segment, index) => {
    // What a command prints into a pipe may be run by the next program; what it writes to a
    // file may be run by a later command. Either way, nothing in it is blanked.
    const keep =
      (segment.pipedOut && !pipesOnlyToConsumers(index)) ||
      (writesAFile(segment) && laterMayRun(index));
    regions.push(...segmentRegions(segment, keep));
    const command = commands[index];
    for (const form of segmentHidingForms(
      segment,
      command,
      gitConfigured,
      gitRunnableBefore[index] as boolean,
      segments[index - 1]?.pipedOut === true,
    )) {
      forms.add(form);
    }
    if (command?.name === "git" && command.sub === "config") gitConfigured = true;
  });
  const hidingForms = HIDING_FORMS.filter((form) => forms.has(form));
  if (regions.length === 0) return { view: { text: command, kinds: [] }, hidingForms };

  regions.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const region of regions) {
    if (region.end <= cursor) continue;
    const start = Math.max(region.start, cursor);
    out += command.slice(cursor, start);
    out += command.slice(start, region.end).replace(/[^\n]/g, " ");
    cursor = region.end;
  }
  out += command.slice(cursor);
  const kinds: MentionKind[] = [];
  for (const region of regions) if (!kinds.includes(region.kind)) kinds.push(region.kind);
  return { view: { text: out, kinds }, hidingForms };
}

/**
 * The command with every region that is only data blanked out. See the module header.
 *
 * Pure and total: any text gives a view, and a text with nothing to blank comes back as it is.
 */
export function executedView(command: string): ExecutedView {
  return readCommand(command, false).view;
}

/**
 * The forms in a shell command that run something this reading does not take apart, in
 * `HIDING_FORMS` order. Empty when it holds none. See `HIDING_FORMS`.
 */
export function commandHidingForms(command: string): readonly HidingForm[] {
  return readCommand(command, false).hidingForms;
}

/** One simple command, as this module's shell reading splits it, for the checks that read it. */
export interface SimpleCommandView {
  /** Its words, with quotes and escapes removed. Redirection targets are not among them. */
  readonly words: readonly string[];
  /** The files its output redirects write, as written. */
  readonly writes: readonly string[];
  /** Its standard input is redirected from a file (`< file`). */
  readonly readsFile: boolean;
  /** Its standard input is the output of the command before it (`a | b`). */
  readonly pipedIn: boolean;
}

/**
 * The simple commands of a shell text, split by the same quote-aware reading that decides what
 * ran: a `;`, `&`, `|` or line break inside quotes, a substitution or a comment does not split.
 *
 * The commands in a heredoc's body follow the command it is fed to. A body is text a shell may
 * run (`bash <<EOF`, or a script written and run later), so a check must find its commands to
 * ask whether they ran; one that is only data is blanked in `executedView`, and `runVerdict`
 * says so. Bodies are read one level deep, so the reading stays linear in the length of the
 * text: a heredoc inside a heredoc's body is not read.
 *
 * Pure and total.
 */
export function simpleCommandsOf(command: string): SimpleCommandView[] {
  return simpleViews(command, true);
}

/** `simpleCommandsOf`, reading heredoc bodies only when `bodies` is set. */
function simpleViews(text: string, bodies: boolean): SimpleCommandView[] {
  const { segments } = parseShell(text);
  const out: SimpleCommandView[] = [];
  segments.forEach((segment, k) => {
    out.push({
      words: segment.words.map((word) => word.value),
      writes: segment.written,
      readsFile: segment.readsFile,
      pipedIn: segments[k - 1]?.pipedOut === true,
    });
    if (!bodies) return;
    for (const input of segment.inputs) {
      out.push(...simpleViews(text.slice(input.start, input.end), false));
    }
  });
  return out;
}

/**
 * The hiding forms one tool call holds: a shell call's, read from its command; every command
 * of a shell this reading does not parse (`unread-shell`); none for any other tool.
 *
 * A per-call signal for the checks: a category whose check finds nothing may be `clean` only
 * when no call that ran holds a form that could hide what it looks for.
 */
export function hidingFormsOf(mapped: MappedCall): readonly HidingForm[] {
  const command = mapped.args.full_command;
  if (command === undefined) return [];
  if (SHELL_TOOLS.has(mapped.tool)) return commandHidingForms(command);
  if (UNREAD_SHELL_TOOLS.has(mapped.tool)) return ["unread-shell"];
  return [];
}

/**
 * What a `ran` verdict rests on for this app. See `RAN_EVIDENCE`.
 *
 * A checked switch, so a new app does not inherit another app's answer.
 */
export function ranEvidenceOf(agent: AgentSource): RanEvidence {
  switch (agent) {
    case "claude":
      return "tool-result";
    case "codex":
      return "output-record";
    case "cursor":
      return "none";
    default:
      return unhandledAgent(agent);
  }
}

/** Does this app's transcript record a result for each tool call? */
export function recordsToolResults(agent: AgentSource): boolean {
  return ranEvidenceOf(agent) !== "none";
}

/** An error result that reports the command's exit code: the command ran and failed. */
const EXIT_CODE = /^\s*Exit code -?\d+/;

/**
 * The tools whose command is POSIX shell text. Every reader maps a shell call to `Bash`;
 * `PowerShell` has its own syntax, which `executedView` does not read, so its calls are judged
 * by their result alone.
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

/** Shell tools whose syntax this reading does not parse: their every command is unread. */
const UNREAD_SHELL_TOOLS: ReadonlySet<string> = new Set(["PowerShell"]);

/** A verdict. */
function verdict(state: RunVerdict["state"], why: RunWhy): RunVerdict {
  return { state, why };
}

/**
 * Did this call run? See the module header.
 *
 * `stillMatches` evaluates the whole catalog on a changed copy of the call, with its data-only
 * regions blanked. If any guardrail still matches, the call is treated as having run — which
 * errs towards `ran` when a different guardrail matches the blanked copy. A match that came
 * only from a mentioned region leaves nothing to match.
 *
 * A call that ran, and whose match would be gone if a file it wrote were never run, is `ran`
 * with `why: "may-run-written-file"`: it is kept only because a later command might run that
 * file, so `isResultBackedRun` is false for it and nothing counts it as `ran`.
 */
export function runVerdict(
  agent: AgentSource,
  mapped: MappedCall,
  result: ToolResult | undefined,
  stillMatches: (call: MappedCall) => boolean,
): RunVerdict {
  // A web search's whole input is a search phrase.
  if (mapped.tool === "WebSearch") return verdict("mentioned", "search");

  const command = mapped.args.full_command;
  const matchesIn = (text: string): boolean =>
    stillMatches({ ...mapped, args: { ...mapped.args, full_command: text } });
  // Set when the match is kept only because a later command may run a file this call wrote.
  let onlyWrittenFile = (): boolean => false;
  if (SHELL_TOOLS.has(mapped.tool) && command !== undefined) {
    const view = executedView(command);
    const first = view.kinds[0];
    if (first !== undefined && !matchesIn(view.text)) return verdict("mentioned", first);
    onlyWrittenFile = () => {
      const trusting = readCommand(command, true).view;
      return trusting.text !== view.text && !matchesIn(trusting.text);
    };
  }

  if (!recordsToolResults(agent)) return verdict("unknown", "not-recorded");
  if (result === undefined) return verdict("unknown", "no-result");
  if (result.isError && !EXIT_CODE.test(result.content)) return verdict("unknown", "error-result");
  if (onlyWrittenFile()) return verdict("ran", "may-run-written-file");
  return result.isError ? verdict("ran", "exit-code") : verdict("ran", "result");
}

/**
 * Is this a `ran` that a recorded result backs, with the matched text where the shell runs it:
 * `why` `result` or `exit-code`? Every count and every claim of what ran uses only these; a
 * `may-run-written-file` call ran, but its matched text is not confirmed to have.
 */
export function isResultBackedRun(run: RunVerdict): boolean {
  return run.state === "ran" && (run.why === "result" || run.why === "exit-code");
}

/** Text in the agent's own reply is never a command that ran. */
export const AGENT_REPLY: RunVerdict = verdict("mentioned", "agent-reply");

/** The matched calls of a corpus, by whether they ran, and what a `ran` rests on. */
export interface MatchedCallTally {
  readonly tally: RunTally;
  readonly resultsRecorded: boolean;
  readonly ranEvidence: RanEvidence;
}

/**
 * Classify every tool call that matched a guardrail.
 *
 * Calls are read and evaluated exactly as `aggregateScan` reads and evaluates them, through the
 * same per-app mapping, so the totals agree. A tool-use id seen twice in one session (a main
 * transcript and a sub-agent file that both carry the call) counts once, as it does there.
 */
export function tallyMatchedCalls(
  corpus: ScanCorpus,
  catalog: readonly CompiledRule[],
  allowlist: CompiledAllowlist,
): MatchedCallTally {
  const agent: AgentSource = corpus.agent ?? "claude";
  const tally = { ran: 0, mentioned: 0, unknown: 0 };
  const stillMatches = (call: MappedCall): boolean =>
    evaluateAction(catalog, allowlist, [call]).decision.matches.length > 0;

  for (const session of corpus.sessions) {
    const seen = new Set<string>();
    for (const turn of session.turns) {
      for (const use of turn.toolUses) {
        if (agent === "claude" && use.toolUseId !== "") {
          if (seen.has(use.toolUseId)) continue;
          seen.add(use.toolUseId);
        }
        const result = session.toolResults.get(use.toolUseId);
        for (const call of toolUseCalls(agent, use)) {
          if (call.kind !== "action") continue;
          const { mapped, decision } = evaluateAction(catalog, allowlist, call.candidates);
          if (decision.matches.length === 0) continue;
          const run = runVerdict(agent, mapped, result, stillMatches);
          // Only a result-backed run counts as ran; an unconfirmed one counts as unknown.
          tally[run.state === "ran" && !isResultBackedRun(run) ? "unknown" : run.state] += 1;
        }
      }
    }
  }
  return {
    tally,
    resultsRecorded: recordsToolResults(agent),
    ranEvidence: ranEvidenceOf(agent),
  };
}
