/**
 * The secret scrubber: the `standard` pattern set, applied to a single string.
 *
 * Used by the decision log, the `scan` report and crash reporting, each of which scrubs
 * exactly once. Guard-specific redaction — filesystem paths in a stack trace or a scan
 * finding — lives in separate modules composed at the call site
 * (`scrubPaths(scrubText(text).text)`), never as a pattern here.
 *
 * It covers all 14 `standard` patterns and nothing else: no configuration object, no
 * per-organization patterns, no attribute-path allowlist. The guard scrubs whole
 * strings, one at a time, and records commands, never tool output.
 *
 * ── Discipline ─────────────────────────────────────────────────────────────
 *
 * Pure. No imports, no I/O, no logging. The secret value is never returned,
 * logged, or counted by value — only `{ patternId → count }`. Every regex is
 * compiled once at module load; each pattern is a single `String.replace` pass.
 */

/** Per-pattern redaction tally. Maps a pattern id → number of redactions. */
export type RedactionCounts = Readonly<Record<string, number>>;

/** Result of scrubbing one string. The original secret is never included. */
export interface ScrubResult {
  /** Redacted text (unchanged content when nothing matched). */
  readonly text: string;
  /** Per-pattern-id redaction counts. Empty when nothing was redacted. */
  readonly redactions: RedactionCounts;
  /** Total redactions across all patterns (sum of `redactions` values). */
  readonly total: number;
}

/** One catalog entry: a pre-compiled regex plus its placeholder builder. */
interface ScrubPattern {
  /** Stable id — the redaction tally key. Must match the real catalog's id. */
  readonly id: string;
  /** Pre-compiled, global-flagged matcher. */
  readonly regex: RegExp;
  /**
   * Build the replacement placeholder for one match. `groups` is the regex's
   * capture array (`groups[0]` = whole match). MUST NOT echo the secret value.
   */
  readonly placeholder: (groups: RegExpExecArray) => string;
}

/** Canonical placeholder shape: `[REDACTED:<kind>:<hint>]`. */
function redacted(kind: string, hint?: string): string {
  return hint ? `[REDACTED:${kind}:${hint}]` : `[REDACTED:${kind}]`;
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/**
 * AWS access key id — `AKIA`/`ASIA`/`AGPA`… + 16 base32-ish chars. Safe hint =
 * last-4 of the *id* (not a secret value); a key id is a public-ish identifier.
 */
const AWS_ACCESS_KEY_ID =
  /\b((?:AKIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|ASCA|ASIA)[A-Z0-9]{16})\b/g;

/**
 * AWS secret access key — 40-char base64-ish value, **context-anchored** to an
 * `aws_secret_access_key` / `secret_access_key` assignment. Two guards keep a
 * 40-hex git SHA from being redacted as a secret: the key-name context anchor,
 * and the explicit `(?![0-9a-f]{40}…)` hex exclusion. Group 1 = key name,
 * group 2 = the original separator (incl. the value's opening quote, so quoted
 * JSON stays balanced), group 3 = the redacted value.
 */
const AWS_SECRET_ACCESS_KEY = new RegExp(
  "((?:aws[_-]?)?secret[_-]?access[_-]?key)([\"']?\\s*[=:]\\s*[\"']?)" +
    "((?![0-9a-f]{40}(?![A-Za-z0-9/+=]))[A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])",
  "gi",
);

/** OpenAI-style key: `sk-` + 20-64 url-safe chars (covers `sk-proj-` too). */
const OPENAI_KEY = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,64}\b/g;

/** GitHub PAT / OAuth / app tokens: `ghp_` `gho_` `ghu_` `ghs_` `ghr_` `github_pat_`. */
const GITHUB_TOKEN =
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g;

/** Slack tokens: `xoxb-`/`xoxp-`/`xoxa-`/`xoxr-`/`xoxs-` + dotted segments. */
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g;

