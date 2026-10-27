/**
 * The verified note on each guardrail in All findings (`core/verify/notes.ts`).
 *
 * - The table: every mapped id is a shipped guardrail, and the map is the one the checks cover.
 * - One test per note kind, on synthetic facts with each check's own field names.
 * - What a note may claim: a check not checked gives no note; one that could not finish, or
 *   whose commands that ran hold a form that can hide others, gives "Could not confirm", never
 *   a reassuring note; sessions with no recorded output confirm nothing that rests on output;
 *   Codex counts carry their caveat.
 * - Only counts: a value of any other type ends the note, and a note's only variable parts are
 *   numbers.
 * - Registered keys only: every key a note reads is one a check registers.
 */

import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { cardsFor, UNCONFIRMED_SENTENCE } from "../core/verify/cards.js";
import { CODEX_CAVEAT } from "../core/verify/copy.js";
import {
  NOTE_COULD_HIDE,
  NOTE_COULD_NOT_CHECK,
  NOTE_FACT_KEYS,
  NOTE_KINDS,
  NOTE_NO_OUTPUT,
  NOTE_RULES,
  type NoteKindName,
  verifiedNote,
  verifiedNotes,
} from "../core/verify/notes.js";
import {
  FACT_KEYS,
  FACT_VALUE_ENUMS,
  HIDING_FORMS,
  VERIFY_CATEGORIES,
  type Verification,
  type VerifyCategory,
} from "../core/verify/types.js";
import {
  CLOUD_FACTS,
  checked,
  DEPENDENCY_FACTS,
  DESTRUCTIVE_FACTS,
  EGRESS_FACTS,
  FACTS,
  LOST_WORK_FACTS,
  library,
  notesVerification,
  PROD_INFRA_FACTS,
  SKIPPED_FACTS,
  TESTS_FACTS,
  TONE_BUILDERS,
  UNREVIEWED_FACTS,
} from "./notes-corpus.js";
import { SECRETS_ACT, SECRETS_CLEAN } from "./verified-corpus.js";

/** The note text for `ruleId` over `verification`, or `undefined`. */
function noteText(ruleId: string, verification: Verification = notesVerification()) {
  const cards = cardsFor(verification, TONE_BUILDERS);
  return verifiedNote(library(ruleId), verification, cards)?.sentence;
}

/** One rule of each kind, for the per-kind tests. */
function ruleOf(kind: NoteKindName): string {
  const id = Object.keys(NOTE_RULES).find((rule) => NOTE_RULES[rule]?.kind === kind);
  if (id === undefined) throw new Error(`no rule for ${kind}`);
  return id;
}

/** The category a kind's rules come from. */
function categoryOf(kind: NoteKindName): VerifyCategory | "dependencies" {
  return (NOTE_RULES[ruleOf(kind)] as { readonly category: VerifyCategory | "dependencies" })
    .category;
}

/** A verification whose `kind`'s facts are `facts`. */
function withFacts(kind: NoteKindName, facts: object, status: "act" | "clean" = "act") {
  const category = categoryOf(kind);
  return category === "dependencies"
    ? notesVerification({}, {}, facts)
    : notesVerification({ [category]: checked(status, facts) });
}

const CODEX_TEXT = CODEX_CAVEAT.render({ codexCaveat: true });

// ── The table ─────────────────────────────────────────────────────────────────

