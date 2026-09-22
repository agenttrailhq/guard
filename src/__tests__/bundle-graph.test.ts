/**
 * Fences over the hook's import graph: what the file Claude Code runs before every tool
 * call may and may not pull in.
 *
 * Imports are read with the TypeScript parser rather than a regex, so an import statement
 * written inside a comment is never mistaken for a real one. The "ignores an import
 * written inside a comment" case below checks that.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const HOOK_ENTRY = join(PKG_ROOT, "src", "hook-entry.ts");

interface ParsedImport {
  readonly specifier: string;
  /** True when the declaration is fully erased at build time (contributes no bytes). */
  readonly typeOnly: boolean;
}

/** Parse a source's import DECLARATIONS. Prose in a comment can never become one. */
function parseImports(source: string): ParsedImport[] {
  const sourceFile = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, false);
  const found: ParsedImport[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    // No clause at all is a side-effect import (`import "x"`) — it runs, so it is a
    // value import. `import type {…}` is type-only outright. A default-free named
    // list is type-only only when EVERY specifier carries its own `type`.
    let typeOnly = false;
    if (clause !== undefined) {
      if (clause.isTypeOnly) {
        typeOnly = true;
      } else if (
        clause.name === undefined &&
        clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        typeOnly = clause.namedBindings.elements.every((e) => e.isTypeOnly);
      }
    }
    found.push({ specifier: statement.moduleSpecifier.text, typeOnly });
  }
  return found;
}

/**
 * Every module reachable from the hook entry by RELATIVE value import — exactly the set of
 * this package's own files that tsup inlines into the hook. Walking the graph rather
 * than globbing `src/` keeps the fence accurate as modules are added, and keeps it off
 * CLI-only files that never reach the hook bundle.
 */
function hookBundleGraph(entry: string = HOOK_ENTRY): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const { specifier, typeOnly } of parseImports(readFileSync(file, "utf8"))) {
      // A type-only import is erased at build time, so it adds nothing to the bundle.
      if (typeOnly || !specifier.startsWith(".")) continue;
      // Source is ESM-with-extension: `./config.js` is `config.ts` on disk.
      const candidate = join(dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (existsSync(candidate)) queue.push(candidate);
    }
  }
  return [...seen].sort();
}

/** The package imports the hook graph makes. Anything new here is new code in the hook bundle. */
const HOOK_PACKAGE_IMPORTS = ["@agenttrail/guardrails/guardrails", "picomatch"];

describe("the import reader", () => {
  it("reports a value import and a side-effect import", () => {
    const imports = parseImports(`
      import { a } from "@scope/one";
      import "@scope/two";
    `);
    expect(imports.filter((i) => !i.typeOnly).map((i) => i.specifier)).toEqual([
      "@scope/one",
      "@scope/two",
    ]);
  });

  it("marks an erased type-only import in both spellings", () => {
    const imports = parseImports(`
      import type { A } from "@scope/one";
      import { type B, type C } from "@scope/two";
    `);
    expect(imports).toHaveLength(2);
    expect(imports.every((i) => i.typeOnly)).toBe(true);
  });

  it("ignores an import written inside a comment", () => {
    const source = `
      // A note that mentions: import { x } from "@scope/one";
      /* and a block comment with import { y } from "@scope/two"; */
      const a = 1;
    `;
    expect(parseImports(source)).toHaveLength(0);
  });

  it("treats a mixed default and named import as a value import", () => {
    const imports = parseImports(`import d, { e } from "@scope/one";`);
    expect(imports.filter((i) => !i.typeOnly)).toHaveLength(1);
  });
});

