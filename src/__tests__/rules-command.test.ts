// cspell:words frobnicate hardd hardx exfiltraton
/**
 * The nine `rules` subcommands, driven through a fake `SetupIO`.
 *
 * The strongest assertions in this file are the negative ones, and they are asserted
 * over the RECORDED WRITE LIST rather than by grepping output. A refusal that printed
 * the right message and wrote the file anyway would pass a string search happily —
 * which matters more here than in most command suites, because the thing being refused
 * is a pattern that silently disables a security rule.
 *
 * `silenceCommand` is exercised by ROUND TRIP rather than by pinning its text alone:
 * the line `status` prints is shell-split and fed back through `runRules`, and the
 * stored pattern must equal the original command. A quoting scheme can be
 * self-consistent and still wrong, and pinning the string would not notice.
 */

import { PACKS } from "@agenttrail/guardrails";
import { describe, expect, it } from "vitest";
import { OWASP_IGNORED_NOTE, runRules } from "../commands/rules.js";
import { silenceCommand } from "../commands/status.js";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { parseConfig } from "../core/config.js";
import { OWASP_IDS, type OwaspId } from "../core/owasp.js";
import { productLineText } from "../core/product-line.js";
import { PATTERN_PLACEHOLDER } from "../core/redaction.js";
import type { ClaudeRunResult, SetupIO } from "../setup-io.js";

const HOME = "/home/test";
const DIR = `${HOME}/.agenttrail/guard`;
const CONFIG = `${DIR}/config.json`;
const RULES = `${DIR}/guardrails.json`;
const OK: ClaudeRunResult = { code: 0, stdout: "", stderr: "" };

interface Harness {
  io: SetupIO;
  out: () => string;
  writes: Array<{ path: string; text: string }>;
  config: () => ReturnType<typeof parseConfig>;
  raw: (path: string) => string | undefined;
}

function harness(files: Record<string, string> = {}): Harness {
  const written: string[] = [];
  const writes: Array<{ path: string; text: string }> = [];
  const store = new Map<string, string>(Object.entries(files));
  const io: SetupIO = {
    writeStdout: (t) => {
      written.push(t);
    },
    readFile: (p) => store.get(p),
    exists: (p) => store.has(p),
    writeFileAtomic: (p, text) => {
      writes.push({ path: p, text });
      store.set(p, text);
    },
    homedir: () => HOME,
    runClaude: () => OK,
  };
  return {
    io,
    out: () => written.join(""),
    writes,
    config: () => parseConfig(store.get(CONFIG)),
    raw: (p) => store.get(p),
  };
}

const USER_RULE = {
  id: "local.no-deploy-friday",
  category: "prod-infra",
  severity: "medium",
  defaultAction: "block",
  title: "Confirm before deploying",
  match: { any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./deploy.sh"] }] },
};

/**
 * A guardrail of the user's own, filed under a category that is not a library pack.
 * `guardrails add` only accepts library packs, but `guardrails.json` is hand-editable and
 * the hook loads any non-empty category — so this is a real shape to support.
 */
const USER_RULE_OWN_CATEGORY = {
  id: "local.team-release-freeze",
  category: "my-team",
  severity: "medium",
  defaultAction: "block",
  title: "Release freeze",
  match: { any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./release.sh"] }] },
};

/**
 * A hand-edited guardrail the hook's structural loader admits (`any_of: [{}]` has a populated
 * positive arm) but the strict validator rejects (the condition has no `kind`). The hook runs
 * it, so its category is a real pack to the hook even though `guardrails list` cannot show it.
 */
const LOOSE_RULE = {
  id: "local.loose",
  category: "loose-team",
  defaultAction: "block",
  match: { any_of: [{}] },
};

/**
 * Shell-split a printed command line the way a POSIX shell would.
 *
 * The backslash branch is not optional: POSIX has no escape INSIDE single quotes, so `'` in a value is
 * emitted as `'\''` — close, escaped quote, reopen. A splitter without the escape
 * reads that as two adjacent quoted runs and silently drops the quote.
 *
 * The authoritative check is in `built-artifact.test.ts`, which feeds the same line to
 * a real `/bin/sh`. This helper exists so the unit-level round trip does not need to
 * spawn a process per case.
 */
function shellSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote === undefined && c === "\\" && i + 1 < line.length) {
      // Outside quotes a backslash escapes the next character, literally.
      cur += line[i + 1] as string;
      i++;
      started = true;
    } else if (quote === undefined && (c === '"' || c === "'")) {
      quote = c;
      started = true;
    } else if (quote !== undefined && c === quote) {
      quote = undefined;
    } else if (quote === undefined && /\s/.test(c)) {
      if (cur.length > 0 || started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
    }
  }
  if (cur.length > 0 || started) out.push(cur);
  return out;
}

// ── allow: the pressure valve ───────────────────────────────────────────────

