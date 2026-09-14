/**
 * ANSI colour for the CLI-only commands. **Never importable from the hook path.**
 *
 * ── Never on the hook path, and why that is a fence rather than a convention ─
 * The hook writes exactly one JSON object to stdout. A colour escape makes that output
 * start with something other than `{`, so Claude Code discards it as plain text and
 * the tool call proceeds — enforcement silently off, with no error anywhere and the
 * plugin still listed as installed. `bundle-graph.test.ts` asserts that nothing
 * reachable from `hook-entry.ts` imports a module matching
 * `/color|chalk|picocolors|ansi/`, so this file cannot join that graph by accident.
 *
 * ── Inline escapes, no dependency ────────────────────────────────────────────
 * This package has an empty `dependencies` block and the shipped bundle inlines
 * everything. Taking `chalk` or `picocolors` for eight escape sequences would add a
 * supply-chain edge to a security tool in order to save twenty lines.
 *
 * ── When colour is OFF, and why each case ────────────────────────────────────
 * `NO_COLOR` (any non-empty value, per no-color.org), `TERM=dumb`, or a stdout that is
 * not a TTY — the last is what makes `agenttrail-guard scan | tee report.txt` produce
 * a clean file rather than one full of escape bytes. `FORCE_COLOR` overrides all three,
 * which is how CI logs keep their colour. Resolution is a pure function of the
 * environment so a test can drive every branch without touching `process`.
 */

/**
 * The escape sequences this module can emit. Reset is applied by every helper.
 *
 * Written with the `\u001B` escape rather than a literal ESC byte: a raw control
 * character in source is invisible in a diff, so a reviewer cannot tell a correct
 * sequence from a mangled one that would put stray bytes on a user's terminal.
 */
const CODES = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  blue: "\u001B[34m",
  cyan: "\u001B[36m",
} as const;

/** A style name. */
export type ColorName = Exclude<keyof typeof CODES, "reset">;

/** One styling function per name, plus the switch that produced it. */
export interface Colors {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  cyan(text: string): string;
}

/** The environment inputs colour resolution reads. Injected, never read from globals. */
export interface ColorEnvironment {
  /** `process.env`, or any subset of it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `process.stdout.isTTY === true`. */
  readonly isTTY: boolean;
}

/**
 * Should output carry colour?
 *
 * Order is deliberate: `FORCE_COLOR` first so a CI runner can opt in despite the pipe,
 * then `NO_COLOR`, then `TERM=dumb`, then the TTY check. An empty `NO_COLOR=""` does
 * NOT disable colour — the standard is explicit that presence with any non-empty value
 * is the signal, and treating the empty string as "on" would surprise anyone who
 * clears the variable by assigning an empty value to it.
 */
export function shouldUseColor({ env, isTTY }: ColorEnvironment): boolean {
  if ((env.FORCE_COLOR ?? "") !== "") return true;
  if ((env.NO_COLOR ?? "") !== "") return false;
  if (env.TERM === "dumb") return false;
  return isTTY;
}

/** Wrap `text` in one code, or return it untouched when colour is off. */
function style(enabled: boolean, name: ColorName, text: string): string {
  return enabled ? `${CODES[name]}${text}${CODES.reset}` : text;
}

/** Build the styling helpers for a given on/off decision. */
export function createColors(enabled: boolean): Colors {
  return {
    enabled,
    bold: (t) => style(enabled, "bold", t),
    dim: (t) => style(enabled, "dim", t),
    red: (t) => style(enabled, "red", t),
    green: (t) => style(enabled, "green", t),
    yellow: (t) => style(enabled, "yellow", t),
    blue: (t) => style(enabled, "blue", t),
    cyan: (t) => style(enabled, "cyan", t),
  };
}

/** Colour helpers that emit nothing. The safe default anywhere the switch is unknown. */
export const NO_COLORS: Colors = createColors(false);
