/**
 * Whether guard's Claude Code hook stands down because AgentTrail OS enforces this project.
 *
 * AgentTrail OS's own `PreToolUse` hook decides every call in a project its `setup` connected.
 * With both plugins installed at user scope, both hooks would decide the same call. So guard
 * gives no decision in such a project, and only there.
 *
 * Every input to "is AgentTrail OS on here?" that lives in a project's settings can be written
 * by the repository itself. So guard stands down only on a per-machine record that `agenttrail
 * setup` writes outside every repository (`~/.agenttrail/os/enforced-projects.json`), and only
 * when all six checks below agree with it. Any failure, and any file that cannot be read or
 * parsed, means guard enforces as usual: the worst case is two hooks deciding, never none.
 *
 *   0. sentinel  `AGENTTRAIL_PEP_ENFORCE=1` is in the hook's environment. Without it AgentTrail
 *                OS's hook gives no decision, so nothing would decide.
 *   1. record    the project (`CLAUDE_PROJECT_DIR`, else the payload `cwd`, by real path) is an
 *                entry's `projectRoot`, or a `global` entry exists.
 *   2. origin    the origin of `AGENTTRAIL_PEP_URL` is the entry's `apiOrigin`.
 *   3. token     the fingerprint of `AGENTTRAIL_PEP_TOKEN` is the entry's `tokenFingerprint`.
 *   4. enabled   `enabledPlugins["agenttrail@agenttrail"]` is `true` after Claude Code's merge
 *                (managed > local > project > user), for every folder this session's project
 *                settings could come from.
 *   5. source    Claude Code's plugin registry lists `agenttrail@agenttrail`, installed from the
 *                marketplace source the entry names.
 *
 * Local reads only: no network and no process spawn. Every file read goes through the injected
 * `readFile`, which returns `undefined` for a missing or unreadable file.
 */

import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, sep } from "node:path";

/** AgentTrail OS's Claude Code plugin id. Matched exactly, never by suffix. */
export const OS_PLUGIN_ID = "agenttrail@agenttrail";
/** The marketplace AgentTrail OS's plugin is installed from. */
export const OS_MARKETPLACE_NAME = "agenttrail";

/** The record's format version this reader understands. */
export const RECORD_VERSION = 1;

/** The environment keys the checks read. */
const ENV_ENFORCE = "AGENTTRAIL_PEP_ENFORCE";
const ENV_URL = "AGENTTRAIL_PEP_URL";
const ENV_TOKEN = "AGENTTRAIL_PEP_TOKEN";
const ENV_PROJECT_DIR = "CLAUDE_PROJECT_DIR";
const ENV_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

/** The six checks, in the order they are evaluated. */
export type StepAsideCheck = "sentinel" | "record" | "origin" | "token" | "enabled" | "source";

/** What a check failure means, for `status`. Names no value. */
export const STEP_ASIDE_CHECK_TEXT: Readonly<Record<StepAsideCheck, string>> = {
  sentinel: "AgentTrail OS enforcement is not turned on here",
  record:
    "this folder is not one AgentTrail OS setup recorded on this machine (the setting may come from the repository, or the project moved). Run AgentTrail OS setup in this folder",
  origin: "the AgentTrail server configured here is not the one AgentTrail OS setup recorded",
  token:
    "the AgentTrail credential configured here is not the one AgentTrail OS setup recorded (it may have been rotated). Refresh the AgentTrail OS login",
  enabled: "the AgentTrail OS plugin is disabled for this folder",
  source:
    "the AgentTrail OS plugin is not installed, or not from the source AgentTrail OS setup recorded",
};

/** `~/.agenttrail/os/enforced-projects.json`. */
export function enforcedProjectsPath(home: string): string {
  return join(home, ".agenttrail", "os", "enforced-projects.json");
}

/** Claude Code's config folder, honouring an absolute `CLAUDE_CONFIG_DIR`. */
function claudeDir(home: string, env: Readonly<Record<string, string | undefined>>): string {
  const configured = env[ENV_CONFIG_DIR]?.trim();
  return configured !== undefined && configured.length > 0 && isAbsolute(configured)
    ? configured
    : join(home, ".claude");
}

