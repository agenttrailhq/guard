// cspell:words acmecorp betaholdings clientco clientdb createdb dbname dropdb flyctl
// cspell:words mongosh mysqladmin mysqldump nerdctl podman rmi sftp unpause
// cspell:words apikey passwd pwd autoscale svc configmap configmaps daemonset
// cspell:words statefulset replicaset serviceaccount rolebinding clusterrole
// cspell:words clusterrolebinding cronjob namespaces endpoints pvc hpa crd
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
 *     git config user.name 'Priya at AcmeCorp'    commit identity
 *     op item get acme-stripe-live-key            password-manager item name
 *     gh pr create --title '[ACME-12] billing'    pull-request title and body
 *     setup --org 123e4567-e89b-42d3-a456-…       an account or record UUID
 *     git commit -F - <<'EOF' … EOF               a heredoc body — free text
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
 * over-redacts instead of leaking. The `kube` family takes the same line against
 * {@link KUBE_KEYWORDS}, so a resource NAME (`get pods <name>`, `exec <name>`) goes and
 * not only the `-n` namespace. The `db` family redacts the SQL statement handed to
 * `-c`/`-e` ({@link DB_SQL_FLAGS}) whole, rather than parsing table names out of it. The
 * `op` family keeps {@link OP_KEYWORDS} and redacts every other operand, so an item id
 * or a vault name goes; the `gh` family redacts only titles, bodies and notes.
 *
 * ── Four passes that are NOT keyed to a command at all ───────────────────────
 * A secret handed as a flag value ({@link SECRET_FLAG} — `--token abc`, `--password x`)
 * leaks the same on a tool the deny-list has never heard of, so it is redacted wherever
 * it appears, before any family is considered. `scrubText` cannot: it anchors to an
 * `=`/`:` assignment, and a space-separated flag value is neither. Likewise a `#`
 * comment is free text a human wrote — a branch, a host, a note — and is collapsed to
 * `#<comment>` in any command. A heredoc body ({@link redactHeredocBodies}) is free text of
 * the same kind — a commit message, a pull-request body, a note — and becomes one
 * `<message>` line between its delimiters. A UUID ({@link UUID}) names an account, an
 * organization or a record in whatever command carries it, and becomes `<name>`; so does
 * the value of a 1Password setting passed as an environment variable (`OP_ACCOUNT=…`).
 *
 * A value slot that is redacted WHOLE — a commit message, a SQL statement, a title — is
 * redacted even when an earlier pass already replaced part of it: a message whose only
 * scrubbed part was the co-author's email still carried the issue number and the author, so
 * such a slot is kept only when it is already nothing but a placeholder.
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
 * overwritten by `<name>`. The one exception is a value slot redacted whole (above): there
 * a word is kept only when it is NOTHING BUT a placeholder, which is still idempotent.
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
/** The body of a shell comment (`# …`) — free text a human wrote in any command. */
export const COMMENT_PLACEHOLDER = "<comment>";

/**
 * A secret carried as a flag's value in ANY command, redacted for the report.
 *
 * It reuses `scrubText`'s `[REDACTED:…]` vocabulary — the report's legend already
 * explains that marker as a redacted secret — so a bare-argument secret reads the same
 * as a shape-matched one. `isRedactedWord` recognizes it, keeping the pass idempotent.
 */
const SECRET_ARG_PLACEHOLDER = `${REDACTION_PREFIX}secret:arg]`;

/**
 * A flag whose value is a secret, whatever command it appears in.
 *
 * `scrubText` catches a secret by SHAPE and anchors to an `=`/`:` assignment; a value
 * handed as the next word (`--token abc123`) is neither, so it survives to here. This is
 * command-INDEPENDENT — a secret flag leaks the same on a tool the deny-list has never
 * heard of — so it is matched in the main loop before any family is considered.
 *
 * The names covered are the ones that imply a credential (`--password`, `--api-key`,
 * `--auth-token`, `--client-secret`, …) plus the two short generic ones people actually
 * type for a secret (`--key`, `--pass`, `--pwd`). It does NOT match `--namespace`,
 * `--dbname`, `--message` or `--name`: none of those contain a secret word.
 */
const SECRET_FLAG =
  /^--(?:[a-z0-9-]*(?:password|passwd|secret|token|api-?key|apikey|access-?key|access-?token|auth-?token|credentials?)[a-z0-9-]*|key|pass|pwd)$/i;

