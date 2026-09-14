/**
 * `scrubPaths` — the frame allow-list.
 *
 * A stack trace scrubbed by the SECRET scrubber alone still reads
 * `/Users/priya/acme-secret-client/src/billing.ts`, which is the developer's name, the
 * client's name and the project's name. These cases assert that none of the three
 * survive.
 */

import { describe, expect, it } from "vitest";
import { EXTERNAL, scrubPaths } from "../core/redact-stack.js";

describe("a stack trace carrying three names — the reason this module exists", () => {
  const stack = [
    "Error: something went wrong",
    "    at capture (/Users/priya/acme-secret-client/src/billing.ts:41:9)",
    "    at run (/Users/priya/acme-secret-client/node_modules/.pnpm/x/index.js:2:1)",
  ].join("\n");

  it("keeps none of the developer, client or project names", () => {
    const out = scrubPaths(stack);
    expect(out).not.toContain("priya");
    expect(out).not.toContain("acme-secret-client");
    expect(out).not.toContain("billing");
    expect(out).not.toContain("/Users/");
  });

  it("reduces a foreign frame to <external> but keeps the function name", () => {
    expect(scrubPaths(stack)).toContain(`at capture (${EXTERNAL})`);
  });

  it("drops the `Error: <message>` header entirely", () => {
    // The header carries the message, and the message is exactly what must never be
    // sent — a JSON.parse SyntaxError quotes the command that broke it.
    expect(scrubPaths(stack)).not.toContain("something went wrong");
    expect(scrubPaths(stack)).not.toContain("Error:");
  });
});

describe("our own frames survive, reduced to a basename", () => {
  it("keeps guard-hook.mjs with its line and column", () => {
    const out = scrubPaths(
      "    at emit (/Users/x/.claude/plugins/guard/scripts/guard-hook.mjs:812:5)",
    );
    expect(out).toBe("    at emit (guard-hook.mjs:812:5)");
  });

  it("keeps cli.js the same way", () => {
    const out = scrubPaths(
      "    at runCli (/opt/homebrew/lib/node_modules/@agenttrail/guard/dist/cli.js:9:1)",
    );
    expect(out).toBe("    at runCli (cli.js:9:1)");
  });

  it("keeps node: internals — no user data can appear in the path", () => {
    expect(scrubPaths("    at readFileSync (node:fs:1234:5)")).toBe(
      "    at readFileSync (node:fs:1234:5)",
    );
  });

  it("handles a file:// URL form of our own bundle", () => {
    const out = scrubPaths("    at x (file:///Users/priya/p/guard-hook.mjs:1:2)");
    expect(out).toBe("    at x (guard-hook.mjs:1:2)");
  });
});

describe("the shapes a deny-list would have leaked", () => {
  it.each([
    [
      "a Windows path",
      "    at f (C:\\Users\\Priya\\acme-client\\src\\a.ts:1:2)",
      ["Priya", "acme-client"],
    ],
    [
      "a UNC share",
      "    at f (\\\\corp-fileserver\\team\\proj\\a.ts:1:2)",
      ["corp-fileserver", "proj"],
    ],
    [
      "a pnpm store with a private scope",
      "    at f (/x/.pnpm/@acme-private+lib/a.js:1:2)",
      ["acme-private"],
    ],
    ["a home path that is not /Users", "    at f (/home/priya/work/a.ts:1:2)", ["priya", "work"]],
  ])("%s leaks nothing", (_label, line, secrets) => {
    const out = scrubPaths(line);
    for (const s of secrets) expect(out).not.toContain(s);
    expect(out).toContain(EXTERNAL);
  });
});

describe("frame spellings and degenerate input", () => {
  it("handles a bare (anonymous) frame with no parens", () => {
    const out = scrubPaths("    at /Users/priya/secret/a.ts:1:2");
    expect(out).not.toContain("priya");
    expect(out).toContain(EXTERNAL);
  });

  it("returns empty for an empty stack rather than throwing", () => {
    expect(scrubPaths("")).toBe("");
  });

  it("drops non-frame lines such as `Caused by:` and blank padding", () => {
    const out = scrubPaths(
      ["Error: x", "Caused by: /Users/priya/a.ts", "", "    at f (node:fs:1:1)"].join("\n"),
    );
    expect(out).toBe("    at f (node:fs:1:1)");
  });

  it("a file merely NAMED like ours is still reduced to a basename we already ship", () => {
    // A deliberate accepted false-positive: the output is `cli.js`, which is a name
    // we publish anyway, so the leak is nil. Pinned so the behavior is a decision.
    expect(scrubPaths("    at f (/Users/priya/secret/cli.js:1:2)")).toBe("    at f (cli.js:1:2)");
  });
});

describe("degenerate frame shapes the regexes must not choke on", () => {
  it("a location with no :line:col still resolves a file", () => {
    // `fileOf`'s optional group. V8 omits the position for some native frames.
    expect(scrubPaths("    at f (node:internal/x)")).toBe("    at f (node:internal/x)");
    expect(scrubPaths("    at f (/Users/priya/a.ts)")).toBe(`    at f (${EXTERNAL})`);
  });

  it("an empty location is treated as foreign, not as ours", () => {
    // `basename("")` returns "", which must not accidentally match an own-artifact.
    expect(scrubPaths("    at f ()")).toBe(`    at f (${EXTERNAL})`);
  });

  it("`at <anonymous>` and native frames survive without a path", () => {
    expect(scrubPaths("    at JSON.parse (<anonymous>)")).toBe(`    at JSON.parse (${EXTERNAL})`);
  });

  it("a Windows own-artifact path is still recognised as ours", () => {
    // The `[/\\]` split, exercised on the separator that is not `/`.
    expect(scrubPaths("    at f (C:\\Users\\p\\dist\\cli.js:1:2)")).toBe("    at f (cli.js:1:2)");
  });
});
