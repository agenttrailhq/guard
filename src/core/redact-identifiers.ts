// cspell:words acmecorp betaholdings clientco clientdb createdb dbname dropdb flyctl
// cspell:words mongosh mysqladmin mysqldump nerdctl podman rmi sftp unpause
/**
 * `redactIdentifiers` — identifying NAMES that are not path-shaped, out of anything
 * `scan` displays or writes.
 *
 * ── The order, and why it is load-bearing ────────────────────────────────────
 * Three passes compose at one call site (`core/scan-report.ts`), in exactly this order:
 *
 *     redactIdentifiers(redactPaths(scrubText(text).text))
 *
 * `scrubText` FIRST — it matches VALUE SHAPES (a key looks like a key), and a token
 * replaced before it runs would hide a secret embedded in that token and under-report
 * the tally. `redactPaths` SECOND — it matches STRUCTURE (a token is a path, or it is
 * not). `redactIdentifiers` LAST — it matches POSITION within a known command, so it
 * must operate on a string whose paths are already `<path>`: run any earlier and
 * `docker run … ghcr.io/clientco/internal` offers it a path in an image-name position
 * and it would mistake one for the other. Running last also means every one of its
 * inputs is either the user's own text or a placeholder it can recognize and leave
 * alone, which is what makes it idempotent.
 *
 * ── Why it is a THIRD module and not a fifteenth scrubbing pattern ───────────
 * `core/scrub.ts` holds the standard secret patterns and nothing guard-specific, so
 * guard-only redaction COMPOSES at the call site, as `redact-path.ts` does. It is not
 * folded into `redact-path.ts` either: that module is one clean structural test and
 * should stay one.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * `redactPaths` is structural: a token is a path if it carries a separator. These
 * survive both earlier passes verbatim, and each can carry an employer's or a
 * client's name:
 *
 *     docker exec acme-prod-db psql -U app        container name
 *     docker logs -f betaholdings_api_1           compose project name
 *     docker network create acme_internal         network name
 *     docker volume rm acmecorp_pgdata            volume name
 *     docker ps --filter name=acme                filter value
 *     kubectl -n acme-prod get pods               namespace
 *     psql -h acme-prod.internal -d clientdb      internal hostname, database name
 *     ssh deploy@acme-prod-01                     host and login
 *     git commit -m 'fix billing for AcmeCorp'    free-text commit message
 *
 * Neither earlier pass is looking for them: one matches value shapes and the other
 * matches path structure, and a container name is neither.
 *
 * ── IT IS A DENY-LIST, AND IT HAS A DENY-LIST'S FAILURE MODE ────────────────
 * **It misses the command nobody thought of.** Everything below is per-command
 * knowledge: a word has to be in {@link COMMANDS} before any rule looks at its
 * operands, so a tool that is not on that list passes through completely untouched. The
 * list does not cover `helm`, `oc`, `aws`, `gcloud`, `az`, `terraform`, `flyctl`,
 * `heroku`, `systemctl`, `pm2`, or the next tool somebody installs. The report's own
 * copy says so, and it is why `scan --review` exists: a bounded human review is the only
 * thing that catches the shape a deny-list has never seen.
 *
 * Three narrower residuals, named for the same reason. A value's left-hand side is kept
 * (`--label com.acme.owner=<name>`). The remote command in `ssh <host> '…'` is left
 * intact. And **a command NESTED INSIDE a quoted argument is not looked at** — the whole
 * quoted region is one word here, so `bash -c "docker exec acme-db psql"` keeps its
 * container name. Recursing into quoted regions is deliberately NOT done: it would start
 * reading ordinary prose (`echo 'we should docker exec into the box'`) as a command.
 *
 * ── Allow-list INSIDE each deny-listed command ───────────────────────────────
 * Within a command it knows, the posture inverts, for the reason `redact-path.ts` gives
 * for taking the same line: a shape nobody thought of defaults to redacted rather than
 * shared. For the container family every operand is replaced UNLESS it is one of the
 * subcommand keywords in {@link CONTAINER_KEYWORDS} — so `docker volume rm <name>`
 * needs no per-subcommand arity table and a subcommand added by a future Docker release
 * over-redacts instead of leaking.
 *
 * ── It keeps enough of the command to be worth reading ───────────────────────
 * `redact-path.test.ts` draws this line and it holds here: the point is a readable
 * SHAPE, not a blanked line. `docker exec <name> psql -U app` still says what happened,
 * and — as with `<path>` — collapsing many distinct container names into one
 * placeholder is also what makes the repeat counting mean anything. Four different
 * container names in one `docker exec … psql` shape are one recurring mistake seen four
 * times, not four singletons and no finding at all.
 *
 * ── It never touches a placeholder ───────────────────────────────────────────
 * A word containing `<…>` or `[REDACTED:` is left exactly as it is. That is what makes
 * this pass idempotent, and it is what stops `-e FOO=<path>` from having its one marker
 * overwritten by `<name>`.
 */

