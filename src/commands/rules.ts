// cspell:words entr
/**
 * `agenttrail-guard guardrails …` — the pressure valve.
 *
 * ── What this command is for ────────────────────────────────────────────────
 * A guardrail that fires repeatedly on something legitimate needs a narrower remedy
 * than hand-editing JSON in a hidden directory or uninstalling. Everything here is in
 * service of `allow`, which silences one guardrail on one command shape.
 *
 * ── Two invariants that are easy to lose and expensive to lose ──────────────
 * 1. **`allow` suppresses one rule on one shape, never globally.** The allowlist is
 *    compiled with picomatch, so `!foo`, `*` and `**` each mute the named rule on
 *    everything while `guardrails list` keeps reporting it enabled. `core/allow-guard.ts`
 *    refuses those at write time, empirically.
 * 2. **Every command prints what changed, in one line, and a no-op says so.** Silent
 *    success is indistinguishable from a silent no-op.
 *
 * ── The argument scanner is hand-written, and that is not a preference ──────
 * `cli.ts`'s `parseArgs` mangles exactly the arguments this command takes. With its
 * current option set, `guardrails list --pack working-tree` yields
 * `values: {pack: true}` with `working-tree` fallen into the positionals, and
 * `guardrails allow x "-rf /"` loses the pattern entirely into `{r: true, f: true}`. Node's
 * `parseArgs` also cannot express "this positional is verbatim, whatever it looks
 * like", which is what `allow`'s pattern needs. So `cli.ts` dispatches `guardrails` BEFORE
 * its own parse — the precedent `hook` already sets there — and the scanning happens
 * here.
 *
 * ── `ask` in, `require_approval` on disk, `ask` on screen ───────────────────
 * One translation, at two boundaries, never inside a file. `require_approval` is the
 * vocabulary the engine and `@agenttrail/guardrails` share, and it is what the hook
 * reads; `ask` is what a person types and what Claude Code shows them. `--json` reports
 * the stored spelling, because its reader is a machine.
 */

import { isPack, MatchSchema, PACKS, parseRule } from "@agenttrail/guardrails";
import { checkAllowPattern, GLOB_NOTE, hasGlob } from "../core/allow-guard.js";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { parseConfig, updateConfigText } from "../core/config.js";
import { inspectConfig } from "../core/config-report.js";
import { compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { guardDir } from "../core/paths.js";
import { blockFixtureCommands } from "../core/rule-fixtures.js";
import {
  bannedConstructWarning,
  buildRuleViews,
  displayAction,
  packsOf,
  type RuleView,
} from "../core/rule-view.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardAction, GuardRule, MappedCall } from "../core/types.js";
import { loadUserRules } from "../core/user-rules.js";
import { parseUserRulesData } from "../core/user-rules-data.js";
import type { SetupIO } from "../setup-io.js";

// ── Arguments ───────────────────────────────────────────────────────────────

interface Flags {
  json: boolean;
  quiet: boolean;
  configDir: string | undefined;
  pack: string | undefined;
  enabled: boolean;
  disabled: boolean;
  all: boolean;
}

interface Scan {
  positionals: string[];
  flags: Flags;
  error: string | undefined;
}

const BOOLEAN_FLAGS = new Set(["--json", "--quiet", "--enabled", "--disabled", "--all"]);
const VALUE_FLAGS = new Set(["--config", "--pack"]);

/**
 * Scan the arguments after the subcommand.
 *
 * @param verbatimAt - a positional index that is taken exactly as written, even if it
 *   starts with `-`. `allow`'s pattern is the only one: a user silencing
 *   `git reset --hard` must be able to pass a pattern that looks like a flag, and the
 *   whole point of the command is that the line `status` printed can be pasted.
 */
function scan(args: readonly string[], verbatimAt?: number): Scan {
  const positionals: string[] = [];
  const flags: Flags = {
    json: false,
    quiet: false,
    configDir: undefined,
    pack: undefined,
    enabled: false,
    disabled: false,
    all: false,
  };
  let endOfFlags = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;

    if (!endOfFlags && token === "--") {
      endOfFlags = true;
      continue;
    }
    // The verbatim slot wins over flag parsing entirely.
    if (verbatimAt !== undefined && positionals.length === verbatimAt) {
      positionals.push(token);
      continue;
    }
    if (endOfFlags || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);

    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) return { positionals, flags, error: `\`${name}\` does not take a value.` };
      if (name === "--json") flags.json = true;
      else if (name === "--quiet") flags.quiet = true;
      else if (name === "--enabled") flags.enabled = true;
      else if (name === "--disabled") flags.disabled = true;
      else flags.all = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      let value: string | undefined;
      if (eq !== -1) {
        value = token.slice(eq + 1);
      } else {
        value = args[i + 1];
        i++;
      }
      if (value === undefined || value.length === 0) {
        return { positionals, flags, error: `\`${name}\` needs a value.` };
      }
      if (name === "--config") flags.configDir = value;
      else flags.pack = value;
      continue;
    }
    return {
      positionals,
      flags,
      error: `unknown flag \`${name}\`. Shared flags are --json, --quiet, --config <dir>; \`list\` also takes --pack <name>, --enabled, --disabled; \`reset\` takes --all.`,
    };
  }

  return { positionals, flags, error: undefined };
}

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * Collects output so a command's success line, its JSON form and `--quiet` are decided
 * in one place rather than at every `return`.
 *
 * `--quiet` suppresses the CONFIRMATION only. An error always prints: a quiet flag that
 * hides a refusal is how a user comes to believe a rule was silenced when it was not.
 * `--json` wins over `--quiet`, because a machine asking for structured output needs the
 * object.
 */
class Reporter {
  private readonly lines: string[] = [];
  constructor(
    private readonly io: SetupIO,
    private readonly flags: Flags,
    private readonly command: string,
  ) {}

  /** A line of human-facing output. Dropped by `--quiet` and by `--json`. */
  say(...text: string[]): void {
    this.lines.push(...text);
  }

