// cspell:words argvs unwritable
/**
 * `init`, `status` and `uninstall` at the command level.
 *
 * The IO is a fake, so no test touches a real `~/.agenttrail`, a real `claude`, or the
 * developer's plugin registry. The most important assertion in the file is the negative
 * one: `init` writes ONLY under `~/.agenttrail/guard/`, asserted over the recorded
 * write list rather than by grepping output for a filename — a string search would pass
 * just as happily if the write happened silently.
 */

import { CATALOG_VERSION } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { runInit } from "../commands/init.js";
import { REPOINT_COMMAND, runStatus, silenceCommand } from "../commands/status.js";
import { runUninstall } from "../commands/uninstall.js";
import { parseConfig } from "../core/config.js";
import { PATTERN_PLACEHOLDER } from "../core/redaction.js";
import { AGENTTRAIL_PLUGIN_ID, GUARD_PLUGIN_ID } from "../plugin/install.js";
import type { ClaudeRunResult, SetupIO } from "../setup-io.js";

const HOME = "/home/test";
const SCAFFOLD = "/pkg/plugin";
const OK: ClaudeRunResult = { code: 0, stdout: "", stderr: "" };

interface Harness {
  io: SetupIO;
  out: () => string;
  writes: Array<{ path: string; text: string }>;
  calls: string[][];
  files: Map<string, string>;
  ran(fragment: string): boolean;
}

function harness(
  options: {
    files?: Record<string, string>;
    plugins?: Array<{ id: string; version?: string; enabled?: boolean; errors?: string[] }>;
    missingPaths?: string[];
    writeThrows?: boolean;
    /** Registered marketplaces. Default: none, as on a clean machine. */
    marketplaces?: Array<{ name: string; path?: string }>;
    /**
     * Version a successful `plugin update` moves our row to, as the real CLI does.
     * Absent → the update changes nothing, which is exactly how a FAILED refresh looks
     * from outside. The refresh verdict is the post-condition, not the exit code, so a
     * static list could never reach the "refreshed" branch.
     */
    updateMovesTo?: string;
  } = {},
): Harness {
  const written: string[] = [];
  const writes: Array<{ path: string; text: string }> = [];
  const calls: string[][] = [];
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const plugins = options.plugins ?? [];
  const missing = new Set(options.missingPaths ?? []);

  const io: SetupIO = {
    writeStdout: (t) => {
      written.push(t);
    },
    readFile: (p) => files.get(p),
    exists: (p) => !missing.has(p),
    writeFileAtomic: (p, text) => {
      if (options.writeThrows) throw new Error("EACCES: permission denied");
      writes.push({ path: p, text });
      files.set(p, text);
    },
    homedir: () => HOME,
    runClaude: (args) => {
      calls.push([...args]);
      const argv = args.join(" ");
      if (args[0] === "--version") return { ...OK, stdout: "2.1.263 (Claude Code)" };
      if (args[1] === "update" && options.updateMovesTo !== undefined) {
        const row = plugins.find((p) => p.id === args[2]);
        if (row !== undefined) row.version = options.updateMovesTo;
        return OK;
      }
      if (argv === "plugin list --json") {
        return {
          ...OK,
          stdout: JSON.stringify(
            plugins.map((p) => ({
              id: p.id,
              version: p.version ?? "0.1.0",
              enabled: p.enabled ?? true,
              // Present only when set, exactly as the real CLI does it — so "absent
              // reads as healthy" is a real assertion and not a fixture artifact.
              ...(p.errors === undefined ? {} : { errors: p.errors }),
            })),
          ),
        };
      }
      if (argv === "plugin marketplace list --json") {
        return {
          ...OK,
          stdout: JSON.stringify(
            (options.marketplaces ?? []).map((m) => ({
              name: m.name,
              source: "directory",
              path: m.path,
              installLocation: m.path,
            })),
          ),
        };
      }
      return OK;
    },
  };

  return {
    io,
    out: () => written.join(""),
    writes,
    calls,
    files,
    ran: (f) => calls.some((c) => c.join(" ").includes(f)),
  };
}

