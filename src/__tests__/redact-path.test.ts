/**
 * `core/redact-path.ts` — the guard-only path redactor, and the composition with the
 * secret scrubber that `scan` actually uses.
 *
 * Every fence here carries a NEGATIVE CONTROL, because the failure this module guards
 * against is silent: a redactor that stopped biting would leave a suite of "the output
 * does not contain the home directory" assertions passing on an empty string, or on a
 * string that never contained one. So each case that asserts a leak is gone also
 * asserts the thing it is looking for was there to begin with.
 */

import { describe, expect, it } from "vitest";
import { PATH_PLACEHOLDER, redactPaths } from "../core/redact-path.js";
import { REDACTION_PREFIX } from "../core/redaction.js";
import { redactForReport } from "../core/scan-report.js";
import { scrubText } from "../core/scrub.js";

/** A realistic identifying path: a person's name, a client's name, a project's name. */
const HOME_PATH = "/Users/priya/clients/acme-secret-client/billing";

describe("what gets redacted", () => {
  it.each([
    ["an absolute POSIX path", "cat /Users/priya/acme/.env", "cat <path>"],
    ["a home-rooted path", "cat ~/notes/clients.md", "cat <path>"],
    ["a relative path", "rm -rf ./node_modules", "rm -rf <path>"],
    ["a bare dot", "git checkout -- .", "git checkout -- <path>"],
    ["a Windows drive path", "type C:\\Users\\priya\\acme\\.env", "type <path>"],
    ["a UNC share", "dir \\\\fileserver\\finance\\q3", "dir <path>"],
    ["a bare drive letter", "cd C:", "cd <path>"],
    ["a secret-manager URI", "op read op://vault/item/field", "op read <path>"],
    ["an internal https URL", "curl https://internal.acme.corp/api", "curl <path>"],
    ["a file URL", "open file:///Users/priya/report.html", "open <path>"],
    ["a flag-attached path", "tar -xf --file=/Users/priya/x.tar", "tar -xf --file=<path>"],
    ["root itself", "rm -rf /", "rm -rf <path>"],
  ])("%s", (_label, input, expected) => {
    expect(redactPaths(input)).toBe(expected);
  });

  it("redacts every path in a multi-path command, not just the first", () => {
    const out = redactPaths("cp /Users/priya/a.txt /Users/priya/clients/beta/b.txt");
    expect(out).toBe("cp <path> <path>");
  });

  it("a quoted path with a SPACE is collapsed whole — the leak this test found", () => {
    // Token-by-token, only the first run carries a separator, so the second segment
    // survived: `rm -rf "<path> Holdings"`. On macOS and Windows a directory name with
    // a space is ordinary, and the surviving segment is a client's name.
    const command = `rm -rf "/Users/priya/Acme Holdings"`;
    expect(command).toContain("Holdings");
    expect(redactPaths(command)).toBe(`rm -rf "<path>"`);
  });

  it("a single-quoted spaced path too", () => {
    expect(redactPaths(`rm -rf '/Users/priya/Acme Holdings'`)).toBe(`rm -rf '<path>'`);
  });

  it("an UNTERMINATED quote still redacts, token by token", () => {
    // The quoted-region pass matches nothing; the fall-through is the safe direction.
    const out = redactPaths(`rm -rf "/Users/priya/Acme Holdings`);
    expect(out).not.toContain("priya");
    expect(out).toContain(PATH_PLACEHOLDER);
  });

  it("a quoted string with no path in it is left alone", () => {
    expect(redactPaths(`echo "hello world"`)).toBe(`echo "hello world"`);
  });
});

