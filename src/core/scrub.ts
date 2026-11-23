// cspell:words pousr
// cspell:words nghp mghp nrtfb prefilter dempotency nohup ugnskcd cret uroot
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
import { isMysqlPasswordFlag } from "./scrub-mysql.js";

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
  readonly accept?: (match: string, offset: number, text: string) => boolean;
  /**
   * Optional cheap, non-global test the text must pass before `regex` runs: a word every match
   * contains. A pattern whose lead-in is a lookbehind alternation is tried at every position, so
   * skipping it on text that cannot match keeps scrubbing fast.
   */
  readonly prefilter?: RegExp;
  /**
   * Optional: a cheaper regex that gives the same result on a text `needs` says no to, because
   * the part it leaves out cannot match there.
   */
  readonly lighter?: { readonly needs: RegExp; readonly regex: RegExp };
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

/** The slot sentinel (U+E000). Every value class excludes it. */
const SLOT = String.fromCharCode(0xe000);

/**
 * A quote as JSON writes it at any depth up to 3: `"` in JSON, `\"` in a JSON string that holds
 * JSON, `\\\"` one level deeper, and so on (each level doubles the backslashes and adds one).
 * Every name rule takes this where it used to take `["']`, so `{\"password\":\"…\"}` reads as
 * a key and a value, as `{"password":"…"}` does. Bounded at 7 backslashes.
 */
const ESC_QUOTE = String.raw`(?:\\{0,7}["'])`;
/**
 * A backslash run that a quote does not follow (`\n`, `\\n`, `\\u00e9`): the only way a
 * backslash enters an unquoted value. A run that a quote follows is an escaped quote, which
 * closes the string the value is in, so no value can swallow it. The lookahead fixes where a run
 * ends, so a text splits into runs in one way only, whatever the run's length.
 */
const ESC_UNIT = String.raw`\\+(?![\\"])`;

/**
 * A value in an escaped-quoted string, `\"…\"` at any depth up to 3, read with JSON's own string
 * grammar at that depth. `group` is the number of the capture group holding the opener's
 * backslashes (b of them; the value is the group after it). Escaped b levels deep, the inner
 * string's backslash is b+1 backslashes and its quote is b backslashes and a quote. So the value
 * is a run of units, each a plain character or an inner backslash followed by one inner character
 * (a plain one, a backslash or a quote), and it closes at the first inner quote that is not
 * escaped: exactly the opener again. A value that is itself JSON, or that ends in a backslash,
 * closes where JSON closes it. Every unit is fixed by its first characters, so nothing
 * backtracks across units. Bounded at 1,024 units.
 */
function escapedQuotedValue(group: number): string {
  const opener = `\\${group}`;
  const innerBackslash = `${opener}\\\\`;
  const unit = `(?:[^"\\\\${SLOT}]|${innerBackslash}(?:[^"\\\\${SLOT}]|${innerBackslash}|${opener}"))`;
  return `(\\\\{1,7})"(${unit}{4,1024})${opener}"`;
}

/**
 * A double-quoted value read with JSON's string grammar (`\"` and `\\` are escapes inside it), so
 * `{"password":"ab\"cd"}` and a value that is itself JSON are taken whole, to the quote that
 * really closes them.
 */
const DOUBLE_QUOTED_UNIT = `(?:[^"\\\\${SLOT}]|\\\\[^${SLOT}])`;

/**
 * An unquoted value: no whitespace, quote, `,` or `;`, and a backslash only as `ESC_UNIT`, so the
 * value stops before an escaped closing quote and the backslash stays in the text.
 */
const UNQUOTED_UNIT = `(?:[^\\s"',;\\\\${SLOT}]|${ESC_UNIT})`;

/**
 * A URL password too long for the bounded search for its `@` (the 512-character run in
 * `CONNECTION_STRING` and `BASIC_AUTH_URL`): the token, 512 characters or more. When the run up to
 * the first quote or backslash holds an `@`, only that run is taken, so the quote that closes a
 * JSON string stays. Otherwise the whole token up to whitespace is taken, quotes and backslashes
 * included, so a password holding one is still redacted (and the closing quote of a JSON string
 * around it goes with it). Either way the match is taken whole, so the scan never restarts inside
 * it and stays linear, and the rule's `accept` check keeps it only when it holds an `@`: a long
 * URL with no credential is left as it is. The host and path are redacted with the password; a
 * long URL followed by an `@` more than 512 characters later in the same whitespace-free token (in
 * its path or query, or a later field of a no-space line) is redacted to the end of the token.
 */