/**
 * HTTP Bearer token in an Authorization-style value. **Case-insensitive** — raw
 * header capture commonly emits the scheme lower-cased, and a case-sensitive
 * anchor left every lowercase bearer token unscrubbed. The accepted cost is that
 * an incidental prose "bearer <8+ token-ish chars>" is also redacted: losing one
 * benign word beats leaking a real lowercase bearer token.
 */
const BEARER_TOKEN = /\bBearer\s+([A-Za-z0-9._~+/-]{8,})=*/gi;

/**
 * Credentialed connection string for common datastores. The whole `user:pass@`
 * userinfo is consumed; group 2 captures ONLY the host, for a non-sensitive
 * `host=<host>` hint. The password class allows `@` and `/` and the host is
 * anchored to the LAST `@` — otherwise `P@ssw0rd` leaks `ssw0rd` into the hint
 * and `pa/ss` misses entirely, persisting the full credential.
 */
const CONNECTION_STRING =
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s/@:]+:[^\s]*@([^\s/:@]+)/gi;

/** JWT: three base64url segments. Claims are NEVER stored in the placeholder. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/** PEM private-key block (RSA / EC / OPENSSH / generic). */
const PEM_PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]{0,8192}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g;

/**
 * HTTP basic-auth credentials embedded in a URL (`user:pass@host`, any scheme).
 * Same robust userinfo shape as `CONNECTION_STRING`, so a password containing
 * `@` or `/` is fully consumed rather than leaving a residual `ssw0rd@`.
 */
const BASIC_AUTH_URL = /\b(https?|ftp|wss?):\/\/[^\s/@:]+:[^\s]*@(?=[^\s/:@])/gi;

/**
 * `.env`-style secret assignment: a KEY whose name implies a secret, followed by
 * `=`/`:` and a value. The value is redacted; the key NAME and the ORIGINAL
 * separator are preserved so the trace stays debuggable and quoted JSON stays
 * balanced. Covers `.env` (`PASSWORD=v`), YAML/prose (`password: v`) and JSON
 * (`"password": "v"`). The value is a three-branch alternation so a quoted value
 * may contain SPACES while an unquoted one still stops at the first terminator.
 * Group 1 = key name, group 2 = separator, groups 3/4/5 = value branches.
 */
const ENV_SECRET_ASSIGNMENT = (() => {
  const sentinel = String.fromCharCode(0xe000);
  const key =
    "([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH[_-]?TOKEN|CREDENTIALS?)[A-Z0-9_]*)";
  // Quoted branches allow spaces (stop only at the matching closing quote);
  // unquoted branch keeps the whitespace/terminator bound. All exclude the
  // sentinel so an already-inserted placeholder is never re-consumed.
  const value =
    `(?:"([^"${sentinel}]{4,})"` + `|'([^'${sentinel}]{4,})'` + `|([^\\s"',;${sentinel}]{4,}))`;
  return new RegExp(`\\b${key}(["']?\\s*[=:]\\s*)${value}`, "gi");
})();

// ── PII ──────────────────────────────────────────────────────────────────────

/** Email address. */
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g;

/** US Social Security Number (`123-45-6789` / `123 45 6789`). */
const SSN = /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g;

/**
 * Candidate card number (Luhn-validated below). Two non-bridging shapes:
 * contiguous 13-19 digits, or 3-5 groups of 3-6 digits joined by a SINGLE,
 * CONSISTENT separator (the `\1` backreference is what stops the pattern
 * bridging two unrelated numbers across a stray space or dash).
 */
const CREDIT_CARD = /\b\d{13,19}\b|\b\d{3,6}([ -])\d{3,6}(?:\1\d{3,6}){1,3}\b/g;

