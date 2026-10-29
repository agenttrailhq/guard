// cspell:words autoscaling awslocal tofu chdir compromis
/**
 * The cloud check (`core/verify/cloud.ts`): IAM, Auto Scaling, S3 and Terraform changes from
 * commands that ran, always for review, with LocalStack set aside.
 *
 * Includes the regression for a card that once said no Terraform ran while a Terraform
 * guardrail's match had: the card's copy comes only from the check's counts, and a Terraform
 * match that ran is a Terraform change whatever its shape.
 */

import { describe, expect, it } from "vitest";
import { cardsFor, pickHeadline } from "../core/verify/cards.js";
import { checkCloud, cloudCard, readCloud } from "../core/verify/cloud.js";
import { COMMAND_CHECK_CARDS } from "../core/verify/command-cards.js";
import { GIT_CARD_BUILDERS } from "../core/verify/git-checks.js";
import type { Verification } from "../core/verify/types.js";
import { type CommandEvent, callsOf, fixText, OK, SHIPPED } from "./verify-command-fixtures.js";

/** Commands a check counts, assembled here. */
const TF_APPLY = `terraform -chdir=zebra-stack apply ${"-auto"}-approve`;
const KEY = "aws iam create-access-key --user-name ci-bot";

async function cloud(
  events: readonly CommandEvent[],
  agent: "claude" | "codex" | "cursor" = "claude",
) {
  return checkCloud({ calls: await callsOf(agent, [events]), ...SHIPPED });
}

/** Every sentence a card shows. */
function allText(card: ReturnType<typeof cloudCard>): string {
  const extra = card as { fixSteps?: { text: string }[] };
  return [...card.found, ...card.now, ...(extra.fixSteps ?? [])].map((s) => s.text).join("\n");
}

describe("reading cloud commands", () => {
  it("counts changes, not reads, per service", () => {
    const changes = (command: string) => readCloud(command).changes.map((c) => c.service);
    expect(changes(KEY)).toEqual(["iam"]);
    expect(changes("aws iam list-users")).toEqual([]);
    expect(
      changes("aws --profile prod iam attach-role-policy --role-name r --policy-arn a"),
    ).toEqual(["iam"]);
    expect(
      changes(
        "aws autoscaling set-desired-capacity --auto-scaling-group-name web --desired-capacity 0",
      ),
    ).toEqual(["auto-scaling"]);
    expect(changes("aws autoscaling describe-auto-scaling-groups")).toEqual([]);
    expect(changes("aws s3 cp ./a.txt s3://bucket/a.txt")).toEqual(["s3"]);
    expect(changes("aws s3 cp s3://bucket/a.txt ./a.txt")).toEqual([]);
    expect(changes("aws s3 ls s3://bucket")).toEqual([]);
    expect(changes("aws s3api put-bucket-policy --bucket b --policy file://p.json")).toEqual([
      "s3",
    ]);
    expect(changes(TF_APPLY)).toEqual(["terraform"]);
    expect(changes("terraform plan")).toEqual([]);
    expect(changes("tofu state rm aws_instance.web")).toEqual(["terraform"]);
    expect(changes("terragrunt run-all destroy")).toEqual(["terraform"]);
  });

  it("an AWS call to LocalStack is set aside", () => {
    expect(readCloud("aws --endpoint-url http://localhost:4566 s3 rb s3://b")).toEqual({
      changes: [],
      localStack: 1,
    });
    expect(readCloud("awslocal iam create-user --user-name u").localStack).toBe(1);
    expect(
      readCloud("aws s3 rb s3://b --endpoint-url=http://localhost.localstack.cloud:4566")
        .localStack,
    ).toBe(1);
  });

  it("every endpoint must be LocalStack: one that is not makes it a real change", () => {
    const real = { changes: ["iam"], localStack: 0 };
    const services = (command: string) => {
      const read = readCloud(command);
      return { changes: read.changes.map((c) => c.service), localStack: read.localStack };
    };
    expect(
      services(
        "aws --endpoint-url http://localhost:4566 iam create-user --user-name u --endpoint-url https://iam.example.invalid",
      ),
    ).toEqual(real);
    expect(
      services(
        "aws --endpoint-url=https://iam.example.invalid iam create-user --user-name u --endpoint-url=http://localhost:4566",
      ),
    ).toEqual(real);
    expect(
      services("awslocal iam create-user --user-name u --endpoint-url https://iam.example.invalid"),
    ).toEqual(real);
    expect(
      services(
        "aws --endpoint-url http://localhost:4566 iam create-user --user-name u --endpoint-url http://127.0.0.1:4566",
      ),
    ).toEqual({ changes: [], localStack: 1 });
  });

  it("says what an IAM change was about", () => {
    const subject = (command: string) => readCloud(command).changes[0]?.subject;
    expect(subject(KEY)).toBe("access-keys");
    expect(subject("aws iam put-user-policy --user-name u --policy-name p")).toBe("policies");
    expect(subject("aws iam create-role --role-name r")).toBe("roles");
    expect(subject("aws iam create-login-profile --user-name u")).toBe("credentials");
  });
});

