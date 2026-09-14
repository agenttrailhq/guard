import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Rewrites the dependency paths esbuild writes into a bundle — module comments and
 * `__commonJS` keys — from pnpm's store layout (`.pnpm/<name>@<version>/node_modules/<name>/…`,
 * prefixed with however many parent directories lead to `node_modules`) to
 * `node_modules/<name>/…`. Without this, the same source and lockfile build different bytes in a
 * standalone checkout and inside a larger workspace.
 */
function normalizeDependencyPaths(file: string): void {
  const text = readFileSync(file, "utf8");
  writeFileSync(
    file,
    text.replace(/(?:\.\.\/)*node_modules\/\.pnpm\/[^/"'\s]+\/node_modules\//g, "node_modules/"),
  );
}

/**
 * Two build products, deliberately separate.
 *
 * 1. `dist/cli.js` — the npm bin (`agenttrail-guard`). Carries every command.
 * 2. `plugin/scripts/guard-hook.mjs` — the file Claude Code actually executes on
 *    every tool call. SELF-CONTAINED (`noExternal`), and reached from its own
 *    entry (`src/hook-entry.ts`) rather than through the CLI, so the argument
 *    parser and the colour helper are structurally absent from the hot path.
 *
 * The hook bundle is a CHECKED-IN artifact because Claude Code needs a real file
 * to invoke.
 *
 * Tests cannot tell whether the committed bundle is stale:
 * `src/__tests__/built-artifact.test.ts` rebuilds in `beforeAll` and binds every
 * assertion to the freshly built bytes, which overwrites the committed file before
 * anything looks at it. Freshness is checked in CI instead, by building and diffing
 * the artifact.
 */
export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    outDir: "dist",
    dts: false,
    clean: true,
    sourcemap: false,
    target: "node20",
    platform: "node",
    // Preserve the `#!/usr/bin/env node` shebang from src/cli.ts.
    shims: false,
    noExternal: [/.*/],
    onSuccess: async () => normalizeDependencyPaths("dist/cli.js"),
  },
  {
    entry: { "guard-hook": "src/hook-entry.ts" },
    outDir: "plugin/scripts",
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    // Inline EVERYTHING (the engine, the guardrail catalog, picomatch) — the shipped
    // file must run with zero runtime node_modules. Node built-ins stay external.
    noExternal: [/.*/],
    dts: false,
    // Do NOT clean plugin/scripts — the dir is inside the shipped `plugin/`.
    clean: false,
    sourcemap: false,
    minify: false,
    target: "node20",
    platform: "node",
    shims: false,
    onSuccess: async () => normalizeDependencyPaths("plugin/scripts/guard-hook.mjs"),
  },
]);
