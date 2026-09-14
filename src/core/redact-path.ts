/**
 * `redactPaths` — filesystem paths out of anything `scan` displays or writes.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The secret scrubber (`core/scrub.ts`) matches secrets and PII.
 * **None of its fourteen patterns match a filesystem path.** `cat
 * /Users/priya/acme-secret-client/.env`, `rm -rf /Users/priya/clients/beta`, `op read
 * op://vault/item/field` and `C:\Users\priya\acme\.env` all come back from `scrubText`
 * unchanged, with `total: 0`. So a scan finding run through the scrubber alone still
 * carries the developer's name, their employer's or client's name, and their project's
 * name — in a report meant to be shareable.
 *
 * ── Why it is not a fifteenth pattern in `core/scrub.ts` ─────────────────────
 * That file holds the standard secret patterns and nothing guard-specific. The two
 * COMPOSE at the call site instead:
 *
 *     redactPaths(scrubText(text).text)
 *
 * The mechanisms differ, which is the deeper reason: `scrubText` matches VALUE SHAPES
 * (a key looks like a key); this matches STRUCTURE (a token is a path, or it is not).
 *
 * ── Why not `core/redact-stack.ts`, which already redacts paths ──────────────
 * `scrubPaths` returns the **empty string** for every command-shaped input. It keeps
 * only lines matching a V8 stack-frame regex and drops the rest — correct for a stack
 * trace, total data loss for a command. Its allow-list POSTURE is reused here; its
 * code cannot be.
 *
 * ── Allow-list, not deny-list ────────────────────────────────────────────────
 * Substituting `$HOME` for `~` and shipping is the obvious version, and it leaks every
 * case nobody thought of: a Windows path, a UNC share, a repository path carrying an
 * employer's name, a pnpm store path carrying a private registry scope. So a token
 * that is structurally a path is replaced WHOLE, and nothing inside it is kept. A
 * shape we have never seen defaults to redacted rather than shared.
 *
 * ── This is also the intended presentation ───────────────────────────────────
 * The report renders `git checkout -- <path>` and `op read <path>` — path elided,
 * command shape intact — and that is what makes the repeat counting work. Fourteen
 * `git checkout -- <path>` calls are one recurring mistake seen fourteen times;
 * fourteen distinct absolute paths are fourteen singletons and no finding at all.
 *
 * ── It must not damage a redaction placeholder ───────────────────────────────
 * `scrubText` runs FIRST, so its output is already in the string — including
 * `[REDACTED:secret:basic-auth]`, one of whose placeholders legitimately contains
 * `://`. `[` and `]` are therefore excluded from the path character class, so no token
 * run can begin inside a placeholder or swallow one. This is done by the character
 * class rather than by a second sentinel pass, deliberately: `scrubText` uses a U+E000
 * sentinel internally and reintroducing one here is the hazard its own comment warns
 * about.
 *
 * ── A quoted region is collapsed WHOLE ───────────────────────────────────────
 * A path containing a space is several whitespace-separated runs, and only the first
 * one carries a separator. Without quote-awareness, `rm -rf "/Users/priya/Acme
 * Holdings"` would redact to `rm -rf "<path> Holdings"`, leaving the client's name.
 * Spaces in directory names are ordinary on macOS and Windows, so this is a common
 * shape, not a corner.
 *
 * Quoting is the only thing that makes a spaced path one argument, so quote-awareness
 * is the only correct fix: a quoted region containing any path-shaped run is replaced
 * entirely. The cost is that `git commit -m "fix /Users/x"` loses its message. That is
 * the right direction — a message that quotes a path is exactly the kind of free text
 * this report must not carry.
 */

import { REDACTION_PREFIX } from "./redaction.js";

/** What a path-shaped token is replaced with. */
export const PATH_PLACEHOLDER = "<path>";