  /** Finish a successful command. */
  ok(payload: Record<string, unknown> = {}): number {
    if (this.flags.json) {
      this.io.writeStdout(`${JSON.stringify({ ok: true, command: this.command, ...payload })}\n`);
      return 0;
    }
    if (!this.flags.quiet && this.lines.length > 0) {
      this.io.writeStdout(`${this.lines.join("\n")}\n`);
    }
    return 0;
  }

  /** Finish a failed command. Prints even under `--quiet`. */
  fail(reason: string, payload: Record<string, unknown> = {}): number {
    if (this.flags.json) {
      this.io.writeStdout(
        `${JSON.stringify({ ok: false, command: this.command, error: reason, ...payload })}\n`,
      );
      return 1;
    }
    this.io.writeStdout(`agenttrail-guard guardrails ${this.command}: ${reason}\n`);
    return 1;
  }
}

// ── Files ───────────────────────────────────────────────────────────────────

interface Files {
  readonly dir: string;
  readonly configPath: string;
  readonly rulesPath: string;
  readonly configText: string | undefined;
  readonly rulesText: string | undefined;
}

function readFiles(io: SetupIO, flags: Flags): Files {
  // `--config <path>` points at a config DIRECTORY, not a file:
  // both `config.json` and `guardrails.json` move together or the flag is useless for tests.
  const dir = flags.configDir ?? guardDir(io.homedir());
  const configPath = `${dir}/config.json`;
  const rulesPath = `${dir}/guardrails.json`;
  return {
    dir,
    configPath,
    rulesPath,
    configText: io.readFile(configPath),
    rulesText: io.readFile(rulesPath),
  };
}

/** Is this text parseable as a JSON object? Mutations refuse otherwise. */
function configIsReadable(text: string | undefined): boolean {
  if (text === undefined) return true;
  try {
    const raw: unknown = JSON.parse(text);
    return raw !== null && typeof raw === "object" && !Array.isArray(raw);
  } catch {
    return false;
  }
}

/** Whether `config.json` text carries a top-level `key`, read raw rather than parsed. */
function hasKey(text: string | undefined, key: string): boolean {
  if (text === undefined) return false;
  try {
    const raw: unknown = JSON.parse(text);
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) && key in raw;
  } catch {
    return false;
  }
}

/**
 * Refuse to mutate a `config.json` we could not read.
 *
 * `parseConfig` is fail-open and would hand back defaults, so writing on top of that
 * would silently DELETE whatever the user had. Refusing names the parse error and the
 * path instead. Read-only commands are unaffected and still work off the defaults.
 */
function unreadableConfig(files: Files): string {
  return `could not read ${files.configPath} — it is not valid JSON, and writing over it would discard whatever it holds. Fix or delete the file, then try again.`;
}

// ── Catalog + views ─────────────────────────────────────────────────────────

export interface RulesDeps {
  /** The rule catalog. `@agenttrail/guardrails` arrives through here. */
  readonly catalog?: readonly GuardRule[];
}

function viewsFor(files: Files, deps: RulesDeps): { views: RuleView[]; invalidCount: number } {
  const config = parseConfig(files.configText);
  const user = loadUserRules(files.rulesText);
  return {
    views: buildRuleViews(deps.catalog ?? SHIPPED_CATALOG, user.valid, config),
    invalidCount: user.invalid.length,
  };
}

/**
 * Every pack id a `disabledPacks` entry can name: the library's packs plus the categories of
 * the user's own guardrails AS THE HOOK LOADS THEM. That is `parseUserRulesData`, not the
 * stricter `loadUserRules`, so a guardrail the hook runs but the validator would not pass
 * still counts — otherwise `list` would call a real category unknown, and `enable` and
 * `reset --all` could not undo a disable the hook is honouring.
 */
function knownPacksFor(files: Files, deps: RulesDeps): string[] {
  const rules = [...(deps.catalog ?? SHIPPED_CATALOG), ...parseUserRulesData(files.rulesText)];
  return [...new Set(rules.map((r) => r.category))];
}

function findView(views: readonly RuleView[], id: string): RuleView | undefined {
  return views.find((v) => v.rule.id === id);
}

/** The closest rule id by a cheap edit distance, for a mistyped one. */
function suggest(views: readonly RuleView[], id: string): string | undefined {
  const distance = (a: string, b: string): number => {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let last = prev[0] as number;
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j] as number;
        prev[j] = Math.min(
          (prev[j] as number) + 1,
          (prev[j - 1] as number) + 1,
          last + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        last = tmp;
      }
    }
    return prev[b.length] as number;
  };
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const v of views) {
    const d = distance(id, v.rule.id);
    if (d < bestScore) {
      bestScore = d;
      best = v.rule.id;
    }
  }
  // A suggestion that is not close is worse than none — it reads as a wrong answer.
  return best !== undefined && bestScore <= Math.max(2, Math.floor(id.length / 3))
    ? best
    : undefined;
}

function unknownRule(views: readonly RuleView[], id: string): string {
  const near = suggest(views, id);
  return `no guardrail with id \`${id}\`.${near !== undefined ? ` Did you mean \`${near}\`?` : ""} Run \`agenttrail-guard guardrails list\` to see them all.`;
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * Parse the action a user typed.
 *
 * `ask` is the documented verb. `require_approval` is accepted too, and that is NOT the
 * same concession `config.json` declines: that file refuses two spellings in one FILE,
 * where two readers could reach different verdicts. A command-line argument has one reader and
 * produces one canonical byte sequence on disk, so no verdict can diverge — and a user
 * who has read `config.json` will type what they saw there.
 */
function parseActionArg(word: string): GuardAction | undefined {
  if (word === "block" || word === "warn") return word;
  if (word === "ask" || word === "require_approval") return "require_approval";
  return undefined;
}

// ── The subcommands ─────────────────────────────────────────────────────────

