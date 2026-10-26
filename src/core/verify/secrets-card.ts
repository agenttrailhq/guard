/**
 * The secrets card: what the secrets check found, in sentences made from its facts.
 *
 * Every line reads `SecretsFacts`, which holds counts and fixed enums only, so no line can carry
 * a value or the name a value was given. A count of credentials is of distinct values.
 *
 * The card makes no claim that rests on calls having run: a credential is found in the text of a
 * transcript, whatever app wrote it, so it never needs the Codex caveat. It still never leads a
 * Codex scan: nothing does, since the Codex reading is limited and unverified (`pickHeadline`).
 *
 * Pure. No I/O.
 */

import { formatCount } from "../tokens.js";
import type { CardView, SentenceTemplate, ToCard } from "./cards.js";
import { sentence, sentences } from "./cards.js";
import { countOf } from "./copy.js";
import type { SecretsFacts } from "./types.js";

/** Likely-real credentials, as a counted phrase. */
function likelyReal(n: number): string {
  return countOf(n, "likely-real credential");
}

/** `is` or `are` for a count. */
function be(n: number): string {
  return n === 1 ? "is" : "are";
}

/** Any credential-shaped value at all, of any class. Set-aside values are placeholders. */
function anyFound(f: SecretsFacts): boolean {
  return (
    f.classes["likely-real"] +
      f.classes["committed-fixture"] +
      f.classes.placeholder +
      f.classes["local-dev"] >
    0
  );
}

const FOUND_LIKELY_REAL: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.likely-real",
  render: (f) =>
    f.classes["likely-real"] > 0
      ? `Found ${likelyReal(f.classes["likely-real"])} in ${countOf(f.filesRead, "transcript file")}.`
      : undefined,
};

const FOUND_NO_LIKELY_REAL: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.no-likely-real",
  render: (f) =>
    f.classes["likely-real"] === 0 && f.filesRead > 0
      ? anyFound(f)
        ? `Found no likely-real credential in ${countOf(f.filesRead, "transcript file")}.`
        : `Found no credential-shaped value in ${countOf(f.filesRead, "transcript file")}.`
      : undefined,
};

const FOUND_FIXTURES: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.committed-fixtures",
  render: (f) => {
    const n = f.classes["committed-fixture"];
    if (n === 0) return undefined;
    return n === 1
      ? "1 value is also in a git-tracked file, a committed fixture: it may be test data, or a real secret that was committed."
      : `${formatCount(n)} values are also in git-tracked files, committed fixtures: each may be test data, or a real secret that was committed.`;
  },
};

const FOUND_NOT_COUNTED: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.not-counted",
  render: (f) => {
    const parts: string[] = [];
    const placeholders = f.classes.placeholder;
    const local = f.classes["local-dev"];
    if (placeholders > 0) {
      parts.push(
        countOf(placeholders, "placeholder or false positive", "placeholders or false positives"),
      );
    }
    if (local > 0) {
      parts.push(`${countOf(local, "local dev value")} for a database or service on this machine`);
    }
    return parts.length > 0 ? `Not counted as likely real: ${parts.join(", and ")}.` : undefined;
  },
};

const FOUND_SET_ASIDE: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.set-aside",
  render: (f) => {
    // A subset of the placeholders, set aside by a rule that can miss a real credential.
    const { unnamedOutputOnly, namedNotCredentialShaped } = f.setAside;
    const n = unnamedOutputOnly + namedNotCredentialShaped;
    if (n === 0) return undefined;
    const why: string[] = [];
    if (unnamedOutputOnly > 0) {
      why.push(`${formatCount(unnamedOutputOnly)} unnamed and seen only in output or replies`);
    }
    if (namedNotCredentialShaped > 0) {
      why.push(`${formatCount(namedNotCredentialShaped)} named but not shaped like a credential`);
    }
    return `Of the placeholders or false positives, ${formatCount(n)} ${n === 1 ? "was" : "were"} set aside by a rule that can miss a real credential: ${why.join(", and ")}.`;
  },
};

const FOUND_FIXTURES_PARTIAL: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.fixtures-partial",
  render: (f) =>
    f.classes["likely-real"] > 0 && f.fixtureCheck === "partial"
      ? `${countOf(f.reposNotChecked, "repo")} could not be searched for committed fixtures, so some of these may be fixtures.`
      : undefined,
};

const FOUND_FIXTURES_UNAVAILABLE: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.fixtures-unavailable",
  render: (f) =>
    f.classes["likely-real"] > 0 && f.fixtureCheck === "unavailable"
      ? "No repo could be searched for committed fixtures, so a fixture would be counted here as likely real."
      : undefined,
};

const FOUND_UNREAD: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.unread",
  render: (f) =>
    f.filesNotRead > 0
      ? `${countOf(f.filesNotRead, "transcript file")} could not be read.`
      : undefined,
};

const FOUND_UNPLACED: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.unplaced",
  render: (f) =>
    f.unplaced > 0
      ? `${countOf(f.unplaced, "redacted text")} could not be lined up with the original, so ${f.unplaced === 1 ? "it was" : "they were"} not classed.`
      : undefined,
};

