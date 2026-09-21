/**
 * The one acceptance criterion no fake can satisfy: prove the recovery works on a
 * directory that has GENUINELY been deleted, driving the REAL `claude` binary.
 *
 * ── OPT-IN (not run in CI) ───────────────────────────────────────────────────
 * Gated behind `AGENTTRAIL_E2E_LIVE_CLAUDE=1` and skipped when `claude` is absent, so
 * the default `pnpm test` never attempts it. Run it with:
 *
 *     AGENTTRAIL_E2E_LIVE_CLAUDE=1 pnpm test src/__tests__/live-plugin-durability.test.ts
 *
 * It needs **no auth and no network**: every `claude plugin …` subcommand used here
 * works in a bare temporary HOME.
 *
 * ── Why a fake cannot cover this ─────────────────────────────────────────────
 * Every claim the implementation rests on is a claim about a vendor binary: that the
 * plugin CACHE survives its source vanishing, that `plugin list --json` grows an
 * `errors` array and later drops it, that `marketplace add` upserts, and that
 * `plugin update` alone moves the cache. A fake asserts our reading of those; only
 * this file asserts the vendor. If Claude Code changes any of them, this is what
 * notices.
 *
 * ── HOME is redirected, always ───────────────────────────────────────────────
 * Every `claude` invocation runs with `HOME` pointed at a throwaway directory, so this
 * test can never touch the developer's own `~/.claude`. That is not a nicety: the
 * commands here register and deregister marketplaces.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runStatus } from "../commands/status.js";
import {
  GUARD_MARKETPLACE_NAME,
  GUARD_PLUGIN_ID,
  installGuardPlugin,
  readInstalledPlugin,
  readMarketplaceHealth,
} from "../plugin/install.js";
import type { ClaudeRunner, SetupIO } from "../setup-io.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAFFOLD_SRC = join(HERE, "..", "..", "plugin");

/**
 * Opt-in FIRST, probe second — the order matters and it is not stylistic.
 *
 * Probing for `claude` at module scope would run a synchronous subprocess on every
 * import, including the ~99% of runs where this suite is skipped. That blocks a vitest
 * worker for the length of a process spawn during the import phase, which is enough to
 * shift when the other workers start — and this package has two suites that rebuild the
 * shared `plugin/scripts/guard-hook.mjs` with tsup while five suites execute it. Doing
 * it here made that latent race fail roughly one run in three; making the probe lazy
 * made it go away again. (The race itself is real and still latent — reported on the PR,
 * not papered over here.)
 */
const OPTED_IN = process.env.AGENTTRAIL_E2E_LIVE_CLAUDE === "1";
const ENABLED = OPTED_IN && spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

let sandbox: string;
let home: string;

