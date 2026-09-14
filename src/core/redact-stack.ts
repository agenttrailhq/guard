/**
 * `scrubPaths` — the frame ALLOW-LIST.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 * The secret scrubber (`core/scrub.ts`) matches secrets and PII.
 * **None of its patterns match a filesystem path.** A stack trace run through it
 * alone still reads
 *
 *     at capture (/Users/priya/acme-secret-client/src/billing.ts:41:9)
 *
 * — the developer's name, the client's name and the project's name. So crash
 * reporting redacts paths in its own right, with a frame allow-list, rather than
 * relying on the scrubber.
 *
 * ── Why it is NOT a sixteenth pattern in `core/scrub.ts` ─────────────────────
 * That file holds the standard secret patterns and nothing guard-specific, so the
 * two compose at the call site instead:
 *
 *     scrubPaths(scrubText(text).text)
 *
 * The mechanisms are genuinely different, which is the deeper reason: `scrubText`
 * matches VALUE SHAPES (a key looks like a key); this matches STRUCTURE (a frame is
 * ours, or it is not). A path is not a secret shape.
 *
 * ── Allow-list, not deny-list ────────────────────────────────────────────────
 * Replacing `$HOME` with `~` and shipping is the obvious version and it leaks the
 * case nobody thought of: a Windows path, a UNC share, a repository path carrying the
 * employer's name, a pnpm store path carrying a private registry scope. Keeping only
 * frames we can positively identify as ours handles all four without enumerating
 * them, and a frame shape we have never seen defaults to redacted rather than sent.
 */

/** What a kept frame is reduced to when we cannot positively identify it. */
export const EXTERNAL = "<external>";

/**
 * Files that belong to the guard itself. The shipped artifacts are flat bundles, so
 * matching their base names is exact rather than a heuristic — `tsup.config.ts`
 * produces precisely these two names and `built-artifact.test.ts` pins them.
 */
const OWN_ARTIFACTS: readonly string[] = ["guard-hook.mjs", "cli.js"];

/** A `node:` internal frame. Safe to keep: no user data can appear in the path. */
const NODE_INTERNAL = /^node:/;

/**
 * A stack line's location, as V8 writes it. Both spellings occur:
 *   `    at fn (/path/to/file.ts:1:2)`   — named frame, location in parens
 *   `    at /path/to/file.ts:1:2`        — anonymous frame, bare location
 */
const FRAME_WITH_PARENS = /^(\s*at\s+.*?)\s*\((.*?)\)\s*$/;
const FRAME_BARE = /^(\s*at\s+)(.*?)\s*$/;

/** Strip a trailing `:line:col`, returning the file part alone. */
function fileOf(location: string): string {
  const m = /^(.*?)(:\d+:\d+)?$/.exec(location);
  return m?.[1] ?? location;
}

/** The last path segment, for either separator. Never throws. */
function basename(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] ?? file;
}

/**
 * Is this location one of ours, or a Node internal?
 *
 * Deliberately narrow. `file:///…/guard-hook.mjs`, `/abs/guard-hook.mjs` and a bare
 * `guard-hook.mjs` all qualify; anything else does not, including a file merely
 * *named* like ours inside someone's project — because we replace it with its
 * basename either way, so a false positive leaks a basename we already ship.
 */
function isOwn(file: string): boolean {
  if (NODE_INTERNAL.test(file)) return true;
  return OWN_ARTIFACTS.includes(basename(file));
}

/**
 * Redact every filesystem path in a stack trace.
 *
 * Kept frames are reduced to `basename:line:col` — enough to locate a bug in a
 * bundle we built, and nothing about where the user keeps their code. Every other
 * frame's location becomes `<external>`, with the function name retained because it
 * is our own call path when it matters and harmless when it is not.
 *
 * A line that is not a frame at all (the `Error: …` header, `Caused by:`, blank
 * padding) is dropped: the header carries the message, and the message is exactly
 * what must never be sent (an error message routinely quotes the thing that broke
 * it, and here that is the command the user just ran).
 */
export function scrubPaths(stack: string): string {
  const out: string[] = [];
  for (const line of stack.split("\n")) {
    const parens = FRAME_WITH_PARENS.exec(line);
    if (parens !== null) {
      const [, head, location] = parens;
      out.push(redactFrame(head ?? "", location ?? ""));
      continue;
    }
    const bare = FRAME_BARE.exec(line);
    if (bare !== null) {
      const [, head, location] = bare;
      out.push(redactFrame((head ?? "").trimEnd(), location ?? ""));
    }
    // Anything that is not a frame — including the `Error: <message>` header — is
    // dropped rather than redacted. See the doc comment.
  }
  return out.join("\n");
}

/** Reduce one frame to a safe form. */
function redactFrame(head: string, location: string): string {
  const file = fileOf(location);
  if (!isOwn(file)) return `${head.trimEnd()} (${EXTERNAL})`;
  // A `node:` specifier is kept WHOLE. Base-naming it would turn
  // `node:internal/process/task_queues` into `task_queues`, throwing away the only
  // useful part of the frame to redact something that cannot identify anyone — the
  // module graph of Node itself is the same on every machine.
  if (NODE_INTERNAL.test(file)) return `${head.trimEnd()} (${location})`;
  const suffix = location.slice(file.length); // `:line:col`, or ""
  return `${head.trimEnd()} (${basename(file)}${suffix})`;
}
