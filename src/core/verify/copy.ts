/**
 * The words the report uses for verified results: category titles, tone labels, credential
 * kinds, how a credential got into a transcript, and the sentences around the cards.
 *
 * Every sentence here is a `SentenceTemplate` over typed facts, so the page states only what a
 * check produced (see `cards.ts`). The fixed labels are names, not claims: a category's title,
 * a tone's name, a kind of credential. A label never carries text read from this machine.
 *
 * Pure. No I/O.
 */

import { formatCount } from "../tokens.js";
import type { CardSentence, CardView, SentenceTemplate } from "./cards.js";
import { sentence, sentences } from "./cards.js";
import type {
  SecretItem,
  SecretKind,
  SecretProvenance,
  Verification,
  VerifyCategory,
  VerifyStatus,
} from "./types.js";

/** `n` and a noun, the plural when `n` is not 1. */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** Each category's card title, as the report heads it. */
export const CATEGORY_TITLES: Readonly<Record<VerifyCategory, string>> = {
  secrets: "Secrets in transcripts",
  "skipped-checks": "Skipped safety checks",
  "lost-work": "Lost work",
  cloud: "Cloud and permissions",
  "prod-infra": "Production infrastructure",
  tests: "Gaming tests",
  destructive: "Destructive commands",
  unreviewed: "Unreviewed code",
  egress: "Data leaving the machine",
};

/** Each tone's label on a card and a chip. */
export const TONE_LABELS: Readonly<Record<VerifyStatus, string>> = {
  act: "Act on this",
  review: "Review",
  clean: "Clean",
  "could-not-check": "Could not check",
  "not-checked": "Not checked",
};

/** What each kind of credential is called on the page. Never the name a value was given. */
export const KIND_LABELS: Readonly<Record<SecretKind, string>> = {
  "aws-access-key": "AWS access key",
  "aws-secret-key": "AWS secret key",
  "private-key": "Private key",
  "github-token": "GitHub token",
  "slack-token": "Slack token",
  "api-key": "API key",
  jwt: "JSON web token",
  "bearer-token": "Bearer token",
  "auth-header": "Authorization header",
  "database-url": "Database URL with a password",
  "url-credentials": "URL with a password",
  password: "Password",
  "named-secret": "A named secret",
  "random-string": "Random-looking secret",
  other: "Other credential",
};

/** How a credential got into a transcript, as the page says it. */
export const PROVENANCE_PHRASES: Readonly<Record<SecretProvenance, string>> = {
  "pasted-into-prompt": "you pasted it into a prompt",
  "typed-into-command": "typed into a command",
  "printed-by-command": "printed by a command",
  "in-agent-reply": "in an agent reply",
};

/** One row of "What it found, never the values": three parts, each a fixed label or a count. */
export interface EvidenceRow {
  /** The kind of credential. */
  readonly kind: string;
  /** Every way it got there, joined. */
  readonly how: string;
  /** How many transcript files hold it. */
  readonly files: string;
}

/** The never-the-values row for one likely-real credential. */
export function evidenceRow(item: SecretItem): EvidenceRow {
  // A kind or a way in this build does not know is shown as "other", or left out: never raw.
  return {
    kind: KIND_LABELS[item.kind] ?? KIND_LABELS.other,
    how: item.via
      .map((via) => PROVENANCE_PHRASES[via])
      .filter((phrase) => phrase !== undefined)
      .join(", "),
    files: `in ${countOf(item.files, "transcript file")}`,
  };
}

/** The line under the list when it is capped. */
export const MORE_EVIDENCE: SentenceTemplate<{ readonly more: number }> = {
  id: "evidence.more",
  render: ({ more }) =>
    more > 0
      ? `And ${countOf(more, "more likely-real credential", "more likely-real credentials")}.`
      : undefined,
};

// ── The notes above the chips: what a count counts ────────────────────────────

/** The matched calls behind the verification, and what their `ran` rests on. */
type CallFacts = Pick<Verification, "matchedCalls" | "resultsRecorded" | "ranEvidence">;

