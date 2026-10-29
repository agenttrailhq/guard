/**
 * The secrets card's sentences, one fact at a time: singular and plural, each class, the
 * set-aside counts, and the states of the committed-fixture search. Every line is made from the
 * card's typed facts, which hold counts and fixed enums only.
 */

import { describe, expect, it } from "vitest";
import { sentences } from "../core/verify/cards.js";
import {
  SECRETS_CHIP,
  SECRETS_FIX,
  SECRETS_FOUND,
  SECRETS_HEADLINE,
  SECRETS_NOW,
  SECRETS_READ,
  secretsCard,
} from "../core/verify/secrets-card.js";
import type { SecretsFacts } from "../core/verify/types.js";

/** Facts with nothing found in `filesRead` files, changed by `over`. */
function facts(over: Partial<SecretsFacts> = {}, classes: Partial<SecretsFacts["classes"]> = {}) {
  return {
    classes: {
      "likely-real": 0,
      "committed-fixture": 0,
      placeholder: 0,
      "local-dev": 0,
      ...classes,
    },
    items: [],
    moreItems: 0,
    filesRead: 3,
    filesNotRead: 0,
    unplaced: 0,
    setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
    fixtureCheck: "complete",
    reposChecked: 1,
    reposNotChecked: 0,
    ...over,
  } satisfies SecretsFacts as SecretsFacts;
}

const found = (f: SecretsFacts): string[] => sentences(SECRETS_FOUND, f).map((s) => s.text);
const now = (f: SecretsFacts): string[] => sentences(SECRETS_NOW, f).map((s) => s.text);
const fix = (f: SecretsFacts): string[] => sentences(SECRETS_FIX, f).map((s) => s.text);

describe("what checking found", () => {
  it("one likely-real credential, in one file", () => {
    expect(found(facts({ filesRead: 1 }, { "likely-real": 1 }))[0]).toBe(
      "Found 1 likely-real credential in the one transcript file it read.",
    );
  });

  it("several, in several files", () => {
    expect(found(facts({}, { "likely-real": 2 }))[0]).toBe(
      "Found 2 likely-real credentials in the 3 transcript files it read.",
    );
  });

  it("nothing credential-shaped at all", () => {
    expect(found(facts())).toEqual([
      "Found no credential-shaped value in the 3 transcript files it read.",
      "Each value was classed by its format and by where else it appears. None was checked with the service that issued it.",
    ]);
  });

  it("committed fixtures, singular and plural, said for what they are", () => {
    expect(found(facts({}, { "committed-fixture": 1 }))).toContain(
      "1 value is also in a git-tracked file, a committed fixture: it may be test data, or a real secret that was committed.",
    );
    expect(found(facts({}, { "committed-fixture": 2 }))).toContain(
      "2 values are also in git-tracked files, committed fixtures: each may be test data, or a real secret that was committed.",
    );
  });

  it("placeholders and local dev values are not counted, and say why", () => {
    expect(found(facts({}, { placeholder: 1, "local-dev": 1 }))).toContain(
      "Not counted as likely real: 1 placeholder or false positive, and 1 local dev value for a database or service on this machine.",
    );
    expect(found(facts({}, { placeholder: 2 }))).toContain(
      "Not counted as likely real: 2 placeholders or false positives.",
    );
    expect(found(facts({}, { placeholder: 2 }))[0]).toBe(
      "Found no likely-real credential in the 3 transcript files it read.",
    );
  });

  it("set-aside values are a part of the placeholders, said with both reasons, never twice", () => {
    const lines = found(
      facts(
        { setAside: { unnamedOutputOnly: 2, namedNotCredentialShaped: 1 } },
        { placeholder: 5 },
      ),
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "Found no likely-real credential in the 3 transcript files it read.",
        "Not counted as likely real: 5 placeholders or false positives.",
        "Of the placeholders or false positives, 3 were set aside by a rule that can miss a real credential: 2 unnamed and seen only in output or replies, and 1 named but not shaped like a credential.",
      ]),
    );
    // A part of the 5, so no line adds them to it.
    expect(lines.join(" ")).not.toMatch(/\b8\b|more credential-like/);
  });

  it("names only the reason that applies, in the singular for one", () => {
    expect(
      found(
        facts(
          { setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 1 } },
          { placeholder: 1 },
        ),
      ),
    ).toContain(
      "Of the placeholders or false positives, 1 was set aside by a rule that can miss a real credential: 1 named but not shaped like a credential.",
    );
    expect(
      found(
        facts(
          { setAside: { unnamedOutputOnly: 1, namedNotCredentialShaped: 0 } },
          { placeholder: 1 },
        ),
      ).join(" "),
    ).not.toContain("named but not shaped");
  });

  it("says nothing of it when nothing was set aside", () => {
    expect(found(facts({}, { placeholder: 2 })).join(" ")).not.toContain("set aside");
  });

  it("says when the fixture search was partial or could not run", () => {
    expect(
      found(facts({ fixtureCheck: "partial", reposNotChecked: 1 }, { "likely-real": 2 })),
    ).toContain(
      "1 repo could not be searched for committed fixtures, so some of these may be fixtures.",
    );
    expect(found(facts({ fixtureCheck: "unavailable" }, { "likely-real": 2 }))).toContain(
      "No repo could be searched for committed fixtures, so a fixture would be counted here as likely real.",
    );
    // With nothing likely real, the search's limits change no count, so they go unsaid.
    expect(found(facts({ fixtureCheck: "unavailable" })).join(" ")).not.toContain("fixture");
  });

  it("says what could not be read or classed", () => {
    expect(found(facts({ filesNotRead: 1, unplaced: 1 }))).toEqual(
      expect.arrayContaining([
        "1 transcript file could not be read.",
        "1 redacted text could not be lined up with the original, so it was not classed.",
      ]),
    );
    expect(found(facts({ unplaced: 2 }))).toContain(
      "2 redacted texts could not be lined up with the original, so they were not classed.",
    );
  });
});

