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
    // Hint = last 4 of the key ID, which is a public-ish identifier, not a secret.
    placeholder: "[REDACTED:secret:aws:…MPLE]",
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
    // Hint = host only. Credentials are never captured, so none can leak into it.
    placeholder: "[REDACTED:secret:connection-string:host=db.internal]",
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
 * Every input, flattened. Order is stable so a failing
 * case is identified the same way on every run.
 */
export const CORPUS: readonly string[] = [
  ...POSITIVE_FIXTURES.map((f) => f.input),
  ...NEGATIVE_FIXTURES.map((f) => f.input),
  ...INTERACTION_FIXTURES.map((f) => f.input),
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
];