const URL_LONG_PASSWORD = String.raw`(?:(?=[^\s"'\\]*@)[^\s"'\\]{512,}|[^\s]{512,})`;

/** A URL rule's match is a credential only when it holds an `@` (see `URL_LONG_PASSWORD`). */
function hasAt(match: string): boolean {
  return match.includes("@");
}

// Only a value that IS a placeholder, followed by a quote, a separator or the end: a real
// value glued onto a placeholder (`[REDACTED:secret:env]<secret>`) is still redacted whole.
const NOT_A_PLACEHOLDER = String.raw`(?!${ESC_QUOTE}?\[REDACTED:[a-z0-9:-]+\]${ESC_QUOTE}?(?:[\s,;}\])]|$))`;

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
  `((?:aws[_-]?)?secret[_-]?access[_-]?key)(${ESC_QUOTE}?\\s*[=:]\\s*${ESC_QUOTE}?)` +
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
 *
 * The user may be empty (`redis://:password@cache`). The host stops at a quote, a backslash,
 * `,` `}` or `]`, so a URL with no port inside JSON keeps the quote that closes its string. The
 * search for the last `@` is bounded at 512 characters: unbounded, a text of repeated schemes
 * (`redis://u:redis://u:…`) took quadratic time. A longer userinfo is taken with the rest of its
 * token instead (`URL_LONG_PASSWORD`), and kept as a credential only if it holds an `@`
 * (`hasAt`), so it is still redacted and the scan stays linear.
 */
const CONNECTION_STRING = led(
  String.raw`(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s/@:]*:(?:[^\s]{0,512}@([^\s/:@"'\\,}\]]+)|${URL_LONG_PASSWORD})`,
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
 * `@` or `/` is fully consumed rather than leaving a residual `ssw0rd@`. The user may be empty,
 * and the search for the `@` is bounded at 512 with `URL_LONG_PASSWORD` beyond it, as there. The rule's own placeholder is never read
 * again as a user, so a second scrub leaves it as it is.
 */
const BASIC_AUTH_URL = led(
  String.raw`(https?|ftp|wss?):\/\/(?!\[REDACTED:)[^\s/@:]*:(?:[^\s]{0,512}@(?=[^\s/:@])|(${URL_LONG_PASSWORD}))`,
  "gi",
);

/**
 * `.env`-style secret assignment: a KEY whose name implies a secret, followed by
 * `=`/`:` and a value. The value is redacted; the key NAME and the ORIGINAL
 * separator are preserved so the trace stays debuggable and quoted JSON stays
 * balanced. Covers `.env` (`PASSWORD=v`), YAML/prose (`password: v`) and JSON
 * (`"password": "v"`), and escaped JSON at any depth up to 3 (`\"password\":\"v\"`). The value
 * is an alternation so a quoted value may contain SPACES while an unquoted one still stops at the
 * first terminator, and before an escaped closing quote. A double-quoted value is read with JSON's
 * escapes, so `\"` inside it does not close it. Groups: 1 = key name, 2 = separator,
 * 3 = the escaped opener's backslashes, 4 = escaped value, 5/6 = `"` opener and value,
 * 7/8 = `'` opener and value, 9 = unquoted value.
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
    `(?:${escapedQuotedValue(3)}` +
    `|(")(${DOUBLE_QUOTED_UNIT}{4,})"` +
    `|(')([^'${sentinel}]{4,})'` +
    `|(${UNQUOTED_UNIT}{4,}))`;
  return new RegExp(
    `${LEAD}${NOT_IN_PLACEHOLDER}${key}(${ESC_QUOTE}?\\s*[=:]\\s*)${NOT_A_PLACEHOLDER}${value}`,
    "gi",
  );
})();

/** A word every `.env`-style secret name holds: the cheap test before `ENV_SECRET_ASSIGNMENT`. */
const ENV_SECRET_KEY_WORD =
  /PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL/i;

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
  `${NAME_LEAD}${NOT_IN_PLACEHOLDER}([A-Z0-9]+(?:_[A-Z0-9]+)*_KEY(?==|${ESC_QUOTE}\\s*:)|(?![Ii]dempotency-)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[Kk][Ee][Yy](?=${ESC_QUOTE}?\\s*:))` +
    `(${ESC_QUOTE}?\\s*[=:]\\s*)${NOT_A_PLACEHOLDER}(?!${ESC_QUOTE}?[~.]{0,2}/)` +
    `(?:${escapedQuotedValue(3)}|(")(${DOUBLE_QUOTED_UNIT}{4,})"|(')([^'${SLOT}]{4,})'|(${UNQUOTED_UNIT}{4,}))`,
  "g",
);

