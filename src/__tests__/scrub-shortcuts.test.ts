// cspell:words gcloud gsutil mariadb xoxb xoxp
/**
 * The scrubber's shortcuts give the same result as the full passes.
 *
 * `scrubText` skips a pattern on text its prefilter says cannot match, and uses a lighter regex
 * where the part it leaves out cannot match. `findValues` (the secrets check) skips both passes
 * on text `mayHoldSecret` says holds no secret. Each is a pure shortcut, so each is held here to
 * the result without it, over a generated corpus built from every pattern's shapes, near
 * misses, escapes and terminal codes, and over the shapes on their own.
 *
 * Token-shaped strings are assembled at runtime, never written as literals, so no checked-in
 * line looks like a credential.
 */

import { describe, expect, it } from "vitest";
import { redactSecrets } from "../core/redact-secrets.js";
import { scrubText, scrubTextWithoutShortcuts } from "../core/scrub.js";
import { findValues, mayHoldSecret } from "../core/verify/secrets.js";

const A = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6";

/** Pieces that start, end, or nearly make every pattern's match. */
const FRAGMENTS: readonly string[] = [
  `AKIA${"ABCDEFGHIJKLMNOP"}`,
  `ASIA${"QRSTUVWXYZ234567"}`,
  "AKIA",
  "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  `eyJ${"hbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxIn0"}.${"c2lnbmF0dXJl"}`,
  "eyJ",
  `gh${"p"}_${A.slice(0, 36)}`,
  `github${"_pat_"}${A.slice(0, 30)}`,
  `xox${"b"}-${"1234567890-abcdef"}`,
  `xox${"p"}-short`,
  `sk${"-"}${A.slice(0, 32)}`,
  `sk${"-proj-"}${A.slice(0, 24)}`,
  "postgres://app:pa55word@db.example.com/app",
  "mysql://root:x@localhost",
  "https://user:pass@example.com/path",
  "ftp://a:b@",
  "://",
  "Bearer abcdefgh12345678",
  "bearer zz",
  "aws_secret_access_key=",
  `secret_access_key: "${A.slice(0, 40)}"`,
  "PASSWORD=hunter2hunter2",
  "api_key: 'value with spaces'",
  'CLIENT_SECRET="abc def ghi"',
  "AUTH_TOKEN=abcd",
  "credentials: xyz12345",
  "VENDOR_KEY=abcdef123456",
  "X-Vendor-Key: abcdef123",
  "Idempotency-Key: abc",
  "Authorization: Basic dXNlcjpwYXNz",
  "Proxy-Authorization: Token abcdefghij",
  "mysql -pS3cretPass",
  "docker exec db mysql -uroot -p'quoted pw'",
  "mariadb -p",
  "ACCOUNT_ID=123456789012",
  "--account-id 0123456789abcdef0123456789abcdef",
  "arn:aws:sns:us-east-1:123456789012:topic",
  "gcloud run deploy --project northwind-prod-481516",
  "bq ls --project=northwind-prod-481516",
  "--project northwind-prod-481516",
  "GOOGLE_CLOUD_PROJECT=northwind-prod",
  A,
  A.slice(0, 31),
  "0123456789abcdef0123456789abcdef01234567",
  "person@example.com",
  "@",
  "123-45-6789",
  "078 05 1120",
  "4111111111111111",
  "4111 1111 1111 1111",
  "4111-1111-1111-1112",
  "\\n",
  "\\u001b[32m",
  "\x1b[31m",
  "\\x1b[0m",
  "\\033[1;32m",
  "\x1b(B",
  '"',
  "'",
  " ",
  "\n",
  "=",
  ": ",
  "_",
  "-",
  "/",
  "token",
  "secret",
  "key",
  "TOKEN",
  "project",
  "account",
  "[REDACTED:secret:env]",
  String.fromCharCode(0xe000),
];

/** A small deterministic generator, so a failure reproduces. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** `count` texts, each 1 to 8 fragments joined with or without a space. */
function corpus(count: number, seed: number): string[] {
  const next = generator(seed);
  const texts: string[] = [...FRAGMENTS];
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const n = 1 + Math.floor(next() * 8);
    for (let k = 0; k < n; k++) {
      parts.push(FRAGMENTS[Math.floor(next() * FRAGMENTS.length)] as string);
      if (next() < 0.5) parts.push(" ");
    }
    texts.push(parts.join(""));
  }
  return texts;
}

const TEXTS = corpus(20_000, 20261029);

describe("scrubText's shortcuts", () => {
  it("give exactly the result of the full passes, text and tally", () => {
    for (const text of TEXTS) {
      expect(scrubText(text), JSON.stringify(text)).toEqual(scrubTextWithoutShortcuts(text));
    }
  });

  it("still redact every shape they guard", () => {
    expect(scrubText(`gh${"p"}_${A.slice(0, 36)}`).text).toBe("[REDACTED:secret:github]");
    expect(scrubText("gcloud run deploy --project northwind-prod-481516").text).toContain(
      "[REDACTED:pii:account]",
    );
    expect(scrubText("ACCOUNT_ID=123456789012").text).toContain("[REDACTED:pii:account]");
  });
});

describe("mayHoldSecret, the secrets check's shortcut", () => {
  it("never says no to a text that holds a secret", () => {
    for (const text of TEXTS) {
      if (mayHoldSecret(text)) continue;
      expect(redactSecrets(scrubText(text).text), JSON.stringify(text)).not.toContain(
        "[REDACTED:secret",
      );
    }
  });

  it("finds the same values with and without it", () => {
    for (const text of TEXTS) {
      if (mayHoldSecret(text)) continue;
      expect(findValues(text).values).toEqual([]);
    }
  });

  it("says no to ordinary text, so the full passes are skipped there", () => {
    expect(mayHoldSecret("Compiled 12 files in 3.2s. All tests passed.")).toBe(false);
    expect(mayHoldSecret("git status --short")).toBe(false);
  });
});
