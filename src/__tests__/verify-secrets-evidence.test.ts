// cspell:words onlylettershere lnbm
// cspell:words Fingerprinter svcacct glpat
/**
 * Why a credential-shaped value counts as likely real: a known format, a credential's name, or
 * a random-looking value with a credential's name, flag or header right before it. And who
 * wrote a Claude Code prompt record's text.
 *
 * Every token-shaped string is assembled at runtime from parts; none is real.
 */

import { describe, expect, it } from "vitest";
import { createFingerprinter } from "../core/verify/fingerprint.js";
import {
  checkSecrets,
  credentialNameClass,
  evidenceOf,
  type FoundValue,
  findValues,
  jwtKind,
  knownFormat,
  namedValueShaped,
} from "../core/verify/secrets.js";
import { recordText } from "../core/verify/sources.js";
import { UNAVAILABLE_VERIFY_IO } from "../core/verify/verify.js";
import { createRealScanIO } from "../scan-io.js";
import { writeCorpus } from "./verify-fixtures.js";

const X = "Zq8xT2mN4pR7vW1kL9sD3fG6hJ0aB5cE8yU2Ab3Cd4";
const io = createRealScanIO();

/** A JWT with `payload`, assembled from JSON. */
function jwt(payload: object): string {
  return [{ alg: "HS256", typ: "JWT" }, payload, "sig0nature"]
    .map((part) =>
      Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url"),
    )
    .join(".");
}

/** The first value `findValues` finds in `text`. */
function first(text: string): FoundValue {
  const found = findValues(text).values[0];
  if (found === undefined) throw new Error("no value found");
  return found;
}

describe("A. a known format counts, with its own kind", () => {
  it.each([
    [`npm${"_"}${X.slice(0, 36)}`, "npm-token"],
    [`sk${"_live_"}${X.slice(0, 24)}`, "stripe-live-key"],
    [`sk${"_test_"}${X.slice(0, 24)}`, "stripe-test-key"],
    [`rk${"_test_"}${X.slice(0, 24)}`, "stripe-test-key"],
    [`sk${"-ant-"}${X.slice(0, 30)}`, "anthropic-key"],
    [`sk${"-proj-"}${X.slice(0, 30)}`, "openai-key"],
    [`AIza${X.slice(0, 35)}`, "google-api-key"],
    [`glpat${"-"}${X.slice(0, 20)}`, "gitlab-token"],
    [`hf${"_"}${X.slice(0, 34)}`, "huggingface-token"],
    [`xox${"b"}-${"12345678901-abcdef"}`, "slack-bot-token"],
    [`xox${"p"}-${"12345678901-abcdef"}`, "slack-user-token"],
    [`AKIA${"Q7RZ2M4X8C1V5B3N"}`, "aws-access-key"],
  ])("%s", (value, kind) => {
    expect(knownFormat(value)).toBe(kind);
  });

  it("a lookalike that breaks the format is not one", () => {
    expect(knownFormat(`npm${"_"}short`)).toBeUndefined();
    expect(knownFormat(`AIza${"tooShort"}`)).toBeUndefined();
    expect(knownFormat(`sk${"_live_"}x`)).toBeUndefined();
  });

  it("a generic value in a known format counts, wherever it was", () => {
    const value = `npm${"_"}${X.slice(0, 36)}`;
    const sighting = evidenceOf(first(`npm notice ${value}`));
    expect(sighting).toEqual({ kind: "npm-token", evidence: "known-format" });
  });
});

describe("a JWT", () => {
  it("decodes to its role, from a fixed set", () => {
    expect(jwtKind(jwt({ role: "service_role" }))).toBe("jwt-service-role");
    expect(jwtKind(jwt({ role: "authenticated" }))).toBe("jwt-authenticated");
    expect(jwtKind(jwt({ sub: "1" }))).toBe("jwt");
    expect(jwtKind(jwt({ role: "someone-else" }))).toBe("jwt");
  });

  it("with the anon role is public by design, and an undecodable one is not counted", () => {
    expect(jwtKind(jwt({ role: "anon" }))).toBe("public");
    expect(evidenceOf(first(`key ${jwt({ role: "anon" })}`)).public).toBe(true);
    const broken = `eyJ${"hbGciOiJIUzI1"}.${"eyJzdWIiOiIx"}.${"c2lnbmF0dXJl"}`;
    expect(jwtKind(broken)).toBe("undecodable");
    expect(evidenceOf(first(`key ${broken}`)).evidence).toBeUndefined();
  });
});