const initDeps = { scaffoldDir: SCAFFOLD, bundledVersion: "0.1.0" };

describe("init", () => {
  it("seeds both files and installs the plugin", async () => {
    const h = harness();
    expect(await runInit(h.io, {}, initDeps)).toBe(0);

    expect(h.writes.map((w) => w.path)).toEqual([
      `${HOME}/.agenttrail/guard/config.json`,
      `${HOME}/.agenttrail/guard/guardrails.json`,
    ]);
    expect(h.ran(`plugin marketplace add ${SCAFFOLD} --scope user`)).toBe(true);
    expect(h.ran(`plugin install ${GUARD_PLUGIN_ID} --scope user`)).toBe(true);
  });

  it("NEVER writes outside ~/.agenttrail/guard — settings.json above all", async () => {
    // Asserted over the write list, not by grepping the output: a stray write would be
    // invisible to a string search but caught here.
    const h = harness();
    await runInit(h.io, {}, initDeps);
    for (const w of h.writes) {
      expect(w.path.startsWith(`${HOME}/.agenttrail/guard/`)).toBe(true);
    }
    expect(h.writes.some((w) => w.path.includes(".claude"))).toBe(false);
    expect(h.writes.some((w) => w.path.includes("settings.json"))).toBe(false);
  });

  it("writes a config the reader round-trips", async () => {
    const h = harness();
    await runInit(h.io, {}, initDeps);
    const text = h.writes.find((w) => w.path.endsWith("config.json"))?.text ?? "";
    const config = parseConfig(text);
    expect(config.failOpen).toBe(true);
    expect(config.crashReports).toBe(false);
    expect(config.enabledPacks).toContain("working-tree");
  });

  it("demonstrates itself — a synthetic rm -rf / shown blocked, not run", async () => {
    const h = harness();
    await runInit(h.io, {}, initDeps);
    expect(h.out()).toContain("rm -rf /");
    expect(h.out()).toContain("BLOCKED");
    expect(h.out()).toContain("evaluated, not executed");
  });

  it("prints the BUNDLED catalog's version and its age", async () => {
    const h = harness();
    await runInit(h.io, {}, initDeps);
    // The version is the catalog package's, not the guard's — the guard bundles the
    // catalog at build time, so that is what determines which rules a user has.
    // `catalog-stamp.test.ts` owns the age arithmetic; this pins that `init` is one of
    // the three surfaces that shows it at all.
    expect(h.out()).toContain(`guardrail library v${CATALOG_VERSION}, published `);
    expect(h.out()).toMatch(/guardrail library v\d+\.\d+\.\d+, published (today|\d+ days? ago)/);
    expect(h.out()).not.toContain("not yet stamped");
  });

  it("is idempotent — a second run rewrites nothing and reinstalls nothing", async () => {
    const h = harness();
    await runInit(h.io, {}, initDeps);
    const firstWrites = h.writes.length;

    // Second run, with the plugin now present.
    const h2 = harness({
      files: Object.fromEntries(h.files),
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }],
    });
    expect(await runInit(h2.io, {}, initDeps)).toBe(0);

    expect(firstWrites).toBe(2);
    expect(h2.writes).toHaveLength(0);
    expect(h2.ran("plugin install")).toBe(false);
    expect(h2.out()).toContain("Already installed");
  });

  it("declines when the agenttrail plugin is present — exit 0, nothing written or run", async () => {
    const h = harness({ plugins: [{ id: AGENTTRAIL_PLUGIN_ID }] });
    expect(await runInit(h.io, {}, initDeps)).toBe(0);

    expect(h.out()).toContain(AGENTTRAIL_PLUGIN_ID);
    expect(h.out()).toContain("Nothing was written");
    expect(h.writes).toHaveLength(0);
    expect(h.ran("plugin install")).toBe(false);
    expect(h.ran("marketplace add")).toBe(false);
  });

  it("warns when the plugin is installed but disabled", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0", enabled: false }] });
    await runInit(h.io, {}, initDeps);
    expect(h.out()).toContain("DISABLED");
    expect(h.out()).toContain("claude plugin enable");
  });

  it("--print changes nothing at all", async () => {
    const h = harness();
    expect(await runInit(h.io, { print: true }, initDeps)).toBe(0);

    expect(h.writes).toHaveLength(0);
    expect(h.ran("marketplace add")).toBe(false);
    expect(h.ran("plugin install")).toBe(false);
    // It still says what it WOULD do, including the two argvs.
    expect(h.out()).toContain("marketplace add");
    expect(h.out()).toContain("plugin install");
    expect(h.out()).toContain("would NOT touch");
  });

  it("--print still detects the agenttrail plugin and declines", async () => {
    const h = harness({ plugins: [{ id: AGENTTRAIL_PLUGIN_ID }] });
    await runInit(h.io, { print: true }, initDeps);
    expect(h.out()).toContain("already installed");
  });

  it("an unwritable config dir is a named error, not a stack trace", async () => {
    const h = harness({ writeThrows: true });
    expect(await runInit(h.io, {}, initDeps)).toBe(1);
    expect(h.out()).toContain("could not write");
    expect(h.out()).not.toContain("at Object.");
  });
});