import { REDACTION_PREFIX } from "./redaction.js";

/** A container, volume, network, namespace, database or other author-chosen name. */
export const NAME_PLACEHOLDER = "<name>";
/** A host or host-like value. */
export const HOST_PLACEHOLDER = "<host>";
/** A login name. */
export const USER_PLACEHOLDER = "<user>";
/** Free text a human wrote — a commit or tag message. */
export const MESSAGE_PLACEHOLDER = "<message>";

/** Which rule set a command word turns on. */
type Family = "container" | "kube" | "db" | "ssh" | "git";

/**
 * The commands whose operands are inspected at all. Everything else is untouched.
 *
 * This map IS the deny-list named in the header. Adding a row is the whole cost of
 * covering a new tool; forgetting one is the whole failure mode.
 */
const COMMANDS: ReadonlyMap<string, Family> = new Map<string, Family>([
  ["docker", "container"],
  ["podman", "container"],
  ["docker-compose", "container"],
  ["podman-compose", "container"],
  ["nerdctl", "container"],
  ["kubectl", "kube"],
  ["psql", "db"],
  ["pg_dump", "db"],
  ["pg_restore", "db"],
  ["pg_isready", "db"],
  ["createdb", "db"],
  ["dropdb", "db"],
  ["mysql", "db"],
  ["mysqladmin", "db"],
  ["mysqldump", "db"],
  ["redis-cli", "db"],
  ["mongo", "db"],
  ["mongosh", "db"],
  ["ssh", "ssh"],
  ["scp", "ssh"],
  ["sftp", "ssh"],
  ["git", "git"],
]);

/**
 * Docker / Podman / Compose subcommand and object words.
 *
 * Recognized ANYWHERE in the command, not only before the first operand: `docker
 * compose -f <name> up <name>` puts a value between `compose` and `up`, and a
 * position-sensitive reading would blank the verb. The cost is that a container
 * literally named `run` survives — a generic word that identifies nobody, which is the
 * cheap side of the trade.
 */
const CONTAINER_KEYWORDS: ReadonlySet<string> = new Set([
  "attach",
  "build",
  "builder",
  "buildx",
  "checkpoint",
  "commit",
  "compose",
  "config",
  "container",
  "context",
  "convert",
  "cp",
  "create",
  "diff",
  "down",
  "events",
  "exec",
  "export",
  "image",
  "images",
  "import",
  "info",
  "init",
  "inspect",
  "kill",
  "list",
  "load",
  "login",
  "logout",
  "logs",
  "ls",
  "manifest",
  "network",
  "node",
  "pause",
  "plugin",
  "port",
  "prune",
  "ps",
  "pull",
  "push",
  "rename",
  "restart",
  "rm",
  "rmi",
  "run",
  "save",
  "scan",
  "search",
  "secret",
  "service",
  "stack",
  "start",
  "stats",
  "stop",
  "swarm",
  "system",
  "tag",
  "top",
  "trust",
  "unpause",
  "up",
  "update",
  "version",
  "volume",
  "wait",
  "watch",
]);

/**
 * Container subcommands after whose first operand the rest is somebody ELSE's command.
 *
 * `docker exec acme-db psql -U app` runs `psql -U app` INSIDE the container, and
 * blanking it would throw away the part of the finding worth reading. So the first
 * operand is redacted and the pass stands down until the next command word — which is
 * usually the inner command itself, and `psql` is on the list above, so its own `-h`
 * still gets caught.
 */