const RAN_BASIS: SentenceTemplate<CallFacts> = {
  id: "lead.ran-basis",
  render: (v) =>
    v.resultsRecorded
      ? "Checked against command output: a match counts only when the transcript records that its command ran."
      : undefined,
};

const NO_RESULTS: SentenceTemplate<CallFacts> = {
  id: "lead.no-results",
  render: (v) =>
    v.resultsRecorded
      ? undefined
      : "These sessions record no command output, so no matched command could be confirmed as run. A count of commands that ran is zero here because nothing could be confirmed, not because nothing ran.",
};

const MENTIONED: SentenceTemplate<CallFacts> = {
  id: "lead.mentioned",
  render: (v) =>
    v.matchedCalls.mentioned > 0
      ? `${countOf(v.matchedCalls.mentioned, "match", "matches")} only mentioned a command, in a search, a message or a file, and ${v.matchedCalls.mentioned === 1 ? "is" : "are"} left out.`
      : undefined,
};

const UNCONFIRMED: SentenceTemplate<CallFacts> = {
  id: "lead.unconfirmed",
  render: (v) =>
    v.resultsRecorded && v.matchedCalls.unknown > 0
      ? `${countOf(v.matchedCalls.unknown, "matched call")} had no recorded output to show ${v.matchedCalls.unknown === 1 ? "it" : "they"} ran, and ${v.matchedCalls.unknown === 1 ? "is" : "are"} left out.`
      : undefined,
};

const CODEX_RAN: SentenceTemplate<CallFacts> = {
  id: "lead.codex-ran",
  render: (v) =>
    v.ranEvidence === "output-record" && v.matchedCalls.ran > 0
      ? "A Codex call counts as ran when Codex recorded an output for it, which may include calls a hook blocked."
      : undefined,
};

/** What every Codex scan says about its own reading, the same words the terminal uses. */
export const CODEX_UNVERIFIED_TEXT =
  "The Codex reading is limited and unverified: it is tested on synthetic sessions only.";

const CODEX_UNVERIFIED: SentenceTemplate<CallFacts> = {
  id: "lead.codex-unverified",
  render: (v) =>
    v.ranEvidence === "output-record"
      ? `${CODEX_UNVERIFIED_TEXT} No Codex finding leads this page.`
      : undefined,
};

/** The notes above the chips, in order. */
export const LEAD_NOTES: readonly SentenceTemplate<CallFacts>[] = [
  RAN_BASIS,
  NO_RESULTS,
  MENTIONED,
  UNCONFIRMED,
  CODEX_UNVERIFIED,
  CODEX_RAN,
];

/** The notes above the chips for one verification. */
export function leadNotes(verification: CallFacts): CardSentence[] {
  return sentences(LEAD_NOTES, verification);
}

// ── Chips ─────────────────────────────────────────────────────────────────────

/**
 * The categories that may have a chip, in the order they are offered. The headline's category is
 * left out and the first six of the rest are shown.
 */
export const CHIP_CANDIDATES = [
  "secrets",
  "skipped-checks",
  "lost-work",
  "cloud",
  "prod-infra",
  "destructive",
  "egress",
] as const satisfies readonly VerifyCategory[];

/** How many chips the page shows. */
export const CHIP_COUNT = 6;

/** The chips' categories for a headline, in order. */
export function chipCategories(headline: VerifyCategory | undefined): VerifyCategory[] {
  return CHIP_CANDIDATES.filter((c) => c !== headline).slice(0, CHIP_COUNT);
}

/** A chip with no claim of its own states its card's tone. */
export const CHIP_TONE: SentenceTemplate<Pick<CardView, "tone">> = {
  id: "chip.tone",
  render: ({ tone }) => TONE_LABELS[tone].toLowerCase(),
};

