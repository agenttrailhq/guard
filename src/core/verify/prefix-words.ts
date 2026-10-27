// cspell:words nohup stdbuf doas ionice setsid caffeinate flock equexit shotsdir classdata pgid argv0 chroot userconfig bunx gtimeout taskset chrt runuser sched direnv pipenv
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
  "bunx",
  "gtimeout",
  "chronic",
  "unbuffer",
  "taskset",
  "chrt",
  "runuser",
  "dotenv",
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
  ["gtimeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["chrt", new Set(["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"])],
  [
    "runuser",
    new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-G",
      "--supp-group",
      "-s",
      "--shell",
      "-w",
      "--whitelist-environment",
      "-c",
      "--command",
      "--session-command",
    ]),
  ],
  ["dotenv", new Set(["-e", "-v", "-c", "-p", "-f", "--file", "-q", "--quote", "--export"])],
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
  ["bunx", new Set(["-p", "--package"])],
  // The launchers' own options, before and after the subcommand that runs a command.
  ["aws-vault", new Set(["-d", "--duration", "--region", "-t", "--mfa-token", "--backend"])],
  ["op", new Set(["--env-file", "--account", "--config", "--session"])],
  ["doppler", new Set(["-p", "--project", "-c", "--config", "--token", "--scope", "--command"])],
  ["mise", new Set(["-C", "--cd", "-E", "--env", "-j", "--jobs", "-c", "--command"])],
  [
    "uv",
    new Set([
      "--with",
      "--with-editable",
      "--with-requirements",
      "-p",
      "--python",
      "--project",
      "--directory",
      "--env-file",
      "--extra",
      "--group",
      "--only-group",
      "--package",
      "--index",
      "--index-url",
      "--extra-index-url",
      "--default-index",
    ]),
  ],
  ["poetry", new Set(["-C", "--directory", "-P", "--project"])],
  ["bundle", new Set(["--gemfile"])],
  ["pnpm", new Set(["-C", "--dir", "-F", "--filter", "--workspace-dir", "--reporter"])],
  [
    "npm",
    new Set([
      "-w",
      "--workspace",
      "-p",
      "--package",
      "-c",
      "--call",
      "--prefix",
      "--registry",
      "--cache",
      "--userconfig",
    ]),
  ],
]);

/**
 * The options of a prefix word or launcher whose value is a command given as one string, which a
 * shell or the word itself splits into words: `env -S 'cmd args'`, `flock lock -c 'cmd'`,
 * `npx -c 'cmd'`, `doppler run --command 'cmd'`, or that runs its command's words through a
 * shell (`pnpm exec -c`). The command in it is not read as words here, so a command that uses
 * one holds the `shell-string` hiding form.
 */
export const PREFIX_SHELL_STRING_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["env", new Set(["-S", "--split-string"])],
  ["flock", new Set(["-c", "--command"])],
  ["npx", new Set(["-c", "--call"])],
  ["npm", new Set(["-c", "--call"])],
  ["runuser", new Set(["-c", "--command", "--session-command"])],
  ["doppler", new Set(["--command"])],
  ["mise", new Set(["-c", "--command"])],
  ["pnpm", new Set(["-c", "--shell-mode"])],
]);

/**
 * Prefix words followed by operands before the program: `timeout 5 cmd`, `flock lock cmd`,
 * `taskset -c 0 cmd`, `chrt 10 cmd`.
 */
const PREFIX_OPERANDS: ReadonlySet<string> = new Set([
  "timeout",
  "gtimeout",
  "flock",
  "taskset",
  "chrt",
]);

/**
 * A program that runs the command given after one of its subcommands: `uv run cmd`,
 * `aws-vault exec <profile> -- cmd`, `direnv exec <dir> cmd`.
 *
 * - `subcommands`: the subcommands that run a command; any other makes the launcher itself the
 *   program, as `npm install` is.
 * - `operands`: the words between the subcommand and the command, `aws-vault exec <profile>`.
 *   A `--` before them ends the launcher's options, and the command follows it.
 * - `dashDash`: `require` when only a command after `--` runs (`mise exec <tools> -- cmd`), so
 *   without one no command is read.
 */
interface Launcher {
  readonly subcommands: ReadonlySet<string>;
  readonly operands: number;
  readonly dashDash?: "require";
}

