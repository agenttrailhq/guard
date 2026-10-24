// cspell:words nerdctl ionice stdbuf doas mysqld kubeconfig classdata cret mysqldump nohup procs rescanned userspec gosu getopt uroot
/**
 * Is a `-p` in a text the password flag of a mysql or mariadb program?
 *
 * The `mysql-password-flag` pattern's regex only finds a candidate: a ` -p<value>` with a
 * `mysql` / `mariadb` word at most 200 characters before it. This check then decides, in code,
 * whether that program is the statement's PROGRAM, the way a shell would read it, rather than an
 * argument (`docker run --name mysql -p3306:3306`, `find /var/lib/mysql -print`).
 *
 * When the shell reading is unsure, it masks: a quote that does not close before the candidate
 * on its own line (`echo it's && mysql -p…`, `ssh host 'mysql -p…'`) accepts the candidate when a
 * mysql word follows the quote, and a value an earlier pattern already redacted
 * (`DB_PASSWORD=[REDACTED] mysql -p…`) is skipped like an assignment.
 *
 * Linear and bounded: it reads at most `WINDOW` characters before the candidate, every loop
 * advances, and the scan state is carried over to the next candidate in the same text, so a text
 * dense with candidates and quotes is read about once. A regex that found the program itself
 * backtracked: each `;` `&` `|` `(` began a new attempt that rescanned the run, and 100 KB of
 * them took seconds.
 */

/** How far back the statement start is looked for. A statement that starts earlier is skipped. */
const WINDOW = 512;

/** The programs that take the password glued to `-p`: `mysql`, `mysqldump`, `mariadb-dump`, … */
const PROGRAM = /^(?:mysql\w*|mariadb[\w-]*)$/i;

/** A program word anywhere in a text, by itself or at the end of a path (`/usr/bin/mysql`). */
const PROGRAM_WORD = /(?:^|[\s'"`(;|&/])(?:mysql\w*|mariadb[\w-]*)(?=$|[\s'"`);|&\\])/i;

/** `NAME=value` before a program. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The character that marks a value an earlier pattern redacted. */
const SLOT = String.fromCharCode(0xe000);

/** Shell words that may stand before a program without being it. */
const KEYWORDS = new Set(["then", "do", "else", "elif", "!", "{"]);

/** Wrappers that run another program, each with its options that take a value as the next token. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "sudo",
    new Set([
      "-u",
      "-g",
      "-p",
      "-C",
      "-D",
      "-r",
      "-t",
      "-U",
      "--user",
      "--group",
      "--prompt",
      "--chdir",
      "--role",
      "--type",
    ]),
  ],
  ["doas", new Set(["-u", "-C"])],
  ["env", new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "-n", "-p", "--class", "--classdata"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  [
    "xargs",
    new Set([
      "-n",
      "-I",
      "-L",
      "-P",
      "-d",
      "-s",
      "-E",
      "-a",
      "--max-args",
      "--replace",
      "--max-procs",
      "--delimiter",
      "--arg-file",
    ]),
  ],
  ["nohup", new Set<string>()],
  ["time", new Set(["-f", "-o", "--format", "--output"])],
  ["exec", new Set(["-a"])],
  ["command", new Set<string>()],
  ["watch", new Set(["-n", "-d", "--interval"])],
  ["strace", new Set(["-o", "-e", "-p", "-s"])],
  ["chroot", new Set(["--userspec", "--groups"])],
  ["gosu", new Set<string>()],
  ["su-exec", new Set<string>()],
]);

/** Wrappers with one positional operand before the program: `timeout <duration>`, `gosu <user>`. */
const OPERAND = new Set(["timeout", "chroot", "gosu", "su-exec"]);

/** `docker exec` / `podman exec` options that take a value. */
const EXEC_OPTIONS = new Set([
  "-u",
  "-w",
  "-e",
  "--user",
  "--workdir",
  "--env",
  "--env-file",
  "--detach-keys",
]);

/** `docker compose` options before its command that take a value. */
const COMPOSE_OPTIONS = new Set([
  "-f",
  "-p",
  "--file",
  "--project-name",
  "--project-directory",
  "--env-file",
  "--profile",
  "--ansi",
  "--progress",
  "--parallel",
]);

/** `docker compose exec` / `run` options that take a value. */
const COMPOSE_EXEC_OPTIONS = new Set([
  "-u",
  "-w",
  "-e",
  "-l",
  "-v",
  "-p",
  "--user",
  "--workdir",
  "--env",
  "--index",
  "--label",
  "--volume",
  "--publish",
  "--name",
  "--entrypoint",
]);

/** `ssh` options that take a value. */
const SSH_OPTIONS = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
  "-B",
]);

/** Characters that end a statement outside quotes. */
const SEPARATORS = new Set([";", "|", "&", "(", ")", "`", "\n", "\r", "{", "}"]);

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return (slash === -1 ? token : token.slice(slash + 1)).toLowerCase();
}