const USAGE = `agenttrail-guard guardrails — see and change what the guard enforces

  guardrails list [--pack <name>] [--enabled|--disabled]   what is on, and what is not
  guardrails show <guardrail-id>                           everything about one guardrail
  guardrails enable|disable <guardrail-id|pack>            turn a guardrail or a whole pack on/off
  guardrails set-action <guardrail-id> block|ask|warn      change what a guardrail does
  guardrails add <file.json>                               install a guardrail you wrote
  guardrails remove <guardrail-id>                         delete one of your own guardrails
  guardrails allow <guardrail-id> <pattern>                silence ONE guardrail on ONE shape
  guardrails reset [<guardrail-id>|--all]                  undo your changes
  guardrails validate [<file>]                             the same check CI runs

Shared flags: --json  --quiet  --config <dir>
`;

function cmdList(io: SetupIO, flags: Flags, files: Files, deps: RulesDeps): number {
  const r = new Reporter(io, flags, "list");
  const { views, invalidCount } = viewsFor(files, deps);

  let shown = views;
  if (flags.pack !== undefined) {
    shown = shown.filter((v) => v.rule.category === flags.pack);
    if (shown.length === 0) {
      return r.fail(
        `no pack named \`${flags.pack}\`. Packs: ${[...new Set(views.map((v) => v.rule.category))].join(", ")}.`,
      );
    }
  }
  // `--enabled` and `--disabled` partition; both together is the same as neither, and
  // saying so is better than silently returning nothing.
  if (flags.enabled && !flags.disabled) shown = shown.filter((v) => v.enabled);
  if (flags.disabled && !flags.enabled) shown = shown.filter((v) => !v.enabled);

  if (flags.json) {
    return r.ok({
      guardrails: shown.map((v) => ({
        id: v.rule.id,
        pack: v.rule.category,
        // Stored spelling: the reader here is a machine.
        action: v.action,
        shippedAction: v.shippedAction,
        source: v.source,
        enabled: v.enabled,
        disabledBy: v.disabledBy ?? null,
        allowlist: v.allowlist.map((a) => a.pattern),
        warning: v.warning ?? null,
      })),
    });
  }

  const byPack = new Map<string, RuleView[]>();
  for (const v of shown) {
    const list = byPack.get(v.rule.category) ?? [];
    list.push(v);
    byPack.set(v.rule.category, list);
  }

  for (const [pack, list] of byPack) {
    const on = list.filter((v) => v.enabled).length;
    r.say(
      "",
      `  ${pack.padEnd(28)} ${list.length} guardrail${list.length === 1 ? "" : "s"} · ${
        on === 0 ? "disabled" : on === list.length ? "enabled" : `${on} of ${list.length} enabled`
      }`,
    );
    for (const v of list) {
      const notes: string[] = [];
      if (!v.enabled) notes.push(v.disabledBy === "pack" ? "pack disabled" : "disabled");
      if (v.overridden) notes.push(`was ${displayAction(v.shippedAction)}`);
      if (v.allowlist.length > 0) {
        notes.push(`${v.allowlist.length} allowlist entr${v.allowlist.length === 1 ? "y" : "ies"}`);
      }
      if (v.source === "yours") notes.push("yours");
      r.say(
        `    ${v.rule.id.padEnd(26)} ${displayAction(v.action).padEnd(7)} ${v.rule.title}${
          notes.length > 0 ? `   (${notes.join(", ")})` : ""
        }`,
      );
      // Printed under the rule rather than collected at the bottom: a warning far from
      // the thing it is about gets read as a general disclaimer.
      if (v.warning !== undefined) r.say(`      WARNING: ${v.rule.id} ${v.warning}`);
    }
  }

  const enabled = views.filter((v) => v.enabled).length;
  const packCount = new Set(views.map((v) => v.rule.category)).size;
  r.say(
    "",
    `  ${views.length} guardrails across ${packCount} pack${packCount === 1 ? "" : "s"} · ${enabled} enabled · ${views.length - enabled} disabled`,
  );
  if (invalidCount > 0) {
    r.say(
      `  ${invalidCount} of your own guardrails ${invalidCount === 1 ? "is" : "are"} invalid and NOT running — run \`agenttrail-guard status\` for the reasons.`,
    );
  }
  for (const p of inspectConfig(files.configText, knownPacksFor(files, deps)).problems) {
    r.say(`  PROBLEM in config.json — ${p.where}: ${p.reason}`);
  }
  return r.ok();
}

