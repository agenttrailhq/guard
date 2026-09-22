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
import { agentChoiceMessage } from "../commands/agent-choice.js";
import { type InitDeps, runInit } from "../commands/init.js";
import {
  REPOINT_COMMAND,
  runStatus as runStatusCommand,
  type StatusDeps,
  silenceCommand,
} from "../commands/status.js";
import { runUninstall, type UninstallDeps } from "../commands/uninstall.js";
import { parseConfig } from "../core/config.js";
import { PATTERN_PLACEHOLDER } from "../core/redaction.js";
import type { GuardRule } from "../core/types.js";
import { VERSION } from "../core/version.js";
import type { GuardIO } from "../io.js";
import { AGENTTRAIL_PLUGIN_ID, GUARD_PLUGIN_ID } from "../plugin/install.js";
import type { ClaudeRunner, ClaudeRunResult, SetupIO } from "../setup-io.js";
import { type FakeCodexFilesOptions, fakeCodexFiles } from "./codex-files.js";
import { type FakeCursorFilesOptions, fakeCursorFiles } from "./cursor-files.js";

const HOME = "/home/test";
const SCAFFOLD = "/pkg/plugin";
const OK: ClaudeRunResult = { code: 0, stdout: "", stderr: "" };

/** Where Claude Code's user settings live, for the approval-override check. */
const CLAUDE_SETTINGS = `${HOME}/.claude/settings.json`;

/** The guard's config file, seeded by `init` and never rewritten by it afterwards. */
const CONFIG_FILE = `${HOME}/.agenttrail/guard/config.json`;

/** A `config.json` with the given fields over the shipped shape. */
function configWith(over: Record<string, unknown>): string {
  return `${JSON.stringify(
    {
      version: 1,
      disabledPacks: [],
      disabledGuardrails: [],
      guardrailActionOverrides: {},
      allowlist: [],
      crashReports: false,
      ...over,
    },
    null,
    2,
  )}\n`;
}

/**
 * A tiny catalog with a known shape, so the override count is deterministic: two
 * `require_approval` holds — one shell (`{Bash,PowerShell}`), one file (`file_glob`) —
 * and one shell `block` that must never be counted as a hold.
 */
const OVERRIDE_CATALOG: GuardRule[] = [
  {
    id: "sh.hold",
    category: "working-tree",
    severity: "high",
    defaultAction: "require_approval",
    title: "a shell hold",
    description: "",
    match: {
      any_of: [{ kind: "execute_tool", label: "{Bash,PowerShell}", detail_matches: ["\\brm\\b"] }],
    },
  },
  {
    id: "fs.hold",
    category: "file-scope",
    severity: "high",
    defaultAction: "require_approval",
    title: "a file hold",
    description: "",
    match: { any_of: [{ kind: "execute_tool", file_glob: "/etc/**" }] },
  },
  {
    id: "sh.block",
    category: "working-tree",
    severity: "critical",
    defaultAction: "block",
    title: "a shell block",
    description: "",
    match: {
      any_of: [{ kind: "execute_tool", label: "{Bash,PowerShell}", detail_matches: ["\\bdd\\b"] }],
    },
  },
];

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

/** `--agent claude`, which `init` and `uninstall` now require to act as they always have. */
const CLAUDE = { agent: "claude" } as const;

/**
 * A `GuardIO` over an in-memory crash spool. It records every directory listed, every file
 * read, and every call that could write.
 */
function fakeGuardIo(options: { files?: Record<string, string>; home?: string } = {}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const writes: string[] = [];
  const listed: string[] = [];
  const read: string[] = [];
  const io: GuardIO = {
    readStdin: async () => "",
    writeStdout: (text) => {
      writes.push(`stdout ${text}`);
    },
    readFile: (path) => {
      read.push(path);
      return files.get(path);
    },
    homedir: () => options.home ?? HOME,
    mkdirp: (path) => {
      writes.push(`mkdirp ${path}`);
      return true;
    },
    writeFileAtomic: (path) => {
      writes.push(`write ${path}`);
      return true;
    },
    listDir: (path) => {
      listed.push(path);
      const prefix = `${path}/`;
      return [...files.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .map((key) => key.slice(prefix.length));
    },
    deleteFile: (path) => {
      writes.push(`delete ${path}`);
      return true;
    },
    appendFile: (path) => {
      writes.push(`append ${path}`);
      return true;
    },
    fileSize: () => 0,
  };
  return { io, writes, listed, read };
}

/**
 * `status` with fakes for the three seams `SetupIO` does not cover — an empty `~/.cursor`,
 * an empty `~/.codex` and an empty crash spool — unless a test passes its own. So no test
 * here reads the real file system.
 */
function runStatus(io: SetupIO, deps: StatusDeps = {}): Promise<number> {
  return runStatusCommand(io, {
    cursorIo: fakeCursorFiles().io,
    codexIo: fakeCodexFiles().io,
    guardIo: fakeGuardIo().io,
    ...deps,
  });
}

describe("init", () => {
  it("seeds both files and installs the plugin", async () => {
    const h = harness();
    expect(await runInit(h.io, CLAUDE, initDeps)).toBe(0);

    expect(h.writes.map((w) => w.path)).toEqual([
      `${HOME}/.agenttrail/guard/config.json`,
      `${HOME}/.agenttrail/guard/guardrails.json`,
    ]);
    expect(h.ran(`plugin marketplace add ${SCAFFOLD} --scope user`)).toBe(true);
    expect(h.ran(`plugin install ${GUARD_PLUGIN_ID} --scope user`)).toBe(true);
    // A fresh install tells the user to restart, just as the refresh path does: the
    // plugin's hook only takes effect once Claude Code reloads.
    expect(h.out()).toContain("Restart Claude Code");
  });

  it("warns at install when settings.json already allows a held tool", async () => {
    const h = harness({
      files: { [CLAUDE_SETTINGS]: JSON.stringify({ permissions: { allow: ["Bash"] } }) },
    });
    expect(
      await runInit(h.io, CLAUDE, {
        ...initDeps,
        catalog: OVERRIDE_CATALOG,
        settingsPath: CLAUDE_SETTINGS,
      }),
    ).toBe(0);
    expect(h.out()).toContain(
      "1 of 2 approval guardrails will not prompt because settings.json allows: Bash",
    );
    // Reading settings.json must never turn into writing it.
    expect(h.writes.some((w) => w.path.includes("settings.json"))).toBe(false);
  });

  it("prints no override warning at install when settings.json allows nothing relevant", async () => {
    const h = harness();
    await runInit(h.io, CLAUDE, {
      ...initDeps,
      catalog: OVERRIDE_CATALOG,
      settingsPath: CLAUDE_SETTINGS,
    });
    expect(h.out()).not.toContain("will not prompt because settings.json allows");
  });

  it("NEVER writes outside ~/.agenttrail/guard — settings.json above all", async () => {
    // Asserted over the write list, not by grepping the output: a stray write would be
    // invisible to a string search but caught here.
    const h = harness();
    await runInit(h.io, CLAUDE, initDeps);
    for (const w of h.writes) {
      expect(w.path.startsWith(`${HOME}/.agenttrail/guard/`)).toBe(true);
    }
    expect(h.writes.some((w) => w.path.includes(".claude"))).toBe(false);
    expect(h.writes.some((w) => w.path.includes("settings.json"))).toBe(false);
  });

  it("writes a config the reader round-trips", async () => {
    const h = harness();
    await runInit(h.io, CLAUDE, initDeps);
    const text = h.writes.find((w) => w.path.endsWith("config.json"))?.text ?? "";
    const config = parseConfig(text);
    expect(config.crashReports).toBe(false);
    // Nothing off, and no list of packs that a later release could outgrow.
    expect(config.disabledPacks).toEqual([]);
    expect(JSON.parse(text)).not.toHaveProperty("enabledPacks");
  });

  it("demonstrates itself — a synthetic rm -rf / shown blocked, not run", async () => {
    const h = harness();
    await runInit(h.io, CLAUDE, initDeps);
    expect(h.out()).toContain("rm -rf /");
    expect(h.out()).toContain("BLOCKED");
    expect(h.out()).toContain("evaluated, not executed");
  });

  it("closes by pointing at the global install when run via npx, not a missing binary", async () => {
    // A user who ran `npx @agenttrail/guard init` has no `agenttrail-guard` on PATH, so the
    // default closing line — "run agenttrail-guard status" — would be `command not found`.
    // An npx invocation resolves the CLI under the npm exec cache, whose path carries an
    // `/_npx/` segment; that branch points at the install instead of naming the binary.
    const h = harness();
    const npxPath = `${HOME}/.npm/_npx/9a1b2c3d/node_modules/@agenttrail/guard/dist/cli.js`;
    await runInit(h.io, CLAUDE, { ...initDeps, cliPath: npxPath });
    expect(h.out()).toContain("npm i -g @agenttrail/guard");
    expect(h.out()).not.toContain("Run `agenttrail-guard status`");
  });

  it("closes with the short command for a global install", async () => {
    // A global install has `agenttrail-guard` on PATH, so it is named directly and the npx
    // install line is not shown.
    const h = harness();
    await runInit(h.io, CLAUDE, { ...initDeps, cliPath: "/usr/local/bin/agenttrail-guard" });
    expect(h.out()).toContain("Run `agenttrail-guard status`");
    expect(h.out()).not.toContain("npm i -g @agenttrail/guard");
  });

  it("prints the BUNDLED catalog's version and its age", async () => {
    const h = harness();
    await runInit(h.io, CLAUDE, initDeps);
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
    await runInit(h.io, CLAUDE, initDeps);
    const firstWrites = h.writes.length;

    // Second run, with the plugin now present.
    const h2 = harness({
      files: Object.fromEntries(h.files),
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }],
    });
    expect(await runInit(h2.io, CLAUDE, initDeps)).toBe(0);

    expect(firstWrites).toBe(2);
    expect(h2.writes).toHaveLength(0);
    expect(h2.ran("plugin install")).toBe(false);
    expect(h2.out()).toContain("Already installed");
  });

  it("declines when the agenttrail plugin is present — exit 0, nothing written or run", async () => {
    const h = harness({ plugins: [{ id: AGENTTRAIL_PLUGIN_ID }] });
    expect(await runInit(h.io, CLAUDE, initDeps)).toBe(0);

    expect(h.out()).toContain(AGENTTRAIL_PLUGIN_ID);
    expect(h.out()).toContain("Nothing was written");
    expect(h.writes).toHaveLength(0);
    expect(h.ran("plugin install")).toBe(false);
    expect(h.ran("marketplace add")).toBe(false);
  });

  it("warns when the plugin is installed but disabled", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0", enabled: false }] });
    await runInit(h.io, CLAUDE, initDeps);
    expect(h.out()).toContain("DISABLED");
    expect(h.out()).toContain("claude plugin enable");
  });

  it("--print changes nothing at all", async () => {
    const h = harness();
    expect(await runInit(h.io, { ...CLAUDE, print: true }, initDeps)).toBe(0);

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
    await runInit(h.io, { ...CLAUDE, print: true }, initDeps);
    expect(h.out()).toContain("already installed");
  });

  it("an unwritable config dir is a named error, not a stack trace", async () => {
    const h = harness({ writeThrows: true });
    expect(await runInit(h.io, CLAUDE, initDeps)).toBe(1);
    expect(h.out()).toContain("could not write");
    expect(h.out()).not.toContain("at Object.");
  });
});

