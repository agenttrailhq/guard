// cspell:words repointed
/**
 * The `claude plugin …` wrapper: the failure matrix, and the vendor behaviors observed
 * with Claude Code 2.1.263.
 *
 * The fake runner records every argv, so the assertions are about *what we asked the
 * vendor to do* — which is the part we control. Each vendor behavior has a test whose
 * name states it.
 */

import { describe, expect, it } from "vitest";
import {
  AGENTTRAIL_PLUGIN_ID,
  agenttrailPluginPresent,
  ClaudeCliNotFoundError,
  ensureMarketplaceAt,
  GUARD_MARKETPLACE_NAME,
  GUARD_PLUGIN_ID,
  installGuardPlugin,
  PluginCommandError,
  PluginUnsupportedError,
  parseClaudeVersion,
  readInstalledPlugin,
  readMarketplaceHealth,
  uninstallGuardPlugin,
} from "../plugin/install.js";
import type { ClaudeRunner, ClaudeRunResult } from "../setup-io.js";

const OK: ClaudeRunResult = { code: 0, stdout: "", stderr: "" };

interface Fake {
  runner: ClaudeRunner;
  calls: string[][];
  /** Every argv joined, for readable "did we ever run X" assertions. */
  ran(fragment: string): boolean;
}

/**
 * A fake `claude`.
 *
 * `plugins` is the mutable installed list, so a test can assert the SEQUENCE of calls
 * against changing state — which is what the uninstall-ordering test needs.
 */
function fakeClaude(
  options: {
    version?: string;
    spawnError?: string;
    plugins?: Array<{ id: string; version?: string; enabled?: boolean; errors?: string[] }>;
    marketplaces?: Array<{ name: string; path?: string }>;
    failOn?: (argv: readonly string[]) => ClaudeRunResult | undefined;
    /**
     * Version `plugin update` moves our row to. Absent → the update changes nothing,
     * which is how a FAILED refresh looks from the outside: exit 0, version unmoved.
     * The refresh verdict comes from re-reading the registry, not from the exit code,
     * so a test has to be able to produce that state.
     */
    updateMovesTo?: string;
  } = {},
): Fake {
  const calls: string[][] = [];
  const plugins = options.plugins ?? [];
  const marketplaces = options.marketplaces ?? [];

  const runner: ClaudeRunner = (args) => {
    calls.push([...args]);
    const argv = args.join(" ");

    const forced = options.failOn?.(args);
    if (forced !== undefined) return forced;

    // A successful `plugin update` really moves the row, so the post-condition check
    // sees what it would see in reality. With a static list every refresh would look
    // failed and the "refreshed" branch could never be reached.
    if (args[1] === "update" && options.updateMovesTo !== undefined) {
      const row = plugins.find((p) => p.id === args[2]);
      if (row !== undefined) row.version = options.updateMovesTo;
      return OK;
    }

    // A successful uninstall really removes the row, so the post-uninstall
    // `anyGuardPluginRemains` guard sees the state it would see in reality. With a
    // static list it would always find our own plugin still present and skip the
    // marketplace removal — hiding the very ordering this file asserts.
    if (args[1] === "uninstall") {
      const i = plugins.findIndex((p) => p.id === args[2]);
      if (i >= 0) plugins.splice(i, 1);
      return OK;
    }

    if (args[0] === "--version") {
      if (options.spawnError !== undefined) {
        return { code: null, stdout: "", stderr: "", spawnError: options.spawnError };
      }
      return { ...OK, stdout: `${options.version ?? "2.1.263"} (Claude Code)` };
    }
    if (argv === "plugin list --json") {
      return {
        ...OK,
        stdout: JSON.stringify(
          plugins.map((p) => ({
            id: p.id,
            version: p.version ?? "0.1.0",
            scope: "user",
            enabled: p.enabled ?? true,
            // Emitted ONLY when set, like the real CLI: the key is absent on a healthy row and
            // appears when the marketplace fails to load. A fake that always emits `errors: []`
            // would make "absent reads as healthy" untestable.
            ...(p.errors === undefined ? {} : { errors: p.errors }),
          })),
        ),
      };
    }
    if (argv === "plugin marketplace list --json") {
      return {
        ...OK,
        stdout: JSON.stringify(
          marketplaces.map((m) => ({ name: m.name, source: "directory", path: m.path })),
        ),
      };
    }
    return OK;
  };

  return { runner, calls, ran: (f) => calls.some((c) => c.join(" ").includes(f)) };
}

