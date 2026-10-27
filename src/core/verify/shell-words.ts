// cspell:words herestring stdbuf nohup pushd popd heredocs redirections
/**
 * Shell words: a command's text split into simple commands and their words, for the checks
 * that read what a command did to this machine.
 *
 * The checks read the text `executedView` (`ran.ts`) returns, where every region that is only
 * data — a search pattern, printed text, a commit message, a heredoc fed to `cat` — is already
 * blanked. What is left is what the shell ran, and this module says which program each part
 * started and with which words.
 *
 * A best-effort reading of POSIX shell: quotes, ANSI-C `$'…'` strings, escapes, `$(…)` and
 * backticks, the control operators, subshell parentheses, redirections and heredocs. It never
 * fails; text it cannot place stays in a word. A word keeps its `$` expansions as written, so a
 * check can tell a literal path from one built from a variable.
 *
 * Pure. No I/O.
 */

import { GIT_GLOBAL_VALUE_OPTIONS, programNameOf, programStart } from "./prefix-words.js";

/** One word of a simple command. */
export interface ShellWord {
  /** The word as written, quotes and all. */
  readonly raw: string;
  /** The word with its quotes and escapes removed. `$` expansions are kept as written. */
  readonly value: string;
  /** It holds a `$` expansion, a `$(…)` or backticks outside single quotes. */
  readonly expands: boolean;
  /**
   * Where in `value` the first `*`, `?` or `[` the shell would expand is: one neither quoted
   * nor escaped. `-1` when there is none, so a quoted `"[ab]"` is a literal name.
   */
  readonly globAt: number;
}

/** One simple command. */
export interface ShellCommand {
  readonly kind: "command";
  /** Its words, redirection targets left out. */
  readonly words: readonly ShellWord[];
  /** The files its `>`, `>>`, `>|`, `&>` and `&>>` redirections write. */
  readonly writes: readonly ShellWord[];
}

/** A simple command, or the start or end of a subshell. */
export type ShellItem = ShellCommand | { readonly kind: "open" } | { readonly kind: "close" };

/** Programs that run the lines of a heredoc fed to them as commands. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * Where an ANSI-C quoted string `$'…'` ends, from its `$`, or `-1` when it is never closed.
 * Inside it a backslash escapes the next character, so `$'it\'s'` is one string, where a plain
 * `'…'` would end at the escaped quote.
 */
export function ansiQuoteEnd(text: string, at: number): number {
  let i = at + 2;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") return i + 1;
    i += 1;
  }
  return -1;
}

/** The one-letter escapes of an ANSI-C quoted string, and what each stands for. */
const ANSI_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/** An escape of an ANSI-C quoted string: hex, Unicode, octal, a control character, or one letter. */
const ANSI_ESCAPE =
  /\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|c([\s\S])|([\s\S]))/g;

/**
 * The text an ANSI-C quoted string stands for, from what is between `$'` and `'`: `\n`, `\t`,
 * `\\`, `\'`, `\xHH`, `\uHHHH`, `\nnn`, `\cX`, as the shell reads them, so `$'\x72m'` is the
 * word `rm`. A NUL ends the string, as it does in the shell. An escape the shell does not know
 * is kept as written.
 */
