// cspell:words QIBADAN Bgkq
/**
 * The transcript scrubber's edits (`core/scrub-transcripts.ts`), on synthetic JSON Lines text.
 *
 * Credential-shaped strings are assembled at runtime from parts, never written whole as a
 * source literal; none of them is real.
 */

import { describe, expect, it } from "vitest";
import {
  planFileScrub,
  SCRUB_MARKER,
  type ScrubTarget,
  scrubPlaceholder,
} from "../core/scrub-transcripts.js";

const GITHUB = `ghp${"_"}Tx7Kq2Wm9Lp4Rn8Vb3Zc6Yd1Hf5Ja0Se2Ug4`;
const AWS_ID = `AKIA${"W3QX7ZP2M9KC4VNB"}`;
const NAMED = `k3Jd9Lq2${"Xw7Vn4Bz"}`;

const targets: ScrubTarget[] = [
  { value: GITHUB, kind: "github-token" },
  { value: AWS_ID, kind: "aws-access-key" },
];

/** One JSON Lines file from records. */
function jsonl(...records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("the placeholder", () => {
  it("names the kind and the marker, and holds no value", () => {
    expect(scrubPlaceholder("github-token")).toBe(`[${SCRUB_MARKER}:github-token]`);
    expect(SCRUB_MARKER).toBe("REDACTED-BY-AGENTTRAIL");
  });
});

describe("replacing values", () => {
  it("replaces every occurrence inside JSON strings and counts them by kind", () => {
    const text = jsonl(
      { type: "user", message: { content: `use ${GITHUB} please` } },
      { type: "assistant", text: `id ${AWS_ID} and again ${GITHUB}` },
      { type: "summary", note: "nothing here" },
    );
    const plan = planFileScrub(text, targets);
    expect(plan.changed).toBe(true);
    expect(plan.text).not.toContain(GITHUB);
    expect(plan.text).not.toContain(AWS_ID);
    expect(plan.replaced).toEqual({ "aws-access-key": 1, "github-token": 2 });
    expect(plan.total).toBe(3);
    expect(plan.linesChanged).toBe(2);
    expect(plan.linesLeft).toBe(0);
    expect(plan.linesIncomplete).toBe(0);
    for (const line of plan.text.split("\n").filter((l) => l !== "")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(plan.text).toContain(`use ${scrubPlaceholder("github-token")} please`);
  });

  it("keeps every other byte: key order, spacing, numbers and untouched lines", () => {
    const line1 = `{"b":1.50, "a" : "x ${GITHUB} y","n":1e3}`;
    const line2 = `{"untouched":true,"z":[1,2,3]}`;
    const text = `${line1}\r\n${line2}\n`;
    const plan = planFileScrub(text, targets);
    expect(plan.text).toBe(
      `{"b":1.50, "a" : "x ${scrubPlaceholder("github-token")} y","n":1e3}\r\n${line2}\n`,
    );
  });

  it("keeps a byte-order mark and a missing final newline", () => {
    const text = `\uFEFF{"a":"${GITHUB}"}\n{"b":"${GITHUB}"}`;
    const plan = planFileScrub(text, targets);
    // The first line does not parse with the mark in front, so it is left and counted.
    expect(plan.text.startsWith("\uFEFF")).toBe(true);
    expect(plan.text.endsWith(`{"b":"${scrubPlaceholder("github-token")}"}`)).toBe(true);
    expect(plan.linesLeft).toBe(1);
  });

  it("finds a value in its JSON-escaped form, quotes, backslashes and newlines included", () => {
    const key = `-----BEGIN ${"PRIVATE"} KEY-----\nMIIEv${"QIBADANBgkq"}\n-----END ${"PRIVATE"} KEY-----`;
    const odd = `pa"ss\\w${"0rd9!x"}`;
    const text = jsonl({ out: `cat key\n${key}\ndone` }, { cmd: `login --password=${odd}` });
    const plan = planFileScrub(text, [
      { value: key, kind: "private-key" },
      { value: odd, kind: "password" },
    ]);
    expect(plan.replaced).toEqual({ password: 1, "private-key": 1 });
    const records = plan.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records[0].out).toBe(`cat key\n${scrubPlaceholder("private-key")}\ndone`);
    expect(records[1].cmd).toBe(`login --password=${scrubPlaceholder("password")}`);
  });

  it("finds a value inside a JSON string nested in a JSON string", () => {
    const inner = JSON.stringify({ command: `export DEPLOY_TOKEN="${NAMED}"` });
    const text = jsonl({ payload: { arguments: inner } });
    // The value as the secrets check sees it: a literal substring of the outer string's text.
    const plan = planFileScrub(text, [{ value: NAMED, kind: "named-secret" }]);
    expect(plan.total).toBe(1);
    const outer = JSON.parse(plan.text.trim());
    expect(JSON.parse(outer.payload.arguments).command).toBe(
      `export DEPLOY_TOKEN="${scrubPlaceholder("named-secret")}"`,
    );
  });

  it("finds a value a writer escaped as \\uXXXX or with \\/", () => {
    const accented = `s3cr\u00e9t-${"Vq8Lz2Mx7"}`;
    const slashed = `ab/${"Cd9Ef8Gh7"}/Ij`;
    const text =
      `{"a":"x ${accented.replace("\u00e9", "\\u00e9")}"}\n` +
      `{"b":"${slashed.replaceAll("/", "\\/")}"}\n`;
    const plan = planFileScrub(text, [
      { value: accented, kind: "password" },
      { value: slashed, kind: "api-key" },
    ]);
    expect(plan.total).toBe(2);
    expect(plan.linesIncomplete).toBe(0);
    expect(plan.text).not.toContain("Vq8Lz2Mx7");
    expect(plan.text).not.toContain("Cd9Ef8Gh7");
  });

  it("leaves a valid line as it was when the edit would stop it parsing", () => {
    // The raw text `41zQ9…` starts inside `A`: replacing it would cut the escape in two.
    const value = `41${"zQ9mK2pL7wX3"}`;
    const line = `{"a":"\\u0041${value.slice(2)}","b":"ok"}`;
    expect(() => JSON.parse(line)).not.toThrow();
    const text = `${line}\n`;
    const plan = planFileScrub(text, [{ value, kind: "named-secret" }]);
    expect(plan.changed).toBe(false);
    expect(plan.text).toBe(text);
    expect(plan.linesChanged).toBe(0);
    expect(plan.linesLeft).toBe(1);
  });

  it("matches a value right after an escaped backslash, and not after an escaping one", () => {
    const value = `n${"8Hq2Lx7Vz3Kp"}`;
    // `\\` is one escaped backslash: the value after it starts a token, so it is replaced.
    const afterEscaped = `{"a":"x\\\\${value}"}\n`;
    const replaced = planFileScrub(afterEscaped, [{ value, kind: "api-key" }]);
    expect(replaced.total).toBe(1);
    expect(JSON.parse(replaced.text.trim()).a).toBe(`x\\${scrubPlaceholder("api-key")}`);
    // `\\\n…` is an escaped backslash then `\n`: the `n` belongs to an escape, so no match.
    const afterEscaping = `{"a":"x\\\\\\${value}"}\n`;
    expect(JSON.parse(afterEscaping.trim()).a).toBe(`x\\\n${value.slice(1)}`);
    const left = planFileScrub(afterEscaping, [{ value, kind: "api-key" }]);
    expect(left.changed).toBe(false);
    expect(left.linesLeft).toBe(0);
  });

  it("does not start a match inside an escape sequence", () => {
    // `\n` followed by the rest of the value: the `n` belongs to the escape.
    const value = `n${"8Hq2Lx7Vz3Kp"}`;
    const text = `{"a":"line\\n${value.slice(1)}"}\n`;
    const plan = planFileScrub(text, [{ value, kind: "api-key" }]);
    expect(plan.changed).toBe(false);
    expect(plan.text).toBe(text);
  });

  it("replaces a value only inside strings, never in keys' quotes or numbers", () => {
    const value = `12${"345678901234"}`;
    const text = `{"n":${value},"s":"${value}"}\n`;
    const plan = planFileScrub(text, [{ value, kind: "random-string" }]);
    expect(plan.text).toBe(`{"n":${value},"s":"${scrubPlaceholder("random-string")}"}\n`);
  });

  it("replaces the longer of two overlapping values whole", () => {
    const short = `Zq8xT2mN${"4pR7vW1k"}`;
    const long = `${short}${"L9sD3fG6"}`;
    const plan = planFileScrub(jsonl({ a: long, b: short }), [
      { value: short, kind: "named-secret" },
      { value: long, kind: "api-key" },
    ]);
    const record = JSON.parse(plan.text.trim());
    expect(record.a).toBe(scrubPlaceholder("api-key"));
    expect(record.b).toBe(scrubPlaceholder("named-secret"));
  });
});

describe("lines that cannot be edited safely", () => {
  it("leaves a line that is not JSON exactly as it was, and counts it", () => {
    const broken = `{"a":"${GITHUB}"`;
    const text = `${broken}\n${JSON.stringify({ b: GITHUB })}\n`;
    const plan = planFileScrub(text, targets);
    expect(plan.text.split("\n")[0]).toBe(broken);
    expect(plan.linesLeft).toBe(1);
    expect(plan.linesChanged).toBe(1);
  });

  it("counts a line cut off inside a string, which it cannot edit, as left", () => {
    // A last line written as the app stopped: its final string never closes.
    const cut = `{"type":"user","message":{"content":"use ${GITHUB} and`;
    const text = `${JSON.stringify({ a: "fine" })}\n${cut}`;
    const plan = planFileScrub(text, targets);
    expect(plan.changed).toBe(false);
    expect(plan.text).toBe(text);
    expect(plan.linesLeft).toBe(1);
  });

  it("counts a parsed line it could not edit only when it still decodes to a value", () => {
    const rest = `8Hq2${"Lx7Vz3Kp"}`;
    const value = `n${rest}`;
    // The raw text `n…` appears only as the second half of `\n`: not the value, not counted.
    const onlyInEscape = `{"a":"line\\n${rest}"}\n`;
    const none = planFileScrub(onlyInEscape, [{ value, kind: "api-key" }]);
    expect(none.changed).toBe(false);
    expect(none.linesLeft).toBe(0);
    // The same, plus the value written with its first letter as `\u006e`, which no tried form
    // matches: the line decodes to the value, so it is counted as left.
    const alsoEscaped = `{"a":"line\\n${rest}","b":"\\u006e${rest}"}\n`;
    const left = planFileScrub(alsoEscaped, [{ value, kind: "api-key" }]);
    expect(left.changed).toBe(false);
    expect(left.text).toBe(alsoEscaped);
    expect(left.linesLeft).toBe(1);
  });

  it("counts a line holding a held value in a form no tried form matches", () => {
    // The value written with its first letter as `g`: no tried form is anywhere in the file.
    const line = `{"a":"x \\u0067${GITHUB.slice(1)} y"}`;
    const text = `${line}\n${JSON.stringify({ b: "fine" })}\n`;
    expect(JSON.parse(line).a).toBe(`x ${GITHUB} y`);
    // Without being told the file holds it, nothing is decoded and nothing counted.
    expect(planFileScrub(text, targets).linesLeft).toBe(0);
    const plan = planFileScrub(text, targets, [GITHUB]);
    expect(plan.changed).toBe(false);
    expect(plan.text).toBe(text);
    expect(plan.linesLeft).toBe(1);
  });

  it("decodes only lines with an escape, and only for the held values", () => {
    const text = `${JSON.stringify({ a: "no escape here" })}\n{"b":"line\\nbreak"}\n`;
    expect(planFileScrub(text, targets, [GITHUB]).linesLeft).toBe(0);
    expect(planFileScrub(text, targets, ["break"]).linesLeft).toBe(1);
    expect(planFileScrub(text, targets, [""]).linesLeft).toBe(0);
  });

  it("counts a changed line that still holds a value in a form it does not edit", () => {
    const value = `Qm7${"Xn2Lp9Vz4"}`;
    // Upper-case hex escapes are not one of the forms tried.
    const escaped = [...value]
      .map((ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
      .join("");
    const text = `{"a":"${value}","b":"${escaped}"}\n`;
    const plan = planFileScrub(text, [{ value, kind: "api-key" }]);
    expect(plan.linesChanged).toBe(1);
    expect(plan.linesIncomplete).toBe(1);
  });

  it("changes nothing when no value is in the text", () => {
    const text = jsonl({ a: "nothing" });
    const plan = planFileScrub(text, targets);
    expect(plan).toEqual({
      text,
      changed: false,
      replaced: {},
      total: 0,
      linesChanged: 0,
      linesLeft: 0,
      linesIncomplete: 0,
    });
  });

  it("ignores an empty value", () => {
    const text = jsonl({ a: "x" });
    expect(planFileScrub(text, [{ value: "", kind: "other" }]).changed).toBe(false);
  });
});

describe("idempotence", () => {
  it("a second pass over the scrubbed text changes nothing", () => {
    const text = jsonl({ a: `${GITHUB} ${AWS_ID}` }, { b: GITHUB });
    const once = planFileScrub(text, targets);
    const twice = planFileScrub(once.text, targets);
    expect(once.changed).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });
});
