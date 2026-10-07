// cspell:disable -- credential-SHAPED synthetic values.
/**
 * `core/redact-secrets.ts` — the wider name rule and the long-random-string fallback.
 *
 * Every value is synthetic. The fallback is measured two ways: a positive set of random
 * base62 and base64url strings it must mask, and `quiet-corpus.ts` of ordinary developer
 * text it must leave alone. The measured counts are printed so the false-positive rate is a
 * recorded number.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import {
  FALLBACK_MIN_ENTROPY,
  GENERIC_PLACEHOLDER,
  redactSecrets,
} from "../core/redact-secrets.js";
import { redactForReport } from "../core/scan-report.js";
import { scrubText } from "../core/scrub.js";
import { QUIET_CORPUS } from "./quiet-corpus.js";

const NAME_PLACEHOLDER = "[REDACTED:secret:env]";

/** Small deterministic generator, so the positive set is the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BASE64URL = `${BASE62}-_`;

function randomString(rand: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

describe("name rule", () => {
  const KEY = "9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR";

  it.each([
    [
      "an environment name ending in _KEY",
      `ACMEVENDOR_KEY=${KEY} run`,
      `ACMEVENDOR_KEY=${NAME_PLACEHOLDER} run`,
    ],
    ["an exported name", `export FOO_KEY=${KEY}`, `export FOO_KEY=${NAME_PLACEHOLDER}`],
    ["a lower-case name with a colon", `vendor_key: ${KEY}`, `vendor_key: ${NAME_PLACEHOLDER}`],
    [
      "a double-quoted JSON member",
      `{"stripe_key":"${KEY}"}`,
      `{"stripe_key":"${NAME_PLACEHOLDER}"}`,
    ],
    [
      "an X-...-Key header",
      `curl -H "X-AcmeVendor-Key: ${KEY}" u`,
      `curl -H "X-AcmeVendor-Key: ${NAME_PLACEHOLDER}" u`,
    ],
    [
      "a raw Authorization header",
      `curl -H "Authorization: ${KEY}" u`,
      `curl -H "Authorization: ${NAME_PLACEHOLDER}" u`,
    ],
    [
      "a Basic credential keeps its scheme",
      `-H "Authorization: Basic dXNlcjpwYXNzd29yZA"`,
      `-H "Authorization: Basic ${NAME_PLACEHOLDER}"`,
    ],
    [
      "a Token credential keeps its scheme",
      `Authorization: Token ${KEY}`,
      `Authorization: Token ${NAME_PLACEHOLDER}`,
    ],
  ])("masks %s", (_name, input, expected) => {
    const out = redactSecrets(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(KEY);
  });

  it("masks a quoted value that contains spaces", () => {
    expect(redactSecrets(`ACMEVENDOR_KEY='two words here'`)).toBe(
      `ACMEVENDOR_KEY='${NAME_PLACEHOLDER}'`,
    );
  });

  it.each([
    ["monkey", "export MONKEY=banana"],
    ["a name that starts with key", "KEYBOARD=qwerty123"],
    ["a short value", "SOME_KEY=abc"],
    [
      "a Bearer header, which has its own pattern",
      "Authorization: Bearer [REDACTED:secret:bearer]",
    ],
    ["a value that is already a placeholder", `SOME_KEY=${NAME_PLACEHOLDER}`],
    ["a path placeholder", "SOME_KEY=<path>"],
  ])("leaves %s alone", (_name, input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});

describe("long-random-string fallback", () => {
  it("masks a bare 34-character key", () => {
    const key = "rdc_9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR";
    expect(redactSecrets(`uploadtool push ${key} report.pdf`)).toBe(
      `uploadtool push ${GENERIC_PLACEHOLDER} report.pdf`,
    );
  });

  it("masks a key inside a quoted string literal", () => {
    const key = "9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR";
    expect(redactSecrets(`python -c "Client('${key}')"`)).toBe(
      `python -c "Client('${GENERIC_PLACEHOLDER}')"`,
    );
  });

  it.each([
    [
      "an unnamed environment assignment",
      "MYVAR=rdc_9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR node server.js",
    ],
    ["a flag with =", "deploytool --session=9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR --verbose"],
    ["a query parameter", "curl 'https://example.com/a?sig=9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR'"],
  ])("masks a random run after an assignment: %s", (_name, input) => {
    const out = redactSecrets(input);
    expect(out).toContain(GENERIC_PLACEHOLDER);
    expect(out).not.toContain("9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR");
  });

  it("leaves a run that ends in base64 padding alone", () => {
    const blob = "9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gRaBcD==";
    expect(redactSecrets(`echo ${blob}`)).toBe(`echo ${blob}`);
  });

  it("masks a key that follows an escaped newline", () => {
    const key = "9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR";
    expect(redactSecrets(`line one\\nuploadtool ${key}`)).toBe(
      `line one\\nuploadtool ${GENERIC_PLACEHOLDER}`,
    );
  });

  it("masks random base62 and base64url strings of 32, 40 and 64 characters", () => {
    const rand = mulberry32(815);
    let masked = 0;
    let total = 0;
    const missed: string[] = [];
    for (const alphabet of [BASE62, BASE64URL]) {
      for (const length of [32, 40, 64]) {
        for (let i = 0; i < 200; i++) {
          const value = randomString(rand, alphabet, length);
          total++;
          if (redactSecrets(`tool ${value} arg`) === `tool ${GENERIC_PLACEHOLDER} arg`) masked++;
          else missed.push(value);
        }
      }
    }
    console.log(
      `[secret:generic] positive set: ${masked}/${total} masked (entropy >= ${FALLBACK_MIN_ENTROPY})`,
    );
    // A random string with no digit at all, or that is all hex, is deliberately not masked.
    expect(masked / total).toBeGreaterThanOrEqual(0.99);
    for (const value of missed) {
      expect(/[0-9]/.test(value) && /[A-Za-z]/.test(value) && !/^[0-9a-f]+$/i.test(value)).toBe(
        false,
      );
    }
  });

  const RANDOM_KEY = "9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR";

  it.each([
    ["after labels in a curl credential", `curl -u ci:prod-api-token-v2-${RANDOM_KEY} u`],
    ["after labels in a login", `tool login prod-deploy-token-eu-west-${RANDOM_KEY}`],
    ["after labels in an assignment", `FOO=my_service_account_prod_${RANDOM_KEY} run`],
    ["after region labels", `tool prod-eu-west-1-${RANDOM_KEY}`],
    ["before region labels", `tool ${RANDOM_KEY}-prod-eu-west-1-blue`],
  ])("masks a random key %s", (_name, input) => {
    const out = redactSecrets(input);
    expect(out).toContain(GENERIC_PLACEHOLDER);
    expect(out).not.toContain(RANDOM_KEY);
  });

  it.each([
    ["lower-case base32 groups of four", "jhwm-4g2p-twyi-syof-au7r-jx2p-wixt-yexc"],
    ["a second base32 key", "oldz-f6w6-zz2n-dlu7-4dzd-ryxb-heal-ogko"],
    ["lower-case alphanumeric groups of five", "ryn1f-ezeim-qpwvs-p97qy-wagy0-lwqsm"],
    ["a second alphanumeric key", "ioqp1-cebit-08905-n9387-el8vi-kovhm"],
    ["lower-case alphanumeric groups of four", "794g-wz17-aklp-gi6o-77ff-nvcw-lhnk-eoxz"],
  ])("masks a dashed lower-case key: %s", (_name, key) => {
    const out = redactSecrets(`tool ${key} arg`);
    expect(out).toBe(`tool ${GENERIC_PLACEHOLDER} arg`);
  });

  it("does not mask a 31-character run", () => {
    const value = "9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3g";
    expect(value).toHaveLength(31);
    expect(redactSecrets(`tool ${value}`)).toBe(`tool ${value}`);
  });

  it("does not mask a pure-hex string even at secret length", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(redactSecrets(`tool ${hex}`)).toBe(`tool ${hex}`);
  });
});

describe("quiet corpus — ordinary developer text stays byte-identical", () => {
  it("is non-trivial", () => {
    expect(QUIET_CORPUS.length).toBeGreaterThan(40);
  });

  it.each(QUIET_CORPUS.map((s) => [s.slice(0, 70), s] as const))("%s", (_label, input) => {
    expect(redactSecrets(input)).toBe(input);
    // Through the whole report composition: other passes may turn a URL into `<path>`, but
    // none may mark it as a secret.
    expect(redactForReport(input)).not.toContain("[REDACTED:");
  });

  it("keeps bare folder names readable through the whole composition", () => {
    for (const input of [
      "cd Q3Ledger2026ReconciliationWorkspaceTemplateFolder9",
      "git -C OrganizationSubscriptionBillingWorkspace2026Archive status",
      "mkdir -p NorthwindQuarterlyLedgerReconciliationWorkspaceTemplateFolder7",
    ]) {
      expect(redactForReport(input)).toBe(input);
    }
  });

  it("holds over the shipped guardrail titles and descriptions", () => {
    let measured = 0;
    for (const rule of SHIPPED_CATALOG) {
      for (const text of [rule.title, rule.description]) {
        measured++;
        expect(redactSecrets(text)).toBe(text);
      }
    }
    console.log(`[secret:generic] shipped catalog: ${measured} strings, 0 changed`);
    expect(measured).toBeGreaterThan(100);
  });

  it("holds over the committed transcript and hook fixtures", () => {
    const root = join(import.meta.dirname, "fixtures");
    let files = 0;
    let candidates = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(jsonl?|txt)$/.test(entry)) {
          files++;
          const text = scrubText(readFileSync(path, "utf8")).text;
          candidates += (text.match(/[A-Za-z0-9_-]{32,}/g) ?? []).length;
          expect(redactSecrets(text), path).not.toContain(GENERIC_PLACEHOLDER);
        }
      }
    };
    walk(root);
    console.log(`[secret:generic] fixtures: ${files} files, ${candidates} long runs, 0 masked`);
    expect(files).toBeGreaterThan(0);
  });
});

describe("idempotence and cost", () => {
  it.each([
    "ACMEVENDOR_KEY=9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR run",
    'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA" u',
    "tool rdc_9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3gR arg",
  ])("a second pass changes nothing: %s", (input) => {
    const once = redactSecrets(input);
    expect(redactSecrets(once)).toBe(once);
  });

  it("returns an empty string unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  // Every pass of the report composition, not just this module: a pattern added to another
  // pass can backtrack on the same shapes. 200,000 characters stays well under a second when
  // matching is linear; a quadratic pattern takes tens of seconds on the same input.
  const SIZE = 200_000;
  const repeat = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));
  const ADVERSARIAL: readonly (readonly [string, string])[] = [
    ["underscores", repeat("_")],
    ["hyphens", repeat("-")],
    ["equals signs", repeat("=")],
    ["KEY=", repeat("KEY=")],
    ["_KEY=", repeat("_KEY=")],
    ["ACCOUNT_ID", repeat("ACCOUNT_ID")],
    ["account_id=", repeat("account_id=")],
    ["x_ACCOUNT_ID=", repeat("x_ACCOUNT_ID=")],
    ["single quotes", repeat("'")],
    ["double quotes", repeat('"')],
    ["digits", repeat("1234567890")],
    ["hex", repeat("0123456789abcdef")],
    ["base64-like", repeat("aGVsbG8gd29ybGQ")],
    ["base64 with + / =", repeat("aGVs+bG8/gd=")],
    ["mixed class run", repeat("A1b2-")],
    ["deployment words", repeat("prod-web-")],
    ["Authorization:", repeat("Authorization:")],
    ["Authorization: x", repeat("Authorization: x ")],
    ["--account-id", repeat("--account-id ")],
    ["arn:aws:", repeat("arn:aws:x:y:")],
    ["sha256-", repeat("sha256-")],
    ["ssh -o User=", repeat("ssh -o User=")],
    ["a name and a separator", repeat("AbC1_-=:\"' KEY=ACCOUNT_ID ")],
  ];

  it.each(ADVERSARIAL)("redactForReport stays linear on %s", (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(SIZE);
    const start = performance.now();
    redactForReport(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it.each(ADVERSARIAL)("redactSecrets stays linear on %s", (_name, input) => {
    const start = performance.now();
    redactSecrets(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
