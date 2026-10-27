// cspell:words nohup stdbuf doas ionice setsid caffeinate flock equexit shotsdir classdata pgid argv0 chroot userconfig
/**
 * The words that come before a program and are not it (`sudo`, `env`, `timeout 5`), and the
 * options of each that take the next word as their value. One table for every reader that looks
 * for a command's program — `ran.ts`, `shell-words.ts` and `calls.ts` — so `sudo -D /x git push`
 * names the same program to every check. `git`'s own options before its subcommand are one table
 * here too.
 *
 * Pure. No I/O, no imports.
 */

/** Words that come before a program and are not it. */
export const PREFIX_WORDS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "builtin",
  "exec",
  "time",
  "nohup",
  "nice",
  "ionice",
  "setsid",
  "caffeinate",
  "stdbuf",
  "timeout",
  "flock",
  "watch",
  "npx",
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

/**
 * The options of each prefix word that take a value: the next word (`sudo -u root`, `sudo --user
 * root`), the rest of a short option's word (`ionice -c3`), or what follows `=` in a long
 * option's word (`sudo --user=root`). Any other option of a prefix word is a flag: `sudo -n`,
 * `sudo -s`, `env -i`.
 */
export const PREFIX_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "sudo",
    new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-C",
      "--close-from",
      "-D",
      "--chdir",
      "-h",
      "--host",
      "-p",
      "--prompt",
      "-R",
      "--chroot",
      "-r",
      "--role",
      "-t",
      "--type",
      "-T",
      "--command-timeout",
      "-U",
      "--other-user",
    ]),
  ],
  ["doas", new Set(["-u", "-C"])],
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"])],
  ["nice", new Set(["-n", "--adjustment"])],
  [
    "ionice",
    new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  ],
  ["caffeinate", new Set(["-t", "-w"])],
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["stdbuf", new Set(["-i", "--input", "-o", "--output", "-e", "--error"])],
  ["time", new Set(["-f", "--format", "-o", "--output"])],
  ["exec", new Set(["-a"])],
  [
    "flock",
    new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code", "-c", "--command"]),
  ],
  ["watch", new Set(["-n", "--interval", "-q", "--equexit", "--shotsdir"])],
  [
    "npx",
    new Set([
      "-p",
      "--package",
      "-c",
      "--call",
      "-w",
      "--workspace",
      "--registry",
      "--cache",
      "--prefix",
      "--userconfig",
    ]),
  ],
]);

/**
 * The options of a prefix word whose value is a command given as one string, which a shell or
 * the word itself splits into words: `env -S 'cmd args'`, `flock lock -c 'cmd'`, `npx -c 'cmd'`.
 * The command in it is not read as words here, so a command that uses one holds the
 * `shell-string` hiding form.
 */
export const PREFIX_SHELL_STRING_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["env", new Set(["-S", "--split-string"])],
  ["flock", new Set(["-c", "--command"])],
  ["npx", new Set(["-c", "--call"])],
]);

/** Prefix words followed by one operand before the program: `timeout 5 cmd`, `flock lock cmd`. */
const PREFIX_OPERANDS: ReadonlySet<string> = new Set(["timeout", "flock"]);

/**
 * `git`'s own options, before its subcommand, that take the next word as their value: `git -C
 * repo`, `git --namespace x`. The long ones also take it after `=` in the same word
 * (`--git-dir=/x`), which is one word to skip. `--exec-path` is not one: alone it prints git's
 * exec path and exits, and it takes a path only as `--exec-path=<path>`. One table for every
 * reader of a `git` command, so `git --namespace x push` names `push` to every check.
 */
export const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--attr-source",
]);

/**
 * Where a `git` command's subcommand is among the words after `git`: past git's own options and
 * their values (`GIT_GLOBAL_VALUE_OPTIONS`). `args.length` when there is none.
 */
export function gitSubcommandIndex(args: readonly string[]): number {
  let k = 0;
  while (k < args.length && (args[k] as string).startsWith("-")) {
    k += GIT_GLOBAL_VALUE_OPTIONS.has(args[k] as string) ? 2 : 1;
  }
  return k;
}

/** A shell variable assignment before the program, such as `HUSKY=0`. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A program's name from its word: the file name, lower-cased, without `.exe`. */
export function programNameOf(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * One option word of a prefix word: the options it gives, and whether the last of them takes the
 * next word as its value. A long option takes its value after `=` or as the next word
 * (`--user=root`, `--user root`). A short one may share its word with others (`-Eu root`), and
 * one that takes a value takes the rest of the word (`-c3`), or the next word when it is last.
 */
function readOption(
  name: string,
  word: string,
): { readonly given: readonly string[]; readonly takesNext: boolean } {
  const valued = PREFIX_VALUE_OPTIONS.get(name);
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    const option = eq < 0 ? word : word.slice(0, eq);
    return { given: [option], takesNext: eq < 0 && valued?.has(option) === true };
  }
  const given: string[] = [];
  for (let c = 1; c < word.length; c++) {
    const option = `-${word[c]}`;
    given.push(option);
    if (valued?.has(option) === true) return { given, takesNext: c === word.length - 1 };
  }
  return { given, takesNext: false };
}

/**
 * Where the program is among a command's words, past assignments and prefix words with their
 * options, and the operand `timeout` and `flock` take before it (a duration, a lock file);
 * `values.length` when there is none. `assignments` are the indexes of the `NAME=value` words
 * before it, including those given to `env`.
 *
 * `shellString` is set when a prefix word is given its command as one string it splits or hands
 * to a shell (`PREFIX_SHELL_STRING_OPTIONS`), or is `watch` without `-x`, which runs its words
 * through `sh -c`. What that string runs is not read as words here.
 */
export function programStart(values: readonly string[]): {
  readonly index: number;
  readonly assignments: readonly number[];
  readonly shellString: boolean;
} {
  const assignments: number[] = [];
  let shellString = false;
  let k = 0;
  while (k < values.length) {
    const value = values[k] as string;
    if (ASSIGNMENT.test(value)) {
      assignments.push(k);
      k += 1;
      continue;
    }
    const name = programNameOf(value);
    if (!PREFIX_WORDS.has(name)) return { index: k, assignments, shellString };
    const strings = PREFIX_SHELL_STRING_OPTIONS.get(name);
    let exec = false;
    k += 1;
    // A prefix word's own options, `sudo -E`, `env -i`, and their values, `sudo -u root`. A `--`
    // ends them.
    const readOptions = (): void => {
      while (k < values.length && (values[k] as string).startsWith("-")) {
        if (values[k] === "--") {
          k += 1;
          return;
        }
        const read = readOption(name, values[k] as string);
        if (read.given.some((option) => strings?.has(option) === true)) shellString = true;
        if (read.given.some((option) => option === "-x" || option === "--exec")) exec = true;
        k += read.takesNext ? 2 : 1;
      }
    };
    readOptions();
    // `timeout 5 cmd`: the duration. `flock lock cmd`, `flock lock -c 'cmd'`: the lock file,
    // and the options after it.
    if (PREFIX_OPERANDS.has(name) && k < values.length) {
      k += 1;
      if (name === "flock") readOptions();
    }
    if (name === "watch" && !exec) shellString = true;
  }
  return { index: k, assignments, shellString };
}
