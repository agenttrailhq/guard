/**
 * FIXTURE — this module must NOT be flagged.
 *
 * It talks about fetch( at length without calling it, which is exactly what the real
 * modules do: `crash-capture.ts` explains that it never reaches the network, and
 * `io.ts` explains why there is no postJson() on GuardIO. If comments were not
 * stripped before matching, those doc comments would fail their own fence.
 */
// Another line about fetch( in a line comment.
export const NOTE = "a module that only talks about the network";