const FOUND_METHOD: SentenceTemplate<SecretsFacts> = {
  id: "secrets.found.method",
  render: (f) =>
    f.filesRead > 0
      ? "Each value was classed by its format and by where else it appears. None was checked with the service that issued it."
      : undefined,
};

/** "What checking found", in order. */
export const SECRETS_FOUND: readonly SentenceTemplate<SecretsFacts>[] = [
  FOUND_LIKELY_REAL,
  FOUND_NO_LIKELY_REAL,
  FOUND_FIXTURES,
  FOUND_NOT_COUNTED,
  FOUND_SET_ASIDE,
  FOUND_FIXTURES_PARTIAL,
  FOUND_FIXTURES_UNAVAILABLE,
  FOUND_UNREAD,
  FOUND_UNPLACED,
  FOUND_METHOD,
];

const NOW_STILL_THERE: SentenceTemplate<SecretsFacts> = {
  id: "secrets.now.still-there",
  render: (f) => {
    const n = f.classes["likely-real"];
    if (n === 0) return undefined;
    return n === 1
      ? "It is still in the transcript files on this machine, where anything that can read those files can read it."
      : `All ${formatCount(n)} are still in the transcript files on this machine, where anything that can read those files can read them.`;
  },
};

const NOW_FIXTURES: SentenceTemplate<SecretsFacts> = {
  id: "secrets.now.committed-fixtures",
  render: (f) => {
    const n = f.classes["committed-fixture"];
    if (n === 0) return undefined;
    return n === 1
      ? "The committed fixture is in a git-tracked file today, and so in the repo's history."
      : `The ${formatCount(n)} committed fixtures are in git-tracked files today, and so in the repo's history.`;
  },
};

const NOW_NOTHING: SentenceTemplate<SecretsFacts> = {
  id: "secrets.now.nothing",
  render: (f) =>
    f.classes["likely-real"] === 0 && f.classes["committed-fixture"] === 0 && f.filesRead > 0
      ? "There is no likely-real credential to rotate."
      : undefined,
};

/** "Now", in order. */
export const SECRETS_NOW: readonly SentenceTemplate<SecretsFacts>[] = [
  NOW_STILL_THERE,
  NOW_FIXTURES,
  NOW_NOTHING,
];

const FIX_ROTATE: SentenceTemplate<SecretsFacts> = {
  id: "secrets.fix.rotate",
  render: (f) => {
    const n = f.classes["likely-real"];
    if (n === 0) return undefined;
    return n === 1
      ? "Rotate it first, with the service that issued it, so the copy in the transcripts no longer works."
      : "Rotate each one first, with the service that issued it, so the copies in the transcripts no longer work.";
  },
};

const FIX_FIXTURES: SentenceTemplate<SecretsFacts> = {
  id: "secrets.fix.committed-fixtures",
  render: (f) =>
    f.classes["committed-fixture"] > 0
      ? "If a committed fixture is a real secret, rotate it as well: removing the file does not remove it from the repo's history."
      : undefined,
};

/** "Fix", in words, in order. */
export const SECRETS_FIX: readonly SentenceTemplate<SecretsFacts>[] = [FIX_ROTATE, FIX_FIXTURES];

/** The headline this card offers. */
export const SECRETS_HEADLINE: SentenceTemplate<SecretsFacts> = {
  id: "secrets.headline",
  render: (f) => {
    const n = f.classes["likely-real"];
    return n > 0 ? `${likelyReal(n)} ${be(n)} still in the agent's transcripts` : undefined;
  },
};

/** The card's raw count: distinct credential-shaped values, of every class. */
export const SECRETS_COUNT: SentenceTemplate<{ readonly matches: number }> = {
  id: "secrets.count",
  render: ({ matches }) => countOf(matches, "credential-shaped value"),
};

/** The chip's label, after its count. */
export const SECRETS_CHIP: SentenceTemplate<SecretsFacts> = {
  id: "secrets.chip",
  render: (f) =>
    f.classes["likely-real"] === 1
      ? "likely-real credential in transcripts"
      : "likely-real credentials in transcripts",
};

/** The secrets card. */
export const secretsCard: ToCard<"secrets"> = (result): CardView => {
  const facts = result.facts;
  const likely = facts.classes["likely-real"];
  const headline = sentence(SECRETS_HEADLINE, facts);
  const chip = sentence(SECRETS_CHIP, facts);
  const countLine = sentence(SECRETS_COUNT, result);
  return {
    category: "secrets",
    tone: result.status,
    count: result.matches,
    ...(countLine === undefined ? {} : { countLine }),
    found: sentences(SECRETS_FOUND, facts),
    now: sentences(SECRETS_NOW, facts),
    fixSteps: sentences(SECRETS_FIX, facts),
    fixes: [],
    codexCaveat: false,
    ...(headline === undefined
      ? {}
      : {
          headline: {
            basis: "likely-real-credentials",
            count: likely,
            restsOnCodexRan: false,
            sentence: headline,
          },
        }),
    ...(chip === undefined ? {} : { chip: { count: likely, label: chip } }),
  };
};
