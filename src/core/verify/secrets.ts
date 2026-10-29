// cspell:words passw pousr aprs orization authori ation
// cspell:words letmein qwerty passwd foobar Fingerprinter changeme abababab automount statted
/**
 * The secrets check: every credential-shaped value in the transcripts, sorted into four
 * classes, and for each likely-real one, how it got there and how many files hold it.
 *
 * ── What counts as credential-shaped ─────────────────────────────────────────
 * Exactly what the report's own redaction takes out as a secret: `scrubText`, then
 * `redactSecrets`, the same two passes `redactForReport` runs. A value the report would
 * redact is a value this check looks at, so the two can never disagree about what a secret
 * is. `scrub.ts` is used as it is and not changed.
 *
 * Those passes return text, not values. The values are recovered by lining the redacted text
 * up against the original: everything between two placeholders is copied verbatim, so each
 * placeholder stands for the original text between the copies around it. The search for that
 * alignment is bounded; a text it cannot place is skipped and counted, never guessed at.
 *
 * ── The four classes ─────────────────────────────────────────────────────────
 * Decided in this order:
 *  1. **placeholder or false positive**: a value shaped like a stand-in (`your-key-here`,
 *     `<token>`, `${API_KEY}`, `xxxx`, `changeme`, a word like `password`); a value found only
 *     by the name it was given whose own text is not credential-shaped (`tokens: count`,
 *     `secret: "auth"`, `password = getPassword()` — code, not a secret); and an unnamed random
 *     string seen only in output or replies, where ids and hashes are common.
 *  2. **local dev data**: a database URL or URL credential for a host on this machine
 *     (`localhost`, a loopback address, `host.docker.internal`). A bare name such as `db`
 *     is not taken as local: it can as easily be a production host on a search domain.
 *  3. **committed fixture**: the same value is in a git-tracked file in a repo the sessions
 *     ran in. Searched in-process over the files `git ls-files` lists; the value is never put
 *     on a command line. A value made only of letters, digits, `-` and `_` must stand as a
 *     whole token of the file; any other value is matched as a substring. The search's own
 *     time is charged to the run's budget, and a search the budget cut short is partial.
 *  4. **likely real**: none of the above.
 *
 * Nothing is ever checked against the service a credential belongs to.
 *
 * ── Never the value ──────────────────────────────────────────────────────────
 * A value is held in memory only while the fixture test may still need it, under a keyed
 * fingerprint (`fingerprint.ts`) that is itself never written. What leaves this module is
 * counts and fixed enums: the kind of credential, how it got there, how many files. The one
 * exception is `findLikelyReal`, which hands `scan --scrub` the likely-real values it is
 * asked to replace in the transcripts.
 */

import { FALLBACK_MIN_LENGTH, redactSecrets } from "../redact-secrets.js";
import { scrubText } from "../scrub.js";
import type { AgentSource } from "../types.js";
import type { Fingerprinter } from "./fingerprint.js";
import { isNetworkPath } from "./paths.js";
import { type LineText, lineText, recordText } from "./sources.js";
import {
  type FixtureCheck,
  MAX_SECRET_ITEMS,
  SECRET_PROVENANCES,
  type SecretClass,
  type SecretItem,
  type SecretKind,
  type SecretProvenance,
  type SecretsCheck,
  type SecretsFacts,
  type VerifyIO,
  type VerifyStatus,
} from "./types.js";

/** A credential-shaped value found in a text, with what is around it. */
export interface FoundValue {
  readonly value: string;
  readonly kind: SecretKind;
  /** Up to `CONTEXT` characters of the text after the value. Used to read a URL's host. */
  readonly after: string;
  /** Up to `CONTEXT` characters of the text before the value. Used to read the name it was given. */
  readonly before?: string;
}

/** Characters of context kept after a value. */
const CONTEXT = 256;

/** Most steps the alignment search takes for one text. */
const MAX_ALIGN_STEPS = 5_000;

/** A placeholder the report's redaction writes. */
const PLACEHOLDER = /\[REDACTED:([a-z0-9-]+(?::[a-z0-9-]+)?)(?::[a-z0-9-]+)?\]/g;

/** The private-use character `scrubText` uses internally and drops from its working copy. */
const SCRUB_SENTINEL = String.fromCharCode(0xe000);

/** A placeholder's label to the kind of credential it stands for. PII labels are absent. */
const KIND_OF_LABEL: ReadonlyMap<string, SecretKind> = new Map([
  ["secret:aws", "aws-access-key"],
  ["secret:aws-secret", "aws-secret-key"],
  ["secret:private-key", "private-key"],
  ["secret:github", "github-token"],
  ["secret:slack", "slack-token"],
  ["secret:api-key", "api-key"],
  ["secret:jwt", "jwt"],
  ["secret:bearer", "bearer-token"],
  ["secret:auth", "auth-header"],
  ["secret:connection-string", "database-url"],
  ["secret:basic-auth", "url-credentials"],
  ["secret:password", "password"],
  ["secret:env", "named-secret"],
  ["secret:generic", "random-string"],
]);

/** The kind for a label: a known `secret:` label, `other` for a new one, nothing for PII. */
function kindOf(label: string): SecretKind | undefined {
  const known = KIND_OF_LABEL.get(label);
  if (known !== undefined) return known;
  return label.startsWith("secret:") ? "other" : undefined;
}

/**
 * Where each placeholder's value sits in `text`, given the literal runs of the redacted text.
 *
 * `literals[i]` is the redacted text before placeholder `i`, and the last one is what follows
 * the last placeholder. The first must start `text`, the last must end it, and each one in
 * between must occur, in order, between two non-empty values. Searched depth-first, earliest
 * occurrence first, up to `MAX_ALIGN_STEPS`. `undefined` when no alignment is found.
 */