function cmdShow(io: SetupIO, flags: Flags, files: Files, deps: RulesDeps, id: string): number {
  const r = new Reporter(io, flags, "show");
  const { views } = viewsFor(files, deps);
  const v = findView(views, id);
  if (v === undefined) return r.fail(unknownRule(views, id));

  if (flags.json) {
    return r.ok({
      id: v.rule.id,
      pack: v.rule.category,
      severity: v.rule.severity,
      action: v.action,
      shippedAction: v.shippedAction,
      source: v.source,
      enabled: v.enabled,
      disabledBy: v.disabledBy ?? null,
      title: v.rule.title,
      description: v.rule.description,
      allowlist: v.allowlist.map((a) => a.pattern),
      warning: v.warning ?? null,
      match: v.rule.match,
    });
  }

  r.say(
    "",
    `  ${v.rule.id.padEnd(36)} ${v.rule.category} · severity: ${v.rule.severity}${v.source === "yours" ? " · your guardrail" : ""}`,
    `  ${v.rule.title}`,
    "",
    `  Action        ${displayAction(v.action).padEnd(7)} ${
      v.overridden
        ? `(shipped default: ${displayAction(v.shippedAction)} — \`guardrails reset ${v.rule.id}\` restores it)`
        : "(shipped default)"
    }`,
    `  Enforcing     ${
      v.enabled
        ? "yes"
        : v.disabledBy === "pack"
          ? `no — its pack is off (\`guardrails enable ${v.rule.category}\`)`
          : `no — turned off (\`guardrails enable ${v.rule.id}\`)`
    }`,
  );
  if (v.allowlist.length > 0) {
    r.say("  Allowlist");
    // No timestamp: `AllowlistEntry` is `{guardrail, pattern}` and `parseConfig`
    // reconstructs exactly those two keys, so an "added" date would be destroyed on the
    // next read.
    for (const a of v.allowlist) r.say(`    ${a.pattern}`);
  }
  r.say("", `  ${v.rule.description}`);
  if (v.warning !== undefined) r.say("", `  WARNING: this guardrail ${v.warning}`);
  return r.ok();
}

function cmdEnableDisable(
  io: SetupIO,
  flags: Flags,
  files: Files,
  deps: RulesDeps,
  target: string,
  enable: boolean,
): number {
  const command = enable ? "enable" : "disable";
  const r = new Reporter(io, flags, command);
  if (!configIsReadable(files.configText)) return r.fail(unreadableConfig(files));

  const { views } = viewsFor(files, deps);
  const config = parseConfig(files.configText);
  const rule = findView(views, target);
  const packRules = views.filter((v) => v.rule.category === target);
  // A pack is anything the hook would switch off by that name — and, for `enable`, anything
  // already in `disabledPacks`, so a disable can always be undone by the same word.
  const isPackTarget =
    packRules.length > 0 ||
    knownPacksFor(files, deps).includes(target) ||
    (enable && config.disabledPacks.includes(target));

  if (rule === undefined && !isPackTarget) {
    return r.fail(
      `no guardrail or pack named \`${target}\`.${
        suggest(views, target) !== undefined ? ` Did you mean \`${suggest(views, target)}\`?` : ""
      } Run \`agenttrail-guard guardrails list\` to see them all.`,
    );
  }

  // A rule id wins over a pack id. They cannot collide today (pack ids are bare words,
  // rule ids are dotted), but resolving ambiguously would be worse than resolving
  // arbitrarily and saying which.
  if (rule !== undefined) {
    const disabled = new Set(config.disabledGuardrails);
    // Computed from the pack list directly, NOT from `view.disabledBy`. A rule that is
    // off by id AND by pack reports `disabledBy: "rule"` (the more specific reason), so
    // reading the view would miss the pack half — which is precisely the case where
    // `guardrails enable <id>` succeeds and the rule still does not fire. Reporting success
    // there is the silent failure this whole surface exists to remove.
    const packOff = config.disabledPacks.includes(rule.rule.category);
    if (enable ? !disabled.has(target) : disabled.has(target)) {
      // A no-op is stated. Silent success and silent no-op are indistinguishable.
      r.say(
        `${target} was already ${enable ? "enabled" : "disabled"}. Nothing changed.${
          enable && packOff
            ? ` It is still not enforcing, because its pack \`${rule.rule.category}\` is off — run \`agenttrail-guard guardrails enable ${rule.rule.category}\`.`
            : ""
        }`,
      );
      return r.ok({ changed: false, guardrail: target });
    }
    if (enable) disabled.delete(target);
    else disabled.add(target);
    const next = [...disabled];
    io.writeFileAtomic(
      files.configPath,
      updateConfigText(files.configText, (d) => {
        d.disabledGuardrails = next;
      }),
    );
    const stillOff = enable && packOff;
    r.say(
      enable
        ? `Enabled ${target}. Action: ${displayAction(rule.action)}.${
            stillOff ? ` It is still not enforcing: its pack \`${rule.rule.category}\` is off.` : ""
          }`
        : `Disabled ${target}. ${views.filter((v) => v.enabled).length - 1} guardrails still active.`,
    );
    return r.ok({ changed: true, guardrail: target, enabled: enable });
  }

  // A pack. `disabledPacks` is the only pack switch: every pack not named there is on.
  const off = new Set(config.disabledPacks);
  if (enable ? !off.has(target) : off.has(target)) {
    r.say(`Pack ${target} was already ${enable ? "enabled" : "disabled"}. Nothing changed.`);
    return r.ok({ changed: false, pack: target });
  }
  if (enable) off.delete(target);
  else off.add(target);
  const next = [...off];
  io.writeFileAtomic(
    files.configPath,
    updateConfigText(files.configText, (d) => {
      d.disabledPacks = next;
    }),
  );
  const affected = packRules.length;
  // Guardrails turned off one at a time stay off whichever way the pack moves, so they
  // are not counted as switching.
  const ruleOff = new Set(config.disabledGuardrails);
  const switching = packRules.filter((v) => !ruleOff.has(v.rule.id)).length;
  const active = views.filter((v) => v.enabled).length;
  r.say(
    enable
      ? `Enabled pack ${target} (${affected} guardrail${affected === 1 ? "" : "s"}). ${active + switching} guardrails active.`
      : `Disabled pack ${target} (${affected} guardrail${affected === 1 ? "" : "s"}). ${active - switching} guardrails still active.`,
  );
  // Allowed, because a list of what is OFF has no empty-list trap — but worth saying: with
  // every library pack off, the guard checks only the user's own guardrails, if any.
  const libraryPacks = packsOf(views.filter((v) => v.source === "library"));
  const allLibraryPacksOff =
    !enable && libraryPacks.length > 0 && libraryPacks.every((p) => off.has(p));
  if (allLibraryPacksOff) {
    const way =
      "Turn one back on with `agenttrail-guard guardrails enable <pack>`, or all of them with `agenttrail-guard guardrails reset --all`.";
    r.say(
      parseUserRulesData(files.rulesText).length > 0
        ? `No library pack is on now — only your own guardrails are enforcing. ${way}`
        : `No library pack is on now, and you have no guardrails of your own — the guard is checking nothing. ${way}`,
    );
  }
  return r.ok({ changed: true, pack: target, enabled: enable, allLibraryPacksOff });
}

function cmdSetAction(
  io: SetupIO,
  flags: Flags,
  files: Files,
  deps: RulesDeps,
  id: string,
  word: string,
): number {
  const r = new Reporter(io, flags, "set-action");
  if (!configIsReadable(files.configText)) return r.fail(unreadableConfig(files));

  const action = parseActionArg(word);
  if (action === undefined) {
    return r.fail(`\`${word}\` is not an action. Use block, ask, or warn.`);
  }
  const { views } = viewsFor(files, deps);
  const v = findView(views, id);
  if (v === undefined) return r.fail(unknownRule(views, id));

  if (v.action === action) {
    r.say(`${id} is already ${displayAction(action)}. Nothing changed.`);
    return r.ok({ changed: false, guardrail: id, action });
  }

  const before = v.action;
  io.writeFileAtomic(
    files.configPath,
    updateConfigText(files.configText, (d) => {
      const overrides = { ...((d.guardrailActionOverrides as Record<string, unknown>) ?? {}) };
      if (action === v.shippedAction) delete overrides[id];
      else overrides[id] = action;
      d.guardrailActionOverrides = overrides;
    }),
  );

  r.say(
    `${id}: ${displayAction(before)} → ${displayAction(action)}. ${
      action === "require_approval"
        ? "You will be prompted instead of blocked."
        : action === "warn"
          ? "It will be recorded and allowed."
          : "It will be blocked."
    }`,
  );
  if (action !== v.shippedAction) {
    r.say(
      `Shipped default was ${displayAction(v.shippedAction)}; run \`agenttrail-guard guardrails reset ${id}\` to restore it.`,
    );
  }
  return r.ok({ changed: true, guardrail: id, action });
}

