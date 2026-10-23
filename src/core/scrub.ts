// cspell:words nghp mghp nrtfb prefilter dempotency nohup ugnskcd
/**
 * The secret scrubber: the `standard` pattern set, applied to a single string.
 *
 * Used by the decision log, the `scan` report and crash reporting, each of which scrubs
 * exactly once. Guard-specific redaction — filesystem paths in a stack trace or a scan
 * finding — lives in separate modules composed at the call site
 * (`scrubPaths(scrubText(text).text)`), never as a pattern here.
 *
 * It covers all 19 `standard` patterns and nothing else: no configuration object, no
 * per-organization patterns, no attribute-path allowlist. The guard scrubs whole
 * strings, one at a time, and records commands, never tool output.
 *
 * ── Discipline ─────────────────────────────────────────────────────────────
 *
 * Pure. No I/O, no logging; the one import is the long-random test it shares with
 * `redact-secrets.ts`. The secret value is never returned,
 * logged, or counted by value — only `{ patternId → count }`. Every regex is
 * compiled once at module load; each pattern is a single `String.replace` pass.
 */

import { FALLBACK_MIN_LENGTH, looksRandom } from "./redact-secrets.js";

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
  /** Optional second check on a match; a match it rejects is kept and not counted. */
  readonly accept?: (match: string) => boolean;
  /**
   * Optional cheap, non-global test the text must pass before `regex` runs: a word every match
   * contains. A pattern whose lead-in is a lookbehind alternation is tried at every position, so
   * skipping it on text that cannot match keeps scrubbing fast.
   */
  readonly prefilter?: RegExp;
}

/** Canonical placeholder shape: `[REDACTED:<kind>:<hint>]`. */
function redacted(kind: string, hint?: string): string {
  return hint ? `[REDACTED:${kind}:${hint}]` : `[REDACTED:${kind}]`;
}

/**
 * Where a secret may start: a word boundary, or right after an escape sequence or a
 * terminal control code that a word boundary cannot see.
 *
 * Text reaches the scrubber JSON-escaped (`line one\nghp_…`) or coloured by a terminal
 * (`ESC[32mghp_…`, or `\u001b[32m…` once escaped). In each of those the character right
 * before the secret is a letter (`n`, `t`, `m`, `K`) or a hex digit, so `\b` does not hold.
 * Each shape keeps `\b` and adds lookbehinds for an escaped `\n` `\r` `\t` `\f` `\b`, a
 * `\uXXXX` escape, any ANSI CSI sequence (`ESC[` parameters, then any final byte `@` to
 * `~`: colour codes including the colon form, erase-line, cursor moves) raw or escaped as
 * `\u001b[`, `\x1b[` or `\033[`, and a character-set switch (`ESC(B`), raw or escaped.
 *
 * It only adds match positions after one of those sequences, so a secret glued to a word
 * is still not matched, and the text is scrubbed where it lies, so each placeholder lands
 * at the secret's own offset. Each lookbehind is bounded (at most 8 characters, or 32
 * parameter characters of a CSI sequence).
 *
 * Not covered: URL-encoded characters (`%0A`), hex or octal escapes in a string literal
 * (`\x0a`, `\012`), and other encodings that would need decoding first.
 */
const ESCAPE_BOUNDARY = String.raw`(?<=\\[nrtfb])|(?<=\\u[0-9A-Fa-f]{4})|(?<=\x1b\[[0-9;:?]{0,32}[@-~])|(?<=\\(?:u001[bB]|x1[bB]|033)\[[0-9;:?]{0,32}[@-~])|(?<=\x1b\([0-9A-Za-z])|(?<=\\(?:u001[bB]|x1[bB]|033)\([0-9A-Za-z])`;
const LEAD = `(?:\\b|${ESCAPE_BOUNDARY})`;

/**
 * Where a NAME may start: not glued to a word character, a `_` or a `-` before it (so
 * `X-Vendor-Key` matches from `X`, never from `Vendor`), or after an escape or colour code.
 */