describe("status", () => {
  const configFile = `${HOME}/.agenttrail/guard/config.json`;
  const rulesFile = `${HOME}/.agenttrail/guard/guardrails.json`;
  const eventsFile = `${HOME}/.agenttrail/guard/events.jsonl`;

  it("says NOT INSTALLED when nothing is installed", async () => {
    const h = harness();
    expect(await runStatus(h.io)).toBe(0);
    expect(h.out()).toContain("NOT INSTALLED");
    expect(h.out()).toContain("agenttrail-guard init");
  });

  it("distinguishes installed-but-DISABLED from enforcing", async () => {
    const disabled = harness({ plugins: [{ id: GUARD_PLUGIN_ID, enabled: false }] });
    await runStatus(disabled.io);
    expect(disabled.out()).toContain("Enforcement: OFF");
    expect(disabled.out()).toContain("claude plugin enable");

    const on = harness({ plugins: [{ id: GUARD_PLUGIN_ID, enabled: true }] });
    await runStatus(on.io);
    expect(on.out()).toContain("Enforcement: ON");
  });

  it("reports invalid user guardrails PROMINENTLY, above the decisions", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [rulesFile]: JSON.stringify([
          { id: "local.broken", category: "custom", defaultAction: "nonsense", match: {} },
        ]),
        [eventsFile]: JSON.stringify({
          ts: "2026-09-07T00:00:00Z",
          tool: "Bash",
          decision: "deny",
          ruleId: "wt.reset-hard",
          command: "git reset --hard",
        }),
      },
    });
    await runStatus(h.io);
    const out = h.out();

    expect(out).toContain("PROBLEM");
    expect(out).toContain("local.broken");
    expect(out).toContain("NOT running");
    // It must reach the user BEFORE the decision history, not below it.
    expect(out.indexOf("PROBLEM")).toBeLessThan(out.indexOf("Recent decisions"));
    // And it must explain why nothing else told them.
    expect(out).toContain("stderr");
  });

  it("flags a user guardrail missing `category` rather than silently loading it", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [rulesFile]: JSON.stringify([
          {
            id: "local.no-category",
            defaultAction: "require_approval",
            match: { any_of: [{ kind: "execute_tool", detail_contains: ["./deploy.sh"] }] },
          },
        ]),
      },
    });
    await runStatus(h.io);
    expect(h.out()).toContain("local.no-category");
    expect(h.out()).toContain("enabledPacks");
  });

  it("names `require_approval` when a guardrail copied from the docs says `ask`", async () => {
    // A hand-written `guardrails.json` commonly uses `"ask"`, which the stored format does
    // not accept (`ask` is Claude Code's prompt; the action is `require_approval`), often
    // together with a wrong `category`. A user making both mistakes gets two rejections, so
    // the message has to be actionable, not just true.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [rulesFile]: JSON.stringify([
          { id: "local.no-deploy-friday", severity: "medium", defaultAction: "ask", match: {} },
        ]),
      },
    });
    await runStatus(h.io);
    expect(h.out()).toContain("local.no-deploy-friday");
    expect(h.out()).toContain("require_approval");
  });

  it("names the most frequent match and prints the EXACT silence command", async () => {
    const noisy = Array.from({ length: 14 }, () =>
      JSON.stringify({
        ts: "2026-09-07T00:00:00Z",
        tool: "Bash",
        decision: "deny",
        ruleId: "wt.checkout-discard",
        command: "git checkout -- ./generated/api-types.ts",
      }),
    );
    const quiet = JSON.stringify({
      ts: "2026-09-07T00:00:00Z",
      tool: "Bash",
      decision: "deny",
      ruleId: "wt.reset-hard",
      command: "git reset --hard",
    });
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [eventsFile]: [...noisy, quiet].join("\n") },
    });
    await runStatus(h.io);
    const out = h.out();

    expect(out).toContain("Most frequent match");
    expect(out).toContain("wt.checkout-discard");
    expect(out).toContain("14x");
    // The exact string `guardrails allow` accepts. Pinned so the printed line and the
    // parser stay one string. The QUOTING moved from double to single: double quotes
    // mis-split on a command containing `"` and let the shell expand `$VAR` on paste.
    // `rules-command.test.ts` round-trips it.
    expect(out).toContain(
      "agenttrail-guard guardrails allow wt.checkout-discard 'git checkout -- ./generated/api-types.ts'",
    );
    expect(out).toContain("does not disable the guardrail");
  });

  it("renders an empty state when there is no decision log", async () => {
    // The state of a machine where nothing has written the log yet.
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    await runStatus(h.io);
    expect(h.out()).toContain("No decisions recorded yet");
    expect(h.out()).not.toContain("Most frequent match");
  });

  it("survives a truncated final line without losing the good ones", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [eventsFile]:
          `${JSON.stringify({ ts: "", tool: "Bash", decision: "deny", ruleId: "a.b", command: "x" })}\n` +
          '{"ts":"2026-09-07T00:00:0',
      },
    });
    expect(await runStatus(h.io)).toBe(0);
    expect(h.out()).toContain("a.b");
  });

  it("counts a guardrail count and reports the bundled catalog's version and age", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [configFile]: "{}" },
    });
    await runStatus(h.io);
    expect(h.out()).toMatch(/\d+ guardrails/);
    expect(h.out()).toContain(`guardrail library v${CATALOG_VERSION}, published `);
    expect(h.out()).toMatch(/guardrail library v\d+\.\d+\.\d+, published (today|\d+ days? ago)/);
    expect(h.out()).not.toContain("not yet stamped");
  });

  it("silenceCommand is the one spelling, shared by the renderer and the test", () => {
    expect(silenceCommand("wt.reset-hard", "git reset --hard ./x")).toBe(
      "agenttrail-guard guardrails allow wt.reset-hard 'git reset --hard ./x'",
    );
  });

  it("quotes so the line survives a command containing quotes or a variable", () => {
    // Double quotes would produce `… "echo "hi""`, which any shell mis-splits, and
    // `… "rm -rf $DIR"`, which the shell expands before the CLI ever sees it — silencing a
    // pattern the user never typed. The round trip through a real `/bin/sh` is in
    // `built-artifact.test.ts`.
    expect(silenceCommand("r", 'echo "hi"')).toBe(
      "agenttrail-guard guardrails allow r 'echo \"hi\"'",
    );
    expect(silenceCommand("r", "rm -rf $DIR")).toBe(
      "agenttrail-guard guardrails allow r 'rm -rf $DIR'",
    );
    // POSIX has no escape inside single quotes: close, escape, reopen.
    expect(silenceCommand("r", "echo it's")).toBe(
      "agenttrail-guard guardrails allow r 'echo it'\\''s'",
    );
  });

  it("reports a guardrail the hook loads that the strict validator would not vouch for", async () => {
    // `any_of: [{}]` has a populated positive arm, so the hook's structural loader
    // admits it; the strict validator rejects the condition for having no `kind`.
    // `status` must show BOTH halves rather than picking one number. (`match: {}` itself
    // is discarded outright, so it is not in the gap.)
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [rulesFile]: JSON.stringify([
          {
            id: "local.shapeless",
            category: "prod-infra",
            defaultAction: "block",
            match: { any_of: [{}] },
          },
        ]),
      },
    });
    await runStatus(h.io);
    expect(h.out()).toContain("local.shapeless");
    expect(h.out()).toContain("loaded and enforcing");
  });

  it("reports a config.json setting that was silently discarded", async () => {
    // `parseOverrides` drops an unrecognized action with no trace, and `ask` is the
    // word the CLI itself teaches.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [configFile]: JSON.stringify({ guardrailActionOverrides: { "wt.reset-hard": "ask" } }),
      },
    });
    await runStatus(h.io);
    expect(h.out()).toContain("in your config.json");
    expect(h.out()).toContain("guardrailActionOverrides.wt.reset-hard");
    // The fix, not just the complaint: `ask` is the word the CLI teaches, so "invalid
    // action" would be a useless answer.
    expect(h.out()).toContain("require_approval");
  });
});