describe("what is deliberately kept", () => {
  it.each([
    ["a command with no path at all", "docker volume rm cache"],
    ["flags", "git reset --hard"],
    ["a long-form flag", "git push --force-with-lease"],
    ["a bare filename with no separator", "cat .env"],
    ["a shell variable, so the coverage limit stays visible", "rm -rf $DIR"],
  ])("%s survives unchanged", (_label, input) => {
    expect(redactPaths(input)).toBe(input);
  });

  it("a bare operand is the residual exposure, and it is a deliberate line", () => {
    // A separator-free token is kept, so `npm install left-pad` stays readable — and a
    // finding whose whole value is WHICH dependency was installed keeps that value.
    // The residual exposure is a single filename in the session's own working
    // directory: it carries no username and no directory chain, unlike every shape
    // above. Widening the rule to catch it would blank most useful commands, so the
    // line is drawn here on purpose rather than by omission.
    expect(redactPaths("npm install left-pad")).toBe("npm install left-pad");
  });

  it("keeps enough of the command to be worth reading", () => {
    // The point of the module is a readable SHAPE, not a blanked line. If this ever
    // reduces to `<path>` alone the finding stops being useful and the fix is a
    // shorter kept form, never a wider one.
    expect(redactPaths(`git checkout -- ${HOME_PATH}/x.ts`)).toBe("git checkout -- <path>");
  });
});

describe("the negative controls — proving the fence bites", () => {
  it("the identifying segments are present before redaction and absent after", () => {
    const command = `rm -rf ${HOME_PATH}`;
    for (const segment of ["priya", "clients", "acme-secret-client", "billing"]) {
      expect(command).toContain(segment);
      expect(redactPaths(command)).not.toContain(segment);
    }
  });

  it("a Windows home directory is gone too", () => {
    const command = "type C:\\Users\\priya\\acme\\.env";
    expect(command).toContain("priya");
    expect(redactPaths(command)).not.toContain("priya");
  });

  it("an un-redacted control string DOES still contain the name", () => {
    // Without this the assertions above would pass against a `redactPaths` that
    // returned the empty string — which is exactly what `redact-stack.ts`'s
    // `scrubPaths` does on command-shaped input, and why it could not be reused.
    expect(HOME_PATH).toContain("priya");
    expect(redactPaths(HOME_PATH).length).toBeGreaterThan(0);
  });
});

describe("totality and idempotency", () => {
  it("the empty string is returned unchanged", () => {
    expect(redactPaths("")).toBe("");
  });

  it("running it twice changes nothing the second time", () => {
    const once = redactPaths(`cat ${HOME_PATH}/.env`);
    expect(redactPaths(once)).toBe(once);
    expect(once).toContain(PATH_PLACEHOLDER);
  });

  it("does not throw on a pathological string", () => {
    expect(() => redactPaths("/".repeat(5000))).not.toThrow();
  });
});

describe("composition with the secret scrubber (the order scan uses)", () => {
  it("a planted AWS key is redacted and the surrounding path is elided", () => {
    const command = `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE aws s3 cp ${HOME_PATH}/db.sql s3://b/k`;
    const out = redactForReport(command);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain(REDACTION_PREFIX);
    expect(out).not.toContain("priya");
  });

  it("path redaction alone does NOT catch the key — which is why both run", () => {
    // The positive control for the composition: each half is necessary.
    const command = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    expect(redactPaths(command)).toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redactForReport(command)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("the scrubber alone does NOT catch the path — the other half of the control", () => {
    // None of the fourteen scrubber patterns match a filesystem path.
    const command = `cat ${HOME_PATH}/.env`;
    const scrubbed = scrubText(command);
    expect(scrubbed.total).toBe(0);
    expect(scrubbed.text).toContain("priya");
    expect(redactForReport(command)).not.toContain("priya");
  });

  it("does not swallow a redaction placeholder that legitimately contains ://", () => {
    // `basic-auth`'s placeholder is `scheme://[REDACTED:secret:basic-auth]@`. A path
    // pass that consumed brackets would eat the marker and the report would lose the
    // one signal saying a secret had been removed.
    const out = redactForReport("curl https://admin:hunter2@example.com/x");
    expect(out).toContain(REDACTION_PREFIX);
  });

  it("leaves a clean command untouched end to end", () => {
    expect(redactForReport("git reset --hard")).toBe("git reset --hard");
  });
});