export function alignValues(
  text: string,
  literals: readonly string[],
): Array<readonly [number, number]> | undefined {
  const count = literals.length - 1;
  if (count <= 0) return [];
  const head = literals[0] as string;
  const tail = literals[count] as string;
  const tailStart = text.length - tail.length;
  if (!text.startsWith(head) || !text.endsWith(tail) || tailStart <= head.length) return undefined;

  const spans: Array<readonly [number, number]> = [];
  let steps = 0;
  const place = (index: number, start: number): boolean => {
    steps += 1;
    if (steps > MAX_ALIGN_STEPS) return false;
    if (index === count - 1) {
      if (tailStart <= start) return false;
      spans[index] = [start, tailStart];
      return true;
    }
    const literal = literals[index + 1] as string;
    let from = start + 1;
    for (;;) {
      const at = text.indexOf(literal, from);
      if (at < 0 || at + literal.length >= tailStart) return false;
      spans[index] = [start, at];
      if (place(index + 1, at + literal.length)) return true;
      if (steps > MAX_ALIGN_STEPS) return false;
      from = at + 1;
    }
  };
  return place(0, head.length) ? spans : undefined;
}

/**
 * What every secret pattern needs somewhere in a text, case-sensitive: the AWS access key id
 * prefixes, a private key block, a JWT header, GitHub and Slack token prefixes, and `sk-`.
 */
const SECRET_ANCHOR_CASED =
  /AKIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|ASCA|ASIA|-----BEGIN|eyJ|gh[pousr]_|github_pat_|xox[baprs]-|sk-/;

/**
 * The same, case-insensitive: a URL with a scheme (credentials in a URL or connection string),
 * a bearer token, an `Authorization` header, a MySQL password flag, and the words the name rules
 * key on.
 */
const SECRET_ANCHOR_ANY_CASE =
  /:\/\/|bearer|authori[sz]ation|mysql|mariadb|passw|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|[_-]key/i;

/** A run long enough to be a random-looking secret. */
const LONG_RUN = new RegExp(`[A-Za-z0-9_-]{${FALLBACK_MIN_LENGTH}}`);

/**
 * Could `text` hold a value any secret pattern in `scrubText` or `redactSecrets` takes out?
 * A necessary condition: every one of those patterns needs one of these anchors, so a text
 * with none of them holds no secret and the full passes are skipped. A test holds it to that.
 */
export function mayHoldSecret(text: string): boolean {
  return SECRET_ANCHOR_CASED.test(text) || SECRET_ANCHOR_ANY_CASE.test(text) || LONG_RUN.test(text);
}

/** What `findValues` returns: the values, and whether the text could not be lined up. */
export interface FoundValues {
  readonly values: readonly FoundValue[];
  /** The redaction changed the text, and its values could not be recovered. */
  readonly unaligned: boolean;
}

/**
 * Every credential-shaped value in `text`. See "What counts as credential-shaped".
 *
 * Pure. The values returned are the caller's to hold briefly and drop; nothing here keeps them.
 */
export function findValues(text: string): FoundValues {
  const clean = text.includes(SCRUB_SENTINEL) ? text.split(SCRUB_SENTINEL).join("") : text;
  if (!mayHoldSecret(clean)) return { values: [], unaligned: false };
  const redacted = redactSecrets(scrubText(clean).text);
  if (redacted === clean) return { values: [], unaligned: false };

  const literals: string[] = [];
  const labels: string[] = [];
  let last = 0;
  for (const match of redacted.matchAll(PLACEHOLDER)) {
    literals.push(redacted.slice(last, match.index));
    labels.push(match[1] as string);
    last = match.index + match[0].length;
  }
  literals.push(redacted.slice(last));
  if (labels.length === 0) return { values: [], unaligned: false };

  const spans = alignValues(clean, literals);
  if (spans === undefined) return { values: [], unaligned: true };
  const values: FoundValue[] = [];
  labels.forEach((label, i) => {
    const kind = kindOf(label);
    const span = spans[i];
    if (kind === undefined || span === undefined) return;
    values.push({
      value: clean.slice(span[0], span[1]),
      kind,
      after: clean.slice(span[1], span[1] + CONTEXT),
      before: clean.slice(Math.max(0, span[0] - CONTEXT), span[0]),
    });
  });
  return { values, unaligned: false };
}