describe("init says what actually happened to the marketplace", () => {
  const DANGLE = "Marketplace agenttrail-guard failed to load: cache-miss";

  it("names a RECOVERED source in plain words — the user's install had silently stopped being updatable", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }],
      marketplaces: [{ name: "agenttrail-guard", path: "/gone/plugin" }],
      missingPaths: ["/gone/plugin"],
    });
    expect(await runInit(h.io, {}, initDeps)).toBe(0);
    expect(h.out()).toContain("Recovered the marketplace");
    expect(h.out()).toContain("could");
    expect(h.out()).toContain(SCAFFOLD);
    // "Re-pointed" is the OTHER message; a vanished source must not read as a move.
    expect(h.out()).not.toContain("Re-pointed the marketplace");
  });

  it("says 'Re-pointed' — not 'Recovered' — when the old path merely moved", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }],
      marketplaces: [{ name: "agenttrail-guard", path: "/somewhere/else" }],
    });
    await runInit(h.io, {}, initDeps);
    expect(h.out()).toContain("Re-pointed the marketplace");
    expect(h.out()).not.toContain("Recovered the marketplace");
  });

  it("tells the user to RESTART after a refresh, or the refresh looks like a no-op", async () => {
    // `plugin update` itself prints "Restart to apply changes." Without this line the user
    // keeps the session open and keeps running the OLD cached hook, so a refresh appears
    // to have done nothing.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }],
      marketplaces: [{ name: "agenttrail-guard", path: SCAFFOLD }],
      updateMovesTo: "0.1.0",
    });
    expect(await runInit(h.io, {}, initDeps)).toBe(0);
    expect(h.out()).toContain(`Refreshed ${GUARD_PLUGIN_ID}`);
    expect(h.out()).toContain("Restart Claude Code");
  });

  it("reports a FAILED refresh as a warning, never as success", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }],
      marketplaces: [{ name: "agenttrail-guard", path: SCAFFOLD }],
    });
    const io: SetupIO = {
      ...h.io,
      runClaude: (args) =>
        args[1] === "update"
          ? { code: 1, stdout: "", stderr: 'Plugin "agenttrail-guard" not found' }
          : h.io.runClaude(args),
    };
    expect(await runInit(io, {}, initDeps)).toBe(0);
    expect(h.out()).toContain("could NOT be updated");
    expect(h.out()).toContain("not found");
    // It must not frighten: the older version is still enforcing.
    expect(h.out()).toContain("still enforcing");
    expect(h.out()).toContain(`claude plugin update ${GUARD_PLUGIN_ID}`);
    expect(h.out()).not.toContain("Refreshed");
  });

  it("warns when the vendor STILL reports an error after we re-pointed", async () => {
    // Re-pointing clears these, so any still present are unexpected: print the vendor's
    // own words rather than guessing at them.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0", errors: [DANGLE] }],
      marketplaces: [{ name: "agenttrail-guard", path: SCAFFOLD }],
    });
    await runInit(h.io, {}, initDeps);
    expect(h.out()).toContain("still reports a problem");
    expect(h.out()).toContain(DANGLE);
  });
});

