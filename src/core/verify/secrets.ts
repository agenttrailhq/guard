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
 * counts and fixed enums: the kind of credential, how it got there, how many files.
 */

import { redactSecrets } from "../redact-secrets.js";
import { scrubText } from "../scrub.js";
import type { AgentSource } from "../types.js";
import type { Fingerprinter } from "./fingerprint.js";
import { isNetworkPath } from "./paths.js";
import { lineText } from "./sources.js";
import {
  type FixtureCheck,
  MAX_SECRET_ITEMS,
  SECRET_PROVENANCES,
  type SecretClass,
  type SecretItem,
  type SecretKind,
  type SecretProvenance,
  type SecretsCheck,
  type VerifyIO,
  type VerifyStatus,
} from "./types.js";

/** A credential-shaped value found in a text, with what is around it. */
export interface FoundValue {
  readonly value: string;
  readonly kind: SecretKind;
  /** Up to `CONTEXT` characters of the text after the value. Used to read a URL's host. */
  readonly after: string;
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
  readonly kind: SecretKind;
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

/** Is an unnamed random string a credential? Only where a person or the agent put it. */
function randomStringIsCredential(via: ReadonlySet<SecretProvenance>): boolean {
  return via.has("pasted-into-prompt") || via.has("typed-into-command");
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
 * Run the secrets check. See the module header.
 *
 * Never throws: a file that cannot be read is counted, and a repo that cannot be searched is
 * counted. Either keeps the result from reading as clean.
 */
export async function checkSecrets(input: SecretsInput): Promise<SecretsCheck> {
  const candidates = new Map<string, Candidate>();
  const workingDirs = new Set<string>();
  let filesRead = 0;
  let filesNotRead = 0;
  let unplaced = 0;
  let held = 0;
  // Keyed hashes of long texts already found to hold nothing. A tool's output is stored twice
  // in a Claude Code transcript, and the same output recurs across sessions; each is scanned
  // once. Only texts that held nothing are remembered, so no value is kept by this.
  const empty = new Set<string>();

  for (const [index, path] of input.files.entries()) {
    try {
      for await (const line of input.readLines(path)) {
        const { pieces, workingDirs: named } = lineText(input.agent, line);
        for (const cwd of named) workingDirs.add(cwd);
        for (const piece of pieces) {
          const remember = piece.text.length >= MIN_REMEMBERED_TEXT;
          const textKey = remember ? input.fingerprint(piece.text) : "";
          if (remember && empty.has(textKey)) continue;
          const result = findValues(piece.text);
          if (result.unaligned) unplaced += 1;
          if (
            remember &&
            result.values.length === 0 &&
            !result.unaligned &&
            empty.size < MAX_EMPTY_TEXTS
          ) {
            empty.add(textKey);
          }
          for (const found of result.values) {
            const key = input.fingerprint(found.value);
            let candidate = candidates.get(key);
            if (candidate === undefined) {
              const reason = placeholderReason(found);
              const decided: SecretClass | undefined =
                reason !== undefined ? "placeholder" : isLocalDev(found) ? "local-dev" : undefined;
              const keep = decided === undefined && held < (input.maxHeldValues ?? MAX_HELD_VALUES);
              if (keep) held += 1;
              candidate = {
                kind: found.kind,
                via: new Set(),
                files: new Set(),
                decided,
                // Past the cap a value is not held, so it cannot be searched for in the repos.
                value: keep ? found.value : undefined,
                setAside: reason === "named-not-credential-shaped" ? reason : undefined,
              };
              candidates.set(key, candidate);
            }
            candidate.via.add(piece.via);
            candidate.files.add(index);
          }
        }
      }
      filesRead += 1;
    } catch {
      filesNotRead += 1;
    }
  }

  // An unnamed random string seen only in output or replies is most often an id or a hash.
  for (const candidate of candidates.values()) {
    if (
      candidate.kind === "random-string" &&
      candidate.decided === undefined &&
      !randomStringIsCredential(candidate.via)
    ) {
      candidate.decided = "placeholder";
      candidate.value = undefined;
      candidate.setAside = "unnamed-output-only";
    }
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
    workingDirs,
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
  for (const candidate of candidates.values()) {
    candidate.decided ??= "likely-real";
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

  let status: VerifyStatus;
  if (filesRead === 0 && filesNotRead === 0) status = "not-checked";
  else if (classes["likely-real"] > 0) status = "act";
  else if (filesNotRead > 0 || unplaced > 0) status = "could-not-check";
  else status = "clean";

  return {
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
}