/**
 * A UUID, anywhere in a word — an account, organization or record id.
 *
 * Global and case-insensitive; applied to whatever part of a word the family rules kept,
 * so `--org=<uuid>` becomes `--org=<name>` and a UUID inside JSON loses only the UUID.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A heredoc operator: `<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`, and the tab-stripping
 * `<<-WORD`. Not `<<<`, which is a here-string with no body. The delimiter must start
 * with a letter or `_`, so an arithmetic shift such as `$((1 << 2))` is not read as one.
 */
const HEREDOC_OPERATOR = /(?<!<)<<(?!<)(-?)[ \t]*\\?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

/** Which rule set a command word turns on. */
type Family = "container" | "kube" | "db" | "ssh" | "git" | "op" | "gh";

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
  ["op", "op"],
  ["gh", "gh"],
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

/**
 * `kubectl` verbs and resource-type words — the allow-list INSIDE the command.
 *
 * The posture the container family takes, applied to `kubectl`: a bare operand that is
 * not one of these is a resource NAME, a context name, or a namespace given positionally
 * — all identifying — and is redacted. So `kubectl get pods acme-web-7` keeps `get pods`
 * and blanks `acme-web-7`, and `kubectl exec acme-web-7 -- sh` blanks the name too. The
 * cost is over-redaction of an alias not listed here (a rare resource type collapses to
 * `<name>`), which is the safe direction for a shared file. It is not exhaustive by
 * design — a shape nobody thought of defaults to redacted rather than shared.
 */
const KUBE_KEYWORDS: ReadonlySet<string> = new Set([
  // verbs
  "annotate",
  "api-resources",
  "api-versions",
  "apply",
  "attach",
  "auth",
  "autoscale",
  "cluster-info",
  "completion",
  "config",
  "cordon",
  "cp",
  "create",
  "delete",
  "describe",
  "diff",
  "drain",
  "edit",
  "exec",
  "explain",
  "expose",
  "get",
  "help",
  "label",
  "logs",
  "patch",
  "port-forward",
  "proxy",
  "replace",
  "rollout",
  "run",
  "scale",
  "set",
  "top",
  "version",
  "wait",
  // resource types
  "all",
  "clusterrole",
  "clusterrolebinding",
  "configmap",
  "configmaps",
  "context",
  "contexts",
  "cronjob",
  "crd",
  "daemonset",
  "deploy",
  "deployment",
  "deployments",
  "endpoints",
  "event",
  "events",
  "hpa",
  "ingress",
  "job",
  "jobs",
  "namespace",
  "namespaces",
  "node",
  "nodes",
  "ns",
  "pod",
  "pods",
  "pv",
  "pvc",
  "replicaset",
  "role",
  "rolebinding",
  "secret",
  "secrets",
  "service",
  "serviceaccount",
  "services",
  "statefulset",
  "svc",
]);

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
 * Database-client flags whose value is a SQL statement.
 *
 * The statement is redacted WHOLE (`psql -c 'SELECT … FROM customers'` → `psql -c
 * <name>`) rather than parsed: pulling the table and column names out of arbitrary SQL
 * is a parser this report does not need, and a WHERE clause carries values as
 * identifying as any table name. Blanking the statement is the safe direction, and the
 * rule id beside it still says what fired. Scoped to the clients in {@link COMMANDS},
 * which is what makes `-c`/`-e` safe to read as "the SQL" here and nowhere else.
 */
const DB_SQL_FLAGS = new Set(["-c", "--command", "-e", "--execute", "--eval"]);

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

/**
 * `git config` keys whose value is the committer's identity. Read both as the operand
 * after `git config` and as the `key=value` given to `git -c`.
 */
const GIT_IDENTITY_KEYS = new Set(["user.name", "user.email"]);

/**
 * 1Password CLI (`op`) subcommand and object words — the allow-list INSIDE the command.
 *
 * The container posture again: any other bare operand is an item, vault, document,
 *     op item get acme-stripe-live-key            password-manager item name
 * keeps `item get` and loses the id. A reference given as `op://vault/item` is already
 * `<path>` by the time this pass runs.
 */
const OP_KEYWORDS: ReadonlySet<string> = new Set([
  "account",
  "add",
  "completion",
  "confirm",
  "connect",
  "create",
  "delete",
  "document",
  "edit",
  "events-api",
  "forget",
  "get",
  "grant",
  "group",
  "inject",
  "item",
  "list",
  "ls",
  "move",
  "plugin",
  "provision",
  "reactivate",
  "read",
  "remove",
  "revoke",
  "rm",
  "run",
  "server",
  "service-account",
  "share",
  "signin",
  "signout",
  "suspend",
  "template",
  "token",
  "update",
  "user",
  "vault",
  "whoami",
]);