const NAME_LEAD = `(?:(?<![A-Za-z0-9_-])|${ESCAPE_BOUNDARY})`;

/**
 * A name rule never starts inside a placeholder, nor takes one as its value. Without these,
 * scrubbing already-scrubbed text read `[REDACTED:secret:github]` as a key `secret`, a `:`
 * and a value `github]`, and mangled the placeholder.
 */
const NOT_IN_PLACEHOLDER = String.raw`(?<!\[REDACTED:)`;
// Only a value that IS a placeholder, followed by a quote, a separator or the end: a real
// value glued onto a placeholder (`[REDACTED:secret:env]<secret>`) is still redacted whole.
const NOT_A_PLACEHOLDER = String.raw`(?!["']?\[REDACTED:[a-z0-9:-]+\]["']?(?:[\s,;}\])]|$))`;

/** A pattern that starts at `LEAD`. `source` is written without a leading `\b`. */
function led(source: string, flags: string): RegExp {
  return new RegExp(`${LEAD}${source}`, flags);
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/**
 * AWS access key id — `AKIA`/`ASIA`/`AGPA`… + 16 base32-ish chars. Fully redacted:
 * the label carries NO part of the id, not even the last-4 — those four characters
 * fingerprint the key, and a shared scan report should disclose nothing that identifies it.
 */
const AWS_ACCESS_KEY_ID = led(
  String.raw`((?:AKIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|ASCA|ASIA)[A-Z0-9]{16})\b`,
  "g",
);

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
const OPENAI_KEY = led(String.raw`sk-(?:proj-)?[A-Za-z0-9_-]{20,64}\b`, "g");

/** GitHub PAT / OAuth / app tokens: `ghp_` `gho_` `ghu_` `ghs_` `ghr_` `github_pat_`. */
const GITHUB_TOKEN = led(
  String.raw`(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b|github_pat_[A-Za-z0-9_]{22,255}\b)`,
  "g",
);

/** Slack tokens: `xoxb-`/`xoxp-`/`xoxa-`/`xoxr-`/`xoxs-` + dotted segments. */
const SLACK_TOKEN = led(String.raw`xox[baprs]-[A-Za-z0-9-]{10,255}\b`, "g");

/**
 * HTTP Bearer token in an Authorization-style value. **Case-insensitive** — raw
 * header capture commonly emits the scheme lower-cased, and a case-sensitive
 * anchor left every lowercase bearer token unscrubbed. The accepted cost is that
 * an incidental prose "bearer <8+ token-ish chars>" is also redacted: losing one
 * benign word beats leaking a real lowercase bearer token.
 */
const BEARER_TOKEN = led(String.raw`Bearer\s+([A-Za-z0-9._~+/-]{8,})=*`, "gi");

/**
 * Credentialed connection string for common datastores. The whole `user:pass@host`
 * — credential AND host — is consumed and fully redacted; the label carries NO real
 * host, because a real hostname fingerprints the environment a shared scan report is
 * not meant to disclose. Group 2 still captures ONLY the host so the password class,
 * which allows `@` and `/`, is anchored to the LAST `@` — otherwise `P@ssw0rd` leaks
 * `ssw0rd` and `pa/ss` misses entirely, persisting the full credential — but the captured
 * host is used only for that anchoring, never echoed into the placeholder.
 */
const CONNECTION_STRING = led(
  String.raw`(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s/@:]+:[^\s]*@([^\s/:@]+)`,
  "gi",
);

/** JWT: three base64url segments. Claims are NEVER stored in the placeholder. */
const JWT = led(String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b`, "g");

/** PEM private-key block (RSA / EC / OPENSSH / generic). */
const PEM_PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]{0,8192}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g;

/**
 * HTTP basic-auth credentials embedded in a URL (`user:pass@host`, any scheme).
 * Same robust userinfo shape as `CONNECTION_STRING`, so a password containing
 * `@` or `/` is fully consumed rather than leaving a residual `ssw0rd@`.
 */
const BASIC_AUTH_URL = led(String.raw`(https?|ftp|wss?):\/\/[^\s/@:]+:[^\s]*@(?=[^\s/:@])`, "gi");

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
  // Each opening quote is its own group so the placeholder can put the quotes back, and the
  // output of a quoted JSON value stays valid JSON.
  const value =
    `(?:(")([^"${sentinel}]{4,})"` + `|(')([^'${sentinel}]{4,})'` + `|([^\\s"',;${sentinel}]{4,}))`;
  return new RegExp(
    `${LEAD}${NOT_IN_PLACEHOLDER}${key}(["']?\\s*[=:]\\s*)${NOT_A_PLACEHOLDER}${value}`,
    "gi",
  );
})();