/** Where Claude Code reads file-based managed settings on this platform. */
export function managedSettingsFiles(
  platform: NodeJS.Platform,
  listDir: (dir: string) => readonly string[],
): string[] {
  const dir =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode"
        : "/etc/claude-code";
  const dropIns = join(dir, "managed-settings.d");
  return [
    join(dir, "managed-settings.json"),
    ...[...listDir(dropIns)]
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(dropIns, name)),
  ];
}

/** What the checks read. */
export interface StepAsideInput {
  /** The hook's environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** The payload's `cwd`, when it carried one. */
  readonly cwd?: string;
  /** A UTF-8 file, or `undefined` when missing or unreadable. */
  readonly readFile: (path: string) => string | undefined;
  /** Entry names, or `[]` when the folder is missing. */
  readonly listDir: (path: string) => readonly string[];
  /** A path through symbolic links. May throw for a path that does not exist. */
  readonly realpath: (path: string) => string;
  readonly platform?: NodeJS.Platform;
  /**
   * The hook process's working folder. Its project settings are scanned for committed values too,
   * and it is the base a relative `CLAUDE_PROJECT_DIR` resolves against.
   */
  readonly processCwd?: string;
}

/** The answer: stand down (with a hashed project key for the event), or which check failed. */
export type StepAsideResult =
  | { readonly standDown: true; readonly projectKey: string }
  | { readonly standDown: false; readonly failed: StepAsideCheck };

