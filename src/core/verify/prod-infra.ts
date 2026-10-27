// cspell:words kubectl orbstack tflocal awslocal kubeconfig apiserver esac
/**
 * The production infrastructure check, for the "Production infrastructure" card: database and
 * infrastructure targets classed as "other" (not this machine, not a scratch copy), from
 * commands that RAN.
 *
 * Two inputs:
 *  - **Database targets**, classed local, scratch or other by the destructive-commands check,
 *    which reads them. They arrive as counts per class (`DatabaseTargetCounts`), passed in by
 *    the orchestrator. When that check could not supply them, the database half reads as not
 *    available, and the card never says clean.
 *  - **Production infrastructure guardrails** (category `prod-infra`): every command or edit
 *    one of them matched that ran. Terraform, kubectl, Helm, cloud deletes, production deploys
 *    and production config edits.
 *
 * What these did to a production system cannot be seen from this machine, so the category is
 * `review` whenever either half found something.
 *
 * What leaves this module is counts and fixed enums.
 */

import type { CompiledAllowlist } from "../evaluate.js";
import type { CompiledRule } from "../rules.js";
import {
  type CorpusCalls,
  couldHideCount,
  executedText,
  heldHidingForms,
  isShell,
  programAndArgs,
  quietStatus,
  rulesMatcher,
  runStateOf,
  simpleCommands,
} from "./calls.js";
import { couldHideTemplate, counted, type FullCard, restsOnCodex } from "./card-parts.js";
import {
  type CardContext,
  type ChipReason,
  chipFor,
  type SentenceTemplate,
  sentences,
  type ToCard,
} from "./cards.js";
import { DATABASE_CHECKS, INFRA_KINDS } from "./command-facts.js";
import { endpointsLocal } from "./hosts.js";
import { commandHidingForms } from "./ran.js";
import type { CheckedCategory, HidingForm, VerifyStatus } from "./types.js";

export { DATABASE_CHECKS, INFRA_KINDS };

/**
 * Database targets from commands that ran, by class: on this machine, a scratch copy, or
 * anything else. This is the input the destructive-commands check supplies.
 */
export interface DatabaseTargetCounts {
  readonly local: number;
  readonly scratch: number;
  readonly other: number;
}

/** One of `DATABASE_CHECKS`. */
export type DatabaseCheck = (typeof DATABASE_CHECKS)[number];

/** One of `INFRA_KINDS`. */
export type InfraKind = (typeof INFRA_KINDS)[number];

/** What the production infrastructure check found. Every count is of calls that ran. */
export interface ProdInfraFacts {
  /** All zero when `databaseCheck` is `not-available`. */
  readonly databaseTargets: DatabaseTargetCounts;
  readonly databaseCheck: DatabaseCheck;
  /** Commands and edits a production infrastructure guardrail matched. */
  readonly infraMatches: number;
  /** What those were about, in `INFRA_KINDS` order. */
  readonly infraKinds: readonly InfraKind[];
  /**
   * Matches that ran but whose target is this machine: a local Kubernetes cluster (kind, k3d,
   * minikube, Docker Desktop, Rancher Desktop, Colima, OrbStack) or LocalStack. Not counted.
   */
  readonly localInfra: number;
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
    "prod-infra": ProdInfraFacts;
  }
}

/** The production infrastructure category's result. */
export type ProdInfraCheck = CheckedCategory<ProdInfraFacts>;

/** The guardrail category this check reads. */
export const PROD_INFRA_CATEGORY = "prod-infra";

/** What each shipped production guardrail is about. A guardrail not listed is `other`. */
const KIND_OF_RULE: ReadonlyMap<string, InfraKind> = new Map([
  ["pi.terraform-auto-approve", "terraform"],
  ["pi.terraform-state-mutate", "terraform"],
  ["pi.kubectl-delete", "kubernetes"],
  ["pi.prod-namespace", "kubernetes"],
  ["pi.helm-release", "helm"],
  ["pi.cloud-resource-delete", "cloud-delete"],
  ["pi.deploy-to-prod", "deploy"],
  ["block-prod-config-edit", "prod-config"],
]);

/** A Kubernetes context of a cluster on this machine. */
const LOCAL_KUBE_CONTEXT =
  /^(?:kind-.+|k3d-.+|minikube|docker-desktop|docker-for-desktop|rancher-desktop|colima(?:-.+)?|orbstack|localhost)$/;