function cmdAllow(
  io: SetupIO,
  flags: Flags,
  files: Files,
  deps: RulesDeps,
  id: string,
  pattern: string,
): number {
  const r = new Reporter(io, flags, "allow");
  if (!configIsReadable(files.configText)) return r.fail(unreadableConfig(files));

  const { views } = viewsFor(files, deps);
  const v = findView(views, id);
  if (v === undefined) {
    // An allowlist entry naming no rule is dead weight `isAllowlisted` skips forever.
    return r.fail(unknownRule(views, id));
  }

  // Pass the rule's own block fixtures so a pattern that would blind the guardrail to a
  // command it exists to stop is refused. A user rule has none, so this is `[]` there.
  const refusal = checkAllowPattern(pattern, blockFixtureCommands(id));
  if (refusal !== undefined) {
    return r.fail(`refusing that pattern — ${refusal.reason}`, { kind: refusal.kind });
  }

  const config = parseConfig(files.configText);
  if (config.allowlist.some((a) => a.guardrail === id && a.pattern === pattern)) {
    r.say(`${id} is already allowlisted for that pattern. Nothing changed.`);
    return r.ok({ changed: false, guardrail: id, pattern });
  }

  io.writeFileAtomic(
    files.configPath,
    updateConfigText(files.configText, (d) => {
      const list = Array.isArray(d.allowlist) ? [...(d.allowlist as unknown[])] : [];
      list.push({ guardrail: id, pattern });
      d.allowlist = list;
    }),
  );

  const others = views.filter((x) => x.enabled).length - 1;
  r.say(
    `Allowlisted. ${id} no longer matches "${pattern}".`,
    `The guardrail still ${displayAction(v.action) === "block" ? "blocks" : "fires on"} everything else, and the other ${others} guardrails are unchanged.`,
  );
  if (hasGlob(pattern)) r.say(GLOB_NOTE);
  return r.ok({ changed: true, guardrail: id, pattern });
}

function cmdReset(
  io: SetupIO,
  flags: Flags,
  files: Files,
  deps: RulesDeps,
  id: string | undefined,
): number {
  const r = new Reporter(io, flags, "reset");
  if (!configIsReadable(files.configText)) return r.fail(unreadableConfig(files));
  if (id === undefined && !flags.all) {
    return r.fail("name a guardrail to reset, or pass --all.");
  }
  const config = parseConfig(files.configText);

  if (flags.all) {
    const overrides = Object.keys(config.guardrailActionOverrides).length;
    const allow = config.allowlist.length;
    const off = config.disabledGuardrails.length;
    // Every `disabledPacks` entry is cleared, whatever it names. Only the ones that exist — a
    // library pack or a category of the user's own guardrails — are counted as a pack coming
    // back; a misspelled entry disabled nothing, so clearing it restores nothing.
    const disabledPacks = new Set(config.disabledPacks);
    const known = new Set(knownPacksFor(files, deps));
    const packsRestored = [...disabledPacks].filter((p) => known.has(p)).length;
    // A key older releases wrote. It is not read, but `status` keeps reporting it until it
    // goes, and "reset everything" should leave nothing to report.
    const staleKey = hasKey(files.configText, "enabledPacks");
    if (overrides + allow + off + disabledPacks.size === 0 && !staleKey) {
      r.say(
        "Nothing to reset — no action overrides, no allowlist entries, no disabled guardrails, and every pack is on.",
      );
      return r.ok({ changed: false });
    }
    io.writeFileAtomic(
      files.configPath,
      updateConfigText(files.configText, (d) => {
        d.guardrailActionOverrides = {};
        d.allowlist = [];
        d.disabledGuardrails = [];
        d.disabledPacks = [];
        delete d.enabledPacks;
      }),
    );
    // Pack changes are stated on their OWN line, separate from the override/allowlist reset,
    // so re-enabling protection is not buried in a housekeeping sentence.
    r.say(
      `Reset ${overrides} action override${overrides === 1 ? "" : "s"}, ${allow} allowlist entr${allow === 1 ? "y" : "ies"}, and ${off} disabled guardrail${off === 1 ? "" : "s"}.`,
    );
    if (packsRestored > 0) {
      r.say(
        `Re-enabled ${packsRestored} pack${packsRestored === 1 ? "" : "s"} — every pack is now on.`,
      );
    }
    if (staleKey) {
      r.say("Removed `enabledPacks`, which older releases wrote and this one does not read.");
    }
    r.say(
      "Your own guardrails in guardrails.json were NOT touched — remove those with `guardrails remove`.",
    );
    return r.ok({ changed: true });
  }

  const target = id as string;
  const { views } = viewsFor(files, deps);
  const v = findView(views, target);
  if (v === undefined) return r.fail(unknownRule(views, target));

  const hadOverride = config.guardrailActionOverrides[target] !== undefined;
  const hadAllow = config.allowlist.filter((a) => a.guardrail === target).length;
  const wasOff = config.disabledGuardrails.includes(target);
  if (!hadOverride && hadAllow === 0 && !wasOff) {
    r.say(`${target} has no changes to reset. Nothing changed.`);
    return r.ok({ changed: false, guardrail: target });
  }

  io.writeFileAtomic(
    files.configPath,
    updateConfigText(files.configText, (d) => {
      const overrides = { ...((d.guardrailActionOverrides as Record<string, unknown>) ?? {}) };
      delete overrides[target];
      d.guardrailActionOverrides = overrides;
      d.allowlist = (Array.isArray(d.allowlist) ? (d.allowlist as unknown[]) : []).filter(
        (e) =>
          !(
            e !== null &&
            typeof e === "object" &&
            (e as Record<string, unknown>).guardrail === target
          ),
      );
      d.disabledGuardrails = (
        Array.isArray(d.disabledGuardrails) ? (d.disabledGuardrails as unknown[]) : []
      ).filter((x) => x !== target);
    }),
  );
  r.say(
    `${target} restored to its shipped default: ${displayAction(v.shippedAction)}.${
      hadAllow > 0 ? ` Removed ${hadAllow} allowlist entr${hadAllow === 1 ? "y" : "ies"}.` : ""
    }${wasOff ? " Re-enabled it." : ""}`,
  );
  return r.ok({ changed: true, guardrail: target });
}

