// cspell:words nerdctl ionice stdbuf doas mysqld kubeconfig classdata cret mysqldump nohup procs rescanned userspec gosu getopt uroot cidfile cgroupns sysctl userns tmpfs ulimit dotenv blkio cpuset gidmap pids uidmap tlscacert tlscert tlskey runroot
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
 * (`DB_PASSWORD=[REDACTED] mysql -p…`) is skipped like an assignment. A statement that starts
 * more than `WINDOW` characters back is unsure too.
 *
 * An exec-form argv (`["mysql", "-uroot", "-p…"]`, a Dockerfile `CMD [...]`) is read as one
 * statement whose tokens are the array's elements.
 *
 * Linear and bounded: it reads at most `WINDOW` characters before the candidate, every loop
 * advances, and the scan state is carried over to the next candidate in the same text, so a text
 * dense with candidates and quotes is read about once. A regex that found the program itself
 * backtracked: each `;` `&` `|` `(` began a new attempt that rescanned the run, and 100 KB of
 * them took seconds.
 */

/**
 * How far back the statement start is looked for. A statement that starts earlier is unsure: the
 * candidate is accepted when a mysql word stands in the last `UNSURE_TAIL` characters before it.
 */
const WINDOW = 512;

/** The candidate regex puts a mysql word at most 200 characters before the `-p`. */
const UNSURE_TAIL = 210;

/** The programs that take the password glued to `-p`: `mysql`, `mysqldump`, `mariadb-dump`, … */
const PROGRAM = /^(?:mysql\w*|mariadb[\w-]*)$/i;

/** A program word anywhere in a text, by itself or at the end of a path (`/usr/bin/mysql`). */
const PROGRAM_WORD = /(?:^|[\s'"`(;|&/])(?:mysql\w*|mariadb[\w-]*)(?=$|[\s'"`);|&\\])/i;

/** The characters after a quote that close an outer string rather than open a password. */
const CLOSES = /[\s,:}\]]/;

/** Does the candidate's value (after ` -p`) open with a quote followed by a `CLOSES` character? */
function quoteThenClose(match: string): boolean {
  const c = match[3];
  const after =
    c === "\\" && match[4] === '"' ? match[5] : c === '"' || c === "'" ? match[4] : undefined;
  return after !== undefined && CLOSES.test(after);
}

/** Is the candidate's value (after ` -p`) an empty quoted pair: `''`, `""` or `\"\"`? */
function isEmptyQuoted(match: string): boolean {
  if (match.length === 5) return match.endsWith("''") || match.endsWith('""');
  return match.length === 7 && match.endsWith('\\"\\"');
}

/** `PROGRAM_WORD`, to find each one in a range. */
const PROGRAM_WORDS = new RegExp(PROGRAM_WORD.source, "gi");

/** `NAME=value` before a program. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The character that marks a value an earlier pattern redacted. */
const SLOT = String.fromCharCode(0xe000);

/** Shell words that may stand before a program without being it. */
const KEYWORDS = new Set(["then", "do", "else", "elif", "!", "{", "RUN", "CMD", "ENTRYPOINT"]);

/**
 * Words that lead a line before its command: a YAML key (`run:`, `command:`, `test:`), a list
 * item (`-`, `*`, `1.`), or a shell prompt (`$`, `%`, `>`, `#`, `user@host:~/dir$`).
 */