/** Kubernetes options whose value names the cluster context. */
const CONTEXT_OPTIONS: ReadonlySet<string> = new Set(["--context", "--kube-context"]);

/**
 * Kubernetes options that send a command somewhere other than its context's cluster: another
 * API server, another kubeconfig file, or another cluster entry in it.
 */
const KUBE_TARGET_OPTIONS: ReadonlySet<string> = new Set([
  "--server",
  "-s",
  "--kubeconfig",
  "--cluster",
  "--kube-apiserver",
]);

/** A variable that names the kubeconfig file. */
const KUBECONFIG_VARIABLE = /^KUBECONFIG=/;

/** The infrastructure tools whose target `targetsOnlyThisMachine` reads. */
const LOCAL_TARGET_PROGRAMS: ReadonlySet<string> = new Set([
  "kubectl",
  "helm",
  "tflocal",
  "awslocal",
  "aws",
]);

/**
 * Programs a text aimed only at this machine may run beside the infrastructure tools read below:
 * shell words and programs that print or look at something, and run no other command. `""` is a
 * simple command with no program, only assignments.
 */
const LOCAL_SIDE_PROGRAMS: ReadonlySet<string> = new Set([
  "",
  "cd",
  "export",
  "unset",
  "fi",
  "done",
  "esac",
  "true",
  "false",
  "sleep",
  "pwd",
  "echo",
  "printf",
  "ls",
  "cat",
  "grep",
  "head",
  "tail",
  "wc",
  "jq",
  "sort",
  "uniq",
]);

/**
 * Does a shell text aim only at this machine? Every `kubectl` or `helm` in it names a local
 * context (`--context kind-dev`) and nothing that points it elsewhere, every Terraform runs as
 * `tflocal`, and every AWS call goes to an endpoint on this machine or through `awslocal`. A
 * command that names no target is not taken as local.
 *
 * The context's name is trusted: a context named `kind-dev` is taken as a kind cluster on this
 * machine, as kind names it. A `--server`, `--kubeconfig`, `--cluster` or `--kube-apiserver`,
 * or a `KUBECONFIG` set on the command or exported earlier in the text, can point that name at
 * another cluster, so with any of them the command is not local.
 *
 * It fails closed: a text that runs any other program (`LOCAL_SIDE_PROGRAMS` aside), such as
 * `terraform` or a wrapper this reading does not take apart, or that holds a hiding form
 * (`commandHidingForms`), is not local, whatever its local commands name.
 */
export function targetsOnlyThisMachine(command: string): boolean {
  if (commandHidingForms(command).length > 0) return false;
  let any = false;
  let kubeconfigSet = false;
  for (const simple of simpleCommands(command)) {
    const { program, args, assignments } = programAndArgs(simple);
    if (program === "export" && args.some((a) => KUBECONFIG_VARIABLE.test(a))) kubeconfigSet = true;
    if (!LOCAL_SIDE_PROGRAMS.has(program) && !LOCAL_TARGET_PROGRAMS.has(program)) return false;
    if (program === "kubectl" || program === "helm") {
      any = true;
      if (kubeconfigSet || assignments.some((a) => KUBECONFIG_VARIABLE.test(a))) return false;
      let context: string | undefined;
      for (let k = 0; k < args.length; k++) {
        const arg = args[k] as string;
        const eq = arg.indexOf("=");
        const name = arg.startsWith("-") && eq > 0 ? arg.slice(0, eq) : arg;
        if (KUBE_TARGET_OPTIONS.has(name)) return false;
        if (CONTEXT_OPTIONS.has(arg)) context = args[k + 1];
        else if (eq > 0 && CONTEXT_OPTIONS.has(name)) context = arg.slice(eq + 1);
      }
      if (context === undefined || !LOCAL_KUBE_CONTEXT.test(context)) return false;
    } else if (program === "tflocal" || program === "awslocal") any = true;
    else if (program === "aws") {
      // Every `--endpoint-url` must be this machine, and there must be one.
      any = true;
      if (endpointsLocal(args) !== true) return false;
    }
  }
  return any;
}