describe("the check", () => {
  it("changes that ran are review, never act and never clean, with exact review commands kept local", async () => {
    const { check, localFixes } = await cloud([
      { kind: "shell", command: KEY, result: OK },
      { kind: "shell", command: "aws s3 rm s3://b/old.txt", result: OK },
      { kind: "shell", command: "aws iam list-users", result: OK },
    ]);
    expect(check.status).toBe("review");
    expect(check.facts).toMatchObject({
      iamChanges: 1,
      s3Changes: 1,
      iamSubjects: ["access-keys"],
    });
    expect(localFixes.map(fixText)).toEqual([
      "'aws' 'iam' 'list-access-keys' '--user-name' 'ci-bot'",
      "'aws' 's3' 'ls' 's3://b'",
    ]);
  });

  it("only mentioned, or not confirmed as run, is not a change", async () => {
    const { check } = await cloud([
      // Written to a file, not run.
      { kind: "shell", command: `cat > notes.md <<EOF\n${KEY}\nEOF`, result: OK },
      { kind: "shell", command: `echo "${KEY}"`, result: OK },
      { kind: "shell", command: KEY },
    ]);
    expect(check.facts).toMatchObject({ iamChanges: 0, mentioned: 1, unconfirmed: 1 });
    // A printed command is not even a candidate.
    expect(check.matches).toBe(2);
    expect(check.status).toBe("could-not-check");
  });

  it("LocalStack calls are counted apart and leave the card clean", async () => {
    const { check } = await cloud([
      { kind: "shell", command: "awslocal s3 mb s3://scratch", result: OK },
    ]);
    expect(check.facts).toMatchObject({ s3Changes: 0, localStack: 1 });
    expect(check.status).toBe("clean");
  });

  it("Cursor: nothing confirmed as run, so not clean", async () => {
    const { check } = await cloud([{ kind: "shell", command: KEY }], "cursor");
    expect(check.facts.unconfirmed).toBe(1);
    expect(check.status).toBe("could-not-check");
  });
});

describe("regression: never 'no Terraform' while a Terraform match ran", () => {
  it.each([
    ["the plain form", TF_APPLY],
    // Shapes this module's own reading does not take apart, which the guardrail matches.
    ["an option with a separate value", `terraform -chdir zebra-stack apply ${"-auto"}-approve`],
    ["run through a shell", `bash -c "terraform apply ${"-auto"}-approve"`],
  ])("%s", async (_, command) => {
    const calls = await callsOf("claude", [[{ kind: "shell", command, result: OK }]]);
    expect(calls.calls[0]?.ruleIds).toContain("pi.terraform-auto-approve");
    const { check } = checkCloud({ calls, ...SHIPPED });
    expect(check.facts.terraformChanges).toBe(1);
    expect(check.facts.terraformAutoApprove).toBe(1);
    expect(check.status).toBe("review");
    const text = allText(cloudCard(check, { ranEvidence: "tool-result" }));
    expect(text).not.toMatch(/\bno\b[^.]*terraform/i);
    expect(text).toContain(
      "1 Terraform command that changes infrastructure or state ran, 1 of them with -auto-approve.",
    );
  });

  it.each([
    // Shapes this module's own reading does not take apart, which the IAM guardrail matches.
    ["run through a shell", `bash -c "${KEY}"`],
    ["run through sh", `sh -c '${KEY}'`],
  ])("an IAM change %s is counted, never no IAM change", async (_, command) => {
    const calls = await callsOf("claude", [[{ kind: "shell", command, result: OK }]]);
    expect(calls.calls[0]?.ruleIds).toContain("ps.iam-grant");
    const { check } = checkCloud({ calls, ...SHIPPED });
    expect(check.facts.iamChanges).toBeGreaterThanOrEqual(1);
    expect(check.status).toBe("review");
    const text = allText(cloudCard(check, { ranEvidence: "tool-result" }));
    expect(text).not.toMatch(/\bno\b[^.]*\bIAM\b/i);
  });

  it("Cursor: a Terraform match not confirmed as run is never reported as no Terraform", async () => {
    const calls = await callsOf("cursor", [[{ kind: "shell", command: TF_APPLY }]]);
    const { check } = checkCloud({ calls, ...SHIPPED });
    expect(check.facts).toMatchObject({ terraformChanges: 0, unconfirmed: 1 });
    expect(check.status).toBe("could-not-check");
    const text = allText(cloudCard(check, { ranEvidence: "none" }));
    expect(text).not.toMatch(/\bno\b[^.]*terraform/i);
    expect(text).toContain("1 match could not be confirmed as run.");
  });

  it("the 'nothing ran' sentence appears only when every count is zero", async () => {
    const quiet = await cloud([{ kind: "shell", command: "terraform plan", result: OK }]);
    expect(allText(cloudCard(quiet.check, { ranEvidence: "tool-result" }))).toBe(
      "No IAM, Auto Scaling, S3 or Terraform change ran.",
    );
  });
});