describe("the failure matrix", () => {
  it("`claude` not on PATH → a named error, not a stack trace", () => {
    const fake = fakeClaude({ spawnError: "ENOENT" });
    expect(() =>
      installGuardPlugin({
        runner: fake.runner,
        scaffoldDir: "/pkg/plugin",
        bundledVersion: "0.1.0",
        pathExists: () => true,
      }),
    ).toThrow(ClaudeCliNotFoundError);
  });

  it("Claude Code too old → names the found version and the needed one", () => {
    const fake = fakeClaude({ version: "2.1.100" });
    try {
      installGuardPlugin({
        runner: fake.runner,
        scaffoldDir: "/pkg/plugin",
        bundledVersion: "0.1.0",
        pathExists: () => true,
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginUnsupportedError);
      expect((error as Error).message).toContain("2.1.100");
      expect((error as Error).message).toContain("2.1.211");
    }
  });

  it("an UNPARSEABLE version PROCEEDS — 'cannot tell' is not 'too old'", () => {
    const fake = fakeClaude({ version: "definitely-not-a-version" });
    const r = installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
    });
    expect(r.status).toBe("installed");
  });

  it("a failing `marketplace add` surfaces as a named PluginCommandError", () => {
    const fake = fakeClaude({
      failOn: (a) =>
        a[1] === "marketplace" && a[2] === "add"
          ? { code: 1, stdout: "", stderr: "catalog unreadable" }
          : undefined,
    });
    expect(() =>
      installGuardPlugin({
        runner: fake.runner,
        scaffoldDir: "/pkg/plugin",
        bundledVersion: "0.1.0",
        pathExists: () => true,
      }),
    ).toThrow(PluginCommandError);
  });

  it("already installed → no second install argv is ever issued", () => {
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }] });
    const r = installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
      // Marketplace already correct, so nothing should be re-pointed either.
    });
    expect(r.status).toBe("already-installed");
    expect(fake.ran("plugin install")).toBe(false);
  });
});

describe("`marketplace add` is an upsert, so re-pointing is ONE call", () => {
  const scaffold = "/pkg/plugin";

  it("re-points a moved marketplace with `add` alone — and never calls `remove`", () => {
    const fake = fakeClaude({
      marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: "/old/gone/plugin" }],
    });
    const action = ensureMarketplaceAt(fake.runner, scaffold, () => true);

    expect(action).toBe("repointed");
    expect(fake.ran(`plugin marketplace add ${scaffold} --scope user`)).toBe(true);
    // The whole point: `remove` would deregister an installed plugin and orphan its
    // cache. `add` overwrites the entry in place, so `remove` is never needed here.
    expect(fake.ran("marketplace remove")).toBe(false);
  });

  it("re-points when the recorded path has VANISHED, even if the name matches", () => {
    // The case the durability requirement exists for: a `directory` source pins an
    // absolute path, and under `npx` that is a cache the package manager may collect.
    //
    // This outcome was SPLIT out of `repointed` into `recovered`. Same behavior —
    // still one `add`, still no `remove` — but named apart, because the sentence `init`
    // prints for "your source is gone" is not the one it prints for "it moved".
    const fake = fakeClaude({
      marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: scaffold }],
    });
    const action = ensureMarketplaceAt(fake.runner, scaffold, () => false);
    expect(action).toBe("recovered");
    expect(fake.ran("marketplace add")).toBe(true);
    expect(fake.ran("marketplace remove")).toBe(false);
  });

  it("does nothing when the recorded path is already ours and still exists", () => {
    const fake = fakeClaude({
      marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: scaffold }],
    });
    expect(ensureMarketplaceAt(fake.runner, scaffold, () => true)).toBe("unchanged");
    expect(fake.ran("marketplace add")).toBe(false);
  });

  it("adds it when no marketplace is registered at all", () => {
    const fake = fakeClaude();
    expect(ensureMarketplaceAt(fake.runner, scaffold, () => true)).toBe("added");
    expect(fake.ran(`marketplace add ${scaffold} --scope user`)).toBe(true);
  });
});

