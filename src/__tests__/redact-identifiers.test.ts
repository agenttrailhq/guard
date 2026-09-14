// cspell:words acmecorp betaholdings clientco clientdb dbname mongosh nerdctl podman sftp
/**
 * `core/redact-identifiers.ts` — the identifying names that are not path-shaped, and
 * the three-way composition `scan` actually uses.
 *
 * Every fence here carries a NEGATIVE CONTROL, for the reason `redact-path.test.ts`
 * gives: the failure this module guards against is silent. A redactor that stopped
 * biting would leave a suite of "the output does not contain the client's name"
 * assertions passing on a string that never contained one. So each case that asserts a
 * leak is gone also asserts the leak was there to begin with.
 *
 * The corpus is a table of real command shapes that survive `scrubText` and
 * `redactPaths` verbatim.
 */

import { describe, expect, it } from "vitest";
import {
  HOST_PLACEHOLDER,
  MESSAGE_PLACEHOLDER,
  NAME_PLACEHOLDER,
  redactIdentifiers,
} from "../core/redact-identifiers.js";
import { redactForReport } from "../core/scan-report.js";

/** The leaks, with what each one is supposed to become. */
const LEAKS: readonly (readonly [string, string, string])[] = [
  ["a container name", "docker exec acme-prod-db psql -U app", "docker exec <name> psql -U app"],
  ["a compose project name", "docker logs -f betaholdings_api_1", "docker logs -f <name>"],
  ["a compose service name", "docker compose up acme-billing", "docker compose up <name>"],
  [
    "a --name value",
    "docker run --rm --name clientco-scanner <path>",
    "docker run --rm --name <name> <path>",
  ],
  ["a network name", "docker network create acme_internal", "docker network create <name>"],
  ["a volume name", "docker volume rm acmecorp_pgdata", "docker volume rm <name>"],
  ["a --filter value", "docker ps --filter name=acme", "docker ps --filter name=<name>"],
  ["a kubectl namespace", "kubectl -n acme-prod get pods", "kubectl -n <name> get pods"],
  [
    "an internal host and a database name",
    "psql -h acme-prod.internal -d clientdb",
    "psql -h <host> -d <name>",
  ],
  ["an ssh login and host", "ssh deploy@acme-prod-01", "ssh <user>@<host>"],
  [
    "a free-text commit message",
    "git commit -m 'fix billing for AcmeCorp'",
    "git commit -m '<message>'",
  ],
];

describe("the known leaks", () => {
  it.each(LEAKS)("%s", (_label, input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
  });

  it.each(LEAKS)("%s: the identifying substring was there and is gone", (_label, input) => {
    // The negative control for the table above, run over the same rows: an assertion
    // that `acme` is absent proves nothing unless `acme` was present.
    const identifying = /acme|beta|client/i;
    expect(input).toMatch(identifying);
    expect(redactIdentifiers(input)).not.toMatch(identifying);
  });
});

describe("the two neighboring commands, so the family is not over-read", () => {
  it("keeps the inner command of `docker exec` — the finding is worth reading", () => {
    // `redact-path.test.ts` draws this line: if the output reduces to placeholders
    // alone the finding stops being useful, and the fix is a shorter kept form.
    expect(redactIdentifiers("docker exec -it acme-db bash")).toBe("docker exec -it <name> bash");
  });

  it("keeps the inner command of `docker run` too, and still redacts the image", () => {
    expect(redactIdentifiers("docker run --rm ubuntu pnpm test")).toBe(
      "docker run --rm <name> pnpm test",
    );
  });

  it("re-arms on the inner command, so `psql -h` inside `docker exec` is still caught", () => {
    const input = "docker exec acme-db psql -h acme-prod.internal";
    expect(redactIdentifiers(input)).toBe("docker exec <name> psql -h <host>");
  });

  it("keeps the remote command of `ssh <host> '…'`, a stated residual", () => {
    expect(redactIdentifiers("ssh acme-prod-01 'systemctl restart api'")).toBe(
      "ssh <host> 'systemctl restart api'",
    );
  });
});

