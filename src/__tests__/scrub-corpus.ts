// cspell:disable -- deliberately full of credential-SHAPED synthetic tokens.
// Spell-checking fabricated secret bodies is noise.
/**
 * The shared scrub fixture corpus.
 *
 * **Every value here is SYNTHETIC** — a canonical documentation dummy, a published
 * example, or an obviously fabricated body. Never a live credential.
 *
 * `scrub.test.ts` asserts the scrubber is *correct* over it: real secret shapes in, the
 * exact placeholder out. `NEGATIVE_FIXTURES` matters as much as `POSITIVE_FIXTURES`: a
 * scrubber that redacted everything would satisfy every positive fixture, and only the
 * negative ones fail it.
 *
 * It is not a `*.test.ts`, so vitest does not collect it as a suite and the
 * package's coverage config excludes it.
 */

/** A fixture that must produce exactly one redaction, of exactly one pattern. */
export interface PositiveFixture {
  /** The catalog pattern id this fixture exercises. */
  readonly id: string;
  /** The input string. Designed to trigger `id` and nothing else. */
  readonly input: string;
  /** The literal secret substring that MUST NOT survive scrubbing. */
  readonly secret: string;
  /** The exact placeholder the output MUST contain. */
  readonly placeholder: string;
}

/** A fixture that must survive scrubbing byte-identical. */
export interface NegativeFixture {
  readonly name: string;
  readonly input: string;
  /** Why it must not be redacted. Read this before "fixing" a failure here. */
  readonly why: string;
}

/**
 * Assembled at runtime so this file holds no contiguous Slack-token-shaped string: secret
 * scanners flag that shape even in a synthetic fixture.
 */
/** A random-looking key from a provider with no known format, assembled at runtime. */
const RANDOM_KEY = ["q7Xk2LmP9vR4", "tZ8wN3bY6cH1", "jF5sD0gAeUoI"].join("");

