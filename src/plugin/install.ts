// cspell:words upserts upsert repointed
/**
 * The `claude plugin …` wrapper for the guard.
 *
 * Injected runner, typed errors, and a version gate that PROCEEDS on an unparseable
 * version.
 *
 * ── The identity must not collide, in either direction ───────────────────────
 * Ours ends `@agenttrail-guard`, and the agenttrail plugin is `agenttrail@agenttrail`,
 * so a suffix match on either marketplace name never selects the other plugin:
 *
 *   "agenttrail-guard@agenttrail-guard".endsWith("@agenttrail")        === false
 *   "agenttrail@agenttrail".endsWith("@agenttrail-guard")              === false
 *
 * `plugin.test.ts` asserts the guard's side of that property.
 *
 * ── Vendor behaviours, observed with Claude Code 2.1.263 ──────────────────────
 * Real scaffold, isolated HOME, stdio piped (never a TTY):
 *
 *   1. `marketplace add` is an UPSERT. Re-adding the same marketplace name with a
 *      different path exits 0 and re-points the recorded path. There is no `--force`
 *      because none is needed — so re-pointing is ONE call, and `init` never has to go
 *      near `marketplace remove`.
 *   2. `marketplace remove` CASCADES. Removing it while our plugin is installed
 *      deregisters the plugin (`plugin list` → `[]`), which makes a subsequent
 *      `uninstall` FAIL, and leaves the plugin's cache directory orphaned on disk.
 *      Hence the strict order in `uninstallGuardPlugin`: uninstall, THEN remove.
 *   3. `plugin uninstall` EXITS 1 when the plugin is absent ("not found in installed
 *      plugins"). Idempotence therefore comes from our pre-check — see the warning
 *      there.
 *   4. `plugin list --json` carries `enabled`. An installed-but-disabled plugin
 *      enforces nothing, and a reader of only `id` cannot tell the two apart.
 *      `readInstalledPlugin` returns `enabled` so `status` can.
 *   5. A vanished source is INVISIBLE in `marketplace list --json` — it still reports
 *      the stale path at exit 0 with no error of its own. But `plugin list --json`
 *      grows `errors: ["Marketplace … failed to load: cache-miss"]` on our row, and
 *      that CLEARS when the marketplace is re-pointed. Hence two detection channels
 *      (`readMarketplaceHealth` stats the path; `InstalledPlugin.errors` asks the
 *      vendor), because each covers the other's blind spot.
 *   6. On a dangling source ALL THREE recovery verbs fail: `marketplace update` exits 1
 *      (ENOENT), `plugin update` exits 1 ("not found"), and `plugin install` exits 1
 *      ("not found in marketplace"). Re-pointing is the only way out, which is why
 *      `ensureMarketplaceAt` runs FIRST and unconditionally.
 *   7. `plugin update` alone refreshes the cache — no `marketplace update` needed for a
 *      `directory` source. See the comment in `installGuardPlugin`.
 *   8. The plugin's CACHE survives the source vanishing, so enforcement keeps working
 *      and the failure stays silent until an update or reinstall is attempted.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeRunner } from "../setup-io.js";

// ── Pinned identifiers ───────────────────────────────────────────────────────

/** Marketplace name (from `plugin/.claude-plugin/marketplace.json`). */
export const GUARD_MARKETPLACE_NAME = "agenttrail-guard";
/** Plugin name (from `plugin/.claude-plugin/plugin.json`). */
export const GUARD_PLUGIN_NAME = "agenttrail-guard";
/** Fully-qualified install id: `<plugin>@<marketplace>`. */
export const GUARD_PLUGIN_ID = `${GUARD_PLUGIN_NAME}@${GUARD_MARKETPLACE_NAME}`;

/**
 * The agenttrail plugin's install id, for coexistence detection only.
 *
 * Matched EXACTLY, never by suffix. A suffix test is what creates the coupling the
 * separate identity exists to prevent.
 */