describe("`plugin uninstall` exits 1 when absent — idempotence is ours", () => {
  it("does not issue the uninstall argv at all when nothing is installed", () => {
    // If the pre-check is ever deleted as 'redundant', this goes red — which is the
    // whole reason it exists, because the vendor's own exit code is 1 here.
    const fake = fakeClaude({ plugins: [] });
    const r = uninstallGuardPlugin({ runner: fake.runner });

    expect(r.status).toBe("not-installed");
    expect(fake.ran("plugin uninstall")).toBe(false);
  });

  it("uninstalls, THEN removes the marketplace — never the reverse", () => {
    // `marketplace remove` first deregisters the plugin, makes `uninstall`
    // fail, and orphans the cache directory. Order is load-bearing, so it is asserted
    // as an order, not as two independent facts.
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    const r = uninstallGuardPlugin({ runner: fake.runner });

    expect(r.status).toBe("removed");
    const uninstallAt = fake.calls.findIndex((c) => c.join(" ").includes("plugin uninstall"));
    const removeAt = fake.calls.findIndex((c) => c.join(" ").includes("marketplace remove"));
    expect(uninstallAt).toBeGreaterThanOrEqual(0);
    expect(removeAt).toBeGreaterThan(uninstallAt);
  });

  it("every `marketplace remove` is scoped to user — it strips ALL scopes without one", () => {
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    uninstallGuardPlugin({ runner: fake.runner });
    for (const call of fake.calls.filter((c) => c.join(" ").includes("marketplace remove"))) {
      expect(call).toContain("--scope");
      expect(call).toContain("user");
    }
  });

  it("skips the marketplace removal while another guard plugin remains", () => {
    // Fail-safe, inverted polarity: never orphan a second plugin whose marketplace we
    // just deleted. Here a sibling stays installed after ours is removed.
    const fake = fakeClaude({
      plugins: [{ id: GUARD_PLUGIN_ID }, { id: `other@${GUARD_MARKETPLACE_NAME}` }],
    });
    const r = uninstallGuardPlugin({ runner: fake.runner });
    expect(r.marketplaceRemoved).toBe(false);
    expect(fake.ran("marketplace remove")).toBe(false);
  });

  it("skips the removal under UNCERTAINTY — an unparseable plugin list", () => {
    let listed = 0;
    const runner: ClaudeRunner = (args) => {
      const argv = args.join(" ");
      if (args[0] === "--version") return { ...OK, stdout: "2.1.263" };
      if (argv === "plugin list --json") {
        listed += 1;
        // Installed on the pre-check; garbage on the post-uninstall guard.
        return listed === 1
          ? { ...OK, stdout: JSON.stringify([{ id: GUARD_PLUGIN_ID, enabled: true }]) }
          : { ...OK, stdout: "{not json" };
      }
      return OK;
    };
    const r = uninstallGuardPlugin({ runner });
    expect(r.marketplaceRemoved).toBe(false);
  });
});