const SLACK_TOKEN = ["xoxb", "123456789012", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-");

/**
 * One positive fixture per pattern in the `standard` set, in catalog
 * order. **Completeness is asserted, not eyeballed** — `scrub.test.ts` checks this
 * list covers every id in `PATTERN_IDS`, because a corpus with a hole is precisely
 * the failure this exists to prevent.
 *
 * Every input is designed to yield `total === 1`. Where a second pattern *could*
 * have matched, the earlier pattern consumes the text into a sentinel first — the
 * `connection-string` and `aws-secret-access-key` entries below are exactly that
 * case, and they are in the corpus to hold that ordering behavior in place.
 */
export const POSITIVE_FIXTURES: readonly PositiveFixture[] = [
  {
    id: "aws-access-key-id",
    input: "aws sts get-caller-identity --profile AKIAIOSFODNN7EXAMPLE",
    secret: "AKIAIOSFODNN7EXAMPLE",
    // No hint: the last 4 of the key ID fingerprint the key, so nothing of it is disclosed.
    placeholder: "[REDACTED:secret:aws]",
  },
  {
    id: "pem-private-key",
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJY\nozo2t60EG8L0561g13R29\n-----END RSA PRIVATE KEY-----",
    secret: "MIIEowIBAAKCAQEAy8Dbv8prpJ",
    placeholder: "[REDACTED:secret:private-key]",
  },
  {
    id: "jwt",
    input:
      "curl -H 'x-auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk'",
    secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    // The hint must never carry claims — the payload segment decodes to real data.
    placeholder: "[REDACTED:secret:jwt:claims-not-stored]",
  },
  {
    id: "github-token",
    input: "gh auth login --with-token ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    secret: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    placeholder: "[REDACTED:secret:github]",
  },
  {
    id: "slack-token",
    input: `export SLACK_BOT=${SLACK_TOKEN}`,
    secret: SLACK_TOKEN,
    placeholder: "[REDACTED:secret:slack]",
  },
  {
    id: "openai-key",
    input: "OPENAI=sk-abcdefghijklmnopqrstuvwxyz012345 node ./bin/run.js",
    secret: "sk-abcdefghijklmnopqrstuvwxyz012345",
    placeholder: "[REDACTED:secret:api-key]",
  },
  {
    id: "connection-string",
    // Also proves ORDERING: `s3cr3t@db.internal` is an email-shaped substring, and
    // `email` would match it — but `connection-string` runs first and consumes it,
    // so the result stays a single redaction. If the catalog order ever changed,
    // this fixture's result would change with it.
    input: "psql postgres://appuser:s3cr3t@db.internal:5432/app",
    secret: "s3cr3t",
    // No hint: the host is a real hostname that fingerprints the environment, so it is
    // fully redacted rather than echoed into the label.
    placeholder: "[REDACTED:secret:connection-string]",
  },
  {
    id: "basic-auth-url",
    input: "curl https://admin:hunter2@dashboard.internal/health",
    secret: "hunter2",
    // Scheme is kept so the URL stays recognizable; only user:pass@ is redacted.
    placeholder: "https://[REDACTED:secret:basic-auth]@",
  },
  {
    id: "bearer-token",
    input: "curl -H 'Authorization: Bearer abc123def456ghi789jkl'",
    secret: "abc123def456ghi789jkl",
    placeholder: "Bearer [REDACTED:secret:bearer]",
  },
  {
    id: "aws-secret-access-key",
    // Also proves the SENTINEL EXCLUSION: `env-secret` would otherwise match this
    // same key name (it contains `SECRET`), double-redacting. It runs later, finds
    // the value already replaced by a sentinel, and its value class excludes the
    // sentinel — so it cannot re-consume it. Result: exactly one redaction.
    input: "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    // Key name AND the original separator are preserved, so the line stays readable.
    placeholder: "aws_secret_access_key=[REDACTED:secret:aws-secret]",
  },
  {
    id: "env-secret",
    input: "DATABASE_PASSWORD=sup3rs3cretvalue",
    secret: "sup3rs3cretvalue",
    placeholder: "DATABASE_PASSWORD=[REDACTED:secret:env]",
  },
  {
    id: "key-name-secret",
    input: `VENDOR_KEY=${RANDOM_KEY}`,
    secret: RANDOM_KEY,
    placeholder: "VENDOR_KEY=[REDACTED:secret:env]",
  },
  {
    id: "authorization-header",
    input: "curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZA==' https://api.example.com",
    secret: "dXNlcjpwYXNzd29yZA==",
    placeholder: "Authorization: Basic [REDACTED:secret:auth]",
  },
  {
    id: "mysql-password-flag",
    input: "mysql -u root -pS3cretPassw0rd orders",
    secret: "S3cretPassw0rd",
    placeholder: "-p[REDACTED:secret:password]",
  },
  {
    id: "cloud-account-id",
    input: "aws sns publish --topic-arn arn:aws:sns:us-east-1:409681372205:alerts",
    secret: "409681372205",
    placeholder: "arn:aws:sns:us-east-1:[REDACTED:pii:account]:alerts",
  },
  {
    id: "generic-secret",
    input: `curl -d 'k ${RANDOM_KEY}' https://api.example.com`,
    secret: RANDOM_KEY,
    placeholder: "[REDACTED:secret:generic]",
  },
  {
    id: "email",
    input: "git commit --author 'Priya <priya@acme.io>'",
    secret: "priya@acme.io",
    placeholder: "[REDACTED:pii:email]",
  },
  {
    id: "ssn",
    input: "echo 'subject ssn 123-45-6789' >> notes.txt",
    secret: "123-45-6789",
    placeholder: "[REDACTED:pii:ssn]",
  },
  {
    id: "credit-card",
    // Luhn-VALID (a standard test PAN). Its invalid twin is a negative fixture.
    input: "curl -d 'pan=4111111111111111' https://payments.internal/charge",
    secret: "4111111111111111",
    placeholder: "[REDACTED:pii:credit-card]",
  },
];

/**
 * Strings that must survive byte-identical.
 *
 * **These are what stop a degenerate copy passing.** A scrubber that redacted
 * everything would satisfy every positive fixture; only these fail it.
 *
 * NOTE ON A FIXTURE THAT IS DELIBERATELY ABSENT: there is no "the English word
 * *bearer* followed by a long word must survive" case. `bearer-token` is
 * case-insensitive on purpose — raw header capture emits `authorization: bearer`
 * lower-cased, and a case-sensitive anchor left every lowercase bearer token
 * unscrubbed. The accepted cost is that incidental prose is also redacted. A
 * retain control here would contradict that decision, so it is omitted on purpose
 * rather than forgotten.
 */
export const NEGATIVE_FIXTURES: readonly NegativeFixture[] = [
  {
    name: "a git commit SHA",
    input: "git show 9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
    why: "40 lowercase hex is the AWS-secret false positive the catalog explicitly guards against, with both a key-name context anchor and a hex exclusion. Redacting SHAs would make every trace unreadable.",
  },
  {
    name: "an `op read` secret-manager fetch",
    input: 'op read "op://vault/db/password"',
    why: "Secret-manager correlation is out of scope for the guard. The guard records commands, never tool output, so the resolved value never enters its records — this string is a PATH, not a secret, and scrubbing it would remove a reference while protecting nothing.",
  },
  {
    name: "a Luhn-invalid long digit run",
    input: "order 4111111111111112 shipped",
    why: "Shape-identical to a card number but fails the checksum, so it is an order id, not a PAN. Proves the Luhn gate suppresses the match AND does not tally it.",
  },
  {
    name: "a short grouped digit run",
    input: "ticket 123 456 789 reopened",
    why: "The grouped card shape matches (3 consistent groups), so this DOES reach the Luhn check — and is rejected there for being 9 digits, under the 13-digit floor. Covers the lower bound of the length window.",
  },
  {
    name: "a long grouped digit run",
    input: "batch 123456 123456 123456 123456 queued",
    why: "Same grouped shape, 24 digits — rejected at the 19-digit ceiling. Covers the upper bound. Together with the case above, these are why the length window is tested through the regex rather than by calling the checksum directly: a bare digit run outside 13-19 never reaches it at all.",
  },
  {
    name: "a UUID",
    input: "trace 550e8400-e29b-41d4-a716-446655440000 completed",
    why: "Grouped hex, not a grouped digit run — the credit-card pattern requires a consistent digit-group separator, which this does not have.",
  },
  {
    name: "a semver and a plain path",
    input: "bumped to v1.24.3 in services/api/package.json",
    why: "Ordinary build output. Nothing here is secret-shaped.",
  },
  {
    name: "ordinary prose",
    input: "The deploy finished and the rollback plan is in the runbook.",
    why: "The baseline: a scrubber that touches this is redacting on no signal at all.",
  },
];

/** A fixture whose expected behavior is more than one redaction. */
export interface InteractionFixture {
  readonly name: string;
  readonly input: string;
  /** The exact expected per-pattern tally. */
  readonly expected: Readonly<Record<string, number>>;
}

/**
 * Multi-match and engine-semantics cases. These carry expectations a single
 * `{id: 1}` shape cannot express, and they are the ones most likely to diverge if
 * the copy's ENGINE (rather than its catalog) drifts.
 */
export const INTERACTION_FIXTURES: readonly InteractionFixture[] = [
  {
    name: "two distinct secrets in one string",
    input: "AKIAIOSFODNN7EXAMPLE and sk-abcdefghijklmnopqrstuvwxyz012345",
    expected: { "aws-access-key-id": 1, "openai-key": 1 },
  },
  {
    name: "the same pattern twice — the tally counts, it does not deduplicate",
    // Both ids are `AKIA` + EXACTLY 16 `[A-Z0-9]`. A 17-char body does not match
    // (the trailing `\b` lands mid-token), which would silently make this a one-match case.
    input: "AKIAIOSFODNN7EXAMPLE then AKIAJ7RQEXAMPLE12345",
    expected: { "aws-access-key-id": 2 },
  },
  {
    name: "a PEM block near a secret-shaped key name",
    // The `.env` heuristic must NOT clip the emitted `[REDACTED:secret:private-key]`
    // placeholder. It cannot, because the placeholder is held behind a sentinel
    // until the final restore pass — this fixture is what proves it.
    input:
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----\nAPI_KEY=abcd1234efgh",
    expected: { "pem-private-key": 1, "env-secret": 1 },
  },
  {
    name: "an email inside an env assignment — the assignment wins, once",
    input: "CLIENT_SECRET=priya@acme.io",
    expected: { "env-secret": 1 },
  },
  {
    name: "a Luhn-valid PAN whose doubled digits exceed 9",
    // The other half of the checksum. In `4111…` every doubled digit stays under
    // 10, so the `d -= 9` correction never runs; this Mastercard test PAN has 5s in
    // doubled positions (5 × 2 = 10 → 1) and exercises it. A checksum that skipped
    // the correction would still validate `4111…` and reject this one.
    input: "curl -d 'pan=5555555555554444' https://payments.internal/charge",
    expected: { "credit-card": 1 },
  },
];

/**
 * Secrets that sit right after an escape sequence or a terminal control code. A word
 * boundary cannot see the start of the secret there: the character before it is the
 * `n` of an escaped newline, the `m` of a colour code, or a hex digit of `\uXXXX`.
 *
 * Each entry is `[description, secret, placeholder kind]`. The GitHub token and the
 * JWT are assembled at runtime; the AWS key is AWS's own documentation example.
 */
export const ESCAPE_BOUNDARY_SECRETS: ReadonlyArray<readonly [string, string, string]> = [
  ["a GitHub token", `${["gh", "p_"].join("")}${"R2l0SHViVG9rZW4".padEnd(36, "q")}`, "github"],
  ["an AWS access key", "AKIAIOSFODNN7EXAMPLE", "aws"],
  [
    "a JWT",
    `${["ey", "J"].join("")}hbGciOiJIUzI1NiJ9.${["ey", "J"].join("")}zdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl`,
    "jwt",
  ],
];

/** Each position where the start of a secret is hidden from a word boundary. */
export const ESCAPE_BOUNDARY_CONTEXTS: ReadonlyArray<
  readonly [string, (secret: string) => string]
> = [
  // What a JSON string holds for a two-line output: a backslash and an `n`, not a newline.
  ["line 2 of a JSON-escaped output", (s) => `{"output":"line one\\n${s}\\nline three"}`],
  ["after an escaped tab", (s) => `name\\t${s}`],
  ["after an escaped CRLF", (s) => `first\\r\\n${s}`],
  ["after a \\uXXXX escape", (s) => `key\\u003d${s}`],
  ["after a raw ANSI colour code", (s) => `\x1b[32m${s}\x1b[0m`],
  ["after an escaped ANSI colour code", (s) => `\\u001b[1;32m${s}\\u001b[0m`],
  ["after an ANSI code escaped for a shell", (s) => `\\x1b[31m${s}`],
  ["in a JSON argument after a newline", (s) => JSON.stringify({ query: `find\n${s}` })],
  ["after an erase-line code, as a spinner prints", (s) => `\r\x1b[K${s}`],
  ["after an erase-whole-line code", (s) => `\x1b[2K${s}`],
  ["after an erase and a cursor move", (s) => `\x1b[2K\x1b[1G${s}`],
  ["after an escaped erase-line code", (s) => JSON.stringify({ o: `progress\r\x1b[K${s}` })],
  ["after a colon-form colour code", (s) => `\x1b[38:5:208m${s}`],
  ["after a character-set switch", (s) => `\x1b(B${s}`],
  ["after a JSON-escaped form feed", (s) => JSON.stringify({ o: `a\f${s}` })],
  ["after a JSON-escaped backspace", (s) => JSON.stringify({ o: `a\b${s}` })],
];

/** A secret in an escape-boundary position: it must be redacted once, as `kind`. */
export interface EscapeBoundaryFixture {
  readonly name: string;
  readonly input: string;
  readonly secret: string;
  readonly kind: string;
}

/** Every secret in every escape-boundary context. */
export const ESCAPE_BOUNDARY_FIXTURES: readonly EscapeBoundaryFixture[] =
  ESCAPE_BOUNDARY_SECRETS.flatMap(([what, secret, kind]) =>
    ESCAPE_BOUNDARY_CONTEXTS.map(([where, wrap]) => ({
      name: `${what} ${where}`,
      input: wrap(secret),
      secret,
      kind,
    })),
  );

/**
 * A secret glued to a word is still not a secret on its own: the escape-aware start
 * only adds positions after an escape or a control code, never inside a word.
 */
export const GLUED_TO_A_WORD: readonly string[] = [
  "xAKIAIOSFODNN7EXAMPLE",
  `prefix${["gh", "p_"].join("")}${"R2l0SHViVG9rZW4".padEnd(36, "q")}`,
];

/**
 * Every input, flattened. Order is stable so a failing
 * case is identified the same way on every run.
 */
export const CORPUS: readonly string[] = [
  ...POSITIVE_FIXTURES.map((f) => f.input),
  ...NEGATIVE_FIXTURES.map((f) => f.input),
  ...INTERACTION_FIXTURES.map((f) => f.input),
  ...ESCAPE_BOUNDARY_FIXTURES.map((f) => f.input),
  ...GLUED_TO_A_WORD,
  // Engine-level edge cases. They carry no catalog expectation of their own, but
  // the two scrubbers must still agree on them exactly.
  "",
  "no secrets here at all",
  // A legitimate U+E000 in content. The engine strips it into a working copy while
  // scanning; on a ZERO-redaction value it must return the ORIGINAL string, so this
  // character survives. Built with fromCharCode — never as a source literal.
  `private use ${String.fromCharCode(0xe000)} char, nothing to redact`,
  // The same character alongside a real secret, where the working copy IS returned.
  `${String.fromCharCode(0xe000)} AKIAIOSFODNN7EXAMPLE`,
  // A secret after an escape sequence or a terminal colour code, raw or escaped, where a
  // word boundary cannot see where it starts.
  '{"output":"line one\\nAKIAIOSFODNN7EXAMPLE"}',
  "name\\tAKIAIOSFODNN7EXAMPLE",
  "\x1b[32mAKIAIOSFODNN7EXAMPLE\x1b[0m",
  "\\u001b[1;32mAKIAIOSFODNN7EXAMPLE",
  JSON.stringify({ query: `find\n${RANDOM_KEY}` }),
  JSON.stringify({ o: `progress\r\x1b[K${SLACK_TOKEN}` }),
  // Already-scrubbed text: a second pass must change nothing.
  "[REDACTED:secret:aws] and [REDACTED:pii:email]",
  'API_KEY="[REDACTED:secret:env]"',
  // Quoted JSON values keep their quotes.
  '{"api_key": "abcd1234efgh"}',
  // An attached -p password only when mysql or mariadb is the statement's program, quoted or not.
  "mysqldump -uroot -p'S3cret Pass' db",
  'mysql -uroot -p"S3cret" db',
  "sudo -u root /usr/bin/mysql -pletmein",
  "timeout 5 nice -n 10 mariadb -psecretpw",
  "echo q | mysql -psecretpw shop",
  '{"command":"mysql -u root -p\\"S3cret\\" shop"}',
  "docker run --name mysql -p3306:3306 mysql:8",
  "find /var/lib/mysql -print",
  "docker compose -f mysql.yml -pmyproj up",
  "systemctl status mysql -pager",
  "kubectl exec mysql-0 -- ls -pla",
  "sudo -u mysql find /var/lib/mysql -print",
  // Key names: env assignments, quoted keys and headers, but not code.
  "x-api-key: abc123def456",
  "primary_key=True",
  'hash_key = "LockID"',
  "data-key={item.id}",
  'public_key = file("~/.ssh/id_rsa.pub")',
  "SSH_KEY=~/.ssh/id_rsa",
  'const STORAGE_KEY = "app-theme";',
  "Idempotency-Key: abc123def456",
  "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==",
  // mysql -p past container exec, ssh, shells and glued statements; and arguments left alone.
  "docker exec -it -u root db mysql -uroot -pS3cret",
  "kubectl -n prod exec mysql-0 -c db -- mysql -pS3cret",
  "ssh -p 2222 -i k db1 mysql -pS3cret",
  "bash -c 'mysql -pS3cret'",
  "`mysql -pS3cret`",
  "x=$(mysql -pS3cret)",
  "mysql -pA1&&mysql -pB2",
  "mysql -pA1; mysql -pB2",
  "if true; then mysql -pS3cret; fi",
  "mariadb-dump -pS3cret db",
  '{"command":"cd /x && mysql -u root -pS3cret shop"}',
  "find /var/lib/mysql -perm 600",
  "tar -pczf db.tgz /var/lib/mysql",
  "echo mysql -pfoo",
  "xargs -I mysql ls -pla",
  // mysql -p after a redacted assignment, an unclosed quote, a wrapper or a line continuation.
  "DB_PASSWORD=hunter2abc mysql -uroot -pS3cretPw",
  "env DB_PASSWORD=hunter2abc mysql -pS3cretPw",
  '{"command":"DB_PASSWORD=hunter2abc mysql -uroot -pS3cretPw"}',
  "# don't do this\nmysql -pS3cretPw",
  '{"text":"I can\'t log in; trying mysql -uroot -pS3cretPw"}',
  "echo it's && mysql -pS3cretPw",
  "I don't know\ndocker run --name mysql -p3306:3306 mysql:8",
  "mysql -h db -P3306 -uroot -pS3cretPw",
  "docker compose exec db mysql -uroot -pS3cretPw",
  "ssh host 'mysql -pS3cretPw'",
  "bash -lc 'mysql -pS3cretPw'",
  "sudo -iu root mysql -pS3cretPw",
  '["bash","-c","mysql -pS3cretPw"]',
  "gosu mysql mysql -pS3cretPw",
  "mysql -uroot \\\n -pS3cretPw",
  '{"command":"mysql -uroot \\\\\\n -pS3cretPw"}',
  "mysql-workbench -pfoo",
];