describe("the hook's package imports", () => {
  it("finds a non-trivial graph", () => {
    const graph = hookBundleGraph();
    expect(graph.length).toBeGreaterThan(5);
    expect(graph).toContain(HOOK_ENTRY);
  });

  it("imports only the expected packages", () => {
    const packages = new Set(
      hookBundleGraph()
        .flatMap((f) => parseImports(readFileSync(f, "utf8")))
        .map((i) => i.specifier)
        .filter((s) => !s.startsWith(".") && !s.startsWith("node:")),
    );
    expect([...packages].sort()).toEqual(HOOK_PACKAGE_IMPORTS);
  });

  it("does not value-import the predicate schema, which carries zod", () => {
    const offenders = hookBundleGraph()
      .filter((f) =>
        parseImports(readFileSync(f, "utf8")).some(
          (i) => i.specifier.endsWith("/policy-predicate.js") && !i.typeOnly,
        ),
      )
      .map((f) => relative(PKG_ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe("the colour helper is unreachable from the hook", () => {
  it("no module in the hook graph imports a colour helper", () => {
    // A colour escape on stdout makes the output start with something other than `{`,
    // so Claude Code discards it as plain text and the tool call proceeds.
    const specifiers = hookBundleGraph().flatMap((f) =>
      parseImports(readFileSync(f, "utf8")).map((i) => i.specifier),
    );
    expect(specifiers.filter((s) => /color|chalk|picocolors|ansi/i.test(s))).toEqual([]);
  });

  /**
   * The modules allowed to reach stdout, by name. A suffix check would also exempt any later
   * module whose file name merely ends in `emit.ts` or `io.ts`.
   */
  const STDOUT_WRITERS = [
    join(PKG_ROOT, "src", "core", "emit.ts"),
    join(PKG_ROOT, "src", "core", "cursor-emit.ts"),
    join(PKG_ROOT, "src", "io.ts"),
  ];

  /** A write to stdout, or a console call, in source with block comments removed. */
  const STDOUT_WRITE = /process\s*\.\s*stdout|console\s*\.\s*(log|info|warn|error)/;

  it("no module in the hook graph writes to stdout except the named writers", () => {
    const writers = hookBundleGraph().filter((f) => {
      if (STDOUT_WRITERS.includes(f)) return false;
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return STDOUT_WRITE.test(code);
    });
    expect(writers).toEqual([]);
  });

  it("every named writer is in the hook graph, so the list cannot go stale", () => {
    const graph = hookBundleGraph();
    for (const writer of STDOUT_WRITERS) expect(graph).toContain(writer);
  });

  it("negative control — the detector DOES flag a stdout write and a console call", () => {
    expect(STDOUT_WRITE.test('process.stdout.write("{}")')).toBe(true);
    expect(STDOUT_WRITE.test('console.log("debug")')).toBe(true);
    expect(STDOUT_WRITE.test("stdout.write(text)")).toBe(false);
  });
});

describe("the per-app modules are in the hook graph", () => {
  // Named, so every fence in this file is known to cover them: a module that fell out of
  // the graph would pass every fence without being checked.
  it.each([
    "core/agent.ts",
    "core/cursor-mapper.ts",
    "core/cursor-emit.ts",
    "core/cursor-entry.ts",
    "core/codex-mapper.ts",
    "core/codex-emit.ts",
  ])("%s is inlined into the hook bundle", (module) => {
    expect(hookBundleGraph()).toContain(join(PKG_ROOT, "src", ...module.split("/")));
  });
});

describe("the hook can never gain the ability to spawn a process", () => {
  // `init`/`status`/`uninstall` shell out to `claude`. Their IO seam is `setup-io.ts`,
  // deliberately NOT `io.ts`, because `io.ts` IS in this graph — so a spawner added
  // there would be inlined into the file Claude Code executes before every tool call.
  it("no module in the hook graph imports node:child_process", () => {
    const offenders = hookBundleGraph().filter((f) =>
      parseImports(readFileSync(f, "utf8")).some(
        (i) => i.specifier === "node:child_process" || i.specifier === "child_process",
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("negative control — the detector DOES flag a child_process import", () => {
    // Without this, the assertion above passes just as happily against a graph walker
    // that silently returned nothing.
    const flagged = parseImports(`
      import { spawnSync } from "node:child_process";
    `).filter((i) => i.specifier === "node:child_process");
    expect(flagged).toHaveLength(1);
  });

  it("setup-io.ts really is the spawner, and really is outside the graph", () => {
    // Both halves matter: if setup-io stopped spawning, this fence would be guarding
    // nothing; if it entered the graph, the fence above would already be red.
    const setupIo = join(PKG_ROOT, "src", "setup-io.ts");
    expect(readFileSync(setupIo, "utf8")).toContain("node:child_process");
    expect(hookBundleGraph()).not.toContain(setupIo);
  });

  it("scan-io.ts is the second spawner, and it is outside the graph too", () => {
    // `scan` launches the desktop's file handler to open its report, which makes it the second
    // `node:child_process` importer outside `setup-io.ts`.
    const scanIo = join(PKG_ROOT, "src", "scan-io.ts");
    expect(readFileSync(scanIo, "utf8")).toContain("node:child_process");
    expect(hookBundleGraph()).not.toContain(scanIo);
  });

  it("the scan command is outside the hook graph, not just its IO seam", () => {
    // `commands/scan.ts` pulls the colour helper and the HTML generator, and neither
    // belongs in the file Claude Code executes before every tool call.
    const graph = hookBundleGraph();
    expect(graph).not.toContain(join(PKG_ROOT, "src", "commands", "scan.ts"));
    expect(graph).not.toContain(join(PKG_ROOT, "src", "core", "report.ts"));
    expect(graph).not.toContain(join(PKG_ROOT, "src", "core", "report-brand.ts"));
    expect(graph).not.toContain(join(PKG_ROOT, "src", "core", "color.ts"));
  });
});

describe("the scan-only plugin bundle carries scan and nothing else", () => {
  // `plugin/scripts/guard-scan.mjs` is built from `scan-entry.ts` and run by the plugin's
  // share-report skill. It needs the scanner and the report; it has no business with the
  // install commands, the process that drives Claude Code's own CLI, or crash reporting.
  const SCAN_ENTRY = join(PKG_ROOT, "src", "scan-entry.ts");
  const graph = hookBundleGraph(SCAN_ENTRY);

  it("finds the scan command and the report in it", () => {
    expect(graph).toContain(join(PKG_ROOT, "src", "commands", "scan.ts"));
    expect(graph).toContain(join(PKG_ROOT, "src", "core", "report.ts"));
    expect(graph).toContain(join(PKG_ROOT, "src", "core", "report-brand.ts"));
  });

  it.each([
    "setup-io.ts",
    "commands/init.ts",
    "commands/status.ts",
    "commands/uninstall.ts",
    "commands/crash-report.ts",
    "commands/hook.ts",
    "plugin/install.ts",
    "cursor/install.ts",
  ])("%s exists and is not inlined into it", (module) => {
    const file = join(PKG_ROOT, "src", ...module.split("/"));
    expect(existsSync(file)).toBe(true);
    expect(graph).not.toContain(file);
  });

  it("reaches nothing under src/net/", () => {
    expect(graph.filter((f) => f.includes(`${join(PKG_ROOT, "src", "net")}`))).toEqual([]);
  });
});

describe("the installers are outside the hook graph", () => {
  // `init` and `uninstall` write files, which the file Claude Code, Cursor and Codex run
  // before every tool call has no reason to do.
  it.each([
    "cursor/install.ts",
    "cursor/cursor-io.ts",
    "codex/install.ts",
    "codex/codex-io.ts",
    "commands/agent-choice.ts",
    "commands/init.ts",
    "commands/uninstall.ts",
    "commands/status.ts",
  ])("%s exists and is not inlined into the hook bundle", (module) => {
    const file = join(PKG_ROOT, "src", ...module.split("/"));
    expect(existsSync(file)).toBe(true);
    expect(hookBundleGraph()).not.toContain(file);
  });
});
