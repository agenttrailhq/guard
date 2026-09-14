/**
 * The guard actually loads the real 56-rule corpus.
 *
 * `hook.ts`, `status.ts`, `init.ts` and `rules.ts` all read
 * `deps.catalog ?? SHIPPED_CATALOG`, and every other test in this package passes
 * a catalog IN. So without this file, deleting the `@agenttrail/guardrails`
 * import and defaulting to `[]` would leave the whole suite green and ship a
 * guard that enforces nothing — silently, which is the failure mode this product
 * cannot have.
 *
 * The count is hardcoded on purpose. A silent drop back to a placeholder is
 * exactly what this exists to catch, and the cost is that adding a rule edits one
 * number in two places (here and `guardrails/__tests__/corpus.test.ts`). That is
 * deliberate, not an oversight.
 */

import { RULES } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { runHook } from "../commands/hook.js";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardIO } from "../io.js";

/** A minimal IO double: no config on disk, no user rules, stdout captured. */
function harness(stdin: string): { io: GuardIO; written: string[] } {
  const written: string[] = [];
  return {
    written,
    io: {
      readStdin: async () => stdin,
      writeStdout: (t) => {
        written.push(t);
      },
      readFile: () => undefined,
      homedir: () => "/home/test",
      mkdirp: () => true,
      writeFileAtomic: () => true,
      listDir: () => [],
      deleteFile: () => true,
      // Added for the decision log. Inert here: nothing on this path
      // records unless a recorder is wired in, but they are stubbed rather than
      // omitted so a future caller cannot silently no-op against a partial double.
      appendFile: () => true,
      fileSize: () => 0,
    },
  };
}

function decisionOf(written: string[]): string {
  expect(written).toHaveLength(1);
  return JSON.parse(written[0] as string).hookSpecificOutput.permissionDecision;
}

async function decide(command: string): Promise<string> {
  // No `deps.catalog` — this is the whole point. Production passes nothing.
  const h = harness(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
  await runHook(h.io);
  return decisionOf(h.written);
}

describe("the shipped catalog is the real one", () => {
  it("is `@agenttrail/guardrails`, not a placeholder", () => {
    expect(SHIPPED_CATALOG).toBe(RULES);
  });

  it("holds 56 guardrails", () => {
    expect(SHIPPED_CATALOG.length).toBe(56);
  });

  it("compiles all 56 — a guardrail that will not compile is SKIPPED, so a drop is silent", () => {
    // `compileCatalog` swallows a bad predicate per-rule by design ("one bad rule
    // must not disable the other 55"), which means a corpus-wide breakage shows up
    // as a smaller catalog rather than as an error. This is where that is noticed.
    expect(compileCatalog(SHIPPED_CATALOG)).toHaveLength(56);
  });

  it("resolves the pack's lead guardrail by id", () => {
    expect(SHIPPED_CATALOG.find((rule) => rule.id === "wt.reset-hard")).toBeDefined();
  });

  it("carries every pack, so no pack ships empty behind an enabled config", () => {
    const packs = new Set(SHIPPED_CATALOG.map((rule) => rule.category));
    expect([...packs].sort()).toEqual([
      "destructive-data",
      "file-scope",
      "privilege-supply-chain",
      "prod-infra",
      "rce-supply-chain",
      "safety-bypass",
      "secret-exposure",
      "working-tree",
    ]);
  });
});

describe("the hook enforces it with no catalog injected", () => {
  it("denies `rm -rf /`", async () => {
    expect(await decide("rm -rf /")).toBe("deny");
  });

  it("denies `git reset --hard` — a guardrail the four-rule seed also had", async () => {
    expect(await decide("git reset --hard")).toBe("deny");
  });

  it("denies `git push --force` — a guardrail ONLY the real corpus has", async () => {
    // The sharpest assertion in this file: `block-force-push` does not exist in
    // any placeholder, so this can only pass if the real package is wired in.
    expect(await decide("git push origin main --force")).toBe("deny");
  });

  it("asks on `helm uninstall api` — another guardrail only the real corpus has", async () => {
    expect(await decide("helm uninstall api")).toBe("ask");
  });

  it("allows `rm -rf ./node_modules`", async () => {
    // The negative control. Without it every assertion above would pass for a
    // catalog that denied everything — the fail-DANGEROUS shape this package has
    // shipped once before and must not repeat.
    expect(await decide("rm -rf ./node_modules")).toBe("allow");
  });

  it("allows `pnpm test`, `git status` and `ls -la`", async () => {
    for (const command of ["pnpm test", "git status", "ls -la", "pnpm install"]) {
      expect(await decide(command), command).toBe("allow");
    }
  });
});
