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
 *     on a command line.
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

/** Is this value a stand-in, or a false positive, rather than a credential? */
export function looksLikePlaceholder(found: FoundValue): boolean {
  const secret = secretPart(found);
  const bare = secret.replace(/^["']|["']$/g, "");
  if (PLACEHOLDER_SHAPE.test(found.value) || COMMON_WORDS.has(bare.toLowerCase())) return true;
  if (NAMED_KINDS.has(found.kind) && !credentialShaped(bare)) return true;
  // A value made of very few distinct characters (`aaaaaaaa`, `abababab`) is filler.
  return bare.length >= 6 && new Set(bare).size <= 3;
}

/** A host on this machine. */
const LOCAL_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|[a-z0-9-]+\.localhost)$/i;

/** The host a URL credential points at, or `undefined`. */
function hostOf(found: FoundValue): string | undefined {
  if (found.kind === "database-url") {
    return found.value.slice(found.value.lastIndexOf("@") + 1).match(/^[^\s/:?#]+/)?.[0];
  }
  if (found.kind === "url-credentials" && found.after.startsWith("@")) {
    return found.after.slice(1).match(/^[^\s/:?#@]+/)?.[0];
  }
  return undefined;
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
): Promise<FixtureSearch> {
  if (held.size === 0) return { check: "not-needed", reposChecked: 0, reposNotChecked: 0 };
  const repos = await findRepos(io, workingDirs);
  let checked = 0;
  let notChecked = repos.notChecked;
  let bytes = 0;

  for (const root of repos.roots) {
    if (held.size === 0) {
      // Nothing left to find, so this repo has nothing to say.
      checked += 1;
      continue;
    }
    const listing = await io.git(root, ["ls-files", "-z"]);
    if (!listing.ok) {
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
        // The run's time budget is the one failure that leaves the rest of the repo unread.
        if (read.reason === "budget") {
          complete = false;
          break;
        }
        continue;
      }
      bytes += read.text.length;
      if (read.text.includes("\0")) continue;
      for (const [key, candidate] of held) {
        if (candidate.value !== undefined && read.text.includes(candidate.value)) {
          candidate.decided = "committed-fixture";
          candidate.value = undefined;
          held.delete(key);
        }
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
              const decided: SecretClass | undefined = looksLikePlaceholder(found)
                ? "placeholder"
                : isLocalDev(found)
                  ? "local-dev"
                  : undefined;
              const keep = decided === undefined && held < (input.maxHeldValues ?? MAX_HELD_VALUES);
              if (keep) held += 1;
              candidate = {
                kind: found.kind,
                via: new Set(),
                files: new Set(),
                decided,
                // Past the cap a value is not held, so it cannot be searched for in the repos.
                value: keep ? found.value : undefined,
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
    }
  }

  const pending = new Map<string, Candidate>();
  let notSearched = 0;
  for (const [key, candidate] of candidates) {
    if (candidate.decided !== undefined) continue;
    if (candidate.value === undefined) notSearched += 1;
    else pending.set(key, candidate);
  }
  const searched = await searchFixtures(input.io, workingDirs, pending);
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
  for (const candidate of candidates.values()) {
    classes[candidate.decided as SecretClass] += 1;
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
      fixtureCheck: fixtures.check,
      reposChecked: fixtures.reposChecked,
      reposNotChecked: fixtures.reposNotChecked,
    },
  };
}