/**
 * The ordered catalog — the `standard` patterns, in application order.
 *
 * **Order is load-bearing and is asserted, not assumed.** Patterns apply
 * sequentially and the first match wins on overlapping shapes, so a reordering
 * changes output without changing membership, so `PATTERN_IDS` is pinned as an
 * ORDERED list.
 *
 * TRIPWIRE — NUMBERED GROUPS ONLY. `applyPattern` reconstructs each placeholder
 * builder's group array with `args.slice(0, args.length - 2)`, dropping the
 * trailing `offset` + `fullString` that `String.replace` appends. A NAMED capture
 * group (`(?<name>…)`) makes `replace` append an EXTRA trailing `groups` object,
 * shifting that slice and corrupting `g[n]`. Every pattern here uses numbered
 * groups only. If you add a `(?<name>…)` group you MUST fix the slice too.
 */
const PATTERNS: readonly ScrubPattern[] = [
  {
    id: "aws-access-key-id",
    regex: AWS_ACCESS_KEY_ID,
    placeholder: (g) => redacted("secret:aws", `…${g[1].slice(-4)}`),
  },
  {
    id: "pem-private-key",
    regex: PEM_PRIVATE_KEY,
    placeholder: () => redacted("secret:private-key"),
  },
  {
    id: "jwt",
    regex: JWT,
    placeholder: () => redacted("secret:jwt", "claims-not-stored"),
  },
  {
    id: "github-token",
    regex: GITHUB_TOKEN,
    placeholder: () => redacted("secret:github"),
  },
  {
    id: "slack-token",
    regex: SLACK_TOKEN,
    placeholder: () => redacted("secret:slack"),
  },
  {
    id: "openai-key",
    regex: OPENAI_KEY,
    placeholder: () => redacted("secret:api-key"),
  },
  {
    id: "connection-string",
    regex: CONNECTION_STRING,
    // Hint = host only (group 2). The host is not a secret; credentials
    // (user:pass) are never captured, so none leak.
    placeholder: (g) => redacted("secret:connection-string", `host=${g[2]}`),
  },
  {
    id: "basic-auth-url",
    regex: BASIC_AUTH_URL,
    // Keep the scheme so the URL stays recognizable; redact user:pass@.
    placeholder: (g) => `${g[1].toLowerCase()}://${redacted("secret:basic-auth")}@`,
  },
  {
    id: "bearer-token",
    regex: BEARER_TOKEN,
    placeholder: () => `Bearer ${redacted("secret:bearer")}`,
  },
  {
    id: "aws-secret-access-key",
    regex: AWS_SECRET_ACCESS_KEY,
    // Preserve the key name (g1) + the original separator (g2, incl. the value's
    // opening quote); redact only the 40-char value. Re-emitting g2 rather than a
    // hard-coded `=` keeps `key: "val"` from becoming `key="val` (dangling quote).
    placeholder: (g) => `${g[1]}${g[2]}${redacted("secret:aws-secret")}`,
  },
  {
    id: "env-secret",
    regex: ENV_SECRET_ASSIGNMENT,
    // Preserve the key name (g1) + the original separator (g2); redact only the
    // value (g3/g4/g5 — which branch matched is irrelevant).
    placeholder: (g) => `${g[1]}${g[2]}${redacted("secret:env")}`,
  },
  {
    id: "email",
    regex: EMAIL,
    placeholder: () => redacted("pii:email"),
  },
  {
    id: "ssn",
    regex: SSN,
    placeholder: () => redacted("pii:ssn"),
  },
  {
    id: "credit-card",
    regex: CREDIT_CARD,
    placeholder: () => redacted("pii:credit-card"),
  },
];

/** The pattern ids, in catalog order. Exported so tests can assert the exact ordered list. */
export const PATTERN_IDS: readonly string[] = PATTERNS.map((p) => p.id);

/** Pattern ids that require Luhn validation before the match counts (cards). */
const LUHN_VALIDATED_IDS: ReadonlySet<string> = new Set(["credit-card"]);

/**
 * Luhn checksum over the digits of `candidate` (non-digits ignored). Rejects
 * false-positive "card numbers" — order ids, long counters — in the engine.
 */