/** A runner bound to the throwaway HOME. Never touches the real `~/.claude`. */
function runnerFor(homeDir: string): ClaudeRunner {
  return (args) => {
    const r = spawnSync("claude", [...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error) return { code: null, stdout: "", stderr: "", spawnError: r.error.message };
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** Copy the real bundled scaffold to `dest`, optionally restamping its version. */
function plantScaffold(dest: string, version?: string): string {
  mkdirSync(dest, { recursive: true });
  cpSync(SCAFFOLD_SRC, join(dest, "plugin"), { recursive: true });
  if (version !== undefined) {
    const manifest = join(dest, "plugin", ".claude-plugin", "plugin.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    parsed.version = version;
    writeFileSync(manifest, JSON.stringify(parsed, null, 2));
  }
  // A marker inside the copy, so we can prove WHICH copy the cache actually holds —
  // a version number alone would not distinguish "updated" from "relabelled".
  writeFileSync(join(dest, "plugin", "scripts", "which-copy.txt"), dest);
  return join(dest, "plugin");
}

/** A SetupIO wired to the sandbox HOME, for driving `runStatus` end to end. */
function sandboxIo(homeDir: string, out: string[]): SetupIO {
  return {
    writeStdout: (t) => out.push(t),
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
    exists: (p) => existsSync(p),
    writeFileAtomic: (p, text) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    },
    homedir: () => homeDir,
    runClaude: runnerFor(homeDir),
  };
}

beforeAll(() => {
  if (!ENABLED) return;
  sandbox = mkdtempSync(join(tmpdir(), "guard-durability-"));
  home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
});

afterAll(() => {
  if (!ENABLED || sandbox === undefined) return;
  rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("live: a vanished marketplace source, and the recovery", () => {
  it("installs, then survives its source being deleted — and says so", () => {
    const first = plantScaffold(join(sandbox, "npx-cache-v1"));
    const runner = runnerFor(home);

    const installed = installGuardPlugin({
      runner,
      scaffoldDir: first,
      bundledVersion: "0.1.0",
      pathExists: existsSync,
    });
    expect(installed.status).toBe("installed");
    expect(installed.marketplaceErrors).toEqual([]);
    expect(readMarketplaceHealth(runner, existsSync)).toEqual({ kind: "ok", path: first });

    // A HEALTHY re-run must be inert. Snapshot the two files Claude Code owns and
    // require them byte-identical afterwards — the strongest form of the idempotence
    // criterion, because it is asserted against the vendor rather than our argv.
    const settings = join(home, ".claude", "settings.json");
    const registry = join(home, ".claude", "plugins", "installed_plugins.json");
    const before = [readFileSync(settings, "utf8"), readFileSync(registry, "utf8")];
    const again = installGuardPlugin({
      runner,
      scaffoldDir: first,
      bundledVersion: "0.1.0",
      pathExists: existsSync,
    });
    expect(again.status).toBe("already-installed");
    expect(again.marketplace).toBe("unchanged");
    expect([readFileSync(settings, "utf8"), readFileSync(registry, "utf8")]).toEqual(before);

    // ── THE VANISH. A real directory, really deleted. ────────────────────────
    rmSync(join(sandbox, "npx-cache-v1"), { recursive: true, force: true });
    expect(existsSync(first)).toBe(false);

    // The cache survives, so the guard is still enforcing and nothing looks wrong.
    const row = readInstalledPlugin(runner, GUARD_PLUGIN_ID);
    expect(row?.enabled).toBe(true);
    expect(row?.errors.length).toBeGreaterThan(0);
    expect(readMarketplaceHealth(runner, existsSync)).toEqual({ kind: "dangling", path: first });

    // …and `status` is where a person finds out.
    const out: string[] = [];
    void runStatus(sandboxIo(home, out));
    const text = out.join("");
    expect(text).toContain("PROBLEM: the plugin source is missing");
    expect(text).toContain("npx @agenttrail/guard@latest init --agent claude");
  });

  it("recovers from the dangle and refreshes to the new version, cache and all", () => {
    // A fresh unpack at a NEW path carrying a NEWER version — exactly what `npx` does
    // after npm has collected the old one.
    const second = plantScaffold(join(sandbox, "npx-cache-v2"), "0.2.0");
    const runner = runnerFor(home);

    const result = installGuardPlugin({
      runner,
      scaffoldDir: second,
      bundledVersion: "0.2.0",
      pathExists: existsSync,
    });

    expect(result.marketplace).toBe("recovered");
    expect(result.status).toBe("refreshed");
    // The vendor's error cleared by itself once re-pointed — the property the whole
    // detection channel rests on.
    expect(result.marketplaceErrors).toEqual([]);
    expect(readMarketplaceHealth(runner, existsSync)).toEqual({ kind: "ok", path: second });

    const row = readInstalledPlugin(runner, GUARD_PLUGIN_ID);
    expect(row?.version).toBe("0.2.0");
    expect(row?.errors).toEqual([]);

    // The decisive assertion: the CACHE holds the new bytes, not merely a new label.
    const cached = join(
      home,
      ".claude",
      "plugins",
      "cache",
      GUARD_MARKETPLACE_NAME,
      "agenttrail-guard",
      "0.2.0",
      "scripts",
      "which-copy.txt",
    );
    expect(existsSync(cached)).toBe(true);
    expect(readFileSync(cached, "utf8")).toBe(join(sandbox, "npx-cache-v2"));

    // And once recovered, it is inert again.
    const settled = installGuardPlugin({
      runner,
      scaffoldDir: second,
      bundledVersion: "0.2.0",
      pathExists: existsSync,
    });
    expect(settled.status).toBe("already-installed");
    expect(settled.marketplace).toBe("unchanged");

    const out: string[] = [];
    void runStatus(sandboxIo(home, out));
    expect(out.join("")).not.toContain("plugin source is missing");
  });
});