/** The slot sentinel. Every value class below excludes it. */
const SLOT = String.fromCharCode(0xe000);

/**
 * A value after a key NAME in the two forms a credential is given under:
 *  - an UPPERCASE name ending in `_KEY`, as an env assignment with no space around `=`
 *    (`VENDOR_KEY=…`) or a quoted JSON / YAML key (`"VENDOR_KEY": "…"`);
 *  - a header name ending in `-Key` followed by `:` (`X-Vendor-Key: …`), except
 *    `Idempotency-Key`.
 * Lower-case code names (`primary_key=True`), constants that name a storage or lookup key
 * (`STORAGE_KEY = "app-theme"`, `TEAM_KEY: string`) and a value that is a path
 * (`SSH_KEY=~/.ssh/id_rsa`) do not match. Same value branches and groups as
 * `ENV_SECRET_ASSIGNMENT`.
 */
const KEY_NAME_ASSIGNMENT = new RegExp(
  `${NAME_LEAD}${NOT_IN_PLACEHOLDER}([A-Z0-9]+(?:_[A-Z0-9]+)*_KEY(?==|["']\\s*:)|(?![Ii]dempotency-)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[Kk][Ee][Yy](?=["']?\\s*:))` +
    `(["']?\\s*[=:]\\s*)${NOT_A_PLACEHOLDER}(?!["']?[~.]{0,2}/)` +
    `(?:(")([^"${SLOT}]{4,})"|(')([^'${SLOT}]{4,})'|([^\\s"',;${SLOT}]{4,}))`,
  "g",
);

/**
 * An `Authorization` or `Proxy-Authorization` header whose credential is not a `Bearer` token
 * (`bearer-token` runs first). An optional scheme word is kept; the credential after it is
 * redacted.
 */
const AUTHORIZATION_HEADER = new RegExp(
  `${NAME_LEAD}((?:Proxy-)?Authorization["']?\\s*[=:]\\s*["']?)((?:Basic|Token|Digest|Negotiate|ApiKey|Api-Key)\\s+)?` +
    `(?!Bearer\\s)${NOT_A_PLACEHOLDER}([^\\s"',;${SLOT}]{8,})`,
  "gi",
);

/**
 * The value glued to `-p` when the statement's program is `mysql*` / `mariadb*`, which take the
 * password attached to the flag. The program sits where a statement starts (the start of the
 * text, after `;` `|` `&` `(` or a raw or escaped newline, or as a JSON string's value), after
 * any `NAME=value` assignments, wrappers (`sudo`, `env`, `nice`, `nohup`, `time`, `timeout`,
 * `xargs`, `exec`, `command`) with their options, and a path. A word that only starts with
 * `mysql` elsewhere (`docker run --name mysql -p3306:3306`, `find /var/lib/mysql -print`) is
 * not the program. A bare `-p` prompts and does not match. A quoted value (`'…'`, `"…"`, or
 * JSON-escaped `\"…\"`) is redacted with its quotes. 1 = the text up to and including `-p`.
 */
