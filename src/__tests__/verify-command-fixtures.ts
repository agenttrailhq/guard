/**
 * Synthetic sessions with shell commands AND file edits, for the suites of the checks that read
 * what commands and edits did (tests, cloud, production, unreviewed code, egress, dependencies).
 *
 * Each session is written to a temporary folder in the app's own format and read back through
 * that app's real reader, so the checks are tested on what the readers produce:
 *
 *   Claude Code   `Bash` for a command; `Edit` and `Write` for edits; a `tool_result` when the
 *                 event has a result.
 *   Codex         `exec_command` for a command; `apply_patch` for edits and deletions; a
 *                 `custom_tool_call_output` when the event has a result. Written from the
 *                 documented rollout format, not from a recorded session.
 *   Cursor        `Shell`, `StrReplace`, `Write` and `Delete`. Cursor records no results.
 *
 * Every value is made up. Text that looks destructive is written here, in test code, and
 * nowhere else.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { readCodexCorpus } from "../core/codex-transcript/scan.js";
import { readCursorCorpus } from "../core/cursor-transcript/scan.js";
import { compileAllowlist } from "../core/evaluate.js";
import { compileCatalog } from "../core/rules.js";
import type { ScanCorpus } from "../core/scan-report.js";
import { parseSession } from "../core/transcript/parse.js";
import type { AgentSource } from "../core/types.js";
import { type CorpusCalls, readCalls } from "../core/verify/calls.js";
import { isLocalFix, type LocalFix, type UnsafeFix } from "../core/verify/cards.js";
import { type VerifyIO, WATCHED_PROCESSES } from "../core/verify/types.js";
import { createRealScanIO } from "../scan-io.js";

/** What a call's transcript records as its result. */
export interface EventResult {
  readonly text: string;
  readonly isError?: boolean;
}

/** One thing that happened in a session. */
export type CommandEvent =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "shell"; readonly command: string; readonly result?: EventResult }
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly old: string;
      readonly new: string;
      readonly result?: EventResult;
    }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly content: string;
      readonly result?: EventResult;
    }
  | { readonly kind: "delete"; readonly path: string; readonly result?: EventResult }
  | { readonly kind: "read"; readonly path: string; readonly result?: EventResult };

/** A result that says the call ran and printed nothing. */
export const OK: EventResult = { text: "" };

/** Options for one written corpus. */
export interface CommandCorpusOptions {
  /** The working directory the sessions name. */
  readonly cwd?: string;
}

/** Claude Code's tool use for one event. */
function claudeUse(event: Exclude<CommandEvent, { kind: "prompt" }>): {
  name: string;
  input: Record<string, unknown>;
} {
  switch (event.kind) {
    case "shell":
      return { name: "Bash", input: { command: event.command } };
    case "edit":
      return {
        name: "Edit",
        input: { file_path: event.path, old_string: event.old, new_string: event.new },
      };
    case "write":
      return { name: "Write", input: { file_path: event.path, content: event.content } };
    case "delete":
      return { name: "Bash", input: { command: `rm ${event.path}` } };
    case "read":
      return { name: "Read", input: { file_path: event.path } };
  }
}

/** A Claude Code transcript for one session. */
function claudeLines(events: readonly CommandEvent[], session: string, cwd: string): string[] {
  const lines: string[] = [];
  const base = { sessionId: session, cwd, timestamp: "2026-10-01T00:00:00.000Z" };
  events.forEach((event, i) => {
    if (event.kind === "prompt") {
      lines.push(
        JSON.stringify({
          ...base,
          type: "user",
          uuid: `u${i}`,
          message: { role: "user", content: event.text },
        }),
      );
      return;
    }
    const id = `${session}-t${i}`;
    const use = claudeUse(event);
    lines.push(
      JSON.stringify({
        ...base,
        type: "assistant",
        uuid: `a${i}`,
        message: { role: "assistant", content: [{ type: "tool_use", id, ...use }] },
      }),
    );
    if (event.result !== undefined) {
      lines.push(
        JSON.stringify({
          ...base,
          type: "user",
          uuid: `r${i}`,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: event.result.text,
                is_error: event.result.isError === true,
              },
            ],
          },
        }),
      );
    }
  });
  return lines;
}

/** One Codex record. */
function codexRecord(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-10-01T00:00:00.000Z", type, payload });
}

/** The shim fragment for one event, in the documented rollout format. */
function codexShim(event: Exclude<CommandEvent, { kind: "prompt" }>): string {
  const patch = (body: string): string =>
    `const r = await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n${body}\n*** End Patch`)});\ntext(r);\n`;
  switch (event.kind) {
    case "shell":
      return `const r = await tools.exec_command({cmd:${JSON.stringify(event.command)},workdir:"/w"}); text(r.output);\n`;
    case "edit": {
      const lines = [
        ...event.old.split("\n").map((l) => `-${l}`),
        ...event.new.split("\n").map((l) => `+${l}`),
      ];
      return patch(`*** Update File: ${event.path}\n@@\n${lines.join("\n")}`);
    }
    case "write":
      return patch(
        `*** Add File: ${event.path}\n${event.content
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n")}`,
      );
    case "delete":
      return patch(`*** Delete File: ${event.path}`);
    case "read":
      return `const r = await tools.exec_command({cmd:${JSON.stringify(`cat ${event.path}`)},workdir:"/w"}); text(r.output);\n`;
  }
}