describe("`plugin list --json` carries `enabled`", () => {
  it("reports an installed-but-DISABLED plugin as disabled, not merely installed", () => {
    // A reader of only `id` would call this "installed". It is
    // installed and enforcing nothing, which is the state `status` must distinguish.
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID, enabled: false }] });
    expect(readInstalledPlugin(fake.runner, GUARD_PLUGIN_ID)).toMatchObject({ enabled: false });
  });

  it("treats an absent `enabled` field as enabled", () => {
    const runner: ClaudeRunner = () => ({
      ...OK,
      stdout: JSON.stringify([{ id: GUARD_PLUGIN_ID, version: "0.1.0" }]),
    });
    expect(readInstalledPlugin(runner, GUARD_PLUGIN_ID)?.enabled).toBe(true);
  });

  it("is conservative when the list cannot be read — reads as not installed", () => {
    const runner: ClaudeRunner = () => ({ code: 1, stdout: "", stderr: "boom" });
    expect(readInstalledPlugin(runner, GUARD_PLUGIN_ID)).toBeUndefined();
  });
});

describe("we never pass -y, and the reason is a real one", () => {
  it("no emitted argv contains -y or --yes", () => {
    // A `directory`-source install off a TTY needs no confirmation. And `-y`
    // is not inert — it accepts a marketplace-DECLARED COMMAND without confirmation,
    // which is the one install class a human should be shown.
    const fake = fakeClaude();
    installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
    });
    uninstallGuardPlugin({ runner: fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID }] }).runner });
    for (const call of fake.calls) {
      expect(call).not.toContain("-y");
      expect(call).not.toContain("--yes");
    }
  });
});

describe("staleness refresh", () => {
  it("refreshes when the installed version differs from the bundled one", () => {
    // Claude Code runs its own cached copy, so editing the package on disk changes
    // nothing that runs. A version mismatch is the signal to update rather than skip.
    const fake = fakeClaude({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }],
      updateMovesTo: "0.1.0",
    });
    const r = installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
    });
    expect(r.status).toBe("refreshed");
    expect(fake.ran(`plugin update ${GUARD_PLUGIN_ID}`)).toBe(true);
  });

  it("does not refresh when the versions agree", () => {
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }] });
    expect(
      installGuardPlugin({
        runner: fake.runner,
        scaffoldDir: "/pkg/plugin",
        bundledVersion: "0.1.0",
        pathExists: () => true,
      }).status,
    ).toBe("already-installed");
    expect(fake.ran("plugin update")).toBe(false);
  });

  it("issues NO `marketplace update` — it is redundant AND it dangles", () => {
    // `plugin update` alone moved 0.1.0 → 0.2.0 against the real 2.1.263, because a
    // `directory` source is read in place (`installLocation === path`). The extra call
    // bought nothing and exits 1 (ENOENT) on precisely the vanished path this check
    // is about. Pinned so it cannot creep back in as "belt and braces".
    const fake = fakeClaude({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }],
      updateMovesTo: "0.1.0",
    });
    installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
    });
    expect(fake.ran(`plugin marketplace update ${GUARD_MARKETPLACE_NAME}`)).toBe(false);
  });

  it("reports refresh-failed — NOT refreshed — when `plugin update` exits non-zero", () => {
    const fake = fakeClaude({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }],
      failOn: (argv) =>
        argv[1] === "update"
          ? { code: 1, stdout: "", stderr: 'Plugin "agenttrail-guard" not found' }
          : undefined,
    });
    const r = installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
    });
    expect(r.status).toBe("refresh-failed");
    expect(r.refreshError).toContain("not found");
  });

  it("reports refresh-failed when the update exits 0 but the version does NOT move", () => {
    // The verdict is the POST-CONDITION, not the exit code: an update that exits 0
    // without moving the version must not be reported as "refreshed".
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }] });
    const r = installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
    });
    expect(fake.ran(`plugin update ${GUARD_PLUGIN_ID}`)).toBe(true);
    expect(r.status).toBe("refresh-failed");
  });

  it("a failed refresh does NOT throw — the older working version stays installed", () => {
    const fake = fakeClaude({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.0.9" }],
      failOn: (argv) =>
        argv[1] === "update" ? { code: 1, stdout: "", stderr: "boom" } : undefined,
    });
    expect(() =>
      installGuardPlugin({
        runner: fake.runner,
        scaffoldDir: "/pkg/plugin",
        bundledVersion: "0.1.0",
        pathExists: () => true,
      }),
    ).not.toThrow();
    // …and it never reached for the uninstall/reinstall hammer, which could have left
    // the user with nothing installed at all.
    expect(fake.ran("plugin uninstall")).toBe(false);
    expect(fake.ran("plugin install")).toBe(false);
  });
});