/** Words and shapes that mark a stand-in rather than a credential. */
const PLACEHOLDER_SHAPE =
  /example|placeholder|changeme|change[-_]?me|dummy|fake|sample|redacted|replace[-_]?me|xxxx|your[-_ ]|<[^>]*>|\{\{|\$\{|^\$[A-Za-z_]|%[A-Za-z_]+%|process\.env|os\.environ|\*{3,}|\.\.\.|…|lorem|foobar|^test[-_]|[-_]test$|^todo|0123456|123456789|abcdefgh/i;

/** Whole values that are a word, not a credential. */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "admin",
  "root",
  "postgres",
  "mysql",
  "guest",
  "letmein",
  "qwerty",
  "pass",
  "string",
  "required",
  "optional",
  "value",
  "default",
  "none",
  "null",
  "undefined",
  "true",
  "false",
  "tbd",
]);

/** The part of a value that is the secret: the password of a URL credential. */
function secretPart(found: FoundValue): string {
  if (found.kind === "database-url") {
    const scheme = found.value.indexOf("://");
    const userinfo = found.value.slice(scheme + 3, found.value.lastIndexOf("@"));
    return userinfo.slice(userinfo.indexOf(":") + 1);
  }
  if (found.kind === "url-credentials") return found.value.slice(found.value.indexOf(":") + 1);
  return found.value;
}

/**
 * Kinds found by a name or a scheme rather than by a format of their own. The redaction takes
 * out whatever follows the name, which is right for a page meant to be shared; to call one a
 * credential, its own text has to look like one.
 */
const NAMED_KINDS: ReadonlySet<SecretKind> = new Set([
  "named-secret",
  "password",
  "auth-header",
  "bearer-token",
  "url-credentials",
  "database-url",
]);

/** Shortest value that can be credential-shaped on its own. */
const MIN_CREDENTIAL_LENGTH = 8;

/** Characters that mark code or prose rather than a credential. */
const CODE_CHARACTERS = /[\s()[\]{}<>;,`'"]/;

/** A dotted identifier path: `result.tokens`, `process.env.TOKEN`. */
const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/**
 * Does a value found by its name look like a credential in its own right? At least eight
 * characters, no code punctuation or whitespace, not a path or a pattern (`/…`, `./…`, `~/…`),
 * not a dotted identifier, and not only letters, `-` and `_` — it carries a digit or another
 * symbol.
 */
export function credentialShaped(secret: string): boolean {
  return (
    secret.length >= MIN_CREDENTIAL_LENGTH &&
    !CODE_CHARACTERS.test(secret) &&
    !/^[~.]{0,2}\//.test(secret) &&
    !MEMBER_PATH.test(secret) &&
    /[^A-Za-z_-]/.test(secret)
  );
}

/**
 * Why a value is a placeholder or a false positive:
 * - `stand-in`: it is shaped like one (`your-key-here`, `${KEY}`, `xxxx`, a common word,
 *   filler), or it is a URL credential for a host reserved for examples;
 * - `named-not-credential-shaped`: it was found only by the name it was given, and its own text
 *   does not look like a credential. A real secret made only of letters can be among these, so
 *   they are also counted on their own (`SecretsFacts.setAside`).
 */
export type PlaceholderReason = "stand-in" | "named-not-credential-shaped";

/** Hosts reserved for examples and documentation (RFC 2606). */
const EXAMPLE_HOST = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test)$/i;

/**
 * Why this value is a placeholder or a false positive, or `undefined` when it is neither. The
 * shape test reads the secret part only, so a real password on a host whose name happens to
 * contain `sample` or `example` is not set aside for its host's name.
 */
export function placeholderReason(found: FoundValue): PlaceholderReason | undefined {
  const bare = secretPart(found).replace(/^["']|["']$/g, "");
  if (PLACEHOLDER_SHAPE.test(bare) || COMMON_WORDS.has(bare.toLowerCase())) return "stand-in";
  const host = hostOf(found);
  if (host !== undefined && EXAMPLE_HOST.test(host)) return "stand-in";
  // A value made of very few distinct characters (`aaaaaaaa`, `abababab`) is filler.
  if (bare.length >= 6 && new Set(bare).size <= 3) return "stand-in";
  if (NAMED_KINDS.has(found.kind) && !credentialShaped(bare)) return "named-not-credential-shaped";
  return undefined;
}

/** Is this value a stand-in, or a false positive, rather than a credential? */
export function looksLikePlaceholder(found: FoundValue): boolean {
  return placeholderReason(found) !== undefined;
}

/** A host on this machine. */
const LOCAL_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|host\.docker\.internal|[a-z0-9-]+\.localhost)$/i;

/**
 * The host a URL credential points at, or `undefined`. A bracketed IPv6 host (`[::1]`) is read
 * whole, from the value and the text after it.
 */
function hostOf(found: FoundValue): string | undefined {
  let rest: string | undefined;
  if (found.kind === "database-url") {
    rest = found.value.slice(found.value.lastIndexOf("@") + 1) + found.after;
  } else if (found.kind === "url-credentials" && found.after.startsWith("@")) {
    rest = found.after.slice(1);
  }
  if (rest === undefined) return undefined;
  const bracketed = /^\[([0-9A-Fa-f:.]+)\]/.exec(rest);
  if (bracketed !== null) return bracketed[1];
  return rest.match(/^[^\s/:?#@[\]]+/)?.[0];
}

/** Is this a credential for a database or service on this machine? */
export function isLocalDev(found: FoundValue): boolean {
  const host = hostOf(found);
  return host !== undefined && LOCAL_HOST.test(host);
}

/** One distinct value, while the check runs. */
interface Candidate {
  /** Refined when a later sighting gives evidence the first did not. */
  kind: SecretKind;
  /** Why it counts as a credential, once any sighting has shown it. See `evidenceOf`. */
  evidence: Evidence | undefined;
  readonly via: Set<SecretProvenance>;
  readonly files: Set<number>;
  /** Decided without the repos, or `undefined` until the fixture test has run. */
  decided: SecretClass | undefined;
  /** The value itself, held only while the fixture test may need it. */
  value: string | undefined;
  /** Set aside as a placeholder by a rule that can under-count; see `SecretsFacts.setAside`. */
  setAside: "unnamed-output-only" | "named-not-credential-shaped" | undefined;
}

/**
 * Most distinct values held for the fixture test. A value past it is still classed by every
 * other rule; it only cannot be searched for in the repos, so it cannot become a fixture.
 */
const MAX_HELD_VALUES = 5_000;

/**
 * Shortest text worth remembering as holding nothing. Below it, scanning again costs less
 * than the hash.
 */
const MIN_REMEMBERED_TEXT = 256;

/** Most texts remembered as holding nothing. */
const MAX_EMPTY_TEXTS = 100_000;

/** Most working directories the fixture test looks at. */
const MAX_WORKING_DIRS = 200;

/** Most tracked files the fixture test reads in one repo. */
const MAX_TRACKED_FILES = 20_000;

/** Most bytes the fixture test reads across every repo. */
const MAX_FIXTURE_BYTES = 256 * 1024 * 1024;

/** A value that is one token: looked up as a whole token of a file rather than as a substring. */
const TOKEN_VALUE = /^[A-Za-z0-9_-]+$/;

/** What splits a file's text into tokens: anything a token value cannot contain. */
const TOKEN_SEPARATORS = /[^A-Za-z0-9_-]+/;

/** Most parent folders walked up from a working directory that is gone. */
const MAX_PARENT_STEPS = 8;

/** What the secrets check needs. */
export interface SecretsInput {
  readonly agent: AgentSource;
  /** The transcript files to read. */
  readonly files: readonly string[];
  readonly readLines: (path: string) => AsyncIterable<string>;
  readonly io: VerifyIO;
  readonly fingerprint: Fingerprinter;
  /** For tests: the cap on values held for the fixture test. */
  readonly maxHeldValues?: number;
  /** A clock in milliseconds, for charging the fixture search to the run's budget. */
  readonly now?: () => number;
}

/** The parent folder of a path, or `undefined` at the root. */
function parentOf(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut <= 0) return undefined;
  return trimmed.slice(0, cut);
}

/** The repos the sessions ran in, and how many working directories could not be placed. */
async function findRepos(
  io: VerifyIO,
  workingDirs: ReadonlySet<string>,
): Promise<{ roots: string[]; notChecked: number }> {
  const roots = new Set<string>();
  const gone = new Set<string>();
  for (const cwd of [...workingDirs].slice(0, MAX_WORKING_DIRS)) {
    // A network share or automount is never statted or walked up from.
    if (isNetworkPath(cwd)) {
      gone.add(cwd);
      continue;
    }
    let dir: string | undefined = cwd;
    let steps = 0;
    while (dir !== undefined && io.isDirectory(dir) !== true && steps < MAX_PARENT_STEPS) {
      dir = parentOf(dir);
      steps += 1;
    }
    if (dir === undefined || io.isDirectory(dir) !== true) {
      gone.add(cwd);
      continue;
    }
    const top = await io.git(dir, ["rev-parse", "--show-toplevel"]);
    if (top.ok) {
      const root = top.stdout.trim();
      if (root !== "") roots.add(root);
    } else if (top.reason !== "not-a-repo" || dir !== cwd) {
      // A folder that is there and is not in a repo is not a failure. A folder that is gone,
      // or a `git` that could not answer, is.
      gone.add(dir === cwd ? cwd : dir);
    }
  }
  return { roots: [...roots].sort(), notChecked: gone.size };
}

/** The outcome of searching the repos for the held values. */
interface FixtureSearch {
  readonly check: FixtureCheck;
  readonly reposChecked: number;
  readonly reposNotChecked: number;
}

/**
 * Search the tracked files of every repo for the values still held, and mark each one found
 * as a committed fixture. A value is compared in-process; it never leaves this process.
 */
async function searchFixtures(
  io: VerifyIO,
  workingDirs: ReadonlySet<string>,
  held: Map<string, Candidate>,
  now: () => number,
): Promise<FixtureSearch> {
  if (held.size === 0) return { check: "not-needed", reposChecked: 0, reposNotChecked: 0 };
  const repos = await findRepos(io, workingDirs);
  let checked = 0;
  let notChecked = repos.notChecked;
  let bytes = 0;
  // Once the run's budget is used up, nothing more is read, and every repo left is not checked.
  let exhausted = false;

  // Values made only of token characters are looked up as whole tokens of each file, in one
  // pass over its text; any other value is searched for as a substring.
  const byToken = new Map<string, string[]>();
  const bySubstring: string[] = [];
  for (const [key, candidate] of held) {
    const value = candidate.value;
    if (value === undefined) continue;
    if (TOKEN_VALUE.test(value)) byToken.set(value, [...(byToken.get(value) ?? []), key]);
    else bySubstring.push(key);
  }
  const mark = (key: string): void => {
    const candidate = held.get(key);
    if (candidate === undefined) return;
    candidate.decided = "committed-fixture";
    candidate.value = undefined;
    held.delete(key);
  };

  for (const root of repos.roots) {
    if (exhausted) {
      notChecked += 1;
      continue;
    }
    if (held.size === 0) {
      // Nothing left to find, so this repo has nothing to say.
      checked += 1;
      continue;
    }
    const listing = await io.git(root, ["ls-files", "-z"]);
    if (!listing.ok) {
      if (listing.reason === "budget") exhausted = true;
      notChecked += 1;
      continue;
    }
    const tracked = listing.stdout.split("\0").filter((p) => p !== "");
    let complete = tracked.length <= MAX_TRACKED_FILES;
    for (const relative of tracked.slice(0, MAX_TRACKED_FILES)) {
      if (held.size === 0) break;
      if (bytes >= MAX_FIXTURE_BYTES) {
        complete = false;
        break;
      }
      const read = await io.readFile(`${root}/${relative}`);
      if (!read.ok) {
        // A file over the size cap, a link out of the repo or a file deleted since: skipped.
        // The run's time budget is the one failure that leaves the rest unread.
        if (read.reason === "budget") {
          exhausted = true;
          complete = false;
          break;
        }
        continue;
      }
      bytes += read.text.length;
      if (read.text.includes("\0")) continue;
      // The search itself is charged to the run's budget, not only the reading.
      const started = now();
      for (const token of read.text.split(TOKEN_SEPARATORS)) {
        const keys = byToken.get(token);
        if (keys === undefined) continue;
        for (const key of keys) mark(key);
        byToken.delete(token);
      }
      for (const key of bySubstring) {
        const value = held.get(key)?.value;
        if (value !== undefined && read.text.includes(value)) mark(key);
      }
      if (io.charge !== undefined && !io.charge(Math.max(0, now() - started))) {
        exhausted = true;
        complete = false;
        break;
      }
    }
    if (complete) checked += 1;
    else notChecked += 1;
  }

  const check: FixtureCheck =
    checked === 0 ? "unavailable" : notChecked === 0 ? "complete" : "partial";
  return { check, reposChecked: checked, reposNotChecked: notChecked };
}

/** The likely-real values as the report may describe them, most widespread first. */
function itemsOf(candidates: Iterable<Candidate>): SecretItem[] {
  const items: SecretItem[] = [];
  for (const candidate of candidates) {
    if (candidate.decided !== "likely-real") continue;
    items.push({
      kind: candidate.kind,
      via: SECRET_PROVENANCES.filter((p) => candidate.via.has(p)),
      files: candidate.files.size,
    });
  }
  return items.sort(
    (a, b) =>
      b.files - a.files ||
      a.kind.localeCompare(b.kind) ||
      a.via.join(" ").localeCompare(b.via.join(" ")),
  );
}

/**
 * The secrets check's status, from its facts: not checked when nothing was read, act on a
 * likely-real credential, could-not-check when a file was not read or a value not placed, and
 * clean otherwise. Committed fixtures leave it clean.
 */
export function secretsStatus(
  facts: Pick<SecretsFacts, "classes" | "filesRead" | "filesNotRead" | "unplaced">,
): VerifyStatus {
  if (facts.filesRead === 0 && facts.filesNotRead === 0) return "not-checked";
  if (facts.classes["likely-real"] > 0) return "act";
  if (facts.filesNotRead > 0 || facts.unplaced > 0) return "could-not-check";
  return "clean";
}

// ── Evidence: why a value counts as a credential ──────────────────────────────

/**
 * Why a value counts as likely real. Without one of these it does not, however it reached the
 * transcripts:
 * - `known-format`: a provider's token format (`KNOWN_FORMATS`), or a format the scrubber
 *   recognises (an AWS key, a private key, a GitHub or Slack token, an `sk-` key, a JWT whose
 *   header and payload decode);
 * - `named`: given under a credential's name (`CREDENTIAL_NAME`), and shaped like a credential
 *   itself (`namedValueShaped`); or a bearer token, an `Authorization` value or a URL password;
 * - `corroborated`: a random-looking string right after a credential's name, flag or header on
 *   the same line (`CORROBORATING_CONTEXT`).
 */
export type Evidence = "known-format" | "named" | "corroborated";

/** Provider formats, whole-value, and the kind each one is. Checked in order. */
const KNOWN_FORMATS: readonly (readonly [RegExp, SecretKind])[] = [
  [/^(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|ASCA)[A-Z0-9]{16}$/, "aws-access-key"],
  [
    /^(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})$/,
    "github-token",
  ],
  [/^xoxb-[A-Za-z0-9-]{10,}$/, "slack-bot-token"],
  [/^xox[aprs]-[A-Za-z0-9-]{10,}$/, "slack-user-token"],
  [/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}$/, "slack-webhook"],
  [/^npm_[A-Za-z0-9]{36}$/, "npm-token"],
  [/^(?:sk|rk)_live_[A-Za-z0-9]{16,}$/, "stripe-live-key"],
  [/^(?:sk|rk)_test_[A-Za-z0-9]{16,}$/, "stripe-test-key"],
  [/^sk-ant-[A-Za-z0-9_-]{20,}$/, "anthropic-key"],
  [/^sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}$/, "openai-key"],
  [/^AIza[0-9A-Za-z_-]{35}$/, "google-api-key"],
  [/^glpat-[A-Za-z0-9_-]{20,}$/, "gitlab-token"],
  [/^hf_[A-Za-z0-9]{30,}$/, "huggingface-token"],
  [/^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/, "sendgrid-key"],
];

/** The kind a value's own format says it is, or `undefined`. */
export function knownFormat(value: string): SecretKind | undefined {
  const bare = value.replace(/^["']|["']$/g, "");
  for (const [format, kind] of KNOWN_FORMATS) if (format.test(bare)) return kind;
  return undefined;
}

/** Kinds the scrubber names by a format of their own. */
const FORMAT_KINDS: ReadonlySet<SecretKind> = new Set([
  "aws-access-key",
  "aws-secret-key",
  "private-key",
  "github-token",
  "slack-token",
  "api-key",
]);

/** One base64url segment of a JWT, decoded as JSON, or `undefined`. */
function jwtPart(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a JWT is: its role, from a fixed set, when its header (with an `alg`) and payload decode;
 * `public` for a role of `anon`, a key meant to be shipped to browsers; `undecodable` otherwise.
 */
export function jwtKind(value: string): SecretKind | "public" | "undecodable" {
  const [header, payload] = value.split(".");
  const head = header === undefined ? undefined : jwtPart(header);
  const body = payload === undefined ? undefined : jwtPart(payload);
  if (head === undefined || typeof head.alg !== "string" || body === undefined) {
    return "undecodable";
  }
  if (body.role === "anon") return "public";
  if (body.role === "service_role") return "jwt-service-role";
  if (body.role === "authenticated") return "jwt-authenticated";
  return "jwt";
}

/** The class of a credential's name, from a fixed set, or `undefined` for any other name. */
type NameClass = "password" | "token" | "api-key" | "secret";

/** The name a value was given: the last identifier before its separator and any quote. */
const NAME_BEFORE = /([A-Za-z_][A-Za-z0-9_.-]*)["'\]]?\s*(?:[:=]|=>)?\s*["'`]?\s*$/;

/**
 * A name that is a field about a credential rather than the credential: an id, an ARN, a name,
 * a path, a file, a type, a URL, a count, a length, a size, a version, a prefix, an expiry.
 */
const NAME_IS_REFERENCE =
  /(?:id|ids|arn|name|path|file|ref|type|url|uri|count|len|length|size|field|header|env|var|prefix|version|ttl|expiry|expires|at|limit|max|min|usage)$/;

/** A name that is a public or a lookup key, not a secret one. */
const PUBLIC_KEY_NAME =
  /(?:public|publishable|anon|site|primary|cache|sort|partition|idempotency|foreign|object|lookup|dedupe|row|map|hash)[_-]?key/;

/** The class of the name before a value, or `undefined` when it is not a credential's name. */
export function credentialNameClass(before: string): NameClass | undefined {
  const name = (NAME_BEFORE.exec(before.split(/\r?\n/).pop() ?? "")?.[1] ?? "").toLowerCase();
  if (name === "") return undefined;
  const flat = name.replace(/[_.-]/g, "");
  if (NAME_IS_REFERENCE.test(flat) || PUBLIC_KEY_NAME.test(name)) return undefined;
  if (/passw|passphrase|pwd/.test(name)) return "password";
  if (/api[_.-]?key|apikey/.test(name)) return "api-key";
  if (
    /(?:^|[_.-])tokens?$|token[_.-]/.test(name) ||
    /(?:access|refresh|auth|bearer|session|bot|id)[_.-]?token/.test(name)
  ) {
    return /tokens$/.test(name) ? undefined : "token";
  }
  if (
    /secret|credential|(?:access|private|signing|encryption|master|license)[_.-]?key|auth/.test(
      name,
    )
  ) {
    return "secret";
  }
  return undefined;
}

/** Shortest value a credential's name can vouch for. */
const MIN_NAMED_LENGTH = 12;

/** Lowest entropy, in bits per character, a named value must have. */
const MIN_NAMED_ENTROPY = 3.5;

/** Shannon entropy of `value`, in bits per character. */
function entropyOf(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Does a value under a credential's name look like a credential itself? At least 12 characters
 * and 3.5 bits of entropy per character, a digit or a symbol among its letters, and not a
 * reference to one: no `$`, no URL, no path, no file name, no ARN, no shell or markup syntax,
 * and a `:` only in a single `user:pass` pair.
 */
export function namedValueShaped(value: string): boolean {
  const bare = value.replace(/^["']|["']$/g, "");
  if (bare.length < MIN_NAMED_LENGTH || entropyOf(bare) < MIN_NAMED_ENTROPY) return false;
  if (!/[^A-Za-z]/.test(bare)) return false;
  if (/\$|:\/\/|^[~./]|^arn:|[|<>]/.test(bare)) return false;
  if (/\.(?:json|ya?ml|env|txt|pem|key|js|ts|py|sh|md|toml)$/i.test(bare)) return false;
  if (bare.includes(":") && !/^[^:\s]+:[^:\s]+$/.test(bare)) return false;
  return true;
}

/**
 * What marks a random-looking string as a credential: right before it on its line, a
 * credential word in an assignment, a credential flag, or a credential header.
 */
const CORROBORATING_CONTEXT =
  /(?:token|secret|passw(?:or)?d|pwd|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|credential|auth(?:orization)?|bearer|session[-_ ]?(?:id|key|token)|cookie|signing[-_ ]?key|webhook|dsn|license[-_ ]?key)["'\]]?\s*(?:[:=]|=>|\s)\s*["'`]?$|(?:--(?:token|password|secret|api-key|apikey|key|auth)(?:=|\s+)["']?|-H\s*["']?[A-Za-z-]*(?:key|token|auth)[A-Za-z-]*:\s*(?:Bearer\s+)?)$/i;

/** Characters before a random-looking string read for a credential's name, flag or header. */
const CORROBORATION_WINDOW = 48;

/** What one sighting of a value shows: its kind, and why it counts, if it does. */
export interface Sighting {
  readonly kind: SecretKind;
  readonly evidence?: Evidence;
  /** A token that is public by design, such as a JWT for the `anon` role. */
  readonly public?: true;
}

/** What one sighting of `found` shows. Pure. */
export function evidenceOf(found: FoundValue): Sighting {
  const secret = secretPart(found);
  const format = knownFormat(found.value) ?? knownFormat(secret);
  if (found.kind === "jwt") {
    const kind = jwtKind(found.value.replace(/^["']|["']$/g, ""));
    if (kind === "public") return { kind: "jwt", public: true };
    if (kind === "undecodable") return { kind: "jwt" };
    return { kind, evidence: "known-format" };
  }
  if (format !== undefined) return { kind: format, evidence: "known-format" };
  if (FORMAT_KINDS.has(found.kind)) return { kind: found.kind, evidence: "known-format" };
  switch (found.kind) {
    case "database-url":
    case "url-credentials":
      return { kind: found.kind, evidence: "named" };
    case "bearer-token":
    case "auth-header":
      return namedValueShaped(secret)
        ? { kind: found.kind, evidence: "named" }
        : { kind: found.kind };
    case "password":
      // A password handed to a database client's `-p` flag.
      return credentialShaped(secret)
        ? { kind: found.kind, evidence: "named" }
        : { kind: found.kind };
    case "named-secret": {
      const name = credentialNameClass(found.before ?? "");
      if (name === undefined || !namedValueShaped(secret)) return { kind: found.kind };
      const kind: SecretKind =
        name === "password"
          ? "named-password"
          : name === "token"
            ? "named-token"
            : name === "api-key"
              ? "named-api-key"
              : "named-secret";
      return { kind, evidence: "named" };
    }
    default: {
      const line = (found.before ?? "").slice(-CORROBORATION_WINDOW).split(/\r?\n/).pop() ?? "";
      return CORROBORATING_CONTEXT.test(line)
        ? { kind: found.kind, evidence: "corroborated" }
        : { kind: found.kind };
    }
  }
}

// ── Collecting values as the transcripts are read ─────────────────────────────

/**
 * Collects credential-shaped values from transcript text, one file at a time. `scan` feeds it
 * the records it parses anyway, so the transcripts are read once; `checkSecrets` feeds it from
 * its own reading for any file it was not given. Values are held only in memory, under keyed
 * fingerprints, until the check is finished.
 */
export interface SecretsCollector {
  readonly agent: AgentSource;
  /** Start a file. Returns its index; the same path returns the same index. */
  file(path: string): number;
  /** One raw line of file `index`. */
  line(index: number, line: string): void;
  /** One record of file `index`, already parsed from its line. */
  record(index: number, record: unknown): void;
  /** File `index` was read to the end. */
  read(index: number): void;
}

/** A remembered text's values. */
type Remembered = FoundValues;

/** Nothing found in a text. */
const NOTHING: Remembered = { values: [], unaligned: false };

/** Most texts with values remembered; texts that held nothing count against `MAX_EMPTY_TEXTS`. */
const MAX_REMEMBERED_VALUES = 20_000;

/** What a collector has gathered, for `finishSecrets`. */
interface Collected {
  readonly candidates: Map<string, Candidate>;
  readonly workingDirs: Set<string>;
  readonly paths: Map<string, number>;
  readonly done: Set<number>;
  /** Texts that could not be lined up, by file. */
  readonly unplaced: Map<number, number>;
}

/** The collector's own state, beside the interface. */
const COLLECTED = new WeakMap<SecretsCollector, Collected>();

/** What a collector needs. */
export interface CollectorOptions {
  readonly agent: AgentSource;
  readonly fingerprint: Fingerprinter;
  /** For tests: the cap on values held for the fixture test. */
  readonly maxHeldValues?: number;
}

/** A new collector. */
export function createSecretsCollector(options: CollectorOptions): SecretsCollector {
  const collected: Collected = {
    candidates: new Map(),
    workingDirs: new Set(),
    paths: new Map(),
    done: new Set(),
    unplaced: new Map(),
  };
  let held = 0;
  let rememberedValues = 0;
  // Keyed hashes of long texts already scanned, with what they held. A tool's output is stored
  // twice in a Claude Code transcript, and the same output recurs across sessions; each is
  // scanned once.
  const remembered = new Map<string, Remembered>();
  // Sub-agents' transcripts: their prompts were written by the agent that started them.
  const subagents = new Set<number>();

  const take = (index: number, text: LineText): void => {
    for (const cwd of text.workingDirs) collected.workingDirs.add(cwd);
    for (const piece of text.pieces) {
      const remember = piece.text.length >= MIN_REMEMBERED_TEXT;
      const textKey = remember ? options.fingerprint(piece.text) : "";
      let result = remember ? remembered.get(textKey) : undefined;
      if (result === undefined) {
        result = findValues(piece.text);
        if (remember && !result.unaligned) {
          if (result.values.length === 0) {
            if (remembered.size < MAX_EMPTY_TEXTS) remembered.set(textKey, NOTHING);
          } else if (rememberedValues < MAX_REMEMBERED_VALUES) {
            remembered.set(textKey, result);
            rememberedValues += 1;
          }
        }
      }
      if (result.unaligned) {
        collected.unplaced.set(index, (collected.unplaced.get(index) ?? 0) + 1);
      }
      for (const found of result.values) {
        const key = options.fingerprint(found.value);
        let candidate = collected.candidates.get(key);
        if (candidate === undefined) {
          const reason = placeholderReason(found);
          const sighting = evidenceOf(found);
          const decided: SecretClass | undefined =
            reason !== undefined || sighting.public === true
              ? "placeholder"
              : isLocalDev(found)
                ? "local-dev"
                : undefined;
          const keep = decided === undefined && held < (options.maxHeldValues ?? MAX_HELD_VALUES);
          if (keep) held += 1;
          candidate = {
            kind: sighting.kind,
            evidence: sighting.evidence,
            via: new Set(),
            files: new Set(),
            decided,
            // Past the cap a value is not held, so it cannot be searched for in the repos.
            value: keep ? found.value : undefined,
            setAside:
              reason === "named-not-credential-shaped" || sighting.public === true
                ? "named-not-credential-shaped"
                : undefined,
          };
          collected.candidates.set(key, candidate);
        } else if (candidate.evidence === undefined && candidate.decided === undefined) {
          // A later sighting can show what the first did not: a name, or a flag before it.
          const sighting = evidenceOf(found);
          if (sighting.evidence !== undefined) {
            candidate.evidence = sighting.evidence;
            candidate.kind = sighting.kind;
          }
        }
        candidate.via.add(piece.via);
        candidate.files.add(index);
      }
    }
  };

  const collector: SecretsCollector = {
    agent: options.agent,
    file(path) {
      let index = collected.paths.get(path);
      if (index === undefined) {
        index = collected.paths.size;
        collected.paths.set(path, index);
        if (/[\\/]subagents[\\/][^\\/]+$/.test(path)) subagents.add(index);
      }
      return index;
    },
    line(index, line) {
      take(index, lineText(options.agent, line, { subagent: subagents.has(index) }));
    },
    record(index, record) {
      take(index, recordText(options.agent, record, { subagent: subagents.has(index) }));
    },
    read(index) {
      collected.done.add(index);
    },
  };
  COLLECTED.set(collector, collected);
  return collector;
}

/** Read `path` into `collector` line by line. `false` when the file could not be read. */
export async function collectFile(
  collector: SecretsCollector,
  path: string,
  readLines: (path: string) => AsyncIterable<string>,
): Promise<boolean> {
  const index = collector.file(path);
  try {
    for await (const line of readLines(path)) collector.line(index, line);
    collector.read(index);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a collector gathered, as plain data, to hand from a worker thread to the main one. It
 * holds values: it moves between threads of this process in memory and is never written.
 */
export interface CollectedPart {
  readonly paths: readonly (readonly [string, number])[];
  readonly done: readonly number[];
  readonly unplaced: readonly (readonly [number, number])[];
  readonly workingDirs: readonly string[];
  readonly candidates: readonly (readonly [
    string,
    {
      readonly kind: SecretKind;
      readonly evidence: Evidence | undefined;
      readonly via: readonly SecretProvenance[];
      readonly files: readonly number[];
      readonly decided: SecretClass | undefined;
      readonly value: string | undefined;
      readonly setAside: Candidate["setAside"];
    },
  ])[];
}

/** `collector`'s state, as plain data. */
export function exportCollected(collector: SecretsCollector): CollectedPart {
  const collected = COLLECTED.get(collector) as Collected;
  return {
    paths: [...collected.paths],
    done: [...collected.done],
    unplaced: [...collected.unplaced],
    workingDirs: [...collected.workingDirs],
    candidates: [...collected.candidates].map(([key, c]) => [
      key,
      {
        kind: c.kind,
        evidence: c.evidence,
        via: [...c.via],
        files: [...c.files],
        decided: c.decided,
        value: c.value,
        setAside: c.setAside,
      },
    ]),
  };
}

/**
 * Add what another collector gathered, under the same fingerprint key, to `collector`. A
 * value both saw is one value: its ways in and files are joined, and evidence either saw
 * counts.
 */
export function mergeCollected(collector: SecretsCollector, part: CollectedPart): void {
  const collected = COLLECTED.get(collector) as Collected;
  const index = new Map<number, number>();
  for (const [path, theirs] of part.paths) index.set(theirs, collector.file(path));
  // Every index a part uses is one of its paths; `-1` is never one of the files a check is about.
  const mine = (theirs: number): number => index.get(theirs) ?? -1;
  for (const theirs of part.done) collector.read(mine(theirs));
  for (const [theirs, count] of part.unplaced) {
    const at = mine(theirs);
    collected.unplaced.set(at, (collected.unplaced.get(at) ?? 0) + count);
  }
  for (const dir of part.workingDirs) collected.workingDirs.add(dir);
  for (const [key, c] of part.candidates) {
    const existing = collected.candidates.get(key);
    if (existing === undefined) {
      collected.candidates.set(key, {
        kind: c.kind,
        evidence: c.evidence,
        via: new Set(c.via),
        files: new Set(c.files.map(mine)),
        decided: c.decided,
        value: c.value,
        setAside: c.setAside,
      });
      continue;
    }
    for (const via of c.via) existing.via.add(via);
    for (const file of c.files) existing.files.add(mine(file));
    if (existing.evidence === undefined && c.evidence !== undefined) {
      existing.evidence = c.evidence;
      existing.kind = c.kind;
    }
    existing.decided ??= c.decided;
    existing.setAside ??= c.setAside;
    existing.value ??= c.value;
  }
}

// ── The check ────────────────────────────────────────────────────────────────

/**
 * Run the secrets check. See the module header.
 *
 * With a `collector` that `scan` filled while it read the transcripts, each file it read is
 * used as it is and only the others are read here. Never throws: a file that cannot be read is
 * counted, and a repo that cannot be searched is counted. Either keeps the result from reading
 * as clean.
 */
export async function checkSecrets(
  input: SecretsInput & { readonly collector?: SecretsCollector },
): Promise<SecretsCheck> {
  return (await classifySecrets(input, false)).check;
}

/** One likely-real value, for `scan --scrub` to replace. */
export interface LikelyRealValue {
  readonly value: string;
  readonly kind: SecretKind;
  /** The transcript files the check found it in, in the order they were given. */
  readonly files: readonly string[];
}

/** What `findLikelyReal` returns. */
export interface LikelyRealValues {
  /** The secrets check, exactly as `checkSecrets` gives it. */
  readonly check: SecretsCheck;
  /** The likely-real values, longest first. Held in memory only; never written out. */
  readonly values: readonly LikelyRealValue[];
  /**
   * Likely-real values past the held-values cap. They were classed, but their text was not
   * kept, so they cannot be replaced.
   */
  readonly notHeld: number;
}

/**
 * The secrets check, keeping the text of each likely-real value.
 *
 * Only `scan --scrub` calls this, to replace those values in the transcripts. Fixtures,
 * placeholders and local dev data are not returned. The caller holds the values for the run
 * and writes them nowhere but the transcript backup.
 */
export async function findLikelyReal(input: SecretsInput): Promise<LikelyRealValues> {
  return await classifySecrets(input, true);
}

/** The secrets check; with `keep`, also the likely-real values themselves. */
async function classifySecrets(
  input: SecretsInput & { readonly collector?: SecretsCollector },
  keep: boolean,
): Promise<LikelyRealValues> {
  const collector =
    input.collector ??
    createSecretsCollector({
      agent: input.agent,
      fingerprint: input.fingerprint,
      ...(input.maxHeldValues === undefined ? {} : { maxHeldValues: input.maxHeldValues }),
    });
  const collected = COLLECTED.get(collector) as Collected;

  // The files this check is about, by their index in the collector. Any file the collector was
  // not given whole is read now.
  const included = new Set<number>();
  let filesRead = 0;
  let filesNotRead = 0;
  for (const path of input.files) {
    const known = collected.paths.get(path);
    if (known !== undefined && collected.done.has(known)) {
      included.add(known);
      filesRead += 1;
      continue;
    }
    if (await collectFile(collector, path, input.readLines)) {
      included.add(collector.file(path));
      filesRead += 1;
    } else {
      filesNotRead += 1;
    }
  }
  let unplaced = 0;
  for (const [index, count] of collected.unplaced) if (included.has(index)) unplaced += count;

  // Only values seen in the files this check is about count, by those files alone.
  const candidates = new Map<string, Candidate>();
  for (const [key, candidate] of collected.candidates) {
    for (const index of candidate.files) if (!included.has(index)) candidate.files.delete(index);
    if (candidate.files.size > 0) candidates.set(key, candidate);
  }
  const fileOrder = new Map<number, number>();
  input.files.forEach((path, order) => {
    const index = collected.paths.get(path);
    if (index !== undefined) fileOrder.set(index, order);
  });

  // A value with no evidence (`evidenceOf`) is not counted, however it got there: a
  // random-looking string with nothing marking it is most often an id or a hash, and a value
  // under a name that is not a credential's is most often code or a setting.
  for (const candidate of candidates.values()) {
    if (candidate.decided !== undefined || candidate.evidence !== undefined) continue;
    candidate.decided = "placeholder";
    candidate.value = undefined;
    candidate.setAside =
      candidate.kind === "random-string" || candidate.kind === "other"
        ? "unnamed-output-only"
        : "named-not-credential-shaped";
  }

  const pending = new Map<string, Candidate>();
  let notSearched = 0;
  for (const [key, candidate] of candidates) {
    if (candidate.decided !== undefined) continue;
    if (candidate.value === undefined) notSearched += 1;
    else pending.set(key, candidate);
  }
  const searched = await searchFixtures(
    input.io,
    collected.workingDirs,
    pending,
    input.now ?? (() => Date.now()),
  );
  // A value that could not be searched for leaves the fixture test incomplete.
  const fixtures: FixtureSearch =
    notSearched === 0
      ? searched
      : {
          ...searched,
          check:
            searched.check === "complete"
              ? "partial"
              : searched.check === "not-needed"
                ? "unavailable"
                : searched.check,
        };
  const kept: LikelyRealValue[] = [];
  let notHeld = 0;
  for (const candidate of candidates.values()) {
    candidate.decided ??= "likely-real";
    if (keep && candidate.decided === "likely-real") {
      if (candidate.value === undefined) notHeld += 1;
      else {
        kept.push({
          value: candidate.value,
          kind: candidate.kind,
          files: [...candidate.files]
            .map((index) => fileOrder.get(index) ?? Number.MAX_SAFE_INTEGER)
            .sort((a, b) => a - b)
            .map((order) => input.files[order] as string),
        });
      }
    }
    candidate.value = undefined;
  }

  const classes: Record<SecretClass, number> = {
    "likely-real": 0,
    "committed-fixture": 0,
    placeholder: 0,
    "local-dev": 0,
  };
  let unnamedOutputOnly = 0;
  let namedNotCredentialShaped = 0;
  for (const candidate of candidates.values()) {
    classes[candidate.decided as SecretClass] += 1;
    if (candidate.setAside === "unnamed-output-only") unnamedOutputOnly += 1;
    else if (candidate.setAside === "named-not-credential-shaped") namedNotCredentialShaped += 1;
  }
  const items = itemsOf(candidates.values());

  const status = secretsStatus({ classes, filesRead, filesNotRead, unplaced });

  const check: SecretsCheck = {
    status,
    matches: candidates.size,
    facts: {
      classes,
      items: items.slice(0, MAX_SECRET_ITEMS),
      moreItems: Math.max(0, items.length - MAX_SECRET_ITEMS),
      filesRead,
      filesNotRead,
      unplaced,
      setAside: { unnamedOutputOnly, namedNotCredentialShaped },
      fixtureCheck: fixtures.check,
      reposChecked: fixtures.reposChecked,
      reposNotChecked: fixtures.reposNotChecked,
    },
  };
  // Longest first, so a value that contains another is replaced whole.
  kept.sort((a, b) => b.value.length - a.value.length);
  return { check, values: kept, notHeld };
}