describe("init never rewrites an existing config", () => {
  // OVERRIDE_CATALOG has two packs: working-tree and file-scope.
  const PACK_DEPS = { ...initDeps, catalog: OVERRIDE_CATALOG };

  it("a re-run keeps a pack the user turned off, off — the file is not touched", async () => {
    const text = configWith({ disabledPacks: ["file-scope"] });
    const h = harness({
      files: { [CONFIG_FILE]: text },
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }],
    });
    expect(await runInit(h.io, CLAUDE, PACK_DEPS)).toBe(0);
    expect(h.writes.some((w) => w.path === CONFIG_FILE)).toBe(false);
    expect(h.files.get(CONFIG_FILE)).toBe(text);
  });

  it("a config written by an older release, listing packs, is left as it is", async () => {
    // Its `enabledPacks` is simply no longer read, so there is nothing to migrate:
    // every pack it does not name is already on.
    const text = configWith({ enabledPacks: ["working-tree"] });
    const h = harness({ files: { [CONFIG_FILE]: text } });
    expect(await runInit(h.io, CLAUDE, PACK_DEPS)).toBe(0);
    expect(h.files.get(CONFIG_FILE)).toBe(text);
    expect(h.out()).not.toContain("Adopted");
  });

  it("init --agent cursor leaves an existing config alone too", async () => {
    const cursor = fakeCursorFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n" },
    });
    const text = configWith({ disabledPacks: ["file-scope"] });
    const h = harness({ files: { [CONFIG_FILE]: text } });
    expect(
      await runInit(
        h.io,
        { agent: "cursor" },
        { ...PACK_DEPS, cursorIo: cursor.io, nodePath: "/n" },
      ),
    ).toBe(0);
    expect(h.writes.some((w) => w.path === CONFIG_FILE)).toBe(false);
    expect(h.files.get(CONFIG_FILE)).toBe(text);
  });
});

describe("status reports the packs that are on, resolved from disabledPacks", () => {
  // OVERRIDE_CATALOG has two packs: working-tree and file-scope.
  it("counts every library pack as on when nothing is disabled", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: VERSION }],
      files: { [CONFIG_FILE]: configWith({}) },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG });
    expect(h.out()).toContain("across 2 of 2 packs");
    expect(h.out()).not.toContain("PROBLEM");
  });

  it("counts a disabled pack as off", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: VERSION }],
      files: { [CONFIG_FILE]: configWith({ disabledPacks: ["file-scope"] }) },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG });
    expect(h.out()).toContain("across 1 of 2 packs");
  });

  it("says 0 of 2 when every library pack is off", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: VERSION }],
      files: { [CONFIG_FILE]: configWith({ disabledPacks: ["working-tree", "file-scope"] }) },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG });
    expect(h.out()).toContain("Enforcement: ON · 0 guardrails across 0 of 2 packs");
  });

  it("an older config listing packs enforces all of them, and says the list is not read", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: VERSION }],
      files: { [CONFIG_FILE]: configWith({ enabledPacks: ["working-tree"] }) },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG });
    expect(h.out()).toContain("across 2 of 2 packs");
    expect(h.out()).toContain("enabledPacks: is no longer read");
  });

  it("names a misspelled pack in disabledPacks, which disables nothing", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: VERSION }],
      files: { [CONFIG_FILE]: configWith({ disabledPacks: ["file-scop"] }) },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG });
    expect(h.out()).toContain("across 2 of 2 packs");
    expect(h.out()).toContain("disabledPacks.file-scop: is not a pack this build knows about");
  });

  it("does not call a disabled category of your own guardrails a misspelling", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: VERSION }],
      files: {
        [CONFIG_FILE]: configWith({ disabledPacks: ["my-team"] }),
        [`${HOME}/.agenttrail/guard/guardrails.json`]: JSON.stringify([
          {
            id: "local.release-freeze",
            category: "my-team",
            severity: "medium",
            defaultAction: "block",
            title: "Release freeze",
            match: { any_of: [{ kind: "execute_tool", detail_contains: ["./release.sh"] }] },
          },
        ]),
      },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG });
    expect(h.out()).not.toContain("disabledPacks.my-team");
  });
});

describe("status flags a Claude Code plugin older than this guard", () => {
  it("names both versions, the refresh command, and the restart", async () => {
    // Installing a newer guard replaces the files on disk, but Claude Code keeps running
    // its cached copy until `init` refreshes it and Claude Code restarts.
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }] });
    await runStatus(h.io);
    expect(h.out()).toContain(
      `Claude Code is running guard 0.0.9; this is guard ${VERSION}. Refresh it: \`agenttrail-guard init --agent claude\`, then restart Claude Code.`,
    );
  });

  it("never suggests an init that would downgrade a NEWER plugin", async () => {
    // A global `agenttrail-guard` older than the release `npx …@latest init` just installed:
    // its `init` would roll the plugin back, so it must say it is the one out of date.
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID, version: "99.0.0" }] });
    await runStatus(h.io);
    expect(h.out()).toContain(
      `Claude Code is running guard 99.0.0, newer than this guard ${VERSION} — this command is out of date.`,
    );
    expect(h.out()).toContain("npx @agenttrail/guard@latest status");
    expect(h.out()).not.toContain("Refresh it:");
  });

  it("says nothing when the versions match", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID, version: VERSION }] });
    await runStatus(h.io);
    expect(h.out()).not.toContain("Claude Code is running guard");
  });

  it("says nothing when the plugin reports no version", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    // The harness defaults a missing version to 0.1.0, so drop it from the listing itself.
    const list = h.io.runClaude;
    h.io.runClaude = (args) => {
      const res = list(args);
      if (args.join(" ") !== "plugin list --json") return res;
      const rows = JSON.parse(res.stdout).map((p: Record<string, unknown>) => {
        const { version: _drop, ...rest } = p;
        return rest;
      });
      return { ...res, stdout: JSON.stringify(rows) };
    };
    await runStatus(h.io);
    expect(h.out()).toContain("Enforcement: ON");
    expect(h.out()).not.toContain("Claude Code is running guard");
  });

  it("says nothing when the plugin is not installed or is disabled", async () => {
    const none = harness();
    await runStatus(none.io);
    expect(none.out()).not.toContain("Claude Code is running guard");
    const off = harness({ plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9", enabled: false }] });
    await runStatus(off.io);
    expect(off.out()).not.toContain("Claude Code is running guard");
  });
});

