/**
 * Fences over the hook's import graph: what the file Claude Code runs before every tool
 * call may and may not pull in.
 *
 * Imports are read with the TypeScript parser rather than a regex, so an import statement
 * written inside a comment is never mistaken for a real one. The "ignores an import
 * written inside a comment" case below checks that.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("the AgentTrail OS line is unreachable from the hook", () => {
  // `init`, `status`, `scan` and `guardrails add` may print it. A hook answer never may: it
  // is read mid-task by the agent and the person at the keyboard.
  it("core/product-line.ts is not in the hook graph", () => {
    const graph = hookBundleGraph().map((f) => relative(PKG_ROOT, f));
    expect(graph).not.toContain(join("src", "core", "product-line.ts"));
  });

  it("negative control — the commands that print it do reach it", () => {
    for (const command of ["init.ts", "status.ts", "scan.ts", "rules.ts"]) {
      const graph = hookBundleGraph(join(PKG_ROOT, "src", "commands", command));
      expect(graph).toContain(join(PKG_ROOT, "src", "core", "product-line.ts"));
    }
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

  it("verify-io.ts is the third spawner, and it is outside the graph too", () => {
    // `scan --verify` runs read-only `git` and lists process names through it.
    const verifyIo = join(PKG_ROOT, "src", "verify-io.ts");
    expect(readFileSync(verifyIo, "utf8")).toContain("node:child_process");
    expect(hookBundleGraph()).not.toContain(verifyIo);
  });

  it("nothing under core/verify/ is in the hook graph", () => {
    const verifyDir = join(PKG_ROOT, "src", "core", "verify");
    expect(existsSync(verifyDir)).toBe(true);
    expect(hookBundleGraph().filter((f) => f.startsWith(verifyDir))).toEqual([]);
  });

  it("scrub-io.ts writes files, starts no process, and is outside the graph", () => {
    // `scan --scrub --apply` backs up and replaces transcripts through it, and nothing else.
    const scrubIo = join(PKG_ROOT, "src", "scrub-io.ts");
    const specifiers = parseImports(readFileSync(scrubIo, "utf8")).map((i) => i.specifier);
    expect(specifiers).toContain("node:fs");
    expect(specifiers).not.toContain("node:child_process");
    expect(hookBundleGraph()).not.toContain(scrubIo);
  });

  it.each([
    "scrub-io.ts",
    "commands/scan-scrub.ts",
    "core/scrub-transcripts.ts",
  ])("%s, part of scan --scrub, is not in the hook graph", (module) => {
    const file = join(PKG_ROOT, "src", ...module.split("/"));
    expect(existsSync(file)).toBe(true);
    expect(hookBundleGraph()).not.toContain(file);
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

  it("carries verification, so the fences over this graph cover it", () => {
    expect(graph).toContain(join(PKG_ROOT, "src", "verify-io.ts"));
    expect(graph).toContain(join(PKG_ROOT, "src", "core", "verify", "verify.ts"));
    expect(graph).toContain(join(PKG_ROOT, "src", "core", "verify", "secrets.ts"));
  });

  it("reaches nothing under src/net/", () => {
    expect(graph.filter((f) => f.includes(`${join(PKG_ROOT, "src", "net")}`))).toEqual([]);
  });
});

describe("only the scrub path can write a transcript", () => {
  const SRC = join(PKG_ROOT, "src");
  const SCRUB_IO = join(SRC, "scrub-io.ts");

  /** The `node:fs` functions that change the file system. */
  const FS_WRITERS = new Set([
    "appendFileSync",
    "chmodSync",
    "copyFileSync",
    "createWriteStream",
    "fchmodSync",
    "fsyncSync",
    "mkdirSync",
    "openSync",
    "renameSync",
    "rmSync",
    "rmdirSync",
    "unlinkSync",
    "writeFileSync",
    "writeSync",
  ]);

  /** The names a source value-imports from `node:fs` or `fs`, plus any `fs/promises` import. */
  function fsWriters(file: string): string[] {
    const sourceFile = ts.createSourceFile(
      "x.ts",
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
    );
    const found: string[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const from = statement.moduleSpecifier.text;
      if (/^(node:)?fs\/promises$/.test(from)) found.push(from);
      if (!/^(node:)?fs$/.test(from)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) {
        // A namespace or default import of `fs` can reach every writer.
        found.push(`${from} (whole module)`);
        continue;
      }
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && FS_WRITERS.has(name)) found.push(name);
      }
    }
    return found;
  }

  it("negative control: the detector finds a writer, a renamed writer and a namespace import", () => {
    const probe = join(mkdtempSync(join(tmpdir(), "agenttrail-fs-probe-")), "probe.ts");
    writeFileSync(
      probe,
      'import { readFileSync, renameSync as mv } from "node:fs";\nimport * as fs from "fs";\n',
    );
    expect(fsWriters(probe)).toEqual(["renameSync", "fs (whole module)"]);
  });

  it("the scan command does not import the scrub seam; only the two CLI entries do", () => {
    expect(hookBundleGraph(join(SRC, "commands", "scan.ts"))).not.toContain(SCRUB_IO);
    expect(hookBundleGraph(join(SRC, "commands", "scan-scrub.ts"))).not.toContain(SCRUB_IO);
    expect(hookBundleGraph(join(SRC, "scan-entry.ts"))).toContain(SCRUB_IO);
    expect(hookBundleGraph(join(SRC, "cli.ts"))).toContain(SCRUB_IO);
  });

  it("in the scan bundle, only scan-io.ts and scrub-io.ts can change a file", () => {
    // `scan-io.ts` writes the report; `scrub-io.ts` writes backups and replaces transcripts.
    // `verify-io.ts` imports `openSync` to read files, and is checked to open read-only below.
    // Everything else `scan` and `scan --scrub` run is read-only.
    const writers = hookBundleGraph(join(SRC, "scan-entry.ts"))
      .filter((f) => fsWriters(f).length > 0)
      .map((f) => relative(SRC, f));
    expect(writers.sort()).toEqual(["scan-io.ts", "scrub-io.ts", "verify-io.ts"]);
  });

  describe("verify-io.ts opens files read-only and writes nothing", () => {
    const VERIFY_IO = join(SRC, "verify-io.ts");

    /**
     * The only flag expressions an `openSync` call in `verify-io.ts` may pass, written out, with
     * whitespace removed before comparing. `constants.O_RDONLY`, optionally OR'ed with the
     * read-safe `O_NOFOLLOW` and `O_NONBLOCK`, each guarded for platforms that lack it. Nothing
     * computed, no variable and no string mode is accepted.
     */
    const ACCEPTED_OPEN_FLAGS = [
      "constants.O_RDONLY",
      "constants.O_RDONLY|(constants.O_NOFOLLOW??0)",
      "constants.O_RDONLY|(constants.O_NONBLOCK??0)",
      "constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)",
    ];

    /** What `verify-io.ts` may import from `node:fs`: reading, stat and descriptor handling. */
    const READ_ONLY_FS_IMPORTS = new Set([
      "accessSync",
      "closeSync",
      "constants",
      "fstatSync",
      "openSync",
      "readSync",
      "realpathSync",
      "statSync",
    ]);

    /** Names of functions that write, in `node:fs`, its callback form and `fs/promises`. */
    const WRITING_NAMES = [
      "writeFileSync",
      "writeFile",
      "appendFileSync",
      "appendFile",
      "createWriteStream",
      "writeSync",
      "write",
      "writev",
      "ftruncateSync",
      "ftruncate",
      "truncateSync",
      "truncate",
      "renameSync",
      "rename",
      "copyFileSync",
      "copyFile",
      "cpSync",
      "cp",
      "mkdirSync",
      "mkdir",
      "mkdtempSync",
      "mkdtemp",
      "rmSync",
      "rm",
      "rmdirSync",
      "rmdir",
      "unlinkSync",
      "unlink",
      "chmodSync",
      "chmod",
      "fchmodSync",
      "fchmod",
      "lchmod",
      "chownSync",
      "chown",
      "symlinkSync",
      "symlink",
      "linkSync",
      "link",
      "utimesSync",
      "utimes",
      "futimesSync",
      "futimes",
      "lutimes",
    ];

    /** Every reason `source` is not read-only, per the rules above. Empty when it is. */
    function readOnlyProblems(source: string): string[] {
      const file = ts.createSourceFile("verify-io.ts", source, ts.ScriptTarget.Latest, true);
      const problems: string[] = [];
      let openCalls = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const from = node.moduleSpecifier.text;
          if (/^(node:)?fs\/promises$/.test(from)) problems.push(`imports ${from}`);
          else if (/^(node:)?fs$/.test(from)) {
            const bindings = node.importClause?.namedBindings;
            if (node.importClause?.name !== undefined || bindings === undefined) {
              problems.push(`imports ${from} whole`);
            } else if (ts.isNamespaceImport(bindings)) {
              problems.push(`imports ${from} as a namespace`);
            } else {
              for (const element of bindings.elements) {
                const name = (element.propertyName ?? element.name).text;
                if (element.propertyName !== undefined) problems.push(`renames ${name}`);
                if (!READ_ONLY_FS_IMPORTS.has(name)) problems.push(`imports ${name}`);
              }
            }
          }
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : undefined;
          if (name !== undefined && WRITING_NAMES.includes(name)) problems.push(`calls ${name}`);
          if (ts.isIdentifier(callee) && callee.text === "require") problems.push("calls require");
          if (name === "openSync") {
            openCalls += 1;
            const [, flags, mode] = node.arguments;
            const text = flags === undefined ? "" : flags.getText(file).replace(/\s+/g, "");
            if (!ACCEPTED_OPEN_FLAGS.includes(text))
              problems.push(`opens with ${text || "no flags"}`);
            if (mode !== undefined || node.arguments.length !== 2) {
              problems.push("passes openSync other than a path and flags");
            }
          }
        } else if (
          ts.isIdentifier(node) &&
          node.text === "openSync" &&
          !ts.isImportSpecifier(node.parent) &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node)
        ) {
          problems.push("uses openSync other than by calling it");
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (openCalls === 0) problems.push("never calls openSync");
      return problems;
    }

    /** The real source with its one `openSync` call's flags replaced by `flags`. */
    function withOpenFlags(source: string, flags: string): string {
      const file = ts.createSourceFile("verify-io.ts", source, ts.ScriptTarget.Latest, true);
      let span: [number, number] | undefined;
      const find = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "openSync"
        ) {
          const arg = node.arguments[1] as ts.Expression;
          span = [arg.getStart(file), arg.getEnd()];
        }
        ts.forEachChild(node, find);
      };
      find(file);
      if (span === undefined) throw new Error("no openSync call");
      return source.slice(0, span[0]) + flags + source.slice(span[1]);
    }

    const real = readFileSync(VERIFY_IO, "utf8");

    it("the real file passes: read-only flags only, and no writing import or call", () => {
      expect(readOnlyProblems(real)).toEqual([]);
      // Its only import the bundle fence flags is openSync, which the rules above allow.
      expect(fsWriters(VERIFY_IO)).toEqual(["openSync"]);
    });

    it.each(ACCEPTED_OPEN_FLAGS)("accepts exactly %s, with any spacing", (flags) => {
      expect(readOnlyProblems(withOpenFlags(real, flags.replaceAll("|", " | ")))).toEqual([]);
    });

    it.each([
      "constants.O_WRONLY",
      "constants.O_RDWR",
      "constants.O_RDONLY | constants.O_CREAT",
      "constants.O_RDONLY | constants.O_APPEND",
      "constants.O_RDONLY | constants.O_TRUNC",
      "constants.O_RDONLY | constants.O_WRONLY",
      "constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_RDWR",
      "flags",
      "READ_FLAGS",
      "readFlags()",
      "constants.O_RDONLY | flags",
      "constants.O_RDONLY | (constants.O_NOFOLLOW ?? constants.O_WRONLY)",
      "0",
      '"r"',
      '"w"',
      '"r+"',
      '"a"',
    ])("negative control: fails on openSync flags %s", (flags) => {
      expect(readOnlyProblems(withOpenFlags(real, flags))).not.toEqual([]);
    });

    it("negative control: fails on a mode argument, or openSync used as a value", () => {
      const withMode = withOpenFlags(real, "constants.O_RDONLY, 0o600");
      expect(readOnlyProblems(withMode)).not.toEqual([]);
      expect(readOnlyProblems(`${real}\nexport const opener = openSync;\n`)).not.toEqual([]);
      const renamed = real.replace("  openSync,\n", "  openSync as open,\n");
      expect(renamed).not.toBe(real);
      expect(readOnlyProblems(renamed)).not.toEqual([]);
    });

    it.each(WRITING_NAMES)("negative control: fails when it imports or calls %s", (name) => {
      const imported = `import { ${name} } from "node:fs";\n${real}`;
      expect(readOnlyProblems(imported)).toContain(`imports ${name}`);
      const called = `${real}\nexport function probe(): void {\n  ${name}("x");\n}\n`;
      expect(readOnlyProblems(called)).toContain(`calls ${name}`);
      const viaPromises = `${real}\nexport async function probe(): Promise<void> {\n  await promises.${name}("x");\n}\n`;
      expect(readOnlyProblems(viaPromises)).toContain(`calls ${name}`);
    });

    it.each([
      'import { writeFile } from "node:fs/promises";',
      'import { readFile } from "fs/promises";',
      'import * as fs from "node:fs";',
      'import fs from "fs";',
      'import { promises } from "node:fs";',
    ])("negative control: fails on %s", (line) => {
      expect(readOnlyProblems(`${line}\n${real}`)).not.toEqual([]);
    });

    it("negative control: fails on require, and on a file that never opens", () => {
      expect(readOnlyProblems(`${real}\nconst fs = require("node:fs");\n`)).toContain(
        "calls require",
      );
      expect(readOnlyProblems('import { statSync } from "node:fs";\nstatSync("x");\n')).toEqual([
        "never calls openSync",
      ]);
    });
  });

  it("the scrub command's own modules change no file", () => {
    for (const module of ["commands/scan-scrub.ts", "core/scrub-transcripts.ts"]) {
      expect(fsWriters(join(SRC, ...module.split("/")))).toEqual([]);
    }
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