/** The words a chip shows after its count, or after its title when it has no claim. */
export function chipText(card: CardView): {
  readonly count?: number;
  readonly label: CardSentence;
} {
  const counted =
    card.chip !== undefined &&
    (card.tone === "act" || card.tone === "review" || card.tone === "clean");
  // A card that could not confirm never shows a zero: only a count it did find stands.
  if (card.unconfirmed !== undefined && (!counted || (card.chip?.count ?? 0) === 0)) {
    return {
      label: sentence(CHIP_UNCONFIRMED, card) ?? { template: CHIP_UNCONFIRMED.id, text: "" },
    };
  }
  if (counted && card.chip !== undefined) {
    return { count: card.chip.count, label: card.chip.label };
  }
  return { label: sentence(CHIP_TONE, card) ?? { template: CHIP_TONE.id, text: "" } };
}

/** A chip whose card could not confirm what it reports. */
export const CHIP_UNCONFIRMED: SentenceTemplate<Pick<CardView, "unconfirmed">> = {
  id: "chip.could-not-confirm",
  render: ({ unconfirmed }) => (unconfirmed === undefined ? undefined : "could not confirm"),
};

/** A card's tone label: "Could not confirm" for a card that could not, else its tone's. */
export function toneLabel(card: Pick<CardView, "tone" | "unconfirmed">): string {
  return card.unconfirmed !== undefined && card.tone === "could-not-check"
    ? "Could not confirm"
    : TONE_LABELS[card.tone];
}

// ── Card lines that are the same for every category ──────────────────────────

/** The line on a card whose counts rest on Codex `ran` records. */
export const CODEX_CAVEAT: SentenceTemplate<Pick<CardView, "codexCaveat">> = {
  id: "card.codex-caveat",
  render: ({ codexCaveat }) =>
    codexCaveat
      ? "Codex counts here include every call Codex recorded an output for, which may include calls a hook blocked."
      : undefined,
};

/** How many cards have each tone, for the section's heading line. */
export const TONE_TALLY: SentenceTemplate<readonly Pick<CardView, "tone">[]> = {
  id: "cards.tally",
  render: (cards) => {
    const parts: string[] = [];
    const n = (tone: VerifyStatus): number => cards.filter((c) => c.tone === tone).length;
    if (n("act") > 0) parts.push(`${formatCount(n("act"))} to act on`);
    if (n("review") > 0) parts.push(`${formatCount(n("review"))} to review`);
    if (n("clean") > 0) parts.push(`${formatCount(n("clean"))} clean`);
    if (n("could-not-check") > 0)
      parts.push(`${formatCount(n("could-not-check"))} could not check`);
    if (n("not-checked") > 0) parts.push(`${formatCount(n("not-checked"))} not checked`);
    return parts.length === 0 ? undefined : parts.join(" · ");
  },
};

/**
 * Where a card's exact fix commands are. The local file holds real names and paths, so the page
 * names it and never shows its contents.
 */
export const FIXES_FILE_NOTE: SentenceTemplate<{ readonly variant: "document" | "artifact" }> = {
  id: "card.fixes-file",
  render: ({ variant }) =>
    variant === "artifact"
      ? `The exact commands, with real names and paths, are in ${FIXES_FILE} on the machine the scan ran on. That file was not published with this page.`
      : `The exact commands for this machine, with real names and paths, are in ${FIXES_FILE} next to this report. That file stays on this machine and is not part of this page.`,
};

/** The fixes file's name. `report.ts` exports it as `FIXES_FILENAME`. */
export const FIXES_FILE = "agenttrail-guard-fixes.txt";

/**
 * A card's raw count, as the page states it: its own count line when it has one, "N matches"
 * otherwise. Absent for a category with no check, and for a check that could not finish with
 * no count.
 */
export function cardCount(card: CardView): CardSentence | undefined {
  if (card.tone === "not-checked" || (card.tone === "could-not-check" && card.count === 0)) {
    return undefined;
  }
  return card.countLine ?? sentence(CARD_COUNT, card);
}

/** A card's raw count, as "N matches". Absent for a category with no check. */
export const CARD_COUNT: SentenceTemplate<Pick<CardView, "tone" | "count">> = {
  id: "card.count",
  render: ({ tone, count }) =>
    tone === "not-checked" || (tone === "could-not-check" && count === 0)
      ? undefined
      : countOf(count, "match", "matches"),
};
