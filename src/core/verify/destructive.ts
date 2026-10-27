// cspell:words dropdb mysqladmin mongosh flushall flushdb bunx dlx PGHOST kubectl podman mypy pycache pytest libpq conninfo CONNINFO hostaddr kubeconfig pathspec pathspecs
/**
 * Destructive commands: what each recursive delete and each database wipe that ran was aimed
 * at.
 *
 * ── `rm -rf` targets ─────────────────────────────────────────────────────────
 * Each target of a recursive `rm` that ran is put in one class, in this order:
 *  0. **the home folder or above**: the home folder itself, a folder that holds it, or `/`.
 *  1. **a variable with no guard**: the path is built from a variable or a substitution with no
 *     `${VAR:?}` guard, so an empty value deletes from the wrong folder. One whose every
 *     variable is guarded is not classed further: its value is not known, so it keeps the
 *     check from clean.
 *  2. **scratch**: a temp folder, or build output such as `node_modules`, `dist` or `.cache`,
 *     with nothing under it that git tracks (a committed `dist/` that is gone, or a repository
 *     cloned into a temp folder, is class 3).
 *  3. **tracked files**: git tracks files under it. Whether they are back is asked of git now.
 *  4. **untracked files in a repo**: inside a repository, with nothing tracked under it.
 *  5. **under the home folder**, outside any repository.
 *  6. **other**: outside the home folder and outside any repository.
 * A glob is classed by the folder before its first wildcard, and a quoted `*`, `?` or `[` is
 * part of a name. A `..` after a wildcard cannot be read from the text: could-not-check. The
 * classes read the path as written: a link is not followed.
 *
 * ── Databases ────────────────────────────────────────────────────────────────
 * A command that drops a database, a schema or a table, truncates one, flushes Redis or resets
 * a schema through a migration tool, classed by where the database is:
 *  - **local**: a host on this machine or a local socket, a container started on this machine,
 *    a SQLite file, or a Redis client given no host;
 *  - **scratch**: a local database whose name says test, temp or scratch, or a SQLite file in
 *    a temp folder;
 *  - **other**: a named host that is not this machine (in an option, a URL, a libpq
 *    `host=` string or `mongosh host/db`), or one reached through `ssh` or `kubectl exec`;
 *  - **unresolved**: the host comes from a variable, a libpq `service=`, or the tool's own
 *    config; and a SQL or Mongo client given no host, whose environment or config files
 *    (`PGHOST`, `~/.pg_service.conf`, `~/.my.cnf`) pick the server.
 *
 * Only what ran counts. The exact restore commands, with real paths, are `LocalFix`es for the
 * local fixes file; the card shows their redacted shapes.
 */

import { dirname, relative, sep } from "node:path";
import {
  type CardContext,
  type CardView,
  type CommandPart,
  type FixShape,
  type LocalFix,
  type SentenceTemplate,
  sentence,
  sentences,
  type ToCard,
  type UnsafeFix,
} from "./cards.js";
import {
  addTallies,
  cardExtras,
  codexCaveat,
  codexLimitedTemplate,
  codexLines,
  counted,
  FixList,
  type GitCheckContext,
  is,
  isUnder,
  MAX_PROBED_ITEMS,
  statusOf,
  unsafeFixLine,
  was,
} from "./git-copy.js";
import { DATABASE_CLASSES, RM_TARGET_CLASSES } from "./git-facts.js";
import { isFailure } from "./repo-probe.js";
import {
  type Detector,
  type Judged,
  judgeAll,
  resolvePath,
  tallyOf,
  walkCommands,
} from "./shell-calls.js";
import {
  commandStart,
  operands,
  programName,
  type ShellWord,
  shellCommands,
} from "./shell-words.js";
import type {
  CheckedCategory,
  CouldNotCheckResult,
  HidingForm,
  PendingCheck,
  RunTally,
} from "./types.js";

export { DATABASE_CLASSES, RM_TARGET_CLASSES };

/** One class of `rm -rf` target. See the module header. */
export type RmTargetClass = (typeof RM_TARGET_CLASSES)[number];

/** One class of database. */
export type DatabaseClass = (typeof DATABASE_CLASSES)[number];

/** Recursive deletes. */
export interface RmFacts {
  readonly calls: RunTally;
  /** Targets of the calls that ran. */
  readonly targets: number;
  readonly classes: Readonly<Record<RmTargetClass, number>>;
  /** Tracked targets with every tracked file back now. */
  readonly trackedBack: number;
  /** Tracked targets that are wholly gone now. */
  readonly trackedGone: number;
  /** Tracked targets that are partly back, with tracked files still missing. */
  readonly trackedPartlyBack: number;
  /** Targets whose folder or repository could not be asked. */
  readonly couldNotCheck: number;
}