const CONTAINER_INNER_COMMAND = new Set(["exec", "run"]);

/** `kubectl` flags whose value names a namespace. */
const KUBE_NAME_FLAGS = new Set(["-n", "--namespace"]);

/** Database-client flags whose value is a host. */
const DB_HOST_FLAGS = new Set(["-h", "--host"]);

/**
 * Database-client flags whose value is a database name.
 *
 * Scoped to the clients in {@link COMMANDS} and to those alone, which is what makes
 * `-d` safe to look at: it means "database" for `psql` and means something else in
 * `ls`, `sort`, `patch` and `uniq`, none of which this pass ever inspects.
 */
const DB_NAME_FLAGS = new Set(["-d", "-D", "--dbname", "--database"]);

/**
 * `ssh`-family flags that CONSUME the next word.
 *
 * Listed so a value is not mistaken for the destination: without it, `ssh -p 22 host`
 * reads `22` as the host and stands down before reaching the real one. Their values are
 * kept except where noted in {@link SSH_VALUE_KIND}.
 */
const SSH_VALUE_FLAGS = new Set([
  "-B",
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
  "-P",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

/** The `ssh`-family value flags whose value is itself identifying. */
const SSH_VALUE_KIND: ReadonlyMap<string, string> = new Map([
  ["-l", USER_PLACEHOLDER],
  ["-J", HOST_PLACEHOLDER],
]);

/**
 * `git` flags that CONSUME the next word, before any subcommand is reached.
 *
 * `git -C build commit -m 'fix billing for AcmeCorp'` is the case: without this `build`
 * reads as the subcommand, `commit` never registers, and the message survives. That is
 * not a corner — it is how every scripted `git` call in this repository is written.
 */
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path"]);

/**
 * `git` subcommands where `-m` is a MESSAGE.
 *
 * Scoped, because `git log -m` is a boolean and eating the word after it would redact
 * a revision. This is the same per-command discipline as `DB_NAME_FLAGS`, one level
 * further down.
 */
const GIT_MESSAGE_SUBCOMMANDS = new Set([
  "am",
  "cherry-pick",
  "commit",
  "merge",
  "notes",
  "revert",
  "stash",
  "tag",
]);

/** `-m`, `--message`, and short-flag clusters ending in `m` such as `-am`. */
const GIT_MESSAGE_FLAG = /^(?:-[A-Za-z]*m|--message)$/;

/** A `--flag=value` or `KEY=value` word, split at the FIRST `=`. */
const ASSIGNMENT = /^([^=]+)=(.+)$/;

/** A `user@host` word. Split on the LAST `@`, the way a login string is read. */
const USER_AT_HOST = /^([^@\s]+)@([^@\s]+)$/;

/** Characters that end one command and start another. */
const BREAK_CHARS = new Set(["&", "|", ";", "(", ")"]);

/** Whitespace outside a quoted region — the word boundary. */
const SPACE = /\s/;

/**
 * Is this word already redacted, in whole or in part?
 *
 * Matches this module's own output, `redactPaths`'s `<path>`, and any `scrubText`
 * placeholder. Nothing that matches is ever modified, which is what makes the pass
 * idempotent and what stops it from overwriting a marker that tells a reader a secret
 * was removed.
 */
function isRedactedWord(word: string): boolean {
  return /<[a-z]+>/.test(word) || word.includes(REDACTION_PREFIX);
}

/** One whitespace-delimited word, with where it sits in the original string. */
interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A word, or the boundary between two commands. */
type Piece = { readonly kind: "word"; readonly word: Word } | { readonly kind: "break" };

/**
 * Split a command into words and command boundaries, quote-aware.
 *
 * A quoted region is folded into the surrounding word, so `git commit -m 'fix billing
 * for AcmeCorp'` is three words and not six, and so an operator character INSIDE a
 * message cannot fake a boundary. An UNTERMINATED quote is treated as an ordinary
 * character rather than swallowing the rest of the string: a runaway quote would bury
 * every later command word in one giant token, and a command word this pass cannot see
 * is a command word it cannot redact.
 *
 * A newline is a boundary as well as whitespace. `redactForReport` runs BEFORE
 * `flatten`, so a `&&`-chained or heredoc command still has its real line structure
 * here, and without this the first word of line two would read as an operand of line
 * one.
 */
function tokenize(text: string): Piece[] {
  const pieces: Piece[] = [];
  let start = -1;
  let i = 0;

  const flush = (end: number): void => {
    if (start >= 0)
      pieces.push({ kind: "word", word: { text: text.slice(start, end), start, end } });
    start = -1;
  };

  while (i < text.length) {
    const ch = text[i] as string;

    if (SPACE.test(ch)) {
      flush(i);
      if (ch === "\n") pieces.push({ kind: "break" });
      i++;
      continue;
    }

    if (BREAK_CHARS.has(ch)) {
      flush(i);
      pieces.push({ kind: "break" });
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      if (close !== -1) {
        if (start < 0) start = i;
        i = close + 1;
        continue;
      }
    }

    if (start < 0) start = i;
    i++;
  }

  flush(text.length);
  return pieces;
}

/**
 * Replace a word's value with `placeholder`, keeping its quotes if it had any.
 *
 * `redactPaths` renders a collapsed quoted region as `"<path>"`, and matching that here
 * means the report has one redaction vocabulary rather than two spellings of it.
 */
function replaceValue(word: string, placeholder: string): string {
  const quote = word[0];
  if ((quote === "'" || quote === '"') && word.length >= 2 && word.endsWith(quote)) {
    return `${quote}${placeholder}${quote}`;
  }
  return placeholder;
}

/** A pending replacement of the NEXT word, set by a flag that takes a value. */
interface Pending {
  /** The placeholder to write, or `undefined` to consume the value and keep it. */
  readonly placeholder: string | undefined;
}

/** Mutable per-command state. Reset at every boundary and at every new command word. */
interface State {
  family: Family | undefined;
  /** The command word itself — `scp` behaves differently from its two siblings. */
  command: string | undefined;
  /** The container subcommand chain has reached `exec`/`run`. */
  innerCommand: boolean;
  /** An operand has been redacted and the rest belongs to the inner command. */
  stopped: boolean;
  /** The `git` subcommand, once seen. */
  gitSubcommand: string | undefined;
  /** The `ssh` destination has been seen; the rest is the remote command. */
  sshDestinationSeen: boolean;
  pending: Pending | undefined;
}

function freshState(family: Family | undefined, command?: string): State {
  return {
    family,
    command,
    innerCommand: false,
    stopped: false,
    gitSubcommand: undefined,
    sshDestinationSeen: false,
    pending: undefined,
  };
}

/**
 * Decide the replacement for one word, advancing `state`.
 *
 * Returns the replacement text, or `undefined` to keep the word as it is. Every branch
 * is per-family; a word reaching here with no family set is kept.
 */
function classify(word: string, state: State): string | undefined {
  const family = state.family;
  if (family === undefined) return undefined;
  const isFlag = word.startsWith("-");

  switch (family) {
    case "container": {
      if (state.stopped) return undefined;
      const assignment = ASSIGNMENT.exec(word);
      if (assignment !== null) {
        // `--name=acme`, `--filter name=acme`, `-e FOO=bar`. The key is kept because it
        // is usually a flag name and always more readable than a bare placeholder; the
        // residual is a key that itself carries a name, which the header states.
        return `${assignment[1]}=${NAME_PLACEHOLDER}`;
      }
      if (isFlag) return undefined;
      if (CONTAINER_KEYWORDS.has(word)) {
        if (CONTAINER_INNER_COMMAND.has(word)) state.innerCommand = true;
        return undefined;
      }
      if (state.innerCommand) state.stopped = true;
      return replaceValue(word, NAME_PLACEHOLDER);
    }

    case "kube": {
      const assignment = ASSIGNMENT.exec(word);
      if (assignment !== null && KUBE_NAME_FLAGS.has(assignment[1] as string)) {
        return `${assignment[1]}=${NAME_PLACEHOLDER}`;
      }
      if (KUBE_NAME_FLAGS.has(word)) state.pending = { placeholder: NAME_PLACEHOLDER };
      return undefined;
    }

    case "db": {
      const assignment = ASSIGNMENT.exec(word);
      if (assignment !== null) {
        const flag = assignment[1] as string;
        if (DB_HOST_FLAGS.has(flag)) return `${flag}=${HOST_PLACEHOLDER}`;
        if (DB_NAME_FLAGS.has(flag)) return `${flag}=${NAME_PLACEHOLDER}`;
        return undefined;
      }
      if (DB_HOST_FLAGS.has(word)) state.pending = { placeholder: HOST_PLACEHOLDER };
      else if (DB_NAME_FLAGS.has(word)) state.pending = { placeholder: NAME_PLACEHOLDER };
      return undefined;
    }

    case "ssh": {
      if (isFlag) {
        if (SSH_VALUE_FLAGS.has(word)) {
          state.pending = { placeholder: SSH_VALUE_KIND.get(word) };
        }
        return undefined;
      }
      const login = USER_AT_HOST.exec(word);
      if (login !== null) {
        state.sshDestinationSeen = true;
        return `${USER_PLACEHOLDER}@${HOST_PLACEHOLDER}`;
      }
      if (state.sshDestinationSeen) return undefined;
      // The first bare operand of `ssh`/`sftp` is the destination. `scp` is EXCLUDED:
      // its operands are files, and a bare `notes.md` is not a host. A remote `scp`
      // target carries `@` and is caught above, or carries `/` and is already `<path>`.
      if (state.command === "scp") return undefined;
      state.sshDestinationSeen = true;
      return replaceValue(word, HOST_PLACEHOLDER);
    }

    case "git": {
      const assignment = ASSIGNMENT.exec(word);
      const messageSubcommand =
        state.gitSubcommand !== undefined && GIT_MESSAGE_SUBCOMMANDS.has(state.gitSubcommand);
      if (assignment !== null) {
        if (messageSubcommand && assignment[1] === "--message") {
          return `--message=${MESSAGE_PLACEHOLDER}`;
        }
        return undefined;
      }
      if (isFlag) {
        if (messageSubcommand && GIT_MESSAGE_FLAG.test(word)) {
          state.pending = { placeholder: MESSAGE_PLACEHOLDER };
        } else if (GIT_VALUE_FLAGS.has(word)) {
          state.pending = { placeholder: undefined };
        }
        return undefined;
      }
      // A placeholder is never the subcommand: `git -C <path> commit -m …` must still
      // reach `commit`, or the message it was about to redact survives.
      if (!isRedactedWord(word)) state.gitSubcommand ??= word;
      return undefined;
    }
  }
}

/**
 * Replace identifying operands of known commands in `text`.
 *
 * Pure, total and idempotent. Compose it LAST — after `scrubText` and `redactPaths` —
 * for the reasons in the module header.
 */
export function redactIdentifiers(text: string): string {
  if (text.length === 0) return text;

  const pieces = tokenize(text);
  const edits: { start: number; end: number; text: string }[] = [];
  let state = freshState(undefined);

  for (const piece of pieces) {
    if (piece.kind === "break") {
      state = freshState(undefined);
      continue;
    }

    const { text: word, start, end } = piece.word;

    // A pending value is consumed even when it is a placeholder or another flag, so
    // the slot is closed either way. A word starting with `-` is NOT eaten: a flag
    // following a value flag means the value was omitted, and swallowing it would
    // redact the wrong thing.
    const pending = state.pending;
    state.pending = undefined;
    if (pending !== undefined && !word.startsWith("-")) {
      if (pending.placeholder !== undefined && !isRedactedWord(word)) {
        edits.push({ start, end, text: replaceValue(word, pending.placeholder) });
      }
      continue;
    }

    // A known command word re-arms the state wherever it appears — after `sudo`, after
    // `time`, after a missed boundary, or as the inner command of `docker exec`. The
    // cost is that `echo docker ps -a` is read as a docker call, which over-redacts.
    const family = COMMANDS.get(word);
    if (family !== undefined) {
      state = freshState(family, word);
      continue;
    }

    if (isRedactedWord(word)) {
      // Not modified — but it still OCCUPIES its position, so `docker exec <name> psql`
      // does not promote `psql` into the operand slot on a second pass.
      classify(word, state);
      continue;
    }

    const replacement = classify(word, state);
    if (replacement !== undefined && replacement !== word) {
      edits.push({ start, end, text: replacement });
    }
  }

  if (edits.length === 0) return text;

  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}