/** The launchers the readers read past to the command they run. */
export const LAUNCHERS: ReadonlyMap<string, Launcher> = new Map<string, Launcher>([
  ["aws-vault", { subcommands: new Set(["exec"]), operands: 1 }],
  ["op", { subcommands: new Set(["run"]), operands: 0 }],
  ["doppler", { subcommands: new Set(["run"]), operands: 0 }],
  ["mise", { subcommands: new Set(["exec", "x"]), operands: 0, dashDash: "require" }],
  ["direnv", { subcommands: new Set(["exec"]), operands: 1 }],
  ["uv", { subcommands: new Set(["run"]), operands: 0 }],
  ["poetry", { subcommands: new Set(["run"]), operands: 0 }],
  ["pipenv", { subcommands: new Set(["run"]), operands: 0 }],
  ["pdm", { subcommands: new Set(["run"]), operands: 0 }],
  ["bundle", { subcommands: new Set(["exec"]), operands: 0 }],
  ["bundler", { subcommands: new Set(["exec"]), operands: 0 }],
  ["pnpm", { subcommands: new Set(["exec", "dlx"]), operands: 0 }],
  ["yarn", { subcommands: new Set(["exec", "dlx"]), operands: 0 }],
  ["npm", { subcommands: new Set(["exec", "x"]), operands: 0 }],
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
 * Where the program is among a command's words, past assignments, prefix words with their
 * options and the operands some take before it (`timeout`'s duration, `flock`'s lock file), and
 * launchers with the subcommand that runs a command (`uv run`, `aws-vault exec <profile> --`);
 * `values.length` when there is none. `assignments` are the indexes of the `NAME=value` words
 * before it, including those given to `env`.
 *
 * `shellString` is set when a prefix word or launcher is given its command as one string it
 * splits or hands to a shell (`PREFIX_SHELL_STRING_OPTIONS`), or is `watch` without `-x`, which
 * runs its words through `sh -c`. What that string runs is not read as words here.
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
    const launcher = LAUNCHERS.get(name);
    if (!PREFIX_WORDS.has(name) && launcher === undefined) {
      return { index: k, assignments, shellString };
    }
    const strings = PREFIX_SHELL_STRING_OPTIONS.get(name);
    const given = new Set<string>();
    let ended = false;
    // A prefix word's own options, `sudo -E`, `env -i`, and their values, `sudo -u root`. A `--`
    // ends them.
    const readOptions = (): void => {
      while (k < values.length && (values[k] as string).startsWith("-")) {
        if (values[k] === "--") {
          k += 1;
          ended = true;
          return;
        }
        const read = readOption(name, values[k] as string);
        for (const option of read.given) {
          given.add(option);
          if (strings?.has(option) === true) shellString = true;
        }
        k += read.takesNext ? 2 : 1;
      }
    };
    const start = k;
    k += 1;
    readOptions();
    if (launcher !== undefined) {
      // A launcher runs a command only through one of its subcommands; otherwise it is the
      // program, as `npm install` is.
      if (ended || !launcher.subcommands.has(values[k] ?? "")) {
        return { index: start, assignments, shellString };
      }
      k += 1;
      if (launcher.dashDash === "require") {
        // Its own options first (`mise exec -c 'cmd'`), then the command after a `--`.
        readOptions();
        if (ended) continue;
        const dash = values.indexOf("--", k);
        if (dash < 0) return { index: values.length, assignments, shellString };
        k = dash + 1;
        continue;
      }
      readOptions();
      if (ended) continue;
      k += launcher.operands;
      readOptions();
      continue;
    }
    // `timeout 5 cmd`: the duration. `flock lock cmd`, `flock lock -c 'cmd'`: the lock file,
    // and the options after it. `taskset -c 0 cmd`: the CPU list. `chrt 10 cmd`: the priority.
    if (PREFIX_OPERANDS.has(name) && k < values.length && !ended) {
      k += 1;
      if (name === "flock") readOptions();
    }
    // `runuser root -c 'cmd'`: with no `-u`, the first operand is the user, and what follows
    // goes to the user's shell.
    if (name === "runuser" && !given.has("-u") && !given.has("--user") && !ended) {
      if (k < values.length) k += 1;
      readOptions();
    }
    // `dotenv -f .env run cmd`.
    if (name === "dotenv" && values[k] === "run" && !ended) {
      k += 1;
      readOptions();
    }
    if (name === "watch" && !given.has("-x") && !given.has("--exec")) shellString = true;
  }
  return { index: k, assignments, shellString };
}
