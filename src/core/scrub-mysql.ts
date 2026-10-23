// cspell:words nerdctl ionice stdbuf doas mysqld kubeconfig classdata cret mysqldump nohup procs rescanned userspec
/**
 * Is a `-p` in a text the password flag of a mysql or mariadb program?
 *
 * The `mysql-password-flag` pattern's regex only finds a candidate: a ` -p<value>` with a
 * `mysql` / `mariadb` word at most 200 characters before it. This check then decides, in code,
 * whether that program is the statement's PROGRAM, the way a shell would read it, rather than an
 * argument (`docker run --name mysql -p3306:3306`, `find /var/lib/mysql -print`).
 *
 * Linear and bounded: it reads at most `WINDOW` characters before the candidate, once, and every
 * loop advances. A regex that found the program itself backtracked: each `;` `&` `|` `(` began a
 * new attempt that rescanned the run, and 100 KB of them took seconds.
 */

/** How far back the statement start is looked for. A statement that starts earlier is skipped. */
const WINDOW = 512;

/** The programs that take the password glued to `-p`: `mysql`, `mysqldump`, `mariadb-dump`, … */
const PROGRAM = /^(?:mysql\w*|mariadb[\w-]*)$/i;

/** `NAME=value` before a program. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

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
]);

/** Wrappers with one positional operand before the program: `timeout <duration>`, `chroot <root>`. */
const OPERAND = new Set(["timeout", "chroot"]);

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

/** Past `-x` options from `i`, consuming a value for those in `withValue`; `--` ends them. */
function skipOptions(tokens: readonly string[], i: number, withValue: ReadonlySet<string>): number {
  let j = i;
  while (j < tokens.length) {
    const token = tokens[j] as string;
    if (token === "--") return j + 1;
    if (!token.startsWith("-") || token === "-") return j;
    j += withValue.has(token) ? 2 : 1;
  }
  return j;
}

/** The index of a statement's PROGRAM token, past assignments, keywords and wrappers, or -1. */
function programIndex(tokens: readonly string[]): number {
  let i = 0;
  // Every pass consumes at least one token, so this ends; 32 passes is far past any real chain.
  for (let pass = 0; pass < 32 && i < tokens.length; pass++) {
    const token = tokens[i] as string;
    if (ASSIGNMENT.test(token) || KEYWORDS.has(token)) {
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
    if (
      (word === "docker" || word === "podman" || word === "nerdctl") &&
      tokens[i + 1] === "exec"
    ) {
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

/** Where the next unescaped `quote` after `from` is, before `end`, or -1. Reads only up to `end`. */
function closingQuote(text: string, quote: string, from: number, end: number): number {
  for (let j = from; j + quote.length <= end; j++) {
    if (text.startsWith(quote, j) && (quote === '\\"' || text[j - 1] !== "\\")) return j;
  }
  return -1;
}

/** A JSON key at `i` (`"command":`, or `\"command\":` escaped): its length, or 0. */
function jsonKeyLength(text: string, i: number): number {
  const key = /^(?:"[\w.-]{1,64}"|\\"[\w.-]{1,64}\\")\s*:/.exec(text.slice(i, i + 80));
  return key ? key[0].length : 0;
}

/**
 * Where the statement holding `end` starts, scanning `text` from `start` once: after a separator
 * or an escaped newline, or inside a quote that holds a command (`bash -c '…'`, a JSON string
 * value `"command": "…"`). A quoted argument is skipped whole. -1 when `end` is inside a quoted
 * argument, or the statement starts before `start`.
 */
function statementStart(text: string, start: number, end: number): number {
  let at = start;
  let found = start === 0;
  let blank = true; // nothing but whitespace since `at`
  let i = start;
  while (i < end) {
    const c = text[i] as string;
    if (c === "\\" && (text[i + 1] === "n" || text[i + 1] === "r")) {
      at = i + 2;
      found = true;
      blank = true;
      i += 2;
      continue;
    }
    const quote = c === "\\" && text[i + 1] === '"' ? '\\"' : c === '"' || c === "'" ? c : null;
    if (quote) {
      // A JSON key (`"command":`): the statement starts after it.
      const key = jsonKeyLength(text, i);
      if (key > 0 && i + key <= end) {
        i += key;
        at = i;
        blank = true;
        continue;
      }
      const before = text.slice(Math.max(at, i - 8), i).trim();
      if (blank || /(?:^|\s)-c$/.test(before) || /[:,[{]$/.test(before)) {
        // A quote that holds a command: the statement starts inside it.
        at = i + quote.length;
        found = true;
        blank = true;
        i += quote.length;
        continue;
      }
      // A quoted argument is skipped whole.
      const close = closingQuote(text, quote, i + quote.length, end);
      if (close === -1) return -1; // `end` is inside a quoted argument.
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
  return found ? at : -1;
}

/**
 * `offset` is where the candidate ` -p<value>` starts in `text`. True when its statement's
 * program is mysql or mariadb.
 */
export function isMysqlPasswordFlag(_match: string, offset: number, text: string): boolean {
  const from = statementStart(text, Math.max(0, offset - WINDOW), offset);
  if (from === -1) return false;
  const tokens = text.slice(from, offset).trim().split(/\s+/);
  const at = programIndex(tokens);
  return at !== -1 && at < tokens.length && PROGRAM.test(basename(tokens[at] as string));
}
