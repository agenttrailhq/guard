/**
 * Guard stands down only where AgentTrail OS's record and every check agree. Each case that a
 * repository, an agent or a stale record could produce keeps guard enforcing.
 */
import { describe, expect, it } from "vitest";
import { type HookDeps, runHook } from "../commands/hook.js";
import { steppedAsideProjects } from "../core/decision-log.js";
import { recordSteppedAside } from "../core/events.js";
import {
  enforcedProjectsPath,
  evaluateStepAside,
  managedSettingsFiles,
  OS_PLUGIN_ID,
  parseEnforcedProjects,
  projectKeyOf,
  type StepAsideInput,
  tokenFingerprint,
} from "../core/os-step-aside.js";
import { eventsPath, steppedAsideMarkerPath } from "../core/paths.js";
import type { GuardIO } from "../io.js";
import { AGENTTRAIL_PLUGIN_ID } from "../plugin/install.js";

const HOME = "/home/dev";
const PROJECT = "/work/app";
const OTHER = "/work/other";
const ORIGIN = "https://api.agenttrail.sh";
const URL = `${ORIGIN}/api/v1/policies/evaluate`;
const TOKEN = "dlv_ingest_real";
const SOURCE = { source: "directory", path: "/npm/_npx/abc/node_modules/@agenttrail/cli/plugin" };
const MANAGED = "/etc/claude-code/managed-settings.json";

function entry(over: Record<string, unknown> = {}) {
  return {
    projectRoot: PROJECT,
    scope: "project",
    apiOrigin: ORIGIN,
    pluginId: OS_PLUGIN_ID,
    marketplaceSource: SOURCE,
    tokenFingerprint: tokenFingerprint(TOKEN),
    writtenAt: "2026-10-26T20:00:00.000Z",
    ...over,
  };
}

/** A machine where AgentTrail OS's setup connected PROJECT and everything agrees. */
function world(): Record<string, string> {
  return {
    [enforcedProjectsPath(HOME)]: JSON.stringify({ version: 1, entries: [entry()] }),
    [`${HOME}/.claude/settings.json`]: JSON.stringify({
      enabledPlugins: { [OS_PLUGIN_ID]: true, "agenttrail-guard@agenttrail-guard": true },
    }),
    [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
      version: 2,
      plugins: { [OS_PLUGIN_ID]: [{ scope: "user", version: "0.2.4" }] },
    }),
    [`${HOME}/.claude/plugins/known_marketplaces.json`]: JSON.stringify({
      agenttrail: {
        source: { path: SOURCE.path, source: "directory" },
        installLocation: SOURCE.path,
      },
    }),
  };
}

const ENV = {
  AGENTTRAIL_PEP_ENFORCE: "1",
  AGENTTRAIL_PEP_URL: URL,
  AGENTTRAIL_PEP_TOKEN: TOKEN,
  CLAUDE_PROJECT_DIR: PROJECT,
};

function input(
  files: Record<string, string>,
  env: Record<string, string | undefined> = ENV,
  over: Partial<StepAsideInput> = {},
): StepAsideInput {
  return {
    env,
    home: HOME,
    cwd: PROJECT,
    readFile: (p) => files[p],
    listDir: () => [],
    realpath: (p) => p,
    platform: "linux",
    ...over,
  };
}

