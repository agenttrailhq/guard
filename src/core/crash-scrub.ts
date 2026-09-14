/**
 * The single binding between crash reporting and the secret scrubber.
 *
 * **This one line is the whole dependency on the secret scrubber.** Everything else
 * in the crash path takes the scrubber as a parameter (`ScrubSecrets` in
 * `crash-record.ts`), so it compiles and is fully tested without it. Isolating the
 * import here means a reviewer can see the entire coupling at once, and means there
 * is exactly one place a second scrubber could ever creep in.
 *
 * `core/scrub.ts` holds the standard secret patterns and nothing guard-specific.
 * Redaction only the guard needs, such as file paths in a stack trace, composes at
 * the call site instead — see `redact-stack.ts`.
 */

import type { ScrubSecrets } from "./crash-record.js";
import { scrubText } from "./scrub.js";

/** Secrets pass. Composed with `scrubPaths` in `buildCrashRecord`, in that order. */
export const scrubSecrets: ScrubSecrets = scrubText;