export async function runRules(
  argv: readonly string[],
  io: SetupIO,
  deps: RulesDeps = {},
): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.writeStdout(USAGE);
    return sub === undefined ? 1 : 0;
  }

  const { positionals, flags, error } = scan(argv.slice(1), sub === "allow" ? 1 : undefined);
  if (error !== undefined) {
    io.writeStdout(`agenttrail-guard guardrails ${sub}: ${error}\n`);
    return 1;
  }
  const files = readFiles(io, flags);
  const need = (n: number, usage: string): boolean => {
    if (positionals.length >= n) return true;
    io.writeStdout(`agenttrail-guard guardrails ${sub}: usage — ${usage}\n`);
    return false;
  };

  try {
    switch (sub) {
      case "list":
        return cmdList(io, flags, files, deps);
      case "show":
        return need(1, "guardrails show <guardrail-id>")
          ? cmdShow(io, flags, files, deps, positionals[0] as string)
          : 1;
      case "enable":
      case "disable":
        return need(1, `guardrails ${sub} <guardrail-id|pack>`)
          ? cmdEnableDisable(io, flags, files, deps, positionals[0] as string, sub === "enable")
          : 1;
      case "set-action":
        return need(2, "guardrails set-action <guardrail-id> block|ask|warn")
          ? cmdSetAction(io, flags, files, deps, positionals[0] as string, positionals[1] as string)
          : 1;
      case "allow":
        return need(2, 'guardrails allow <guardrail-id> "<pattern>"')
          ? cmdAllow(io, flags, files, deps, positionals[0] as string, positionals[1] as string)
          : 1;
      case "reset":
        return cmdReset(io, flags, files, deps, positionals[0]);
      case "add":
        return need(1, "guardrails add <file.json>")
          ? cmdAdd(io, flags, files, deps, positionals[0] as string)
          : 1;
      case "remove":
        return need(1, "guardrails remove <guardrail-id>")
          ? cmdRemove(io, flags, files, deps, positionals[0] as string)
          : 1;
      case "validate":
        return cmdValidate(io, flags, files, deps, positionals[0]);
      default:
        io.writeStdout(`agenttrail-guard guardrails: unknown subcommand "${sub}".\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    // `runCli`'s contract is that a command never throws. A failed write is the likely
    // cause and the user needs the path, not a stack.
    io.writeStdout(
      `agenttrail-guard guardrails ${sub}: ${(err as Error).message}\n  (nothing was changed)\n`,
    );
    return 1;
  }
}

// ── add / remove / validate ─────────────────────────────────────────────────
// Split out below because they are the file-format half of the surface: `add` and
// `validate` do NOT validate the same thing.

/**
 * Validate a rule destined for the user's own `guardrails.json`.
 *
 * STRICTER than the hook, never looser — that direction is the whole point. Anything
 * `add` accepts must be something the hook will load, or "Added." is followed by silent
 * non-enforcement. Being stricter is safe; being looser is the failure.
 *
 * The strictness beyond `loadUserRules` comes from `@agenttrail/guardrails`'
 * `MatchSchema`, which is `.strict()` and therefore rejects `numeric` and `scope`,
 * two constructs `parsePolicyPredicate` still permits. Both would install cleanly and
 * then never behave as written, which is the class of bug this command surface exists
 * to remove.
 *
 * The ENVELOPE stays `loadUserRules`', not `guardrails`' `RuleSchema`: a personal rule
 * is not a library rule, and `fixtures`, `title` and `description` are more than a rule
 * written for one machine needs.
 */
function validateUserRule(raw: unknown): { rule?: GuardRule; errors: string[] } {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: ["expected a JSON object describing one guardrail."] };
  }
  const rec = raw as Record<string, unknown>;

  const id = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : undefined;
  if (id === undefined)
    errors.push("`id` must be a non-empty string — it is how you refer to the guardrail later.");

  const action = rec.defaultAction;
  if (typeof action !== "string" || !["block", "require_approval", "warn"].includes(action)) {
    errors.push(
      action === "ask"
        ? "`defaultAction` is `ask`, but the stored spelling is `require_approval` — `ask` is what you type at the CLI and what Claude Code shows, not what goes in the file."
        : "`defaultAction` must be one of block, require_approval, warn.",
    );
  }

  if (typeof rec.category !== "string" || rec.category.length === 0) {
    errors.push(
      `\`category\` is required and must be one of the ${PACKS.length} packs (${PACKS.join(", ")}) — it names the pack the guardrail belongs to, so \`guardrails disable <pack>\` turns it off with the rest of that pack, and the hook does not load a guardrail without one.`,
    );
  } else if (!isPack(rec.category)) {
    errors.push(
      `\`category\` is \`${rec.category}\`, which is not a pack. Use one of: ${PACKS.join(", ")}.`,
    );
  }

  const match = MatchSchema.safeParse(rec.match);
  if (!match.success) {
    // A banned construct gets its MECHANISM, not the schema's "unrecognized key". Told
    // only that `numeric` is not allowed, a person assumes a schema nicety; told that
    // `lt` is always true before the tool runs, they understand the rule would have
    // frozen every command. Same sentence `guardrails list` uses on an already-installed one.
    const banned = bannedConstructWarning(rec.match);
    if (banned !== undefined) {
      errors.push(`this guardrail ${banned}`);
    } else {
      const issue = match.error.issues[0];
      const where = issue?.path.length ? ` at match.${issue.path.join(".")}` : "";
      errors.push(`${issue?.message ?? "invalid `match`"}${where}`);
    }
  } else {
    // A rule whose every positive condition has no narrowing matcher parses cleanly and
    // then matches EVERY tool call of that kind — at `block`, every command the user
    // runs. It is legal, so the hook's structural loader still admits it and `rules
    // list` only warns; refusing it THERE would break `strict ⊆ structural` in the
    // dangerous direction, letting `add` write a rule the hook silently drops.
    //
    // Refusing it HERE is free of that cost: the strict validator getting smaller
    // preserves the invariant, and it stops the footgun where it is actually made.
    // Nobody types this on purpose — a hand-edited file still gets the warning.
    const broad = bannedConstructWarning(rec.match);
    if (broad !== undefined) errors.push(`this guardrail ${broad}`);
  }

  if (errors.length > 0 || id === undefined || !match.success) return { errors };
  return {
    rule: {
      id,
      category: rec.category as string,
      severity: typeof rec.severity === "string" ? rec.severity : "medium",
      defaultAction: action as GuardAction,
      title: typeof rec.title === "string" ? rec.title : id,
      description: typeof rec.description === "string" ? rec.description : "",
      match: match.data,
    },
    errors: [],
  };
}