describe("what is deliberately untouched — the deny-list's other edge", () => {
  it.each([
    ["a command that is not on the list at all", "helm upgrade acme-api ./chart"],
    ["a bare dependency install", "npm install left-pad"],
    ["flags with no values", "git reset --hard"],
    ["a shell variable, so the coverage limit stays visible", "rm -rf $DIR"],
    ["a quoted string outside any known command", `echo "hello world"`],
    ["`-m` on a git subcommand where it is a boolean", "git log -m --stat"],
    ["`-d` outside the database clients", "ls -d build"],
    ["`-h` outside the database clients", "du -h build"],
    ["a bare scp operand, which is a file and not a host", "scp notes.md <path>"],
  ])("%s survives unchanged", (_label, input) => {
    expect(redactIdentifiers(input)).toBe(input);
  });

  it("the deny-list's failure mode is real and is not hidden", () => {
    // Named in the module header, asserted here so it cannot be quietly claimed as
    // covered later. `helm -n` is the same flag with the same meaning as `kubectl -n`
    // and this pass does not look at it.
    const input = "helm -n acme-prod list";
    expect(redactIdentifiers(input)).toBe(input);
    expect(redactIdentifiers(input)).toContain("acme-prod");
  });

  it("a command nested inside a quoted argument is not looked at, and that is stated", () => {
    // The third residual in the module header, pinned so it is a known gap rather than a
    // surprise. The whole quoted region is ONE word here, so nothing inside it is read as
    // a command. Recursing is a small change and is deliberately deferred until somebody
    // measures what it does to ordinary prose.
    const input = `bash -c "docker exec acme-db psql"`;
    expect(redactIdentifiers(input)).toBe(input);
    expect(redactIdentifiers(input)).toContain("acme-db");
  });
});

describe("shell structure", () => {
  it("a chained command starts a new command, so the second word is not an operand", () => {
    expect(redactIdentifiers("docker ps && kubectl -n acme-prod get pods")).toBe(
      "docker ps && kubectl -n <name> get pods",
    );
  });

  it("a newline is a boundary too — redaction runs BEFORE flatten", () => {
    const input = "docker logs acme-api\nkubectl -n acme-prod get pods";
    expect(redactIdentifiers(input)).toBe("docker logs <name>\nkubectl -n <name> get pods");
  });

  it("a pipe does not carry the family across", () => {
    expect(redactIdentifiers("docker ps -q | xargs docker rm acme-old")).toBe(
      "docker ps -q | xargs docker rm <name>",
    );
  });

  it("`sudo docker` is still docker", () => {
    expect(redactIdentifiers("sudo docker restart acme-api")).toBe("sudo docker restart <name>");
  });

  it("an operator glued to a word still breaks the command", () => {
    expect(redactIdentifiers("cleanup;docker volume rm acmecorp_pgdata")).toBe(
      "cleanup;docker volume rm <name>",
    );
  });

  it("a quoted message containing an operator is one word, not a boundary", () => {
    // Without quote awareness the `&&` inside the message would split it and the tail
    // would be read as a fresh command.
    expect(redactIdentifiers(`git commit -m 'build && deploy for AcmeCorp'`)).toBe(
      `git commit -m '<message>'`,
    );
  });

  it("an unterminated quote does not swallow the rest of the string", () => {
    // The runaway-quote direction matters: a quote that consumed everything after it
    // would bury `kubectl` inside one giant word, and a command word this pass cannot
    // see is a command word it cannot redact.
    const input = `echo 'oops && kubectl -n acme-prod get pods`;
    expect(redactIdentifiers(input)).toContain(`-n ${NAME_PLACEHOLDER}`);
    expect(redactIdentifiers(input)).not.toContain("acme-prod");
  });
});