export const AGENTTRAIL_PLUGIN_ID = "agenttrail@agenttrail";

/**
 * Minimum Claude Code version for the plugin path. Do not lower it without verifying
 * the plugin commands on the older version.
 */
export const MIN_CLAUDE_VERSION = "2.1.211";

/** MVP pins scope to `user`; a caller cannot widen it. */
export type PluginScope = "user";

// ── Typed errors ─────────────────────────────────────────────────────────────

/** `claude` is not installed / not on PATH. */
export class ClaudeCliNotFoundError extends Error {
  constructor() {
    super(
      "Claude Code (`claude`) was not found on your PATH. Install Claude Code first, " +
        "then re-run — see https://docs.claude.com/en/docs/claude-code.",
    );
    this.name = "ClaudeCliNotFoundError";
  }
}

/** The installed Claude Code is too old for the plugin system. */
export class PluginUnsupportedError extends Error {
  constructor(
    readonly foundVersion: string | null,
    readonly minVersion: string = MIN_CLAUDE_VERSION,
  ) {
    super(
      `This Claude Code version (${foundVersion ?? "unknown"}) does not support plugins. ` +
        `Upgrade Claude Code to ${minVersion} or newer, then re-run.`,
    );
    this.name = "PluginUnsupportedError";
  }
}

/** A `claude plugin …` invocation exited non-zero. */
export class PluginCommandError extends Error {
  constructor(
    readonly step: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `\`claude plugin ${step}\` failed (exit ${exitCode ?? "null"}): ` +
        `${stderr.trim() || "no stderr"}`,
    );
    this.name = "PluginCommandError";
  }
}

// ── Version gate ─────────────────────────────────────────────────────────────

/** Extract an `x.y.z` triple from `claude --version` ("2.1.263 (Claude Code)"). */
export function parseClaudeVersion(output: string): [number, number, number] | null {
  const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True iff `version` >= `min`. */
export function isVersionAtLeast(
  version: [number, number, number],
  min: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    const v = version[i] as number;
    const m = min[i] as number;
    if (v > m) return true;
    if (v < m) return false;
  }
  return true;
}

const MIN_VERSION_TUPLE = parseClaudeVersion(MIN_CLAUDE_VERSION) as [number, number, number];

/**
 * Ensure `claude` exists and is new enough.
 *
 * An UNPARSEABLE version proceeds rather than failing: "cannot tell" is not "too old".
 * Blocking on it would strand users on any future version
 * string we did not anticipate.
 */
export function ensureClaudeSupportsPlugins(runner: ClaudeRunner): void {
  const r = runner(["--version"]);
  if (r.spawnError !== undefined) throw new ClaudeCliNotFoundError();
  const parsed = parseClaudeVersion(r.stdout);
  if (parsed && !isVersionAtLeast(parsed, MIN_VERSION_TUPLE)) {
    throw new PluginUnsupportedError(r.stdout.trim() || null);
  }
}

// ── Registry readers ─────────────────────────────────────────────────────────

/** One row of `claude plugin list --json`, as far as we trust it. */
export interface InstalledPlugin {
  readonly id: string;
  readonly version: string | undefined;
  /** `false` means installed but NOT enforcing. See `readInstalledPlugin`. */
  readonly enabled: boolean;
  /**
   * Vendor-reported load failures for THIS row; `[]` when healthy.
   *
   * Observed with 2.1.263: delete the marketplace's source directory and the row grows
   * `"errors": ["Marketplace agenttrail-guard failed to load: cache-miss"]`, which
   * CLEARS by itself the moment the marketplace is re-pointed. That makes it a live
   * health signal, and the only one that will still work once the source is `npm`
   * and there is no local path left to stat.
   *
   * We never match the message TEXT. `cache-miss` is a vendor-internal word and
   * pattern-matching it would be a hostage to the next release; "we never expect an
   * error on our own row" is durable, so ANY non-empty array is a problem and the
   * vendor's own string is what gets shown to the user. An ABSENT field is healthy —
   * see `readInstalledPlugin`.
   */
  readonly errors: readonly string[];
}