/** A valid personal guardrail, printed when `add` rejects a common mistaken form. */
const CORRECTED_EXAMPLE = `  {
    "id": "local.no-deploy-friday",
    "category": "prod-infra",
    "severity": "medium",
    "defaultAction": "require_approval",
    "title": "Confirm before deploying",
    "match": { "any_of": [
      { "kind": "execute_tool", "label": "Bash", "detail_contains": ["./deploy.sh"] }
    ]}
  }`;

function cmdAdd(io: SetupIO, flags: Flags, files: Files, deps: RulesDeps, path: string): number {
  const r = new Reporter(io, flags, "add");
  const text = io.readFile(path);
  if (text === undefined) return r.fail(`could not read ${path}.`);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return r.fail(`${path} is not valid JSON: ${(error as Error).message}. Nothing was written.`);
  }
  // A file holding a one-element array is what someone copying `guardrails.json` produces.
  const candidate = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;

  const { rule, errors } = validateUserRule(candidate);
  if (rule === undefined) {
    if (flags.json) return r.fail("rejected", { errors });
    io.writeStdout(
      `Rejected — not added. Nothing was written.\n${errors.map((e) => `    ${e}`).join("\n")}\n\nA valid guardrail looks like this:\n\n${CORRECTED_EXAMPLE}\n`,
    );
    return 1;
  }

  // `guardrails.json` must be readable before appending — writing over an unparseable file
  // would discard whatever the user had in it.
  let existing: unknown[] = [];
  if (files.rulesText !== undefined && files.rulesText.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(files.rulesText);
      if (!Array.isArray(parsed)) throw new TypeError("expected a JSON array of guardrails");
      existing = parsed;
    } catch (error) {
      return r.fail(
        `could not read ${files.rulesPath} (${(error as Error).message}), and appending would discard it. Fix or delete that file first. Nothing was written.`,
      );
    }
  }

  const { views } = viewsFor(files, deps);
  if (findView(views, rule.id) !== undefined) {
    return r.fail(
      `a guardrail with id \`${rule.id}\` already exists. Silently replacing it would be worse than refusing — remove it first (\`guardrails remove ${rule.id}\`) or change the id.`,
    );
  }

  io.writeFileAtomic(files.rulesPath, `${JSON.stringify([...existing, candidate], null, 2)}\n`);
  const active = views.filter((v) => v.enabled).length + 1;
  r.say(
    `Validated. Added ${rule.id} (${displayAction(rule.defaultAction)}) to ${files.rulesPath}.`,
    `${active} guardrails active.`,
  );
  return r.ok({ changed: true, guardrail: rule.id });
}