describe("status reports a dangling plugin source", () => {
  const DANGLE = "Marketplace agenttrail-guard failed to load: cache-miss";

  it("names the problem and the ONE line that fixes it", async () => {
    // Before this, a dangled install printed a fully green `Enforcement: ON` while
    // `plugin update` and `plugin install` both exited 1. The guard kept working and
    // could never be upgraded, and `status` is the only place a person would find out.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      marketplaces: [{ name: "agenttrail-guard", path: "/gone/plugin" }],
      missingPaths: ["/gone/plugin"],
    });
    expect(await runStatus(h.io)).toBe(0);
    expect(h.out()).toContain("PROBLEM: the plugin source is missing");
    expect(h.out()).toContain("/gone/plugin");
    expect(h.out()).toContain(REPOINT_COMMAND);
    // It must NOT read as "you are unprotected" — the cached copy is still enforcing.
    expect(h.out()).toContain("still enforcing");
  });

  it("fires on the VENDOR channel alone, even when the recorded path still exists", async () => {
    // The two channels are independent on purpose: this one is the only one that will
    // still work once the source is `npm` and there is no path to stat.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, errors: [DANGLE] }],
      marketplaces: [{ name: "agenttrail-guard", path: "/pkg/plugin" }],
    });
    await runStatus(h.io);
    expect(h.out()).toContain("PROBLEM: the plugin source is missing");
    // The vendor's own sentence, verbatim — we never paraphrase or pattern-match it.
    expect(h.out()).toContain(DANGLE);
  });

  it("says NOTHING about the marketplace when the install is healthy", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      marketplaces: [{ name: "agenttrail-guard", path: "/pkg/plugin" }],
    });
    await runStatus(h.io);
    expect(h.out()).not.toContain("plugin source is missing");
    expect(h.out()).not.toContain(REPOINT_COMMAND);
  });

  it("stays silent when the marketplace list cannot be read — not 'broken', 'could not look'", async () => {
    // A scary, unactionable line on a machine that is fine is how a tool gets
    // uninstalled. `unknown` health is silence.
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    const io: SetupIO = {
      ...h.io,
      runClaude: (args) =>
        args.join(" ") === "plugin marketplace list --json"
          ? { code: 1, stdout: "", stderr: "nope" }
          : h.io.runClaude(args),
    };
    await runStatus(io);
    expect(h.out()).not.toContain("plugin source is missing");
  });

  it("says nothing about the marketplace when nothing is installed at all", async () => {
    // "NOT INSTALLED — run init" is the whole story; a second paragraph about a
    // marketplace path would be noise on top of it.
    const h = harness({ marketplaces: [{ name: "agenttrail-guard", path: "/gone" }] });
    await runStatus(h.io);
    expect(h.out()).toContain("NOT INSTALLED");
    expect(h.out()).not.toContain("plugin source is missing");
  });
});