describe("status", () => {
  const configFile = `${HOME}/.agenttrail/guard/config.json`;
  const rulesFile = `${HOME}/.agenttrail/guard/guardrails.json`;
  const eventsFile = `${HOME}/.agenttrail/guard/events.jsonl`;

  it("says NOT INSTALLED when nothing is installed", async () => {
    const h = harness();
    expect(await runStatus(h.io)).toBe(0);
    // The whole Claude Code line: Cursor's section says NOT INSTALLED too.
    expect(h.out()).toContain(
      "Enforcement: NOT INSTALLED — run `agenttrail-guard init --agent claude`.",
    );
    expect(h.out()).toContain("agenttrail-guard init --agent claude");
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
          agent: "claude",
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
    expect(h.out()).toContain("the hook does not load a guardrail without one");
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
        agent: "claude",
      }),
    );
    const quiet = JSON.stringify({
      ts: "2026-09-07T00:00:00Z",
      tool: "Bash",
      decision: "deny",
      ruleId: "wt.reset-hard",
      command: "git reset --hard",
      agent: "claude",
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
          `${JSON.stringify({ ts: "", tool: "Bash", decision: "deny", ruleId: "a.b", command: "x", agent: "claude" })}\n` +
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

  it("names the require_approval holds a settings.json allow rule will not prompt", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [CLAUDE_SETTINGS]: JSON.stringify({ permissions: { allow: ["Bash"] } }) },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG, settingsPath: CLAUDE_SETTINGS });
    const out = h.out();
    // The shell hold fires on Bash; the file hold does not, so 1 of 2, naming Bash.
    expect(out).toContain(
      "1 of 2 approval guardrails will not prompt because settings.json allows: Bash",
    );
    expect(out).toContain("Claude Code runs an allowed tool before the guard's hold can ask");
  });

  it("names the file tool when a bare Read allow silences a file hold", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [CLAUDE_SETTINGS]: JSON.stringify({ permissions: { allow: ["Read"] } }) },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG, settingsPath: CLAUDE_SETTINGS });
    expect(h.out()).toContain(
      "1 of 2 approval guardrails will not prompt because settings.json allows: Read",
    );
  });

  it("prints no override line for a missing settings.json or a merely scoped allow", async () => {
    const missing = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    await runStatus(missing.io, { catalog: OVERRIDE_CATALOG, settingsPath: CLAUDE_SETTINGS });
    expect(missing.out()).not.toContain("will not prompt because settings.json allows");

    // A scoped allow is narrower than the whole tool, so it is conservatively not counted.
    const scoped = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [CLAUDE_SETTINGS]: JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }) },
    });
    await runStatus(scoped.io, { catalog: OVERRIDE_CATALOG, settingsPath: CLAUDE_SETTINGS });
    expect(scoped.out()).not.toContain("will not prompt because settings.json allows");
  });

  it("does not print the override line while the guard is not enforcing", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, enabled: false }],
      files: { [CLAUDE_SETTINGS]: JSON.stringify({ permissions: { allow: ["Bash"] } }) },
    });
    await runStatus(h.io, { catalog: OVERRIDE_CATALOG, settingsPath: CLAUDE_SETTINGS });
    expect(h.out()).toContain("Enforcement: OFF");
    expect(h.out()).not.toContain("will not prompt because settings.json allows");
  });

  it("says a logged `ask` is a verdict, not proof of a prompt", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [eventsFile]: JSON.stringify({
          ts: "2026-09-07T00:00:00Z",
          tool: "Bash",
          decision: "ask",
          ruleId: "sh.hold",
          command: "rm -rf $DIR",
          agent: "claude",
        }),
      },
    });
    await runStatus(h.io);
    expect(h.out()).toContain("not confirmation you were prompted");
  });

  it("explains a codex `ask` as the block it actually was", async () => {
    // Claude Code's caveat is about a prompt that may not have happened. On Codex the
    // guard sent a block, so printing that caveat over a codex row states the opposite of
    // what the user experienced.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [eventsFile]: JSON.stringify({
          ts: "2026-09-21T10:40:12Z",
          tool: "Bash",
          decision: "ask",
          ruleId: "ps.permission-widen",
          command: "chmod 777 note.txt",
          agent: "codex",
        }),
      },
    });
    await runStatus(h.io);
    expect(h.out()).toContain("was sent as a block");
    expect(h.out()).not.toContain("not confirmation you were prompted");
  });

  it("gives each app its own sentence when both kinds of ask are logged", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
        [eventsFile]: [
          JSON.stringify({
            ts: "2026-09-21T10:00:00Z",
            tool: "Bash",
            decision: "ask",
            ruleId: "sh.hold",
            command: "rm -rf $DIR",
            agent: "claude",
          }),
          JSON.stringify({
            ts: "2026-09-21T10:40:12Z",
            tool: "Bash",
            decision: "ask",
            ruleId: "ps.permission-widen",
            command: "chmod 777 note.txt",
            agent: "codex",
          }),
        ].join("\n"),
      },
    });
    await runStatus(h.io);
    expect(h.out()).toContain("not confirmation you were prompted");
    expect(h.out()).toContain("was sent as a block");
  });

  it("omits the ask caveat when no decision in the log was an ask", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: {
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
    expect(h.out()).not.toContain("not confirmation you were prompted");
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
    expect(await runInit(h.io, CLAUDE, initDeps)).toBe(0);
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
    await runInit(h.io, CLAUDE, initDeps);
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
    expect(await runInit(h.io, CLAUDE, initDeps)).toBe(0);
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
    expect(await runInit(io, CLAUDE, initDeps)).toBe(0);
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
    await runInit(h.io, CLAUDE, initDeps);
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
    expect(h.out()).toContain(
      "Enforcement: NOT INSTALLED — run `agenttrail-guard init --agent claude`.",
    );
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
    expect(await runInit(h.io, { ...CLAUDE, print: true }, initDeps)).toBe(0);
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
    await runInit(h.io, { ...CLAUDE, print: true }, initDeps);
    expect(h.out()).toContain("nothing to do");
    expect(h.out()).toContain("already installed at 0.1.0");
  });

  it("describes an UPDATE when the installed version is behind the bundled one", async () => {
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }],
      marketplaces: [{ name: "agenttrail-guard", path: SCAFFOLD }],
    });
    await runInit(h.io, { ...CLAUDE, print: true }, initDeps);
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
    expect(await runInit(io, { ...CLAUDE, print: true }, initDeps)).toBe(0);
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
      await runInit(h.io, { ...CLAUDE, print: true }, initDeps);
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
    agent: "claude",
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
        agent: "claude",
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

  /** A log of `n` identical records for a real library rule and command. */
  function libraryLog(ruleId: string, command: string, n = 3): string {
    return `${Array.from({ length: n }, () =>
      JSON.stringify({
        ts: "2026-09-07T00:00:00Z",
        tool: "Bash",
        decision: "deny",
        ruleId,
        command,
        agent: "claude",
      }),
    ).join("\n")}\n`;
  }

  it("explains instead of suggesting when the shape is the guardrail's own block fixture", async () => {
    // `git reset --hard` is exactly what wt.reset-hard exists to stop, so silencing that
    // shape would blind the guardrail — the suggester must not propose it.
    const h = harness({
      plugins: [{ id: GUARD_PLUGIN_ID }],
      files: { [eventsFile]: libraryLog("wt.reset-hard", "git reset --hard") },
    });
    await runStatus(h.io);
    const out = h.out();

    expect(out).toContain("Most frequent match");
    expect(out).toContain("wt.reset-hard");
    expect(out).toContain("blind the guardrail to its own purpose");
    expect(out).not.toContain(silenceCommand("wt.reset-hard", "git reset --hard"));
  });
});

describe("uninstall", () => {
  it("removes ours and says the rest is untouched", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    expect(await runUninstall(h.io, CLAUDE)).toBe(0);
    expect(h.ran(`plugin uninstall ${GUARD_PLUGIN_ID} --scope user`)).toBe(true);
    expect(h.out()).toContain("untouched");
  });

  it("running it twice is not an error", async () => {
    const h = harness({ plugins: [] });
    expect(await runUninstall(h.io, CLAUDE)).toBe(0);
    expect(h.out()).toContain("not installed");
    expect(h.ran("plugin uninstall")).toBe(false);
  });

  it("keeps the user's own settings and says where they are", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    await runUninstall(h.io, CLAUDE);
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
    expect(await runUninstall(io, CLAUDE)).toBe(1);
  });

  const PLUGIN_CACHE_DIR = `${HOME}/.claude/plugins/cache/agenttrail-guard/agenttrail-guard`;

  it("clears the plugin's stale cache version directories on uninstall", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    const removed: string[] = [];
    const io: SetupIO = {
      ...h.io,
      readdir: (p) => (p === PLUGIN_CACHE_DIR ? ["0.0.9", "0.1.0"] : undefined),
      removeDirRecursive: (p) => {
        removed.push(p);
      },
    };
    expect(await runUninstall(io, CLAUDE)).toBe(0);
    expect(removed).toContain(PLUGIN_CACHE_DIR);
    expect(h.out()).toContain("Cleared 2 stale plugin cache directories");
  });

  it("clears leftover cache directories even when the plugin is not installed", async () => {
    // Stale version dirs outlive an uninstall the vendor already did, so "not installed"
    // is exactly when they may still be there.
    const h = harness({ plugins: [] });
    const removed: string[] = [];
    const io: SetupIO = {
      ...h.io,
      readdir: (p) => (p === PLUGIN_CACHE_DIR ? ["0.1.0"] : undefined),
      removeDirRecursive: (p) => {
        removed.push(p);
      },
    };
    expect(await runUninstall(io, CLAUDE)).toBe(0);
    expect(removed).toContain(PLUGIN_CACHE_DIR);
    expect(h.out()).toContain("Cleared 1 stale plugin cache directory");
  });

  it("does not fail when there is no cache directory to clear", async () => {
    const h = harness({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    const io: SetupIO = {
      ...h.io,
      readdir: () => undefined,
      removeDirRecursive: () => {
        throw new Error("should not be called when nothing to clear");
      },
    };
    expect(await runUninstall(io, CLAUDE)).toBe(0);
    expect(h.out()).not.toContain("stale plugin cache");
  });
});

