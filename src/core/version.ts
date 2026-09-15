/**
 * The guard's own version, in a module of its own.
 *
 * The crash record carries the version, and the hook path needs it — but
 * `hook-entry.ts` must never import `cli.ts`, because that would pull the argument
 * parser and the colour helper into the bundle Claude Code runs on every tool call.
 * A three-line module shares the constant without sharing the graph.
 *
 * `cli.ts` re-exports it, so `import { VERSION }` from `cli.ts` keeps working, and
 * `cli.test.ts` keeps it in step with package.json.
 */

/** Kept in step with package.json by `cli.test.ts`. */
export const VERSION = "0.1.0-rc.2";