describe("init --print tells the truth about what it would do", () => {
  /** Every verb that changes the machine. `--print` may emit none of them. */
  const MUTATING = ["add", "install", "update", "remove", "uninstall", "enable", "disable"];

  it("describes RE-POINTING a vanished source rather than a fresh install", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      marketplaces: [{ name: "agenttrail-guard", path: "/gone/plugin" }],
      missingPaths: ["/gone/plugin"],
    });
    expect(await runInit(h.io, { print: true }, initDeps)).toBe(0);
    expect(h.out()).toContain("PROBLEM");
    expect(h.out()).toContain("/gone/plugin");
    expect(h.out()).toContain("re-points it");
  });

  it("says there is nothing to do when everything is already current", async () => {
    // `--print` must not promise to install something already installed.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }],
      marketplaces: [{ name: "agenttrail-guard", path: SCAFFOLD }],
      files: {
        [`${HOME}/.agenttrail/guard/config.json`]: "{}",
        [`${HOME}/.agenttrail/guard/guardrails.json`]: "[]",
      },
    });
    await runInit(h.io, { print: true }, initDeps);
    expect(h.out()).toContain("nothing to do");
    expect(h.out()).toContain("already installed at 0.1.0");
  });

  it("describes an UPDATE when the installed version is behind the bundled one", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }],
      marketplaces: [{ name: "agenttrail-guard", path: SCAFFOLD }],
    });
    await runInit(h.io, { print: true }, initDeps);
    expect(h.out()).toContain(`claude plugin update ${GUARD_PLUGIN_ID}`);
    expect(h.out()).toContain("0.0.9");
  });

  it("performs the VERSION GATE it claims to, and stops when Claude Code is too old", async () => {
    // `--print` performs the same version gate `init` does.
    const h = harness();
    const io: SetupIO = {
      ...h.io,
      runClaude: (args) =>
        args[0] === "--version"
          ? { code: 0, stdout: "2.0.1 (Claude Code)", stderr: "" }
          : h.io.runClaude(args),
    };
    expect(await runInit(io, { print: true }, initDeps)).toBe(0);
    expect(h.out()).toContain("It would STOP");
    expect(h.out()).toContain("2.1.211");
  });

  it("issues ZERO mutating argv in every state it can describe", async () => {
    for (const options of [
      {},
      { plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }] },
      {
        plugins: [{ id: GUARD_PLUGIN_ID }],
        marketplaces: [{ name: "agenttrail-guard", path: "/gone" }],
        missingPaths: ["/gone"],
      },
      { plugins: [{ id: GUARD_PLUGIN_ID, enabled: false }] },
    ]) {
      const h = harness(options);
      await runInit(h.io, { print: true }, initDeps);
      expect(h.writes).toEqual([]);
      for (const verb of MUTATING) {
        expect(h.calls.some((c) => c.includes(verb))).toBe(false);
      }
    }
  });
});

