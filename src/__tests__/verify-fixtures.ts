/**
 * Synthetic transcripts for the `scan --verify` suites, for all three apps.
 *
 * Each session is a list of events — a prompt, a reply, a shell call with or without a
 * result — written to a temporary folder in the app's own file format and read back through
 * that app's real reader, so the verification is tested on what the readers actually produce.
 * Every value here is made up; credential-shaped strings are assembled at runtime by the
 * suites, never written as source literals. The Codex sessions are built from the documented
 * rollout format, not from a recorded Codex session.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexCorpus } from "../core/codex-transcript/scan.js";
import { readCursorCorpus } from "../core/cursor-transcript/scan.js";
import type { ScanCorpus } from "../core/scan-report.js";
import { parseSession } from "../core/transcript/parse.js";
import type { AgentSource } from "../core/types.js";
import { createRealScanIO } from "../scan-io.js";

/** One thing that happened in a session. */
export type SessionEvent =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "reply"; readonly text: string }
  | {
      readonly kind: "call";
      readonly command: string;
      /** Omitted: the transcript records no result for the call. */
      readonly result?: { readonly text: string; readonly isError?: boolean };
      /** Codex only: the folder the call names. Omitted: `/w`. */
      readonly workdir?: string;
    };

/** A written corpus: what the reader made of it, and where the files are. */
export interface WrittenCorpus {
  readonly corpus: ScanCorpus;
  /** The folder the sessions were written under. */
  readonly root: string;
}

/** Options for one written corpus. */
export interface CorpusOptions {
  /** The working directory the sessions name. Claude Code and Codex record one. */
  readonly cwd?: string;
}

/** A Claude Code transcript for one session. */
export function claudeLines(
  events: readonly SessionEvent[],
  session: string,
  cwd: string,
): string[] {
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
    } else if (event.kind === "reply") {
      lines.push(
        JSON.stringify({
          ...base,
          type: "assistant",
          uuid: `a${i}`,
          message: { role: "assistant", content: [{ type: "text", text: event.text }] },
        }),
      );
    } else {
      const id = `${session}-t${i}`;
      lines.push(
        JSON.stringify({
          ...base,
          type: "assistant",
          uuid: `a${i}`,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id, name: "Bash", input: { command: event.command } }],
          },
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
    }
  });
  return lines;
}

/** One Codex record. */
function codexRecord(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-10-01T00:00:00.000Z", type, payload });
}

/** The shim fragment Codex writes for one shell command, in the folder it names. */
export function codexExec(command: string, workdir = "/w"): string {
  return `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(workdir)}}); text(r.output);\n`;
}

/** A Codex session file for one session. */
function codexLines(events: readonly SessionEvent[], session: string, cwd: string): string[] {
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
    } else if (event.kind === "reply") {
      lines.push(
        codexRecord("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: event.text }],
        }),
      );
    } else {
      const callId = `call_${session}_${i}`;
      lines.push(
        codexRecord("response_item", {
          type: "custom_tool_call",
          call_id: callId,
          name: "exec",
          input: codexExec(event.command, event.workdir),
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
    }
  });
  lines.push(codexRecord("token_usage_record", { usage: { input_tokens: 1, output_tokens: 1 } }));
  return lines;
}

/** A Cursor session file for one session. Cursor records no results. */
function cursorLines(events: readonly SessionEvent[]): string[] {
  return events.map((event) => {
    if (event.kind === "prompt") {
      return JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: event.text }] },
      });
    }
    if (event.kind === "reply") {
      return JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: event.text }] },
      });
    }
    return JSON.stringify({
      role: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Shell", input: { command: event.command } }],
      },
    });
  });
}

/** Write one app's sessions to a new temporary folder and read them back with its reader. */
export async function writeCorpus(
  agent: AgentSource,
  sessions: readonly (readonly SessionEvent[])[],
  options: CorpusOptions = {},
): Promise<WrittenCorpus> {
  const root = mkdtempSync(join(tmpdir(), `agenttrail-verify-${agent}-`));
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