function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' = 48
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Sentinel character delimiting an already-inserted placeholder. A Unicode
 * private-use code point (U+E000) — NOT a control character — that no catalog
 * regex matches and that never appears in real telemetry. Each emitted
 * placeholder is wrapped in sentinels so it is inert to every *later* pattern in
 * the pass: a placeholder is never re-scanned and re-redacted (e.g.
 * `[REDACTED:secret:private-key]` being clipped by the broad `.env` heuristic).
 * Sentinels are restored to the real placeholders in one final pass. Built via
 * `String.fromCharCode` / `RegExp` so no private-use char appears as a source
 * literal (Biome `noControlCharactersInRegex`).
 */
const SENTINEL_CHAR = String.fromCharCode(0xe000);
const SENTINEL_RE = new RegExp(`${SENTINEL_CHAR}(\\d+)${SENTINEL_CHAR}`, "g");

function sentinel(index: number): string {
  return `${SENTINEL_CHAR}${index}${SENTINEL_CHAR}`;
}

/**
 * Run one pattern over `text`, redacting matches into sentinels and tallying the
 * count. Emitted placeholders are pushed to `slots` and replaced by an inert
 * sentinel so subsequent patterns cannot match inside them.
 *
 * For Luhn-validated patterns (credit card), a match that fails the checksum is
 * left untouched AND NOT COUNTED — the tally must agree with the real engine's,
 * not just the text.
 */
function applyPattern(
  text: string,
  pattern: ScrubPattern,
  tally: Record<string, number>,
  slots: string[],
): string {
  const needsLuhn = LUHN_VALIDATED_IDS.has(pattern.id);
  // `String.replace` resets the regex's lastIndex, so the shared global regex is
  // safe to reuse across calls. Do NOT swap any of these for `.test()`/`.exec()`.
  return text.replace(pattern.regex, (...args) => {
    // args = [match, ...groups, offset, fullString] — and a trailing
    // `namedGroups` object ONLY if the regex declares a named group. See the
    // TRIPWIRE on PATTERNS: no pattern here declares one.
    const match = args[0] as string;
    if (needsLuhn && !passesLuhn(match)) return match; // false positive — keep.
    const groups = args.slice(0, args.length - 2) as unknown as RegExpExecArray;
    tally[pattern.id] = (tally[pattern.id] ?? 0) + 1;
    const slot = slots.length;
    slots.push(pattern.placeholder(groups));
    return sentinel(slot);
  });
}

/**
 * Scrub a single string against the `standard` pattern set.
 *
 * @param text - The value to scrub. Empty short-circuits.
 * @returns `{ text, redactions, total }`. The secret value is never surfaced.
 */
export function scrubText(text: string): ScrubResult {
  if (text.length === 0) {
    return { text, redactions: {}, total: 0 };
  }

  const tally: Record<string, number> = {};
  const slots: string[] = [];
  // Strip any pre-existing sentinel char so it can't collide with our placeholder
  // scheme during scanning. This is a WORKING COPY; if nothing is redacted we
  // discard it and return the ORIGINAL `text` untouched, so a legitimate U+E000 in
  // content is never deleted on a zero-redaction value.
  let out = text.includes(SENTINEL_CHAR) ? text.split(SENTINEL_CHAR).join("") : text;

  for (const pattern of PATTERNS) {
    out = applyPattern(out, pattern, tally, slots);
  }

  // Nothing matched — return the original text verbatim (do NOT leak the
  // sentinel-stripped working copy, which would delete legitimate U+E000 chars).
  if (slots.length === 0) {
    return { text, redactions: {}, total: 0 };
  }

  // Restore sentinels to their real placeholders in one final pass.
  out = out.replace(SENTINEL_RE, (_m, idx: string) => slots[Number(idx)]);

  let total = 0;
  for (const k in tally) total += tally[k];
  return { text: out, redactions: tally, total };
}