/** A Codex session file for one session. */
function codexLines(events: readonly CommandEvent[], session: string, cwd: string): string[] {
  const lines = [codexRecord("session_meta", { session_id: session, cwd, cli_version: "0.0.0" })];
  events.forEach((event, i) => {
    if (event.kind === "prompt") {
      lines.push(
        codexRecord("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: event.text }],
        }),
      );
      return;
    }
    const callId = `call_${session}_${i}`;
    lines.push(
      codexRecord("response_item", {
        type: "custom_tool_call",
        call_id: callId,
        name: "exec",
        input: codexShim(event),
      }),
    );
    if (event.result !== undefined) {
      lines.push(
        codexRecord("response_item", {
          type: "custom_tool_call_output",
          call_id: callId,
          output: [{ type: "input_text", text: event.result.text }],
        }),
      );
    }
  });
  lines.push(codexRecord("token_usage_record", { usage: { input_tokens: 1, output_tokens: 1 } }));
  return lines;
}

/** A Cursor session file for one session. */
function cursorLines(events: readonly CommandEvent[]): string[] {
  return events.map((event) => {
    if (event.kind === "prompt") {
      return JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: event.text }] },
      });
    }
    const use =
      event.kind === "shell"
        ? { name: "Shell", input: { command: event.command } }
        : event.kind === "edit"
          ? {
              name: "StrReplace",
              input: { path: event.path, old_string: event.old, new_string: event.new },
            }
          : event.kind === "write"
            ? { name: "Write", input: { path: event.path, contents: event.content } }
            : event.kind === "read"
              ? { name: "Read", input: { path: event.path } }
              : { name: "Delete", input: { path: event.path } };
    return JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "tool_use", ...use }] },
    });
  });
}

/** Write one app's sessions to a new temporary folder and read them back with its reader. */
export async function writeCommandCorpus(
  agent: AgentSource,
  sessions: readonly (readonly CommandEvent[])[],
  options: CommandCorpusOptions = {},
): Promise<{ readonly corpus: ScanCorpus; readonly root: string }> {
  const root = mkdtempSync(join(tmpdir(), `agenttrail-verify-cmd-${agent}-`));
  const cwd = options.cwd ?? "/nonexistent/synthetic/project";
  const io = createRealScanIO();

  if (agent === "claude") {
    const folder = join(root, "-synthetic-project");
    mkdirSync(folder, { recursive: true });
    const parsed = [];
    const files: string[] = [];
    for (const [i, events] of sessions.entries()) {
      const file = join(folder, `session-${i}.jsonl`);
      writeFileSync(file, `${claudeLines(events, `session-${i}`, cwd).join("\n")}\n`);
      parsed.push(await parseSession(file, `session-${i}`, io));
      files.push(file);
    }
    return {
      root,
      corpus: { agent: "claude", sessions: parsed, quarantined: 0, notRead: 0, projects: 1, files },
    };
  }

  if (agent === "codex") {
    const folder = join(root, "2026", "10", "01");
    mkdirSync(folder, { recursive: true });
    for (const [i, events] of sessions.entries()) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      writeFileSync(
        join(folder, `rollout-2026-10-01T00-00-00-${id}.jsonl`),
        `${codexLines(events, id, cwd).join("\n")}\n`,
      );
    }
    return { root, corpus: await readCodexCorpus(root, io) };
  }

  for (const [i, events] of sessions.entries()) {
    const folder = join(root, "synthetic-project", "agent-transcripts", `s${i}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `s${i}.jsonl`), `${cursorLines(events).join("\n")}\n`);
  }
  return { root, corpus: await readCursorCorpus(root, io) };
}

/** The shipped guardrails, compiled, with no allowlist. */
export const SHIPPED = {
  catalog: compileCatalog(SHIPPED_CATALOG),
  allowlist: compileAllowlist([]),
};

/** The calls of one app's sessions, as the checks read them, under the shipped guardrails. */
export async function callsOf(
  agent: AgentSource,
  sessions: readonly (readonly CommandEvent[])[],
  options: CommandCorpusOptions = {},
): Promise<CorpusCalls> {
  const { corpus } = await writeCommandCorpus(agent, sessions, options);
  return readCalls(corpus, SHIPPED.catalog, SHIPPED.allowlist);
}

/** A `VerifyIO` that answers from fixed tables and records the git calls it was asked. */
export function fakeIO(
  options: {
    readonly processes?: readonly string[] | "fail";
    readonly git?: (cwd: string, args: readonly string[]) => string | undefined;
  } = {},
): VerifyIO & { readonly gitCalls: { cwd: string; args: readonly string[] }[] } {
  const gitCalls: { cwd: string; args: readonly string[] }[] = [];
  return {
    gitCalls,
    git: (cwd, args) => {
      gitCalls.push({ cwd, args });
      const out = options.git?.(cwd, args);
      return Promise.resolve(
        out === undefined ? { ok: false, reason: "missing" } : { ok: true, stdout: out },
      );
    },
    isDirectory: () => true,
    readFile: () => Promise.resolve({ ok: false, reason: "missing" }),
    processNames: () =>
      Promise.resolve(
        options.processes === "fail"
          ? { ok: false, reason: "failed" }
          : {
              ok: true,
              running: WATCHED_PROCESSES.filter((id) => (options.processes ?? []).includes(id)),
            },
      ),
  };
}

/** A fix as the local fixes file would say it: the command, or that none could be made safe. */
export function fixText(fix: LocalFix | UnsafeFix): string {
  return isLocalFix(fix) ? fix.command : `(${fix.note})`;
}