/** `op` flags whose value names a vault or account. */
const OP_NAME_FLAGS = new Set(["--vault", "--account"]);

/**
 * `op` flags whose value is kept: field labels and output formats say what was read,
 * not whose. Listed so the value is consumed rather than taken for an item name.
 */
const OP_KEPT_VALUE_FLAGS = new Set(["--fields", "--field", "--format"]);

/**
 * GitHub CLI (`gh`) flags whose value is free text a human or an agent wrote — a pull
 * request, issue or release title, body or notes. Everything else `gh` takes is kept: a
 * PR number identifies nobody, and an `owner/repo` is already `<path>`.
 */
const GH_MESSAGE_FLAGS = new Set(["--title", "-t", "--body", "-b", "--notes"]);

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

/**
 * Is this word NOTHING BUT one placeholder, optionally quoted?
 *
 * Narrower than {@link isRedactedWord}, for a value slot that is redacted whole (a commit
 * message, a SQL statement, a title). There, a word that merely CONTAINS a placeholder
 * still carries everything around it — a message whose only scrubbed part is the
 * co-author's email still names the issue — so only a value that is already a bare
 * placeholder is left as it is.
 */
function isPlaceholderOnly(word: string): boolean {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(word);
  const inner = quoted === null ? word : (quoted[2] as string);
  return /^(?:<[a-z]+>|\[REDACTED:[^\]]*\])$/.test(inner);
}

/**
 * A 1Password CLI setting passed through the environment (`OP_ACCOUNT=…`, `OP_VAULT=…`):
 * the value names an account, a vault or a server. A token-shaped one is a secret and
 * `scrubText` has already replaced it, which this leaves alone.
 */
const OP_ENV_ASSIGNMENT = /^(OP_[A-Z0-9_]+)=(.+)$/;

/** One whitespace-delimited word, with where it sits in the original string. */
interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A word, a command boundary, or a shell comment run (`#` to end of line). */
type Piece =
  | { readonly kind: "word"; readonly word: Word }
  | { readonly kind: "break" }
  | { readonly kind: "comment"; readonly start: number; readonly end: number };

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

    if (ch === "#" && start < 0) {
      // A `#` at a word boundary begins a shell comment that runs to end of line — free
      // text a human wrote, which can name a branch, a host or a client. Mid-word
      // (`foo#bar`) a `#` is an ordinary character, so this fires only when no word is
      // open. The trailing newline is left for the SPACE branch to emit as a boundary.
      const newline = text.indexOf("\n", i);
      const commentEnd = newline === -1 ? text.length : newline;
      pieces.push({ kind: "comment", start: i, end: commentEnd });
      i = commentEnd;
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
  /**
   * For a value that is kept, an optional narrower rewrite of it — `git -c`'s
   * `user.name=…` is the case: the value is kept unless it is an identity key.
   */
  readonly rewrite?: (word: string) => string | undefined;
}

/** `user.name=…` / `user.email=…` as handed to `git -c`, with the value redacted. */
function gitIdentityPair(word: string): string | undefined {
  const pair = ASSIGNMENT.exec(word);
  if (pair === null) return undefined;
  const key = pair[1] as string;
  return GIT_IDENTITY_KEYS.has(key) ? `${key}=${USER_PLACEHOLDER}` : undefined;
}

/** Replace every UUID in a word with `<name>`, leaving the rest of the word as it is. */
function withoutIds(word: string): string {
  return word.replace(UUID, NAME_PLACEHOLDER);
}

/**
 * Collapse each heredoc body to one `<message>` line, keeping the operator and the
 * delimiter so the shape still reads as a heredoc.
 *
 * Runs on the raw, multi-line text before tokenizing. The body starts on the line after
 * the operator and ends at the first line whose trimmed text is the delimiter — trimmed,
 * because agents routinely indent a terminator inside `"$(cat <<'EOF' … EOF)"`. A heredoc
 * whose terminator is not found runs to the end of the text, as the shell reads one — and
 * it is the common case, not a corner: the engine keeps only the first `MAX_DETAIL_LEN`
 * characters of a shell command, so a long body loses its terminator before it gets here.
 * A one-line command has no body to redact, so `echo "use << EOF"` is untouched; a
 * multi-line one with such a string over-redacts, which is the safe direction. Several
 * heredoc operators on one line are read in order, as the shell reads them.
 */