describe("init and uninstall require an --agent they can act on", () => {
  /**
   * What `parseArgs` hands on for no flag, a lone `--agent`, `--agent x` and
   * `--agent --print`, plus near misses and `--print` alone.
   */
  const REFUSED: Array<[string, { agent?: string | boolean; print?: boolean }]> = [
    ["no flag", {}],
    ["a lone --agent", { agent: true }],
    ["--agent x", { agent: "x" }],
    ["--agent --print", { agent: "--print" }],
    ["--agent Cursor", { agent: "Cursor" }],
    ["an empty --agent", { agent: "" }],
    ["--print and no --agent", { print: true }],
  ];

  /**
   * Dependencies that throw when read, so a refusal that looked at any of them — the plugin
   * folder, the Cursor file seam — fails instead of passing.
   */
  const untouchable = new Proxy(
    {},
    {
      get: (_target, key) => {
        throw new Error(`deps.${String(key)} was read before --agent was checked`);
      },
    },
  );

  /** A harness whose every read, write and spawn is recorded. */
  function recorded() {
    const h = harness();
    const touched: string[] = [];
    const io: SetupIO = {
      ...h.io,
      readFile: (p) => {
        touched.push(`read ${p}`);
        return h.io.readFile(p);
      },
      exists: (p) => {
        touched.push(`exists ${p}`);
        return h.io.exists(p);
      },
      homedir: () => {
        touched.push("homedir");
        return HOME;
      },
    };
    return { h, io, touched };
  }

  it.each(
    REFUSED,
  )("init with %s: the choice, exit 1, nothing read, written or run", async (_l, argv) => {
    const { h, io, touched } = recorded();
    expect(await runInit(io, argv, untouchable as InitDeps)).toBe(1);
    expect(h.out()).toContain("choose --agent claude, --agent cursor or --agent codex");
    expect(h.out()).toContain("agenttrail-guard init --agent cursor");
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(touched).toEqual([]);
  });

  it.each(
    REFUSED,
  )("uninstall with %s: the choice, exit 1, nothing read, written or run", async (_l, argv) => {
    const { h, io, touched } = recorded();
    expect(await runUninstall(io, argv, untouchable as UninstallDeps)).toBe(1);
    expect(h.out()).toContain("choose --agent claude, --agent cursor or --agent codex");
    expect(h.out()).toContain("agenttrail-guard uninstall --agent claude");
    expect(h.writes).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(touched).toEqual([]);
  });
});

describe("--agent codex names an app both commands act on", () => {
  it("offers codex in the choice message, and the menu agrees with what the commands do", () => {
    // The two have to agree: a menu that hides `codex` while `chosenAgent` accepts it, or
    // one that offers it with no branch behind it, are both lies.
    expect(agentChoiceMessage("init")).toContain("--agent codex");
    expect(agentChoiceMessage("init")).toContain("for Codex CLI");
  });

  it("init --agent codex does not fall through to the Claude Code path", async () => {
    // The failure the checked switch exists to prevent: installing a Claude Code plugin
    // and reporting success for an app that has none.
    const h = harness();
    const codex = fakeCodexFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n" },
    });
    expect(
      await runInit(h.io, { agent: "codex" }, { ...initDeps, codexIo: codex.io, nodePath: "/n" }),
    ).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out()).not.toContain(GUARD_PLUGIN_ID);
    expect(h.out()).toContain("Installed for Codex CLI");
  });

  it("uninstall --agent codex removes nothing of Claude Code's", async () => {
    const h = harness();
    const codex = fakeCodexFiles();
    expect(await runUninstall(h.io, { agent: "codex" }, { codexIo: codex.io })).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out()).toContain("Guard is not installed for Codex CLI — nothing to remove.");
    expect(h.out()).not.toContain(GUARD_PLUGIN_ID);
  });
});

describe("--agent cursor writes only guard's folder and Cursor's user hooks file", () => {
  const HOOKS = `${HOME}/.cursor/hooks.json`;
  const GUARD = `${HOME}/.agenttrail/guard/`;

  it("init NEVER writes outside ~/.agenttrail/guard/ except ~/.cursor/hooks.json, and runs no claude", async () => {
    // The same kind of promise `init --agent claude` makes above, over the recorded writes of
    // both seams rather than the output.
    const h = harness();
    const cursor = fakeCursorFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n" },
    });
    const deps = { ...initDeps, cursorIo: cursor.io, nodePath: "/usr/local/bin/node" };
    expect(await runInit(h.io, { agent: "cursor" }, deps)).toBe(0);

    const paths = [...h.writes.map((w) => w.path), ...cursor.writes.map((w) => w.path)];
    // Both places were written, so the loop below is not checking an empty list.
    expect(paths).toContain(HOOKS);
    expect(paths.filter((p) => p.startsWith(GUARD)).length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith(GUARD) || path === HOOKS, path).toBe(true);
    }
    expect(paths.some((p) => p.includes(".claude"))).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("closes with the run-mode approval note — the Cursor analogue of the settings.json hold disclosure", async () => {
    const h = harness();
    const cursor = fakeCursorFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n" },
    });
    await runInit(h.io, { agent: "cursor" }, { ...initDeps, cursorIo: cursor.io, nodePath: "/n" });
    expect(h.out()).toContain("Cursor's own run mode auto-approves the command first");
  });

  it("uninstall changes nothing outside those two places either, and runs no claude", async () => {
    const h = harness();
    const cursor = fakeCursorFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n" },
    });
    await runInit(h.io, { agent: "cursor" }, { ...initDeps, cursorIo: cursor.io, nodePath: "/n" });
    const before = cursor.writes.length;

    expect(await runUninstall(h.io, { agent: "cursor" }, { cursorIo: cursor.io })).toBe(0);
    const changed = [...cursor.writes.slice(before).map((w) => w.path), ...cursor.deletes];
    expect(changed).toContain(HOOKS);
    for (const path of changed) {
      expect(path.startsWith(GUARD) || path === HOOKS, path).toBe(true);
    }
    expect(h.calls).toEqual([]);
  });
});

describe("--agent codex writes only guard's folder and Codex's user hooks file", () => {
  const HOOKS = `${HOME}/.codex/hooks.json`;
  const GUARD = `${HOME}/.agenttrail/guard/`;

  it("init NEVER writes outside ~/.agenttrail/guard/ except ~/.codex/hooks.json, and runs no claude", async () => {
    const h = harness();
    const codex = fakeCodexFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n" },
    });
    const deps = { ...initDeps, codexIo: codex.io, nodePath: "/usr/local/bin/node" };
    expect(await runInit(h.io, { agent: "codex" }, deps)).toBe(0);

    const paths = [...h.writes.map((w) => w.path), ...codex.writes.map((w) => w.path)];
    // Both places were written, so the loop below is not checking an empty list.
    expect(paths).toContain(HOOKS);
    expect(paths.filter((p) => p.startsWith(GUARD)).length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith(GUARD) || path === HOOKS, path).toBe(true);
    }
    // Never Codex's other hooks layer: the two AGGREGATE, so an entry in both would run
    // guard twice for one tool call.
    expect(paths.some((p) => p.includes("config.toml"))).toBe(false);
    expect(paths.some((p) => p.includes(".cursor"))).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("closes by naming the approval step, without which Codex never runs the hook", async () => {
    const h = harness();
    const codex = fakeCodexFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n" },
    });
    await runInit(h.io, { agent: "codex" }, { ...initDeps, codexIo: codex.io, nodePath: "/n" });
    expect(h.out()).toContain("NEXT STEP — until you do this, guard checks nothing:");
    expect(h.out()).toContain("run /hooks");
  });

  it("uninstall changes nothing outside those two places either, and runs no claude", async () => {
    const h = harness();
    const codex = fakeCodexFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n" },
    });
    await runInit(h.io, { agent: "codex" }, { ...initDeps, codexIo: codex.io, nodePath: "/n" });
    const before = codex.writes.length;

    expect(await runUninstall(h.io, { agent: "codex" }, { codexIo: codex.io })).toBe(0);
    const changed = [...codex.writes.slice(before).map((w) => w.path), ...codex.deletes];
    expect(changed).toContain(HOOKS);
    for (const path of changed) {
      expect(path.startsWith(GUARD) || path === HOOKS, path).toBe(true);
    }
    expect(h.calls).toEqual([]);
  });
});

// ── status: one section per app ──────────────────────────────────────────────

const CURSOR_HOOKS = `${HOME}/.cursor/hooks.json`;
const HOOK_COPY = `${HOME}/.agenttrail/guard/cursor/guard-hook.mjs`;
const INSTALL_RECORD = `${HOME}/.agenttrail/guard/cursor/install.json`;
const CRASHES = `${HOME}/.agenttrail/guard/crashes`;
const NODE = "/usr/local/bin/node";
/** The command `init --agent cursor` writes for `NODE` and `HOOK_COPY`. */
const GUARD_COMMAND = `"${NODE}" "${HOOK_COPY}" --agent cursor`;

const CODEX_HOOKS = `${HOME}/.codex/hooks.json`;
const CODEX_COPY = `${HOME}/.agenttrail/guard/codex/guard-hook.mjs`;
const CODEX_RECORD = `${HOME}/.agenttrail/guard/codex/install.json`;
/** The command `init --agent codex` writes for `NODE` and `CODEX_COPY`. */
const CODEX_COMMAND = `"${NODE}" "${CODEX_COPY}" --agent codex`;