export function ansiQuoteValue(inner: string): string {
  const value = inner.replace(
    ANSI_ESCAPE,
    (
      whole,
      hex?: string,
      u4?: string,
      u8?: string,
      octal?: string,
      control?: string,
      one?: string,
    ) => {
      const code = hex ?? u4 ?? u8;
      if (code !== undefined) {
        const point = Number.parseInt(code, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
      }
      if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      if (control !== undefined) return String.fromCharCode(control.charCodeAt(0) & 0x1f);
      return ANSI_ESCAPES[one ?? ""] ?? whole;
    },
  );
  const nul = value.indexOf("\0");
  return nul < 0 ? value : value.slice(0, nul);
}

/**
 * Where a quoted string ends, from its opening quote, or `-1` when it is never closed. Inside
 * double quotes a `$(…)` is skipped whole, as `ran.ts` reads it, so a quote inside the
 * substitution does not end the string: `"$(printf '"')"; git stash drop` is two commands, not
 * one open string.
 */
function quoteEnd(text: string, at: number, quote: string): number {
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote !== "'" && ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === '"' && ch === "$" && text[i + 1] === "(") {
      i = substitutionEnd(text, i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return -1;
}

/** `quoteEnd`, with a string never closed running to the end of the text. */
function skipQuoted(text: string, at: number, quote: string): number {
  const end = quoteEnd(text, at, quote);
  return end < 0 ? text.length : end;
}

/** `substitutionEnd`, with a substitution never closed running to the end of the text. */
function skipSubstitution(text: string, at: number): number {
  const end = substitutionEnd(text, at);
  return end < 0 ? text.length : end;
}

/**
 * Where a `$(…)` or `$((…))` ends, from its `(`, counting nested parentheses, or `-1` when it is
 * never closed.
 */
function substitutionEnd(text: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "$" && text[i + 1] === "'") {
      i = ansiQuoteEnd(text, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i = quoteEnd(text, i, ch);
      if (i < 0) return -1;
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
  return -1;
}

/** What the next completed word is. */
type Next = "word" | "write" | "read" | "heredoc" | "heredoc-tabs" | "herestring";

/** A heredoc whose body starts on the next line. */
interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  /** The words of the command it is fed to, filled in as that command is read. */
  readonly words: readonly ShellWord[];
}

/**
 * Split shell text into simple commands, in order, with `open` and `close` around each
 * subshell. See the module header.
 */
export function shellItems(text: string): ShellItem[] {
  const items: ShellItem[] = [];
  const pending: PendingHeredoc[] = [];
  let words: ShellWord[] = [];
  let writes: ShellWord[] = [];
  let next: Next = "word";
  let start = -1;
  let value = "";
  let expands = false;
  let globAt = -1;

  const endWord = (end: number): void => {
    if (start < 0) return;
    const word: ShellWord = { raw: text.slice(start, end), value, expands, globAt };
    if (next === "word") words.push(word);
    else if (next === "write") writes.push(word);
    else if (next === "heredoc" || next === "heredoc-tabs") {
      pending.push({ delimiter: value, stripTabs: next === "heredoc-tabs", words });
    }
    next = "word";
    start = -1;
    value = "";
    expands = false;
    globAt = -1;
  };
  const endCommand = (end: number): void => {
    endWord(end);
    if (words.length > 0 || writes.length > 0) items.push({ kind: "command", words, writes });
    words = [];
    writes = [];
  };
  const begin = (at: number): void => {
    if (start < 0) start = at;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;

    if (ch === "\n") {
      endCommand(i);
      i += 1;
      // A heredoc's body starts on the next line. Fed to a shell, its lines are commands and
      // are read as such; fed to anything else, they are that program's input, and skipped.
      while (pending.length > 0) {
        const doc = pending.shift() as PendingHeredoc;
        const program = doc.words[commandStart(doc.words).index];
        if (program !== undefined && SHELLS.has(programName(program))) {
          pending.length = 0;
          break;
        }
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

    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord(i);
      i += 1;
      continue;
    }

    if (ch === "#" && start < 0) {
      const lineEnd = text.indexOf("\n", i);
      i = lineEnd < 0 ? text.length : lineEnd;
      continue;
    }

    if (ch === "'" || ch === '"') {
      begin(i);
      const end = skipQuoted(text, i, ch);
      const inner = text.slice(i + 1, Math.max(i + 1, end - 1));
      if (ch === '"') {
        if (inner.includes("$") || inner.includes("`")) expands = true;
        value += inner.replace(/\\(["\\$`])/g, "$1");
      } else value += inner;
      i = end;
      continue;
    }

    if (ch === "\\") {
      begin(i);
      if (text[i + 1] !== "\n") value += text[i + 1] ?? "";
      i += 2;
      continue;
    }

    if (ch === "$") {
      begin(i);
      if (text[i + 1] === "'") {
        // An ANSI-C quoted string: escapes are read, and nothing in it expands.
        const end = ansiQuoteEnd(text, i);
        const stop = end < 0 ? text.length : end - 1;
        value += ansiQuoteValue(text.slice(i + 2, Math.max(i + 2, stop)));
        i = end < 0 ? text.length : end;
        continue;
      }
      if (text[i + 1] === '"') {
        // `$"…"` is read as `"…"`.
        i += 1;
        continue;
      }
      if (text[i + 1] === "(") {
        const end = skipSubstitution(text, i + 1);
        value += text.slice(i, end);
        expands = true;
        i = end;
        continue;
      }
      if (/[A-Za-z_{0-9@*#?$!-]/.test(text[i + 1] ?? "")) expands = true;
      value += ch;
      i += 1;
      continue;
    }

    if (ch === "`") {
      begin(i);
      const end = skipQuoted(text, i, "`");
      value += text.slice(i, end);
      expands = true;
      i = end;
      continue;
    }

    if (ch === "<" || ch === ">") {
      // A word of digits right before is the file descriptor, not an argument.
      if (start >= 0 && /^\d+$/.test(value)) {
        start = -1;
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
        const writing = ch === ">" || text[i + 1] === ">";
        i += 1;
        // `>>`, `>|`, `<>`, and `>&` / `<&` with a descriptor.
        const duplicating = text[i] === "&";
        while (i < text.length && /[>|&<]/.test(text[i] as string)) i += 1;
        next = duplicating ? "read" : writing ? "write" : "read";
      }
      continue;
    }

    if (ch === "&" && text[i + 1] === ">") {
      endWord(i);
      i += 2;
      if (text[i] === ">") i += 1;
      next = "write";
      continue;
    }

    if (ch === "(" || ch === ")") {
      endCommand(i);
      items.push({ kind: ch === "(" ? "open" : "close" });
      i += 1;
      continue;
    }

    if (ch === ";" || ch === "&" || ch === "|") {
      endCommand(i);
      i += 1;
      // `&&`, `||`, `|&` and `;;` are one operator.
      if (/[&|;]/.test(text[i] ?? "")) i += 1;
      continue;
    }

    begin(i);
    if (globAt < 0 && (ch === "*" || ch === "?" || ch === "[")) globAt = value.length;
    value += ch;
    i += 1;
  }
  endCommand(text.length);
  return items;
}

/** The simple commands of shell text, subshell markers left out. */
export function shellCommands(text: string): ShellCommand[] {
  return shellItems(text).filter((item): item is ShellCommand => item.kind === "command");
}

/** The program's name: its file name, lower-cased, without `.exe`. */
export function programName(word: ShellWord): string {
  return programNameOf(word.value);
}

/** Where the program is in a command, and the assignments made for it. */
export interface CommandStart {
  /** The index of the program word; `words.length` when there is none. */
  readonly index: number;
  /** `NAME=value` words before the program, including those given to `env`. */
  readonly assignments: readonly ShellWord[];
}

/**
 * The program word, past assignments and prefix words such as `sudo` and `env`, by the shared
 * table (`prefix-words.ts`).
 */
export function commandStart(words: readonly ShellWord[]): CommandStart {
  const { index, assignments } = programStart(words.map((word) => word.value));
  return { index, assignments: assignments.map((i) => words[i] as ShellWord) };
}

/** A `git` command: its subcommand, the words after it, and the folders `-C` moves to. */
export interface GitCommand {
  /** The subcommand, such as `commit`. Empty when there is none. */
  readonly sub: string;
  /** The words after the subcommand. */
  readonly args: readonly ShellWord[];
  /** Each `-C` folder, in order. */
  readonly folders: readonly ShellWord[];
  /** `--git-dir` or `--work-tree` was given, so the folder it ran on cannot be told. */
  readonly elsewhere: boolean;
}

/** `words` as a `git` command, or `undefined` when the program is not `git`. */
export function gitCommand(words: readonly ShellWord[]): GitCommand | undefined {
  const at = commandStart(words).index;
  const program = words[at];
  if (program === undefined || programName(program) !== "git") return undefined;
  const folders: ShellWord[] = [];
  let elsewhere = false;
  let k = at + 1;
  while (k < words.length && (words[k] as ShellWord).value.startsWith("-")) {
    const option = (words[k] as ShellWord).value;
    if (option.startsWith("--git-dir") || option.startsWith("--work-tree")) elsewhere = true;
    if (option === "-C" && words[k + 1] !== undefined) folders.push(words[k + 1] as ShellWord);
    k += GIT_GLOBAL_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  const sub = words[k]?.value ?? "";
  return { sub, args: words.slice(k + 1), folders, elsewhere };
}

/** The words of `args` that are not options, with everything after `--` taken as is. */
export function operands(
  args: readonly ShellWord[],
  valueOptions: ReadonlySet<string> = new Set(),
): ShellWord[] {
  const out: ShellWord[] = [];
  let k = 0;
  while (k < args.length) {
    const word = args[k] as ShellWord;
    if (word.value === "--") {
      out.push(...args.slice(k + 1));
      break;
    }
    if (word.value.startsWith("-") && word.value !== "-") {
      k += valueOptions.has(word.value) ? 2 : 1;
      continue;
    }
    out.push(word);
    k += 1;
  }
  return out;
}

/** Is the folder a `cd`, `pushd` or `popd` moves to known, and what is it, as written? */
export type DirectoryChange =
  | { readonly kind: "none" }
  | { readonly kind: "to"; readonly path: string }
  | { readonly kind: "home" }
  | { readonly kind: "unknown" };

/** What a simple command does to the shell's folder. */
export function directoryChange(words: readonly ShellWord[]): DirectoryChange {
  const at = commandStart(words).index;
  const program = words[at];
  if (program === undefined) return { kind: "none" };
  const name = programName(program);
  if (name === "popd") return { kind: "unknown" };
  if (name !== "cd" && name !== "pushd") return { kind: "none" };
  const targets = operands(words.slice(at + 1));
  if (targets.length === 0) return name === "cd" ? { kind: "home" } : { kind: "unknown" };
  const target = targets[0] as ShellWord;
  if (targets.length > 1 || target.expands || target.value === "-") return { kind: "unknown" };
  return { kind: "to", path: target.value };
}