describe("the card", () => {
  it("says the changes cannot be checked here, and shows shapes, never names", async () => {
    const { check } = await cloud([
      { kind: "shell", command: KEY, result: OK },
      { kind: "shell", command: TF_APPLY, result: OK },
    ]);
    const card = cloudCard(check, { ranEvidence: "tool-result" });
    expect(card.tone).toBe("review");
    expect(card.now.map((s) => s.template)).toEqual(["cloud.cannot-check"]);
    expect(card.fixes.map((f) => f.shape)).toEqual([
      "aws iam list-access-keys --user-name <user>",
      "cd <folder> && terraform show",
    ]);
    expect(JSON.stringify(card)).not.toContain("ci-bot");
    expect(JSON.stringify(card)).not.toContain("zebra-stack");
  });

  it("leads from review with the IAM count only, worded as needing review, not as harm", async () => {
    const { check } = await cloud([{ kind: "shell", command: KEY, result: OK }]);
    const card = cloudCard(check, { ranEvidence: "tool-result" });
    expect(card.headline).toEqual({
      basis: "iam-changes",
      count: 1,
      restsOnCodexRan: false,
      sentence: { template: "cloud.headline", text: "1 IAM change ran and needs review" },
    });
    expect(card.headline?.sentence.text).not.toMatch(
      /compromis|breach|leak|attack|harm|damage|danger|expos|malicious|risk/i,
    );
    expect(pickHeadline([card], { ranEvidence: "tool-result" })).toBe(card);
  });

  it("S3, Auto Scaling or Terraform changes alone make no headline claim", async () => {
    const { check } = await cloud([
      { kind: "shell", command: TF_APPLY, result: OK },
      { kind: "shell", command: "aws s3 rm s3://b/x", result: OK },
    ]);
    const card = cloudCard(check, { ranEvidence: "tool-result" });
    expect(card.headline).toBeUndefined();
    expect(pickHeadline([card], { ranEvidence: "tool-result" })).toBeUndefined();
  });

  it("Codex: the claim rests on Codex ran counts, so it never leads, and the card says so", async () => {
    const { check } = await cloud([{ kind: "shell", command: KEY, result: OK }], "codex");
    const card = cloudCard(check, { ranEvidence: "output-record" });
    expect(card.headline?.restsOnCodexRan).toBe(true);
    expect(card.codexCaveat).toBe(true);
    expect(pickHeadline([card], { ranEvidence: "output-record" })).toBeUndefined();
  });

  it("cardsFor reaches this builder through the registry export", async () => {
    const { check } = await cloud([{ kind: "shell", command: KEY, result: OK }]);
    const pending = { status: "not-checked" } as const;
    const verification = {
      matchedCalls: { ran: 1, mentioned: 0, unknown: 0 },
      resultsRecorded: true,
      ranEvidence: "tool-result",
      categories: {
        secrets: pending,
        "skipped-checks": pending,
        "lost-work": pending,
        cloud: check,
        "prod-infra": pending,
        tests: pending,
        destructive: pending,
        unreviewed: pending,
        egress: pending,
      },
    } as unknown as Verification;
    const cards = cardsFor(verification, {
      ...GIT_CARD_BUILDERS,
      ...COMMAND_CHECK_CARDS,
      secrets: () => ({}) as never,
    });
    expect(cards[0]?.category).toBe("cloud");
    expect(cards[0]?.tone).toBe("review");
  });
});