const CLAUDE_NOT_INSTALLED =
  "Enforcement: NOT INSTALLED — run `agenttrail-guard init --agent claude`.";
const CURSOR_NOT_INSTALLED =
  "Enforcement: NOT INSTALLED — run `agenttrail-guard init --agent cursor`.";
const CURSOR_AGAIN = "Run `agenttrail-guard init --agent cursor` again.";
const AGENT_WINDOW = "Cursor's Agent Window can skip hooks";
const CODEX_NOT_INSTALLED =
  "Enforcement: NOT INSTALLED — run `agenttrail-guard init --agent codex`.";
const CODEX_AGAIN = "Run `agenttrail-guard init --agent codex` again.";
const CODEX_APPROVE_AGAIN = "Approve it again in Codex's /hooks screen.";
const TRUST_NOTE = "Codex runs a hook only once you approve it in Codex's /hooks screen";

function hooksText(hooks: unknown): string {
  return JSON.stringify({ version: 1, hooks });
}

/** Codex's file, which carries no `version`. */
function codexHooksText(hooks: unknown): string {
  return JSON.stringify({ hooks });
}

/** The entry `init --agent codex` writes, with a field changed to break it. */
function codexEntry(over: Record<string, unknown> = {}, handler: Record<string, unknown> = {}) {
  return {
    matcher: ".*",
    hooks: [{ type: "command", command: CODEX_COMMAND, timeout: 10, ...handler }],
    ...over,
  };
}

function hookEntry(command: string = GUARD_COMMAND): { command: string; timeout: number } {
  return { command, timeout: 10 };
}

/** Cursor's files with guard installed and working. */
const WORKING: Record<string, string> = {
  [CURSOR_HOOKS]: hooksText({ preToolUse: [hookEntry()], beforeShellExecution: [hookEntry()] }),
  [NODE]: "",
  [HOOK_COPY]: "// hook\n",
};

/** `WORKING` without one file. */
function workingWithout(path: string): Record<string, string> {
  return Object.fromEntries(Object.entries(WORKING).filter(([key]) => key !== path));
}

/** Codex's files with guard installed, working, and still where it was installed. */
const CODEX_WORKING: Record<string, string> = {
  [CODEX_HOOKS]: codexHooksText({
    PreToolUse: [codexEntry()],
    PermissionRequest: [codexEntry()],
  }),
  [NODE]: "",
  [CODEX_COPY]: "// hook\n",
};

/** `CODEX_WORKING` without one file. */
function codexWorkingWithout(path: string): Record<string, string> {
  return Object.fromEntries(Object.entries(CODEX_WORKING).filter(([key]) => key !== path));
}

/** `CODEX_WORKING` with another `hooks.json`. */
function codexWith(hooks: unknown): Record<string, string> {
  return { ...CODEX_WORKING, [CODEX_HOOKS]: codexHooksText(hooks) };
}

/** `install.json` recording `guardVersion`. */
function installRecord(guardVersion: string): string {
  return JSON.stringify({
    installedAt: "2026-09-01T00:00:00.000Z",
    hookPath: HOOK_COPY,
    nodePath: NODE,
    guardVersion,
  });
}

/** Codex's `install.json`, which also records where each entry was written. */
function codexInstallRecord(
  guardVersion: string = VERSION,
  groupIndex: Record<string, number> = { PreToolUse: 0, PermissionRequest: 0 },
): string {
  return JSON.stringify({
    installedAt: "2026-09-01T00:00:00.000Z",
    hookPath: CODEX_COPY,
    nodePath: NODE,
    guardVersion,
    groupIndex,
  });
}

/** The Claude Code section: everything before the first blank line. */
function claudeSection(out: string): string {
  return out.split("\n\n")[0] ?? "";
}

/** The Cursor section: its heading, to the blank line that ends it. */
function cursorSection(out: string): string {
  const start = out.indexOf("\nCursor\n");
  expect(start, out).toBeGreaterThanOrEqual(0);
  return out.slice(start + 1).split("\n\n")[0] ?? "";
}

/** The Codex CLI section: its heading, to the blank line that ends it. */
function codexSection(out: string): string {
  const start = out.indexOf("\nCodex CLI\n");
  expect(start, out).toBeGreaterThanOrEqual(0);
  return out.slice(start + 1).split("\n\n")[0] ?? "";
}

/** One crash record, as the spool holds it. */
function crashRecord(command: string, ts: string): string {
  return JSON.stringify({
    v: 1,
    ts,
    guardVersion: "0.2.0",
    nodeVersion: "v22.14.0",
    platform: "darwin",
    command,
    errorName: "TypeError",
    frames: "",
  });
}

/**
 * Three hook records, whose newest time is NOT in the last file by name, a `scan` record newer
 * than all of them, and a file whose name the spool does not use.
 */
const SPOOL: Record<string, string> = {
  [`${CRASHES}/crash-1757462400000-aaaa1111.json`]: crashRecord("hook", "2026-09-10T00:00:00.000Z"),
  [`${CRASHES}/crash-1757635200000-bbbb2222.json`]: crashRecord("hook", "2026-09-14T08:30:00.000Z"),
  [`${CRASHES}/crash-1757721600000-cccc3333.json`]: crashRecord("hook", "2026-09-12T00:00:00.000Z"),
  [`${CRASHES}/crash-1757808000000-dddd4444.json`]: crashRecord("scan", "2026-09-15T00:00:00.000Z"),
  [`${CRASHES}/notes.json`]: crashRecord("hook", "2026-09-16T00:00:00.000Z"),
};
const CRASH_LINE =
  "Crash records from guard's hook (shared by Claude Code, Cursor and Codex): 3, newest 2026-09-14T08:30:00.000Z.";

/** `status` over every seam's fake, with each read of `SetupIO` recorded. */
async function statusOver(
  options: {
    cursor?: FakeCursorFilesOptions;
    codex?: FakeCodexFilesOptions;
    spool?: Record<string, string>;
    setup?: Parameters<typeof harness>[0];
    runClaude?: (h: Harness) => ClaudeRunner;
  } = {},
) {
  const h = harness(options.setup);
  const setupReads: string[] = [];
  const io: SetupIO = {
    ...h.io,
    readFile: (path) => {
      setupReads.push(path);
      return h.io.readFile(path);
    },
    runClaude: options.runClaude?.(h) ?? h.io.runClaude,
  };
  const cursor = fakeCursorFiles(options.cursor);
  const codex = fakeCodexFiles(options.codex);
  const guard = fakeGuardIo({ files: options.spool });
  const code = await runStatus(io, { cursorIo: cursor.io, codexIo: codex.io, guardIo: guard.io });
  return { code, out: h.out(), h, setupReads, cursor, codex, guard };
}

/** A `claude` that cannot be started, recording what was asked of it. */
function missingClaude(calls: string[][]): ClaudeRunner {
  return (args) => {
    calls.push([...args]);
    return { code: null, stdout: "", stderr: "", spawnError: "ENOENT" };
  };
}

describe("status: the Claude Code section", () => {
  it("says Claude Code was not found when `claude` cannot start, and reads no plugin state", async () => {
    const calls: string[][] = [];
    const { code, out } = await statusOver({
      setup: {
        plugins: [{ id: GUARD_PLUGIN_ID }],
        marketplaces: [{ name: "agenttrail-guard", path: "/gone" }],
        missingPaths: ["/gone"],
      },
      runClaude: () => missingClaude(calls),
    });
    expect(code).toBe(0);
    expect(claudeSection(out)).toMatch(
      /^Claude Code: not found\. Once it is installed, run `agenttrail-guard init --agent claude`\./,
    );
    // The version check is the only spawn: no `plugin list`, no `marketplace list`.
    expect(calls).toEqual([["--version"]]);
    expect(out).not.toContain(CLAUDE_NOT_INSTALLED);
    expect(out).not.toContain("Enforcement: ON");
    expect(out).not.toContain("plugin source is missing");
    // The other two sections are still reported.
    expect(cursorSection(out)).toBe(`Cursor\n${CURSOR_NOT_INSTALLED}`);
    expect(codexSection(out)).toBe(`Codex CLI\n${CODEX_NOT_INSTALLED}`);
  });

  it("an older `claude` still goes through today's plugin reads", async () => {
    const { out, h } = await statusOver({
      setup: { plugins: [{ id: GUARD_PLUGIN_ID }] },
      runClaude: (harnessed) => (args) =>
        args[0] === "--version"
          ? { code: 0, stdout: "2.0.1 (Claude Code)", stderr: "" }
          : harnessed.io.runClaude(args),
    });
    expect(h.ran("plugin list --json")).toBe(true);
    expect(claudeSection(out)).toMatch(/^Claude Code\nEnforcement: ON · \d+ guardrails/);
    expect(out).not.toContain("Claude Code: not found");
  });

  it("a `claude --version` that throws for another reason still goes through the plugin reads", async () => {
    const { out, h } = await statusOver({
      setup: { plugins: [{ id: GUARD_PLUGIN_ID }] },
      runClaude: (harnessed) => (args) => {
        if (args[0] === "--version") throw new Error("EPIPE");
        return harnessed.io.runClaude(args);
      },
    });
    expect(h.ran("plugin list --json")).toBe(true);
    expect(claudeSection(out)).toMatch(/^Claude Code\nEnforcement: ON · /);
    expect(out).not.toContain("Claude Code: not found");
  });

  it("names the active bundle path so the running version is unambiguous", async () => {
    const { out } = await statusOver({
      setup: { plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }] },
    });
    expect(claudeSection(out)).toContain(
      "Active bundle: /home/test/.claude/plugins/cache/agenttrail-guard/agenttrail-guard/0.1.0",
    );
  });

  it("shows the active version alone when the bundle path is not where it is expected", async () => {
    const bundle = "/home/test/.claude/plugins/cache/agenttrail-guard/agenttrail-guard/0.1.0";
    const { out } = await statusOver({
      setup: { plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }], missingPaths: [bundle] },
    });
    expect(claudeSection(out)).toContain("Active version: 0.1.0");
    expect(claudeSection(out)).not.toContain("Active bundle:");
  });
});