describe("git message flags", () => {
  it.each([
    ["-m", "git commit -m 'fix billing for AcmeCorp'", "git commit -m '<message>'"],
    ["a short-flag cluster", "git commit -am 'fix for AcmeCorp'", "git commit -am '<message>'"],
    ["--message", "git tag -a v1 --message 'ship AcmeCorp'", "git tag -a v1 --message '<message>'"],
    ["--message=", "git commit --message='ship AcmeCorp'", "git commit --message=<message>"],
    ["an unquoted message", "git commit -m AcmeCorp-fix", "git commit -m <message>"],
    [
      "a repo-scoped call, where -C would otherwise eat the subcommand",
      "git -C build commit -m 'fix for AcmeCorp'",
      "git -C build commit -m '<message>'",
    ],
  ])("%s", (_label, input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
  });

  it("a flag is never eaten as a message value", () => {
    // `-m` followed by another flag means the value was omitted; swallowing the flag
    // would redact the wrong thing and change what the command appears to do.
    expect(redactIdentifiers("git commit -m --amend")).toBe("git commit -m --amend");
  });
});

describe("totality and idempotency", () => {
  it("the empty string is returned unchanged", () => {
    expect(redactIdentifiers("")).toBe("");
  });

  it.each(LEAKS)("%s: running it twice changes nothing the second time", (_l, input) => {
    const once = redactIdentifiers(input);
    expect(redactIdentifiers(once)).toBe(once);
  });

  it("never overwrites a placeholder the earlier passes wrote", () => {
    // `-e FOO=<path>` has one marker saying a path was removed. Replacing the whole
    // assignment with `<name>` would delete it. The image after it is still redacted:
    // an assignment does not consume the operand slot, which is what keeps
    // `docker run -e FOO=bar ubuntu` from leaking the image.
    expect(redactIdentifiers("docker run -e FOO=<path> ubuntu")).toBe(
      "docker run -e FOO=<path> <name>",
    );
  });

  it("a placeholder still occupies its operand slot", () => {
    // Otherwise a second pass would promote `psql` into the container-name position.
    expect(redactIdentifiers("docker exec <name> psql -U app")).toBe(
      "docker exec <name> psql -U app",
    );
  });

  it("does not throw on a pathological string", () => {
    expect(() => redactIdentifiers(`docker exec ${"a".repeat(5000)}`)).not.toThrow();
    expect(() => redactIdentifiers(`git commit -m '${"'".repeat(2000)}`)).not.toThrow();
  });
});

describe("composition — the order scan uses", () => {
  it("the identifier pass runs LAST, so an image path is not read as an object name", () => {
    const command = "docker run --rm --name clientco-scanner ghcr.io/clientco/internal:latest";
    expect(command).toContain("clientco");
    const out = redactForReport(command);
    expect(out).toBe("docker run --rm --name <name> <path>");
    expect(out).not.toContain("clientco");
  });

  it("the two earlier passes alone do NOT catch it — the control for the composition", () => {
    // Each of the three is necessary; this is the half that proves the third one is.
    const command = "docker exec acme-prod-db psql -U app";
    expect(command).toContain("acme-prod-db");
    expect(redactForReport(command)).not.toContain("acme-prod-db");
  });

  it("a planted secret still becomes a placeholder, and the name still goes", () => {
    const command = "docker exec acme-prod-db psql 'postgresql://admin:hunter2@db.internal/app'";
    const out = redactForReport(command);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("acme-prod-db");
  });

  it("a clean command survives all three untouched, end to end", () => {
    expect(redactForReport("git reset --hard")).toBe("git reset --hard");
  });

  it("the whole composition is idempotent", () => {
    const once = redactForReport("ssh deploy@acme-prod-01 'ls /srv/acme'");
    expect(redactForReport(once)).toBe(once);
    expect(once).toContain(HOST_PLACEHOLDER);
    expect(once).not.toContain("acme-prod-01");
  });

  it("the placeholders are the ones the report explains", () => {
    // The report's "Before you share this" section names each placeholder. A renamed
    // constant with no copy change would leave a reader looking at a marker the page
    // does not explain.
    expect(NAME_PLACEHOLDER).toBe("<name>");
    expect(HOST_PLACEHOLDER).toBe("<host>");
    expect(MESSAGE_PLACEHOLDER).toBe("<message>");
  });
});