/** Destructive database commands. */
export interface DatabaseFacts {
  readonly calls: RunTally;
  /** Databases the commands that ran were aimed at, by class. */
  readonly classes: Readonly<Record<DatabaseClass, number>>;
}

/** What the destructive-commands check found. Counts only. */
export interface DestructiveFacts {
  readonly rm: RmFacts;
  readonly databases: DatabaseFacts;
  /**
   * Exact fix commands that could not be made safe. The local fixes file lists each one as could
   * not make a safe command, with no command text.
   */
  readonly unsafeFixes: number;
  /**
   * The calls that ran, or may have run, holding a form this reading does not take apart, and those forms. While
   * any is present the check cannot say nothing ran, so it is never `clean`.
   */
  readonly hidingCalls: number;
  readonly hidingForms: readonly HidingForm[];
}

declare module "./types.js" {
  interface CategoryFactsMap {
    destructive: DestructiveFacts;
  }
}

/** The destructive-commands result. */
export type DestructiveCheck = CheckedCategory<DestructiveFacts>;

/**
 * The databases that destructive commands which RAN were aimed at, by class: `local`,
 * `scratch`, `other` (a named host that is not this machine, or one reached through `ssh` or
 * `kubectl exec`) and `unresolved` (the host comes from a variable or the tool's own config).
 * For the production-infrastructure card, which counts the `other` ones.
 *
 * `undefined` when the destructive check has no facts: not checked, or it failed outright. A
 * check that is could-not-check for its `rm -rf` targets still has these counts.
 */
export function databaseTargetClasses(
  check: DestructiveCheck | CouldNotCheckResult | PendingCheck,
): Readonly<Record<DatabaseClass, number>> | undefined {
  if (!("facts" in check)) return undefined;
  const classes = check.facts.databases.classes;
  return {
    local: classes.local,
    scratch: classes.scratch,
    other: classes.other,
    unresolved: classes.unresolved,
  };
}

// ── rm -rf ───────────────────────────────────────────────────────────────────

/** One target of a recursive delete, and the folder it was read from. */
interface RmTarget {
  readonly folder: string | undefined;
  readonly word: ShellWord;
}

/** The targets of an `rm` that deletes recursively, or none. */
export function recursiveRmTargets(args: readonly ShellWord[]): ShellWord[] {
  let recursive = false;
  for (const word of args) {
    const value = word.value;
    if (value === "--") break;
    if (value === "--recursive") recursive = true;
    else if (/^-[A-Za-z]+$/.test(value) && /[rR]/.test(value)) recursive = true;
  }
  return recursive ? operands(args) : [];
}

/** Every target of a recursive `rm`. */
const rmTargets: Detector<RmTarget> = (text, cwd, home) => {
  const out: RmTarget[] = [];
  walkCommands(text, cwd, home, (command, folder) => {
    const start = commandStart(command.words).index;
    const program = command.words[start];
    if (program === undefined || programName(program) !== "rm") return;
    for (const word of recursiveRmTargets(command.words.slice(start + 1))) {
      out.push({ folder, word });
    }
  });
  return out;
};

/**
 * Is every expansion in a word guarded with `${VAR:?}`? A bare `$VAR`, a `${VAR}` without `:?`,
 * `$(…)` and backticks are not.
 */
export function guarded(raw: string): boolean {
  if (raw.includes("`") || raw.includes("$(")) return false;
  let inSingle = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'") inSingle = !inSingle;
    if (inSingle || ch !== "$") continue;
    if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*:\?/.test(raw.slice(i))) return false;
  }
  return true;
}

/** Folder names that hold build output, caches or scratch on any project. */
const SCRATCH_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".parcel-cache",
  ".svelte-kit",
  ".vite",
  ".angular",
  ".gradle",
  ".expo",
  ".output",
  ".vercel",
  "storybook-static",
  "tmp",
  "temp",
  ".tmp",
]);

/** Does a path, read from `folder`, name build output or scratch below that folder? */
export function namesScratch(path: string, folder: string | undefined): boolean {
  const below =
    folder !== undefined && (path === folder || path.startsWith(`${folder}${sep}`))
      ? relative(folder, path)
      : (path.split(/[\\/]/).pop() ?? "");
  return below.split(/[\\/]/).some((part) => SCRATCH_NAMES.has(part));
}

/**
 * The literal folder a target names, cut before its first wildcard. `wild` is where the first
 * wildcard the shell expands is (`ShellWord.globAt`); a quoted `*`, `?` or `[` is part of the
 * name. Without it, every one counts.
 */