describe("evaluateStepAside — stands down only when every check passes", () => {
  it("stands down when the record, server, credential, plugin and source all agree", () => {
    expect(evaluateStepAside(input(world()))).toEqual({
      standDown: true,
      projectKey: projectKeyOf(PROJECT),
    });
  });

  it("a global entry covers any folder", () => {
    const files = {
      ...world(),
      [enforcedProjectsPath(HOME)]: JSON.stringify({
        version: 1,
        entries: [entry({ scope: "global", projectRoot: undefined })],
      }),
    };
    const r = evaluateStepAside(
      input(files, { ...ENV, CLAUDE_PROJECT_DIR: OTHER }, { cwd: OTHER }),
    );
    expect(r).toEqual({ standDown: true, projectKey: projectKeyOf(undefined) });
  });

  it("sentinel absent: enforces", () => {
    const env = { ...ENV, AGENTTRAIL_PEP_ENFORCE: undefined };
    expect(evaluateStepAside(input(world(), env))).toEqual({
      standDown: false,
      failed: "sentinel",
    });
  });

  it("(a) a repo commits the sentinel and its own URL and token, OS set up for another project", () => {
    const env = {
      AGENTTRAIL_PEP_ENFORCE: "1",
      AGENTTRAIL_PEP_URL: "https://evil.example/api/v1/policies/evaluate",
      AGENTTRAIL_PEP_TOKEN: "dlv_live_attacker",
      CLAUDE_PROJECT_DIR: OTHER,
    };
    expect(evaluateStepAside(input(world(), env, { cwd: OTHER }))).toEqual({
      standDown: false,
      failed: "record",
    });
  });

  it("(a) inside a recorded project, a swapped server fails the origin check", () => {
    const env = { ...ENV, AGENTTRAIL_PEP_URL: "https://evil.example/e" };
    expect(evaluateStepAside(input(world(), env))).toEqual({ standDown: false, failed: "origin" });
  });

  it("(a') a URL that points nowhere and a snapshot path: enforces", () => {
    const env = {
      ...ENV,
      AGENTTRAIL_PEP_URL: "http://127.0.0.1:9/nothing",
      AGENTTRAIL_PEP_SNAPSHOT_PATH: `${PROJECT}/empty.json`,
    };
    expect(evaluateStepAside(input(world(), env))).toEqual({ standDown: false, failed: "origin" });
    const unparseable = { ...ENV, AGENTTRAIL_PEP_URL: "not a url" };
    expect(evaluateStepAside(input(world(), unparseable))).toEqual({
      standDown: false,
      failed: "origin",
    });
  });

  it("(b) the project's settings.json disables the OS plugin: enforces", () => {
    const files = {
      ...world(),
      [`${PROJECT}/.claude/settings.json`]: JSON.stringify({
        env: { AGENTTRAIL_PEP_ENFORCE: "1" },
        enabledPlugins: { [OS_PLUGIN_ID]: false },
      }),
    };
    expect(evaluateStepAside(input(files))).toEqual({ standDown: false, failed: "enabled" });
  });

  it("(b) a disable in the working folder's own project file counts too", () => {
    const sub = `${PROJECT}/packages/web`;
    const files = {
      ...world(),
      [`${sub}/.claude/settings.json`]: JSON.stringify({
        enabledPlugins: { [OS_PLUGIN_ID]: false },
      }),
    };
    expect(evaluateStepAside(input(files, ENV, { cwd: sub }))).toEqual({
      standDown: false,
      failed: "enabled",
    });
  });

  it("local and managed settings outrank the project file, as in Claude Code", () => {
    const disabledByProject = {
      ...world(),
      [`${PROJECT}/.claude/settings.json`]: JSON.stringify({
        enabledPlugins: { [OS_PLUGIN_ID]: false },
      }),
      [`${PROJECT}/.claude/settings.local.json`]: JSON.stringify({
        enabledPlugins: { [OS_PLUGIN_ID]: true },
      }),
    };
    expect(evaluateStepAside(input(disabledByProject)).standDown).toBe(true);
    const disabledByManaged = {
      ...world(),
      [MANAGED]: JSON.stringify({ enabledPlugins: { [OS_PLUGIN_ID]: false } }),
    };
    expect(evaluateStepAside(input(disabledByManaged))).toEqual({
      standDown: false,
      failed: "enabled",
    });
  });

  it("an unparseable project settings file is not read as enabled", () => {
    const files = { ...world(), [`${PROJECT}/.claude/settings.json`]: "{ nope" };
    expect(evaluateStepAside(input(files))).toEqual({ standDown: false, failed: "enabled" });
  });

  it("a plugin installed but never enabled: enforces", () => {
    const files = { ...world(), [`${HOME}/.claude/settings.json`]: JSON.stringify({}) };
    expect(evaluateStepAside(input(files))).toEqual({ standDown: false, failed: "enabled" });
  });

  it("a mid-session write is caught on the next call: the checks run per call", () => {
    const files = world();
    expect(evaluateStepAside(input(files)).standDown).toBe(true);
    // An agent writes, through Bash, a disable into the project file and a new token.
    files[`${PROJECT}/.claude/settings.json`] = JSON.stringify({
      enabledPlugins: { [OS_PLUGIN_ID]: false },
    });
    expect(evaluateStepAside(input(files))).toEqual({ standDown: false, failed: "enabled" });
    expect(
      evaluateStepAside(input(world(), { ...ENV, AGENTTRAIL_PEP_TOKEN: "dlv_live_other" })),
    ).toEqual({ standDown: false, failed: "token" });
  });

  it("a token rotated without a record update: enforces", () => {
    const env = { ...ENV, AGENTTRAIL_PEP_TOKEN: "dlv_ingest_rotated" };
    expect(evaluateStepAside(input(world(), env))).toEqual({ standDown: false, failed: "token" });
    const none = { ...ENV, AGENTTRAIL_PEP_TOKEN: undefined };
    expect(evaluateStepAside(input(world(), none))).toEqual({ standDown: false, failed: "token" });
  });

  it("a moved project: the real path no longer matches", () => {
    const moved = "/work/app-renamed";
    const env = { ...ENV, CLAUDE_PROJECT_DIR: moved };
    expect(evaluateStepAside(input(world(), env, { cwd: moved }))).toEqual({
      standDown: false,
      failed: "record",
    });
  });

  it("a symlinked path resolves to the recorded real path", () => {
    const realpath = (p: string) => (p === "/links/app" ? PROJECT : p);
    const env = { ...ENV, CLAUDE_PROJECT_DIR: "/links/app" };
    expect(evaluateStepAside(input(world(), env, { cwd: "/links/app", realpath })).standDown).toBe(
      true,
    );
  });

  it("CLAUDE_PROJECT_DIR naming a recorded project does not cover a folder outside it", () => {
    expect(evaluateStepAside(input(world(), ENV, { cwd: OTHER }))).toEqual({
      standDown: false,
      failed: "record",
    });
    const relative = { ...ENV, CLAUDE_PROJECT_DIR: "app" };
    expect(evaluateStepAside(input(world(), relative, { cwd: OTHER })).standDown).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["not JSON", "{"],
    ["an unknown version", JSON.stringify({ version: 2, entries: [entry()] })],
    [
      "an entry with a bad fingerprint",
      JSON.stringify({ version: 1, entries: [entry({ tokenFingerprint: "xyz" })] }),
    ],
    [
      "an entry for another plugin",
      JSON.stringify({ version: 1, entries: [entry({ pluginId: "agenttrail@evil" })] }),
    ],
    [
      "a relative projectRoot",
      JSON.stringify({ version: 1, entries: [entry({ projectRoot: "app" })] }),
    ],
  ])("a record that is %s: enforces", (_why, text) => {
    const files: Record<string, string> = { ...world() };
    if (text === undefined) delete files[enforcedProjectsPath(HOME)];
    else files[enforcedProjectsPath(HOME)] = text;
    expect(evaluateStepAside(input(files))).toEqual({ standDown: false, failed: "record" });
  });

  it("a marketplace source other than the recorded one: enforces", () => {
    const files = {
      ...world(),
      [`${HOME}/.claude/plugins/known_marketplaces.json`]: JSON.stringify({
        agenttrail: { source: { source: "github", repo: "someone/agenttrail" } },
      }),
    };
    expect(evaluateStepAside(input(files))).toEqual({ standDown: false, failed: "source" });
  });

  it("the plugin missing from installed_plugins.json: enforces", () => {
    const files = {
      ...world(),
      [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
        version: 2,
        plugins: {},
      }),
    };
    expect(evaluateStepAside(input(files))).toEqual({ standDown: false, failed: "source" });
  });

  it("honours CLAUDE_CONFIG_DIR for the user settings and the plugin registry", () => {
    const files: Record<string, string> = {};
    for (const [path, text] of Object.entries(world())) {
      files[path.replace(`${HOME}/.claude`, "/cfg")] = text;
    }
    files[enforcedProjectsPath(HOME)] = world()[enforcedProjectsPath(HOME)] as string;
    expect(evaluateStepAside(input(files, { ...ENV, CLAUDE_CONFIG_DIR: "/cfg" })).standDown).toBe(
      true,
    );
    expect(evaluateStepAside(input(files)).standDown).toBe(false);
  });

  it("a reader that throws is treated as no record", () => {
    const r = evaluateStepAside(
      input(world(), ENV, {
        readFile: () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(r.standDown).toBe(false);
  });
});

describe("the identifiers", () => {
  it("the OS plugin id is the one init's coexistence check uses", () => {
    expect(OS_PLUGIN_ID).toBe(AGENTTRAIL_PLUGIN_ID);
  });

  it("the fingerprint is the first 16 hex of sha256", () => {
    // sha256("abc")
    expect(tokenFingerprint("abc")).toBe("ba7816bf8f01cfea");
  });

  it("the managed-settings files include sorted .json drop-ins", () => {
    expect(managedSettingsFiles("darwin", () => ["b.json", "a.json", "x.txt"])).toEqual([
      "/Library/Application Support/ClaudeCode/managed-settings.json",
      "/Library/Application Support/ClaudeCode/managed-settings.d/a.json",
      "/Library/Application Support/ClaudeCode/managed-settings.d/b.json",
    ]);
  });

  it("parseEnforcedProjects keeps a valid global entry without a root", () => {
    const text = JSON.stringify({
      version: 1,
      entries: [entry({ scope: "global", projectRoot: undefined })],
    });
    expect(parseEnforcedProjects(text)).toHaveLength(1);
  });
});

// ── The hook itself ─────────────────────────────────────────────────────────

function fakeIo(files: Record<string, string>, stdin: string) {
  const written: string[] = [];
  const appended: Array<{ path: string; text: string }> = [];
  const io: GuardIO = {
    readStdin: async () => stdin,
    writeStdout: (t) => {
      written.push(t);
    },
    readFile: (p) => files[p],
    homedir: () => HOME,
    mkdirp: () => true,
    writeFileAtomic: (p, t) => {
      files[p] = t;
      return true;
    },
    listDir: () => [],
    deleteFile: () => true,
    appendFile: (path, text) => {
      appended.push({ path, text });
      files[path] = (files[path] ?? "") + text;
      return true;
    },
    fileSize: () => 0,
  };
  return { io, written, appended };
}

const RM = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /" },
  cwd: PROJECT,
  session_id: "s",
  tool_use_id: "t1",
});