/**
 * An `Authorization` or `Proxy-Authorization` header whose credential is not a `Bearer` token
 * (`bearer-token` runs first). An optional scheme word is kept; the credential after it is
 * redacted.
 */
const AUTHORIZATION_HEADER = new RegExp(
  `${NAME_LEAD}((?:Proxy-)?Authorization${ESC_QUOTE}?\\s*[=:]\\s*${ESC_QUOTE}?)((?:Basic|Token|Digest|Negotiate|ApiKey|Api-Key)\\s+)?` +
    `(?!Bearer\\s)${NOT_A_PLACEHOLDER}(${UNQUOTED_UNIT}{8,})`,
  "gi",
);

/**
 * The value glued to `-p` when the statement's program is `mysql*` / `mariadb*` (`mysql -pS3cret`,
 * `docker exec db mysql -pS3cret`, `bash -c 'mysql -pS3cret'`). The regex only finds a candidate,
 * a ` -p<value>` with a `mysql` / `mariadb` word at most 200 characters before it; the `accept`
 * check (`isMysqlPasswordFlag`) then reads the statement in bounded code to decide whether that
 * word is the program rather than an argument (`docker run --name mysql -p3306:3306`). Every run
 * is bounded and the lookbehind runs only after a literal ` -p`, so the scan stays linear. A bare
 * `-p` prompts and does not match. A quoted value (`'…'`, `$'…'`, `"…"`, `\"…\"`) is redacted
 * with its quotes and any unquoted tail glued to it (`-p"S3cret"tail`); a quoted part runs to its
 * closing quote on the same line. After a bare `-p`, the quote that closes the outer string is
 * not a value (`isMysqlPasswordFlag` decides). An unquoted value stops at a separator, so
 * `mysql -pA&&mysql -pB` redacts both, and at a quote, which may close an outer string, raw or
 * JSON-escaped (`\"`). The second
 * alternative is an exec-form argv element (`["mysql", "-uroot", "-pS3cret"]`). 1 (or 2, for
 * argv) = the flag and what stands before it.
 * The flag is case-sensitive, since `-P` is the port flag, and the program word is not; a line
 * continuation (`\` and a newline) may stand between them.
 */
const MYSQL_WORD = "(?:[Mm][Yy][Ss][Qq][Ll]|[Mm][Aa][Rr][Ii][Aa][Dd][Bb])";
/**
 * An unquoted run: no whitespace, quote or separator. A JSON-escaped backslash (`\\`) is one
 * unit; a lone backslash counts only when a quote does not follow it (`\"` closes a
 * JSON-escaped string). Unrolled, so each character is read once:
 * `MYSQL_UNQUOTED_RUN` may be empty, `MYSQL_UNQUOTED_RUN1` holds at least one character.
 */
const MYSQL_UNQUOTED_CHAR = `[^\\s"'\`;|&)\\\\${SLOT}]`;
const MYSQL_BACKSLASH = `(?:\\\\\\\\|\\\\(?!["\\\\]))`;
const MYSQL_UNQUOTED_RUN = `${MYSQL_UNQUOTED_CHAR}*(?:${MYSQL_BACKSLASH}${MYSQL_UNQUOTED_CHAR}*)*`;
const MYSQL_UNQUOTED_RUN1 = `(?=${MYSQL_UNQUOTED_CHAR}|${MYSQL_BACKSLASH})${MYSQL_UNQUOTED_RUN}`;
const MYSQL_QUOTED =
  `(?:'[^'\\n${SLOT}]*'|\\$'(?:[^'\\\\\\n${SLOT}]|\\\\[^\\n${SLOT}]){0,1024}'` +
  `|\\\\"[^"\\\\\\n${SLOT}]*\\\\"|"[^"\\n${SLOT}]*")`;