function parseArray(stdout: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Look up one installed plugin by exact id.
 *
 * Returns `enabled` because reading only `id` cannot distinguish a disabled plugin:
 * after `claude plugin disable`, the row is still listed with `"enabled": false`.
 * `status` distinguishes the two states on the strength of this field.
 *
 * Conservative on uncertainty: a non-zero exit or unparseable payload reads as
 * "not installed", which makes `init` try rather than wrongly skip.
 */
export function readInstalledPlugin(runner: ClaudeRunner, id: string): InstalledPlugin | undefined {
  const r = runner(["plugin", "list", "--json"]);
  if (r.code !== 0) return undefined;
  const arr = parseArray(r.stdout);
  if (arr === undefined) return undefined;
  for (const row of arr) {
    if (row === null || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (rec.id !== id) continue;
    return {
      id,
      version: typeof rec.version === "string" ? rec.version : undefined,
      // Absent `enabled` reads as enabled: the field is a disable marker, and treating
      // "not stated" as disabled would under-report a working install.
      enabled: rec.enabled !== false,
      // Absent `errors` reads as HEALTHY, for the same reason in the other direction:
      // the field only appears when something is wrong, so treating "not stated" as
      // broken would put a scary, unactionable line in front of a working install.
      errors: readStringArray(rec.errors),
    };
  }
  return undefined;
}

/** Every string in `value`, or `[]` if it is not an array of them. Never throws. */
function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Is the agenttrail plugin installed? Exact id, never a suffix match. */
export function agenttrailPluginPresent(runner: ClaudeRunner): boolean {
  return readInstalledPlugin(runner, AGENTTRAIL_PLUGIN_ID) !== undefined;
}

/**
 * How our marketplace registration is doing, as far as we can see it.
 *
 * `unknown` is NOT a synonym for "broken". A non-zero exit or unparseable payload
 * means we could not look, and reporting a problem we could not see would put an
 * unactionable warning in front of a user whose install is fine.
 */
export type MarketplaceHealth =
  /** Registered, and the recorded source is still there. */
  | { readonly kind: "ok"; readonly path: string }
  /** Registered, but the recorded source has vanished from disk. */
  | { readonly kind: "dangling"; readonly path: string }
  /** No row with our name — a first install, or someone removed it. */
  | { readonly kind: "unregistered" }
  /** The listing could not be read. Say nothing rather than guess. */
  | { readonly kind: "unknown" };

/**
 * Read the marketplace row and decide whether its source still exists.
 *
 * This is the CORROBORATING channel; the primary one is `InstalledPlugin.errors`.
 * Two channels because each covers the other's blind spot: this stat is the only one
 * that survives a future CLI dropping `errors`, and `errors` is the only one that
 * survives a move to an `npm` source, which has no local path to stat.
 * Agreement is the normal case; disagreement is reported, not resolved by precedence.
 *
 * With 2.1.263 and a deleted source directory, this listing still reports the
 * stale path at exit 0 and carries NO error field of its own — so the dangle is
 * invisible here unless we stat the path ourselves. That is why this function exists
 * rather than a simple "is it registered" check.
 */
export function readMarketplaceHealth(
  runner: ClaudeRunner,
  pathExists: (p: string) => boolean,
): MarketplaceHealth {
  const r = runner(["plugin", "marketplace", "list", "--json"]);
  if (r.code !== 0) return { kind: "unknown" };
  const arr = parseArray(r.stdout);
  if (arr === undefined) return { kind: "unknown" };
  for (const row of arr) {
    if (row === null || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (rec.name !== GUARD_MARKETPLACE_NAME) continue;
    const path = rec.path;
    // Registered under our name but with no readable path: we cannot stat what we
    // cannot see, and that is "could not look", not "broken".
    if (typeof path !== "string") return { kind: "unknown" };
    return pathExists(path) ? { kind: "ok", path } : { kind: "dangling", path };
  }
  return { kind: "unregistered" };
}

/**
 * True iff ANY `*@agenttrail-guard` plugin remains installed.
 *
 * FAIL-SAFE, INVERTED polarity — read this before "simplifying" it. It gates the
 * destructive `marketplace remove` in `uninstallGuardPlugin`, so `false` means "go
 * ahead and delete". Under ANY uncertainty — non-zero exit, unparseable JSON, or a
 * parsed-but-non-array payload — it returns `true` (assume one remains → SKIP), so we
 * can never orphan a second guard plugin whose marketplace we just deleted. Cost of
 * erring this way is inert residue.
 *
 * This is the OPPOSITE polarity from the readers above, on purpose. Do not collapse
 * the non-array guard into `Array.isArray(x) && x.some(...)` — that returns `false` on
 * a non-array and re-opens the fail-open bug.
 */
export function anyGuardPluginRemains(runner: ClaudeRunner): boolean {
  const r = runner(["plugin", "list", "--json"]);
  if (r.code !== 0) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return true;
  }
  if (!Array.isArray(parsed)) return true;
  return parsed.some((p) => {
    const id = (p as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.endsWith(`@${GUARD_MARKETPLACE_NAME}`);
  });
}

// ── Scaffold resolution ──────────────────────────────────────────────────────

/** Directory of the current module — format-safe. */
function currentModuleDir(): string {
  const url = (import.meta as { url?: string }).url;
  if (url) return dirname(fileURLToPath(url));
  return typeof __dirname !== "undefined" ? __dirname : process.cwd();
}

/**
 * Resolve the bundled `plugin/` scaffold — the marketplace source.
 *
 * Walks up from this module until it finds `plugin/.claude-plugin/marketplace.json`,
 * so it works from `dist/cli.js`, from `src/` under vitest, and from an unpacked npm
 * tarball. The source is therefore a LOCAL PATH and the install makes no network call.
 */
export function resolvePluginScaffoldDir(fromDir?: string): string {
  let dir = fromDir ?? currentModuleDir();
  for (;;) {
    const candidate = join(dir, "plugin");
    if (existsSync(join(candidate, ".claude-plugin", "marketplace.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate the bundled guard plugin scaffold " +
      "(plugin/.claude-plugin/marketplace.json). The package may be published without " +
      "its `plugin/` directory.",
  );
}

// ── Install / refresh / uninstall ────────────────────────────────────────────

/**
 * What `ensureMarketplaceAt` did.
 *
 * `repointed` and `recovered` are both one `marketplace add`; they are separate because
 * the SENTENCE the user should read differs. "Moved" is housekeeping. "The source you
 * were pointing at is gone" is the failure this check exists for, and saying so is how
 * a person learns their install had silently stopped being updatable.
 */
export type MarketplaceAction =
  /** Nothing was registered under our name. */
  | "added"
  /** Registered elsewhere, and that elsewhere still existed. */
  | "repointed"
  /** Registered at a path that had VANISHED. The dangle, repaired. */
  | "recovered"
  /** Already ours and still on disk — no argv issued. */
  | "unchanged";

/**
 * Point our marketplace at `scaffoldDir`, adding or re-pointing as needed.
 *
 * ONE `marketplace add`, because it is an upsert: re-adding the same name
 * with a different path exits 0 and the recorded path becomes the new one. There is
 * deliberately NO `marketplace remove` on this path: removing while our plugin is
 * installed would deregister the plugin and orphan its cache (see the module docblock).
 *
 * Re-points when the recorded path differs from ours OR has vanished from disk. The
 * vanishing case is the one that motivates the requirement: a `directory` source pins
 * an absolute path, and under `npx` that is a package-manager cache which may be
 * collected. `marketplace update` cannot help there — it re-reads the RECORDED source,
 * which is precisely what is gone.
 */
export function ensureMarketplaceAt(
  runner: ClaudeRunner,
  scaffoldDir: string,
  pathExists: (p: string) => boolean,
  scope: PluginScope = "user",
): MarketplaceAction {
  const health = readMarketplaceHealth(runner, pathExists);
  if (health.kind === "ok" && health.path === scaffoldDir) return "unchanged";

  const add = runner(["plugin", "marketplace", "add", scaffoldDir, "--scope", scope]);
  if (add.code !== 0) throw new PluginCommandError("marketplace add", add.code, add.stderr);

  if (health.kind === "dangling") return "recovered";
  if (health.kind === "ok") return "repointed";
  // `unregistered` and `unknown` both land on "added", and that is deliberate.
  // "Re-pointed" asserts there WAS a different pointer — under `unknown` we could not
  // read the listing, so we do not know that and must not say it. What is true either
  // way is that the marketplace is now registered at our path, which is what "added"
  // claims. Issuing the `add` under uncertainty is safe: it is an idempotent upsert
  // (the same path re-added exits 0 with "already on disk").
  return "added";
}

export type InstallStatus =
  | "installed"
  | "already-installed"
  | "refreshed"
  /** We tried to refresh and the version did NOT move. Never reported as success. */
  | "refresh-failed";

export interface InstallResult {
  readonly status: InstallStatus;
  readonly pluginId: string;
  readonly scope: PluginScope;
  readonly marketplace: MarketplaceAction;
  /** True when the installed plugin is present but `claude plugin disable`d. */
  readonly disabled: boolean;
  /** On `refresh-failed`, whatever the vendor said. Shown verbatim, never paraphrased. */
  readonly refreshError?: string;
  /**
   * Vendor-reported errors still on our row AFTER the marketplace was ensured.
   *
   * Re-pointing clears them, so a non-empty array here is unexpected, and `init` says
   * so rather than staying quiet.
   */
  readonly marketplaceErrors: readonly string[];
}

/**
 * Install (or refresh) the guard plugin at `--scope user`. Idempotent.
 *
 * "Refresh" exists because Claude Code runs its own CACHED COPY at
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, not the directory we
 * pointed at — so editing the package on disk changes nothing that runs. A version
 * mismatch between the installed record and our bundled `plugin.json` is the cheap,
 * precise signal for "the cache is stale", and we then update rather than silently
 * skip.
 */
export function installGuardPlugin(options: {
  runner: ClaudeRunner;
  scaffoldDir: string;
  bundledVersion: string | undefined;
  pathExists: (p: string) => boolean;
  scope?: PluginScope;
}): InstallResult {
  const { runner, scaffoldDir, bundledVersion, pathExists } = options;
  const scope: PluginScope = options.scope ?? "user";

  ensureClaudeSupportsPlugins(runner);

  const marketplace = ensureMarketplaceAt(runner, scaffoldDir, pathExists, scope);
  const existing = readInstalledPlugin(runner, GUARD_PLUGIN_ID);

  if (existing !== undefined) {
    const stale = bundledVersion !== undefined && existing.version !== bundledVersion;
    if (!stale) {
      return {
        status: "already-installed",
        pluginId: GUARD_PLUGIN_ID,
        scope,
        marketplace,
        disabled: !existing.enabled,
        marketplaceErrors: existing.errors,
      };
    }

    // ── ONE call, and then we CHECK ─────────────────────────────────────────
    // There is deliberately no `plugin marketplace update` here. With
    // the marketplace already pointing at a real directory, `plugin update` ALONE
    // moved 0.1.0 → 0.2.0 and the cache genuinely held the new bytes — because for a
    // `directory` source `installLocation === path`, so Claude Code reads the folder
    // in place and keeps no separate marketplace copy. The extra call was redundant,
    // AND it is the one that exits 1 on a dangling path (ENOENT), which is precisely
    // the failure this code exists for. For an `npm` source it may matter, since the
    // marketplace would then have a cache of its own — verify before adopting one.
    const upd = runner(["plugin", "update", GUARD_PLUGIN_ID, "--scope", scope]);

    // Do not take the exit code's word for it, and do not take our own intention for
    // it either. Re-read the registry: the only evidence that a refresh happened is
    // the installed version having actually moved.
    const after = readInstalledPlugin(runner, GUARD_PLUGIN_ID);
    const moved = after?.version === bundledVersion;
    // No throw. A failed refresh leaves the working older version installed, which is
    // strictly better than a hard exit — but it is reported, not swallowed.
    return {
      status: moved ? "refreshed" : "refresh-failed",
      pluginId: GUARD_PLUGIN_ID,
      scope,
      marketplace,
      disabled: !(after ?? existing).enabled,
      ...(moved ? {} : { refreshError: upd.stderr.trim() || `exit ${upd.code ?? "null"}` }),
      marketplaceErrors: (after ?? existing).errors,
    };
  }

  const install = runner(["plugin", "install", GUARD_PLUGIN_ID, "--scope", scope]);
  if (install.code !== 0) throw new PluginCommandError("install", install.code, install.stderr);

  return {
    status: "installed",
    pluginId: GUARD_PLUGIN_ID,
    scope,
    marketplace,
    disabled: false,
    marketplaceErrors: [],
  };
}

export type UninstallStatus = "removed" | "not-installed";

export interface UninstallResult {
  readonly status: UninstallStatus;
  readonly pluginId: string;
  readonly scope: PluginScope;
  readonly marketplaceRemoved: boolean;
}

/**
 * Uninstall the guard plugin. Running it twice is not an error.
 *
 * ── The pre-check is LOAD-BEARING. Do not delete it as redundant. ────────────
 * `claude plugin uninstall <id>` on a plugin that is not installed exits **1** with
 * "not found in installed plugins", so "running it twice is not an error" is provided
 * ENTIRELY by returning early here without ever issuing the argv. Remove this and the
 * second `uninstall` starts failing.
 *
 * ── The ORDER is load-bearing too. ───────────────────────────────────────────
 * `marketplace remove` cascades — run first, it deregisters the plugin
 * (`plugin list` → `[]`), the subsequent `uninstall` then FAILS, and the plugin's cache
 * directory is left orphaned on disk. So: uninstall the plugin, THEN remove the
 * marketplace. Never the reverse.
 *
 * The marketplace removal is guarded (no other `@agenttrail-guard` plugin remains) and
 * best-effort — its result is ignored, because the plugin is already gone and that is
 * the part that matters. `--scope user` is pinned: `marketplace remove` without a scope
 * strips the declaration from EVERY scope, which could delete a project-scoped entry in
 * a team repo we never wrote.
 */
export function uninstallGuardPlugin(options: {
  runner: ClaudeRunner;
  scope?: PluginScope;
}): UninstallResult {
  const { runner } = options;
  const scope: PluginScope = options.scope ?? "user";

  ensureClaudeSupportsPlugins(runner);

  if (readInstalledPlugin(runner, GUARD_PLUGIN_ID) === undefined) {
    return {
      status: "not-installed",
      pluginId: GUARD_PLUGIN_ID,
      scope,
      marketplaceRemoved: false,
    };
  }

  const uninstall = runner(["plugin", "uninstall", GUARD_PLUGIN_ID, "--scope", scope]);
  if (uninstall.code !== 0) {
    throw new PluginCommandError("uninstall", uninstall.code, uninstall.stderr);
  }

  let marketplaceRemoved = false;
  if (!anyGuardPluginRemains(runner)) {
    runner(["plugin", "marketplace", "remove", GUARD_MARKETPLACE_NAME, "--scope", scope]);
    marketplaceRemoved = true;
  }

  return { status: "removed", pluginId: GUARD_PLUGIN_ID, scope, marketplaceRemoved };
}