export function literalPart(value: string, wild: number = value.search(/[*?[]/)): string {
  if (wild < 0) return value;
  const cut = value.lastIndexOf("/", wild);
  return cut < 0 ? "." : value.slice(0, cut) || "/";
}

/** One classed target. A tracked one says whether files are missing, and where it is. */
type Classed =
  | { readonly kind: Exclude<RmTargetClass, "tracked"> }
  | {
      readonly kind: "tracked";
      readonly missing: boolean;
      readonly folder: string;
      readonly path: string;
      readonly absent: boolean;
    }
  | { readonly kind: "could-not-check" };

/** Most folders walked up from a target to one that exists. */
const MAX_PARENT_STEPS = 64;

/** Class one target. See the module header. */
async function classify(context: GitCheckContext, target: RmTarget): Promise<Classed> {
  const { word } = target;
  if (word.expands) return { kind: guarded(word.raw) ? "guarded-variable" : "unguarded-variable" };
  const home = context.log.home;
  // A `..` after a wildcard climbs out of a folder the wildcard picks: the target cannot be
  // read from the text.
  if (word.globAt >= 0 && /(^|\/)\.\.(\/|$)/.test(word.value.slice(word.globAt))) {
    return { kind: "could-not-check" };
  }
  const path = resolvePath(target.folder, literalPart(word.value, word.globAt), home);
  if (path === undefined) return { kind: "could-not-check" };
  // The home folder itself, a folder that holds it, or the root: everything in it goes.
  if (path === home || path === sep || isUnder(home, [path])) return { kind: "home-or-above" };
  // A temp folder, or a build-output name (`dist`, `build`, `node_modules`), counts as scratch
  // only once git has said nothing under it is tracked: a committed `dist/` that is gone is lost
  // work, and so is a repository cloned into a temp folder.
  const byName = isUnder(path, context.scratchRoots) || namesScratch(path, target.folder);

  // The nearest folder that is still there: the target itself, or a parent of it.
  let folder = path;
  let steps = 0;
  while (context.probe.isFolder(folder) !== true && steps < MAX_PARENT_STEPS) {
    const up = dirname(folder);
    if (up === folder) break;
    folder = up;
    steps += 1;
  }
  if (context.probe.isFolder(folder) !== true) return { kind: "could-not-check" };

  const root = await context.probe.toplevel(folder);
  if (isFailure(root)) {
    if (root.failed !== "not-a-repo") return { kind: "could-not-check" };
    if (byName) return { kind: "scratch" };
    return { kind: isUnder(path, [home]) ? "home" : "other" };
  }
  const state = await context.probe.tracked(folder, path);
  if (isFailure(state)) return { kind: "could-not-check" };
  if (state.tracked === 0) return { kind: byName ? "scratch" : "untracked" };
  return {
    kind: "tracked",
    missing: state.missing > 0,
    folder,
    path,
    absent: context.probe.exists(path) === false,
  };
}

/**
 * The parts of the exact command that brings a wholly gone tracked target back. A target that
 * is wholly gone has nothing in it to overwrite. One partly back may hold new changes, so no
 * command restores it as a whole. `--literal-pathspecs` makes git take the path as a name:
 * never a wildcard, and never pathspec magic such as `:(top)`.
 */
function restoreParts(folder: string, path: string): CommandPart[] {
  const rel = relative(folder, path).split(sep).join("/") || ".";
  return ["git", "-C", { ref: folder }, "--literal-pathspecs", "restore", "--", { repoPath: rel }];
}

/** Class every target of the calls that ran. */
async function checkRm(
  context: GitCheckContext,
  judged: readonly Judged<RmTarget>[],
  fixes: FixList,
): Promise<RmFacts> {
  const classes = Object.fromEntries(RM_TARGET_CLASSES.map((c) => [c, 0])) as Record<
    RmTargetClass,
    number
  >;
  let targets = 0;
  let trackedBack = 0;
  let trackedGone = 0;
  let trackedPartlyBack = 0;
  let couldNotCheck = 0;
  for (const j of judged) {
    for (const target of j.found) {
      targets += 1;
      if (targets > MAX_PROBED_ITEMS) {
        couldNotCheck += 1;
        continue;
      }
      const classed = await classify(context, target);
      if (classed.kind === "could-not-check") {
        couldNotCheck += 1;
        continue;
      }
      classes[classed.kind] += 1;
      if (classed.kind !== "tracked") continue;
      if (!classed.missing) {
        trackedBack += 1;
        continue;
      }
      if (!classed.absent) {
        trackedPartlyBack += 1;
        continue;
      }
      trackedGone += 1;
      fixes.add(restoreParts(classed.folder, classed.path));
    }
  }
  return {
    calls: tallyOf(judged),
    targets,
    classes,
    trackedBack,
    trackedGone,
    trackedPartlyBack,
    couldNotCheck,
  };
}

/** Tracked targets with files still missing. */
function trackedMissing(f: DestructiveFacts): number {
  return f.rm.trackedGone + f.rm.trackedPartlyBack;
}

// ── Databases ────────────────────────────────────────────────────────────────

/** Where a database is, as a command names it. */
type Host = "local" | "remote" | "unresolved";

/** One database a destructive command was aimed at. */
interface DatabaseTarget {
  readonly host: Host;
  /** Its name says test, temp or scratch, or it is a SQLite file in a temp folder. */
  readonly scratch: boolean;
  /** The command named no host, so `host` is its client's default. */
  readonly noHostGiven?: boolean;
}

/** SQL that drops or empties data. */
const DESTRUCTIVE_SQL = /\b(?:drop\s+(?:database|schema|table)|truncate)\b/i;

/** A host on this machine. */
const LOCAL_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|[a-z0-9-]+\.localhost)$/i;