describe("status: the Cursor section", () => {
  it("is ON when both entries run guard's command and the Node and hook copy exist", async () => {
    const { code, out } = await statusOver({ cursor: { files: WORKING } });
    expect(code).toBe(0);
    const section = cursorSection(out);
    expect(section).toMatch(/^Cursor\nEnforcement: ON · \d+ guardrails/);
    expect(section).toContain(AGENT_WINDOW);
    expect(section).not.toContain("BROKEN");
    expect(section).not.toContain("Installed by guard");
  });

  it.each<[string, Record<string, string>]>([
    ["there is no hooks.json", {}],
    [
      "hooks.json has no guard entry",
      { [CURSOR_HOOKS]: hooksText({ preToolUse: [hookEntry("node other-hook.mjs")] }) },
    ],
    ["hooks.json has an empty hooks object", { [CURSOR_HOOKS]: hooksText({}) }],
    [
      "guard's two lists are empty",
      { [CURSOR_HOOKS]: hooksText({ preToolUse: [], beforeShellExecution: [] }) },
    ],
  ])("is NOT INSTALLED, with nothing else in the section, when %s", async (_label, files) => {
    const { out } = await statusOver({ cursor: { files: { ...files, [NODE]: "" } } });
    expect(cursorSection(out)).toBe(`Cursor\n${CURSOR_NOT_INSTALLED}`);
  });

  it.each<[string, FakeCursorFilesOptions, string]>([
    [
      "only the preToolUse entry is there",
      { files: { ...WORKING, [CURSOR_HOOKS]: hooksText({ preToolUse: [hookEntry()] }) } },
      `${CURSOR_HOOKS} has guard's preToolUse entry but not its beforeShellExecution entry`,
    ],
    [
      "only the beforeShellExecution entry is there",
      { files: { ...WORKING, [CURSOR_HOOKS]: hooksText({ beforeShellExecution: [hookEntry()] }) } },
      `${CURSOR_HOOKS} has guard's beforeShellExecution entry but not its preToolUse entry`,
    ],
    [
      "the Node is missing",
      { files: workingWithout(NODE) },
      `the Node that guard's preToolUse entry runs is missing: ${NODE}`,
    ],
    [
      "the hook copy is missing",
      { files: workingWithout(HOOK_COPY) },
      `the hook copy that guard's preToolUse entry runs is missing: ${HOOK_COPY}`,
    ],
    [
      "hooks.json is not valid JSON",
      { files: { ...WORKING, [CURSOR_HOOKS]: "{ not json" } },
      `${CURSOR_HOOKS} is not valid JSON`,
    ],
    [
      "a hook list is not an array",
      {
        files: {
          ...WORKING,
          [CURSOR_HOOKS]: hooksText({
            preToolUse: hookEntry(),
            beforeShellExecution: [hookEntry()],
          }),
        },
      },
      `${CURSOR_HOOKS} has a "preToolUse" hook list that is not an array`,
    ],
    [
      "a guard entry's command is not quoted the way guard writes it",
      {
        files: {
          ...WORKING,
          [CURSOR_HOOKS]: hooksText({
            preToolUse: [hookEntry(`${NODE} ${HOOK_COPY} --agent cursor`)],
            beforeShellExecution: [hookEntry()],
          }),
        },
      },
      `guard's preToolUse entry in ${CURSOR_HOOKS} runs a command in a form guard does not write`,
    ],
    [
      "a guard entry's command carries an extra flag",
      {
        files: {
          ...WORKING,
          [CURSOR_HOOKS]: hooksText({
            preToolUse: [hookEntry()],
            beforeShellExecution: [hookEntry(`${GUARD_COMMAND} --verbose`)],
          }),
        },
      },
      `guard's beforeShellExecution entry in ${CURSOR_HOOKS} runs a command in a form guard does not write`,
    ],
    [
      "hooks.json cannot be read",
      { files: WORKING, failReads: [CURSOR_HOOKS] },
      `could not read ${CURSOR_HOOKS} — EACCES`,
    ],
    [
      "the Node cannot be checked",
      { files: WORKING, failReads: [NODE] },
      `could not check ${NODE} — EACCES`,
    ],
  ])("is BROKEN, with the reason and the fix, when %s", async (_label, cursor, reason) => {
    const { code, out } = await statusOver({ cursor });
    expect(code).toBe(0);
    const section = cursorSection(out);
    expect(section).toContain(`\nEnforcement: BROKEN — ${reason}`);
    expect(section).toContain(`\n  ${CURSOR_AGAIN}`);
    expect(section).toContain(AGENT_WINDOW);
    expect(section).not.toContain("Enforcement: ON");
    expect(section).not.toContain("NOT INSTALLED");
  });

  it("says when install.json records another guard version, and how to refresh", async () => {
    const { out } = await statusOver({
      cursor: { files: { ...WORKING, [INSTALL_RECORD]: installRecord("0.0.1") } },
    });
    expect(VERSION).not.toBe("0.0.1");
    expect(cursorSection(out)).toContain(
      `\n  Installed by guard 0.0.1; this is guard ${VERSION}. Refresh it: \`agenttrail-guard init --agent cursor\``,
    );
  });

  it("never suggests an init that would downgrade a NEWER Cursor install", async () => {
    const { out } = await statusOver({
      cursor: { files: { ...WORKING, [INSTALL_RECORD]: installRecord("99.0.0") } },
    });
    const section = cursorSection(out);
    expect(section).toContain(
      `Installed by guard 99.0.0, newer than this guard ${VERSION} — this command is out of date.`,
    );
    expect(section).toContain("npm install -g @agenttrail/guard@latest");
    expect(section).not.toContain("Refresh it:");
  });

  it("shows the version difference on a BROKEN install too", async () => {
    const { out } = await statusOver({
      cursor: { files: { ...workingWithout(HOOK_COPY), [INSTALL_RECORD]: installRecord("0.0.1") } },
    });
    const section = cursorSection(out);
    expect(section).toContain("Enforcement: BROKEN");
    expect(section).toContain("Installed by guard 0.0.1");
  });

  it.each<[string, Record<string, string>]>([
    ["install.json records this version", { ...WORKING, [INSTALL_RECORD]: installRecord(VERSION) }],
    ["there is no install.json", WORKING],
    ["install.json is not JSON", { ...WORKING, [INSTALL_RECORD]: "{" }],
    [
      "guard is not installed for Cursor",
      { [INSTALL_RECORD]: installRecord("0.0.1"), [NODE]: "", [HOOK_COPY]: "// hook\n" },
    ],
  ])("says nothing about the version when %s", async (_label, files) => {
    const { out } = await statusOver({ cursor: { files } });
    expect(out).not.toContain("Installed by guard");
  });

  it.each<[string, boolean, Record<string, string>]>([
    ["ON", true, WORKING],
    ["BROKEN", true, workingWithout(HOOK_COPY)],
    ["NOT INSTALLED", false, {}],
  ])("when Cursor is %s, the Agent Window line is shown: %s", async (_state, shown, files) => {
    const { out } = await statusOver({ cursor: { files } });
    expect(out.split(AGENT_WINDOW).length - 1).toBe(shown ? 1 : 0);
    expect(cursorSection(out).includes(AGENT_WINDOW)).toBe(shown);
  });

  const RUN_MODE = "Cursor's own run mode auto-approves the command first";

  it.each<[string, boolean, Record<string, string>]>([
    ["ON", true, WORKING],
    ["BROKEN", true, workingWithout(HOOK_COPY)],
    ["NOT INSTALLED", false, {}],
  ])("when Cursor is %s, the run-mode approval note is shown: %s — the Cursor analogue of the settings.json hold disclosure", async (_state, shown, files) => {
    const { out } = await statusOver({ cursor: { files } });
    expect(cursorSection(out).includes(RUN_MODE)).toBe(shown);
  });
});

