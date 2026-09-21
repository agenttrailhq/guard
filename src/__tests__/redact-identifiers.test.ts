// cspell:words acmecorp betaholdings clientco clientdb dbname mongosh nerdctl podman sftp
// cspell:words tokenvalue passvalue keyvalue apivalue clientvalue mytool
// cspell:words acmeq7k2m9p4w8r1t5y6u3v0xz ACMEQ7K2M9P4W8R1T5Y6U3V0XZ
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
  [
    "a commit identity set with git config",
    "git config user.name 'Priya at AcmeCorp'",
    "git config user.name '<user>'",
  ],
  [
    "a commit identity handed to git -c",
    "git -c user.email=priya@acme.dev commit -m 'x'",
    "git -c user.email=<user> commit -m '<message>'",
  ],
  [
    "a 1Password item id",
    "op item get acmeq7k2m9p4w8r1t5y6u3v0xz --fields credential --reveal",
    "op item get <name> --fields credential --reveal",
  ],
  ["a 1Password vault name", "op item list --vault AcmeClientVault", "op item list --vault <name>"],
  [
    "a pull-request title and body",
    `gh pr create --title "[ACME-12] billing" --body "for AcmeCorp"`,
    `gh pr create --title "<message>" --body "<message>"`,
  ],
  [
    "a heredoc body",
    "git commit -F - <<'EOF'\nfix billing for AcmeCorp\nEOF",
    "git commit -F - <<'EOF'\n<message>\nEOF",
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

describe("a secret handed as a flag value, in any command", () => {
  it.each([
    ["--token", "deploy --token tokenvalue", "deploy --token [REDACTED:secret:arg]"],
    ["--password", "mytool --password passvalue", "mytool --password [REDACTED:secret:arg]"],
    ["--key", "provider auth --key keyvalue", "provider auth --key [REDACTED:secret:arg]"],
    ["--api-key=", "call --api-key=apivalue", "call --api-key=[REDACTED:secret:arg]"],
    [
      "--client-secret",
      "login --client-secret clientvalue",
      "login --client-secret [REDACTED:secret:arg]",
    ],
  ])("%s is redacted even for a tool no family covers", (_label, input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
  });

  it("does not eat a following flag as the secret value", () => {
    expect(redactIdentifiers("deploy --token --verbose")).toBe("deploy --token --verbose");
  });

  it("does not fire on a flag that merely names a namespace or a message", () => {
    expect(redactIdentifiers("kubectl --namespace acme-prod get pods")).toContain("--namespace");
    expect(redactIdentifiers("git commit --message hello")).not.toContain("[REDACTED:secret:arg]");
  });
});

describe("kubectl redacts resource-name operands, not just the namespace", () => {
  it.each([
    ["a resource name after a type", "kubectl get pods acme-web-7", "kubectl get pods <name>"],
    ["a namespace given as an operand", "kubectl get ns acme-prod", "kubectl get ns <name>"],
    ["a delete target", "kubectl delete deployment acme-api", "kubectl delete deployment <name>"],
  ])("%s", (_label, input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
  });

  it("still keeps the verb and resource type, so the shape reads", () => {
    const out = redactIdentifiers("kubectl -n acme-prod get pods acme-web-7");
    expect(out).toBe("kubectl -n <name> get pods <name>");
    expect(out).not.toContain("acme");
  });
});

describe("a SQL statement handed to a database client is redacted whole", () => {
  it.each([
    ["-c", "psql -c 'SELECT * FROM customers'", "psql -c '<name>'"],
    ["-e", "mysql -e 'DROP TABLE clients'", "mysql -e '<name>'"],
    ["--command=", "psql --command='TRUNCATE orders'", "psql --command=<name>"],
  ])("%s", (_label, input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
  });

  it("still keeps a username operand readable — the finding is worth reading", () => {
    // `-U app` is not a host, a database or a SQL statement, so it survives, as before.
    expect(redactIdentifiers("psql -U app")).toBe("psql -U app");
  });
});

describe("a shell comment is redacted, in any command", () => {
  it("collapses a comment that names a branch, keeping the command", () => {
    expect(redactIdentifiers("git push origin main # switch to acme-prod later")).toBe(
      "git push origin main #<comment>",
    );
  });

  it("a `#` mid-word is an ordinary character, not a comment", () => {
    expect(redactIdentifiers("grep foo#bar file")).toBe("grep foo#bar file");
  });

  it("a bare `#` with no body is left alone", () => {
    expect(redactIdentifiers("echo done #")).toBe("echo done #");
  });

  it("redacts a comment on the second line of a chained command", () => {
    // Redaction runs before flatten, so the newline structure is still here.
    const out = redactIdentifiers("git status\ngit push # deploy acme-prod");
    expect(out).toBe("git status\ngit push #<comment>");
  });
});

describe("a UUID is redacted in any command", () => {
  const ORG = "123e4567-e89b-42d3-a456-426614174000";

  it.each([
    ["as a flag's value", `exporter setup --org ${ORG}`, "exporter setup --org <name>"],
    ["in a --flag=value word", `exporter setup --org=${ORG}`, "exporter setup --org=<name>"],
    ["in upper case", `run ${ORG.toUpperCase()}`, "run <name>"],
    [
      "inside a quoted JSON payload, keeping the rest",
      `curl -d '{"org":"${ORG}","plan":"team"}'`,
      `curl -d '{"org":"<name>","plan":"team"}'`,
    ],
    ["as a value a family keeps", `git -C ${ORG} status`, "git -C <name> status"],
  ])("%s", (_label, input, expected) => {
    expect(input.toLowerCase()).toContain("123e4567");
    expect(redactIdentifiers(input)).toBe(expected);
  });

  it("leaves a short hash and an ordinary hyphenated word alone", () => {
    expect(redactIdentifiers("git show 3f2a9c1e")).toBe("git show 3f2a9c1e");
    expect(redactIdentifiers("npm install left-pad")).toBe("npm install left-pad");
  });
});

describe("a heredoc body is redacted, whatever command reads it", () => {
  it.each([
    [
      "an unquoted delimiter",
      "cat <<EOF > notes.md\nclient AcmeCorp\nEOF",
      "cat <<EOF > notes.md\n<message>\nEOF",
    ],
    [
      "a double-quoted delimiter over several lines",
      'python3 - <<"PY"\nprint("acme")\nprint("beta")\nPY',
      'python3 - <<"PY"\n<message>\nPY',
    ],
    [
      "a tab-stripped <<- terminator",
      "cat <<-END\n\tfor AcmeCorp\n\tEND",
      "cat <<-END\n<message>\n\tEND",
    ],
    [
      "an indented terminator inside $(cat …), as agents write it",
      `x "$(cat <<'EOF'\n   Closes ACME-12\n   EOF\n   )"`,
      `x "$(cat <<'EOF'\n<message>\n   EOF\n   )"`,
    ],
    [
      "two heredoc operators on one line, read in order",
      "diff <(cat <<A\nacme one\nA\n) <(cat <<B\nbeta two\nB\n)",
      "diff <(cat <<A\n<message>\nA\n) <(cat <<B\n<message>\nB\n)",
    ],
  ])("%s", (_label, input, expected) => {
    expect(input).toMatch(/acme|beta/i);
    const out = redactIdentifiers(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/acme|beta/i);
  });

  it("redacts to the end when the terminator is gone, as a long command capped by the engine is", () => {
    // Shell commands keep only their first MAX_DETAIL_LEN characters, so a long heredoc
    // arrives here with no terminator. Found on a real corpus: the body carried a ticket id.
    const input = `cat > <path> <<'BODY'\n## Result for ACME-12\nclient notes${"x".repeat(50)}`;
    const out = redactIdentifiers(input);
    expect(out).toBe("cat > <path> <<'BODY'\n<message>");
    expect(out).not.toMatch(/acme|client/i);
  });

  it.each([
    [
      "a one-line operator with no body, which may be text in a string",
      `echo "use << EOF for acme"`,
    ],
    ["a here-string, which has no body", `cat <<< "acme"`],
    ["an arithmetic shift", "echo $((1 << 2))"],
  ])("leaves %s alone", (_label, input) => {
    expect(redactIdentifiers(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = redactIdentifiers("git commit -F - <<'EOF'\nfix for AcmeCorp\nEOF");
    expect(redactIdentifiers(once)).toBe(once);
  });

  it("survives the full composition and the report's one-line flattening", () => {
    const out = redactForReport(
      "git commit -F - <<'EOF'\nchore: format for AcmeCorp [skip ci]\nEOF",
    )
      .replace(/\s+/g, " ")
      .trim();
    expect(out).toBe("git commit -F - <<'EOF' <message> EOF");
  });
});

describe("the 1Password and GitHub CLIs keep their verbs", () => {
  it.each([
    ["op signin", "op signin"],
    ["op whoami", "op whoami"],
    ["op read <path>", "op read <path>"],
    ["gh pr view 467", "gh pr view 467"],
    ["gh pr merge 467 --squash", "gh pr merge 467 --squash"],
  ])("%s survives unchanged", (input) => {
    expect(redactIdentifiers(input)).toBe(input);
  });

  it("stops at `op run --`, leaving the wrapped command readable", () => {
    expect(redactIdentifiers("op run --env-file prod.env -- npm start")).toBe(
      "op run --env-file <name> -- npm start",
    );
  });

  it("a known command after `op run --` is still read as itself", () => {
    expect(redactIdentifiers("op run -- docker exec acme-db psql")).toBe(
      "op run -- docker exec <name> psql",
    );
  });

  it("redacts the --title=value and short -t / -b forms of gh", () => {
    expect(redactIdentifiers("gh issue create --title=ACME -b 'for beta'")).toBe(
      "gh issue create --title=<message> -b '<message>'",
    );
  });
});

describe("a value slot is redacted whole, even when an earlier pass redacted part of it", () => {
  it.each([
    [
      "a commit message whose only scrubbed part is the co-author email",
      `git commit -m "fix ACME-12 billing\n\nCo-Authored-By: Claude <[REDACTED:pii:email]>"`,
      `git commit -m "<message>"`,
    ],
    [
      "a pull-request title that contains a placeholder-looking word",
      `gh pr create --title "Map<string> for AcmeCorp"`,
      `gh pr create --title "<message>"`,
    ],
    ["a SQL statement that held a path", `psql -c "COPY acme_users TO <path>"`, `psql -c "<name>"`],
  ])("%s", (_label, input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
    expect(redactIdentifiers(input)).not.toMatch(/acme/i);
  });

  it("keeps a value that is already nothing but a placeholder, so a secret's marker survives", () => {
    expect(redactIdentifiers("deploy --token [REDACTED:secret:env]")).toBe(
      "deploy --token [REDACTED:secret:env]",
    );
    expect(redactIdentifiers(`git commit -m "<message>"`)).toBe(`git commit -m "<message>"`);
  });

  it("is still idempotent over the whole-value case", () => {
    const once = redactIdentifiers(`git commit -m "x <[REDACTED:pii:email]>"`);
    expect(redactIdentifiers(once)).toBe(once);
  });
});

describe("a 1Password setting passed through the environment", () => {
  it.each([
    ["an account", "export OP_ACCOUNT=ACMEQ7K2M9P4W8R1T5Y6U3V0XZ", "export OP_ACCOUNT=<name>"],
    [
      "a vault, before the command",
      "OP_VAULT=AcmeVault op item list",
      "OP_VAULT=<name> op item list",
    ],
  ])("%s", (_label, input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
    expect(redactIdentifiers(input)).not.toMatch(/acme/i);
  });

  it("leaves a token the scrubber already replaced, and an unrelated variable, alone", () => {
    expect(redactIdentifiers("OP_SERVICE_ACCOUNT_TOKEN=[REDACTED:secret:env] op whoami")).toBe(
      "OP_SERVICE_ACCOUNT_TOKEN=[REDACTED:secret:env] op whoami",
    );
    expect(redactIdentifiers("NODE_ENV=production npm start")).toBe(
      "NODE_ENV=production npm start",
    );
  });
});