const LEADER = /^(?:[\w.-]+:|-|\*|\d+[.)]|[$%>#]|[\w.-]+@[\w.-]+:\S*[#$%>])$/;

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
  ["eval", new Set<string>()],
  ["npx", new Set(["-p", "--package"])],
  ["dotenv", new Set(["-e", "-v", "-p"])],
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

/** `docker run` / `podman run` options that take a value. */
const RUN_OPTIONS = new Set([
  ...EXEC_OPTIONS,
  "-a",
  "-c",
  "-h",
  "-l",
  "-m",
  "-p",
  "-v",
  "--add-host",
  "--annotation",
  "--arch",
  "--attach",
  "--blkio-weight",
  "--blkio-weight-device",
  "--cap-add",
  "--cap-drop",
  "--cgroup-parent",
  "--cgroupns",
  "--cidfile",
  "--cpu-period",
  "--cpu-quota",
  "--cpu-rt-period",
  "--cpu-rt-runtime",
  "--cpu-shares",
  "--cpus",
  "--cpuset-cpus",
  "--cpuset-mems",
  "--device",
  "--device-cgroup-rule",
  "--device-read-bps",
  "--device-read-iops",
  "--device-write-bps",
  "--device-write-iops",
  "--dns",
  "--dns-option",
  "--dns-search",
  "--domainname",
  "--entrypoint",
  "--expose",
  "--gpus",
  "--gidmap",
  "--group-add",
  "--health-cmd",
  "--health-interval",
  "--health-retries",
  "--health-start-interval",
  "--health-start-period",
  "--health-timeout",
  "--hostname",
  "--ip",
  "--ip6",
  "--ipc",
  "--isolation",
  "--kernel-memory",
  "--label",
  "--label-file",
  "--link",
  "--link-local-ip",
  "--log-driver",
  "--log-opt",
  "--mac-address",
  "--memory",
  "--memory-reservation",
  "--memory-swap",
  "--memory-swappiness",
  "--mount",
  "--name",
  "--net",
  "--network",
  "--network-alias",
  "--oom-score-adj",
  "--os",
  "--pid",
  "--pids-limit",
  "--platform",
  "--pod",
  "--publish",
  "--pull",
  "--restart",
  "--runtime",
  "--secret",
  "--security-opt",
  "--shm-size",
  "--stop-signal",
  "--stop-timeout",
  "--storage-opt",
  "--sysctl",
  "--tmpfs",
  "--uidmap",
  "--ulimit",
  "--userns",
  "--uts",
  "--volume",
  "--volume-driver",
  "--volumes-from",
]);

/** `docker` / `podman` / `nerdctl` options before the subcommand that take a value. */
const CONTAINER_OPTIONS = new Set([
  "-H",
  "-c",
  "-l",
  "-n",
  "-a",
  "--host",
  "--context",
  "--config",
  "--log-level",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
  "--connection",
  "--url",
  "--identity",
  "--root",
  "--runroot",
  "--storage-driver",
  "--namespace",
  "--address",
  "--snapshotter",
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

/** A token's last path part, without quotes or a backslash (`"/usr/bin/mysql"`, `\mysql`). */
function basename(token: string): string {
  const bare = token.replace(/['"\\]/g, "");
  const slash = bare.lastIndexOf("/");
  return (slash === -1 ? bare : bare.slice(slash + 1)).toLowerCase();
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

/** `--entrypoint mysql` / `--entrypoint=mysql` among `docker run`'s options, from `i` to `end`. */
function entrypoint(tokens: readonly string[], i: number, end: number): string | null {
  for (let j = i; j < end; j++) {
    const token = tokens[j] as string;
    const value =
      token === "--entrypoint"
        ? tokens[j + 1]
        : token.startsWith("--entrypoint=")
          ? token.slice("--entrypoint=".length)
          : undefined;
    // An empty entrypoint (`--entrypoint ""`) clears it: the image's command runs.
    if (value !== undefined) return value.replace(/['"]/g, "") === "" ? null : value;
  }
  return null;
}

/**
 * A statement's PROGRAM word, past assignments, keywords and wrappers, or null. A token holding an
 * earlier pattern's redaction (`DB_PASSWORD=<redacted>`) is an assignment. `docker run
 * --entrypoint <program>` names the program among its options.
 */
function programWord(tokens: readonly string[]): string | null {
  let i = 0;
  let leading = true; // only leaders so far
  // Every pass consumes at least one token or returns, so there are at most as many passes as
  // tokens (a statement is at most `WINDOW` characters).
  for (let pass = 0; pass <= tokens.length && i < tokens.length; pass++) {
    const token = tokens[i] as string;
    if (leading && LEADER.test(token)) {
      i++;
      continue;
    }
    leading = false;
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
    // The subcommand, past the global options (`docker --context prod exec`) and `container`.
    let sub = container ? skipOptions(tokens, i + 1, CONTAINER_OPTIONS) : i + 1;
    if (container && tokens[sub] === "container") sub++;
    if (word === "docker-compose" || (container && tokens[sub] === "compose")) {
      const command = skipOptions(
        tokens,
        word === "docker-compose" ? i + 1 : sub + 1,
        COMPOSE_OPTIONS,
      );
      if (tokens[command] !== "exec" && tokens[command] !== "run") return token;
      i = skipOptions(tokens, command + 1, COMPOSE_EXEC_OPTIONS) + 1; // the service
      continue;
    }
    if (container && (tokens[sub] === "exec" || tokens[sub] === "run")) {
      const run = tokens[sub] === "run";
      const end = skipOptions(tokens, sub + 1, run ? RUN_OPTIONS : EXEC_OPTIONS);
      const entry = run ? entrypoint(tokens, sub + 1, end) : null;
      if (entry !== null) return entry;
      i = end + 1; // the container, or the image
      continue;
    }
    if (word === "kubectl" || word === "oc") {
      const dashes = tokens.indexOf("--", i);
      const before = dashes === -1 ? [] : tokens.slice(i, dashes);
      if (!before.includes("exec") && !before.includes("run") && !before.includes("debug")) {
        return null;
      }
      i = dashes + 1;
      continue;
    }
    if (word === "ssh") {
      i = skipOptions(tokens, i + 1, SSH_OPTIONS) + 1; // the host
      continue;
    }
    return token;
  }
  return null;
}

/** Is a statement's program, given as its tokens, mysql or mariadb? */
function runsMysql(tokens: readonly string[]): boolean {
  const program = programWord(tokens);
  return program !== null && PROGRAM.test(basename(program));
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

/** Where the word glued to the left of `i` starts: at most 64 characters back, and not before `at`. */
function gluedWordStart(text: string, i: number, at: number): number {
  const from = Math.max(at, i - 64);
  let j = i;
  while (j > from && text[j - 1] !== " " && text[j - 1] !== "\t") j--;
  return j;
}

/** A statement's reading: where it starts, and whether a quote left it unsure. */
interface Reading {
  start: number;
  /**
   * A quote that does not close before the candidate on its own line starts at `start`, or the
   * statement starts before the window.
   */
  unsure: boolean;
  /** The statement starts before the window: `start` is `UNSURE_TAIL` back. */
  outside?: boolean;
  /** The quote the statement is inside (`"command":"…"`, `bash -c '…'`), or null. */
  inside: string | null;
}

/** The scan state reached at a candidate, carried to the next candidate in the same text. */
interface ScanState {
  text: string;
  i: number;
  at: number;
  found: boolean;
  blank: boolean;
  inside: string | null;
  word: boolean;
}

let carried: ScanState | null = null;

/**
 * Where the statement holding `end` starts: after a separator or an escaped newline, or inside a
 * quote that holds a command (`bash -c '…'`, a JSON string value `"command": "…"`). A quoted
 * argument is skipped whole; the closing quote of a JSON string (`"bash",`) ends a statement; a
 * line continuation (`\` and a newline, raw or JSON-escaped) does not. Unsure when the
 * statement starts before the window. It scans from the previous candidate's state when that is in the
 * window, else from `end - WINDOW`.
 */
function statementStart(text: string, end: number): Reading {
  const windowStart = Math.max(0, end - WINDOW);
  let i: number;
  let at: number;
  let found: boolean;
  let blank: boolean; // nothing but whitespace since `at`
  let inside: string | null; // the quote that holds the statement
  let word: boolean; // `inside` holds one word so far (`"/usr/bin/mysql" -p…`)
  if (carried && carried.text === text && carried.i <= end && carried.i >= windowStart) {
    ({ i, at, found, blank, inside, word } = carried);
  } else {
    i = windowStart;
    at = windowStart;
    found = windowStart === 0;
    blank = true;
    inside = null;
    word = false;
  }
  carried = null;
  while (i < end) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "\\") {
      if (next === "n" || next === "r") {
        // An escaped newline: a new line, outside any quote left open on the last one.
        at = i + 2;
        found = true;
        blank = true;
        inside = null;
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
      if (next === "u" && text.startsWith("0026", i + 2)) {
        // A JSON-escaped `&` (`\u0026\u0026`, as Go's encoder writes it) ends a statement.
        at = i + 6;
        found = true;
        blank = true;
        i += 6;
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
        inside = null;
        continue;
      }
      const after = text[i + quote.length];
      if (quote === inside && word && (after === " " || after === "\t")) {
        // It held one word, the program (`"/usr/bin/mysql" -p…`): the statement goes on.
        i += quote.length;
        blank = false;
        inside = null;
        continue;
      }
      if (quote === inside || (!blank && (after === "," || after === "]" || after === "}"))) {
        // The quote that closes the one holding the statement, or the closing quote of a JSON
        // string (`"bash",`): the statement ends here.
        i += quote.length;
        at = i;
        found = true;
        blank = true;
        inside = null;
        continue;
      }
      if (blank || holdsCommand(text, at, i)) {
        // A quote that holds a command: the statement starts inside it.
        i += quote.length;
        at = i;
        found = true;
        blank = true;
        inside = quote;
        word = true;
        continue;
      }
      // A quoted argument is skipped whole.
      const close = closingQuote(text, quote, i + quote.length, end);
      if (close === -1) {
        // `end` is inside the quote, or the quote is an apostrophe (`don't`): unsure. The next
        // candidate reads this quote again, with a later end. The word glued to the quote is read
        // too, since the quote may close it (`"/usr/bin/mysql" -p…`, `'mysql' -p…`).
        carried = { text, i, at, found, blank, inside, word };
        return { start: gluedWordStart(text, i, at), unsure: true, inside };
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
      word = false;
      if (c === "\n" || c === "\r") inside = null; // a new line, outside a quote left open
    } else if (c !== " " && c !== "\t") {
      blank = false;
    } else {
      word = false;
    }
    i++;
  }
  carried = { text, i, at, found, blank, inside, word };
  if (found && at >= windowStart) return { start: at, unsure: false, inside };
  // The statement starts before the window: unsure, read the tail the candidate regex vouched for.
  return {
    start: Math.max(windowStart, end - UNSURE_TAIL),
    unsure: true,
    outside: true,
    inside: null,
  };
}

/**
 * The mysql words of a text, found in one pass: the last one before the latest candidate, and the
 * next one after it. Candidates in a text come in order, so the text is searched once.
 */
interface WordScan {
  text: string;
  /** Where the last word before `end` starts, or -1. */
  last: number;
  /** Where the next word starts, at or after `end`; `Infinity` when there is none. */
  next: number;
  /** The latest candidate's offset. */
  end: number;
}

let words: WordScan | null = null;

/**
 * Is there a mysql word between `from` and `end`? The search runs forward through the text once
 * across all of its candidates: a candidate before the next known word needs no search at all,
 * so a long line with no separator stays linear and cheap.
 */
function wordWithin(text: string, from: number, end: number): boolean {
  if (!words || words.text !== text || words.end > end) {
    words = { text, last: -1, next: -1, end };
  }
  words.end = end;
  while (words.next < end) {
    if (words.next !== -1) words.last = words.next;
    PROGRAM_WORDS.lastIndex = words.next === -1 ? 0 : words.next + 1;
    const m = PROGRAM_WORDS.exec(text);
    words.next = m ? m.index : Number.POSITIVE_INFINITY;
  }
  return words.last >= from;
}

/**
 * `$(which mysql) -p…` or `` `which mysql` -p… ``: the statement before the candidate starts right
 * after a command substitution that is itself at a statement start, and it names a mysql program.
 * Reads at most 64 characters of the substitution and 8 before it.
 */
function substitutedProgram(text: string, start: number): boolean {
  const close = start - 1;
  const c = text[close];
  if (c !== ")" && c !== "`") return false;
  let open = -1;
  for (let j = close - 1; j >= Math.max(0, close - 64); j--) {
    if (c === ")" ? text[j] === "(" && text[j - 1] === "$" : text[j] === "`") {
      open = j;
      break;
    }
  }
  if (open === -1) return false;
  let p = c === ")" ? open - 2 : open - 1;
  const from = p - 8;
  while (p >= 0 && p > from && (text[p] === " " || text[p] === "\t")) p--;
  const before = text[p];
  if (p >= 0 && !SEPARATORS.has(before as string) && before !== '"' && before !== "'") {
    return false;
  }
  return PROGRAM_WORD.test(text.slice(open + 1, close));
}

/**
 * An exec-form argv candidate (`, "-p…` or `[\\"-p…`): the elements from the array's `[` are the
 * statement's tokens. The `[` is looked for at most `WINDOW` characters back, on the same line.
 */
function argvProgram(text: string, offset: number, match: string): boolean {
  let open = -1;
  if (match[0] === "[") open = offset;
  else {
    for (let j = offset - 1; j >= Math.max(0, offset - WINDOW); j--) {
      const c = text[j];
      if (c === "[") {
        open = j;
        break;
      }
      if (c === "]" || c === "\n") break;
    }
  }
  if (open === -1) return false;
  const tokens = text
    .slice(open + 1, offset)
    .split(",")
    .map((element) => element.trim().replace(/["\\]/g, ""));
  return runsMysql(tokens);
}

/**
 * `offset` is where the candidate ` -p<value>` starts in `text`. True when its statement's
 * program is mysql or mariadb, or when the reading is unsure and a mysql word follows the quote.
 */
export function isMysqlPasswordFlag(match: string, offset: number, text: string): boolean {
  if (match[0] === "[" || match[0] === ",") return argvProgram(text, offset, match);
  // The value starts after ` -p` (3 characters) and is read in place, not sliced: this runs once
  // per candidate. An empty quoted value (`-p""`, `-p\"\"`) holds no password.
  if (isEmptyQuoted(match)) return false;
  const reading = statementStart(text, offset);
  // A bare `-p` before the quote that closes the statement's string prompts; that quote is not
  // a quoted password (`"command":"mysql -uroot -p","…"`, `bash -c 'mysql -p' && …`).
  if (reading.inside !== null && match.startsWith(reading.inside, 3)) return false;
  // When the reading is unsure, the enclosing quote is unknown: a quote followed by whitespace
  // or `, : } ]` closes an outer string more often than it opens a password
  // (`echo "run mysql -uroot -p" && …`).
  if (reading.unsure && quoteThenClose(match)) return false;
  if (reading.outside) return wordWithin(text, reading.start, offset);
  const statement = text.slice(reading.start, offset);
  if (reading.unsure) return PROGRAM_WORD.test(statement);
  const tokens = statement.trim().split(/\s+/);
  return runsMysql(tokens) || substitutedProgram(text, reading.start);
}