describe("status --clear-history", () => {
  const eventsFile = `${HOME}/.agenttrail/guard/events.jsonl`;

  const oneRecord = JSON.stringify({
    ts: "2026-09-07T00:00:00Z",
    tool: "Bash",
    decision: "deny",
    ruleId: "wt.reset-hard",
    command: "git reset --hard",
  });

  it("empties the log, names the path, and exits 0", async () => {
    const h = harness({ files: { [eventsFile]: `${oneRecord}\n` } });
    expect(await runStatus(h.io, { clearHistory: true })).toBe(0);
    expect(h.files.get(eventsFile)).toBe("");
    expect(h.out()).toContain("Decision log cleared");
    expect(h.out()).toContain(eventsFile);
  });

  it("TRUNCATES rather than deletes, so the 0600 file survives", async () => {
    // Deleting would let the next append recreate the file, and `appendFile` only
    // applies its mode on creation — so a umask change between runs could widen it.
    const h = harness({ files: { [eventsFile]: `${oneRecord}\n` } });
    await runStatus(h.io, { clearHistory: true });
    expect(h.files.has(eventsFile)).toBe(true);
    expect(h.writes.map((w) => w.path)).toEqual([eventsFile]);
  });

  it("is not an error on a log that does not exist yet", async () => {
    const h = harness();
    expect(await runStatus(h.io, { clearHistory: true })).toBe(0);
  });

  it("a write failure is LOUD and exits 1", async () => {
    // A destructive command that silently did nothing is worse than one that
    // failed: the user would believe their log was cleared.
    const h = harness({ files: { [eventsFile]: `${oneRecord}\n` }, writeThrows: true });
    expect(await runStatus(h.io, { clearHistory: true })).toBe(1);
    expect(h.out()).toContain("Could not clear");
    expect(h.out()).toContain(eventsFile);
  });

  it("prints nothing else — it is the whole command, not a modifier", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [eventsFile]: `${oneRecord}\n` },
    });
    await runStatus(h.io, { clearHistory: true });
    expect(h.out()).not.toContain("Enforcement:");
    expect(h.out()).not.toContain("Most frequent match");
  });

  it("deleting the file by hand stays safe — status still runs", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    expect(await runStatus(h.io)).toBe(0);
    expect(h.out()).toContain("No decisions recorded yet.");
  });
});