describe("`plugin list --json` reports a dangling marketplace in `errors`", () => {
  const DANGLE = `Marketplace ${GUARD_MARKETPLACE_NAME} failed to load: cache-miss`;

  it("surfaces the vendor's errors verbatim rather than matching its wording", () => {
    // `cache-miss` is a vendor-internal word. We never pattern-match it: ANY non-empty
    // array on our own row is a problem, and the vendor's own sentence is what a user
    // is shown. That survives the next release changing the message.
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID, errors: [DANGLE] }] });
    expect(readInstalledPlugin(fake.runner, GUARD_PLUGIN_ID)?.errors).toEqual([DANGLE]);
  });

  it("treats an ABSENT `errors` key as healthy, not as broken", () => {
    // The opposite default from `enabled`, and deliberately: the key only appears when
    // something is wrong, so "not stated" must read as fine. Reading it the other way
    // would put a scary, unactionable line on every healthy machine.
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    expect(readInstalledPlugin(fake.runner, GUARD_PLUGIN_ID)?.errors).toEqual([]);
  });

  it("ignores non-string entries rather than throwing on a shape we did not expect", () => {
    const fake = fakeClaude({
      plugins: [{ id: GUARD_PLUGIN_ID, errors: [DANGLE, 42, null] as unknown as string[] }],
    });
    expect(readInstalledPlugin(fake.runner, GUARD_PLUGIN_ID)?.errors).toEqual([DANGLE]);
  });

  it("carries them onto the InstallResult so `init` can warn if re-pointing did not clear them", () => {
    const fake = fakeClaude({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0", errors: [DANGLE] }],
      marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: "/pkg/plugin" }],
    });
    const r = installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
    });
    expect(r.marketplaceErrors).toEqual([DANGLE]);
  });
});

describe("readMarketplaceHealth — the corroborating channel", () => {
  it("is `ok` when the recorded path is still on disk", () => {
    const fake = fakeClaude({ marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: "/a" }] });
    expect(readMarketplaceHealth(fake.runner, () => true)).toEqual({ kind: "ok", path: "/a" });
  });

  it("is `dangling` when the recorded path has VANISHED", () => {
    // `marketplace list --json` still reports the stale path at exit 0 with
    // no error of its own, so nothing but this stat can see it on this channel.
    const fake = fakeClaude({ marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: "/gone" }] });
    expect(readMarketplaceHealth(fake.runner, () => false)).toEqual({
      kind: "dangling",
      path: "/gone",
    });
  });

  it("is `unregistered` when no row carries our name", () => {
    const fake = fakeClaude({ marketplaces: [{ name: "somebody-else", path: "/a" }] });
    expect(readMarketplaceHealth(fake.runner, () => true)).toEqual({ kind: "unregistered" });
  });

  it("is `unknown` on a non-zero exit — 'could not look' is not 'broken'", () => {
    const fake = fakeClaude({
      failOn: (argv) =>
        argv[2] === "list" && argv[1] === "marketplace"
          ? { code: 1, stdout: "", stderr: "nope" }
          : undefined,
    });
    expect(readMarketplaceHealth(fake.runner, () => true)).toEqual({ kind: "unknown" });
  });

  it("is `unknown` on unparseable JSON, and never throws", () => {
    const fake = fakeClaude({
      failOn: (argv) =>
        argv[2] === "list" && argv[1] === "marketplace"
          ? { code: 0, stdout: "not json", stderr: "" }
          : undefined,
    });
    expect(readMarketplaceHealth(fake.runner, () => true)).toEqual({ kind: "unknown" });
  });

  it("is `unknown` when our row has no readable path — we cannot stat what we cannot see", () => {
    const fake = fakeClaude({ marketplaces: [{ name: GUARD_MARKETPLACE_NAME }] });
    expect(readMarketplaceHealth(fake.runner, () => true)).toEqual({ kind: "unknown" });
  });
});