describe("status: the Codex CLI section", () => {
  it("is ON when both entries are the entry guard writes, the files exist and nothing has moved", async () => {
    const { code, out } = await statusOver({
      codex: { files: { ...CODEX_WORKING, [CODEX_RECORD]: codexInstallRecord() } },
    });
    expect(code).toBe(0);
    const section = codexSection(out);
    expect(section).toMatch(/^Codex CLI\nEnforcement: ON · \d+ guardrails/);
    expect(section).toContain(TRUST_NOTE);
    expect(section).not.toContain("BROKEN");
    expect(section).not.toContain("Installed by guard");
  });

  it.each<[string, Record<string, string>]>([
    ["there is no hooks.json", {}],
    [
      "hooks.json has no guard entry",
      { [CODEX_HOOKS]: codexHooksText({ PreToolUse: [{ matcher: ".*", hooks: [] }] }) },
    ],
    ["hooks.json has an empty hooks object", { [CODEX_HOOKS]: codexHooksText({}) }],
    [
      "guard's two lists are empty",
      { [CODEX_HOOKS]: codexHooksText({ PreToolUse: [], PermissionRequest: [] }) },
    ],
  ])("is NOT INSTALLED, with nothing else in the section, when %s", async (_label, files) => {
    const { out } = await statusOver({ codex: { files: { ...files, [NODE]: "" } } });
    expect(codexSection(out)).toBe(`Codex CLI\n${CODEX_NOT_INSTALLED}`);
  });

  it.each<[string, FakeCodexFilesOptions, string]>([
    [
      "only the PreToolUse entry is there",
      { files: codexWith({ PreToolUse: [codexEntry()] }) },
      `${CODEX_HOOKS} has guard's PreToolUse entry but not its PermissionRequest entry`,
    ],
    [
      "only the PermissionRequest entry is there",
      { files: codexWith({ PermissionRequest: [codexEntry()] }) },
      `${CODEX_HOOKS} has guard's PermissionRequest entry but not its PreToolUse entry`,
    ],
    [
      "the Node is missing",
      { files: codexWorkingWithout(NODE) },
      `the Node that guard's PreToolUse entry runs is missing: ${NODE}`,
    ],
    [
      "the hook copy is missing",
      { files: codexWorkingWithout(CODEX_COPY) },
      `the hook copy that guard's PreToolUse entry runs is missing: ${CODEX_COPY}`,
    ],
    [
      "hooks.json is not valid JSON",
      { files: { ...CODEX_WORKING, [CODEX_HOOKS]: "{ not json" } },
      `${CODEX_HOOKS} is not valid JSON`,
    ],
    [
      "an event list is not an array",
      {
        files: codexWith({ PreToolUse: codexEntry(), PermissionRequest: [codexEntry()] }),
      },
      `${CODEX_HOOKS} has a "PreToolUse" hook list that is not an array`,
    ],
    [
      "a hook group is not an object",
      { files: codexWith({ PreToolUse: ["./x.sh"], PermissionRequest: [codexEntry()] }) },
      `${CODEX_HOOKS} has a "PreToolUse" hook that is not an object`,
    ],
    [
      "a guard entry's command is not quoted the way guard writes it",
      {
        files: codexWith({
          PreToolUse: [
            {
              matcher: ".*",
              hooks: [
                {
                  type: "command",
                  command: `${NODE} ${CODEX_COPY} --agent codex`,
                  timeout: 10,
                },
              ],
            },
          ],
          PermissionRequest: [codexEntry()],
        }),
      },
      `guard's PreToolUse entry in ${CODEX_HOOKS} runs a command in a form guard does not write`,
    ],
    [
      "hooks.json cannot be read",
      { files: CODEX_WORKING, failReads: [CODEX_HOOKS] },
      `could not read ${CODEX_HOOKS} — EACCES`,
    ],
    [
      "the Node cannot be checked",
      { files: CODEX_WORKING, failReads: [NODE] },
      `could not check ${NODE} — EACCES`,
    ],
    [
      "install.json records an install whose hooks.json is gone",
      { files: { [CODEX_RECORD]: codexInstallRecord(), [NODE]: "" } },
      `guard is recorded as installed for Codex CLI, but there is no ${CODEX_HOOKS}`,
    ],
    [
      "install.json records an install whose entries are gone",
      {
        files: {
          [CODEX_HOOKS]: codexHooksText({ Stop: [{ matcher: ".*", hooks: [] }] }),
          [CODEX_RECORD]: codexInstallRecord(),
          [NODE]: "",
        },
      },
      `guard is recorded as installed for Codex CLI, but ${CODEX_HOOKS} holds no guard entry`,
    ],
  ])("is BROKEN, with the reason and the fix, when %s", async (_label, codex, reason) => {
    const { code, out } = await statusOver({ codex });
    expect(code).toBe(0);
    const section = codexSection(out);
    expect(section).toContain(`\nEnforcement: BROKEN — ${reason}`);
    expect(section).toContain(`\n  ${CODEX_AGAIN}`);
    expect(section).toContain(TRUST_NOTE);
    expect(section).not.toContain("Enforcement: ON");
    expect(section).not.toContain("NOT INSTALLED");
  });

  it.each<[string, Record<string, unknown>]>([
    ["a matcher guard does not write", codexEntry({ matcher: "Bash" })],
    ["a timeout guard does not write", codexEntry({}, { timeout: 11 })],
    ["a handler type guard does not write", codexEntry({}, { type: "shell" })],
    [
      "a second handler beside guard's, which moves guard's handler index",
      {
        matcher: ".*",
        hooks: [
          { type: "command", command: "./mine.sh" },
          { type: "command", command: CODEX_COMMAND, timeout: 10 },
        ],
      },
    ],
  ])(// Codex hashes the whole entry, so any of these is an entry no approval matches — the
  // hook is installed and not running, which nothing else reports.
  "is BROKEN when guard's entry has %s", async (_label, entry) => {
    const { out } = await statusOver({
      codex: { files: codexWith({ PreToolUse: [entry], PermissionRequest: [codexEntry()] }) },
    });
    expect(codexSection(out)).toContain(
      `Enforcement: BROKEN — guard's PreToolUse entry in ${CODEX_HOOKS} is not the entry guard writes, so Codex's approval of it no longer applies.`,
    );
  });

  it("is BROKEN when guard's entry has moved, and says to approve it again rather than to re-init", async () => {
    // Another tool put a hook ahead of guard's. Codex's approval is recorded by position,
    // so guard's no longer matches and it is silently not running. `init` cannot repair
    // this — it never moves an entry — so it is not what the fix line says.
    const moved = codexHooksText({
      PreToolUse: [
        { matcher: ".*", hooks: [{ type: "command", command: "./theirs.sh" }] },
        codexEntry(),
      ],
      PermissionRequest: [codexEntry()],
    });
    const { out } = await statusOver({
      codex: {
        files: { ...CODEX_WORKING, [CODEX_HOOKS]: moved, [CODEX_RECORD]: codexInstallRecord() },
      },
    });
    const section = codexSection(out);
    expect(section).toContain(
      `Enforcement: BROKEN — guard's PreToolUse entry in ${CODEX_HOOKS} has moved from position 0 to position 1 since it was installed.`,
    );
    expect(section).toContain(CODEX_APPROVE_AGAIN);
    expect(section).not.toContain(CODEX_AGAIN);
  });

  it("says nothing about a move when install.json records no position, as an older guard's would not", async () => {
    const { out } = await statusOver({
      codex: {
        files: {
          ...CODEX_WORKING,
          [CODEX_RECORD]: JSON.stringify({ guardVersion: VERSION, hookPath: CODEX_COPY }),
        },
      },
    });
    expect(codexSection(out)).toMatch(/^Codex CLI\nEnforcement: ON · /);
  });

  it("says when install.json records another guard version, and how to refresh", async () => {
    const { out } = await statusOver({
      codex: { files: { ...CODEX_WORKING, [CODEX_RECORD]: codexInstallRecord("0.0.1") } },
    });
    expect(VERSION).not.toBe("0.0.1");
    expect(codexSection(out)).toContain(
      `\n  Installed by guard 0.0.1; this is guard ${VERSION}. Refresh it: \`agenttrail-guard init --agent codex\``,
    );
  });

  it("never suggests an init that would downgrade a NEWER Codex install", async () => {
    const { out } = await statusOver({
      codex: { files: { ...CODEX_WORKING, [CODEX_RECORD]: codexInstallRecord("99.0.0") } },
    });
    const section = codexSection(out);
    expect(section).toContain(
      `Installed by guard 99.0.0, newer than this guard ${VERSION} — this command is out of date.`,
    );
    expect(section).toContain("npm install -g @agenttrail/guard@latest");
    expect(section).not.toContain("Refresh it:");
  });

  it.each<[string, boolean, Record<string, string>]>([
    ["ON", true, CODEX_WORKING],
    ["BROKEN", true, codexWorkingWithout(CODEX_COPY)],
    ["NOT INSTALLED", false, {}],
  ])(// The one thing guard cannot check is the one that decides whether any of it runs, so
  // it is said whenever the entries are there — and never implied when they are not.
  "when Codex is %s, the approval note is shown: %s", async (_state, shown, files) => {
    const { out } = await statusOver({ codex: { files } });
    expect(out.split(TRUST_NOTE).length - 1).toBe(shown ? 1 : 0);
    expect(codexSection(out).includes(TRUST_NOTE)).toBe(shown);
  });

  it("never claims to know whether the hook is approved", async () => {
    const { out } = await statusOver({ codex: { files: CODEX_WORKING } });
    const section = codexSection(out);
    expect(section).toContain("Guard cannot tell whether you have");
    expect(section).toContain("config.toml");
    expect(section).not.toMatch(/\bapproved\b(?!.*cannot)/);
  });
});

