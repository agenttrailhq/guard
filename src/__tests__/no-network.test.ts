/**
 * "No network from `hook` or `scan`."
 *
 * ── Read this before changing anything here ─────────────────────────────────
 * Opt-in crash reporting puts one `fetch` in the shipped CLI bundle, so "grep the built
 * bundle for `fetch`" cannot be the whole test. The guarantee is a REACHABILITY claim
 * instead. That is a weaker statement, which is why this file is written the way it is.
 *
 * **A runtime trial is evidence about one execution; the fence is a statement about
 * all of them.** The guarantee here does not rest on having watched a crash fail to
 * phone home — it rests on `src/net/**` being absent from the import graph of
 * `hook-entry.ts` and of every command except `crash-report.ts`, checked over every
 * reachable module by a parser. `crash-runtime.test.ts` corroborates that at runtime
 * on the real bytes; it does not replace it. **Do not delete the static fence because
 * "we test it at runtime now"** — the runtime test could pass on a build where the
 * sender is one un-taken branch away from the hook path, and this one could not.
 *
 * ── Why a parser and not a regex ─────────────────────────────────────────────
 * Prose in a COMMENT containing the words of an import statement must not be read as
 * a real import. `bundle-graph.test.ts` owns the parser and proves it ignores
 * comments; this file reuses it. That file covers the colour-helper and bare-barrel
 * fences; this one covers the network.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const SRC = join(PKG_ROOT, "src");
const HOOK_ENTRY = join(SRC, "hook-entry.ts");
/** The entry of `plugin/scripts/guard-scan.mjs`, which the plugin's skill runs. */
const SCAN_ENTRY = join(SRC, "scan-entry.ts");
const COMMANDS = join(SRC, "commands");
const PLUGIN_SCRIPTS = join(PKG_ROOT, "plugin", "scripts");

/** The one file allowed to contain a network call. */
const TRANSPORT = join(SRC, "net", "crash-transport.ts");
/** The one command allowed to reach it. */
const SENDER_COMMAND = "crash-report.ts";

/** Parse import DECLARATIONS. Prose in a comment can never become one. */
function importsOf(source: string): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    // Type-only imports are erased at build time and cannot carry a call, but they
    // are still counted here: a module that needs the transport's TYPES has no
    // business on the hook path either, and allowing them invites a later refactor
    // to widen one into a value import unnoticed.
    out.push(st.moduleSpecifier.text);
  }
  return out;
}

/** Every module reachable from `entry` by relative import — the tsup inline set. */
function graphFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const candidate = join(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(candidate)) queue.push(candidate);
    }
  }
  return [...seen];
}