describe("the rule table", () => {
  const shipped = new Set(SHIPPED_CATALOG.map((rule) => rule.id));

  it("maps only shipped guardrails", () => {
    const unknown = Object.keys(NOTE_RULES).filter((id) => !shipped.has(id));
    expect(unknown).toEqual([]);
  });

  it("names a known check and a known kind for every rule", () => {
    for (const [id, rule] of Object.entries(NOTE_RULES)) {
      expect([...VERIFY_CATEGORIES, "dependencies"], id).toContain(rule.category);
      expect(Object.keys(NOTE_KINDS), id).toContain(rule.kind);
    }
  });

  it("every kind has a rule, and a kind's rules share one check", () => {
    for (const kind of Object.keys(NOTE_KINDS) as NoteKindName[]) {
      const categories = new Set(
        Object.values(NOTE_RULES)
          .filter((rule) => rule.kind === kind)
          .map((rule) => rule.category),
      );
      expect(categories.size, kind).toBe(1);
    }
  });

  it("puts the git-backed checks' guardrails where those checks look", () => {
    const of = (ids: readonly string[]) => ids.map((id) => NOTE_RULES[id]?.category);
    expect(of(["gb.git-no-verify", "gb.hooks-disable"])).toEqual([
      "skipped-checks",
      "skipped-checks",
    ]);
    expect(
      of([
        "wt.branch-force-delete",
        "wt.stash-drop",
        "wt.checkout-discard",
        "wt.restore-path",
        "wt.reset-hard",
      ]),
    ).toEqual(Array(5).fill("lost-work"));
    expect(
      of([
        "require-approval-rm-rf",
        "dd.rm-rf-absolute",
        "dd.database-drop",
        "block-destructive-sql",
      ]),
    ).toEqual(Array(4).fill("destructive"));
  });

  it("puts the command checks' guardrails where those checks look", () => {
    const of = (ids: readonly string[]) => ids.map((id) => NOTE_RULES[id]?.category);
    // The rules the cloud and egress checks read by id.
    expect(of(["ps.iam-grant", "pi.terraform-auto-approve", "pi.terraform-state-mutate"])).toEqual(
      Array(3).fill("cloud"),
    );
    expect(
      of(["ex.file-upload", "se.secret-egress", "ex.paste-service", "ex.reverse-shell"]),
    ).toEqual(Array(4).fill("egress"));
    expect(NOTE_RULES["ex.tunnel-expose"]).toEqual({ category: "egress", kind: "tunnels" });
    // The production check reads every guardrail of the prod-infra pack; the two Terraform
    // ones get the cloud check's more specific note.
    const prodPack = SHIPPED_CATALOG.filter((rule) => rule.category === "prod-infra").map(
      (rule) => rule.id,
    );
    for (const id of prodPack) {
      expect(["prod-infra", "cloud"], id).toContain(NOTE_RULES[id]?.category);
    }
    expect(of(["ti.test-file-delete", "ti.test-config-edit", "ti.coverage-bypass"])).toEqual(
      Array(3).fill("tests"),
    );
    expect(NOTE_RULES["block-force-push"]?.category).toBe("unreviewed");
    expect(of(["flag-dependency-install", "rce.unverified-package"])).toEqual(
      Array(2).fill("dependencies"),
    );
  });
});

// ── One test per kind ────────────────────────────────────────────────────────

describe("each mapped rule gets its kind's note", () => {
  it.each(Object.entries(NOTE_RULES))("%s", (id, rule) => {
    const note = noteText(id);
    expect(note?.template).toBe(NOTE_KINDS[rule.kind].template.id);
  });
});

describe("a rule the table leaves out gets no note", () => {
  it.each([
    "wt.clean-fdx",
    "gb.admin-merge",
    "ps.persistence",
    "t.rm-rf",
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
  ])("%s", (id) => {
    expect(noteText(id)).toBeUndefined();
  });

  it("a guardrail the user wrote gets none, even with a shipped id", () => {
    const verification = notesVerification();
    const cards = cardsFor(verification, TONE_BUILDERS);
    expect(
      verifiedNote({ ruleId: "dd.rm-rf-absolute", source: "yours" }, verification, cards),
    ).toBeUndefined();
    expect(noteText("dd.rm-rf-absolute")).toBeDefined();
  });
});

