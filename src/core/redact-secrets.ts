/**
 * `redactSecrets` — secrets the pattern-based scrubber has no shape for, out of anything
 * `scan` displays or writes.
 *
 * `scrubText` recognises a secret by a known FORMAT (an AWS key, a JWT, a GitHub token) or
 * by a name that contains a secret word (`TOKEN`, `PASSWORD`, `API_KEY`, …). A key from a
 * provider it has never heard of, handed over under a name outside that list or with no
 * name at all, survives it. This pass adds two rules for exactly that:
 *
 *  1. **A wider name rule.** A value that follows a name ending in `_KEY` / `-key`
 *     (`VENDOR_KEY=…`, `X-Vendor-Key: …`), or an `Authorization:` header carrying a raw
 *     credential, is replaced with `[REDACTED:secret:env]` — the same marker the narrower
 *     name rule uses, so the report legend is unchanged.
 *  2. **A long-random-string fallback.** A run of 32 or more base62 / base64url characters
 *     that looks random is replaced with `[REDACTED:secret:generic]`, so a reader can tell
 *     a guess from a recognised format.
 *
 * ── Order ────────────────────────────────────────────────────────────────────
 * It runs after `scrubText` and `redactPaths`, and before `redactIdentifiers`:
 *
 *     redactIdentifiers(redactSecrets(redactPaths(scrubText(text).text)))
 *
 * After `scrubText`, so a recognised format keeps its specific label. After `redactPaths`,
 * so a file path is already `<path>` and never reaches the fallback. Before
 * `redactIdentifiers`, which leaves any word that carries a placeholder alone.
 *
 * ── What the fallback will NOT touch ─────────────────────────────────────────
 * A candidate is left as it is when it is a UUID; purely hexadecimal (a git SHA, an MD5,
 * SHA-256 or SHA-512 digest — indistinguishable from a hex-encoded key, so hex is masked
 * only under a name or flag); a package integrity value or image digest (`sha512-…`,
 * `sha256:…`); a run touching `+ / . %` or ending in `=` (a base64 blob, a data URI, a file
 * name, a domain, a URL-encoded value); a label joined to a hash (`main-<40 hex>`); a run
 * of eight or more digits (a timestamp, an account number); mostly ordinary words (a long
 * kebab-case branch, a snake_case, camelCase or PascalCase identifier, a folder name with a
 * year in it); or unremarkable by character mix — no digit, no letter, or low entropy. The
 * thresholds are in {@link FALLBACK_MIN_LENGTH} and {@link FALLBACK_MIN_ENTROPY}.
 *
 * ── It is a heuristic and says so ────────────────────────────────────────────
 * A secret shorter than 32 characters with no recognised name or format, a secret that is
 * only hex, a secret split across `+ / .`, an unnamed secret followed by `.` and an unnamed
 * secret ending in `=` can survive. The report's own copy states
 * that redaction is not a guarantee.
 *
 * Pure, total and idempotent: no imports, no I/O, every regex compiled once. The secret is
 * never echoed into a placeholder.
 */

/** Marker for a value taken out under the name rule — the existing `.env` marker. */
const NAME_RULE_PLACEHOLDER = "[REDACTED:secret:env]";
/** Marker for a value taken out by the long-random-string fallback. */
export const GENERIC_PLACEHOLDER = "[REDACTED:secret:generic]";

/** The shortest run the fallback considers. */
export const FALLBACK_MIN_LENGTH = 32;
/** The longest segment of a hyphenated name (a pod's hash segments are ten characters). */
const NAME_SEGMENT_MAX = 12;
/** The share of a run that must be ordinary words to count as an identifier. */
const WORDLIKE_SHARE = 0.7;
/** The lowest Shannon entropy (bits per character) the fallback masks. */
export const FALLBACK_MIN_ENTROPY = 4.0;

/**
 * A name ending in `_key` or `-key`, case-insensitive, with at least one character before
 * the suffix. `monkey` and `keyboard` do not match; `VENDOR_KEY`, `foo-key`, `x-vendor-key`
 * do.
 */
const KEY_NAME = "[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*[_-]key";

/** Characters a value never contains: whitespace, quotes and list separators. */
const UNQUOTED_VALUE = "[^\\s\"',;\\[<]";

/**
 * `NAME<sep>value` where NAME ends in `_KEY` / `-key`. Same three-branch value as the
 * `.env` rule: a quoted value may contain spaces, an unquoted one stops at the first
 * terminator. A value that is already a placeholder (`[REDACTED:…]`, `<path>`) is skipped.
 * Group 1 = name, 2 = separator, 3 / 4 = the opening double / single quote, when there is one.
 */
