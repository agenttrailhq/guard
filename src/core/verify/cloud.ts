// cspell:words autoscaling terragrunt tofu awslocal chdir dryrun untaint
/**
 * The cloud check, for the "Cloud and permissions" card: IAM, Auto Scaling, S3 and Terraform
 * changes made by commands that RAN.
 *
 * What a change did in the cloud account cannot be seen from this machine, so a category with
 * any change is always `review`, never `act` and never `clean`, and the card says so. Its
 * wording claims only that the changes ran and need review.
 *
 * ── Copy comes only from what ran ────────────────────────────────────────────
 * Each count is of commands that ran. A command is read two ways, and either is enough: this
 * module's own reading of `aws`, `terraform`, `tofu` and `terragrunt` commands, and the
 * guardrails that match Terraform runs and IAM grants. So a Terraform run a guardrail matched
 * is a Terraform run here even when the reading below does not recognize its shape, and the
 * card can never say no Terraform command ran while one did.
 *
 * An `aws` call sent to LocalStack (an `--endpoint-url` on this machine, or `awslocal`) changes
 * nothing in a cloud account. It is counted apart and left out of the changes.
 *
 * What leaves this module is counts and fixed enums. Names (users, roles, buckets, folders)
 * go only into exact commands for the local fixes file.
 */

import type { CompiledAllowlist } from "../evaluate.js";
import type { CompiledRule } from "../rules.js";
import {
  backstopCalls,
  type CorpusCalls,
  executedText,
  hidingFacts,
  isShell,
  programAndArgs,
  quietStatus,
  rulesMatcher,
  runStateOf,
  runsAnyOf,
  type SessionCall,
  simpleCommands,
} from "./calls.js";
import {
  counted,
  type FullCard,
  MAX_LOCAL_FIXES,
  moreMatches,
  noun,
  restsOnCodex,
} from "./card-parts.js";
import {
  type CardContext,
  type CommandPart,
  isLocalFix,
  type LocalFix,
  localFixCommand,
  type SentenceTemplate,
  sentence,
  sentences,
  type ToCard,
  type UnsafeFix,
} from "./cards.js";
import { IAM_SUBJECTS } from "./command-facts.js";
import { endpointsLocal } from "./hosts.js";
import { READ_PROGRAMS } from "./ran.js";
import { placed } from "./repos.js";
import type { CheckedCategory, HidingForm, VerifyStatus } from "./types.js";

export { IAM_SUBJECTS };

/** One of `IAM_SUBJECTS`. */
export type IamSubject = (typeof IAM_SUBJECTS)[number];

/** What the cloud check found. Every count is of commands that ran. */
export interface CloudFacts {
  readonly iamChanges: number;
  /** What the IAM changes were about, in `IAM_SUBJECTS` order. */
  readonly iamSubjects: readonly IamSubject[];
  readonly autoScalingChanges: number;
  readonly s3Changes: number;
  /** Terraform, OpenTofu and Terragrunt commands that change infrastructure or state. */
  readonly terraformChanges: number;
  /** Of those, run with `-auto-approve`. */
  readonly terraformAutoApprove: number;
  /** `aws` calls that went to LocalStack on this machine, and are not counted above. */
  readonly localStack: number;
  /** Matches that only mentioned one of these, and did not run. */
  readonly mentioned: number;
  /** Matches that could not be confirmed as run. */
  readonly unconfirmed: number;
  /** Calls that ran, or may have run, and could have run other commands this check does not read. */
  readonly couldHide: number;
  /** The hiding forms those calls hold, in `HIDING_FORMS` order. */
  readonly hidingForms: readonly HidingForm[];
}

declare module "./types.js" {
  interface CategoryFactsMap {
    cloud: CloudFacts;
  }
}

/** The cloud category's result. */
export type CloudCheck = CheckedCategory<CloudFacts>;

/** The services a change is counted under. */
type Service = "iam" | "auto-scaling" | "s3" | "terraform";

/** One change a command makes, with what an exact review command needs. */
interface CloudChange {
  readonly service: Service;
  readonly subject?: IamSubject;
  readonly autoApprove?: boolean;
  /** For the local fixes file: the review command, exactly, or why there is none. */
  readonly review?: LocalFix | UnsafeFix;
}