const MYSQL_PASSWORD_FLAG = (() => {
  const blank = "[ \\t]";
  const assignment = `[A-Za-z_]\\w*=[^\\s${SLOT}]*${blank}+`;
  // A short option that takes a value always takes it (`-u mysql` is a user), then any other
  // option, or a number (`timeout 5`).
  const option = `(?:-[ugnskcdUCD]${blank}+[^\\s${SLOT}-][^\\s${SLOT}]*|-(?![ugnskcdUCD]${blank})[^\\s${SLOT}]*|\\d[^\\s${SLOT}]*)${blank}+`;
  const wrapper = `(?:sudo|env|nice|nohup|time|timeout|xargs|exec|command)${blank}+(?:${option}|${assignment})*`;
  const start = `(?<=^|[;|&(\\n]|[:,[{]${blank}*"|\\\\n)`;
  const program = `(?:[^\\s${SLOT}"']*/)?(?:mysql\\w*|mariadb\\w*)(?![\\w.-])`;
  const value = `(?:'[^'\\n${SLOT}]*'|\\\\"[^"\\\\\\n${SLOT}]*\\\\"|"[^"\\n${SLOT}]*"|[^\\s"'${SLOT}]+)`;
  return new RegExp(
    `${start}(${blank}*(?:${assignment})*(?:${wrapper})*${program}[^\\n;|&${SLOT}]{0,200}?\\s-p)${NOT_A_PLACEHOLDER}${value}`,
    "g",
  );
})();

/**
 * Cloud account identifiers, redacted as PII: a variable or key that names one, an account
 * flag with an account's shape, the account field of an AWS ARN, and `--project` for the
 * Google Cloud tools.
 */
const CLOUD_ACCOUNT_ID = new RegExp(
  [
    `${NAME_LEAD}([A-Za-z0-9_]*(?:ACCOUNT[_-]?ID|CF_ACCOUNT|CLOUDFLARE_ACCOUNT|AWS_ACCOUNT|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|GCP_PROJECT|CORE_PROJECT))(["']?\\s*[=:]\\s*)(["']?)([^\\s"',;<[${SLOT}][^\\s"',;${SLOT}]*)\\3`,
    `(--(?:account-id|account|owner-id|account-number))(=|\\s+)(["']?)(\\d{12}|[0-9a-f]{32})\\7(?![A-Za-z0-9])`,
    `(?<=\\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)\\d{12}(?![A-Za-z0-9])`,
    `(?<=\\b(?:gcloud|gsutil|bq|firebase)\\b[^\\n;|&${SLOT}]{0,200}?)(--project(?:_id|-id)?)(=|\\s+)(["']?)([a-z][a-z0-9-]{4,28}[a-z0-9])\\11(?![A-Za-z0-9-])`,
  ].join("|"),
  "gi",
);

/**
 * A long-random-string candidate (32+ base62 / base64url characters, nothing glued to either
 * end); `looksRandom` decides whether it is a credential.
 */
const GENERIC_SECRET_CANDIDATE = new RegExp(
  `(?:(?<![A-Za-z0-9_+/.%-])|${ESCAPE_BOUNDARY})(?<!==)(?<!sha(?:1|224|256|384|512)[-:])(?<!base64,)` +
    `[A-Za-z0-9_-]{${FALLBACK_MIN_LENGTH},}(?![A-Za-z0-9_+/=.%-])`,
  "g",
);

/** A run long enough to be a `generic-secret` candidate: the cheap test before the full one. */
const GENERIC_SECRET_PREFILTER = new RegExp(`[A-Za-z0-9_-]{${FALLBACK_MIN_LENGTH}}`);

/** Re-emit a NAME=value match's name, separator and quotes around a placeholder. */
function aroundValue(
  name: string,
  separator: string,
  quote: string | undefined,
  label: string,
): string {
  const q = quote ?? "";
  return `${name}${separator}${q}${label}${q}`;
}

// ── PII ──────────────────────────────────────────────────────────────────────