describe("the vanished source is RECOVERED, and named as such", () => {
  it("reports `recovered` (not `repointed`) when the recorded path was gone", () => {
    // The two are one `marketplace add`; they are separate because the sentence a user
    // reads differs. "Moved" is housekeeping; "the source you pointed at is gone" is
    // the failure, and saying it is how they learn the install had stopped being
    // updatable.
    const fake = fakeClaude({ marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: "/gone" }] });
    expect(ensureMarketplaceAt(fake.runner, "/pkg/plugin", () => false)).toBe("recovered");
    expect(fake.ran("plugin marketplace add /pkg/plugin --scope user")).toBe(true);
  });

  it("still reports `repointed` when the old path merely moved", () => {
    const fake = fakeClaude({ marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: "/old" }] });
    expect(ensureMarketplaceAt(fake.runner, "/new", () => true)).toBe("repointed");
  });

  it("says `added` — not `repointed` — when the listing was unreadable", () => {
    // Under `unknown` we did not see a previous pointer, so we must not claim we moved
    // one. What IS true either way is that it is now registered at our path.
    const fake = fakeClaude({
      failOn: (argv) =>
        argv[1] === "marketplace" && argv[2] === "list"
          ? { code: 1, stdout: "", stderr: "x" }
          : undefined,
    });
    expect(ensureMarketplaceAt(fake.runner, "/pkg/plugin", () => true)).toBe("added");
  });

  it("IDEMPOTENCE: a healthy re-run issues not one mutating argv", () => {
    // Structural, over the recorded argv — so a future edit that adds a mutation fails
    // here rather than being noticed by eye in review.
    const fake = fakeClaude({
      plugins: [{ id: GUARD_PLUGIN_ID, version: "0.1.0" }],
      marketplaces: [{ name: GUARD_MARKETPLACE_NAME, path: "/pkg/plugin" }],
    });
    const r = installGuardPlugin({
      runner: fake.runner,
      scaffoldDir: "/pkg/plugin",
      bundledVersion: "0.1.0",
      pathExists: () => true,
    });
    expect(r.status).toBe("already-installed");
    expect(r.marketplace).toBe("unchanged");
    for (const verb of ["add", "install", "update", "remove", "uninstall"]) {
      expect(fake.calls.some((c) => c.includes(verb))).toBe(false);
    }
  });
});

describe("coexistence detection", () => {
  it("finds the agenttrail plugin by EXACT id", () => {
    const fake = fakeClaude({ plugins: [{ id: AGENTTRAIL_PLUGIN_ID }] });
    expect(agenttrailPluginPresent(fake.runner)).toBe(true);
  });

  it("does not mistake our own plugin for the agenttrail one", () => {
    // A suffix test (`endsWith("agenttrail")`) would get this wrong, which is exactly
    // the coupling the separate identity exists to avoid.
    const fake = fakeClaude({ plugins: [{ id: GUARD_PLUGIN_ID }] });
    expect(agenttrailPluginPresent(fake.runner)).toBe(false);
  });
});

describe("version parsing", () => {
  it.each([
    ["2.1.263 (Claude Code)", [2, 1, 263]],
    ["2.1.211", [2, 1, 211]],
  ])("parses %s", (input, expected) => {
    expect(parseClaudeVersion(input as string)).toEqual(expected);
  });

  it("returns null for something with no version in it", () => {
    expect(parseClaudeVersion("no version here")).toBeNull();
  });
});