/** What the production infrastructure check needs. */
export interface ProdInfraInput {
  readonly calls: CorpusCalls;
  readonly catalog: readonly CompiledRule[];
  readonly allowlist: CompiledAllowlist;
  /**
   * The database targets from commands that ran, by class, from the destructive-commands
   * check. `undefined` when it could not supply them.
   */
  readonly databaseTargets: DatabaseTargetCounts | undefined;
  /**
   * Database commands that ran whose target could not be told (a host from a variable, a
   * service file or the tool's own config). Never read as local: each counts as unconfirmed, so
   * the card cannot read clean while one is there.
   */
  readonly databaseTargetsUnresolved?: number;
}

/** Run the production infrastructure check. See the module header. Pure; never throws. */
export function checkProdInfra(input: ProdInfraInput): ProdInfraCheck {
  const { agent, calls } = input.calls;
  const isProdRule = (rule: CompiledRule): boolean => rule.rule.category === PROD_INFRA_CATEGORY;
  const prodIds = new Set(input.catalog.filter(isProdRule).map((r) => r.rule.id));
  const prodRule = rulesMatcher(input.catalog, input.allowlist, isProdRule);
  const kinds = new Set<InfraKind>();
  let infraMatches = 0;
  let localInfra = 0;
  let mentioned = 0;
  let unconfirmed = 0;
  let candidates = 0;

  for (const call of calls) {
    const matched = call.ruleIds.filter((id) => prodIds.has(id));
    if (matched.length === 0) continue;
    candidates += 1;
    // An edit, or any other call a production guardrail reads by path, has no text that is
    // only mentioned: it ran when its result says so.
    const state = isShell(call)
      ? runStateOf(agent, call, (command) => prodRule(call, command))
      : runStateOf(agent, call, () => true);
    if (state === "mentioned") mentioned += 1;
    else if (state === "unknown") unconfirmed += 1;
    else if (
      isShell(call) &&
      call.hidingForms.length === 0 &&
      targetsOnlyThisMachine(executedText(call.command))
    )
      localInfra += 1;
    else {
      infraMatches += 1;
      for (const id of matched) kinds.add(KIND_OF_RULE.get(id) ?? "other");
    }
  }

  const supplied = input.databaseTargets;
  const facts: ProdInfraFacts = {
    databaseTargets: {
      local: supplied?.local ?? 0,
      scratch: supplied?.scratch ?? 0,
      other: supplied?.other ?? 0,
    },
    databaseCheck: supplied === undefined ? "not-available" : "checked",
    infraMatches,
    infraKinds: INFRA_KINDS.filter((k) => kinds.has(k)),
    localInfra,
    mentioned,
    unconfirmed: unconfirmed + Math.max(0, input.databaseTargetsUnresolved ?? 0),
    couldHide: couldHideCount(input.calls),
    hidingForms: heldHidingForms(input.calls),
  };
  return {
    status: prodInfraStatus(facts),
    matches: candidates + facts.databaseTargets.other,
    facts,
  };
}

/** The production card's tone: `review` when either half found a production target. */
export function prodInfraStatus(facts: ProdInfraFacts): VerifyStatus {
  if (facts.databaseTargets.other > 0 || facts.infraMatches > 0) return "review";
  if (facts.databaseCheck === "not-available") return "could-not-check";
  return quietStatus(facts.unconfirmed, facts.couldHide);
}

// ── The card ─────────────────────────────────────────────────────────────────

/** How each kind reads in a sentence. */
const KIND_WORDS: Readonly<Record<InfraKind, string>> = {
  terraform: "Terraform",
  kubernetes: "Kubernetes",
  helm: "Helm releases",
  "cloud-delete": "cloud resource deletes",
  deploy: "production deploys",
  "prod-config": "production config edits",
  other: "your own production guardrails",
};

/** A template that renders when `when` holds. */
function when(
  id: string,
  test: (f: ProdInfraFacts) => boolean,
  say: (f: ProdInfraFacts) => string,
): SentenceTemplate<ProdInfraFacts> {
  return { id, render: (f) => (test(f) ? say(f) : undefined) };
}