const deps = (env: Record<string, string | undefined>): HookDeps => ({
  agent: "claude",
  env,
  realpath: (p) => p,
  platform: "linux",
});

describe("runHook — the stand-down path", () => {
  it("gives no decision and logs one stepped-aside line with a hashed project", async () => {
    const files = world();
    const { io, written, appended } = fakeIo(files, RM);
    await runHook(io, deps(ENV));
    expect(written).toEqual([]);
    expect(appended).toHaveLength(1);
    const line = JSON.parse(appended[0]?.text ?? "{}");
    expect(line).toMatchObject({
      event: "stepped-aside",
      project: projectKeyOf(PROJECT),
      agent: "claude",
    });
    expect(appended[0]?.text).not.toContain(PROJECT);
    expect(appended[0]?.text).not.toContain("rm -rf");
  });

  it("enforces as usual when a check fails (b)", async () => {
    const files = {
      ...world(),
      [`${PROJECT}/.claude/settings.json`]: JSON.stringify({
        enabledPlugins: { [OS_PLUGIN_ID]: false },
      }),
    };
    const { io, written } = fakeIo(files, RM);
    await runHook(io, { ...deps(ENV), recorder: { record() {} } });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "{}").hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("enforces as usual when the entry point passes no environment", async () => {
    const { io, written } = fakeIo(world(), RM);
    await runHook(io, { agent: "claude", recorder: { record() {} } });
    expect(JSON.parse(written[0] ?? "{}").hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("recordSteppedAside / steppedAsideProjects", () => {
  it("writes at most one line per project an hour, and counts distinct projects", () => {
    const files: Record<string, string> = {};
    const { io } = fakeIo(files, "");
    let now = Date.parse("2026-10-26T10:00:00Z");
    recordSteppedAside(io, "aaaa", "claude", () => now);
    now += 60_000;
    recordSteppedAside(io, "aaaa", "claude", () => now);
    recordSteppedAside(io, "bbbb", "claude", () => now);
    now += 61 * 60_000;
    recordSteppedAside(io, "aaaa", "claude", () => now);
    const log = files[eventsPath(HOME)] ?? "";
    expect(log.trim().split("\n")).toHaveLength(3);
    expect(files[steppedAsideMarkerPath(HOME)]).toBeDefined();
    expect(steppedAsideProjects(log, now)).toBe(2);
    expect(steppedAsideProjects(log, now + 31 * 24 * 3600_000)).toBe(0);
    expect(steppedAsideProjects(undefined, now)).toBe(0);
  });
});