/** One parsed record entry. */
interface RecordEntry {
  readonly scope: "project" | "global";
  readonly projectRoot?: string;
  readonly apiOrigin: string;
  readonly marketplaceSource: unknown;
  readonly tokenFingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The record's usable entries. An unknown version or a malformed file has none. */
export function parseEnforcedProjects(text: string | undefined): RecordEntry[] {
  const parsed = parseJson(text);
  if (!isRecord(parsed) || parsed.version !== RECORD_VERSION || !Array.isArray(parsed.entries)) {
    return [];
  }
  const out: RecordEntry[] = [];
  for (const raw of parsed.entries) {
    if (!isRecord(raw)) continue;
    const { scope, projectRoot, apiOrigin, pluginId, marketplaceSource, tokenFingerprint } = raw;
    if (pluginId !== OS_PLUGIN_ID) continue;
    if (typeof apiOrigin !== "string" || apiOrigin.length === 0) continue;
    if (typeof tokenFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(tokenFingerprint)) continue;
    if (typeof raw.writtenAt !== "string") continue;
    if (!isRecord(marketplaceSource)) continue;
    if (scope === "global") {
      out.push({ scope, apiOrigin, marketplaceSource, tokenFingerprint });
    } else if (scope === "project" && typeof projectRoot === "string" && isAbsolute(projectRoot)) {
      out.push({ scope, projectRoot, apiOrigin, marketplaceSource, tokenFingerprint });
    }
  }
  return out;
}

/** The first 16 hex characters of a token's SHA-256: the record's `tokenFingerprint`. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

/** A short hash naming a project in the decision log, never its path. */
export function projectKeyOf(root: string | undefined): string {
  return createHash("sha256")
    .update(root ?? "global", "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** A URL's origin, or `undefined` when it does not parse. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined || url.trim().length === 0) return undefined;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return undefined;
  }
}

/** JSON with object keys sorted, so two equal sources compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function safeRealpath(path: string, realpath: (p: string) => string): string | undefined {
  try {
    return realpath(path);
  } catch {
    return undefined;
  }
}

/** True when `path` is `root` or inside it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The folders whose `.claude/settings*.json` this session may have loaded as its project files:
 * the project folder and the working folder, each with its ancestors up to, not including, the
 * home folder (whose `.claude/settings.json` is the user file).
 */
function projectSettingsFolders(starts: readonly string[], home: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const start of starts) {
    let dir = start;
    for (;;) {
      if (dir === home || seen.has(dir)) break;
      seen.add(dir);
      out.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return out;
}

/**
 * `enabledPlugins[id]` in one settings file: `true`, `false`, `undefined` when the file sets
 * nothing for it, or `"unreadable"` when the file exists and does not parse or sets the id to
 * anything but a boolean (`"false"`, `null`, `0`), which fails the check.
 */
function enabledIn(text: string | undefined): boolean | undefined | "unreadable" {
  if (text === undefined) return undefined;
  const parsed = parseJson(text);
  if (!isRecord(parsed)) return "unreadable";
  const plugins = parsed.enabledPlugins;
  if (plugins === undefined) return undefined;
  if (!isRecord(plugins)) return "unreadable";
  if (!(OS_PLUGIN_ID in plugins)) return undefined;
  const value = plugins[OS_PLUGIN_ID];
  return typeof value === "boolean" ? value : "unreadable";
}

/** Check 4 for one project folder: Claude Code's merge, managed > local > project > user. */
function enabledFor(
  folder: string,
  input: StepAsideInput,
  managed: readonly (boolean | undefined | "unreadable")[],
  user: boolean | undefined | "unreadable",
): boolean {
  const layers = [
    ...managed,
    enabledIn(input.readFile(join(folder, ".claude", "settings.local.json"))),
    enabledIn(input.readFile(join(folder, ".claude", "settings.json"))),
    user,
  ];
  for (const layer of layers) {
    if (layer === "unreadable") return false;
    if (layer !== undefined) return layer;
  }
  return false;
}

/** Check 5: the registry lists the plugin, installed from the entry's marketplace source. */
function sourceMatches(entry: RecordEntry, input: StepAsideInput, configDir: string): boolean {
  const plugins = join(configDir, "plugins");
  const installed = parseJson(input.readFile(join(plugins, "installed_plugins.json")));
  if (!isRecord(installed) || !isRecord(installed.plugins)) return false;
  const rows = installed.plugins[OS_PLUGIN_ID];
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const marketplaces = parseJson(input.readFile(join(plugins, "known_marketplaces.json")));
  if (!isRecord(marketplaces)) return false;
  const ours = marketplaces[OS_MARKETPLACE_NAME];
  if (!isRecord(ours) || !isRecord(ours.source)) return false;
  return canonical(ours.source) === canonical(entry.marketplaceSource);
}

/** Decide whether guard stands down for this call. Never throws. */
export function evaluateStepAside(input: StepAsideInput): StepAsideResult {
  try {
    return evaluate(input);
  } catch {
    // An unforeseen failure is not evidence that AgentTrail OS is enforcing.
    return { standDown: false, failed: "record" };
  }
}

function evaluate(input: StepAsideInput): StepAsideResult {
  const { env } = input;
  // 0. sentinel, as it reaches the hook. The full check runs below, once the folder is known.
  if (env[ENV_ENFORCE]?.trim() !== "1") return { standDown: false, failed: "sentinel" };

  // 1. record. `CLAUDE_PROJECT_DIR` is used only when absolute, and then the working folder must
  // be inside it, so a value pointing at some other recorded project does not match.
  const projectDirRaw = env[ENV_PROJECT_DIR]?.trim();
  const projectDir =
    projectDirRaw !== undefined && projectDirRaw.length > 0 && isAbsolute(projectDirRaw)
      ? safeRealpath(projectDirRaw, input.realpath)
      : undefined;
  const cwd =
    input.cwd !== undefined && input.cwd.length > 0 && isAbsolute(input.cwd)
      ? safeRealpath(input.cwd, input.realpath)
      : undefined;
  const here =
    projectDir !== undefined && (cwd === undefined || within(cwd, projectDir)) ? projectDir : cwd;
  if (here === undefined) return { standDown: false, failed: "record" };

  const entries = parseEnforcedProjects(input.readFile(enforcedProjectsPath(input.home)));
  const candidates = [
    ...entries.filter((e) => e.scope === "project" && e.projectRoot === here),
    ...entries.filter((e) => e.scope === "global"),
  ];
  if (candidates.length === 0) return { standDown: false, failed: "record" };

  // 0, judged the way the AgentTrail OS hook judges it: the "1" must come from a scope a
  // repository can't write (managed, this machine's settings.local.json, or the user settings),
  // never only from a project's settings.json. The hook sets a committed "1" with nothing
  // trusted behind it aside and gives no decision, so standing down on it would leave nothing
  // deciding. A repository that sets CLAUDE_PROJECT_DIR or CLAUDE_CONFIG_DIR doesn't get to choose
  // which local or user file counts.
  //
  // The files are chosen exactly as the AgentTrail OS hook chooses them, so the two can't disagree:
  //   - committed values are looked for in CLAUDE_PROJECT_DIR (whoever set it, relative ones
  //     included), the payload cwd and the hook's own folder, each with its ancestors;
  //   - the local file is CLAUDE_PROJECT_DIR's when that is absolute and not set by a project
  //     file, NO local file when it is present but can't be trusted, and the payload cwd's (else the
  //     hook folder's) only when it is absent. `here`, the folder the record is looked up for, is
  //     not used for this: a session can run in one project while cwd is in another.
  const homeReal = safeRealpath(input.home, input.realpath) ?? input.home;
  const base = input.processCwd;
  const resolveFrom = (path: string) =>
    isAbsolute(path) ? path : base !== undefined ? join(base, path) : undefined;
  const scanStarts = [projectDirRaw, input.cwd, base]
    .filter((p): p is string => p !== undefined && p.length > 0)
    .map(resolveFrom)
    .filter((p): p is string => p !== undefined)
    .map((p) => safeRealpath(p, input.realpath) ?? p);
  const scanned = projectSettingsFolders(scanStarts, homeReal).map((folder) =>
    input.readFile(join(folder, ".claude", "settings.json")),
  );
  // A file that exists but doesn't parse to an object, or whose `env` is present but not an
  // object (`null`, a list, a string, a number), counts as setting every key, as the OS hook
  // reads it.
  const repoSets = (key: string) =>
    scanned.some((text) => {
      if (text === undefined) return false;
      const parsed = parseJson(text);
      if (!isRecord(parsed)) return true;
      if (!("env" in parsed) || parsed.env === undefined) return false;
      return !isRecord(parsed.env) || key in parsed.env;
    });
  const configDir = repoSets(ENV_CONFIG_DIR)
    ? join(input.home, ".claude")
    : claudeDir(input.home, env);
  let localRoot: string | undefined;
  if (projectDirRaw !== undefined && projectDirRaw.length > 0) {
    localRoot = projectDir !== undefined && !repoSets(ENV_PROJECT_DIR) ? projectDir : undefined;
  } else {
    const fallback = [input.cwd, base].find((p) => p !== undefined && p.length > 0);
    localRoot =
      fallback === undefined ? undefined : (safeRealpath(fallback, input.realpath) ?? fallback);
  }
  const trustedFiles = [
    ...managedSettingsFiles(input.platform ?? process.platform, input.listDir),
    ...(localRoot === undefined ? [] : [join(localRoot, ".claude", "settings.local.json")]),
    join(configDir, "settings.json"),
  ];
  const trustedSentinel = trustedFiles
    .map((path) => envBlock(input.readFile(path))[ENV_ENFORCE])
    .find((value) => value !== undefined);
  if (trustedSentinel?.trim() !== "1") return { standDown: false, failed: "sentinel" };

  // 2. and 3., per candidate entry; the first entry that passes both is the one checked on.
  const origin = originOf(env[ENV_URL]);
  const token = env[ENV_TOKEN]?.trim();
  const fingerprint = token !== undefined && token.length > 0 ? tokenFingerprint(token) : undefined;
  const sameOrigin = candidates.filter((e) => origin !== undefined && e.apiOrigin === origin);
  if (sameOrigin.length === 0) return { standDown: false, failed: "origin" };
  const matched = sameOrigin.find(
    (e) => fingerprint !== undefined && e.tokenFingerprint === fingerprint,
  );
  if (matched === undefined) return { standDown: false, failed: "token" };

  // 4. enabled, in every folder this session's project settings could have come from.
  const home = safeRealpath(input.home, input.realpath) ?? input.home;
  const managed = managedSettingsFiles(input.platform ?? process.platform, input.listDir).map(
    (path) => enabledIn(input.readFile(path)),
  );
  const user = enabledIn(input.readFile(join(configDir, "settings.json")));
  const starts = [here, ...(cwd !== undefined && cwd !== here ? [cwd] : [])];
  const folders = projectSettingsFolders(starts, home);
  const enabled =
    folders.length === 0
      ? enabledFor(home, { ...input, readFile: () => undefined }, managed, user)
      : folders.every((folder) => enabledFor(folder, input, managed, user));
  if (!enabled) return { standDown: false, failed: "enabled" };

  // 5. source
  if (!sourceMatches(matched, input, configDir)) return { standDown: false, failed: "source" };

  return {
    standDown: true,
    projectKey: projectKeyOf(matched.scope === "global" ? undefined : matched.projectRoot),
  };
}

// ── `status` ───────────────────────────────────────────────────────────────

/** The `env` block of one settings file, or `{}`. */
function envBlock(text: string | undefined): Record<string, string> {
  const parsed = parseJson(text);
  if (!isRecord(parsed) || !isRecord(parsed.env)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.env)) {
    // Any present value counts as set: a number or boolean as Claude Code would pass it, anything
    // else (null, an object) as its JSON text, which is never "1".
    out[key] =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
  }
  return out;
}

/** What `status` reads to describe AgentTrail OS here. */
export interface OsStatusInput extends Omit<StepAsideInput, "env" | "cwd"> {
  /** The shell environment `status` runs in. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The folder `status` runs in. */
  readonly cwd: string;
  /** How many projects guard stood down in recently (`steppedAsideProjects`). */
  readonly steppedAsideCount: number;
}

/**
 * The lines `status` prints about AgentTrail OS, or none.
 *
 * - How many projects guard has recently stood down in, from the decision log.
 * - When this folder's settings turn AgentTrail OS enforcement on, whether guard stands down
 *   here, and if not, which check failed. `status` is not a hook, so the environment the hook
 *   would see is rebuilt the way Claude Code merges it: the shell, then the user, project,
 *   local and managed settings' `env` blocks, each overriding the last.
 */
export function osStatusLines(input: OsStatusInput): string[] {
  const out: string[] = [];
  const n = input.steppedAsideCount;
  if (n > 0) {
    out.push(
      `  AgentTrail OS is enforcing in ${n} project${n === 1 ? "" : "s"}. Guard stands down there.`,
    );
  }
  const cwd = safeRealpath(input.cwd, input.realpath) ?? input.cwd;
  const managed = managedSettingsFiles(input.platform ?? process.platform, input.listDir);
  const merged: Record<string, string | undefined> = {
    ...input.env,
    ...envBlock(input.readFile(join(claudeDir(input.home, input.env), "settings.json"))),
    ...envBlock(input.readFile(join(cwd, ".claude", "settings.json"))),
    ...envBlock(input.readFile(join(cwd, ".claude", "settings.local.json"))),
    ...Object.assign({}, ...[...managed].reverse().map((p) => envBlock(input.readFile(p)))),
    [ENV_PROJECT_DIR]: cwd,
  };
  if (merged[ENV_ENFORCE]?.trim() !== "1") return out;
  const result = evaluateStepAside({ ...input, env: merged, cwd });
  out.push(
    result.standDown
      ? "  AgentTrail OS enforces this folder. Guard stands down here."
      : `  AgentTrail OS enforcement is turned on for this folder, but Guard keeps enforcing here: ${STEP_ASIDE_CHECK_TEXT[result.failed]}.`,
  );
  return out;
}