/** Each kind's note on the full corpus, and on facts that change what it says. */
const KIND_CASES: readonly [NoteKindName, string, object, string][] = [
  [
    "no-verify",
    "commits on main",
    SKIPPED_FACTS,
    "4 commits skipped the hooks of a repo that has them; 3 are on main now.",
  ],
  [
    "no-verify",
    "no hooks to skip",
    {
      ...SKIPPED_FACTS,
      noVerify: { ...SKIPPED_FACTS.noVerify, withoutHooks: 2, onMain: 0, offMain: 0 },
    },
    "False positive: all 2 commits that skipped hooks were in repos with no commit hook, so no check was skipped.",
  ],
  [
    "no-verify",
    "not looked up",
    {
      ...SKIPPED_FACTS,
      noVerify: {
        ...SKIPPED_FACTS.noVerify,
        withoutHooks: 2,
        onMain: 0,
        offMain: 0,
        notIdentified: 1,
      },
    },
    "1 commit could not be looked up.",
  ],
  [
    "hooks-off",
    "back on",
    SKIPPED_FACTS,
    "Hooks are on now in every repo where they were switched. 1 command turned Husky off for that command only.",
  ],
  [
    "hooks-off",
    "off now",
    {
      ...SKIPPED_FACTS,
      hooksPath: { ...SKIPPED_FACTS.hooksPath, off: 2 },
      husky: { ran: 0, mentioned: 0, unknown: 0 },
    },
    "Hooks are switched off now in 2 repos.",
  ],
  [
    "branches",
    "recoverable",
    LOST_WORK_FACTS,
    "2 deleted branches can still be recovered by commit id.",
  ],
  [
    "branches",
    "nothing lost",
    {
      ...LOST_WORK_FACTS,
      branches: { ...LOST_WORK_FACTS.branches, recoverable: 0, onAnotherRef: 2 },
    },
    "Nothing lost: every deleted branch's commits are still on another branch or tag.",
  ],
  [
    "stashes",
    "recoverable",
    LOST_WORK_FACTS,
    "1 dropped stash can still be recovered by commit id.",
  ],
  [
    "stashes",
    "cleared",
    { ...LOST_WORK_FACTS, stashes: { ...LOST_WORK_FACTS.stashes, recoverable: 0, cleared: 1 } },
    "1 stash clear ran; what it removed is not checked.",
  ],
  [
    "discards",
    "own copy",
    LOST_WORK_FACTS,
    "All 4 discarded paths were in the agent's own worktree or a scratch copy.",
  ],
  [
    "discards",
    "mixed",
    {
      ...LOST_WORK_FACTS,
      discards: { ...LOST_WORK_FACTS.discards, ownCopy: 1, agentEdited: 2, mainCheckout: 1 },
    },
    "Of 4 discarded paths: 1 in the agent's own copy, 2 the agent had edited, 1 in the main checkout with no agent edit on record.",
  ],
  [
    "rm-targets",
    "mostly scratch",
    DESTRUCTIVE_FACTS,
    "Mostly scratch, temp or build folders. No tracked file is missing. 1 target held untracked files in a repo.",
  ],
  [
    "rm-targets",
    "all scratch",
    {
      ...DESTRUCTIVE_FACTS,
      rm: {
        ...DESTRUCTIVE_FACTS.rm,
        classes: { ...DESTRUCTIVE_FACTS.rm.classes, scratch: 7, tracked: 0, untracked: 0 },
        trackedBack: 0,
      },
    },
    "All scratch, temp or build folders. No tracked file is missing.",
  ],
  [
    "rm-targets",
    "tracked missing, unguarded",
    {
      ...DESTRUCTIVE_FACTS,
      rm: {
        ...DESTRUCTIVE_FACTS.rm,
        classes: {
          ...DESTRUCTIVE_FACTS.rm.classes,
          scratch: 2,
          tracked: 2,
          untracked: 0,
          home: 1,
          "unguarded-variable": 2,
        },
        trackedBack: 0,
        trackedGone: 1,
        trackedPartlyBack: 1,
      },
    },
    "2 of 7 targets were scratch, temp or build folders. 2 tracked targets still have files missing. 1 target was under the home folder, outside a repo. 2 targets came from a variable with no guard.",
  ],
  [
    "databases",
    "local only",
    DESTRUCTIVE_FACTS,
    "Only local or scratch databases: 2 local, 0 scratch.",
  ],
  [
    "databases",
    "other",
    {
      ...DESTRUCTIVE_FACTS,
      databases: {
        ...DESTRUCTIVE_FACTS.databases,
        classes: { local: 1, scratch: 0, other: 1, unresolved: 0 },
      },
    },
    "1 database aimed at was neither local nor scratch.",
  ],
  ["secrets-printed", "printed", SECRETS_ACT, "Likely-real credentials printed by a command: 1."],
  ["secrets-typed", "typed", SECRETS_ACT, "Likely-real credentials typed into a command: 1."],
  [
    "secrets-printed",
    "listed in part",
    { ...SECRETS_ACT, moreItems: 4 },
    "Likely-real credentials printed by a command: at least 1.",
  ],
  [
    "secrets-printed",
    "none printed",
    {
      ...SECRETS_ACT,
      items: SECRETS_ACT.items.filter((item) => !item.via.includes("printed-by-command")),
      setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
    },
    "None of the likely-real credentials found were printed by a command.",
  ],
  [
    "secrets-printed",
    "none at all",
    { ...SECRETS_CLEAN, setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 } },
    "No likely-real credential was found in the transcripts.",
  ],
  [
    "iam",
    "ran",
    CLOUD_FACTS,
    "2 IAM changes ran. They cannot be checked from this machine, so review them by hand.",
  ],
  [
    "terraform",
    "ran",
    CLOUD_FACTS,
    "1 Terraform command that changes infrastructure or state ran, 1 with auto-approve. It cannot be checked from this machine, so review it by hand.",
  ],
  [
    "infra",
    "ran",
    PROD_INFRA_FACTS,
    "1 production infrastructure command or edit ran. It cannot be checked from this machine, so review it by hand.",
  ],
  [
    "tests-deleted",
    "after failing",
    TESTS_FACTS,
    "1 test file deleted, 1 after a test run reported it failing.",
  ],
  [
    "tests-deleted",
    "not known",
    { ...TESTS_FACTS, testFilesDeleted: 3, deletedAfterFailing: 0, deletedFailureUnknown: 2 },
    "3 test files deleted, 0 after a test run reported them failing. For 2, whether they failed first is not known.",
  ],
  [
    "tests-config",
    "raises undone",
    TESTS_FACTS,
    "No coverage floor went down: the 2 threshold drops undid an automatic raise.",
  ],
  [
    "tests-config",
    "lowered",
    { ...TESTS_FACTS, thresholdsLowered: 1, excludesAdded: 2, configsRewritten: 1 },
    "1 coverage threshold lowered. 2 excludes added to a test or coverage list. 1 test config rewritten whole, so whether a threshold went down cannot be told.",
  ],
  [
    "tests-pass",
    "pass with no tests",
    { ...TESTS_FACTS, ciStepsForcedTrue: 2 },
    "1 test run or config allowed passing with no tests. 2 CI steps were made to pass whatever they return.",
  ],
  [
    "pushes",
    "on main",
    UNREVIEWED_FACTS,
    "1 push went straight to main or master, carrying 2 commits still on it.",
  ],
  [
    "uploads",
    "false positive",
    EGRESS_FACTS,
    "False positive: the 3 upload-shaped calls that ran went to this machine or LocalStack.",
  ],
  [
    "uploads",
    "real uploads",
    { ...EGRESS_FACTS, uploads: 2 },
    "2 uploads to a host off this machine ran.",
  ],
  ["tunnels", "none seen", EGRESS_FACTS, "No known tunnel or relay program was seen running now."],
  [
    "tunnels",
    "started and running",
    { ...EGRESS_FACTS, tunnelsStarted: 1, tunnelsRunning: 1 },
    "1 tunnel was started to expose this machine. 1 tunnel program is running now.",
  ],
  [
    "tunnels",
    "process list unread",
    { ...EGRESS_FACTS, processCheck: "could-not-check" },
    "Whether one is running now could not be checked.",
  ],
  [
    "installs",
    "installs",
    DEPENDENCY_FACTS,
    "2 package installs ran, not counting 3 lockfile restores. Package age is not checked: the scan runs offline.",
  ],
  [
    "installs",
    "restores only",
    { ...DEPENDENCY_FACTS, installs: 0 },
    "False positive: the 3 installs that ran only restored a lockfile.",
  ],
];