/** A database name that says it is for tests or scratch. */
const SCRATCH_DATABASE =
  /(?:^|[_.-])(?:test|tests|testing|tmp|temp|scratch|e2e|ci|sandbox|throwaway|dummy)(?:$|[_.\d-])/i;

/** A connection URL: its host and the database named in its path. */
const URL_PARTS =
  /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::\d+)?(?:\/([^?#]*))?/i;

/**
 * The class of a host as written. A path is a local socket. None given is `noHost`: for a
 * client whose own config or environment picks the server (`PGHOST`, a service file,
 * `~/.my.cnf`), that is `unresolved`, never local.
 */
function hostClass(host: string | undefined, noHost: Host): Host {
  if (host === undefined || host === "") return noHost;
  if (host.startsWith("/")) return "local";
  if (host.includes("$")) return "unresolved";
  return LOCAL_HOST.test(host) ? "local" : "remote";
}

/** A libpq keyword/value connection string: `host=… dbname=…`. */
const CONNINFO = /(?:^|\s)(?:host|hostaddr|service|dbname)\s*=/;

/** The keywords of a libpq connection string. */
function conninfoOf(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const match of text.matchAll(/(\w+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S*))/g)) {
    out.set((match[1] as string).toLowerCase(), match[2] ?? match[3] ?? "");
  }
  return out;
}

/** The value of an option given as `-h x`, `-hx`, `--host x` or `--host=x`. */
function optionValue(
  words: readonly ShellWord[],
  short: string | undefined,
  long: string | undefined,
): ShellWord | undefined {
  for (let k = 0; k < words.length; k++) {
    const value = (words[k] as ShellWord).value;
    const word = words[k] as ShellWord;
    if ((short !== undefined && value === short) || (long !== undefined && value === long)) {
      return words[k + 1];
    }
    if (long !== undefined && value.startsWith(`${long}=`)) {
      return { ...word, value: value.slice(long.length + 1) };
    }
    if (
      short !== undefined &&
      value.startsWith(short) &&
      value.length > short.length &&
      !value.startsWith("--")
    ) {
      return { ...word, value: value.slice(short.length) };
    }
  }
  return undefined;
}

/** An option's short and long spellings. Either may be absent. */
type OptionNames = readonly [string | undefined, string | undefined];

/** The host and name of a `psql`, `dropdb`, `mysql`, `redis-cli` or `mongosh` command. */
function serverOf(
  args: readonly ShellWord[],
  assignments: readonly ShellWord[],
  options: {
    readonly host: OptionNames;
    readonly name?: OptionNames;
    /** The class when no host is given. See `hostClass`. */
    readonly noHost: Host;
    /** The first operand may be `host[:port]/db`, as `mongosh` takes it. */
    readonly positionalHost?: boolean;
  },
  sql = "",
): DatabaseTarget {
  const urls = args.filter((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a.value));
  const hostWord = optionValue(args, options.host[0], options.host[1]);
  const nameWord =
    options.name === undefined ? undefined : optionValue(args, options.name[0], options.name[1]);
  const urlWord =
    urls[0] ?? (nameWord !== undefined && /:\/\//.test(nameWord.value) ? nameWord : undefined);
  const fromUrl = urlWord?.value.match(URL_PARTS) ?? undefined;
  // A libpq connection string, given as an operand or as `-d`.
  const infoWord = args.find((a) => CONNINFO.test(a.value));
  const info = infoWord === undefined ? undefined : conninfoOf(infoWord.value);
  const pgHost = assignments.find((a) => a.value.startsWith("PGHOST="));
  const rest = operands(args, DATABASE_VALUE_OPTIONS);
  // `mongosh db.example.com/app`, `mongosh db.example.com:27017/app`.
  const positional =
    options.positionalHost === true &&
    rest[0] !== undefined &&
    !rest[0].value.includes("://") &&
    /^[^/\s]+(?::\d+)?\//.test(rest[0].value)
      ? rest[0]
      : undefined;
  const host =
    fromUrl?.[1] ??
    info?.get("host") ??
    info?.get("hostaddr") ??
    positional?.value.split("/")[0]?.replace(/:\d+$/, "") ??
    hostWord?.value ??
    pgHost?.value.slice("PGHOST=".length);
  // A service name is looked up in the user's service file: where it points is not known.
  const service = host === undefined && info?.has("service") === true;
  // A host, a URL or a database argument built from a variable: where it points is not known.
  const variable =
    hostWord?.expands === true ||
    pgHost?.expands === true ||
    urlWord?.expands === true ||
    infoWord?.expands === true ||
    (hostWord === undefined &&
      fromUrl === undefined &&
      (nameWord?.expands === true || rest.some((o) => o.expands)));
  // The database a `DROP DATABASE` names, or else the one the command connects to.
  const dropped = /\bdrop\s+database\s+(?:if\s+exists\s+)?[`"']?([\w.-]+)/i.exec(sql)?.[1];
  const name =
    dropped ??
    fromUrl?.[2] ??
    info?.get("dbname") ??
    positional?.value.split("/")[1] ??
    nameWord?.value ??
    rest.find((o) => !o.value.includes("://") && !CONNINFO.test(o.value))?.value ??
    "";
  return {
    host: variable || service ? "unresolved" : hostClass(host, options.noHost),
    scratch: SCRATCH_DATABASE.test(name),
    noHostGiven: !variable && !service && (host === undefined || host === ""),
  };
}

/** Database client options that take the next word as their value. */
const DATABASE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-h",
  "-p",
  "-U",
  "-u",
  "-d",
  "-D",
  "-c",
  "-e",
  "-f",
  "-v",
  "-o",
  "-P",
  "-T",
  "-F",
  "-R",
  "-n",
  "-a",
  "--host",
  "--port",
  "--username",
  "--user",
  "--dbname",
  "--database",
  "--command",
  "--execute",
  "--file",
  "--set",
  "--variable",
  "--uri",
  "--eval",
]);

/** `kubectl` global options that take the next word as their value. */
const KUBECTL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-n",
  "--namespace",
  "--context",
  "--cluster",
  "--kubeconfig",
  "-s",
  "--server",
  "--user",
  "--token",
]);

/** Package runners a command-line tool is started through. */
const LAUNCHERS: ReadonlySet<string> = new Set(["npx", "pnpm", "yarn", "bunx", "bun"]);

/** The databases one simple command wipes, read from its words. */
function databaseTargets(
  words: readonly ShellWord[],
  scratchRoots: readonly string[],
  view: string,
  depth = 0,
): DatabaseTarget[] {
  const start = commandStart(words);
  let at = start.index;
  let program = words[at];
  if (program === undefined || depth > 3) return [];
  let name = programName(program);
  // `npx prisma …`, `pnpm exec prisma …`.
  if (LAUNCHERS.has(name)) {
    at += 1;
    while (
      words[at] !== undefined &&
      ["exec", "dlx", "run", "x"].includes((words[at] as ShellWord).value)
    )
      at += 1;
    program = words[at];
    if (program === undefined) return [];
    name = programName(program);
  }
  const args = words.slice(at + 1);
  const values = args.map((a) => a.value);
  // A command run on another machine is aimed at that machine's databases. One run in a local
  // container keeps whatever host it names itself, and with none names the container: local.
  const relay = (rest: readonly ShellWord[], host: "local" | "remote"): DatabaseTarget[] =>
    databaseTargets(rest, scratchRoots, view, depth + 1).map((t) =>
      host === "remote" ? { ...t, host } : t.noHostGiven === true ? { ...t, host: "local" } : t,
    );

  switch (name) {
    case "docker":
    case "podman": {
      // `docker exec [options] <container> <command…>`, `docker compose exec <service> …`.
      let k = values[0] === "compose" ? 1 : 0;
      if (values[k] !== "exec") return [];
      k += 1;
      while (k < args.length && (args[k] as ShellWord).value.startsWith("-")) {
        k += ["-e", "--env", "-u", "--user", "-w", "--workdir"].includes(
          (args[k] as ShellWord).value,
        )
          ? 2
          : 1;
      }
      return relay(args.slice(k + 1), "local");
    }
    case "kubectl": {
      // `kubectl -n prod --context x exec pod -- …`: the subcommand comes after the global
      // options, and the command after `--`.
      let k = 0;
      while (k < args.length && (args[k] as ShellWord).value.startsWith("-")) {
        k += KUBECTL_VALUE_OPTIONS.has((args[k] as ShellWord).value) ? 2 : 1;
      }
      const dash = values.indexOf("--");
      return values[k] === "exec" && dash > k ? relay(args.slice(dash + 1), "remote") : [];
    }
    case "ssh": {
      const rest = operands(args, new Set(["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D"]));
      const text = rest
        .slice(1)
        .map((w) => w.value)
        .join(" ");
      return shellCommands(text).flatMap((c) => relay(c.words, "remote"));
    }
    case "psql": {
      // The SQL given with `-c`, or else what the command reads in: a heredoc or a here-string.
      const sql = optionValue(args, "-c", "--command")?.value ?? view;
      return DESTRUCTIVE_SQL.test(sql)
        ? [
            serverOf(
              args,
              start.assignments,
              { host: ["-h", "--host"], name: ["-d", "--dbname"], noHost: "unresolved" },
              sql,
            ),
          ]
        : [];
    }
    case "dropdb":
      return [serverOf(args, start.assignments, { host: ["-h", "--host"], noHost: "unresolved" })];
    case "mysql":
    case "mariadb": {
      const sql = optionValue(args, "-e", "--execute")?.value ?? view;
      return DESTRUCTIVE_SQL.test(sql)
        ? [
            serverOf(
              args,
              start.assignments,
              { host: ["-h", "--host"], name: ["-D", "--database"], noHost: "unresolved" },
              sql,
            ),
          ]
        : [];
    }
    case "mysqladmin":
      return values.includes("drop")
        ? [serverOf(args, start.assignments, { host: ["-h", "--host"], noHost: "unresolved" })]
        : [];
    case "redis-cli":
      // redis-cli reads no config file for its server: with no host it is this machine.
      return values.some((v) => /^flush(?:all|db)$/i.test(v))
        ? [
            serverOf(args, start.assignments, {
              host: ["-h", undefined],
              name: ["-u", "--uri"],
              noHost: "local",
            }),
          ]
        : [];
    case "mongo":
    case "mongosh": {
      const script = optionValue(args, undefined, "--eval")?.value ?? "";
      return /dropDatabase\s*\(|\.drop\s*\(/.test(script)
        ? [
            serverOf(args, start.assignments, {
              host: [undefined, "--host"],
              noHost: "unresolved",
              positionalHost: true,
            }),
          ]
        : [];
    }
    case "sqlite3": {
      const [file, sql] = operands(args);
      if (file === undefined || !DESTRUCTIVE_SQL.test(sql?.value ?? view)) return [];
      return [
        {
          host: "local",
          scratch:
            file.value === ":memory:" ||
            isUnder(file.value, scratchRoots) ||
            SCRATCH_DATABASE.test(file.value.split(/[\\/]/).pop() ?? ""),
        },
      ];
    }
    case "prisma": {
      const reset =
        (values[0] === "migrate" && values[1] === "reset") ||
        (values[0] === "db" && values[1] === "push" && values.includes("--force-reset"));
      return reset ? [{ host: "unresolved", scratch: false }] : [];
    }
    case "rails":
    case "rake":
      return values.some((v) => /^db:(?:drop|reset|purge)(?::|$)/.test(v))
        ? [{ host: "unresolved", scratch: false }]
        : [];
    default:
      return [];
  }
}

/** The class of one database target. */
function databaseClass(target: DatabaseTarget): DatabaseClass {
  if (target.host === "remote") return "other";
  if (target.host === "unresolved") return "unresolved";
  return target.scratch ? "scratch" : "local";
}

/** Every database a text's commands wipe. */
function databaseDetector(scratchRoots: readonly string[]): Detector<DatabaseTarget> {
  return (text, cwd, home) => {
    const out: DatabaseTarget[] = [];
    walkCommands(text, cwd, home, (command) => {
      out.push(...databaseTargets(command.words, scratchRoots, text));
    });
    return out;
  };
}

/** A cheap test every destructive database command passes. */
const DATABASE_HINT =
  /drop|truncate|flush|migrate\s+reset|force-reset|db:(?:drop|reset|purge)|dropDatabase|\.drop\s*\(/i;

// ── The check ────────────────────────────────────────────────────────────────

/** What the destructive-commands check produced: its result, and the exact local commands. */
export interface DestructiveOutcome {
  readonly result: DestructiveCheck;
  readonly localFixes: readonly LocalFix[];
  /** Fixes that could not be made safe, each with its note. Counted in the facts. */
  readonly unsafeFixes: readonly UnsafeFix[];
}

/** Run the destructive-commands check. Never throws: what cannot be asked is counted. */
export async function checkDestructive(context: GitCheckContext): Promise<DestructiveOutcome> {
  const log = context.log;
  const fixes = new FixList("destructive");
  const rmCalls = judgeAll(log, /\brm\b/, rmTargets);
  const dbCalls = judgeAll(log, DATABASE_HINT, databaseDetector(context.scratchRoots));

  const rm = await checkRm(context, rmCalls, fixes);
  const dbClasses = Object.fromEntries(DATABASE_CLASSES.map((c) => [c, 0])) as Record<
    DatabaseClass,
    number
  >;
  for (const j of dbCalls) {
    for (const target of j.found) dbClasses[databaseClass(target)] += 1;
  }
  const databases: DatabaseFacts = { calls: tallyOf(dbCalls), classes: dbClasses };
  const facts: DestructiveFacts = {
    rm,
    databases,
    unsafeFixes: fixes.unsafe.length,
    hidingCalls: log.hiding.calls,
    hidingForms: [...log.hiding.forms],
  };

  const calls = new Set([...rmCalls, ...dbCalls].map((j) => j.call.id));
  const all = addTallies(rm.calls, databases.calls);
  const status = statusOf({
    sessions: log.sessions,
    act:
      rm.classes["home-or-above"] + rm.classes["unguarded-variable"] > 0 ||
      trackedMissing(facts) > 0,
    review:
      rm.classes.untracked + rm.classes.home + rm.classes.other > 0 ||
      databases.classes.other + databases.classes.unresolved > 0,
    // A target built from guarded variables names a folder this check cannot know.
    incomplete:
      rm.couldNotCheck + rm.classes["guarded-variable"] + all.unknown + log.hiding.calls > 0,
  });
  return {
    result: { status, matches: calls.size, facts },
    localFixes: fixes.made,
    unsafeFixes: fixes.unsafe,
  };
}

// ── The card ─────────────────────────────────────────────────────────────────

type T = SentenceTemplate<DestructiveFacts>;

/** Every call the card counts, by state. */
function allCalls(f: DestructiveFacts): RunTally {
  return addTallies(f.rm.calls, f.databases.calls);
}

/** The number of targets in a class. */
function n(f: DestructiveFacts, c: RmTargetClass): number {
  return f.rm.classes[c];
}

const HEADLINE: T = {
  id: "destructive.headline",
  render: (f) =>
    n(f, "unguarded-variable") > 0
      ? `${counted(n(f, "unguarded-variable"), "rm -rf target")} ${was(n(f, "unguarded-variable"))} built from a variable with no guard.`
      : undefined,
};

const CODEX: T = codexLimitedTemplate("destructive");

const CHIP: T = {
  id: "destructive.chip",
  render: (f) =>
    `${counted(n(f, "unguarded-variable"), "rm -rf target")} built from an unguarded variable`,
};

/** A class sentence. */
function classLine(c: RmTargetClass, what: (count: number) => string): T {
  return {
    id: `destructive.rm.${c}`,
    render: (f) => (n(f, c) > 0 ? `${counted(n(f, c), "target")} ${what(n(f, c))}` : undefined),
  };
}

const FOUND: readonly T[] = [
  {
    id: "destructive.rm",
    render: (f) =>
      f.rm.calls.ran > 0
        ? `${counted(f.rm.calls.ran, "rm -rf command")} ran, with ${counted(f.rm.targets, "target")}.`
        : undefined,
  },
  classLine(
    "home-or-above",
    (c) =>
      `${was(c)} the home folder itself, a folder that holds it, or the root, so everything in ${c === 1 ? "it" : "them"} was deleted.`,
  ),
  classLine(
    "unguarded-variable",
    (c) =>
      `${was(c)} built from a variable with no \${VAR:?} guard, so an empty value deletes from the wrong folder.`,
  ),
  classLine("scratch", (c) => `${was(c)} scratch, temp or build output.`),
  classLine("tracked", () => "held files git tracks."),
  classLine(
    "untracked",
    (c) =>
      `${was(c)} in a repo with nothing tracked under ${c === 1 ? "it" : "them"}, so git keeps no copy.`,
  ),
  classLine("home", (c) => `${was(c)} under the home folder, outside any repo.`),
  classLine("other", (c) => `${was(c)} outside the home folder and outside any repo.`),
  classLine(
    "guarded-variable",
    (c) =>
      `${was(c)} built from guarded variables, so ${c === 1 ? "its" : "their"} folder is not known.`,
  ),
  {
    id: "destructive.databases",
    render: (f) => {
      const c = f.databases.classes;
      const total = c.local + c.scratch + c.other + c.unresolved;
      if (total === 0) return undefined;
      const parts: string[] = [];
      if (c.other > 0) parts.push(`${c.other} on another machine`);
      if (c.unresolved > 0) parts.push(`${c.unresolved} whose host is set elsewhere`);
      if (c.local > 0) parts.push(`${c.local} local`);
      if (c.scratch > 0) parts.push(`${c.scratch} local scratch or test`);
      return `${counted(total, "database")} ${was(total)} dropped or wiped: ${parts.join(", ")}.`;
    },
  },
  {
    id: "destructive.mentioned",
    render: (f) => {
      const m = allCalls(f).mentioned;
      return m > 0
        ? `${counted(m, "match", "matches")} only mentioned a delete, and ${m === 1 ? "is" : "are"} not counted.`
        : undefined;
    },
  },
  {
    id: "destructive.unknown",
    render: (f) => {
      const u = allCalls(f).unknown;
      return u > 0 ? `${counted(u, "command")} could not be confirmed as run.` : undefined;
    },
  },
  {
    id: "destructive.none",
    render: (f) =>
      allCalls(f).ran === 0 && f.hidingCalls === 0
        ? "No rm -rf and no database wipe that this check could read ran."
        : undefined,
  },
];

const NOW: readonly T[] = [
  {
    id: "destructive.now.unsafe-fixes",
    render: (f) => unsafeFixLine(f.unsafeFixes),
  },
  {
    id: "destructive.now.tracked-gone",
    render: (f) =>
      f.rm.trackedGone > 0
        ? `${counted(f.rm.trackedGone, "tracked target")} ${is(f.rm.trackedGone)} still gone.`
        : undefined,
  },
  {
    id: "destructive.now.tracked-partly-back",
    render: (f) =>
      f.rm.trackedPartlyBack > 0
        ? `${counted(f.rm.trackedPartlyBack, "tracked target")} ${is(f.rm.trackedPartlyBack)} partly back, with tracked files still missing. No exact command is made for ${f.rm.trackedPartlyBack === 1 ? "it" : "them"}: restoring a whole target would overwrite any new changes in the files that are back.`
        : undefined,
  },
  {
    id: "destructive.now.tracked-back",
    render: (f) =>
      f.rm.trackedBack > 0
        ? `${counted(f.rm.trackedBack, "tracked target")} ${f.rm.trackedBack === 1 ? "has" : "have"} every tracked file back.`
        : undefined,
  },
  {
    id: "destructive.now.could-not-check",
    render: (f) =>
      f.rm.couldNotCheck > 0
        ? `${counted(f.rm.couldNotCheck, "target")} could not be checked on this machine.`
        : undefined,
  },
];

const FIX_STEPS: readonly T[] = [
  {
    id: "destructive.fix.restore",
    render: (f) =>
      f.rm.trackedGone > 0 ? "Restore each tracked target that is still wholly gone." : undefined,
  },
  {
    id: "destructive.fix.restore-partly",
    render: (f) =>
      f.rm.trackedPartlyBack > 0
        ? "Where a target is partly back, restore only the files still missing, one by one, after checking that none of them was deleted on purpose."
        : undefined,
  },
  {
    id: "destructive.fix.guard",
    render: (f) =>
      n(f, "unguarded-variable") > 0
        ? `Write a path built from a variable as \${VAR:?}/path, so an empty variable stops the command instead of deleting from the wrong folder.`
        : undefined,
  },
  {
    id: "destructive.fix.outside",
    render: (f) =>
      n(f, "untracked") + n(f, "home") + n(f, "other") > 0
        ? "Check that each folder deleted outside scratch and build output was meant to go. Git keeps no copy of untracked files."
        : undefined,
  },
  {
    id: "destructive.fix.databases",
    render: (f) =>
      f.databases.classes.other + f.databases.classes.unresolved > 0
        ? "Check that each database wiped on another machine, or whose host is set elsewhere, was meant to be."
        : undefined,
  },
];

/** The redacted fix shapes for what was found. */
function fixShapes(f: DestructiveFacts): FixShape[] {
  const out: FixShape[] = [];
  if (f.rm.trackedGone > 0) out.push({ shape: "git --literal-pathspecs restore -- <path>" });
  return out;
}

/** The destructive-commands card. */
export const destructiveCard: ToCard<"destructive"> = (result, context: CardContext): CardView => {
  const f = result.facts;
  const headline = sentence(HEADLINE, f);
  const extras = cardExtras(
    { count: n(f, "unguarded-variable"), label: sentence(CHIP, f) },
    sentences(FIX_STEPS, f),
  );
  return {
    ...extras,
    category: "destructive",
    tone: result.status,
    count: result.matches,
    found: [...sentences(FOUND, f), ...codexLines(CODEX, context, f)],
    now: sentences(NOW, f),
    fixes: fixShapes(f),
    codexCaveat: codexCaveat(context, allCalls(f).ran),
    ...(headline === undefined
      ? {}
      : {
          headline: {
            basis: "unguarded-recursive-deletes",
            count: n(f, "unguarded-variable"),
            restsOnCodexRan: context.ranEvidence === "output-record",
            sentence: headline,
          },
        }),
  };
};

/**
 * The templates, for a test that every card line comes from one. Only a test reads it, so it is
 * marked pure and left out of the bundles.
 */
export const DESTRUCTIVE_TEMPLATES: readonly T[] = /* @__PURE__ */ (() => [
  HEADLINE,
  CHIP,
  ...FOUND,
  CODEX,
  ...NOW,
  ...FIX_STEPS,
])();