function cmdRemove(io: SetupIO, flags: Flags, files: Files, deps: RulesDeps, id: string): number {
  const r = new Reporter(io, flags, "remove");
  const { views } = viewsFor(files, deps);
  const v = findView(views, id);

  if (v !== undefined && v.source === "library") {
    // Shipped guardrails are disabled, not removed.
    return r.fail(
      `${id} is one of ours, so it cannot be removed — it would come back on the next update. Turn it off instead: \`agenttrail-guard guardrails disable ${id}\`.`,
    );
  }

  let existing: unknown[] = [];
  if (files.rulesText !== undefined && files.rulesText.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(files.rulesText);
      if (!Array.isArray(parsed)) throw new TypeError("expected a JSON array of guardrails");
      existing = parsed;
    } catch (error) {
      return r.fail(`could not read ${files.rulesPath}: ${(error as Error).message}.`);
    }
  }
  const kept = existing.filter(
    (e) => !(e !== null && typeof e === "object" && (e as Record<string, unknown>).id === id),
  );
  if (kept.length === existing.length) {
    return r.fail(
      `no guardrail of yours with id \`${id}\` in ${files.rulesPath}. Nothing changed.${
        v !== undefined ? "" : ` Run \`agenttrail-guard guardrails list\` to see what is there.`
      }`,
    );
  }

  io.writeFileAtomic(files.rulesPath, `${JSON.stringify(kept, null, 2)}\n`);
  r.say(`Removed ${id}. ${views.filter((x) => x.enabled).length - 1} guardrails active.`);
  return r.ok({ changed: true, guardrail: id });
}

/** Run one fixture through the guard's own evaluator. Returns whether the rule matched. */
function fixtureMatches(rule: GuardRule, fixture: { tool: string; text: string; file: boolean }) {
  const mapped: MappedCall = {
    tool: fixture.tool,
    args: fixture.file ? { file_path: fixture.text } : { full_command: fixture.text },
  };
  const decision = evaluateCall(
    compileCatalog([rule]),
    buildGuardSpanContext(mapped),
    mapped,
    compileAllowlist([]),
  );
  return decision.matches.length > 0;
}

function cmdValidate(
  io: SetupIO,
  flags: Flags,
  files: Files,
  _deps: RulesDeps,
  path: string | undefined,
): number {
  const r = new Reporter(io, flags, "validate");

  // No file: validate what is installed. That is the "did my edit break anything?"
  // question, and it is the one a user asks most often.
  if (path === undefined) {
    const user = loadUserRules(files.rulesText);
    if (flags.json) {
      return user.invalid.length === 0
        ? r.ok({ valid: user.valid.length, invalid: [] })
        : r.fail("invalid guardrails", { invalid: user.invalid });
    }
    if (user.invalid.length === 0) {
      r.say(`Valid. ${user.valid.length} of your own guardrails in ${files.rulesPath}.`);
      return r.ok({ valid: user.valid.length });
    }
    io.writeStdout(
      `${user.invalid.length} of your guardrails ${user.invalid.length === 1 ? "is" : "are"} invalid and NOT running:\n${user.invalid
        .map((b) => `    ${b.id}: ${b.reason}`)
        .join("\n")}\n`,
    );
    return 1;
  }

  const text = io.readFile(path);
  if (text === undefined) return r.fail(`could not read ${path}.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return r.fail(`${path} is not valid JSON: ${(error as Error).message}`);
  }

  // A FILE argument is the contributor's question — "would CI accept this rule?" — so
  // it is checked against `@agenttrail/guardrails`' `parseRule`, which is literally the
  // function `defineRule` calls at module load and therefore the one CI runs.
  const parsed = parseRule(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `    ${i.message}${i.path.length ? ` at ${i.path.join(".")}` : ""}`);
    if (flags.json) return r.fail("invalid", { issues: parsed.error.issues });
    io.writeStdout(`Invalid — this is the same check CI runs.\n${issues.join("\n")}\n`);
    return 1;
  }

  const rule = parsed.data;
  const guardRule: GuardRule = {
    id: rule.id,
    category: rule.category,
    severity: rule.severity,
    defaultAction: rule.defaultAction,
    title: rule.title,
    description: rule.description,
    match: rule.match,
  };

  const rows: { direction: "block" | "allow"; text: string; pass: boolean }[] = [];
  for (const f of rule.fixtures.block) {
    const fixture =
      "command" in f
        ? { tool: f.tool, text: f.command, file: false }
        : { tool: f.tool, text: f.file_path, file: true };
    rows.push({ direction: "block", text: fixture.text, pass: fixtureMatches(guardRule, fixture) });
  }
  for (const f of rule.fixtures.allow) {
    const fixture =
      "command" in f
        ? { tool: f.tool, text: f.command, file: false }
        : { tool: f.tool, text: f.file_path, file: true };
    rows.push({
      direction: "allow",
      text: fixture.text,
      pass: !fixtureMatches(guardRule, fixture),
    });
  }
  const failed = rows.filter((x) => !x.pass).length;

  if (flags.json) {
    return failed === 0
      ? r.ok({ id: rule.id, action: rule.defaultAction, fixtures: rows })
      : r.fail("fixtures failed", { id: rule.id, fixtures: rows });
  }

  // A fixture path written with backslashes is answered differently depending on
  // whether the evaluator normalizes separators: the guard rewrites `\` to `/` when it
  // builds the span (a forward-slash glob never matches a backslash path), so
  // `C:\project\.env` matches here and does not match where paths are taken as
  // written. Named specifically because this is the one input where the answers diverge.
  const backslashFixtures = [...rule.fixtures.block, ...rule.fixtures.allow].filter(
    (f) => !("command" in f) && f.file_path.includes("\\"),
  );

  const lines = [
    failed === 0
      ? `Valid. ${rule.id} (${displayAction(rule.defaultAction)})`
      : `Schema valid, but ${failed} fixture${failed === 1 ? "" : "s"} failed. ${rule.id}`,
    ...rows.map(
      (x) =>
        `    ${x.direction} fixture   ${x.text.padEnd(28)} → ${
          x.direction === "block" ? "matched" : "not matched"
        }   ${x.pass ? "PASS" : "FAIL"}`,
    ),
    "",
    // The schema half is the same `parseRule` CI runs; the fixture half is the guard's
    // own evaluator.
    "  Schema checked with the same `parseRule` CI runs. Fixtures were run through the",
    "  guard's own evaluator — the one that will run on your machine.",
    ...(backslashFixtures.length > 0
      ? [
          "",
          `  WARNING: ${backslashFixtures.length} fixture${backslashFixtures.length === 1 ? " uses" : "s use"} a backslash path, which evaluators answer DIFFERENTLY:`,
          "  the guard normalizes `\\` to `/` before matching, so a backslash fixture can pass",
          "  here and fail wherever paths are matched as written. Write forward slashes.",
        ]
      : []),
  ];
  io.writeStdout(`${lines.join("\n")}\n`);
  return failed === 0 ? 0 : 1;
}