describe("what it read", () => {
  it("transcript files, and only the repos it could search", () => {
    expect(SECRETS_READ.render(facts({ reposChecked: 0, reposNotChecked: 0 }))).toBe(
      "Read 3 transcript files again.",
    );
    expect(SECRETS_READ.render(facts({ filesRead: 1, reposChecked: 2 }))).toBe(
      "Read 1 transcript file again and searched the git-tracked files of 2 repos the sessions ran in, with read-only git.",
    );
    expect(SECRETS_READ.render(facts({ reposChecked: 0, reposNotChecked: 1 }))).toBe(
      "Read 3 transcript files again; 1 repo the sessions named could not be searched.",
    );
    expect(SECRETS_READ.render(facts({ filesRead: 0 }))).toBeUndefined();
  });
});

describe("now, and the fix", () => {
  it("one, or several, still in the transcripts, to rotate first", () => {
    expect(now(facts({}, { "likely-real": 1 }))[0]).toMatch(/^It is still in the transcript files/);
    expect(now(facts({}, { "likely-real": 3 }))[0]).toMatch(
      /^All 3 are still in the transcript files/,
    );
    expect(fix(facts({}, { "likely-real": 1 }))[0]).toMatch(/^Rotate it first/);
    expect(fix(facts({}, { "likely-real": 3 }))[0]).toMatch(/^Rotate each one first/);
  });

  it("a committed fixture alone: a caveat under Now that it may be real, and no Fix", () => {
    // Nothing likely real reads clean, and a clean card gives no Fix; a committed fixture may
    // still be a real secret, so the card says so, never that it is safe.
    expect(now(facts({}, { "committed-fixture": 1 }))).toEqual([
      "The committed fixture is in a git-tracked file today, and so in the repo's history.",
      "If a committed fixture is a real secret, it stays in the repo's history even after the file is removed, so rotate it with the service that issued it.",
    ]);
    expect(now(facts({}, { "committed-fixture": 2 }))[0]).toMatch(/^The 2 committed fixtures are/);
    expect(fix(facts({}, { "committed-fixture": 1 }))).toEqual([]);
  });

  it("a committed fixture beside a likely-real credential: rotated if real, under Fix", () => {
    const both = facts({}, { "likely-real": 1, "committed-fixture": 1 });
    expect(fix(both)).toEqual([
      "Rotate it first, with the service that issued it, so the copy in the transcripts no longer works.",
      "If a committed fixture is a real secret, rotate it as well: removing the file does not remove it from the repo's history.",
    ]);
    expect(now(both).join(" ")).not.toContain("stays in the repo's history even after");
  });

  it("nothing to rotate when nothing is likely real or committed", () => {
    expect(now(facts({}, { placeholder: 4 }))).toEqual([
      "There is no likely-real credential to rotate.",
    ]);
    expect(fix(facts({}, { placeholder: 4 }))).toEqual([]);
  });
});

describe("the card", () => {
  it("takes its tone and count from the check, and offers the likely-real count to lead", () => {
    const card = secretsCard(
      { status: "act", matches: 9, facts: facts({}, { "likely-real": 2 }) },
      { ranEvidence: "output-record" },
    );
    expect(card.tone).toBe("act");
    expect(card.count).toBe(9);
    expect(card.fixes).toEqual([]);
    // Found in text, so its claim does not rest on Codex ran records; a Codex scan still never
    // leads with it, since nothing leads a Codex scan.
    expect(card.codexCaveat).toBe(false);
    expect(card.headline).toEqual({
      basis: "likely-real-credentials",
      count: 2,
      restsOnCodexRan: false,
      sentence: {
        template: SECRETS_HEADLINE.id,
        text: "2 likely-real credentials are still in the agent's transcripts",
      },
    });
    expect(card.chip).toEqual({
      count: 2,
      label: { template: SECRETS_CHIP.id, text: "likely-real credentials in transcripts" },
    });
  });

  it("offers no headline with nothing likely real, and a singular chip for one", () => {
    const none = secretsCard(
      { status: "clean", matches: 1, facts: facts({}, { placeholder: 1 }) },
      { ranEvidence: "tool-result" },
    );
    expect(none.headline).toBeUndefined();
    expect(none.chip?.count).toBe(0);
    const one = secretsCard(
      { status: "act", matches: 1, facts: facts({}, { "likely-real": 1 }) },
      { ranEvidence: "tool-result" },
    );
    expect(one.chip?.label.text).toBe("likely-real credential in transcripts");
  });
});