const KEY_NAME_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_-])(${KEY_NAME})(["']?\\s*[=:]\\s*)` +
    `(?:(")(?!\\[REDACTED:|<)[^"]{4,}"` +
    `|(')(?!\\[REDACTED:|<)[^']{4,}'` +
    `|${UNQUOTED_VALUE}{4,})`,
  "gi",
);

/**
 * An `Authorization` header whose credential is not a `Bearer` token (that one has its own
 * pattern). An optional scheme word (`Basic`, `Token`, `Digest`, …) is kept; the credential
 * after it is redacted. Group 1 = name and separator, 2 = optional scheme, 3/4/5 = value.
 */
const AUTHORIZATION = new RegExp(
  `(?<![A-Za-z0-9_-])(Authorization["']?\\s*[=:]\\s*["']?)((?:Basic|Token|Digest|Negotiate|ApiKey|Api-Key)\\s+)?` +
    `(?!Bearer\\s|\\[REDACTED:|<)(${UNQUOTED_VALUE}{8,})`,
  "gi",
);

/** A UUID, dashes and all. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A fallback candidate: 32 or more base62 / base64url characters, with nothing glued to
 * either end that makes it part of a larger token (`+ / . %` and word characters), and
 * not after an integrity or digest prefix or a `base64,` data-URI marker. A single `=`
 * before the run is an assignment (`VAR=<value>`, `--session=<value>`) and is allowed; a
 * run after `==`, or one that ends in `=` (base64 padding), is part of an encoded blob.
 */
const CANDIDATE = new RegExp(
  `(?<![A-Za-z0-9_+/.%-])(?<!==)(?<!sha(?:1|224|256|384|512)[-:])(?<!base64,)` +
    `[A-Za-z0-9_-]{${FALLBACK_MIN_LENGTH},}(?![A-Za-z0-9_+/=.%-])`,
  "g",
);

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

/** An ordinary word inside an identifier: `Billing`, `period`, or an upper-case `HTTPS`. */
const WORD = /[A-Z][a-z]{3,}|[a-z]{4,}|[A-Z]{4,}/g;

/**
 * A run made mostly of ordinary words — a long branch, a release tag, a snake_case,
 * camelCase or PascalCase identifier, a folder name with a year or a version in it —
 * rather than random characters. Digits and short fragments count against the run
 * (separators do not), so `getBillingPeriodV2StartTimestamp` is words and
 * `9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR` is not: a random string rarely holds a lower-case run
 * of four letters.
 */
function looksLikeWords(candidate: string): boolean {
  let wordChars = 0;
  for (const word of candidate.match(WORD) ?? []) wordChars += word.length;
  return wordChars / candidate.replace(/[-_]/g, "").length >= WORDLIKE_SHARE;
}

/** Words that label an environment, a region, a service or a release in a deployment name. */
const NAME_WORDS: ReadonlySet<string> = new Set([
  "api",
  "app",
  "auth",
  "backend",
  "billing",
  "blue",
  "build",
  "canary",
  "checkout",
  "cluster",
  "controller",
  "default",
  "deploy",
  "deployment",
  "dev",
  "east",
  "frontend",
  "gateway",
  "green",
  "ingest",
  "ingress",
  "internal",
  "job",
  "main",
  "migration",
  "north",
  "prod",
  "production",
  "release",
  "replica",
  "rollout",
  "service",
  "south",
  "staging",
  "stage",
  "test",
  "web",
  "west",
  "worker",
]);

/**
 * A long hyphenated or underscored name — a pod, a release, a deployment — made of short
 * segments of which at least three are ordinary deployment words
 * (`web-frontend-7d9f8b6c5d-x2k9q-canary-blue-green-2026-10-07`).
 *
 * Judged only when EVERY segment is short: a random key joined to labels
 * (`prod-api-token-v2-<32 random characters>`) has a long segment and is never a name.
 */
function looksLikeSegmentedName(candidate: string): boolean {
  const segments = candidate.split(/[-_]/);
  if (segments.length < 5 || segments.some((segment) => segment.length > NAME_SEGMENT_MAX)) {
    return false;
  }
  return segments.filter((segment) => NAME_WORDS.has(segment.toLowerCase())).length >= 3;
}

/** Does this candidate look like a random credential rather than a name or a hash? */
function looksRandom(candidate: string): boolean {
  if (UUID_SHAPE.test(candidate)) return false;
  // A package integrity value or image digest the lookbehind cannot see, because the
  // candidate run includes its own `sha256-` prefix.
  if (/^sha(?:1|224|256|384|512)-/i.test(candidate)) return false;
  if (looksLikeWords(candidate) || looksLikeSegmentedName(candidate)) return false;
  // A long run of digits (a timestamp, an account number, zero padding) is a number, not a key.
  if (/\d{8,}/.test(candidate)) return false;
  // A label joined to a hash (`main-<40 hex>`, an image tag): the hash is not a credential.
  if (
    candidate
      .split(/[-_]/)
      .some((segment) => segment.length >= 32 && /^[0-9a-fA-F]+$/.test(segment))
  )
    return false;
  // Hex-only: a git SHA, an MD5/SHA digest or a content hash. Masked only under a name.
  if (/^[0-9a-fA-F]+$/.test(candidate)) return false;
  // A credential mixes letters and digits; a long word or a numeric id does not.
  if (!/[A-Za-z]/.test(candidate) || !/[0-9]/.test(candidate)) return false;
  return entropyOf(candidate) >= FALLBACK_MIN_ENTROPY;
}

/**
 * Replace secrets the pattern scrubber cannot recognise. Idempotent: a second run over its
 * own output changes nothing.
 */
export function redactSecrets(input: string): string {
  if (input.length === 0) return input;

  let out = input.replace(
    KEY_NAME_ASSIGNMENT,
    (_m, name: string, sep: string, dq: string | undefined, sq: string | undefined) => {
      const quote = dq ?? sq ?? "";
      return `${name}${sep}${quote}${NAME_RULE_PLACEHOLDER}${quote}`;
    },
  );

  out = out.replace(
    AUTHORIZATION,
    (_m, head: string, scheme: string | undefined) =>
      `${head}${scheme ?? ""}${NAME_RULE_PLACEHOLDER}`,
  );

  out = out.replace(CANDIDATE, (candidate) =>
    looksRandom(candidate) ? GENERIC_PLACEHOLDER : candidate,
  );

  return out;
}