describe("status: crash records", () => {
  it("counts the hook's records in every section, with the newest time, labelled as shared", async () => {
    const { out } = await statusOver({
      cursor: { files: WORKING },
      codex: { files: CODEX_WORKING },
      spool: SPOOL,
    });
    expect(claudeSection(out)).toContain(`\n  ${CRASH_LINE}`);
    expect(cursorSection(out)).toContain(`\n  ${CRASH_LINE}`);
    expect(codexSection(out)).toContain(`\n  ${CRASH_LINE}`);
    expect(out.split(CRASH_LINE).length - 1).toBe(3);
  });

  it("prints no crash line when no record is from the hook", async () => {
    const scanOnly = {
      [`${CRASHES}/crash-1757808000000-dddd4444.json`]: crashRecord(
        "scan",
        "2026-09-15T00:00:00.000Z",
      ),
    };
    const { out } = await statusOver({ spool: scanOnly });
    expect(out).not.toContain("Crash records");
  });

  it("reads the spool under the home folder status was given, not the hook IO's own", async () => {
    const h = harness();
    const guard = fakeGuardIo({ files: SPOOL, home: "/somewhere/else" });
    await runStatus(h.io, {
      cursorIo: fakeCursorFiles().io,
      codexIo: fakeCodexFiles().io,
      guardIo: guard.io,
    });
    expect(h.out()).toContain(CRASH_LINE);
    expect(guard.listed).toEqual([CRASHES]);
    expect(guard.read.length).toBeGreaterThan(0);
    for (const path of guard.read) expect(path.startsWith(`${CRASHES}/`), path).toBe(true);
  });
});

describe("status: recent decisions name the app", () => {
  it("shows claude or cursor on each line", async () => {
    const decision = (agent: string, ruleId: string, verdict: string) =>
      JSON.stringify({
        ts: "2026-09-07T00:00:00Z",
        tool: "Bash",
        decision: verdict,
        ruleId,
        command: "x",
        agent,
      });
    const { out } = await statusOver({
      setup: {
        files: {
          [`${HOME}/.agenttrail/guard/events.jsonl`]: [
            decision("claude", "wt.reset-hard", "deny"),
            decision("cursor", "ti.dep-install", "ask"),
          ].join("\n"),
        },
      },
    });
    expect(out).toMatch(/^ {2}deny {2}claude wt\.reset-hard +x$/m);
    expect(out).toMatch(/^ {2}ask {3}cursor ti\.dep-install +x$/m);
  });
});

describe("status: a multi-line command stays one row", () => {
  const eventsFile = `${HOME}/.agenttrail/guard/events.jsonl`;

  it("flattens a heredoc-bearing command to one line and declines an unusable silence", async () => {
    const heredoc = "python3 - <<'PY'\nimport os\nos.system('rm -rf /tmp/x')\nPY";
    const rows = Array.from({ length: 3 }, () =>
      JSON.stringify({
        ts: "2026-09-07T00:00:00Z",
        tool: "Bash",
        decision: "deny",
        ruleId: "sh.hold",
        command: heredoc,
        agent: "claude",
      }),
    );
    const { out } = await statusOver({ setup: { files: { [eventsFile]: rows.join("\n") } } });

    // The heredoc body never lands on its own line — neither in the decision row nor in the
    // most-frequent-match display; the whole command is flattened onto one line.
    expect(out).not.toMatch(/^import os$/m);
    expect(out).toMatch(/^ {2}deny {2}claude sh\.hold\s+python3 - <<'PY' import os/m);
    // The `guardrails allow` suggester cannot express a multi-line command as a single line
    // to paste, so it declines and says why rather than emitting a broken multi-line paste.
    expect(out).toContain("spans multiple lines");
    expect(out).not.toMatch(/guardrails allow sh\.hold 'python3/);
  });

  it("distinguishes how many decisions are displayed from how many are recorded", async () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      JSON.stringify({
        ts: "2026-09-07T00:00:00Z",
        tool: "Bash",
        decision: "deny",
        ruleId: "wt.reset-hard",
        command: `git reset --hard # ${i}`,
        agent: "claude",
      }),
    );
    const { out } = await statusOver({ setup: { files: { [eventsFile]: rows.join("\n") } } });
    expect(out).toContain("Recent decisions (latest 5 of 9):");
  });
});

describe("status writes nothing", () => {
  const events = {
    [`${HOME}/.agenttrail/guard/events.jsonl`]: JSON.stringify({
      ts: "2026-09-07T00:00:00Z",
      tool: "Bash",
      decision: "deny",
      ruleId: "wt.reset-hard",
      command: "x",
      agent: "cursor",
    }),
  };

  it.each<[string, Parameters<typeof statusOver>[0]]>([
    [
      "Cursor ON with an older install record, crashes and decisions",
      {
        cursor: { files: { ...WORKING, [INSTALL_RECORD]: installRecord("0.0.1") } },
        spool: SPOOL,
        setup: { plugins: [{ id: GUARD_PLUGIN_ID }], files: events },
      },
    ],
    [
      "Cursor BROKEN and the plugin source missing",
      {
        cursor: { files: workingWithout(HOOK_COPY) },
        spool: SPOOL,
        setup: {
          plugins: [{ id: GUARD_PLUGIN_ID }],
          marketplaces: [{ name: "agenttrail-guard", path: "/gone" }],
          missingPaths: ["/gone"],
          files: events,
        },
      },
    ],
    [
      "Claude Code not found",
      {
        cursor: { files: WORKING },
        spool: SPOOL,
        setup: { files: events },
        runClaude: () => missingClaude([]),
      },
    ],
  ])("%s: no write on any seam, and file contents read only under the home folder", async (_label, options) => {
    const { code, h, setupReads, cursor, codex, guard } = await statusOver({
      ...options,
      codex: { files: CODEX_WORKING },
    });
    expect(code).toBe(0);
    expect(h.writes).toEqual([]);
    expect(cursor.writes).toEqual([]);
    expect(cursor.deletes).toEqual([]);
    expect(codex.writes).toEqual([]);
    expect(codex.deletes).toEqual([]);
    expect(guard.writes).toEqual([]);

    // Each seam was read, so the loops below are not checking empty lists.
    expect(setupReads.length).toBeGreaterThan(0);
    expect(cursor.reads.length).toBeGreaterThan(0);
    expect(codex.reads.length).toBeGreaterThan(0);
    expect(guard.read.length).toBeGreaterThan(0);
    for (const path of setupReads) expect(path.startsWith(`${HOME}/`), path).toBe(true);
    for (const path of guard.read) expect(path.startsWith(`${HOME}/`), path).toBe(true);
    // Each app's reads also hold existence checks; the Node its entries run is the only
    // path outside the home folder.
    for (const path of [...cursor.reads, ...codex.reads]) {
      expect(path.startsWith(`${HOME}/`) || path === NODE, path).toBe(true);
    }
  });
});

describe("status agrees with init and uninstall for Cursor", () => {
  it("reports ON after init --agent cursor, and NOT INSTALLED after uninstall --agent cursor", async () => {
    const h = harness();
    const cursor = fakeCursorFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n", [NODE]: "" },
    });
    const guardIo = fakeGuardIo().io;
    const deps = { ...initDeps, cursorIo: cursor.io, nodePath: NODE };
    expect(await runInit(h.io, { agent: "cursor" }, deps)).toBe(0);

    let from = h.out().length;
    expect(await runStatus(h.io, { cursorIo: cursor.io, guardIo })).toBe(0);
    const installed = cursorSection(h.out().slice(from));
    expect(installed).toMatch(/^Cursor\nEnforcement: ON · /);
    expect(installed).not.toContain("Installed by guard");

    expect(await runUninstall(h.io, { agent: "cursor" }, { cursorIo: cursor.io })).toBe(0);
    from = h.out().length;
    expect(await runStatus(h.io, { cursorIo: cursor.io, guardIo })).toBe(0);
    expect(cursorSection(h.out().slice(from))).toBe(`Cursor\n${CURSOR_NOT_INSTALLED}`);
  });
});

describe("status agrees with init and uninstall for Codex", () => {
  it("reports ON after init --agent codex, and NOT INSTALLED after uninstall --agent codex", async () => {
    // The install writes the entry AND the position; `status` reads both back. A record
    // that disagreed with the file would show as BROKEN right after a clean install.
    const h = harness();
    const codex = fakeCodexFiles({
      files: { [`${SCAFFOLD}/scripts/guard-hook.mjs`]: "// hook\n", [NODE]: "" },
    });
    const guardIo = fakeGuardIo().io;
    const deps = { ...initDeps, codexIo: codex.io, nodePath: NODE };
    expect(await runInit(h.io, { agent: "codex" }, deps)).toBe(0);

    let from = h.out().length;
    expect(await runStatus(h.io, { codexIo: codex.io, guardIo })).toBe(0);
    const installed = codexSection(h.out().slice(from));
    expect(installed).toMatch(/^Codex CLI\nEnforcement: ON · /);
    expect(installed).not.toContain("Installed by guard");

    expect(await runUninstall(h.io, { agent: "codex" }, { codexIo: codex.io })).toBe(0);
    from = h.out().length;
    expect(await runStatus(h.io, { codexIo: codex.io, guardIo })).toBe(0);
    expect(codexSection(h.out().slice(from))).toBe(`Codex CLI\n${CODEX_NOT_INSTALLED}`);
  });
});
