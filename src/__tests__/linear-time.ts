/**
 * Checks that a function's time grows linearly with its input, whatever the machine's load.
 *
 * An absolute time limit measures the machine as much as the code: under a full parallel test
 * run the same call can take twenty times as long. Here the function runs on an input of a
 * quarter of the size and on one of the full size, best of five each, alternated so a change in
 * load hits both. Linear work grows about 4x; quadratic work about 16x.
 */

/** Below this ratio, growth from a quarter of the size to the full size counts as linear. */
export const LINEAR_RATIO = 8;

/** A backstop on the full-size time, for a pattern so slow the ratio cannot be measured. */
export const BACKSTOP_MS = 10_000;

function time(fn: (input: string) => unknown, input: string): number {
  const start = performance.now();
  fn(input);
  return performance.now() - start;
}

/** How the time of `fn` grows from `make(size / 4)` to `make(size)`. */
export function growth(
  fn: (input: string) => unknown,
  make: (size: number) => string,
  size: number,
): { readonly ratio: number; readonly large: number } {
  const smallInput = make(Math.ceil(size / 4));
  const largeInput = make(size);
  time(fn, make(Math.ceil(size / 20)));
  let small = Number.POSITIVE_INFINITY;
  let large = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 5; run++) {
    small = Math.min(small, time(fn, smallInput));
    large = Math.min(large, time(fn, largeInput));
  }
  // A floor of 1ms, so a sub-millisecond small run cannot inflate the ratio.
  return { ratio: large / Math.max(small, 1), large };
}