describe("each kind's template, on the facts its check reports", () => {
  it.each(KIND_CASES)("%s: %s", (kind, _case, facts, expected) => {
    const note = noteText(ruleOf(kind), withFacts(kind, facts));
    expect(note).toEqual({ template: NOTE_KINDS[kind].template.id, text: expected });
  });

  it("every kind has a case", () => {
    expect(new Set(KIND_CASES.map(([kind]) => kind))).toEqual(new Set(Object.keys(NOTE_KINDS)));
  });
});

// ── What a note may claim ─────────────────────────────────────────────────────

/** The categories behind the kinds, with a rule of each. */
const CATEGORY_RULES: readonly [VerifyCategory, string][] = VERIFY_CATEGORIES.map((category) => {
  const id = Object.keys(NOTE_RULES).find((rule) => NOTE_RULES[rule]?.category === category);
  if (id === undefined) throw new Error(`no rule for ${category}`);
  return [category, id];
});

/** Words a reassuring note uses. A note that could not confirm must use none of them. */
const REASSURING =
  /false positive|nothing lost|no tracked file|only local|no coverage floor|no known tunnel|every repo|no likely-real|none of the/i;

describe("a check that is not checked gives no note", () => {
  it.each(CATEGORY_RULES)("%s", (category, id) => {
    expect(noteText(id, notesVerification({ [category]: { status: "not-checked" } }))).toBe(
      undefined,
    );
  });

  it("the dependency check, absent, gives none", () => {
    expect(noteText("flag-dependency-install", notesVerification({}, {}, null))).toBeUndefined();
  });

  it("a category with no card gives none", () => {
    const verification = notesVerification();
    expect(verifiedNote(library("dd.rm-rf-absolute"), verification, [])).toBeUndefined();
  });
});

describe("a check that could not finish says it could not confirm", () => {
  const could = NOTE_COULD_NOT_CHECK.render(undefined);

  it.each(CATEGORY_RULES)("%s, with no facts", (category, id) => {
    const note = noteText(
      id,
      notesVerification({ [category]: { status: "could-not-check", matches: 2 } }),
    );
    expect(note).toEqual({ template: NOTE_COULD_NOT_CHECK.id, text: could });
    expect(note?.text).toMatch(/^Could not confirm/);
  });

  it.each(CATEGORY_RULES)("%s, even when its facts would reassure", (category, id) => {
    const note = noteText(
      id,
      notesVerification({ [category]: checked("could-not-check", FACTS[category]) }),
    );
    expect(note?.text).toBe(could);
    expect(note?.text).not.toMatch(REASSURING);
  });
});