/** Every `.ts` under `src/`, excluding tests. */
function allSources(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue;
      out.push(...allSources(p));
    } else if (e.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Source with block and line comments removed, so prose cannot register a hit. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const NETWORK = /\bfetch\s*\(|node:https?|node:net|XMLHttpRequest|new\s+WebSocket/;

describe("the fence bites — proven on a fixture, not assumed", () => {
  // A fence that has never fired is not a fence. These fixtures prove it bites, on
  // every run rather than once by hand.
  const FIXTURES = join(HERE, "fixtures", "no-network");

  it("flags a module that calls fetch", () => {
    expect(NETWORK.test(code(join(FIXTURES, "calls-fetch.ts")))).toBe(true);
  });

  it("flags node:https, node:net and WebSocket too, not just fetch", () => {
    const src = code(join(FIXTURES, "other-transports.ts"));
    expect(NETWORK.test(src)).toBe(true);
    for (const probe of ['import x from "node:https"', "new WebSocket(u)", 'require("node:net")']) {
      expect(NETWORK.test(probe)).toBe(true);
    }
  });

  it("does NOT flag the word fetch written in a comment", () => {
    // The whole reason comments are stripped before matching. Without this, the
    // doc comment in `crash-capture.ts` explaining that it never fetches would
    // itself fail the fence.
    expect(NETWORK.test(code(join(FIXTURES, "mentions-fetch-in-prose.ts")))).toBe(false);
  });

  it("reaches a transitively-imported offender, not just a direct one", () => {
    // The graph walk is the part that could silently degrade to "check one file".
    const graph = graphFrom(join(FIXTURES, "entry-imports-offender.ts"));
    expect(graph.some((f) => NETWORK.test(code(f)))).toBe(true);
    expect(graph.length).toBeGreaterThan(1);
  });
});

describe("no network — exactly one network call, in one known file", () => {
  it("only `net/crash-transport.ts` references the network", () => {
    const offenders = allSources()
      .filter((f) => NETWORK.test(code(f)))
      .map((f) => f.replace(`${SRC}/`, ""));
    expect(offenders).toEqual(["net/crash-transport.ts"]);
  });

  it("that file exists — an empty allow-list would make the test above vacuous", () => {
    expect(existsSync(TRANSPORT)).toBe(true);
    expect(NETWORK.test(code(TRANSPORT))).toBe(true);
  });
});

describe("no network — the sender is unreachable from `hook`", () => {
  it("finds a non-trivial hook graph (a fence over nothing proves nothing)", () => {
    const graph = graphFrom(HOOK_ENTRY);
    expect(graph.length).toBeGreaterThan(5);
    expect(graph).toContain(HOOK_ENTRY);
  });

  it("no module reachable from the hook entry imports src/net/**", () => {
    const offenders = graphFrom(HOOK_ENTRY).filter((f) => f.startsWith(join(SRC, "net")));
    expect(offenders).toEqual([]);
  });

  it("no module reachable from the hook entry references the network at all", () => {
    const offenders = graphFrom(HOOK_ENTRY)
      .filter((f) => NETWORK.test(code(f)))
      .map((f) => f.replace(`${SRC}/`, ""));
    expect(offenders).toEqual([]);
  });

  it.each([
    "core/agent.ts",
    "core/cursor-mapper.ts",
    "core/cursor-emit.ts",
    "core/cursor-entry.ts",
  ])("the Cursor module %s is in the hook graph, so the two fences above cover it", (module) => {
    const file = join(SRC, ...module.split("/"));
    expect(graphFrom(HOOK_ENTRY)).toContain(file);
    expect(NETWORK.test(code(file))).toBe(false);
  });
});

describe("no network — the sender is unreachable from the scan-only plugin bundle", () => {
  // `commands/` is fenced by glob below, but this entry lives outside it, so it is named.
  it("finds a non-trivial scan graph that really is the scan command", () => {
    const graph = graphFrom(SCAN_ENTRY);
    expect(graph.length).toBeGreaterThan(8);
    expect(graph).toContain(join(COMMANDS, "scan.ts"));
  });

  it("no module reachable from the scan entry imports src/net/**", () => {
    const offenders = graphFrom(SCAN_ENTRY).filter((f) => f.startsWith(join(SRC, "net")));
    expect(offenders).toEqual([]);
  });

  it("no module reachable from the scan entry references the network at all", () => {
    const offenders = graphFrom(SCAN_ENTRY)
      .filter((f) => NETWORK.test(code(f)))
      .map((f) => f.replace(`${SRC}/`, ""));
    expect(offenders).toEqual([]);
  });
});

describe("no network — and unreachable from every command except the sender", () => {
  // Globbing `commands/` rather than naming files means a new command is fenced the
  // day it is created, with no edit here, including a command that does not exist yet.
  const commandFiles = readdirSync(COMMANDS).filter((f) => f.endsWith(".ts"));

  it("the command list is non-empty and contains hook.ts", () => {
    // Without this, a glob that silently returned nothing would make every
    // assertion below pass over an empty set.
    expect(commandFiles.length).toBeGreaterThan(0);
    expect(commandFiles).toContain("hook.ts");
  });

  it.each(
    commandFiles.filter((f) => f !== SENDER_COMMAND),
  )("commands/%s cannot reach src/net/**", (file) => {
    const offenders = graphFrom(join(COMMANDS, file)).filter((f) => f.startsWith(join(SRC, "net")));
    expect(offenders).toEqual([]);
  });

  it("the sender command CAN reach it — the positive control for the guardrail above", () => {
    const graph = graphFrom(join(COMMANDS, SENDER_COMMAND));
    expect(graph).toContain(TRANSPORT);
  });
});

describe("no network — crash reporting is off by default", () => {
  it("DEFAULT_CONFIG.crashReports is false", async () => {
    const { DEFAULT_CONFIG } = await import("../core/config.js");
    expect(DEFAULT_CONFIG.crashReports).toBe(false);
  });

  it("a missing or malformed config yields false, not true", async () => {
    const { parseConfig } = await import("../core/config.js");
    expect(parseConfig(undefined).crashReports).toBe(false);
    expect(parseConfig("").crashReports).toBe(false);
    expect(parseConfig("{}").crashReports).toBe(false);
    expect(parseConfig('{"crashReports":"true"}').crashReports).toBe(false);
    expect(parseConfig('{"crashReports":1}').crashReports).toBe(false);
  });

  it("ships with no endpoint, so a send has nowhere to go even when enabled", async () => {
    const { DEFAULT_CONFIG } = await import("../core/config.js");
    expect(DEFAULT_CONFIG.crashEndpoint).toBeUndefined();
  });
});

describe("the secret scrubber holds no guard-specific redaction", () => {
  // Path redaction composes at the call site (`scrubPaths(scrubText(text).text)`)
  // rather than living in `core/scrub.ts` as another pattern.
  it("crash reporting's path redaction lives in redact-stack.ts, not scrub.ts", () => {
    expect(existsSync(join(SRC, "core", "redact-stack.ts"))).toBe(true);
    const scrub = join(SRC, "core", "scrub.ts");
    if (!existsSync(scrub)) return;
    // No path-shaped pattern may appear in the scrubber.
    expect(code(scrub)).not.toMatch(/scrubPaths|<external>|guard-hook\.mjs/);
  });
});

describe("the built artifacts still say what we claim", () => {
  it("the plugin ships exactly the two bundles fenced here", () => {
    // A third `.mjs` in `plugin/scripts/` would ship to every user with no grep over it.
    if (!existsSync(PLUGIN_SCRIPTS)) return;
    expect(
      readdirSync(PLUGIN_SCRIPTS)
        .filter((f) => f.endsWith(".mjs"))
        .sort(),
    ).toEqual(["guard-hook.mjs", "guard-scan.mjs"]);
  });

  it.each([
    "guard-hook.mjs",
    "guard-scan.mjs",
  ])("the plugin bundle %s contains no fetch call — the old grep, KEPT", (name) => {
    // The bundle grep cannot cover `dist/cli.js`, because crash reporting puts a fetch in
    // it. It holds for both plugin bundles: each is a separate tsup entry and the sender
    // is not in either graph, so this assertion stays for those artifacts.
    const bundle = join(PLUGIN_SCRIPTS, name);
    if (!existsSync(bundle)) return;
    expect(readFileSync(bundle, "utf8")).not.toMatch(/\bfetch\s*\(/);
  });

  it("the CLI bundle DOES contain one — the positive control for the test above", () => {
    // Without this, the assertion above would also pass on a build where crash
    // reporting had silently vanished.
    const bundle = join(PKG_ROOT, "dist", "cli.js");
    if (!existsSync(bundle)) return;
    expect(readFileSync(bundle, "utf8")).toMatch(/\bfetch\s*\(/);
  });
});
