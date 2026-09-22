/**
 * The plugin scaffold and the README promise.
 *
 * These are config files and prose, which is exactly why they need tests: the
 * `WebFetch` exclusion and the 10-second timeout are enforced by a JSON string a
 * user can edit and no compiler ever checks. If the matcher silently regains
 * `WebFetch`, the guard starts evaluating web fetches against rules that cannot
 * match them — and the README's coverage promise quietly becomes false.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(...parts: string[]): Record<string, never> {
  return JSON.parse(readFileSync(join(PKG_ROOT, ...parts), "utf8"));
}

const hooks = readJson("plugin", "hooks", "hooks.json") as unknown as {
  hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] };
};
const entry = hooks.hooks.PreToolUse[0] as NonNullable<(typeof hooks.hooks.PreToolUse)[0]>;

describe("the PreToolUse matcher", () => {
  it("is exactly the documented matcher", () => {
    expect(entry.matcher).toBe(
      "Bash|PowerShell|Edit|Write|Read|NotebookEdit|Grep|Glob|WebSearch|mcp__.*",
    );
  });

  it.each([
    "Bash",
    "PowerShell",
    "Edit",
    "Write",
    "Read",
    "NotebookEdit",
    "Grep",
    "Glob",
    "WebSearch",
  ])("intercepts %s", (tool) => {
    expect(new RegExp(entry.matcher).test(tool)).toBe(true);
  });

  it("intercepts any mcp__ tool", () => {
    expect(new RegExp(entry.matcher).test("mcp__chrome__navigate")).toBe(true);
  });

  it("still intercepts MultiEdit, because Edit substring-matches it", () => {
    expect(new RegExp(entry.matcher).test("MultiEdit")).toBe(true);
  });

  it("does NOT name WebFetch — v1 ships no website guardrails", () => {
    // The engine has no `url` matcher, so a WebFetch rule would match nothing,
    // forever, silently. Rather than ship a channel that only appears to work, the
    // tool is left out and the README says so.
    expect(entry.matcher).not.toContain("WebFetch");
  });

  it("names PowerShell — without it the guard is dead on Windows without Git Bash", () => {
    // "On Windows without Git Bash … Claude Code doesn't register the Bash tool at
    // all. A hook that matches only `Bash` never fires there." (`hooks.md:1612`)
    expect(entry.matcher).toContain("PowerShell");
  });
});

describe("the hook command entry", () => {
  it("sets a 10-second timeout, not the vendor's 600", () => {
    // 600 is Claude Code's default (`hooks.md:428`). Ours is 10 because an overrun
    // on PreToolUse lets the tool call continue (`hooks.md:3186`) — which IS the
    // fail-open posture, so no internal watchdog is needed.
    expect(entry.hooks[0]?.timeout).toBe(10);
  });

  it("invokes the built bundle from CLAUDE_PLUGIN_ROOT, naming the app with --agent claude", () => {
    // The `${...}` is Claude Code's own interpolation, expanded by the vendor at
    // hook-invocation time. It is the literal under test, not a stray JS template.
    // `--agent claude` tells the hook which app's configuration launched it.
    expect(entry.hooks[0]?.command).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: vendor placeholder, asserted verbatim
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/guard-hook.mjs" --agent claude',
    );
  });
});

describe("plugin identity must not collide with the agenttrail plugin", () => {
  const plugin = readJson("plugin", ".claude-plugin", "plugin.json") as unknown as {
    name: string;
  };

  it("is named agenttrail-guard", () => {
    expect(plugin.name).toBe("agenttrail-guard");
  });

  it("does NOT end in `@agenttrail`", () => {
    // A suffix match on `@agenttrail` must never select the guard, or uninstalling the
    // agenttrail plugin could remove the guard too.
    expect(plugin.name.endsWith("@agenttrail")).toBe(false);
  });

  it("the marketplace lists exactly this one plugin", () => {
    const market = readJson("plugin", ".claude-plugin", "marketplace.json") as unknown as {
      plugins: { name: string; source: string }[];
    };
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]?.name).toBe("agenttrail-guard");
  });
});

describe("package.json ships what the plugin needs", () => {
  const pkg = readJson("package.json") as unknown as {
    bin: Record<string, string>;
    files: string[];
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("exposes the agenttrail-guard bin", () => {
    expect(pkg.bin["agenttrail-guard"]).toBe("./dist/cli.js");
  });

  it("ships dist and plugin in the tarball", () => {
    // If `plugin` were dropped, the hook would point at a missing script, node would
    // exit non-zero, and Claude Code would fail open with nobody the wiser.
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("plugin");
  });

  it("declares NO runtime dependencies — the bundle is self-contained", () => {
    expect(pkg.dependencies).toEqual({});
  });

  it("depends on no @agenttrail package other than the published rules", () => {
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((name) => name.startsWith("@agenttrail/"))).toEqual([
      "@agenttrail/guardrails",
    ]);
  });
});

describe("the README states the coverage gap plainly", () => {
  const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");

  it("says the guard does not see what the agent fetches from the web", () => {
    // A security tool that overstates its coverage is worse than one that names the gap,
    // so the README's statement of this gap is pinned.
    expect(readme).toContain("does not see what the agent fetches from the web");
  });

  it("has a `what the guard does not do` section", () => {
    expect(readme).toContain("What the guard does not do");
  });

  it("documents the local events log rather than leaving it to be discovered", () => {
    expect(readme).toContain("events.jsonl");
  });

  it("states the three runtime invariants", () => {
    expect(readme).toContain("always exits 0");
    expect(readme).toContain("exactly one JSON object");
    expect(readme).toContain("fails open");
  });
});