/** Email address. */
const EMAIL = led(String.raw`[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b`, "g");

/** US Social Security Number (`123-45-6789` / `123 45 6789`). */
const SSN = led(String.raw`(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b`, "g");

/**
 * Candidate card number (Luhn-validated below). Two non-bridging shapes:
 * contiguous 13-19 digits, or 3-5 groups of 3-6 digits joined by a SINGLE,
 * CONSISTENT separator (the `\1` backreference is what stops the pattern
 * bridging two unrelated numbers across a stray space or dash).
 */
const CREDIT_CARD = led(String.raw`(?:\d{13,19}\b|\d{3,6}([ -])\d{3,6}(?:\1\d{3,6}){1,3}\b)`, "g");

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
    // No hint: the last-4 of the id fingerprints the key, so nothing of it is disclosed.
    placeholder: () => redacted("secret:aws"),
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
    // No hint: the host is captured (group 2) only to anchor the password class to the
    // last `@`; it is a real hostname and is not echoed into the placeholder.
    placeholder: () => redacted("secret:connection-string"),
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
    // Preserve the key name (g1) and the original separator (g2); redact only the value
    // (g4/g6/g7), putting back its quotes (g3/g5), so quoted JSON stays valid.
    placeholder: (g) => {
      const quote = g[3] ?? g[5] ?? "";
      return `${g[1]}${g[2]}${quote}${redacted("secret:env")}${quote}`;
    },
  },
  {
    id: "key-name-secret",
    regex: KEY_NAME_ASSIGNMENT,
    prefilter: /_KEY|-key/i,
    placeholder: (g) => aroundValue(g[1] ?? "", g[2] ?? "", g[3] ?? g[5], redacted("secret:env")),
  },
  {
    id: "authorization-header",
    regex: AUTHORIZATION_HEADER,
    prefilter: /authorization/i,
    placeholder: (g) => `${g[1] ?? ""}${g[2] ?? ""}${redacted("secret:auth")}`,
  },
  {
    id: "mysql-password-flag",
    regex: MYSQL_PASSWORD_FLAG,
    prefilter: /mysql|mariadb/i,
    placeholder: (g) => `${g[1] ?? ""}${redacted("secret:password")}`,
  },
  {
    id: "cloud-account-id",
    regex: CLOUD_ACCOUNT_ID,
    prefilter: /account|project|owner-id|arn:aws/i,
    placeholder: (g) => {
      const label = redacted("pii:account");
      if (g[1] !== undefined) return aroundValue(g[1], g[2] ?? "", g[3], label);
      if (g[5] !== undefined) return aroundValue(g[5], g[6] ?? "", g[7], label);
      if (g[9] !== undefined) return aroundValue(g[9], g[10] ?? "", g[11], label);
      return label;
    },
  },
  {
    id: "generic-secret",
    regex: GENERIC_SECRET_CANDIDATE,
    prefilter: GENERIC_SECRET_PREFILTER,
    accept: looksRandom,
    placeholder: () => redacted("secret:generic"),
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
  // A text that cannot hold a match skips the full scan (see `ScrubPattern.prefilter`).
  if (pattern.prefilter && !pattern.prefilter.test(text)) return text;
  const needsLuhn = LUHN_VALIDATED_IDS.has(pattern.id);
  // `String.replace` resets the regex's lastIndex, so the shared global regex is
  // safe to reuse across calls. Do NOT swap any of these for `.test()`/`.exec()`.
  return text.replace(pattern.regex, (...args) => {
    // args = [match, ...groups, offset, fullString] — and a trailing
    // `namedGroups` object ONLY if the regex declares a named group. See the
    // TRIPWIRE on PATTERNS: no pattern here declares one.
    const match = args[0] as string;
    if (needsLuhn && !passesLuhn(match)) return match; // false positive — keep.
    if (pattern.accept && !pattern.accept(match)) return match; // its second check said no.
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