/** What one shell text does in the cloud. */
export interface CloudReading {
  readonly changes: readonly CloudChange[];
  /** `aws` calls sent to LocalStack. */
  readonly localStack: number;
}

/** `aws` options that come before the service and take the next word. */
const AWS_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--profile",
  "--region",
  "--endpoint-url",
  "--output",
  "--query",
  "--color",
  "--ca-bundle",
  "--cli-read-timeout",
  "--cli-connect-timeout",
  "--cli-binary-format",
]);

/** The value of `--name value` or `--name=value` among `args`. */
function optionValue(args: readonly string[], name: string): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string;
    if (arg === name) return args[k + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

/** The words of `args` that are not options or option values. */
function operands(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && k + 1 < args.length && !(args[k + 1] as string).startsWith("-")) {
        // `--acl public-read`: the option's value is not an operand. A flag with no value
        // (`--recursive`) followed by an operand is read the same way, which only ever drops
        // an operand, never invents one.
        if (!/^--(?:recursive|dryrun|dry-run|quiet|force|delete|exact-timestamps)$/.test(arg))
          k += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

/** What an IAM operation is about. */
function iamSubject(operation: string): IamSubject {
  if (operation.includes("access-key")) return "access-keys";
  if (
    /login-profile|password|mfa|ssh-public-key|signing-certificate|service-specific-credential/.test(
      operation,
    )
  ) {
    return "credentials";
  }
  if (operation.includes("policy")) return "policies";
  if (operation.includes("role") || operation.includes("instance-profile")) return "roles";
  if (operation.includes("group")) return "groups";
  if (operation.includes("user")) return "users";
  return "other";
}

/**
 * An exact, read-only review command for the local fixes file. Every name in it is a ref
 * (`localFixCommand`), so one with unsafe characters gives no command, only the note that a
 * safe one could not be made.
 */
function review(parts: readonly CommandPart[]): LocalFix | UnsafeFix {
  return localFixCommand("cloud", parts);
}

/** The review command for an IAM change, exactly, when its arguments name what to look at. */
function iamReview(subject: IamSubject, args: readonly string[]): LocalFix | UnsafeFix | undefined {
  const user = optionValue(args, "--user-name");
  const role = optionValue(args, "--role-name");
  const group = optionValue(args, "--group-name");
  if (subject === "access-keys" && user !== undefined) {
    return review(["aws", "iam", "list-access-keys", "--user-name", { ref: user }]);
  }
  if (role !== undefined) {
    return review(["aws", "iam", "list-attached-role-policies", "--role-name", { ref: role }]);
  }
  if (group !== undefined)
    return review(["aws", "iam", "get-group", "--group-name", { ref: group }]);
  if (user !== undefined) {
    return review(["aws", "iam", "list-attached-user-policies", "--user-name", { ref: user }]);
  }
  return undefined;
}

/** The review command for an S3 change. */
function bucketReview(bucket: string): LocalFix | UnsafeFix {
  return review(["aws", "s3", "ls", { ref: `s3://${bucket}` }]);
}

/** One `aws` command. */
function readAws(args: readonly string[], local: boolean): CloudChange[] | "local" {
  let k = 0;
  while (k < args.length && (args[k] as string).startsWith("--")) {
    k += AWS_VALUE_OPTIONS.has(args[k] as string) ? 2 : 1;
  }
  const service = args[k] ?? "";
  const operation = args[k + 1] ?? "";
  const rest = args.slice(k + 2);
  // Every endpoint named, before the service or after it, must be this machine; with none,
  // `awslocal` is.
  const toLocal = endpointsLocal(args) ?? local;

  let change: CloudChange | undefined;
  if (
    service === "iam" &&
    operation !== "" &&
    !/^(?:get|list|simulate|generate|wait|help)\b/.test(operation)
  ) {
    const subject = iamSubject(operation);
    const review = iamReview(subject, rest);
    change = { service: "iam", subject, ...(review === undefined ? {} : { review }) };
  } else if (
    service === "autoscaling" &&
    operation !== "" &&
    !/^(?:describe|get|wait|help)\b/.test(operation)
  ) {
    const group = optionValue(rest, "--auto-scaling-group-name");
    change = {
      service: "auto-scaling",
      ...(group === undefined
        ? {}
        : {
            review: review([
              "aws",
              "autoscaling",
              "describe-auto-scaling-groups",
              "--auto-scaling-group-names",
              { ref: group },
            ]),
          }),
    };
  } else if (service === "s3") {
    const targets = operands(rest);
    const last = targets[targets.length - 1] ?? "";
    const writes =
      ["rm", "rb", "mb", "website"].includes(operation) ||
      (["cp", "mv", "sync"].includes(operation) && last.startsWith("s3://"));
    const bucket = targets
      .map((t) => /^s3:\/\/([^/\s]+)/.exec(t)?.[1])
      .find((b) => b !== undefined);
    if (writes) {
      change = {
        service: "s3",
        ...(bucket === undefined ? {} : { review: bucketReview(bucket) }),
      };
    }
  } else if (
    service === "s3api" &&
    operation !== "" &&
    !/^(?:get|list|head|wait|help|select)\b/.test(operation)
  ) {
    const bucket = optionValue(rest, "--bucket");
    change = {
      service: "s3",
      ...(bucket === undefined ? {} : { review: bucketReview(bucket) }),
    };
  }
  if (change === undefined) return [];
  return toLocal ? "local" : [change];
}

/** Terraform subcommands that change infrastructure or state. */
const TERRAFORM_CHANGES: ReadonlySet<string> = new Set([
  "apply",
  "destroy",
  "import",
  "taint",
  "untaint",
  "force-unlock",
]);

/** `terraform state` subcommands that change state. */
const STATE_CHANGES: ReadonlySet<string> = new Set(["rm", "mv", "push", "replace-provider"]);

/** One `terraform`, `tofu` or `terragrunt` command. */
function readTerraform(args: readonly string[], cwd: string | null): CloudChange[] {
  let folder: string | undefined;
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-chdir=")) folder = arg.slice("-chdir=".length);
    else if (!arg.startsWith("-")) words.push(arg);
  }
  // `terragrunt run-all apply`, `terragrunt run apply`.
  const [first, second] = words[0] === "run-all" || words[0] === "run" ? words.slice(1) : words;
  const changes =
    (first !== undefined && TERRAFORM_CHANGES.has(first)) ||
    (first === "state" && second !== undefined && STATE_CHANGES.has(second)) ||
    (first === "workspace" && second === "delete");
  if (!changes) return [];
  // A relative `-chdir` is the session's working directory's; the command names it in full.
  const where = folder === undefined ? (cwd ?? undefined) : (placed(folder, cwd) ?? folder);
  return [
    {
      service: "terraform",
      autoApprove: args.some((a) => /^--?auto-approve(?:=true)?$/.test(a)),
      // The folder goes in as an argument, never as shell text: `sh` runs the fixed script with
      // it as `$1`.
      ...(where === undefined
        ? {}
        : {
            review: review(["sh", "-c", 'cd "$1" && terraform show', "sh", { ref: where }]),
          }),
    },
  ];
}

/** What a shell text does in the cloud, by this module's own reading. */
export function readCloud(command: string, cwd: string | null = null): CloudReading {
  const changes: CloudChange[] = [];
  let localStack = 0;
  for (const simple of simpleCommands(command)) {
    const { program, args } = programAndArgs(simple);
    if (program === "aws" || program === "awslocal") {
      const read = readAws(args, program === "awslocal");
      if (read === "local") localStack += 1;
      else changes.push(...read);
    } else if (program === "terraform" || program === "tofu" || program === "terragrunt") {
      changes.push(...readTerraform(args, cwd));
    }
  }
  return { changes, localStack };
}

/** Guardrails whose match is a Terraform change. */
export const TERRAFORM_RULES: ReadonlySet<string> = new Set([
  "pi.terraform-auto-approve",
  "pi.terraform-state-mutate",
]);

/** Guardrails whose match is an IAM grant. */
export const IAM_RULES: ReadonlySet<string> = new Set(["ps.iam-grant"]);

/**
 * Other guardrails whose match is a cloud change: a cloud resource deleted, a storage ACL made
 * public. When one matched a command that ran and this module's reading found no `aws` or
 * Terraform command in it, the command is in a form the reading does not take apart, and the
 * card could not confirm (`unread-match`). One the reading did take apart, such as an
 * `aws ec2` delete, is outside what the card counts.
 */
export const CLOUD_UNREAD_RULES: ReadonlySet<string> = new Set([
  "pi.cloud-resource-delete",
  "se.public-acl",
]);

/** The programs this module's reading takes apart. */
const CLOUD_PROGRAMS: ReadonlySet<string> = READ_PROGRAMS.cloud;

/** What the cloud check needs. */
export interface CloudInput {
  readonly calls: CorpusCalls;
  readonly catalog: readonly CompiledRule[];
  readonly allowlist: CompiledAllowlist;
}

/** What the cloud check produced. */
export interface CloudOutcome {
  readonly check: CloudCheck;
  readonly localFixes: readonly (LocalFix | UnsafeFix)[];
}

/** Run the cloud check. See the module header. Pure; never throws. */
export function checkCloud(input: CloudInput): CloudOutcome {
  const { agent, calls } = input.calls;
  const terraformRule = rulesMatcher(input.catalog, input.allowlist, (r) =>
    TERRAFORM_RULES.has(r.rule.id),
  );
  const autoApproveRule = rulesMatcher(
    input.catalog,
    input.allowlist,
    (r) => r.rule.id === "pi.terraform-auto-approve",
  );
  const iamRule = rulesMatcher(input.catalog, input.allowlist, (r) => IAM_RULES.has(r.rule.id));
  const unreadRule = rulesMatcher(input.catalog, input.allowlist, (r) =>
    CLOUD_UNREAD_RULES.has(r.rule.id),
  );
  const unread: SessionCall[] = [];
  const counts = {
    iamChanges: 0,
    autoScalingChanges: 0,
    s3Changes: 0,
    terraformChanges: 0,
    terraformAutoApprove: 0,
    localStack: 0,
    mentioned: 0,
    unconfirmed: 0,
  };
  const subjects = new Set<IamSubject>();
  const fixes: (LocalFix | UnsafeFix)[] = [];
  const reviews = new Set<string>();
  let matches = 0;

  for (const call of calls) {
    if (!isShell(call)) continue;
    const ruled = call.ruleIds.some((id) => TERRAFORM_RULES.has(id) || IAM_RULES.has(id));
    // Another cloud guardrail matched, and the reading takes apart no command in the call.
    const unreadable =
      call.ruleIds.some((id) => CLOUD_UNREAD_RULES.has(id)) &&
      !runsAnyOf(call.command, CLOUD_PROGRAMS);
    const reading = readCloud(call.command, call.cwd);
    if (!ruled && !unreadable && reading.changes.length === 0 && reading.localStack === 0) continue;
    const holds = (command: string): boolean => {
      const r = readCloud(command, call.cwd);
      return (
        r.changes.length > 0 ||
        r.localStack > 0 ||
        terraformRule(call, command) ||
        iamRule(call, command) ||
        (unreadable && unreadRule(call, command))
      );
    };
    matches += 1;
    const state = runStateOf(agent, call, holds);
    if (state === "mentioned") {
      counts.mentioned += 1;
      continue;
    }
    if (state === "unknown") {
      counts.unconfirmed += 1;
      continue;
    }

    const ran = executedText(call.command);
    const read = readCloud(ran, call.cwd);
    const changes = [...read.changes];
    counts.localStack += read.localStack;
    // A guardrail's match counts even where the reading above did not recognize the shape.
    if (!changes.some((c) => c.service === "terraform") && terraformRule(call, ran)) {
      changes.push({ service: "terraform", autoApprove: autoApproveRule(call, ran) });
    }
    if (!changes.some((c) => c.service === "iam") && iamRule(call, ran)) {
      changes.push({ service: "iam", subject: "other" });
    }
    // A cloud guardrail matched what ran and nothing here was read: could not confirm.
    if (
      unreadable &&
      changes.length === 0 &&
      read.localStack === 0 &&
      !runsAnyOf(ran, CLOUD_PROGRAMS) &&
      unreadRule(call, ran)
    ) {
      unread.push(call);
    }
    for (const change of changes) {
      if (change.service === "iam") {
        counts.iamChanges += 1;
        subjects.add(change.subject ?? "other");
      } else if (change.service === "auto-scaling") counts.autoScalingChanges += 1;
      else if (change.service === "s3") counts.s3Changes += 1;
      else {
        counts.terraformChanges += 1;
        if (change.autoApprove === true) counts.terraformAutoApprove += 1;
      }
      // The same review command is written once. Each command that could not be made safe is
      // kept, so the file says how many were left out.
      const review = change.review;
      if (review === undefined || fixes.length >= MAX_LOCAL_FIXES) continue;
      if (isLocalFix(review)) {
        if (reviews.has(review.command)) continue;
        reviews.add(review.command);
      }
      fixes.push(review);
    }
  }

  // A cloud command behind a program no check reads, in any call, read or not.
  const behind = backstopCalls(
    input.calls,
    READ_PROGRAMS.cloud,
    (tail, call) => readCloud(tail, call.cwd).changes.length > 0,
    (call, text) => unreadRule(call, text) || terraformRule(call, text) || iamRule(call, text),
  );
  const facts: CloudFacts = {
    ...counts,
    iamSubjects: IAM_SUBJECTS.filter((s) => subjects.has(s)),
    ...hidingFacts(input.calls, [...unread, ...behind]),
  };
  return { check: { status: cloudStatus(facts), matches, facts }, localFixes: fixes };
}

/** Every change counted, across services. */
function changesOf(f: CloudFacts): number {
  return f.iamChanges + f.autoScalingChanges + f.s3Changes + f.terraformChanges;
}

/** The cloud card's tone: `review` whenever a change ran, since none can be checked here. */
export function cloudStatus(facts: CloudFacts): VerifyStatus {
  return changesOf(facts) > 0 ? "review" : quietStatus(facts.unconfirmed, facts.couldHide);
}

// ── The card ─────────────────────────────────────────────────────────────────

/** How each IAM subject reads in a sentence. */
const SUBJECT_WORDS: Readonly<Record<IamSubject, string>> = {
  "access-keys": "access keys",
  policies: "policies",
  roles: "roles",
  users: "users",
  groups: "groups",
  credentials: "sign-in credentials",
  other: "other IAM settings",
};

/** A template that states a count when it is above zero. */
function whenAny(
  id: string,
  count: (f: CloudFacts) => number,
  say: (n: number, f: CloudFacts) => string,
): SentenceTemplate<CloudFacts> {
  return { id, render: (f) => (count(f) > 0 ? say(count(f), f) : undefined) };
}

/** "What checking found". */
export const CLOUD_FOUND: readonly SentenceTemplate<CloudFacts>[] = [
  whenAny(
    "cloud.iam",
    (f) => f.iamChanges,
    (n, f) =>
      `${counted(n, "IAM change", "IAM changes")} ran, touching ${f.iamSubjects.map((s) => SUBJECT_WORDS[s]).join(", ")}.`,
  ),
  whenAny(
    "cloud.auto-scaling",
    (f) => f.autoScalingChanges,
    (n) => `${counted(n, "Auto Scaling change", "Auto Scaling changes")} ran.`,
  ),
  whenAny(
    "cloud.s3",
    (f) => f.s3Changes,
    (n) => `${counted(n, "S3 write or delete", "S3 writes or deletes")} ran.`,
  ),
  whenAny(
    "cloud.terraform",
    (f) => f.terraformChanges,
    (n, f) =>
      `${counted(n, "Terraform command that changes", "Terraform commands that change")} infrastructure or state ran${
        f.terraformAutoApprove > 0 ? `, ${f.terraformAutoApprove} of them with -auto-approve` : ""
      }.`,
  ),
  {
    id: "cloud.nothing",
    render: (f) =>
      changesOf(f) === 0 && f.couldHide === 0 && f.unconfirmed === 0
        ? "No IAM, Auto Scaling, S3 or Terraform change ran."
        : undefined,
  },
  whenAny(
    "cloud.local-stack",
    (f) => f.localStack,
    (n) =>
      `${counted(n, "AWS call", "AWS calls")} went to LocalStack on this machine and ${n === 1 ? "is" : "are"} not counted.`,
  ),
  whenAny(
    "cloud.mentioned",
    (f) => f.mentioned,
    (n, f) =>
      `${moreMatches(n, changesOf(f) + f.localStack > 0)} only mentioned a cloud command and did not run.`,
  ),
  whenAny(
    "cloud.unconfirmed",
    (f) => f.unconfirmed,
    (n) => `${counted(n, "match", "matches")} could not be confirmed as run.`,
  ),
];

/** "Now". */
export const CLOUD_NOW: readonly SentenceTemplate<CloudFacts>[] = [
  whenAny(
    "cloud.cannot-check",
    changesOf,
    () =>
      "Cloud changes cannot be checked from this machine: their current state is in the cloud account, so each needs a person to review it.",
  ),
];

/** "Fix", in sentences. */
export const CLOUD_FIX_STEPS: readonly SentenceTemplate<CloudFacts>[] = [
  whenAny("cloud.fix.review", changesOf, (_, f) =>
    f.iamChanges > 0
      ? "Review each change in the cloud account, starting with IAM, with the read-only commands below."
      : "Review each change in the cloud account with the read-only commands below.",
  ),
];

/** The headline claim: IAM changes ran and need review. Only the IAM count leads. */
export const CLOUD_HEADLINE: SentenceTemplate<CloudFacts> = whenAny(
  "cloud.headline",
  (f) => f.iamChanges,
  (n) => `${counted(n, "IAM change", "IAM changes")} ran and ${n === 1 ? "needs" : "need"} review`,
);

/** The chip label: the number is shown apart. */
const CLOUD_CHIP: SentenceTemplate<CloudFacts> = {
  id: "cloud.chip",
  render: (f) => noun(changesOf(f), "cloud change to review", "cloud changes to review"),
};

/** The redacted review command shapes, for the page and the JSON. */
function cloudShapes(f: CloudFacts): { shape: string }[] {
  const shapes: { shape: string }[] = [];
  // IAM shapes only beside an IAM change, so the card never offers a command it would not review.
  const iam = f.iamChanges > 0 ? f.iamSubjects : [];
  if (iam.includes("access-keys")) {
    shapes.push({ shape: "aws iam list-access-keys --user-name <user>" });
  }
  if (iam.some((s) => s === "policies" || s === "roles")) {
    shapes.push({ shape: "aws iam list-attached-role-policies --role-name <role>" });
  }
  if (iam.includes("users")) {
    shapes.push({ shape: "aws iam list-attached-user-policies --user-name <user>" });
  }
  if (iam.includes("groups")) shapes.push({ shape: "aws iam get-group --group-name <group>" });
  if (f.autoScalingChanges > 0) {
    shapes.push({
      shape: "aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names <group>",
    });
  }
  if (f.s3Changes > 0) shapes.push({ shape: "aws s3 ls s3://<bucket>" });
  if (f.terraformChanges > 0) shapes.push({ shape: "cd <folder> && terraform show" });
  return shapes;
}

/** The card for the cloud check. */
export const cloudCard: ToCard<"cloud"> = (result, context: CardContext) => {
  const f = result.facts;
  const headline = sentence(CLOUD_HEADLINE, f);
  const card: FullCard = {
    category: "cloud",
    tone: result.status,
    count: result.matches,
    found: sentences(CLOUD_FOUND, f),
    now: sentences(CLOUD_NOW, f),
    fixes: cloudShapes(f),
    fixSteps: sentences(CLOUD_FIX_STEPS, f),
    chip: {
      count: changesOf(f),
      label: sentence(CLOUD_CHIP, f) ?? { template: CLOUD_CHIP.id, text: "" },
    },
    codexCaveat: restsOnCodex(context) && changesOf(f) > 0,
    ...(headline === undefined
      ? {}
      : {
          headline: {
            basis: "iam-changes",
            count: f.iamChanges,
            restsOnCodexRan: restsOnCodex(context),
            sentence: headline,
          },
        }),
  };
  return card;
};