/**
 * Does `token` take the next token as its value? `-u`, or a cluster of short flags that ends in
 * one (`-iu`), as getopt reads it; `-uroot` holds its value and `--user=root` too.
 */
function takesValue(token: string, withValue: ReadonlySet<string>): boolean {
  if (withValue.has(token)) return true;
  if (token.startsWith("--")) return false;
  for (let k = 1; k < token.length; k++) {
    if (withValue.has(`-${token[k]}`)) return k === token.length - 1;
  }
  return false;
}

/** Past `-x` options from `i`, consuming a value for those that take one; `--` ends them. */
function skipOptions(tokens: readonly string[], i: number, withValue: ReadonlySet<string>): number {
  let j = i;
  while (j < tokens.length) {
    const token = tokens[j] as string;
    if (token === "--") return j + 1;
    if (!token.startsWith("-") || token === "-") return j;
    j += takesValue(token, withValue) ? 2 : 1;
  }
  return j;
}

/**
 * The index of a statement's PROGRAM token, past assignments, keywords and wrappers, or -1. A
 * token holding an earlier pattern's redaction (`DB_PASSWORD=<redacted>`) is an assignment.
 */
function programIndex(tokens: readonly string[]): number {
  let i = 0;
  // Every pass consumes at least one token, so this ends; 32 passes is far past any real chain.
  for (let pass = 0; pass < 32 && i < tokens.length; pass++) {
    const token = tokens[i] as string;
    if (ASSIGNMENT.test(token) || KEYWORDS.has(token) || token.includes(SLOT)) {
      i++;
      continue;
    }
    const word = basename(token);
    const withValue = WRAPPERS.get(word);
    if (withValue) {
      i = skipOptions(tokens, i + 1, withValue);
      if (OPERAND.has(word)) i++;
      continue;
    }
    const container = word === "docker" || word === "podman" || word === "nerdctl";
    if (word === "docker-compose" || (container && tokens[i + 1] === "compose")) {
      const command = skipOptions(tokens, i + (word === "docker-compose" ? 1 : 2), COMPOSE_OPTIONS);
      if (tokens[command] !== "exec" && tokens[command] !== "run") return i;
      i = skipOptions(tokens, command + 1, COMPOSE_EXEC_OPTIONS) + 1; // the service
      continue;
    }
    if (container && tokens[i + 1] === "exec") {
      i = skipOptions(tokens, i + 2, EXEC_OPTIONS) + 1; // the container
      continue;
    }
    if (word === "kubectl" || word === "oc") {
      const dashes = tokens.indexOf("--", i);
      if (dashes === -1 || !tokens.slice(i, dashes).includes("exec")) return -1;
      i = dashes + 1;
      continue;
    }
    if (word === "ssh") {
      i = skipOptions(tokens, i + 1, SSH_OPTIONS) + 1; // the host
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Where the next unescaped `quote` after `from` is, before `end`. A newline before it, raw or
 * escaped (`\\n`), ends the search: its index is returned instead. -1 when neither comes before
 * `end`.
 */
function closingQuote(text: string, quote: string, from: number, end: number): number {
  for (let j = from; j + quote.length <= end; j++) {
    if (isNewline(text, j)) return j;
    if (text.startsWith(quote, j) && (quote === '\\"' || text[j - 1] !== "\\")) return j;
  }
  return -1;
}

/** A newline at `j`: raw, or escaped (`\\n`, `\\r`). */
function isNewline(text: string, j: number): boolean {
  const c = text[j];
  if (c === "\n" || c === "\r") return true;
  return c === "\\" && (text[j + 1] === "n" || text[j + 1] === "r");
}

function isNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 46 || // .
    code === 45 // -
  );
}

/** A JSON key at `i` (`"command":`, or `\"command\":` escaped) that ends by `end`: its length, or 0. */
function jsonKeyLength(text: string, i: number, end: number): number {
  const escaped = text[i] === "\\";
  const nameStart = i + (escaped ? 2 : 1);
  let j = nameStart;
  while (j < nameStart + 65 && j < end && isNameChar(text.charCodeAt(j))) j++;
  if (j === nameStart || j - nameStart > 64) return 0;
  if (escaped) {
    if (text[j] !== "\\" || text[j + 1] !== '"') return 0;
    j += 2;
  } else {
    if (text[j] !== '"') return 0;
    j++;
  }
  while (j < end && (text[j] === " " || text[j] === "\t")) j++;
  return j < end && text[j] === ":" ? j + 1 - i : 0;
}

/**
 * Does the quote at `i` hold a command? It does after a JSON `:` `,` `[` `{`, or after a shell's
 * `-c` (`bash -c '…'`, also in a cluster: `-lc`, `-xc`). Reads at most 8 characters back.
 */
function holdsCommand(text: string, at: number, i: number): boolean {
  const from = Math.max(at, i - 8);
  let p = i - 1;
  while (p >= from && (text[p] === " " || text[p] === "\t")) p--;
  if (p < from) return false;
  const c = text[p];
  if (c === ":" || c === "," || c === "[" || c === "{") return true;
  if (c !== "c") return false;
  let q = p - 1;
  while (q >= from && /[A-Za-z]/.test(text[q] as string)) q--;
  return (
    q >= from && text[q] === "-" && (q === from || text[q - 1] === " " || text[q - 1] === "\t")
  );
}

/** A statement's reading: where it starts, and whether a quote left it unsure. */
interface Reading {
  start: number;
  /** A quote that does not close before the candidate on its own line starts at `start`. */
  unsure: boolean;
}

/** The scan state reached at a candidate, carried to the next candidate in the same text. */
interface ScanState {
  text: string;
  i: number;
  at: number;
  found: boolean;
  blank: boolean;
}

let carried: ScanState | null = null;

/**
 * Where the statement holding `end` starts: after a separator or an escaped newline, or inside a
 * quote that holds a command (`bash -c '…'`, a JSON string value `"command": "…"`). A quoted
 * argument is skipped whole; the closing quote of a JSON string (`"bash",`) ends a statement; a
 * line continuation (`\` and a newline, raw or JSON-escaped) does not. Null when the statement
 * starts before the window. It scans from the previous candidate's state when that is in the
 * window, else from `end - WINDOW`.
 */
function statementStart(text: string, end: number): Reading | null {
  const windowStart = Math.max(0, end - WINDOW);
  let i: number;
  let at: number;
  let found: boolean;
  let blank: boolean; // nothing but whitespace since `at`
  if (carried && carried.text === text && carried.i <= end && carried.i >= windowStart) {
    ({ i, at, found, blank } = carried);
  } else {
    i = windowStart;
    at = windowStart;
    found = windowStart === 0;
    blank = true;
  }
  carried = null;
  while (i < end) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "\\") {
      if (next === "n" || next === "r") {
        at = i + 2;
        found = true;
        blank = true;
        i += 2;
        continue;
      }
      if (next === "\\") {
        // `\\\n`, a JSON-escaped line continuation, goes on; any other `\\` is one character.
        i += text[i + 2] === "\\" && text[i + 3] === "n" ? 4 : 2;
        blank = false;
        continue;
      }
      if (next === "\n" || next === "\r") {
        i += 2; // a raw line continuation
        continue;
      }
    }
    const quote = c === "\\" && next === '"' ? '\\"' : c === '"' || c === "'" ? c : null;
    if (quote) {
      // A JSON key (`"command":`): the statement starts after it.
      const key = jsonKeyLength(text, i, end);
      if (key > 0) {
        i += key;
        at = i;
        found = true;
        blank = true;
        continue;
      }
      const after = text[i + quote.length];
      if (!blank && (after === "," || after === "]" || after === "}")) {
        // The closing quote of a JSON string (`"bash",`): the statement ends here.
        i += quote.length;
        at = i;
        found = true;
        blank = true;
        continue;
      }
      if (blank || holdsCommand(text, at, i)) {
        // A quote that holds a command: the statement starts inside it.
        i += quote.length;
        at = i;
        found = true;
        blank = true;
        continue;
      }
      // A quoted argument is skipped whole.
      const close = closingQuote(text, quote, i + quote.length, end);
      if (close === -1) {
        // `end` is inside the quote, or the quote is an apostrophe (`don't`): unsure. The next
        // candidate reads this quote again, with a later end.
        carried = { text, i, at, found, blank };
        return { start: i + quote.length, unsure: true };
      }
      if (isNewline(text, close)) {
        // Unclosed on its line: an apostrophe, read as a character.
        i += quote.length;
        blank = false;
        continue;
      }
      i = close + quote.length;
      blank = false;
      continue;
    }
    if (SEPARATORS.has(c)) {
      at = i + 1;
      found = true;
      blank = true;
    } else if (c !== " " && c !== "\t") {
      blank = false;
    }
    i++;
  }
  carried = { text, i, at, found, blank };
  return found && at >= windowStart ? { start: at, unsure: false } : null;
}

/**
 * `offset` is where the candidate ` -p<value>` starts in `text`. True when its statement's
 * program is mysql or mariadb, or when the reading is unsure and a mysql word follows the quote.
 */
export function isMysqlPasswordFlag(_match: string, offset: number, text: string): boolean {
  const reading = statementStart(text, offset);
  if (!reading) return false;
  const statement = text.slice(reading.start, offset);
  if (reading.unsure) return PROGRAM_WORD.test(statement);
  const tokens = statement.trim().split(/\s+/);
  const at = programIndex(tokens);
  return at !== -1 && at < tokens.length && PROGRAM.test(basename(tokens[at] as string));
}
