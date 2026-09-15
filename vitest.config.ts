import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "guard",
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    // Every test file runs with HOME pointed at a temporary directory; see the file.
    setupFiles: ["src/__tests__/setup-home.ts"],
    passWithNoTests: false,
    // The built-artifact suites shell out to tsup; give them room.
    testTimeout: 120_000,
    /**
     * Run this package's files ONE AT A TIME.
     *
     * TWO suites rebuild the shared, checked-in `plugin/scripts/guard-hook.mjs` (and
     * `dist/cli.js`) with tsup in `beforeAll` — `built-artifact.test.ts` and
     * `crash-runtime.test.ts` — while FIVE spawn `node` on the result. Run in parallel
     * workers, one suite can execute the bundle during the window another is truncating
     * and rewriting it. The symptom is a hook that emits nothing, surfacing as
     * "stdout parses as ONE object" or even "both artifacts are built" failing in an
     * unrelated file.
     *
     * Building once in a `globalSetup` would remove the window entirely; serializing
     * costs this package roughly a second and is sufficient.
     */
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**/*.ts",
        // A single top-level `await runHook(createRealIO())`. It cannot be imported
        // in-process without consuming the real stdin, so it is covered where it
        // actually matters — `built-artifact.test.ts` executes the built bundle in a
        // child process and asserts its stdout and exit code.
        "src/hook-entry.ts",
        // A single re-export binding crash reporting to the secret scrubber. Same
        // rationale as `hook-entry.ts`: there is no behavior to instrument in-process,
        // and it IS exercised where it matters — `crash-runtime.test.ts` drives a crash
        // through the built bundle and asserts a scrubbed record lands on disk.
        "src/core/crash-scrub.ts",
        // The secret scrubber's pattern set. Measured by its own behavioral suite,
        // `scrub.test.ts`, rather than counted toward this package's threshold.
        "src/core/scrub.ts",
        // The Claude Code transcript reader. Exercised end to end by `scan-cli.test.ts`
        // and `built-artifact.test.ts`, and not counted toward this package's threshold.
        "src/core/transcript/**",
        // The rule-matching engine. Exercised through the guard by `rules.test.ts`,
        // `evaluate.test.ts` and `windows-paths.test.ts`, and not counted toward this
        // package's threshold.
        "src/engine/**",
      ],
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
});