const MYSQL_PASSWORD_FLAG = new RegExp(
  `(\\s-p)(?<=${MYSQL_WORD}(?:\\\\\\n|[^\\n]){0,200}\\s-p)${NOT_A_PLACEHOLDER}` +
    `(?:${MYSQL_QUOTED}${MYSQL_UNQUOTED_RUN}|${MYSQL_UNQUOTED_RUN1})` +
    `|([[,]\\s{0,8}\\\\?"-p)(?<=${MYSQL_WORD}[^\\n]{0,200}"-p)${NOT_A_PLACEHOLDER}` +
    `[^"\\\\\\n${SLOT}]+(?=\\\\?")`,
  "g",
);

/**
 * Cloud account identifiers, redacted as PII: a variable or key that names one, an account
 * flag with an account's shape, the account field of an AWS ARN, and `--project` for the
 * Google Cloud tools.
 */
const CLOUD_ACCOUNT_ID_PARTS = [
  `${NAME_LEAD}([A-Za-z0-9_]*(?:ACCOUNT[_-]?ID|CF_ACCOUNT|CLOUDFLARE_ACCOUNT|AWS_ACCOUNT|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|GCP_PROJECT|CORE_PROJECT))(${ESC_QUOTE}?\\s*[=:]\\s*)(\\\\{0,7}["']|)([^\\s"',;<[\\\\${SLOT}][^\\s"',;\\\\${SLOT}]*)\\3`,
  `(--(?:account-id|account|owner-id|account-number))(=|\\s+)(["']?)(\\d{12}|[0-9a-f]{32})\\7(?![A-Za-z0-9])`,
  `(?<=\\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)\\d{12}(?![A-Za-z0-9])`,
  `(?<=\\b(?:gcloud|gsutil|bq|firebase)\\b[^\\n;|&${SLOT}]{0,200}?)(--project(?:_id|-id)?)(=|\\s+)(["']?)([a-z][a-z0-9-]{4,28}[a-z0-9])\\11(?![A-Za-z0-9-])`,
];
const CLOUD_ACCOUNT_ID = new RegExp(CLOUD_ACCOUNT_ID_PARTS.join("|"), "gi");

/**
 * The same pattern without its Google Cloud alternative, for a text that names none of those
 * tools. That alternative starts with a lookbehind for the tool's name and can match nothing
 * without it, so the result is the same; its groups (9 to 12) are simply never set.
 */
const CLOUD_ACCOUNT_ID_WITHOUT_GCP = new RegExp(CLOUD_ACCOUNT_ID_PARTS.slice(0, 3).join("|"), "gi");

/** The Google Cloud tools `CLOUD_ACCOUNT_ID`'s last alternative needs before `--project`. */
const GCP_TOOL = /\b(?:gcloud|gsutil|bq|firebase)\b/i;

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

/**
 * The quote a name rule's value was in, to put back around the placeholder: the escaped opener's
 * backslashes and a quote (groups 3 and 4), a `"` (group 5) or a `'` (group 7). None for an
 * unquoted value.
 */
