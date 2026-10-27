// cspell:words nohup stdbuf
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

/**
 * The options of each prefix word that take the next word as their value, `sudo -u root`. Any
 * other option of a prefix word is a flag: `sudo -n`, `sudo -s`, `env -i`.
 */
export const PREFIX_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-R", "-r", "-T", "-t", "-U"])],
  ["env", new Set(["-u", "-C", "--unset", "--chdir"])],
  ["nice", new Set(["-n"])],
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["time", new Set(["-f", "-o", "--format", "--output"])],
  ["exec", new Set(["-a"])],
]);

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
 * Where the program is among a command's words, past assignments and prefix words with their
 * options, and `timeout`'s duration; `values.length` when there is none. `assignments` are the
 * indexes of the `NAME=value` words before it, including those given to `env`.
 */
export function programStart(values: readonly string[]): {
  readonly index: number;
  readonly assignments: readonly number[];
} {
  const assignments: number[] = [];
  let k = 0;
  while (k < values.length) {
    const value = values[k] as string;
    if (ASSIGNMENT.test(value)) {
      assignments.push(k);
      k += 1;
      continue;
    }
    const name = programNameOf(value);
    if (!PREFIX_WORDS.has(name)) return { index: k, assignments };
    const valued = PREFIX_VALUE_OPTIONS.get(name);
    k += 1;
    // A prefix word's own options, `sudo -E`, `env -i`, and their values, `sudo -u root`.
    while (k < values.length && (values[k] as string).startsWith("-")) {
      k += valued?.has(values[k] as string) === true ? 2 : 1;
    }
    // `timeout 5 cmd`: the duration.
    if (name === "timeout" && k < values.length) k += 1;
  }
  return { index: k, assignments };
}