describe("guardrails allow", () => {
  it("stores the entry and says what changed, in one line", async () => {
    const h = harness();
    expect(await runRules(["allow", "wt.reset-hard", "git reset --hard ./scratch"], h.io)).toBe(0);
    expect(h.config().allowlist).toEqual([
      { guardrail: "wt.reset-hard", pattern: "git reset --hard ./scratch" },
    ]);
    expect(h.out()).toContain("Allowlisted.");
    expect(h.out()).toContain("wt.reset-hard");
    // The reassurance is the load-bearing half: a user must know the rule still works.
    expect(h.out()).toContain("everything else");
  });

  it("leaves the OTHER guardrails firing", async () => {
    // Asserted through the config the hook actually reads, not through the message.
    const h = harness();
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./scratch"], h.io);
    const config = h.config();
    expect(config.allowlist.filter((a) => a.guardrail !== "wt.reset-hard")).toEqual([]);
    expect(config.disabledGuardrails).toEqual([]);
    expect(config.guardrailActionOverrides).toEqual({});
  });

  it.each([
    ["!foo"],
    ["*"],
    ["**"],
    ["{*,}"],
    ["?*"],
  ])("REFUSES %s and writes nothing at all", async (pattern) => {
    const h = harness();
    expect(await runRules(["allow", "wt.reset-hard", pattern], h.io)).toBe(1);
    // Over the write list, not the output: a refusal that still wrote would pass a
    // string search for the refusal message.
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain("refusing that pattern");
  });

  it("refuses the `<your pattern>` placeholder `status` prints", async () => {
    const h = harness();
    expect(await runRules(["allow", "wt.reset-hard", PATTERN_PLACEHOLDER], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain(PATTERN_PLACEHOLDER);
  });

  it("refuses a redaction placeholder", async () => {
    const h = harness();
    expect(
      await runRules(["allow", "block-env-file-read", "cat [REDACTED:secret:env]"], h.io),
    ).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("refuses a pattern that is one of the guardrail's own block fixtures", async () => {
    // `git reset --hard` is a canonical dangerous example wt.reset-hard exists to stop.
    // Allowlisting it would blind the guardrail to its own purpose.
    const h = harness();
    expect(await runRules(["allow", "wt.reset-hard", "git reset --hard"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain("refusing that pattern");
    expect(h.out()).toContain("exists to stop");
  });

  it("refuses an unknown guardrail id — an entry naming nothing is dead weight", async () => {
    const h = harness();
    expect(await runRules(["allow", "wt.reset-hardd", "git reset --hard ./x"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    // The suggestion is the difference between a dead end and a fix.
    expect(h.out()).toContain("wt.reset-hard");
  });

  it("says so on a duplicate rather than writing it twice", async () => {
    const h = harness();
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], h.io);
    const writesAfterFirst = h.writes.length;
    expect(await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], h.io)).toBe(0);
    expect(h.writes).toHaveLength(writesAfterFirst);
    expect(h.out()).toContain("Nothing changed");
  });

  it("takes a pattern that starts with `-` verbatim", async () => {
    // `parseArgs` in `cli.ts` would have eaten this entirely; the whole reason `rules`
    // scans its own arguments.
    const h = harness();
    expect(await runRules(["allow", "wt.reset-hard", "--hard ./x"], h.io)).toBe(0);
    expect(h.config().allowlist[0]?.pattern).toBe("--hard ./x");
  });

  it("prints the glob note only when the pattern has a glob", async () => {
    const withGlob = harness();
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./scratch/**"], withGlob.io);
    expect(withGlob.out()).toContain("segments");

    const literal = harness();
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], literal.io);
    expect(literal.out()).not.toContain("segments");
  });
});

// ── The round trip that proves the printed line works ───────────────────────

describe("silenceCommand round-trips through guardrails allow", () => {
  it.each([
    ["a plain command", "git reset --hard ./x"],
    ["one containing a double quote", 'echo "hi"'],
    ["one containing a shell variable", "rm -rf $DIR"],
    ["one containing a single quote", "echo it's"],
    ["one containing a backtick", "echo `date`"],
  ])("%s survives print → shell-split → stored pattern", async (_name, command) => {
    // Built from `silenceCommand` itself, never a retyped literal: a copy of the string
    // cannot catch a drift in the string.
    const line = silenceCommand("wt.reset-hard", command);
    const argv = shellSplit(line);
    expect(argv.slice(0, 3)).toEqual(["agenttrail-guard", "guardrails", "allow"]);

    const h = harness();
    // `runRules` receives everything AFTER `guardrails`, i.e. ["allow", <id>, <pattern>].
    expect(await runRules(argv.slice(2), h.io)).toBe(0);
    // The pattern stored must be the command that was recorded — byte for byte.
    expect(h.config().allowlist[0]?.pattern).toBe(command);
  });

  it("PINNED: the spelling, so the printed line and the parser stay one string", () => {
    expect(silenceCommand("wt.reset-hard", "git reset --hard ./x")).toBe(
      "agenttrail-guard guardrails allow wt.reset-hard 'git reset --hard ./x'",
    );
  });
});

// ── set-action: the ask / require_approval boundary ─────────────────────────

describe("guardrails set-action", () => {
  it("takes `ask`, stores `require_approval`, prints `ask`", async () => {
    const h = harness();
    expect(await runRules(["set-action", "wt.reset-hard", "ask"], h.io)).toBe(0);
    expect(h.config().guardrailActionOverrides["wt.reset-hard"]).toBe("require_approval");
    expect(h.out()).toContain("block → ask");
    expect(h.out()).not.toContain("require_approval");
  });

  it("also takes `require_approval` and produces the same bytes", async () => {
    const viaAsk = harness();
    await runRules(["set-action", "wt.reset-hard", "ask"], viaAsk.io);
    const viaStored = harness();
    await runRules(["set-action", "wt.reset-hard", "require_approval"], viaStored.io);
    expect(viaStored.raw(CONFIG)).toBe(viaAsk.raw(CONFIG));
  });

  it("reports the stored spelling under --json, because the reader is a machine", async () => {
    const h = harness();
    await runRules(["set-action", "wt.reset-hard", "ask", "--json"], h.io);
    expect(JSON.parse(h.out())).toMatchObject({ ok: true, action: "require_approval" });
  });

  it("removes the override entirely when set back to the shipped default", async () => {
    // Not "writes block" — an override equal to the default is noise in a hand-edited
    // file and would survive a change to the shipped action.
    const h = harness();
    await runRules(["set-action", "wt.reset-hard", "ask"], h.io);
    await runRules(["set-action", "wt.reset-hard", "block"], h.io);
    expect(h.config().guardrailActionOverrides).toEqual({});
  });

  it("rejects a word that is not an action", async () => {
    const h = harness();
    expect(await runRules(["set-action", "wt.reset-hard", "deny"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("says so when the action is already what was asked for", async () => {
    const h = harness();
    expect(await runRules(["set-action", "wt.reset-hard", "block"], h.io)).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain("Nothing changed");
  });
});

// ── enable / disable ────────────────────────────────────────────────────────

describe("guardrails enable and disable", () => {
  it("disables one guardrail by id and leaves the rest alone", async () => {
    const h = harness();
    expect(await runRules(["disable", "wt.reset-hard"], h.io)).toBe(0);
    expect(h.config().disabledGuardrails).toEqual(["wt.reset-hard"]);
    expect(h.out()).toContain("Disabled wt.reset-hard");
  });

  it("re-enables it", async () => {
    const h = harness();
    await runRules(["disable", "wt.reset-hard"], h.io);
    expect(await runRules(["enable", "wt.reset-hard"], h.io)).toBe(0);
    expect(h.config().disabledGuardrails).toEqual([]);
    expect(h.out()).toContain("Enabled wt.reset-hard");
  });

  it("disables a whole pack by recording it in disabledPacks, and nothing else", async () => {
    const h = harness();
    expect(await runRules(["disable", "working-tree"], h.io)).toBe(0);
    expect(h.config().disabledPacks).toEqual(["working-tree"]);
    expect(JSON.parse(h.raw(CONFIG) as string)).not.toHaveProperty("enabledPacks");
    expect(h.out()).toContain("Disabled pack working-tree");
  });

  it("re-enabling a pack removes it from disabledPacks", async () => {
    const h = harness();
    await runRules(["disable", "working-tree"], h.io);
    await runRules(["disable", "exfiltration"], h.io);
    expect(await runRules(["enable", "working-tree"], h.io)).toBe(0);
    expect(h.config().disabledPacks).toEqual(["exfiltration"]);
    expect(h.out()).toContain("Enabled pack working-tree");
  });

  it.each([
    ["disable", "disabled"],
    ["enable", "enabled"],
  ])("a second %s of a pack is a stated no-op that writes nothing", async (verb, state) => {
    const h = harness();
    if (verb === "enable") await runRules(["disable", "working-tree"], h.io);
    await runRules([verb, "working-tree"], h.io);
    const before = h.writes.length;
    expect(await runRules([verb, "working-tree"], h.io)).toBe(0);
    expect(h.writes).toHaveLength(before);
    expect(h.out()).toContain(`Pack working-tree was already ${state}. Nothing changed.`);
  });

  it("allows turning every library pack off, and says only your own guardrails remain", async () => {
    // A list of what is OFF has no empty-list trap, so this is expressible and allowed —
    // but it is said plainly, with the way back.
    const packs = PACKS.slice(0, -1);
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: packs }),
      [RULES]: JSON.stringify([USER_RULE_OWN_CATEGORY]),
    });
    expect(await runRules(["disable", PACKS[PACKS.length - 1] as string], h.io)).toBe(0);
    expect(h.config().disabledPacks).toHaveLength(PACKS.length);
    expect(h.out()).toContain(
      "No library pack is on now — only your own guardrails are enforcing.",
    );
    expect(h.out()).toContain("guardrails reset --all");
  });

  it("does not warn about every pack being off while any library pack is still on", async () => {
    const h = harness();
    await runRules(["disable", "working-tree"], h.io);
    expect(h.out()).not.toContain("No library pack is on now");
  });

  it("says the guard checks nothing when every library pack is off and you have no guardrails", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: PACKS.slice(0, -1) }),
    });
    expect(await runRules(["disable", PACKS[PACKS.length - 1] as string], h.io)).toBe(0);
    expect(h.out()).toContain("you have no guardrails of your own — the guard is checking nothing");
  });

  it("puts every-pack-off in the --json answer, where the sentence is not printed", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: PACKS.slice(0, -1) }),
    });
    await runRules(["disable", PACKS[PACKS.length - 1] as string, "--json"], h.io);
    expect(JSON.parse(h.out()).allLibraryPacksOff).toBe(true);
  });

  it("can turn back on a category only the hook's loader knows about", async () => {
    // A hand-edited guardrail the hook loads but the stricter validator rejects. Its
    // category is real to the hook, so the same word must be able to turn it back on.
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: ["loose-team"] }),
      [RULES]: JSON.stringify([LOOSE_RULE]),
    });
    expect(await runRules(["enable", "loose-team"], h.io)).toBe(0);
    expect(h.config().disabledPacks).toEqual([]);
  });

  it("can take a misspelled name back out of disabledPacks", async () => {
    const h = harness({ [CONFIG]: JSON.stringify({ version: 1, disabledPacks: ["exfiltraton"] }) });
    expect(await runRules(["enable", "exfiltraton"], h.io)).toBe(0);
    expect(h.config().disabledPacks).toEqual([]);
  });

  it("switches off a category of your own guardrails by name", async () => {
    const h = harness({ [RULES]: JSON.stringify([USER_RULE_OWN_CATEGORY]) });
    expect(await runRules(["disable", "my-team"], h.io)).toBe(0);
    expect(h.config().disabledPacks).toEqual(["my-team"]);
    expect(h.out()).toContain("Disabled pack my-team (1 guardrail)");
  });

  it("tells a user their re-enabled guardrail is still off because its pack is", async () => {
    // Without this the command reports success and the rule does not fire — the exact
    // class of silent failure this surface exists to remove.
    const h = harness({
      [CONFIG]: JSON.stringify({
        version: 1,
        disabledPacks: ["working-tree"],
        disabledGuardrails: ["wt.reset-hard"],
      }),
    });
    expect(await runRules(["enable", "wt.reset-hard"], h.io)).toBe(0);
    expect(h.out()).toContain("still not enforcing");
    expect(h.out()).toContain("working-tree");
  });

  it("refuses an unknown target and writes nothing", async () => {
    const h = harness();
    expect(await runRules(["disable", "not-a-thing"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
  });
});

// ── add / remove ────────────────────────────────────────────────────────────

describe("guardrails add", () => {
  it("validates, appends, and says how many guardrails are active", async () => {
    const h = harness({ "/tmp/r.json": JSON.stringify(USER_RULE) });
    expect(await runRules(["add", "/tmp/r.json"], h.io)).toBe(0);
    expect(h.writes.map((w) => w.path)).toEqual([RULES]);
    expect(JSON.parse(h.raw(RULES) as string)).toEqual([USER_RULE]);
    expect(h.out()).toContain("Validated. Added local.no-deploy-friday");
    expect(h.out()).toContain("guardrails active");
  });

  it("REJECTS a common mistaken form, naming BOTH faults", async () => {
    // Held as a literal on purpose: this is the shape people actually paste.
    const stale = {
      id: "local.no-deploy-friday",
      severity: "medium",
      defaultAction: "ask",
      title: "Confirm before deploying",
      match: USER_RULE.match,
    };
    const h = harness({ "/tmp/stale.json": JSON.stringify(stale) });
    expect(await runRules(["add", "/tmp/stale.json"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain("require_approval");
    expect(h.out()).toContain("category");
    // And it prints the corrected form, so the fix does not require reading a doc.
    expect(h.out()).toContain('"category": "prod-infra"');
    expect(h.out()).toContain('"defaultAction": "require_approval"');
  });

  it("REJECTS a `numeric` guardrail and states the MECHANISM, not the schema key", async () => {
    // A user told only "unrecognized key `numeric`" assumes a schema nicety. The rule
    // would have frozen every command they run.
    const rule = {
      id: "local.cheap",
      category: "prod-infra",
      defaultAction: "block",
      title: "x",
      match: {
        any_of: [{ kind: "execute_tool", numeric: [{ field: "tokens", op: "lt", value: 1 }] }],
      },
    };
    const h = harness({ "/tmp/n.json": JSON.stringify(rule) });
    expect(await runRules(["add", "/tmp/n.json"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain("fires on EVERY command");
  });

  it("REJECTS a `scope` guardrail", async () => {
    const rule = {
      id: "local.scoped",
      category: "prod-infra",
      defaultAction: "block",
      title: "x",
      match: { ...USER_RULE.match, scope: { agent_in: ["claude-code"] } },
    };
    const h = harness({ "/tmp/s.json": JSON.stringify(rule) });
    expect(await runRules(["add", "/tmp/s.json"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain("matches nothing");
  });

  it("REJECTS a category that is not one of the eleven packs", async () => {
    const h = harness({
      "/tmp/c.json": JSON.stringify({ ...USER_RULE, category: "made-up" }),
    });
    expect(await runRules(["add", "/tmp/c.json"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("refuses a duplicate id rather than silently replacing a guardrail the user wrote", async () => {
    const h = harness({
      "/tmp/r.json": JSON.stringify(USER_RULE),
      [RULES]: JSON.stringify([USER_RULE]),
    });
    expect(await runRules(["add", "/tmp/r.json"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("refuses to append to a guardrails.json it cannot parse, rather than discarding it", async () => {
    const h = harness({ "/tmp/r.json": JSON.stringify(USER_RULE), [RULES]: "{not json" });
    expect(await runRules(["add", "/tmp/r.json"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.raw(RULES)).toBe("{not json");
  });
});

describe("guardrails remove", () => {
  it("removes one of the user's own guardrails", async () => {
    const h = harness({ [RULES]: JSON.stringify([USER_RULE]) });
    expect(await runRules(["remove", "local.no-deploy-friday"], h.io)).toBe(0);
    expect(JSON.parse(h.raw(RULES) as string)).toEqual([]);
    expect(h.out()).toContain("Removed local.no-deploy-friday");
  });

  it("refuses a shipped guardrail and points at disable", async () => {
    const h = harness();
    expect(await runRules(["remove", "wt.reset-hard"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain("guardrails disable wt.reset-hard");
  });
});

// ── reset ───────────────────────────────────────────────────────────────────

describe("guardrails reset", () => {
  it("clears one guardrail's override, allowlist entries and disabled state, and nothing else", async () => {
    const h = harness();
    await runRules(["set-action", "wt.reset-hard", "ask"], h.io);
    await runRules(["set-action", "block-env-file-read", "block"], h.io);
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], h.io);
    await runRules(["disable", "wt.reset-hard"], h.io);

    expect(await runRules(["reset", "wt.reset-hard"], h.io)).toBe(0);
    const config = h.config();
    expect(config.guardrailActionOverrides["wt.reset-hard"]).toBeUndefined();
    expect(config.allowlist).toEqual([]);
    expect(config.disabledGuardrails).toEqual([]);
    // The other rule's override is untouched — "and nothing else" is the assertion.
    expect(config.guardrailActionOverrides["block-env-file-read"]).toBe("block");
  });

  it("--all restores the packs and leaves guardrails.json byte-identical", async () => {
    const rulesText = `${JSON.stringify([USER_RULE], null, 2)}\n`;
    const h = harness({ [RULES]: rulesText });
    await runRules(["set-action", "wt.reset-hard", "ask"], h.io);
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], h.io);
    await runRules(["disable", "working-tree"], h.io);

    expect(await runRules(["reset", "--all"], h.io)).toBe(0);
    const config = h.config();
    expect(config.guardrailActionOverrides).toEqual({});
    expect(config.allowlist).toEqual([]);
    expect(config.disabledGuardrails).toEqual([]);
    expect(config.disabledPacks).toEqual([]);
    expect(JSON.parse(h.raw(CONFIG) as string)).not.toHaveProperty("enabledPacks");
    // Asserted rather than assumed.
    expect(h.raw(RULES)).toBe(rulesText);
    expect(h.out()).toContain("were NOT touched");
  });

  it("--all keeps a guardrail of your own with its own category loading", async () => {
    // Resetting used to rewrite the pack list to the library's packs, which silently
    // dropped a user guardrail filed under a category of its own.
    const h = harness({ [RULES]: JSON.stringify([USER_RULE_OWN_CATEGORY]) });
    await runRules(["disable", "my-team"], h.io);
    expect(await runRules(["reset", "--all"], h.io)).toBe(0);
    expect(h.config().disabledPacks).toEqual([]);
    const list = harness({ [CONFIG]: h.raw(CONFIG) as string, [RULES]: h.raw(RULES) as string });
    await runRules(["list", "--json"], list.io);
    const mine = JSON.parse(list.out()).guardrails.find(
      (r: { id: string }) => r.id === USER_RULE_OWN_CATEGORY.id,
    );
    expect(mine.enabled).toBe(true);
  });

  it("--all does not count a misspelled disabledPacks entry as a pack coming back", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: ["working-tree", "exfiltraton"] }),
    });
    expect(await runRules(["reset", "--all"], h.io)).toBe(0);
    expect(h.out()).toContain("Re-enabled 1 pack — every pack is now on.");
    expect(h.config().disabledPacks).toEqual([]);
  });

  it("--all clears a disabled category only the hook's loader knows about", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: ["loose-team"] }),
      [RULES]: JSON.stringify([LOOSE_RULE]),
    });
    expect(await runRules(["reset", "--all"], h.io)).toBe(0);
    expect(h.config().disabledPacks).toEqual([]);
    expect(h.out()).toContain("Re-enabled 1 pack — every pack is now on.");
  });

  it("--all removes an enabledPacks key an older release left, and says so", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, enabledPacks: ["working-tree"] }),
    });
    expect(await runRules(["reset", "--all"], h.io)).toBe(0);
    expect(JSON.parse(h.raw(CONFIG) as string)).not.toHaveProperty("enabledPacks");
    expect(h.out()).toContain("Removed `enabledPacks`");
    // And the list that follows has nothing left to report about it.
    const after = harness({ [CONFIG]: h.raw(CONFIG) as string });
    await runRules(["list"], after.io);
    expect(after.out()).not.toContain("PROBLEM in config.json");
  });

  it("says so when there is nothing to reset", async () => {
    const h = harness();
    expect(await runRules(["reset", "--all"], h.io)).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.out()).toContain("Nothing to reset");
  });

  it("states pack changes on their own line, separate from override/allowlist, and clears disabledPacks", async () => {
    const h = harness();
    await runRules(["disable", "working-tree"], h.io);
    expect(await runRules(["reset", "--all"], h.io)).toBe(0);
    expect(h.config().disabledPacks).toEqual([]);
    // The override/allowlist reset and the pack re-enable are separate sentences.
    expect(h.out()).toContain(
      "Reset 0 action overrides, 0 allowlist entries, and 0 disabled guardrails.",
    );
    expect(h.out()).toContain("Re-enabled 1 pack — every pack is now on.");
  });

  it("needs a target", async () => {
    const h = harness();
    expect(await runRules(["reset"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
  });
});

// ── list / show ─────────────────────────────────────────────────────────────

describe("guardrails list", () => {
  it("shows every guardrail with its effective action, in `ask` not `require_approval`", async () => {
    const h = harness();
    expect(await runRules(["list"], h.io)).toBe(0);
    expect(h.out()).toContain("wt.reset-hard");
    expect(h.out()).toContain("block-env-file-read");
    expect(h.out()).toContain("ask");
    expect(h.out()).not.toContain("require_approval");
  });

  it("--pack filters, and names the packs when the pack is unknown", async () => {
    const h = harness();
    await runRules(["list", "--pack", "working-tree"], h.io);
    expect(h.out()).toContain("wt.reset-hard");
    expect(h.out()).not.toContain("block-env-file-read");

    const bad = harness();
    expect(await runRules(["list", "--pack", "nope"], bad.io)).toBe(1);
    expect(bad.out()).toContain("working-tree");
  });

  it("--enabled and --disabled partition without overlap or loss", async () => {
    const h = harness();
    await runRules(["disable", "wt.reset-hard"], h.io);

    const on = harness({ [CONFIG]: h.raw(CONFIG) as string });
    await runRules(["list", "--enabled"], on.io);
    const off = harness({ [CONFIG]: h.raw(CONFIG) as string });
    await runRules(["list", "--disabled"], off.io);

    expect(off.out()).toContain("wt.reset-hard");
    expect(on.out()).not.toContain("wt.reset-hard  ");
    expect(on.out()).toContain("dd.rm-rf-absolute");
  });

  it("--json parses to one object and reports the STORED action", async () => {
    const h = harness();
    await runRules(["set-action", "wt.reset-hard", "ask"], h.io);
    const j = harness({ [CONFIG]: h.raw(CONFIG) as string });
    await runRules(["list", "--json"], j.io);
    const parsed = JSON.parse(j.out());
    expect(parsed.ok).toBe(true);
    const rule = parsed.guardrails.find((r: { id: string }) => r.id === "wt.reset-hard");
    expect(rule.action).toBe("require_approval");
    expect(rule.shippedAction).toBe("block");
  });

  it("surfaces a config.json setting that was silently dropped", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({
        version: 1,
        guardrailActionOverrides: { "wt.reset-hard": "ask" },
      }),
    });
    await runRules(["list"], h.io);
    expect(h.out()).toContain("PROBLEM in config.json");
    expect(h.out()).toContain("require_approval");
  });

  it("names a misspelled pack in disabledPacks, but not a category of your own", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: ["exfiltraton", "my-team"] }),
      [RULES]: JSON.stringify([USER_RULE_OWN_CATEGORY]),
    });
    await runRules(["list"], h.io);
    expect(h.out()).toContain("PROBLEM in config.json — disabledPacks.exfiltraton");
    expect(h.out()).not.toContain("disabledPacks.my-team");
  });

  it("does not call a category the hook loads unknown, even when the validator rejects its rule", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: ["loose-team"] }),
      [RULES]: JSON.stringify([LOOSE_RULE]),
    });
    await runRules(["list"], h.io);
    expect(h.out()).not.toContain("disabledPacks.loose-team");
  });

  it("marks every guardrail of a disabled pack as off because of its pack", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledPacks: ["working-tree"] }),
    });
    await runRules(["list", "--pack", "working-tree"], h.io);
    expect(h.out()).toMatch(/working-tree\s+\d+ guardrails · disabled/);
    expect(h.out()).toContain("(pack disabled)");
  });

  it("warns about an installed `numeric` guardrail and states the mechanism", async () => {
    const h = harness({
      [RULES]: JSON.stringify([
        {
          id: "local.cheap",
          category: "prod-infra",
          defaultAction: "block",
          title: "x",
          match: {
            any_of: [{ kind: "execute_tool", numeric: [{ field: "tokens", op: "lt", value: 1 }] }],
          },
        },
      ]),
    });
    await runRules(["list"], h.io);
    expect(h.out()).toContain("WARNING: local.cheap");
    expect(h.out()).toContain("fires on EVERY command");
  });
});

describe("guardrails show", () => {
  it("renders the effective action, the shipped default and the allowlist", async () => {
    const h = harness();
    await runRules(["set-action", "wt.reset-hard", "ask"], h.io);
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], h.io);

    const s = harness({ [CONFIG]: h.raw(CONFIG) as string });
    expect(await runRules(["show", "wt.reset-hard"], s.io)).toBe(0);
    expect(s.out()).toContain("Action        ask");
    expect(s.out()).toContain("shipped default: block");
    expect(s.out()).toContain("git reset --hard ./x");
    expect(s.out()).toContain("Enforcing     yes");
  });

  it("says WHY a guardrail is not enforcing, and how to turn it back on", async () => {
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, disabledGuardrails: ["wt.reset-hard"] }),
    });
    await runRules(["show", "wt.reset-hard"], h.io);
    expect(h.out()).toContain("guardrails enable wt.reset-hard");
  });

  it("refuses an unknown id with a suggestion", async () => {
    const h = harness();
    expect(await runRules(["show", "wt.reset-hardx"], h.io)).toBe(1);
    expect(h.out()).toContain("wt.reset-hard");
  });
});

// ── validate ────────────────────────────────────────────────────────────────

describe("guardrails validate", () => {
  it("with no file, reports the installed guardrails as valid", async () => {
    const h = harness({ [RULES]: JSON.stringify([USER_RULE]) });
    expect(await runRules(["validate"], h.io)).toBe(0);
    expect(h.out()).toContain("Valid.");
  });

  it("with no file, reports an invalid installed guardrail and exits 1", async () => {
    const h = harness({
      [RULES]: JSON.stringify([{ ...USER_RULE, defaultAction: "ask" }]),
    });
    expect(await runRules(["validate"], h.io)).toBe(1);
    expect(h.out()).toContain("require_approval");
  });

  it("with a file, rejects a guardrail missing fixtures — the check CI runs", async () => {
    // `parseRule` is literally the function `defineRule` calls at module load, so a
    // corpus rule that fails here fails the build.
    const h = harness({ "/tmp/r.json": JSON.stringify(USER_RULE) });
    expect(await runRules(["validate", "/tmp/r.json"], h.io)).toBe(1);
    expect(h.out()).toContain("the same check CI runs");
  });

  it("with a file, runs the fixtures and says which engine ran them", async () => {
    const corpusRule = {
      ...USER_RULE,
      description: "Synthetic, for the fixture run.",
      fixtures: {
        block: [{ tool: "Bash", command: "./deploy.sh prod" }],
        allow: [{ tool: "Bash", command: "ls -la" }],
      },
    };
    const h = harness({ "/tmp/ok.json": JSON.stringify(corpusRule) });
    expect(await runRules(["validate", "/tmp/ok.json"], h.io)).toBe(0);
    expect(h.out()).toContain("PASS");
    // Names which engine ran the fixtures: the schema half is CI's, the fixture half is
    // the guard's own evaluator.
    expect(h.out()).toContain("guard's own evaluator");
  });

  it("FAILS a guardrail whose block fixture does not match — the net catches something", async () => {
    const wrong = {
      ...USER_RULE,
      description: "Synthetic, deliberately wrong.",
      fixtures: {
        block: [{ tool: "Bash", command: "ls -la" }],
        allow: [{ tool: "Bash", command: "./deploy.sh prod" }],
      },
    };
    const h = harness({ "/tmp/bad.json": JSON.stringify(wrong) });
    expect(await runRules(["validate", "/tmp/bad.json"], h.io)).toBe(1);
    expect(h.out()).toContain("FAIL");
  });
});

// ── flags, arguments, and the contract with `runCli` ────────────────────────

describe("shared flags and argument scanning", () => {
  it("--config moves BOTH files, not just config.json", async () => {
    const h = harness();
    await runRules(
      ["allow", "wt.reset-hard", "git reset --hard ./x", "--config", "/scratch"],
      h.io,
    );
    expect(h.writes.map((w) => w.path)).toEqual(["/scratch/config.json"]);

    const add = harness({ "/tmp/r.json": JSON.stringify(USER_RULE) });
    await runRules(["add", "/tmp/r.json", "--config", "/scratch"], add.io);
    expect(add.writes.map((w) => w.path)).toEqual(["/scratch/guardrails.json"]);
  });

  it("--quiet suppresses the confirmation but NOT a refusal", async () => {
    const quiet = harness();
    expect(
      await runRules(["allow", "wt.reset-hard", "git reset --hard ./x", "--quiet"], quiet.io),
    ).toBe(0);
    expect(quiet.out()).toBe("");
    // Still wrote, though: quiet is about the message, not the effect.
    expect(quiet.config().allowlist).toHaveLength(1);

    const refused = harness();
    expect(await runRules(["allow", "wt.reset-hard", "*", "--quiet"], refused.io)).toBe(1);
    expect(refused.out()).not.toBe("");
  });

  it("--json wins over --quiet", async () => {
    const h = harness();
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x", "--json", "--quiet"], h.io);
    expect(JSON.parse(h.out())).toMatchObject({ ok: true });
  });

  it("takes --config=<dir> as well as --config <dir>", async () => {
    const h = harness();
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x", "--config=/scratch"], h.io);
    expect(h.writes.map((w) => w.path)).toEqual(["/scratch/config.json"]);
  });

  it("rejects an unknown flag rather than ignoring it", async () => {
    const h = harness();
    expect(await runRules(["list", "--nope"], h.io)).toBe(1);
    expect(h.out()).toContain("unknown flag");
  });

  it("rejects a value flag with no value", async () => {
    const h = harness();
    expect(await runRules(["list", "--pack"], h.io)).toBe(1);
    expect(h.out()).toContain("needs a value");
  });

  it("never writes outside the guard directory", async () => {
    // Mirrors `setup-commands.test.ts`'s strongest assertion, for the same reason: a
    // stray write is invisible to a string search over the output.
    const h = harness({ "/tmp/r.json": JSON.stringify(USER_RULE) });
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], h.io);
    await runRules(["set-action", "wt.reset-hard", "ask"], h.io);
    await runRules(["disable", "dd.rm-rf-absolute"], h.io);
    await runRules(["add", "/tmp/r.json"], h.io);
    expect([...new Set(h.writes.map((w) => w.path))].sort()).toEqual([CONFIG, RULES]);
  });

  it("refuses to mutate a config.json it cannot parse", async () => {
    // `parseConfig` is fail-open and would hand back defaults; writing on top of that
    // would silently delete whatever the user had.
    const h = harness({ [CONFIG]: "{not json" });
    expect(await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.raw(CONFIG)).toBe("{not json");
    // But a READ still works, off the defaults.
    expect(await runRules(["list"], h.io)).toBe(0);
  });

  it("preserves keys it does not understand when it writes", async () => {
    // `parseConfig` keeps only the seven keys it knows, so a serialize-from-config
    // writer would delete `crashEndpoint` and anything a newer build wrote.
    const h = harness({
      [CONFIG]: JSON.stringify({ version: 1, crashEndpoint: "https://x.test/e", somethingNew: 42 }),
    });
    await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], h.io);
    const written = JSON.parse(h.raw(CONFIG) as string);
    expect(written.crashEndpoint).toBe("https://x.test/e");
    expect(written.somethingNew).toBe(42);
  });

  it("prints usage for --help and for no subcommand", async () => {
    const help = harness();
    expect(await runRules(["--help"], help.io)).toBe(0);
    expect(help.out()).toContain("guardrails allow");

    const none = harness();
    expect(await runRules([], none.io)).toBe(1);
  });

  it("names an unknown subcommand", async () => {
    const h = harness();
    expect(await runRules(["frobnicate"], h.io)).toBe(1);
    expect(h.out()).toContain('unknown subcommand "frobnicate"');
  });

  it("never throws, and reports a failed write without changing anything", async () => {
    const h = harness();
    const throwing: SetupIO = {
      ...h.io,
      writeFileAtomic: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    expect(await runRules(["allow", "wt.reset-hard", "git reset --hard ./x"], throwing)).toBe(1);
    expect(h.out()).toContain("EACCES");
    expect(h.out()).toContain("nothing was changed");
  });
});

describe("guardrails validate names the one input where CI will disagree", () => {
  const base = {
    id: "local.win",
    category: "file-scope",
    severity: "medium",
    defaultAction: "require_approval",
    title: "Windows path fixture",
    description: "Synthetic.",
    match: { any_of: [{ kind: "execute_tool", file_glob: "**/.env*" }] },
  };

  it("warns when a fixture uses a backslash path", async () => {
    // The guard rewrites `\` to `/` when it builds the span (a forward-slash glob never
    // matches a backslash path), so a backslash fixture can pass here and fail wherever
    // paths are matched as written. `validate` must say so.
    const rule = {
      ...base,
      fixtures: {
        block: [{ tool: "Read", file_path: "C:\\project\\.env" }],
        allow: [{ tool: "Read", file_path: "src/index.ts" }],
      },
    };
    const h = harness({ "/tmp/win.json": JSON.stringify(rule) });
    await runRules(["validate", "/tmp/win.json"], h.io);
    expect(h.out()).toContain("evaluators answer DIFFERENTLY");
    expect(h.out()).toContain("Write forward slashes");
  });

  it("does NOT warn when the same fixture uses forward slashes", async () => {
    // The other direction — otherwise the warning is a permanent disclaimer nobody
    // reads, which is the thing it is meant not to be.
    const rule = {
      ...base,
      fixtures: {
        block: [{ tool: "Read", file_path: "C:/project/.env" }],
        allow: [{ tool: "Read", file_path: "src/index.ts" }],
      },
    };
    const h = harness({ "/tmp/posix.json": JSON.stringify(rule) });
    expect(await runRules(["validate", "/tmp/posix.json"], h.io)).toBe(0);
    expect(h.out()).not.toContain("evaluators answer DIFFERENTLY");
  });
});

describe("a guardrail that would match everything is named, not silently accepted", () => {
  const BROAD = {
    id: "usr.broad",
    category: "prod-infra",
    defaultAction: "block",
    title: "t",
    match: { any_of: [{ kind: "execute_tool" }] },
  };

  it("`guardrails list` warns, and states the mechanism", async () => {
    // Legal per the strict schema, so it is NOT rejected — refusing it would break the
    // one-directional invariant and let `guardrails add` write a rule the hook drops. It is
    // warned about instead, with the consequence spelled out rather than the word
    // "broad": at `block` this denies every command the user runs.
    const h = harness({ [RULES]: JSON.stringify([BROAD]) });
    expect(await runRules(["list"], h.io)).toBe(0);
    expect(h.out()).toContain("WARNING: usr.broad");
    expect(h.out()).toContain("denies every command you run");
  });

  it("`guardrails add` REFUSES to create one, and states the consequence", async () => {
    // Deliberate: keep the warning in the structural loader, but
    // refuse it at `add`. The strict validator getting SMALLER preserves
    // `strict ⊆ structural`, so this cannot reintroduce the divergence where the CLI
    // accepts a rule the hook then drops — while stopping the footgun where it is
    // actually made. A hand-edited file still only gets the warning.
    const h = harness({ "/tmp/broad.json": JSON.stringify(BROAD) });
    expect(await runRules(["add", "/tmp/broad.json"], h.io)).toBe(1);
    expect(h.writes).toEqual([]);
    // The consequence, not the word "broad".
    expect(h.out()).toContain("denies every command you run");
  });

  it("`guardrails add` still accepts a narrowed guardrail — the refusal is not a blanket one", async () => {
    const narrow = {
      ...BROAD,
      id: "usr.narrow",
      match: {
        any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./deploy.sh"] }],
      },
    };
    const h = harness({ "/tmp/narrow.json": JSON.stringify(narrow) });
    expect(await runRules(["add", "/tmp/narrow.json"], h.io)).toBe(0);
    expect(h.writes.map((w) => w.path)).toEqual([RULES]);
  });

  it("a properly narrowed guardrail gets no warning", async () => {
    // The other direction — otherwise the warning is a permanent banner nobody reads.
    const narrow = {
      ...BROAD,
      id: "usr.narrow",
      match: {
        any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./deploy.sh"] }],
      },
    };
    const h = harness({ [RULES]: JSON.stringify([narrow]) });
    await runRules(["list"], h.io);
    expect(h.out()).not.toContain("WARNING");
  });

  it("`guardrails validate` names a guardrail whose match selects nothing", async () => {
    // The discard has to be VISIBLE. A rule dropped by the hook with nothing reporting
    // why is the silent failure this whole surface exists to remove.
    const h = harness({
      [RULES]: JSON.stringify([
        {
          id: "usr.bogus",
          category: "prod-infra",
          defaultAction: "block",
          title: "t",
          match: { tool_in: ["Bash"] },
        },
      ]),
    });
    expect(await runRules(["validate"], h.io)).toBe(1);
    expect(h.out()).toContain("usr.bogus");
    expect(h.out()).toContain("NOT running");
  });
});

describe("a one-element brace alternation in `label` is named, not left inert", () => {
  // `{Bash,PowerShell}` is an alternation. `{Bash}` is not: picomatch reads a brace group
  // with no comma as literal braces, so the label only matches a tool literally named
  // `{Bash}`, and the guardrail never fires.
  const BRACED = {
    ...USER_RULE,
    match: {
      any_of: [{ kind: "execute_tool", label: "{Bash}", detail_contains: ["./deploy.sh"] }],
    },
  };
  const BRACED_CORPUS_RULE = {
    ...BRACED,
    description: "Synthetic, with a one-element brace alternation.",
    fixtures: {
      block: [{ tool: "Bash", command: "./deploy.sh prod" }],
      allow: [{ tool: "Bash", command: "ls -la" }],
    },
  };

  it("validate with a file warns on `{Bash}` and gives the corrected spelling", async () => {
    const h = harness({ "/tmp/b.json": JSON.stringify(BRACED_CORPUS_RULE) });
    // The block fixture is a matching command, and the braced label still misses it.
    expect(await runRules(["validate", "/tmp/b.json"], h.io)).toBe(1);
    expect(h.out()).toContain("block fixture   ./deploy.sh prod");
    expect(h.out()).toContain("FAIL");
    expect(h.out()).toContain("`{Bash}`");
    expect(h.out()).toContain('write `"Bash"`');
    expect(h.out()).toContain("match.any_of[0].label");
  });

  it("validate with a file reports the warning under --json", async () => {
    const h = harness({ "/tmp/b.json": JSON.stringify(BRACED_CORPUS_RULE) });
    await runRules(["validate", "/tmp/b.json", "--json"], h.io);
    const j = JSON.parse(h.out()) as Record<string, unknown>;
    expect(j.warnings).toEqual([
      { path: "match.any_of[0].label", label: "{Bash}", corrected: "Bash", rewrite: true },
    ]);
  });

  it("validate with no file warns on an installed guardrail that uses it", async () => {
    const h = harness({ [RULES]: JSON.stringify([BRACED]) });
    expect(await runRules(["validate"], h.io)).toBe(0);
    expect(h.out()).toContain("local.no-deploy-friday");
    expect(h.out()).toContain("`{Bash}`");
    expect(h.out()).toContain('write `"Bash"`');
  });

  it("validate with no file still warns when another installed guardrail is invalid", async () => {
    const h = harness({
      [RULES]: JSON.stringify([BRACED, { ...USER_RULE_OWN_CATEGORY, defaultAction: "ask" }]),
    });
    expect(await runRules(["validate"], h.io)).toBe(1);
    expect(h.out()).toContain("require_approval");
    expect(h.out()).toContain("`{Bash}`");
  });

  it("validate with no file keeps the warning under --json when another guardrail is invalid", async () => {
    const h = harness({
      [RULES]: JSON.stringify([BRACED, { ...USER_RULE_OWN_CATEGORY, defaultAction: "ask" }]),
    });
    expect(await runRules(["validate", "--json"], h.io)).toBe(1);
    const j = JSON.parse(h.out()) as Record<string, unknown>;
    expect(j.warnings).toEqual([
      {
        guardrail: "local.no-deploy-friday",
        path: "match.any_of[0].label",
        label: "{Bash}",
        corrected: "Bash",
        rewrite: true,
      },
    ]);
  });

  it("add rewrites `{Bash}` to `Bash` and says so", async () => {
    const h = harness({ "/tmp/b.json": JSON.stringify(BRACED) });
    expect(await runRules(["add", "/tmp/b.json"], h.io)).toBe(0);
    const stored = JSON.parse(h.raw(RULES) as string) as (typeof USER_RULE)[];
    expect(stored[0]?.match.any_of[0]?.label).toBe("Bash");
    expect(stored).toEqual([USER_RULE]);
    expect(h.out()).toContain("Rewrote");
    expect(h.out()).toContain("`{Bash}` to `Bash`");
  });

  it("add reports the rewrite under --json", async () => {
    const h = harness({ "/tmp/b.json": JSON.stringify(BRACED) });
    await runRules(["add", "/tmp/b.json", "--json"], h.io);
    const j = JSON.parse(h.out()) as Record<string, unknown>;
    expect(j).toMatchObject({ ok: true, changed: true, guardrail: "local.no-deploy-friday" });
    expect(j.rewrote).toEqual([
      { path: "match.any_of[0].label", label: "{Bash}", corrected: "Bash", rewrite: true },
    ]);
  });

  describe("a wildcard in one-value braces is warned about and never rewritten", () => {
    // Unwrapping `{*}` would turn a guardrail that never fires into one that matches every
    // tool call, so it is left as written.
    const STAR = {
      ...USER_RULE,
      match: {
        any_of: [{ kind: "execute_tool", label: "{*}", detail_contains: ["./deploy.sh"] }],
      },
    };
    const STAR_CORPUS_RULE = {
      ...STAR,
      description: "Synthetic, with a wildcard in one-value braces.",
      fixtures: {
        block: [{ tool: "Bash", command: "./deploy.sh prod" }],
        allow: [{ tool: "Bash", command: "ls -la" }],
      },
    };
    const WARNING = {
      path: "match.any_of[0].label",
      label: "{*}",
      corrected: "*",
      rewrite: false,
    };

    it("add writes `{*}` unchanged and warns with the spelling", async () => {
      const h = harness({ "/tmp/s.json": JSON.stringify(STAR) });
      expect(await runRules(["add", "/tmp/s.json"], h.io)).toBe(0);
      expect(JSON.parse(h.raw(RULES) as string)).toEqual([STAR]);
      expect(h.out()).not.toContain("Rewrote");
      expect(h.out()).toContain("WARNING");
      expect(h.out()).toContain("`{*}`");
      expect(h.out()).toContain('`"*"`');
      expect(h.out()).toContain("not rewritten");
    });

    it("add still prints the warning under --quiet", async () => {
      const h = harness({ "/tmp/s.json": JSON.stringify(STAR) });
      expect(await runRules(["add", "/tmp/s.json", "--quiet"], h.io)).toBe(0);
      expect(h.out()).toContain("WARNING");
      expect(h.out()).toContain("`{*}`");
      expect(h.out()).not.toContain("Validated.");
    });

    it("add writes a negation in one-value braces unchanged and warns", async () => {
      const negated = {
        ...USER_RULE,
        match: {
          any_of: [{ kind: "execute_tool", label: "{!Bash}", detail_contains: ["./deploy.sh"] }],
        },
      };
      const h = harness({ "/tmp/n.json": JSON.stringify(negated) });
      expect(await runRules(["add", "/tmp/n.json"], h.io)).toBe(0);
      expect(JSON.parse(h.raw(RULES) as string)).toEqual([negated]);
      expect(h.out()).not.toContain("Rewrote");
      expect(h.out()).toContain("WARNING");
    });

    it("add reports it under --json as a warning, not a rewrite", async () => {
      const h = harness({ "/tmp/s.json": JSON.stringify(STAR) });
      expect(await runRules(["add", "/tmp/s.json", "--json"], h.io)).toBe(0);
      expect(JSON.parse(h.raw(RULES) as string)).toEqual([STAR]);
      const j = JSON.parse(h.out()) as Record<string, unknown>;
      expect(j).not.toHaveProperty("rewrote");
      expect(j.warnings).toEqual([WARNING]);
    });

    it("add rewrites `{Bash}` and only warns on `{*}` in the same guardrail", async () => {
      const mixed = {
        ...USER_RULE,
        match: {
          any_of: [
            { kind: "execute_tool", label: "{*}", detail_contains: ["./deploy.sh"] },
            { kind: "execute_tool", label: "{Bash}", detail_contains: ["./release.sh"] },
          ],
        },
      };
      const h = harness({ "/tmp/m.json": JSON.stringify(mixed) });
      expect(await runRules(["add", "/tmp/m.json", "--json"], h.io)).toBe(0);
      const stored = JSON.parse(h.raw(RULES) as string) as (typeof mixed)[];
      expect(stored[0]?.match.any_of.map((c) => c.label)).toEqual(["{*}", "Bash"]);
      const j = JSON.parse(h.out()) as Record<string, unknown>;
      expect((j.rewrote as { label: string }[]).map((f) => f.label)).toEqual(["{Bash}"]);
      expect((j.warnings as { label: string }[]).map((f) => f.label)).toEqual(["{*}"]);
    });

    it("validate with a file warns and leaves the file unchanged", async () => {
      const text = JSON.stringify(STAR_CORPUS_RULE);
      const h = harness({ "/tmp/s.json": text });
      await runRules(["validate", "/tmp/s.json"], h.io);
      expect(h.out()).toContain("WARNING");
      expect(h.out()).toContain("`{*}`");
      expect(h.raw("/tmp/s.json")).toBe(text);
      expect(h.writes).toEqual([]);
    });

    it("validate with a file reports it under --json", async () => {
      const h = harness({ "/tmp/s.json": JSON.stringify(STAR_CORPUS_RULE) });
      await runRules(["validate", "/tmp/s.json", "--json"], h.io);
      expect((JSON.parse(h.out()) as Record<string, unknown>).warnings).toEqual([WARNING]);
    });

    it("validate with no file warns on an installed guardrail and leaves it unchanged", async () => {
      const text = JSON.stringify([STAR]);
      const h = harness({ [RULES]: text });
      expect(await runRules(["validate"], h.io)).toBe(0);
      expect(h.out()).toContain("WARNING local.no-deploy-friday");
      expect(h.out()).toContain("`{*}`");
      expect(h.raw(RULES)).toBe(text);
      expect(h.writes).toEqual([]);
    });

    it("validate with no file reports it under --json", async () => {
      const h = harness({ [RULES]: JSON.stringify([STAR]) });
      expect(await runRules(["validate", "--json"], h.io)).toBe(0);
      expect((JSON.parse(h.out()) as Record<string, unknown>).warnings).toEqual([
        { guardrail: "local.no-deploy-friday", ...WARNING },
      ]);
    });
  });

  it("leaves a real alternation alone, in add and in validate", async () => {
    const alternation = {
      ...USER_RULE,
      match: {
        any_of: [
          { kind: "execute_tool", label: "{Bash,PowerShell}", detail_contains: ["./deploy.sh"] },
        ],
      },
    };
    const added = harness({ "/tmp/a.json": JSON.stringify(alternation) });
    expect(await runRules(["add", "/tmp/a.json"], added.io)).toBe(0);
    expect(JSON.parse(added.raw(RULES) as string)).toEqual([alternation]);
    expect(added.out()).not.toContain("Rewrote");

    const installed = harness({ [RULES]: JSON.stringify([alternation]) });
    expect(await runRules(["validate"], installed.io)).toBe(0);
    expect(installed.out()).not.toContain("WARNING");
  });

  it("a rejected rule's example says what `label` accepts", async () => {
    const h = harness({ "/tmp/x.json": JSON.stringify({ ...USER_RULE, category: "made-up" }) });
    expect(await runRules(["add", "/tmp/x.json"], h.io)).toBe(1);
    expect(h.out()).toContain("`label` is one tool name");
    expect(h.out()).toContain("{Bash,PowerShell}");
  });
});

/**
 * The `--json` KEY CONTRACT.
 *
 * This is the one output in the package a machine reads, and a key name in it is
 * free to change today and impossible to change quietly once anything consumes it.
 * The keys are `guardrail` (never `rule`), and `list`'s array is `guardrails` (never
 * `rules`).
 *
 * Asserted across a REPRESENTATIVE SET of the emitting commands rather than one,
 * because the payload is spread over 21 `r.ok` sites and nothing in the type system
 * ties them together — `Reporter.ok` takes `Record<string, unknown>`, so one missed
 * site is a silent inconsistency, not a compile error. Each case asserts the new key
 * IS there and the old key is NOT, because a spread that added the new name while
 * leaving the old one would satisfy a positive-only check.
 */
describe("--json key contract", () => {
  const parse = (h: Harness) => JSON.parse(h.out()) as Record<string, unknown>;

  it("list emits `guardrails`, not `rules`", async () => {
    const h = harness();
    await runRules(["list", "--json"], h.io);
    const j = parse(h);
    expect(Array.isArray(j.guardrails)).toBe(true);
    expect(j).not.toHaveProperty("rules");
  });

  it.each([
    ["disable", ["disable", "wt.reset-hard", "--json"], "wt.reset-hard"],
    ["set-action", ["set-action", "wt.reset-hard", "warn", "--json"], "wt.reset-hard"],
    ["allow", ["allow", "wt.reset-hard", "git reset --hard ./scratch", "--json"], "wt.reset-hard"],
  ])("%s names the target under `guardrail`, not `rule`", async (_label, argv, id) => {
    const h = harness();
    await runRules(argv as string[], h.io);
    const j = parse(h);
    expect(j).toMatchObject({ ok: true, changed: true, guardrail: id });
    expect(j).not.toHaveProperty("rule");
  });

  it("a no-op still names the guardrail, so a machine can tell WHICH one did nothing", async () => {
    // `changed: false` with no target is indistinguishable from a command that ran
    // against the wrong id, which is the failure this surface exists to remove.
    const h = harness();
    await runRules(["enable", "wt.reset-hard", "--json"], h.io);
    const j = parse(h);
    expect(j).toMatchObject({ ok: true, changed: false, guardrail: "wt.reset-hard" });
    expect(j).not.toHaveProperty("rule");
  });

  it("pack commands still say `pack` — a pack did not become a guardrail", async () => {
    const h = harness();
    await runRules(["disable", "working-tree", "--json"], h.io);
    expect(parse(h)).toMatchObject({ ok: true, changed: true, pack: "working-tree" });
  });
});

describe("guardrails list --owasp", () => {
  const parse = (h: Harness) =>
    JSON.parse(h.out()) as { guardrails: { id: string; pack: string; owasp: string[] }[] };
  const taggedWith = (id: OwaspId) =>
    SHIPPED_CATALOG.filter((rule) => (rule.owasp ?? []).includes(id))
      .map((rule) => rule.id)
      .sort();
  const listed = (h: Harness) =>
    parse(h)
      .guardrails.map((g) => g.id)
      .sort();

  it("returns exactly the guardrails tagged with the id", async () => {
    const h = harness();
    expect(await runRules(["list", "--owasp", "ASI06", "--json"], h.io)).toBe(0);
    expect(listed(h)).toEqual(taggedWith("ASI06"));
    expect(listed(h)).toEqual(["ac.instruction-file-edit", "ac.memory-store-edit"]);
  });

  it.each(
    OWASP_IDS.map((id) => [id] as const),
  )("matches the catalog's own tags for %s", async (id) => {
    const h = harness();
    await runRules(["list", "--owasp", id, "--json"], h.io);
    expect(listed(h)).toEqual(taggedWith(id));
  });

  it("accepts any letter case, the list's year suffix and --owasp=<id>", async () => {
    for (const argv of [
      ["list", "--owasp", "asi06", "--json"],
      ["list", "--owasp", "ASI06:2026", "--json"],
      ["list", "--owasp=ASI06", "--json"],
      ["list", "--owasp", " ASI06 ", "--json"],
    ]) {
      const h = harness();
      expect(await runRules(argv, h.io), argv.join(" ")).toBe(0);
      expect(listed(h), argv.join(" ")).toEqual(taggedWith("ASI06"));
    }
  });

  it("refuses any suffix other than a year", async () => {
    for (const id of ["ASI06:x", "ASI06:", "ASI06:20266"]) {
      const h = harness();
      expect(await runRules(["list", "--owasp", id], h.io), id).toBe(1);
      expect(h.out(), id).toContain(`\`${id}\` is not an OWASP id`);
    }
  });

  it("answers an id on no list as unknown, whatever its year suffix", async () => {
    for (const id of ["ASI11:2025", "LLM00:2024", "ASI11:2026"]) {
      const h = harness();
      expect(await runRules(["list", "--owasp", id], h.io), id).toBe(1);
      expect(h.out(), id).toContain(`\`${id}\` is not an OWASP id`);
      expect(h.out(), id).not.toContain("another edition");
    }
  });

  it("refuses an id from another edition of the lists rather than renumbering it", async () => {
    // LLM03 is Supply Chain in the 2025 list and Excessive Agency in the 2026 one.
    for (const id of ["LLM03:2025", "LLM06:2025", "asi02:2024", "ASI02:2027"]) {
      const h = harness();
      expect(await runRules(["list", "--owasp", id], h.io), id).toBe(1);
      expect(h.out(), id).toContain(`\`${id}\` is from another edition of the OWASP lists`);
      expect(h.out(), id).toContain("2026 lists");
      const j = harness();
      expect(await runRules(["list", "--owasp", id, "--json"], j.io), id).toBe(1);
      expect(JSON.parse(j.out()), id).toMatchObject({ ok: false, command: "list" });
    }
    const ok = harness();
    expect(await runRules(["list", "--owasp", "ASI02:2026", "--json"], ok.io)).toBe(0);
    expect(listed(ok)).toEqual(taggedWith("ASI02"));
  });

  it("ANDs with --enabled and --disabled", async () => {
    const h = harness();
    await runRules(["disable", "ac.memory-store-edit"], h.io);
    const config = h.raw(CONFIG) as string;

    const on = harness({ [CONFIG]: config });
    await runRules(["list", "--owasp", "ASI06", "--enabled", "--json"], on.io);
    expect(listed(on)).toEqual(["ac.instruction-file-edit"]);

    const off = harness({ [CONFIG]: config });
    await runRules(["list", "--owasp", "ASI06", "--disabled", "--json"], off.io);
    expect(listed(off)).toEqual(["ac.memory-store-edit"]);
  });

  it("counts every tagged guardrail, and says how many the other filters left", async () => {
    const h = harness();
    await runRules(["list", "--owasp", "ASI06", "--pack", "agent-context", "--disabled"], h.io);
    expect(h.out()).toContain(
      "2 guardrails tagged ASI06 Memory and Context Poisoning; 0 of them shown with the other filters.",
    );
    const all = harness();
    await runRules(["list", "--owasp", "ASI06"], all.io);
    expect(all.out()).toContain("2 guardrails tagged ASI06 Memory and Context Poisoning. A tag");

    // The tagged count is taken before --pack: ASI10 spans two packs.
    const asi10 = taggedWith("ASI10");
    const inPack = SHIPPED_CATALOG.filter(
      (r) => r.category === "test-integrity" && asi10.includes(r.id),
    ).length;
    expect([asi10.length, inPack]).toEqual([6, 2]);
    const packed = harness();
    await runRules(["list", "--owasp", "ASI10", "--pack", "test-integrity"], packed.io);
    expect(packed.out()).toContain(
      "6 guardrails tagged ASI10 Rogue Agents; 2 of them shown with the other filters.",
    );
  });

  it("refuses an id that is on neither list, and names the ranges", async () => {
    const h = harness();
    expect(await runRules(["list", "--owasp", "ASI11"], h.io)).toBe(1);
    expect(h.out()).toContain("`ASI11` is not an OWASP id");
    expect(h.out()).toContain("ASI01 to ASI10");
    expect(h.out()).toContain("LLM01 to LLM10");
  });

  it("ANDs with --pack", async () => {
    const h = harness();
    await runRules(["list", "--owasp", "ASI10", "--pack", "test-integrity", "--json"], h.io);
    expect(listed(h)).toEqual(["ti.test-config-edit", "ti.test-file-delete"]);
  });

  it("says how many matched, and that a tag is not full coverage, even when none do", async () => {
    const h = harness();
    expect(await runRules(["list", "--owasp", "LLM01"], h.io)).toBe(0);
    expect(h.out()).toContain("0 guardrails tagged LLM01 Prompt Injection");
    expect(h.out()).toContain("not full coverage");
  });

  it("every --json row carries the guardrail's own ids, [] when it has none", async () => {
    const h = harness({ [RULES]: JSON.stringify([USER_RULE]) });
    await runRules(["list", "--json"], h.io);
    const rows = parse(h).guardrails;
    for (const row of rows) {
      const shipped = SHIPPED_CATALOG.find((rule) => rule.id === row.id);
      expect(row.owasp, row.id).toEqual([...(shipped?.owasp ?? [])]);
    }
    expect(rows.find((r) => r.id === USER_RULE.id)?.owasp).toEqual([]);
  });

  it("show prints the ids with their titles, and --json carries them", async () => {
    const h = harness();
    await runRules(["show", "ac.memory-store-edit"], h.io);
    expect(h.out()).toContain(
      "OWASP         ASI06 Memory and Context Poisoning, LLM03 Excessive Agency",
    );
    const j = harness();
    await runRules(["show", "ac.memory-store-edit", "--json"], j.io);
    expect((JSON.parse(j.out()) as { owasp: string[] }).owasp).toEqual(["ASI06", "LLM03"]);
  });
});

describe("a personal guardrail never claims an OWASP id", () => {
  const withOwasp = (owasp: unknown) => ({ ...USER_RULE, owasp });

  it.each([
    ["a valid id", ["ASI06"]],
    ["an invalid id", ["ASI11"]],
  ])("with %s, it is never listed under --owasp and its row carries []", async (_label, owasp) => {
    const h = harness({ [RULES]: JSON.stringify([withOwasp(owasp)]) });
    expect(await runRules(["list", "--owasp", "ASI06", "--json"], h.io)).toBe(0);
    const listed = JSON.parse(h.out()) as { guardrails: { id: string }[] };
    // Exactly the shipped ASI06 guardrails: the personal one is absent and nothing else moved.
    expect(listed.guardrails.map((g) => g.id).sort()).toEqual([
      "ac.instruction-file-edit",
      "ac.memory-store-edit",
    ]);

    const one = harness({ [RULES]: JSON.stringify([withOwasp(owasp)]) });
    await runRules(["show", USER_RULE.id, "--json"], one.io);
    expect((JSON.parse(one.out()) as { owasp: unknown }).owasp).toEqual([]);
  });

  it("add accepts it, keeps the file as written, and says the key is ignored", async () => {
    const h = harness({ "/tmp/rule.json": JSON.stringify(withOwasp(["ASI06"])) });
    expect(await runRules(["add", "/tmp/rule.json"], h.io)).toBe(0);
    expect(h.out()).toContain(OWASP_IGNORED_NOTE);
    // Written as given: the key is ignored when read, not removed from the user's file.
    expect(JSON.parse(h.raw(RULES) as string)).toEqual([withOwasp(["ASI06"])]);

    const j = harness({ "/tmp/rule.json": JSON.stringify(withOwasp(["ASI06"])) });
    await runRules(["add", "/tmp/rule.json", "--json"], j.io);
    expect(JSON.parse(j.out())).toMatchObject({
      ok: true,
      ignored: [{ guardrail: USER_RULE.id, key: "owasp" }],
    });
  });

  it("add --quiet still prints the note, as it does a brace warning", async () => {
    const h = harness({ "/tmp/rule.json": JSON.stringify(withOwasp(["ASI06"])) });
    expect(await runRules(["add", "/tmp/rule.json", "--quiet"], h.io)).toBe(0);
    expect(h.out()).toBe(`NOTE: ${OWASP_IGNORED_NOTE}\n`);
  });

  it("add --quiet prints nothing for a guardrail without owasp, and --json stays parseable", async () => {
    const plain = harness({ "/tmp/rule.json": JSON.stringify(USER_RULE) });
    expect(await runRules(["add", "/tmp/rule.json", "--quiet"], plain.io)).toBe(0);
    expect(plain.out()).toBe("");

    const j = harness({ "/tmp/rule.json": JSON.stringify(withOwasp(["ASI06"])) });
    expect(await runRules(["add", "/tmp/rule.json", "--quiet", "--json"], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject({
      ok: true,
      ignored: [{ guardrail: USER_RULE.id, key: "owasp" }],
    });
  });

  it("validate --json reports it on the failing path too, naming an id-less guardrail", async () => {
    const h = harness({
      [RULES]: JSON.stringify([
        withOwasp(["ASI06"]),
        { id: "local.bad", category: "x", defaultAction: "ask", match: {} },
        { category: "prod-infra", defaultAction: "warn", owasp: ["ASI06"], match: {} },
      ]),
    });
    expect(await runRules(["validate", "--json"], h.io)).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({
      ok: false,
      command: "validate",
      ignored: [
        { guardrail: USER_RULE.id, key: "owasp" },
        { guardrail: "(no id)", key: "owasp" },
      ],
    });
  });

  it("validate --quiet still prints the notes, as add --quiet does", async () => {
    const h = harness({
      [RULES]: JSON.stringify([withOwasp(["ASI06"]), USER_RULE_OWN_CATEGORY]),
    });
    expect(await runRules(["validate", "--quiet"], h.io)).toBe(0);
    expect(h.out()).toBe(`    NOTE ${USER_RULE.id}: ${OWASP_IGNORED_NOTE}\n`);

    const clean = harness({ [RULES]: JSON.stringify([USER_RULE]) });
    expect(await runRules(["validate", "--quiet"], clean.io)).toBe(0);
    expect(clean.out()).toBe("");
  });

  it("validate --json reports it in the same shape as add --json", async () => {
    const other = { ...USER_RULE, id: "local.second" };
    const h = harness({ [RULES]: JSON.stringify([withOwasp(["ASI06"]), other]) });
    expect(await runRules(["validate", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      ok: true,
      command: "validate",
      valid: 2,
      invalid: [],
      ignored: [{ guardrail: USER_RULE.id, key: "owasp" }],
    });

    const clean = harness({ [RULES]: JSON.stringify([USER_RULE]) });
    await runRules(["validate", "--json"], clean.io);
    expect(JSON.parse(clean.out())).not.toHaveProperty("ignored");
  });

  it("add says nothing about owasp when the key is absent", async () => {
    const h = harness({ "/tmp/rule.json": JSON.stringify(USER_RULE) });
    await runRules(["add", "/tmp/rule.json"], h.io);
    expect(h.out()).not.toContain(OWASP_IGNORED_NOTE);
  });

  it("validate on the installed file notes it per guardrail", async () => {
    const h = harness({
      [RULES]: JSON.stringify([withOwasp(["ASI06"]), USER_RULE_OWN_CATEGORY]),
    });
    expect(await runRules(["validate"], h.io)).toBe(0);
    expect(h.out()).toContain(`NOTE ${USER_RULE.id}: ${OWASP_IGNORED_NOTE}`);
    // Only the guardrail that carries `owasp` gets a note.
    expect(h.out().match(/^ {4}NOTE /gm)).toHaveLength(1);
    expect(h.out()).not.toContain(`NOTE ${USER_RULE_OWN_CATEGORY.id}`);
  });
});

describe("guardrails add: the AgentTrail OS line", () => {
  const STATE = `${DIR}/.product-line`;
  const NOW = new Date("2026-03-10T12:00:00.000Z");
  const LINE = productLineText({ surface: "add", guardrailId: USER_RULE.id }) as string;

  function tty(files: Record<string, string> = {}) {
    const h = harness({ "/tmp/r.json": JSON.stringify(USER_RULE), ...files });
    return { ...h, io: { ...h.io, isTTY: () => true } };
  }

  it("ends with one line naming both ways to share", async () => {
    const h = tty();
    expect(await runRules(["add", "/tmp/r.json"], h.io, { now: NOW })).toBe(0);
    const lines = h.out().trimEnd().split("\n");
    expect(lines.at(-2)).toContain("guardrails active.");
    expect(lines.at(-1)).toBe(LINE);
    expect(JSON.parse(h.raw(STATE) ?? "{}").add).toBe(NOW.toISOString());
  });

  it.each([
    ["--quiet", ["--quiet"], {}],
    ["--json", ["--json"], {}],
    ['"productLine": false', [], { [CONFIG]: '{"productLine": false}' }],
    ["shown in the last day", [], { [STATE]: JSON.stringify({ add: "2026-03-10T01:00:00.000Z" }) }],
  ])("%s: no line", async (_label, flags, files) => {
    const h = tty(files);
    await runRules(["add", "/tmp/r.json", ...flags], h.io, { now: NOW });
    expect(h.out()).not.toContain("AgentTrail OS");
  });

  it("not a terminal: no line, and nothing recorded", async () => {
    const h = harness({ "/tmp/r.json": JSON.stringify(USER_RULE) });
    await runRules(["add", "/tmp/r.json"], h.io, { now: NOW });
    expect(h.out()).not.toContain("AgentTrail OS");
    expect(h.raw(STATE)).toBeUndefined();
  });

  it("a rejected guardrail: no line", async () => {
    const h = tty({ "/tmp/r.json": "{}" });
    expect(await runRules(["add", "/tmp/r.json"], h.io, { now: NOW })).toBe(1);
    expect(h.out()).not.toContain("AgentTrail OS");
  });

  it("--config <dir> keeps the record beside that config.json", async () => {
    const h = tty();
    await runRules(["add", "/tmp/r.json", "--config", "/scratch"], h.io, { now: NOW });
    expect(h.raw("/scratch/.product-line")).toBeDefined();
    expect(h.raw(STATE)).toBeUndefined();
  });
});