function valueQuote(g: RegExpExecArray): string | undefined {
  if (g[3] !== undefined) return `${g[3]}"`;
  return g[5] ?? g[7];
}

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
    prefilter: /AKIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|ASCA|ASIA/,
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
    prefilter: /eyJ/,
    placeholder: () => redacted("secret:jwt", "claims-not-stored"),
  },
  {
    id: "github-token",
    regex: GITHUB_TOKEN,
    prefilter: /gh[pousr]_|github_pat_/,
    placeholder: () => redacted("secret:github"),
  },
  {
    id: "slack-token",
    regex: SLACK_TOKEN,
    prefilter: /xox[baprs]-/,
    placeholder: () => redacted("secret:slack"),
  },
  {
    id: "openai-key",
    regex: OPENAI_KEY,
    prefilter: /sk-/,
    placeholder: () => redacted("secret:api-key"),
  },
  {
    id: "connection-string",
    regex: CONNECTION_STRING,
    // The long-password branch takes a whole long token; it is a credential only with an `@`.
    accept: hasAt,
    prefilter: /:\/\//,
    // No hint: the host is captured (group 2) only to anchor the password class to the
    // last `@`; it is a real hostname and is not echoed into the placeholder.
    placeholder: () => redacted("secret:connection-string"),
  },
  {
    id: "basic-auth-url",
    regex: BASIC_AUTH_URL,
    // The long-password branch takes a whole long token; it is a credential only with an `@`.
    accept: hasAt,
    prefilter: /:\/\//,
    // Keep the scheme so the URL stays recognizable; redact user:pass@.
    // A password too long to find its `@` (group 2) took the rest of the URL with it, so no `@`
    // follows the placeholder.
    placeholder: (g) =>
      `${g[1].toLowerCase()}://${redacted("secret:basic-auth")}${g[2] === undefined ? "@" : ""}`,
  },
  {
    id: "bearer-token",
    regex: BEARER_TOKEN,
    prefilter: /bearer/i,
    placeholder: () => `Bearer ${redacted("secret:bearer")}`,
  },
  {
    id: "aws-secret-access-key",
    regex: AWS_SECRET_ACCESS_KEY,
    prefilter: /secret[_-]?access[_-]?key/i,
    // Preserve the key name (g1) + the original separator (g2, incl. the value's
    // opening quote); redact only the 40-char value. Re-emitting g2 rather than a
    // hard-coded `=` keeps `key: "val"` from becoming `key="val` (dangling quote).
    placeholder: (g) => `${g[1]}${g[2]}${redacted("secret:aws-secret")}`,
  },
  {
    id: "env-secret",
    regex: ENV_SECRET_ASSIGNMENT,
    prefilter: ENV_SECRET_KEY_WORD,
    // Preserve the key name (g1) and the original separator (g2); redact only the value
    // (g4/g6/g8/g9), putting back its quotes (`valueQuote`), so quoted JSON stays valid at
    // every depth.
    placeholder: (g) => aroundValue(g[1], g[2], valueQuote(g), redacted("secret:env")),
  },
  {
    id: "key-name-secret",
    regex: KEY_NAME_ASSIGNMENT,
    prefilter: /_KEY|-key/i,
    placeholder: (g) => aroundValue(g[1] ?? "", g[2] ?? "", valueQuote(g), redacted("secret:env")),
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
    accept: isMysqlPasswordFlag,
    placeholder: (g) => `${g[1] ?? g[2] ?? ""}${redacted("secret:password")}`,
  },
  {
    id: "cloud-account-id",
    regex: CLOUD_ACCOUNT_ID,
    prefilter: /account|project|owner-id|arn:aws/i,
    lighter: { needs: GCP_TOOL, regex: CLOUD_ACCOUNT_ID_WITHOUT_GCP },
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
    prefilter: /@/,
    placeholder: () => redacted("pii:email"),
  },
  {
    id: "ssn",
    regex: SSN,
    prefilter: /\d{3}[- ]\d{2}[- ]\d{4}/,
    placeholder: () => redacted("pii:ssn"),
  },
  {
    id: "credit-card",
    regex: CREDIT_CARD,
    prefilter: /\d{13}|\d{3}[ -]\d{3}/,
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
  shortcuts: boolean,
): string {
  // A text that cannot hold a match skips the full scan (see `ScrubPattern.prefilter`).
  if (shortcuts && pattern.prefilter && !pattern.prefilter.test(text)) return text;
  const needsLuhn = LUHN_VALIDATED_IDS.has(pattern.id);
  const regex =
    shortcuts && pattern.lighter !== undefined && !pattern.lighter.needs.test(text)
      ? pattern.lighter.regex
      : pattern.regex;
  // `String.replace` resets the regex's lastIndex, so the shared global regex is
  // safe to reuse across calls. Do NOT swap any of these for `.test()`/`.exec()`.
  return text.replace(regex, (...args) => {
    // args = [match, ...groups, offset, fullString] — and a trailing
    // `namedGroups` object ONLY if the regex declares a named group. See the
    // TRIPWIRE on PATTERNS: no pattern here declares one.
    const match = args[0] as string;
    if (needsLuhn && !passesLuhn(match)) return match; // false positive — keep.
    // Its second check said no. It reads the match, where it starts, and the text around it.
    if (
      pattern.accept &&
      !pattern.accept(match, args[args.length - 2] as number, args[args.length - 1] as string)
    ) {
      return match;
    }
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
  return scrub(text, true);
}

/**
 * `scrubText` without the prefilters and lighter regexes, which are pure shortcuts. For the test
 * that holds them to giving the same result.
 */
export function scrubTextWithoutShortcuts(text: string): ScrubResult {
  return scrub(text, false);
}

/** `scrubText`, with or without its shortcuts. */
function scrub(text: string, shortcuts: boolean): ScrubResult {
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
    out = applyPattern(out, pattern, tally, slots, shortcuts);
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
