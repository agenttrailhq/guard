/**
 * What `scan` is doing, on stderr, while it runs: which phase, and how far through.
 *
 * Only fixed phase names and counts are written: never a path, a project or repo name, a
 * command or anything found. In a terminal it is one line rewritten in place, at most ten times
 * a second, and cleared when the scan is done; anywhere else it is one plain line per phase.
 * `--quiet` turns it off, and so does the plugin's scan, whose output an agent reads.
 *
 * Pure apart from the `write` it is given.
 */

/** Reports progress. */
export interface Progress {
  /** A phase started, or moved on: `label`, and `done` of `total` when there is a count. */
  phase(label: string, done?: number, total?: number): void;
  /** The scan is done: clear the line, then write `line` if there is one. */
  finish(line?: string): void;
}

/** Progress that says nothing. */
export const NO_PROGRESS: Progress = {
  phase: () => {},
  finish: () => {},
};

/** Least time between two rewrites of the line in a terminal. */
export const REDRAW_MS = 100;

/** How a progress line starts. */
const PREFIX = "agenttrail-guard: ";

/** Clears the terminal line and puts the cursor at its start. */
const CLEAR_LINE = "\r\u001b[K";

/** `n` with a thousands separator. */
function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** One progress line. */
export function progressLine(label: string, done?: number, total?: number): string {
  const tally =
    done === undefined || total === undefined ? "" : ` · ${count(done)} of ${count(total)}`;
  return `${PREFIX}${label}${tally}`;
}

/** Progress written with `write`, rewriting one line when `terminal`. */
export function createProgress(
  write: (text: string) => void,
  terminal: boolean,
  now: () => number = () => Date.now(),
): Progress {
  let shownLabel: string | undefined;
  let lastDrawn = Number.NEGATIVE_INFINITY;
  let drawn = false;
  return {
    phase(label, done, total) {
      if (!terminal) {
        // One line per phase: a count changing within a phase is not news worth a line.
        if (label !== shownLabel) write(`${progressLine(label)}\n`);
        shownLabel = label;
        return;
      }
      const t = now();
      if (label === shownLabel && t - lastDrawn < REDRAW_MS) return;
      shownLabel = label;
      lastDrawn = t;
      drawn = true;
      write(`${CLEAR_LINE}${progressLine(label, done, total)}`);
    },
    finish(line) {
      if (terminal && drawn) write(CLEAR_LINE);
      drawn = false;
      shownLabel = undefined;
      if (line !== undefined) write(`${PREFIX}${line}\n`);
    },
  };
}
