// cspell:words efgh unscrubbed
/**
 * The decision log writer.
 *
 * Two blocks here keep a piece of REASONING alive, not just a behavior:
 *
 *   - "scrub the field, then serialize" carries its own negative control, because
 *     the obvious ordering is the opposite one, and the opposite
 *     silently leaves secrets in the file.
 *   - the end-to-end block holds "status never prints a raw secret" against real
 *     output: the recorder scrubs once, and nothing on the display path scrubs again.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runStatus } from "../commands/status.js";
import { parseDecisionLog } from "../core/decision-log.js";
import {
  createEventRecorder,
  DEDUP_WINDOW_MS,
  MAX_AGE_MS,
  MAX_BYTES,
  NOOP_RECORDER,
  TARGET_BYTES,
} from "../core/events.js";
import { eventsPath } from "../core/paths.js";
import { isRedacted } from "../core/redaction.js";
import { scrubText } from "../core/scrub.js";
import { AGENTS, type GuardDecision, type MappedCall } from "../core/types.js";
import type { GuardIO } from "../io.js";
import type { SetupIO } from "../setup-io.js";
import { POSITIVE_FIXTURES } from "./scrub-corpus.js";

const HOME = "/home/test";
const LOG = eventsPath(HOME);

/** An in-memory filesystem good enough for append, size, read and atomic write. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const io: GuardIO = {
    readStdin: async () => "{}",
    writeStdout: () => undefined,
    readFile: (p) => files.get(p),
    homedir: () => HOME,
    mkdirp: (p) => {
      dirs.add(p);
      return true;
    },
    writeFileAtomic: (p, text) => {
      files.set(p, text);
      return true;
    },
    listDir: () => [],
    deleteFile: (p) => files.delete(p),
    appendFile: (p, text) => {
      files.set(p, (files.get(p) ?? "") + text);
      return true;
    },
    fileSize: (p) => Buffer.byteLength(files.get(p) ?? "", "utf8"),
  };
  return { io, files, dirs };
}

function call(command: string, tool = "Bash"): MappedCall {
  return { tool, args: { full_command: command } };
}

function denied(ruleId = "wt.reset-hard"): GuardDecision {
  return {
    decision: "deny",
    reason: `blocked by rule: ${ruleId}`,
    matches: [{ ruleId, action: "block" }],
  };
}

function lines(text: string | undefined): string[] {
  return (text ?? "").split("\n").filter((l) => l.trim().length > 0);
}

describe("the record shape", () => {
  it("writes exactly {ts, tool, decision, ruleId, command, agent}, in that order", () => {
    const { io, files } = fakeFs();
    createEventRecorder(io, () => Date.parse("2026-09-07T10:00:00.000Z")).record({
      mapped: call("git reset --hard"),
      decision: denied(),
      agent: "claude",
    });

    const written = lines(files.get(LOG));
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] as string);
    expect(Object.keys(parsed)).toEqual(["ts", "tool", "decision", "ruleId", "command", "agent"]);
    expect(parsed).toEqual({
      ts: "2026-09-07T10:00:00.000Z",
      tool: "Bash",
      decision: "deny",
      ruleId: "wt.reset-hard",
      command: "git reset --hard",
      agent: "claude",
    });
    expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
  });

  it("writes the event's agent, not a fixed value", () => {
    // The caller decides the app; the writer copies it. A writer that always wrote
    // `claude` would still pass the test above. Driven off `AGENTS`, so an app added
    // there is covered here without anyone remembering to extend a literal list — which
    // is how `codex` would otherwise have been written to the log untested.
    for (const agent of AGENTS) {
      const { io, files } = fakeFs();
      createEventRecorder(io).record({ mapped: call("x"), decision: denied(), agent });
      expect(JSON.parse(lines(files.get(LOG))[0] as string).agent).toBe(agent);
    }
  });

  it("round-trips through the reader that consumes it", () => {
    // The writer and `core/decision-log.ts` are separate modules with separate
    // shapes. This is the only assertion that proves they agree on the wire.
    const { io, files } = fakeFs();
    const rec = createEventRecorder(io, () => Date.parse("2026-09-07T10:00:00.000Z"));
    rec.record({ mapped: call("rm -rf ./build"), decision: denied("fs.rm-rf"), agent: "claude" });
    rec.record({ mapped: call("rm -rf ./dist"), decision: denied("fs.rm-rf"), agent: "cursor" });

    expect(parseDecisionLog(files.get(LOG))).toEqual([
      {
        ts: "2026-09-07T10:00:00.000Z",
        tool: "Bash",
        decision: "deny",
        ruleId: "fs.rm-rf",
        command: "rm -rf ./build",
        agent: "claude",
      },
      {
        ts: "2026-09-07T10:00:00.000Z",
        tool: "Bash",
        decision: "deny",
        ruleId: "fs.rm-rf",
        command: "rm -rf ./dist",
        agent: "cursor",
      },
    ]);
  });

  it("uses file_path when the call has no command channel", () => {
    const { io, files } = fakeFs();
    createEventRecorder(io).record({
      mapped: { tool: "Edit", args: { file_path: "/etc/hosts" } },
      decision: denied("fs.system-path"),
      agent: "claude",
    });
    expect(JSON.parse(lines(files.get(LOG))[0] as string).command).toBe("/etc/hosts");
  });
});

describe("the reader requires agent", () => {
  const LINE = {
    ts: "2026-09-07T10:00:00.000Z",
    tool: "Bash",
    decision: "deny",
    ruleId: "wt.reset-hard",
    command: "git reset --hard",
  };

  it("skips a line without a string agent, and keeps the lines around it", () => {
    const text = [
      JSON.stringify({ ...LINE, agent: "claude" }),
      JSON.stringify(LINE),
      JSON.stringify({ ...LINE, agent: null }),
      JSON.stringify({ ...LINE, agent: 1 }),
      JSON.stringify({ ...LINE, ruleId: "fs.rm-rf", agent: "cursor" }),
    ].join("\n");

    expect(parseDecisionLog(text)).toEqual([
      { ...LINE, agent: "claude" },
      { ...LINE, ruleId: "fs.rm-rf", agent: "cursor" },
    ]);
  });

  it("a log whose lines all lack agent reads as empty", () => {
    expect(parseDecisionLog(`${JSON.stringify(LINE)}\n${JSON.stringify(LINE)}\n`)).toEqual([]);
  });
});

describe("what is recorded, and what is not", () => {
  it("a call that matched nothing writes no line at all", () => {
    // `parseDecisionLog` discards records without a ruleId, so writing one would be
    // pure cost — and most tool calls match nothing.
    const { io, files } = fakeFs();
    createEventRecorder(io).record({
      mapped: call("ls"),
      decision: { decision: "allow", reason: "", matches: [] },
      agent: "claude",
    });
    expect(files.get(LOG)).toBeUndefined();
  });

  it("a warn IS recorded — as allow, with its guardrail id", () => {
    // `status` counts warns: a rule that warns forty times a day is exactly as
    // annoying as one that blocks, and the allowlist is the valve for both.
    const { io, files } = fakeFs();
    createEventRecorder(io).record({
      mapped: call("npm install left-pad"),
      decision: {
        decision: "allow",
        reason: "warning from rule: sc.new-dependency",
        matches: [{ ruleId: "sc.new-dependency", action: "warn" }],
      },
      agent: "claude",
    });
    const parsed = JSON.parse(lines(files.get(LOG))[0] as string);
    expect(parsed.decision).toBe("allow");
    expect(parsed.ruleId).toBe("sc.new-dependency");
  });

  it("records the DECIDING guardrail, and agrees with decision.reason", () => {
    // `evaluate.ts` already names the deciding rule in `reason`. Deriving it a
    // second way is only safe if the two provably agree.
    const cases: GuardDecision[] = [
      {
        decision: "deny",
        reason: "blocked by rule: b.rule",
        matches: [
          { ruleId: "w.rule", action: "warn" },
          { ruleId: "b.rule", action: "block" },
        ],
      },
      {
        decision: "ask",
        reason: "approval required by rule: a.rule",
        matches: [
          { ruleId: "w.rule", action: "warn" },
          { ruleId: "a.rule", action: "require_approval" },
        ],
      },
      {
        decision: "allow",
        reason: "warning from rule: w.rule",
        matches: [{ ruleId: "w.rule", action: "warn" }],
      },
    ];

    for (const decision of cases) {
      const { io, files } = fakeFs();
      createEventRecorder(io).record({ mapped: call("x"), decision, agent: "claude" });
      const parsed = JSON.parse(lines(files.get(LOG))[0] as string);
      expect(decision.reason.endsWith(parsed.ruleId)).toBe(true);
    }
  });
});

describe("scrubbing: the field, then serialize", () => {
  const SECRETS: readonly [string, string][] = [
    ["quoted env value", 'export API_KEY="abcd1234efgh" && deploy'],
    ["aws key id", "aws s3 cp x s3://b --profile AKIAIOSFODNN7EXAMPLE"],
    ["github token in a url", `git push https://ghp_${"A".repeat(36)}@github.com/x/y`],
    ["env-style aws secret", "AWS_SECRET_ACCESS_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd cmd"],
    ["connection string", "psql postgres://u:p@db.internal:5432/app"],
    ["an email", "git config user.email priya@acme.io"],
  ];

  it.each(SECRETS)("redacts a %s before it reaches the file", (_name, command) => {
    const { io, files } = fakeFs();
    createEventRecorder(io).record({ mapped: call(command), decision: denied(), agent: "claude" });

    const raw = files.get(LOG) ?? "";
    const parsed = JSON.parse(lines(raw)[0] as string);
    expect(parsed.command).toContain("[REDACTED:");
    // The redacted SUBSTRING must be gone from the whole file, not just changed.
    const secret = scrubText(command);
    expect(secret.total).toBeGreaterThan(0);
    expect(parsed.command).toBe(secret.text);
  });

  it("every written line re-parses as JSON", () => {
    const { io, files } = fakeFs();
    const rec = createEventRecorder(io);
    for (const [, command] of SECRETS)
      rec.record({ mapped: call(command), decision: denied(), agent: "claude" });
    rec.record({ mapped: call("echo 'a\nb'"), decision: denied(), agent: "claude" });
    rec.record({
      mapped: call(JSON.stringify({ query: "x", api_key: "abcd1234efgh" }), "mcp__demo__run"),
      decision: denied(),
      agent: "claude",
    });

    const written = lines(files.get(LOG));
    expect(written).toHaveLength(SECRETS.length + 2);
    for (const line of written) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("PINNED: scrubbing the SERIALIZED line instead would leave the secret", () => {
    // The negative control for the ordering above, and the reason it is not
    // arbitrary. `JSON.stringify` escapes the value's quotes to \"; the `.env`
    // heuristic's quoted branch needs a literal `"` and its unquoted branch excludes
    // one, so an escaped quote matches NEITHER and nothing is redacted at all.
    const command = 'export API_KEY="abcd1234efgh"';
    const serializedFirst = scrubText(JSON.stringify({ command })).text;
    expect(serializedFirst).toContain("abcd1234efgh");
    expect(serializedFirst).not.toContain("[REDACTED:");

    // The order this module actually uses.
    const fieldFirst = JSON.stringify({ command: scrubText(command).text });
    expect(fieldFirst).not.toContain("abcd1234efgh");
    expect(JSON.parse(fieldFirst).command).toBe("export API_KEY=[REDACTED:secret:env]");
  });

  it("PINNED: the written command must never be scrubbed a second time", () => {
    // `scrubText` is not idempotent. If any consumer re-scrubs a recorded command,
    // this is what it does to it.
    const { io, files } = fakeFs();
    createEventRecorder(io).record({
      mapped: call("aws s3 cp x s3://b --profile AKIAIOSFODNN7EXAMPLE"),
      decision: denied(),
      agent: "claude",
    });
    const once = JSON.parse(lines(files.get(LOG))[0] as string).command as string;
    expect(once).toContain("[REDACTED:secret:aws]");

    const twice = scrubText(once).text;
    expect(twice).not.toBe(once);
    expect(twice).toContain("[REDACTED:secret:[REDACTED:");
  });
});

describe("dedupe — one tool call, one record", () => {
  const claude = (command: string, callId?: string) => ({
    mapped: call(command),
    decision: denied("fs.rm-rf"),
    agent: "claude" as const,
    ...(callId === undefined ? {} : { callId }),
  });

  it("skips the twin record of a double hook invocation (same tool_use_id)", () => {
    const { io, files } = fakeFs();
    const rec = createEventRecorder(io);
    rec.record(claude("rm -rf ./build", "toolu_123"));
    rec.record(claude("rm -rf ./build", "toolu_123"));
    expect(lines(files.get(LOG))).toHaveLength(1);
  });

  it("keeps two distinct calls that share a command but differ in tool_use_id", () => {
    // The whole reason the id path exists: it never folds real, separate calls together.
    const { io, files } = fakeFs();
    const rec = createEventRecorder(io);
    rec.record(claude("rm -rf ./build", "toolu_a"));
    rec.record(claude("rm -rf ./build", "toolu_b"));
    expect(lines(files.get(LOG))).toHaveLength(2);
  });

  it("without an id, folds identical records inside the window and keeps them apart outside it", () => {
    const within = fakeFs();
    let t = 1_000_000;
    const rw = createEventRecorder(within.io, () => t);
    rw.record(claude("rm -rf ./x"));
    t += DEDUP_WINDOW_MS; // still within (the bound is inclusive)
    rw.record(claude("rm -rf ./x"));
    expect(lines(within.files.get(LOG))).toHaveLength(1);

    const outside = fakeFs();
    let u = 1_000_000;
    const ro = createEventRecorder(outside.io, () => u);
    ro.record(claude("rm -rf ./x"));
    u += DEDUP_WINDOW_MS + 1;
    ro.record(claude("rm -rf ./x"));
    expect(lines(outside.files.get(LOG))).toHaveLength(2);
  });

  it("never writes a tool_use_id into the log line", () => {
    const { io, files } = fakeFs();
    createEventRecorder(io).record({
      mapped: call("x"),
      decision: denied(),
      agent: "cursor",
      callId: "toolu_secret_id",
    });
    expect(files.get(LOG)).not.toContain("toolu_secret_id");
    const parsed = JSON.parse(lines(files.get(LOG))[0] as string);
    expect(Object.keys(parsed)).toEqual(["ts", "tool", "decision", "ruleId", "command", "agent"]);
  });
});

describe("bounded — by bytes on write, by age at compaction", () => {
  /** A record of a known size, `ageMs` old relative to `now`. */
  function seedLine(now: number, ageMs: number, i: number): string {
    return JSON.stringify({
      ts: new Date(now - ageMs).toISOString(),
      tool: "Bash",
      decision: "deny",
      ruleId: "r.seed",
      command: `cmd-${String(i).padStart(6, "0")}-${"x".repeat(100)}`,
      agent: "claude",
    });
  }

  it("crosses MAX_BYTES, compacts to at most TARGET_BYTES, keeps the newest", () => {
    const now = Date.parse("2026-09-07T10:00:00.000Z");
    const seed: string[] = [];
    let bytes = 0;
    let i = 0;
    while (bytes <= MAX_BYTES) {
      const line = seedLine(now, 1000, i++);
      seed.push(line);
      bytes += Buffer.byteLength(line, "utf8") + 1;
    }
    const { io, files } = fakeFs({ [LOG]: `${seed.join("\n")}\n` });

    createEventRecorder(io, () => now).record({
      mapped: call("the newest command"),
      decision: denied("r.newest"),
      agent: "claude",
    });

    const after = files.get(LOG) ?? "";
    expect(Buffer.byteLength(after, "utf8")).toBeLessThanOrEqual(TARGET_BYTES);
    // The newest survives, the oldest is gone, and it is still a valid log.
    const parsedAfter = parseDecisionLog(after, 100_000);
    expect(parsedAfter.at(-1)?.ruleId).toBe("r.newest");
    expect(after).not.toContain("cmd-000000");
    for (const line of lines(after)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("drops records past MAX_AGE_MS in the same pass", () => {
    const now = Date.parse("2026-09-07T10:00:00.000Z");
    const aged = seedLine(now, MAX_AGE_MS + 60_000, 1);
    const fresh = seedLine(now, 60_000, 2);

    // The two probes sit at the NEWEST end, immediately before the append that
    // triggers compaction. That is what isolates the age bound from the size bound:
    // compaction keeps the newest TARGET_BYTES, so a probe placed in the older half
    // would be evicted for its POSITION and the test would pass without age working
    // at all. Here both probes are comfortably inside the retained window, and the
    // only thing that can remove `aged` is its timestamp.
    const filler: string[] = [];
    let bytes = Buffer.byteLength(`${aged}\n${fresh}\n`, "utf8");
    let i = 10;
    while (bytes <= MAX_BYTES) {
      const line = seedLine(now, 60_000, i++);
      filler.push(line);
      bytes += Buffer.byteLength(line, "utf8") + 1;
    }
    const { io, files } = fakeFs({ [LOG]: `${filler.join("\n")}\n${aged}\n${fresh}\n` });

    createEventRecorder(io, () => now).record({
      mapped: call("x"),
      decision: denied(),
      agent: "claude",
    });

    const after = files.get(LOG) ?? "";
    expect(after).toContain("cmd-000002"); // fresh, same position band — retained
    expect(after).not.toContain("cmd-000001"); // aged out, despite being newest-but-one
  });

  it("a truncated final line is tolerated and dropped at compaction", () => {
    const now = Date.parse("2026-09-07T10:00:00.000Z");
    const seed: string[] = [];
    let bytes = 0;
    let i = 0;
    while (bytes <= MAX_BYTES) {
      const line = seedLine(now, 1000, i++);
      seed.push(line);
      bytes += Buffer.byteLength(line, "utf8") + 1;
    }
    // A process killed mid-append leaves exactly this.
    const { io, files } = fakeFs({ [LOG]: `${seed.join("\n")}\n{"ts":"2026-09-07T09` });

    createEventRecorder(io, () => now).record({
      mapped: call("x"),
      decision: denied(),
      agent: "claude",
    });

    const after = files.get(LOG) ?? "";
    for (const line of lines(after)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("does not compact while under the ceiling", () => {
    const { io, files } = fakeFs();
    const rec = createEventRecorder(io);
    for (let i = 0; i < 50; i++)
      rec.record({ mapped: call(`cmd ${i}`), decision: denied(), agent: "claude" });
    expect(lines(files.get(LOG))).toHaveLength(50);
  });
});

describe("never fatal — every IO member forced to fail in turn", () => {
  const BREAK: readonly (keyof GuardIO)[] = [
    "homedir",
    "mkdirp",
    "appendFile",
    "fileSize",
    "readFile",
    "writeFileAtomic",
  ];

  it.each(BREAK)("a throw from %s is swallowed", (member) => {
    const { io } = fakeFs();
    const broken: GuardIO = {
      ...io,
      [member]: () => {
        throw new Error("boom");
      },
    };
    expect(() =>
      createEventRecorder(broken).record({
        mapped: call("x"),
        decision: denied(),
        agent: "claude",
      }),
    ).not.toThrow();
  });

  it.each([
    "mkdirp",
    "appendFile",
    "writeFileAtomic",
  ] as const)("a false return from %s is not an error either", (member) => {
    const { io } = fakeFs();
    const refusing: GuardIO = { ...io, [member]: () => false };
    expect(() =>
      createEventRecorder(refusing).record({
        mapped: call("x"),
        decision: denied(),
        agent: "claude",
      }),
    ).not.toThrow();
  });

  it("a read-only home records nothing and writes no output", () => {
    const { io, files } = fakeFs();
    const readOnly: GuardIO = { ...io, mkdirp: () => false };
    const written: string[] = [];
    createEventRecorder({ ...readOnly, writeStdout: (t) => written.push(t) }).record({
      mapped: call("x"),
      decision: denied(),
      agent: "claude",
    });
    expect(files.get(LOG)).toBeUndefined();
    expect(written).toEqual([]);
  });

  it("NOOP_RECORDER still exists and does nothing", () => {
    expect(() =>
      NOOP_RECORDER.record({ mapped: call("x"), decision: denied(), agent: "claude" }),
    ).not.toThrow();
  });
});

describe("the display leg — no second scrub", () => {
  /** `SetupIO` over the same fake filesystem, so `status` reads what we wrote. */
  function setupOver(files: Map<string, string>) {
    const out: string[] = [];
    const setup: SetupIO = {
      writeStdout: (t) => out.push(t),
      readFile: (p) => files.get(p),
      exists: (p) => files.has(p),
      writeFileAtomic: (p, text) => {
        files.set(p, text);
      },
      homedir: () => HOME,
      runClaude: () => ({ code: 1, stdout: "", stderr: "" }),
    };
    return { setup, out };
  }

  it("no raw secret reaches status stdout, with NO display-time scrub", () => {
    // Held end-to-end: real recorder in, real `status` out.
    const secrets: readonly [string, string][] = [
      ["abcd1234efgh", 'export API_KEY="abcd1234efgh"'],
      ["AKIAIOSFODNN7EXAMPLE", "aws --profile AKIAIOSFODNN7EXAMPLE s3 ls"],
      [`ghp_${"A".repeat(36)}`, `git push https://ghp_${"A".repeat(36)}@github.com/x/y`],
      ["priya@acme.io", "git config user.email priya@acme.io"],
      [
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd",
        "AWS_SECRET_ACCESS_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd x",
      ],
      ["u:p@db.internal", "psql postgres://u:p@db.internal:5432/app"],
    ];

    const { io, files } = fakeFs();
    const rec = createEventRecorder(io);
    for (const [, command] of secrets)
      rec.record({ mapped: call(command), decision: denied(), agent: "claude" });

    const { setup, out } = setupOver(files);
    return runStatus(setup, { catalog: [] }).then((code) => {
      expect(code).toBe(0);
      const stdout = out.join("");
      for (const [secret] of secrets) expect(stdout).not.toContain(secret);
      expect(stdout).toContain("[REDACTED:");
    });
  });

  it("exactly one module value-imports scrubText — the writer", () => {
    // The durable form of "scrub exactly once". A second call site anywhere in
    // production `src/` re-introduces the double-scrub that deleted a module
    // to avoid. Parsed, not grepped: prose in a comment must not read as an import.
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".ts")) files.push(full);
      }
    };
    walk(srcRoot);
    expect(files.length).toBeGreaterThan(20); // a sweep over nothing proves nothing

    const importers = files.filter((full) => {
      const sf = ts.createSourceFile(
        full,
        readFileSync(full, "utf8"),
        ts.ScriptTarget.Latest,
        false,
      );
      return sf.statements.some(
        (st) =>
          ts.isImportDeclaration(st) &&
          ts.isStringLiteral(st.moduleSpecifier) &&
          /(^|\/)scrub\.js$/.test(st.moduleSpecifier.text) &&
          st.importClause?.isTypeOnly !== true,
      );
    });

    // `__tests__` legitimately imports it to assert on it. Production importers are
    // listed explicitly, and the rule that governs the list is NOT "how many" — it is:
    //
    //   **one binding per data path, and each scrubs RAW input exactly once.**
    //
    //   core/events.ts      — commands, on their way into events.jsonl
    //   core/crash-scrub.ts — stack traces, on their way into the crash spool
    //   core/scan-report.ts — transcript commands, on their way into the scan report
    //                         and the --json payload
    //
    // The failure this guards against is a SECOND PASS over already-scrubbed data,
    // which mangles 11 of the 14 placeholder kinds. `commands/status.ts` and
    // `core/decision-log.ts` are the two that must never appear here for exactly that
    // reason — they read what `events.ts` already scrubbed.
    //
    // `core/scan-report.ts` satisfies the rule too: it reads
    // transcript text that has never been through the scrubber, scrubs it once on the
    // way IN, and every downstream surface (HTML, JSON, terminal) consumes the
    // already-redacted result without re-scrubbing. Before adding a fourth entry, check
    // that same property — a raw source, scrubbed once — rather than checking the count.
    const production = importers
      .map((f) => f.slice(srcRoot.length + 1))
      .filter((f) => !f.startsWith("__tests__"))
      .sort();
    expect(production).toEqual(["core/crash-scrub.ts", "core/events.ts", "core/scan-report.ts"]);
  });
});

describe("the redaction prefix isRedacted keys on is the one the catalog emits", () => {
  it("PINNED: every catalog pattern produces it", () => {
    // Total, not a sample. If any of the 14 placeholders changes shape,
    // this goes red rather than `status` and `guardrails allow` silently failing open.
    expect(POSITIVE_FIXTURES.length).toBeGreaterThanOrEqual(14);
    for (const fixture of POSITIVE_FIXTURES) {
      const scrubbed = scrubText(fixture.input);
      expect(scrubbed.total).toBeGreaterThan(0);
      expect(isRedacted(scrubbed.text)).toBe(true);
    }
  });

  it("does not flag ordinary text", () => {
    expect(isRedacted("git reset --hard ./src")).toBe(false);
    expect(isRedacted("")).toBe(false);
  });
});