describe("status withholds a silence pattern it knows cannot work", () => {
  const eventsFile = `${HOME}/.agenttrail/guard/events.jsonl`;

  function logOf(command: string, n = 3): string {
    return `${Array.from({ length: n }, () =>
      JSON.stringify({
        ts: "2026-09-07T00:00:00Z",
        tool: "Bash",
        decision: "deny",
        ruleId: "sec.env-read",
        command,
      }),
    ).join("\n")}\n`;
  }

  it("explains instead of suggesting when the shape was redacted", async () => {
    // `[REDACTED:secret:env]` is a picomatch BRACKET EXPRESSION. `compileAllowlist`
    // accepts it, compiles it as a character class, and it matches almost nothing —
    // so the user pastes the line, sees no error, and the rule keeps firing.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [eventsFile]: logOf("cat [REDACTED:secret:env]") },
    });
    await runStatus(h.io);
    const out = h.out();

    expect(out).toContain("cannot be used as a match pattern");
    expect(out).toContain(silenceCommand("sec.env-read", PATTERN_PLACEHOLDER));
    expect(out).not.toContain(silenceCommand("sec.env-read", "cat [REDACTED:secret:env]"));
  });

  it("still prints the guardrail and the count — silence would read as 'no noisy guardrail'", async () => {
    // The negative control for the assertion above: withholding the PATTERN must
    // not turn into withholding the finding.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [eventsFile]: logOf("cat [REDACTED:secret:env]") },
    });
    await runStatus(h.io);
    const out = h.out();

    expect(out).toContain("Most frequent match");
    expect(out).toContain("sec.env-read");
    expect(out).toContain("3x");
  });

  it("suggests normally when nothing was redacted", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [eventsFile]: logOf("git reset --hard ./src") },
    });
    await runStatus(h.io);
    const out = h.out();

    expect(out).toContain(silenceCommand("sec.env-read", "git reset --hard ./src"));
    expect(out).not.toContain("cannot be used as a match pattern");
  });
});

describe("uninstall", () => {
  it("removes ours and says the rest is untouched", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    expect(await runUninstall(h.io)).toBe(0);
    expect(h.ran(`plugin uninstall ${GUARD_PLUGIN_ID} --scope user`)).toBe(true);
    expect(h.out()).toContain("untouched");
  });

  it("running it twice is not an error", async () => {
    const h = harness({ plugins: [] });
    expect(await runUninstall(h.io)).toBe(0);
    expect(h.out()).toContain("not installed");
    expect(h.ran("plugin uninstall")).toBe(false);
  });

  it("keeps the user's own settings and says where they are", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    await runUninstall(h.io);
    expect(h.writes).toHaveLength(0);
    expect(h.out()).toContain("/.agenttrail/guard");
  });

  it("a failing uninstall is a named error, not a stack trace", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    const io: SetupIO = {
      ...h.io,
      runClaude: (args) => {
        if (args[0] === "--version") return { ...OK, stdout: "2.1.263" };
        if (args.join(" ") === "plugin list --json") {
          return { ...OK, stdout: JSON.stringify([{ id: GUARD_PLUGIN_ID, enabled: true }]) };
        }
        if (args[1] === "uninstall") return { code: 1, stdout: "", stderr: "locked" };
        return OK;
      },
    };
    expect(await runUninstall(io)).toBe(1);
  });
});
