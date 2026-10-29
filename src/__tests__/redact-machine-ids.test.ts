// cspell:words northwind Unorthwind unorthwind mysqldump mongosh
/**
 * `redactMachineIdentifiers` — a database login, an AWS profile name and an AWS resource id,
 * in any command, on the page, in the JSON and in the local fixes file.
 *
 * Every case asserts the identifier was in the input before asserting it is gone, so a
 * redactor that stopped biting cannot pass on a string that never held one. The negative
 * controls pin what must NOT change: other tools' `-u` and `-U`, and hex that is not an id.
 */

import { describe, expect, it } from "vitest";
import { fixesFileText } from "../core/fixes-file.js";
import { redactIdentifiers, redactMachineIdentifiers } from "../core/redact-identifiers.js";
import { redactForReport } from "../core/scan-report.js";
import { localFixCommand } from "../core/verify/cards.js";

const LEAKS: readonly (readonly [string, string, string, string])[] = [
  [
    "psql -U, spaced",
    "psql -h localhost -U northwind_app -d app",
    "northwind_app",
    "psql -h localhost -U <user> -d app",
  ],
  ["psql -U, glued", "psql -Unorthwind_app app", "northwind_app", "psql -U<user> app"],
  [
    "psql --username=",
    "pg_dump --username=northwind_app app",
    "northwind_app",
    "pg_dump --username=<user> app",
  ],
  [
    "psql --username, spaced",
    "pg_restore --username northwind_app x.dump",
    "northwind_app",
    "pg_restore --username <user> x.dump",
  ],
  [
    "mysql -u, glued",
    "mysql -unorthwind_app -e 'select 1'",
    "northwind_app",
    "mysql -u<user> -e 'select 1'",
  ],
  [
    "mysql --user=",
    "mysqldump --user=northwind_app db",
    "northwind_app",
    "mysqldump --user=<user> db",
  ],
  [
    "mongosh --username, quoted",
    `mongosh --username "northwind_app"`,
    "northwind_app",
    `mongosh --username "<user>"`,
  ],
  [
    "inside docker exec",
    "docker exec db psql -U northwind_app",
    "northwind_app",
    "docker exec db psql -U <user>",
  ],
  [
    "exported AWS profile",
    "export AWS_PROFILE=northwind-prod",
    "northwind-prod",
    "export AWS_PROFILE=<name>",
  ],
  [
    "inline AWS profile",
    "AWS_PROFILE=northwind-prod aws s3 ls",
    "northwind-prod",
    "AWS_PROFILE=<name> aws s3 ls",
  ],
  [
    "quoted default profile",
    `export AWS_DEFAULT_PROFILE='northwind-prod'`,
    "northwind-prod",
    `export AWS_DEFAULT_PROFILE='<name>'`,
  ],
  [
    "aws --profile, spaced",
    "aws ec2 describe-instances --profile northwind-prod",
    "northwind-prod",
    "aws ec2 describe-instances --profile <name>",
  ],
  [
    "aws --profile=",
    "aws s3 ls --profile=northwind-prod",
    "northwind-prod",
    "aws s3 ls --profile=<name>",
  ],
  [
    "a 17-digit instance id",
    "aws ec2 stop-instances --instance-ids i-0a1b2c3d4e5f60718",
    "0a1b2c3d4e5f60718",
    "aws ec2 stop-instances --instance-ids <name>",
  ],
  ["an 8-digit instance id after =", "IID=i-0a1b2c3d ./run.sh", "0a1b2c3d", "IID=<name> ./run.sh"],
  [
    "a security group and a subnet",
    "aws ec2 run-instances --security-group-ids sg-0a1b2c3d --subnet-id subnet-0a1b2c3d4e5f60718",
    "0a1b2c3d",
    "aws ec2 run-instances --security-group-ids <name> --subnet-id <name>",
  ],
  [
    "a volume id",
    "aws ec2 delete-volume --volume-id vol-0a1b2c3d4e5f60718",
    "0a1b2c3d4e5f60718",
    "aws ec2 delete-volume --volume-id <name>",
  ],
];

describe("each machine identifier is replaced, keeping the command's shape", () => {
  it.each(LEAKS)("%s", (_label, input, secret, expected) => {
    expect(input).toContain(secret);
    expect(redactMachineIdentifiers(input)).toBe(expected);
    expect(redactMachineIdentifiers(input)).not.toContain(secret);
  });

  it.each(LEAKS)("%s, through the report's whole composition", (_label, input, secret) => {
    expect(redactForReport(input)).not.toContain(secret);
  });
});

describe("what must not change", () => {
  it.each([
    ["sudo's -u is a user switch, not a database client", "sudo -u deploy ls"],
    ["git's -U is a diff context", "git diff -U3 HEAD"],
    ["a profile flag on another tool", "node --profile app.js"],
    ["a word that only starts like an id", "git checkout fix-0a1b2c3d"],
    ["an id shape with upper-case hex", "echo i-0A1B2C3D"],
    ["a hash with a prefix that is not an AWS resource", "git log x-0a1b2c3d"],
    ["a database client with no login", "psql -h localhost -d app"],
    ["a variable that only ends like a profile", "MY_AWS_PROFILE_COUNT=3 make"],
  ])("%s", (_label, input) => {
    expect(redactMachineIdentifiers(input)).toBe(input);
  });

  it("stops at the end of the command, so a later -u is not a login", () => {
    expect(redactMachineIdentifiers("psql -U app; sudo -u deploy ls")).toBe(
      "psql -U <user>; sudo -u deploy ls",
    );
  });

  it("is idempotent, and leaves a placeholder another pass wrote", () => {
    for (const [, input] of LEAKS) {
      const once = redactMachineIdentifiers(input);
      expect(redactMachineIdentifiers(once)).toBe(once);
      expect(redactIdentifiers(redactIdentifiers(input))).toBe(redactIdentifiers(input));
    }
    expect(redactMachineIdentifiers("export AWS_PROFILE=[REDACTED:secret:env]")).toBe(
      "export AWS_PROFILE=[REDACTED:secret:env]",
    );
  });
});

describe("the local fixes file", () => {
  it("never writes a database login, an AWS profile or an AWS resource id", () => {
    const fixes = [
      localFixCommand("cloud", [
        "aws",
        "ec2",
        "describe-instances",
        "--profile",
        { ref: "northwind-prod" },
      ]),
      localFixCommand("cloud", [
        "aws",
        "ec2",
        "describe-instances",
        "--instance-ids",
        { ref: "i-0a1b2c3d4e5f60718" },
      ]),
      localFixCommand("prod-infra", ["psql", "-U", { ref: "northwind_app" }, "-l"]),
    ];
    const text = fixesFileText(fixes, {
      version: "0.0.0",
      generatedAt: new Date("2026-10-01T09:00:00.000Z"),
      reportName: "report.html",
    });
    expect(text).toContain("'aws' 'ec2' 'describe-instances' '--profile' '<name>'");
    expect(text).toContain("'psql' '-U' '<user>' '-l'");
    for (const secret of ["northwind-prod", "0a1b2c3d4e5f60718", "northwind_app"]) {
      expect(text).not.toContain(secret);
    }
  });
});