describe("B. a named secret counts when its name and its value are a credential's", () => {
  it.each([
    ["DB_PASSWORD=", "password"],
    ["export GITHUB_TOKEN=", "token"],
    ['"apiKey": "', "api-key"],
    ["CLIENT_SECRET=", "secret"],
    ["X-Api-Key: ", "api-key"],
  ])("%s", (before, nameClass) => {
    expect(credentialNameClass(before)).toBe(nameClass);
  });

  it.each([
    ["SECRET_ID=", "an id field"],
    ["SECRET_ARN=", "an ARN field"],
    ["TOKEN_COUNT=", "a count"],
    ["max_tokens: ", "a count"],
    ["PUBLISHABLE_KEY=", "a public key"],
    ["PRIMARY_KEY=", "a lookup key"],
    ["TOKEN_TYPE=", "a type"],
    ["BUILD_NUMBER=", "no credential word"],
  ])("%s is not a credential's name (%s)", (before) => {
    expect(credentialNameClass(before)).toBeUndefined();
  });

  it("the value must look like a credential too", () => {
    expect(namedValueShaped("k3Jd9Lq2Xw7Vn4Bz")).toBe(true);
    expect(namedValueShaped("short1")).toBe(false);
    expect(namedValueShaped("aaaaaaaaaaaaaaaa1")).toBe(false);
    expect(namedValueShaped("onlylettershere")).toBe(false);
    expect(namedValueShaped("$SOME_VARIABLE_1")).toBe(false);
    expect(namedValueShaped("https://example.com/x1")).toBe(false);
    expect(namedValueShaped("arn:aws:secretsmanager:us-east-1:1:secret:x")).toBe(false);
    expect(namedValueShaped("config/secrets.json")).toBe(false);
    expect(namedValueShaped("a|b|c|d|1234567890")).toBe(false);
  });

  it("names the kind by the class of its name, never the name", () => {
    const sighting = evidenceOf(first(`export DEPLOY_TOKEN=k3Jd9Lq2${"Xw7Vn4Bz"}`));
    expect(sighting).toEqual({ kind: "named-token", evidence: "named" });
    expect(evidenceOf(first(`SECRET_ID=k3Jd9Lq2${"Xw7Vn4Bz"} ./run`)).evidence).toBeUndefined();
  });
});

describe("C. a random-looking value counts only with a credential's name, flag or header before it", () => {
  it.each([
    [`--token ${X}`],
    [`--api-key=${X}`],
    [`password: ${X}`],
    [`curl -H "Authorization: Bearer ${X}"`],
  ])("%s", (text) => {
    const found = findValues(text).values[0];
    expect(found).toBeDefined();
    expect(evidenceOf(found as FoundValue).evidence).toBeDefined();
  });

  it("alone, it never counts, wherever it appeared", async () => {
    const { corpus } = await writeCorpus("claude", [
      [
        { kind: "prompt", text: `look at ${X} please` },
        { kind: "call", command: `git show ${X}`, result: { text: `commit ${X}` } },
        { kind: "reply", text: `That is ${X}.` },
      ],
    ]);
    const result = await checkSecrets({
      agent: "claude",
      files: corpus.files ?? [],
      readLines: (path) => io.readLines(path),
      io: UNAVAILABLE_VERIFY_IO,
      fingerprint: createFingerprinter(),
    });
    expect(result.facts.classes["likely-real"]).toBe(0);
    expect(result.facts.setAside.unnamedOutputOnly).toBe(1);
  });
});

describe("who wrote a Claude Code prompt record's text", () => {
  const user = (content: unknown, extra: object = {}) => ({
    type: "user",
    message: { role: "user", content },
    ...extra,
  });
  const vias = (record: object, options = {}) =>
    recordText("claude", record, options).pieces.map((p) => p.via);

  it("what a person typed is pasted into a prompt", () => {
    expect(vias(user("please deploy"))).toEqual(["pasted-into-prompt"]);
  });

  it("a record the app marks as its own, and a resumed conversation's summary, are the app's", () => {
    expect(vias(user("skill body", { isMeta: true }))).toEqual(["added-by-app"]);
    expect(vias(user("summary", { isCompactSummary: true }))).toEqual(["added-by-app"]);
  });

  it("a reminder the app appended is the app's, and the rest is the person's", () => {
    const text = "fix it\n<system-reminder>context the app added</system-reminder>";
    expect(vias(user(text)).sort()).toEqual(["added-by-app", "pasted-into-prompt"]);
  });

  it("a local or bash-mode command's output is printed by a command", () => {
    expect(vias(user("<bash-stdout>value</bash-stdout>"))).toEqual(["printed-by-command"]);
    expect(vias(user("<local-command-stdout>x</local-command-stdout>"))).toEqual([
      "printed-by-command",
    ]);
  });

  it("a command's name the app recorded is the app's", () => {
    expect(vias(user("<command-name>/review</command-name>"))).toEqual(["added-by-app"]);
  });

  it("a sub-agent's prompt was written by the agent that started it", () => {
    expect(vias(user("go find the bug"), { subagent: true })).toEqual(["in-agent-reply"]);
  });
});