/** "What checking found". */
export const PROD_FOUND: readonly SentenceTemplate<ProdInfraFacts>[] = [
  when(
    "prod.databases",
    (f) => f.databaseCheck === "checked" && f.databaseTargets.other > 0,
    (f) =>
      `${counted(f.databaseTargets.other, "database command", "database commands")} that ran targeted a database that is not on this machine or a scratch copy, which this report counts as production.`,
  ),
  when(
    "prod.databases-local",
    (f) => f.databaseCheck === "checked" && f.databaseTargets.local + f.databaseTargets.scratch > 0,
    (f) => {
      const n = f.databaseTargets.local + f.databaseTargets.scratch;
      return `${counted(n, "database command", "database commands")} targeted a local or scratch database and ${n === 1 ? "is" : "are"} not counted.`;
    },
  ),
  when(
    "prod.databases-none",
    (f) =>
      f.databaseCheck === "checked" &&
      f.databaseTargets.other === 0 &&
      f.couldHide === 0 &&
      f.unconfirmed === 0,
    () => "No database command that ran targeted a database beyond local and scratch ones.",
  ),
  when(
    "prod.databases-unavailable",
    (f) => f.databaseCheck === "not-available",
    () => "Database targets could not be checked, so this is not a clean result.",
  ),
  when(
    "prod.infra",
    (f) => f.infraMatches > 0,
    (f) =>
      `${counted(f.infraMatches, "command or edit", "commands or edits")} that ran matched a production infrastructure guardrail: ${f.infraKinds.map((k) => KIND_WORDS[k]).join(", ")}.`,
  ),
  when(
    "prod.local-infra",
    (f) => f.localInfra > 0,
    (f) =>
      `${counted(f.localInfra, "match", "matches")} targeted this machine (a local Kubernetes cluster or LocalStack) and ${f.localInfra === 1 ? "is" : "are"} not counted.`,
  ),
  when(
    "prod.infra-none",
    (f) => f.infraMatches === 0 && f.couldHide === 0 && f.unconfirmed === 0,
    // After the line on matches that targeted this machine, "other" keeps the two from
    // contradicting each other.
    (f) =>
      f.localInfra > 0
        ? "No other command or edit that ran matched a production infrastructure guardrail."
        : "No command or edit that ran matched a production infrastructure guardrail.",
  ),
  couldHideTemplate("prod.could-hide"),
  when(
    "prod.mentioned",
    (f) => f.mentioned > 0,
    (f) =>
      `${counted(f.mentioned, "more match", "more matches")} only mentioned a production command and did not run.`,
  ),
  when(
    "prod.unconfirmed",
    (f) => f.unconfirmed > 0,
    (f) => `${counted(f.unconfirmed, "match", "matches")} could not be confirmed as run.`,
  ),
];

/** Is there anything on the card to review? */
function anyTarget(f: ProdInfraFacts): boolean {
  return f.databaseTargets.other > 0 || f.infraMatches > 0;
}

/** "Now". */
export const PROD_NOW: readonly SentenceTemplate<ProdInfraFacts>[] = [
  when(
    "prod.cannot-check",
    anyTarget,
    () => "What these did to a production system cannot be checked from this machine.",
  ),
];

/** "Fix", in sentences. */
export const PROD_FIX_STEPS: readonly SentenceTemplate<ProdInfraFacts>[] = [
  when(
    "prod.fix.review",
    anyTarget,
    () => "Review each one with whoever owns the production system it touched.",
  ),
];

/** The chip's usual claim: the number is shown apart. */
const PROD_CHIP: ChipReason<ProdInfraFacts> = {
  id: "prod.chip",
  count: (f) => f.databaseTargets.other,
  one: "production database touched",
  many: "production databases touched",
};

/** What can make the card review, in the order `prodInfraStatus` reads them. */
const PROD_CHIP_REASONS: readonly ChipReason<ProdInfraFacts>[] = [
  PROD_CHIP,
  {
    id: "prod.chip.infra",
    count: (f) => f.infraMatches,
    one: "command matched a production infrastructure guardrail",
    many: "commands matched a production infrastructure guardrail",
  },
];

/** The card for the production infrastructure check. */
export const prodInfraCard: ToCard<"prod-infra"> = (result, context: CardContext) => {
  const f = result.facts;
  const card: FullCard = {
    category: "prod-infra",
    tone: result.status,
    count: result.matches,
    found: sentences(PROD_FOUND, f),
    now: sentences(PROD_NOW, f),
    fixes: [],
    fixSteps: sentences(PROD_FIX_STEPS, f),
    chip: chipFor(f, PROD_CHIP_REASONS, PROD_CHIP),
    codexCaveat: restsOnCodex(context) && anyTarget(f),
  };
  return card;
};