describe("a check whose commands could hide others never reassures", () => {
  it.each(HIDING_FORMS)("form %s, on every kind", (form) => {
    for (const kind of Object.keys(NOTE_KINDS) as NoteKindName[]) {
      const category = categoryOf(kind);
      const base = category === "dependencies" ? DEPENDENCY_FACTS : (FACTS[category] as object);
      const facts = { ...base, hidingForms: [form] };
      const note = noteText(ruleOf(kind), withFacts(kind, facts, "clean"));
      expect(note?.template, kind).toBe(UNCONFIRMED_SENTENCE.id);
      expect(note?.text, kind).toMatch(/^Could not confirm/);
      expect(note?.text, kind).not.toMatch(REASSURING);
    }
  });

  it("names every form the facts hold, in their order", () => {
    const note = noteText(
      "dd.rm-rf-absolute",
      notesVerification({
        destructive: checked("clean", { ...DESTRUCTIVE_FACTS, hidingForms: ["xargs", "eval"] }),
      }),
    );
    expect(note?.text).toBe(
      UNCONFIRMED_SENTENCE.render({ reason: "hiding-forms", forms: ["xargs", "eval"] }),
    );
  });

  it("a count of hiding calls with no form named still could not confirm", () => {
    for (const [category, extra] of [
      ["destructive", { hidingCalls: 2 }],
      ["egress", { couldHide: 1 }],
    ] as const) {
      const id = category === "destructive" ? "dd.rm-rf-absolute" : "ex.file-upload";
      const note = noteText(
        id,
        notesVerification({ [category]: checked("clean", { ...FACTS[category], ...extra }) }),
      );
      expect(note).toEqual({
        template: NOTE_COULD_HIDE.id,
        text: NOTE_COULD_HIDE.render(undefined),
      });
    }
    const deps = noteText(
      "flag-dependency-install",
      notesVerification({}, {}, { ...DEPENDENCY_FACTS, couldHide: 1 }),
    );
    expect(deps?.template).toBe(NOTE_COULD_HIDE.id);
  });

  it("an act card that keeps its tone still could not confirm", () => {
    const note = noteText(
      "wt.stash-drop",
      notesVerification({
        "lost-work": checked("act", { ...LOST_WORK_FACTS, hidingForms: ["eval"] }),
      }),
    );
    expect(note?.template).toBe(UNCONFIRMED_SENTENCE.id);
  });
});