/**
 * A maximal run of characters that could belong to one path token.
 *
 * Excluded, and each for a reason:
 *   - whitespace — the token boundary itself;
 *   - `'` `"` — quoting, so a quoted path is still one run;
 *   - `[` `]` — so a `[REDACTED:…]` placeholder is never entered or consumed;
 *   - `<` `>` — shell redirection, AND this module's own placeholder, which makes
 *     `redactPaths` idempotent rather than re-eating its own output;
 *   - `|` `&` `;` `(` `)` — shell operators; a path never spans one;
 *   - `$` — so `rm -rf $DIR` keeps its variable visible, which is exactly the
 *     coverage limit the rule descriptions state;
 *   - `=` — so `--file=/etc/passwd` redacts the path and keeps the flag.
 *
 * `:` and `\` are deliberately INCLUDED: `C:\Users\…`, `\\server\share` and
 * `op://vault/item` are all paths and all have to be caught by one rule.
 */
const TOKEN_RUN = /[^\s'"[\]<>|&;()$=]+/g;

/** A bare Windows drive with nothing after it — `C:` — which is still a location. */
const BARE_DRIVE = /^[A-Za-z]:$/;

/**
 * Is this token a path?
 *
 * Structural, and it errs toward yes. Any separator at all makes it one, which sweeps
 * up absolute POSIX paths, relative paths, Windows paths, UNC shares, `~`-rooted
 * paths, `file://` and `op://` URLs, and http(s) URLs — the last of which are not
 * filesystem paths but are every bit as identifying (`https://internal.acme.corp/…`)
 * and are redacted for the same reason.
 *
 * The cost is over-redaction: `grep -E 'foo/bar'` loses its pattern, and `rm -rf /`
 * becomes indistinguishable from `rm -rf ./build`. Both are accepted. The rule id and
 * title sit beside the command in every surface that renders one, so the distinction
 * that matters is not carried by the command text alone — and for a report designed to
 * be posted in public, under-inclusion is safe and over-inclusion is a leak.
 */
function isPathShaped(token: string): boolean {
  if (token === "." || token === ".." || token === "~") return true;
  if (token.includes("/") || token.includes("\\")) return true;
  return BARE_DRIVE.test(token);
}

/**
 * A single- or double-quoted region, non-greedy by construction.
 *
 * Alternation order is irrelevant — each branch requires its own closing quote — and
 * an UNTERMINATED quote matches nothing and falls through to the token pass, which is
 * the safe direction: it is still redacted, just token by token.
 */
const QUOTED_REGION = /'[^']*'|"[^"]*"/g;

/** Does any run inside this text look like a path? */
function containsPath(text: string): boolean {
  // `TOKEN_RUN` is global and stateful; `match` resets `lastIndex` on entry the way
  // `replace` does, so the shared regex stays safe to reuse across calls.
  return (text.match(TOKEN_RUN) ?? []).some(isPathShaped);
}

/**
 * Replace every path-shaped token in `text` with {@link PATH_PLACEHOLDER}.
 *
 * Pure, total, and idempotent. Compose it AFTER the secret scrubber, never before:
 * running it first would replace a path that a secret pattern was about to match
 * inside, and the scrubber's tally would then under-report.
 */
export function redactPaths(text: string): string {
  if (text.length === 0) return text;

  // Pass 1 — quoted regions, whole. Skipped when the region already carries a
  // redaction placeholder: collapsing it would delete the one marker telling a reader
  // a secret was removed, and pass 2 still redacts every path run inside it.
  const collapsed = text.replace(QUOTED_REGION, (region) => {
    if (region.includes(REDACTION_PREFIX)) return region;
    const quote = region[0] ?? '"';
    const inner = region.slice(1, -1);
    return containsPath(inner) ? `${quote}${PATH_PLACEHOLDER}${quote}` : region;
  });

  // Pass 2 — everything else, token by token. The placeholder inserted above survives
  // it: `<` and `>` are outside `TOKEN_RUN`, so `<path>` reduces to the run `path`,
  // which carries no separator and is kept. That is what makes this idempotent.
  return collapsed.replace(TOKEN_RUN, (run) => (isPathShaped(run) ? PATH_PLACEHOLDER : run));
}