export function redactHeredocBodies(text: string): string {
  if (!text.includes("<<")) return text;
  const edits: { start: number; end: number }[] = [];
  let lineStart = 0;

  while (lineStart < text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) break;
    const operators = [...text.slice(lineStart, lineEnd).matchAll(HEREDOC_OPERATOR)];
    let next = lineEnd + 1;

    for (const operator of operators) {
      const stripTabs = operator[1] === "-";
      const delimiter = operator[3] as string;
      let at = next;
      let terminator = -1;
      let terminatorEnd = -1;
      while (at <= text.length) {
        const newline = text.indexOf("\n", at);
        const end = newline === -1 ? text.length : newline;
        const line = text.slice(at, end);
        if ((stripTabs ? line.replace(/^\t+/, "") : line).trim() === delimiter) {
          terminator = at;
          terminatorEnd = end;
          break;
        }
        if (newline === -1) break;
        at = newline + 1;
      }
      if (terminator === -1) {
        // Unterminated: the body is the rest of the text.
        if (next < text.length) edits.push({ start: next, end: text.length });
        next = text.length;
        break;
      }
      if (terminator > next) edits.push({ start: next, end: terminator - 1 });
      next = terminatorEnd + 1;
    }
    lineStart = next;
  }

  if (edits.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += `${text.slice(cursor, edit.start)}${MESSAGE_PLACEHOLDER}`;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
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
 * Options for {@link redactIdentifiers}.
 *
 * The default (`{}`) is the command posture. `redactTitle` overrides only what a PROSE
 * title cannot take — the same kind of decision that omits the path pass for titles.
 */
export interface RedactIdentifiersOptions {
  /**
   * Redact bare `kubectl` resource-name operands (`get pods <name>`). On by default; a
   * title turns it OFF, so a sentence like "kubectl delete / drain removes running
   * workloads" keeps its words.
   */
  readonly kubeResourceOperands?: boolean;
}

/**
 * Decide the replacement for one word, advancing `state`.
 *
 * Returns the replacement text, or `undefined` to keep the word as it is. Every branch
 * is per-family; a word reaching here with no family set is kept.
 */
function classify(
  word: string,
  state: State,
  options: RedactIdentifiersOptions,
): string | undefined {
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
      if (assignment !== null) {
        if (KUBE_NAME_FLAGS.has(assignment[1] as string)) {
          return `${assignment[1]}=${NAME_PLACEHOLDER}`;
        }
        return undefined;
      }
      if (isFlag) {
        if (KUBE_NAME_FLAGS.has(word)) state.pending = { placeholder: NAME_PLACEHOLDER };
        return undefined;
      }
      // A bare operand: keep kubectl's own verbs and resource types, redact the rest —
      // a resource NAME, a context name, or a positional namespace are all identifying.
      // OFF for a title, which is prose: "kubectl delete / drain removes running
      // workloads" is a sentence, not a command, and its words are not resource names.
      if (options.kubeResourceOperands === false) return undefined;
      if (KUBE_KEYWORDS.has(word)) return undefined;
      return replaceValue(word, NAME_PLACEHOLDER);
    }

    case "db": {
      const assignment = ASSIGNMENT.exec(word);
      if (assignment !== null) {
        const flag = assignment[1] as string;
        if (DB_HOST_FLAGS.has(flag)) return `${flag}=${HOST_PLACEHOLDER}`;
        if (DB_NAME_FLAGS.has(flag)) return `${flag}=${NAME_PLACEHOLDER}`;
        if (DB_SQL_FLAGS.has(flag)) return `${flag}=${NAME_PLACEHOLDER}`;
        return undefined;
      }
      if (DB_HOST_FLAGS.has(word)) state.pending = { placeholder: HOST_PLACEHOLDER };
      else if (DB_NAME_FLAGS.has(word)) state.pending = { placeholder: NAME_PLACEHOLDER };
      else if (DB_SQL_FLAGS.has(word)) state.pending = { placeholder: NAME_PLACEHOLDER };
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
        } else if (word === "-c" && state.gitSubcommand === undefined) {
          // `git -c user.name=… commit`: the pair is kept unless it sets an identity.
          state.pending = { placeholder: undefined, rewrite: gitIdentityPair };
        } else if (GIT_VALUE_FLAGS.has(word)) {
          state.pending = { placeholder: undefined };
        }
        return undefined;
      }
      // `git config [--global] user.name '…'`: the value after an identity key is a name.
      if (state.gitSubcommand === "config" && GIT_IDENTITY_KEYS.has(word)) {
        state.pending = { placeholder: USER_PLACEHOLDER };
        return undefined;
      }
      // A placeholder is never the subcommand: `git -C <path> commit -m …` must still
      // reach `commit`, or the message it was about to redact survives.
      if (!isRedactedWord(word)) state.gitSubcommand ??= word;
      return undefined;
    }

    case "op": {
      if (state.stopped) return undefined;
      const assignment = ASSIGNMENT.exec(word);
      if (assignment !== null) {
        const flag = assignment[1] as string;
        if (OP_NAME_FLAGS.has(flag)) return `${flag}=${NAME_PLACEHOLDER}`;
        return undefined;
      }
      if (isFlag) {
        // `op run -- <command>`: what follows `--` is somebody else's command line.
        if (word === "--") state.stopped = true;
        else if (OP_NAME_FLAGS.has(word)) state.pending = { placeholder: NAME_PLACEHOLDER };
        else if (OP_KEPT_VALUE_FLAGS.has(word)) state.pending = { placeholder: undefined };
        return undefined;
      }
      if (OP_KEYWORDS.has(word)) return undefined;
      return replaceValue(word, NAME_PLACEHOLDER);
    }

    case "gh": {
      const assignment = ASSIGNMENT.exec(word);
      if (assignment !== null) {
        const flag = assignment[1] as string;
        if (GH_MESSAGE_FLAGS.has(flag)) return `${flag}=${MESSAGE_PLACEHOLDER}`;
        return undefined;
      }
      if (GH_MESSAGE_FLAGS.has(word)) state.pending = { placeholder: MESSAGE_PLACEHOLDER };
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
export function redactIdentifiers(input: string, options: RedactIdentifiersOptions = {}): string {
  if (input.length === 0) return input;

  // Heredoc bodies first: they are free text, and once collapsed nothing inside them can
  // be mistaken for a command word or a comment by the word pass below.
  const text = redactHeredocBodies(input);
  const pieces = tokenize(text);
  const edits: { start: number; end: number; text: string }[] = [];
  let state = freshState(undefined);

  for (const piece of pieces) {
    if (piece.kind === "break") {
      state = freshState(undefined);
      continue;
    }

    if (piece.kind === "comment") {
      // Collapse a comment that carries text to `#<comment>`; a bare `#` is left alone.
      const body = text.slice(piece.start + 1, piece.end);
      if (body.trim().length > 0) {
        edits.push({ start: piece.start, end: piece.end, text: `#${COMMENT_PLACEHOLDER}` });
      }
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
      if (pending.placeholder !== undefined) {
        // A value redacted WHOLE — even when an earlier pass already took a secret or a
        // path out of part of it; only a value that is already a bare placeholder stays.
        if (!isPlaceholderOnly(word)) {
          edits.push({ start, end, text: replaceValue(word, pending.placeholder) });
        }
      } else if (!isRedactedWord(word)) {
        const kept = pending.rewrite?.(word) ?? withoutIds(word);
        if (kept !== word) edits.push({ start, end, text: kept });
      }
      continue;
    }

    // Command-INDEPENDENT: a 1Password setting handed through the environment.
    const opEnv = OP_ENV_ASSIGNMENT.exec(word);
    if (opEnv !== null && !isPlaceholderOnly(opEnv[2] as string)) {
      edits.push({ start, end, text: `${opEnv[1]}=${NAME_PLACEHOLDER}` });
      continue;
    }

    // Command-INDEPENDENT: a secret-bearing flag's value is a secret in ANY command,
    // including one no family covers. Checked before the family logic so it wins over a
    // family's own reading of the same flag, and skipped on an already-redacted word so
    // the pass stays idempotent.
    if (!isRedactedWord(word)) {
      const secretAssignment = ASSIGNMENT.exec(word);
      if (secretAssignment !== null && SECRET_FLAG.test(secretAssignment[1] as string)) {
        edits.push({ start, end, text: `${secretAssignment[1]}=${SECRET_ARG_PLACEHOLDER}` });
        continue;
      }
      if (SECRET_FLAG.test(word)) {
        state.pending = { placeholder: SECRET_ARG_PLACEHOLDER };
        continue;
      }
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
      classify(word, state, options);
      continue;
    }

    // A UUID goes from whatever the family rules kept — the whole word when no family
    // claimed it, or the kept half of a `--flag=value` a family rewrote.
    const replacement = withoutIds(classify(word, state, options) ?? word);
    if (replacement !== word) edits.push({ start, end, text: replacement });
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