describe("no note says a guardrail's commands did not run", () => {
  it("over every kind and every case", () => {
    const texts = [
      ...KIND_CASES.map(([kind, , facts]) => noteText(ruleOf(kind), withFacts(kind, facts))?.text),
      ...Object.keys(NOTE_RULES).map((id) => noteText(id)?.text),
    ];
    for (const text of texts) {
      expect(text).toBeDefined();
      expect(text).not.toMatch(/did not run|didn't run|never ran|not run\b|no \w+ ran|none ran/i);
    }
  });
});

describe("sessions that record no command output confirm nothing that rests on it", () => {
  const cursor = { resultsRecorded: false, ranEvidence: "none" } as const;
  const noOutput = { template: NOTE_NO_OUTPUT.id, text: NOTE_NO_OUTPUT.render(undefined) };
  const restsOnOutput = (kind: NoteKindName): boolean =>
    NOTE_KINDS[kind].ran || NOTE_KINDS[kind].output === true;

  it.each(Object.entries(NOTE_RULES).filter(([, rule]) => restsOnOutput(rule.kind)))("%s", (id) => {
    expect(noteText(id, notesVerification({}, cursor))).toEqual(noOutput);
  });

  it("the printed-by-command note never reassures from sessions with no output", () => {
    // Cursor sessions never record what a command printed, so "none was printed" and "none
    // was found" are not known there, whatever the credentials pasted or typed.
    const nonePrinted = {
      ...SECRETS_ACT,
      items: SECRETS_ACT.items.filter((item) => !item.via.includes("printed-by-command")),
      setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
    };
    const noneAtAll = {
      ...SECRETS_CLEAN,
      setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
    };
    for (const [status, facts] of [
      ["act", nonePrinted],
      ["clean", noneAtAll],
    ] as const) {
      // The same facts reassure from sessions that record output.
      const recorded = noteText(
        "se.env-print",
        notesVerification({ secrets: checked(status, facts) }),
      );
      expect(recorded?.text).toMatch(REASSURING);
      const note = noteText(
        "se.env-print",
        notesVerification({ secrets: checked(status, facts) }, cursor),
      );
      expect(note).toEqual(noOutput);
      expect(note?.text).toMatch(/^Could not confirm/);
    }
  });

  it("a note on what was typed into a command still stands: those sessions record the command", () => {
    expect(noteText("block-hardcoded-secrets", notesVerification({}, cursor))?.text).toBe(
      "Likely-real credentials typed into a command: 1.",
    );
  });
});

describe("Codex counts carry their caveat", () => {
  const codex = notesVerification({}, { ranEvidence: "output-record" });

  it.each(
    Object.entries(NOTE_RULES).filter(([, rule]) => NOTE_KINDS[rule.kind].ran),
  )("%s", (id) => {
    const plain = noteText(id);
    const note = noteText(id, codex);
    expect(note?.template).toBe(plain?.template);
    expect(note?.text).toBe(`${plain?.text} ${CODEX_TEXT}`);
  });

  it("a note on what the transcripts hold does not", () => {
    expect(noteText("se.env-print", codex)?.text).toBe(noteText("se.env-print")?.text);
  });

  it("a Codex note that could not confirm says so, without a count to caveat", () => {
    const note = noteText(
      "dd.rm-rf-absolute",
      notesVerification(
        { destructive: checked("clean", { ...DESTRUCTIVE_FACTS, hidingForms: ["eval"] }) },
        { ranEvidence: "output-record" },
      ),
    );
    expect(note?.template).toBe(UNCONFIRMED_SENTENCE.id);
  });
});

describe("a reassuring note needs every part of its check settled", () => {
  it.each([
    [
      "rm-targets",
      "a target not checked",
      { ...DESTRUCTIVE_FACTS, rm: { ...DESTRUCTIVE_FACTS.rm, couldNotCheck: 1 } },
    ],
    [
      "rm-targets",
      "a call not confirmed",
      {
        ...DESTRUCTIVE_FACTS,
        rm: { ...DESTRUCTIVE_FACTS.rm, calls: { ran: 7, mentioned: 0, unknown: 1 } },
      },
    ],
    ["uploads", "a match not confirmed", { ...EGRESS_FACTS, unconfirmed: 1 }],
    ["installs", "a match not confirmed", { ...DEPENDENCY_FACTS, installs: 0, unconfirmed: 1 }],
    ["tests-config", "a config rewritten", { ...TESTS_FACTS, configsRewritten: 1 }],
    [
      "secrets-printed",
      "values set aside",
      {
        ...SECRETS_ACT,
        items: [],
        setAside: { unnamedOutputOnly: 1, namedNotCredentialShaped: 0 },
      },
    ],
    [
      "secrets-printed",
      "a file not read",
      {
        ...SECRETS_CLEAN,
        filesNotRead: 1,
        setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
      },
    ],
    [
      "secrets-printed",
      "nothing read",
      {
        ...SECRETS_CLEAN,
        filesRead: 0,
        setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
      },
    ],
    [
      "branches",
      "a deletion not looked up",
      {
        ...LOST_WORK_FACTS,
        branches: {
          ...LOST_WORK_FACTS.branches,
          recoverable: 0,
          onAnotherRef: 2,
          couldNotCheck: 1,
        },
      },
    ],
    [
      "no-verify",
      "a commit not identified",
      {
        ...SKIPPED_FACTS,
        noVerify: {
          ...SKIPPED_FACTS.noVerify,
          withoutHooks: 4,
          onMain: 0,
          offMain: 0,
          notIdentified: 1,
        },
      },
    ],
    [
      "databases",
      "a database not placed",
      {
        ...DESTRUCTIVE_FACTS,
        databases: {
          ...DESTRUCTIVE_FACTS.databases,
          classes: { local: 2, scratch: 0, other: 0, unresolved: 1 },
        },
      },
    ],
    [
      "hooks-off",
      "a repo not checked",
      { ...SKIPPED_FACTS, hooksPath: { ...SKIPPED_FACTS.hooksPath, couldNotCheck: 1 } },
    ],
  ] as const)("%s: %s", (kind, _case, facts) => {
    const text = noteText(ruleOf(kind), withFacts(kind, facts))?.text ?? "";
    expect(text).not.toMatch(REASSURING);
  });
});

// ── Only counts ───────────────────────────────────────────────────────────────

const CANARY = `CANARY${"note"}/Users/sample/secret-project@example.com`;

describe("a note reads only counts", () => {
  it("a string where a count belongs ends the note, and never prints", () => {
    const facts = {
      ...DESTRUCTIVE_FACTS,
      rm: { ...DESTRUCTIVE_FACTS.rm, targets: CANARY },
    };
    expect(noteText("dd.rm-rf-absolute", withFacts("rm-targets", facts))).toBeUndefined();
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["a list", [1]],
    ["an object", { n: 1 }],
    ["null", null],
  ] as const)("a count that is %s ends the note", (_label, bad) => {
    for (const kind of Object.keys(NOTE_KINDS) as NoteKindName[]) {
      const category = categoryOf(kind);
      if (category === "dependencies") {
        const note = noteText(
          ruleOf(kind),
          notesVerification({}, {}, { ...DEPENDENCY_FACTS, installs: bad }),
        );
        expect(note, kind).toBeUndefined();
      }
    }
    const facts = { ...EGRESS_FACTS, localOnly: bad };
    expect(noteText("ex.file-upload", withFacts("uploads", facts))).toBeUndefined();
  });

  it("keys a check does not hold, holding values, change nothing and never print", () => {
    const facts = {
      ...EGRESS_FACTS,
      host: CANARY,
      path: CANARY,
      [CANARY]: 7,
      hidingFormsExtra: [CANARY],
    };
    const note = noteText("ex.file-upload", withFacts("uploads", facts));
    expect(note?.text).toBe(
      "False positive: the 3 upload-shaped calls that ran went to this machine or LocalStack.",
    );
    expect(JSON.stringify(note)).not.toContain("CANARY");
  });

  it("an enum read for a yes or no takes only its value, never prints it", () => {
    const facts = { ...EGRESS_FACTS, processCheck: CANARY };
    expect(noteText("ex.tunnel-expose", withFacts("tunnels", facts))?.text).toBe(
      "Whether one is running now could not be checked.",
    );
  });

  it("a list read for a count holds lists, or ends the note", () => {
    const facts = { ...SECRETS_ACT, items: [{ kind: "api-key", via: CANARY, files: 1 }] };
    expect(noteText("se.env-print", withFacts("secrets-printed", facts))).toBeUndefined();
  });

  it("a note's only variable parts are numbers", () => {
    // Every case, with each digit run made one mark: what is left is fixed wording, made of
    // plain words and punctuation, with nothing shaped like a path, a host or a command.
    for (const [kind, , facts] of KIND_CASES) {
      const text = noteText(ruleOf(kind), withFacts(kind, facts))?.text ?? "";
      expect(text.replace(/\d+/g, "#"), kind).toMatch(/^[A-Za-z#,.:;' -]+$/);
    }
  });
});

// ── Registered keys only ──────────────────────────────────────────────────────

/**
 * The fact keys and enum values the git-backed checks and the command checks register, as
 * `git-facts.ts` (`GIT_FACT_KEYS`, `RM_TARGET_CLASSES`, `DATABASE_CLASSES`) and
 * `command-facts.ts` (`COMMAND_FACT_KEYS`, `PROCESS_CHECKS`) export them. Those modules are not
 * in this build: when they are, these come from `FACT_KEYS` and `FACT_VALUE_ENUMS`, and this
 * list goes.
 */
const KEYS_OF_CHECKS_NOT_IN_THIS_BUILD: ReadonlySet<string> = new Set([
  // GIT_FACT_KEYS
  "calls",
  "ran",
  "mentioned",
  "unknown",
  "couldNotCheck",
  "noVerify",
  "commits",
  "notIdentified",
  "withoutHooks",
  "onMain",
  "offMain",
  "noMainToCheck",
  "gone",
  "otherNoVerify",
  "husky",
  "hooksPath",
  "off",
  "on",
  "none",
  "instructions",
  "read",
  "sayToSkip",
  "agentWrote",
  "agentWroteStill",
  "agentWroteRemoved",
  "couldNotRead",
  "branches",
  "deleted",
  "recoverable",
  "onAnotherRef",
  "stashes",
  "dropped",
  "cleared",
  "listed",
  "discards",
  "paths",
  "ownCopy",
  "agentEdited",
  "mainCheckout",
  "rm",
  "targets",
  "trackedBack",
  "trackedGone",
  "trackedPartlyBack",
  "databases",
  "unsafeFixes",
  "hidingCalls",
  // RM_TARGET_CLASSES, DATABASE_CLASSES
  "unguarded-variable",
  "guarded-variable",
  "scratch",
  "tracked",
  "untracked",
  "home",
  "other",
  "local",
  "unresolved",
  // COMMAND_FACT_KEYS
  "thresholdsLowered",
  "autoUpdateReverts",
  "autoUpdateNow",
  "unread",
  "configsRewritten",
  "excludesAdded",
  "passWithNoTests",
  "ciStepsForcedTrue",
  "testFilesDeleted",
  "deletedAfterFailing",
  "deletedFailureUnknown",
  "unconfirmed",
  "couldHide",
  "iamChanges",
  "iamSubjects",
  "autoScalingChanges",
  "s3Changes",
  "terraformChanges",
  "terraformAutoApprove",
  "localStack",
  "databaseTargets",
  "databaseCheck",
  "infraMatches",
  "infraKinds",
  "pushesToMain",
  "commitsOnMain",
  "commitsNotOnMain",
  "pushesNotChecked",
  "uploads",
  "uploadKinds",
  "tunnelsStarted",
  "localOnly",
  "tunnelsRunning",
  "tunnelPrograms",
  "processCheck",
  "dependencies",
  "installs",
  "lockfileRestores",
  "managers",
  "packageAge",
  // PROCESS_CHECKS
  "checked",
  "could-not-check",
]);

/** Every key and enum value the report's boundary lets facts carry in this build. */
const REGISTERED: ReadonlySet<string> = new Set([...FACT_KEYS, ...FACT_VALUE_ENUMS.flat()]);

/** The keys a note reads that neither this build nor the checks not in it register. */
function unregistered(keys: readonly string[]): string[] {
  return keys.filter((key) => !REGISTERED.has(key) && !KEYS_OF_CHECKS_NOT_IN_THIS_BUILD.has(key));
}

describe("a note reads registered keys only", () => {
  it("every key a note reads is registered", () => {
    expect(NOTE_FACT_KEYS.length).toBeGreaterThan(40);
    expect(unregistered(NOTE_FACT_KEYS)).toEqual([]);
  });

  it("the list catches a key that is not registered", () => {
    expect(unregistered([...NOTE_FACT_KEYS, "branchName", "host"])).toEqual(["branchName", "host"]);
  });

  it("every key the full corpus's facts use is registered, so the corpus is a check's", () => {
    const keys = (node: unknown): string[] =>
      Array.isArray(node)
        ? node.flatMap(keys)
        : node !== null && typeof node === "object"
          ? Object.entries(node).flatMap(([k, v]) => [k, ...keys(v)])
          : typeof node === "string"
            ? [node]
            : [];
    const used = [...Object.values(FACTS), DEPENDENCY_FACTS].flatMap(keys);
    // The enums the corpus holds as values that no note reads: still a check's own values.
    const values = new Set(["access-keys", "policies", "kubernetes", "npm", "not-checked-offline"]);
    expect(unregistered(used.filter((k) => !values.has(k)))).toEqual([]);
  });

  it("the secrets notes read only what this build registers, so they reach the page", () => {
    // The strings in a read are its path's keys and the enum values it compares with.
    const strings = (node: unknown): string[] =>
      typeof node === "string"
        ? [node]
        : node !== null && typeof node === "object"
          ? Object.values(node).flatMap(strings)
          : [];
    const secretsKeys = strings([
      NOTE_KINDS["secrets-printed"].reads,
      NOTE_KINDS["secrets-typed"].reads,
    ]);
    expect(secretsKeys).toContain("printed-by-command");
    expect(secretsKeys.filter((key) => !REGISTERED.has(key))).toEqual([]);
  });
});

describe("the notes for a list of findings", () => {
  it("keeps the findings' order, one note per finding that gets one", () => {
    const verification = notesVerification();
    const cards = cardsFor(verification, TONE_BUILDERS);
    const notes = verifiedNotes(
      [
        library("ex.file-upload"),
        library("ps.persistence"),
        { ruleId: "wt.stash-drop", source: "yours" },
        library("dd.rm-rf-absolute"),
      ],
      verification,
      cards,
    );
    expect(notes.map((n) => [n.ruleId, n.category])).toEqual([
      ["ex.file-upload", "egress"],
      ["dd.rm-rf-absolute", "destructive"],
    ]);
  });
});

// ── Golden ────────────────────────────────────────────────────────────────────

describe("the golden notes", () => {
  /** Every mapped rule's note over one verification, one line each. */
  const lines = (label: string, verification: Verification): string[] => [
    `# ${label}`,
    ...Object.keys(NOTE_RULES).map((id) => {
      const note = noteText(id, verification);
      return note === undefined ? `${id}  (no note)` : `${id}  ${note.template}  ${note.text}`;
    }),
  ];

  it("over the full corpus, from each app, and with a form that can hide others", async () => {
    const text = [
      ...lines("Claude Code", notesVerification()),
      ...lines("Codex", notesVerification({}, { ranEvidence: "output-record" })),
      ...lines("Cursor", notesVerification({}, { resultsRecorded: false, ranEvidence: "none" })),
      ...lines(
        "Hiding forms in every check",
        notesVerification(
          Object.fromEntries(
            VERIFY_CATEGORIES.map((category) => [
              category,
              checked("clean", { ...FACTS[category], hidingForms: ["shell-string"] }),
            ]),
          ),
          {},
          { ...DEPENDENCY_FACTS, hidingForms: ["shell-string"] },
        ),
      ),
      "",
    ].join("\n");
    await expect(text).toMatchFileSnapshot("__snapshots__/verified-notes.golden.txt");
  });
});
