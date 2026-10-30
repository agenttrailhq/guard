/**
 * What a file-tool call (Edit, Write, Read, MultiEdit, NotebookEdit…) is shown as in the report.
 *
 * Its path is redacted whole, so `Edit <path>` alone tells a reader nothing: one row would stand
 * for a test config, an agent's memory and a CI workflow at once, and read as a false flag. So a
 * file-tool call is shown as the tool and what kind of file it was:
 *
 * - a well-known name that identifies no one and no project keeps it: `Edit vitest.config.ts`,
 *   `Edit package.json`, `Write CLAUDE.md`, `Read .env.local`,
 *   `Edit .github/workflows/<file>.yml` (`KNOWN_NAMES`). Nothing else of the path is kept;
 * - any other file is named by the kind of file the guardrail that matched it looks for:
 *   `Edit <test config>`, `Write <agent memory file>` (`FILE_KINDS`). A guardrail with no kind
 *   here, such as one the user wrote, gives `<file>`.
 *
 * The output is built only from the tool's name, these fixed names and kinds, and a name that
 * matches one of the `KNOWN_NAMES` patterns whole: no other part of a path ever reaches it.
 */

/** A well-known, non-identifying file name, matched whole against a path's last segment. */
const KNOWN_NAMES: readonly RegExp[] = [
  /^(?:vitest|vite)\.(?:config|workspace)\.(?:js|ts|mjs|mts|cjs|cts|json)$/,
  /^jest\.config\.(?:js|ts|mjs|mts|cjs|cts|json)$/,
  /^package\.json$/,
  /^tsconfig\.json$/,
  /^(?:CLAUDE|CLAUDE\.local|AGENTS|GEMINI|MEMORY)\.md$/,
  /^\.mcp\.json$/,
  /^\.env(?:\.(?:local|development|dev|production|prod|staging|test|example|sample))*$/,
];

/** A CI workflow: kept as the folder with the file's name taken out. */
const WORKFLOW = /(?:^|[\\/])\.github[\\/]workflows[\\/][^\\/]+\.(yml|yaml)$/;

/** The kind of file each shipped guardrail that reads paths looks for, by guardrail id. */
export const FILE_KINDS: Readonly<Record<string, string>> = {
  "ti.test-config-edit": "test config",
  "ac.memory-store-edit": "agent memory file",
  "fs.ci-definition": "CI workflow",
  "se.credential-file": "credentials file",
  "block-env-file-read": "env file",
  "block-prod-config-edit": "production config",
  "require-auth-on-pii-endpoints": "API route file",
  "fs.agent-self-config": "agent settings file",
  "fs.system-paths": "system file",
  "fs.vcs-internals": "git internals file",
  "ac.instruction-file-edit": "agent instructions file",
  "ac.skill-install": "agent skill file",
  "ac.mcp-server-add": "MCP config file",
};

/** The kind shown for a guardrail with none in `FILE_KINDS`. */
export const UNKNOWN_FILE_KIND = "file";

/** A path's last segment, either separator. */
function lastSegment(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

/**
 * What `path` may be shown as, when its name is a well-known one (`KNOWN_NAMES`, a CI
 * workflow), or `undefined` when it must not be shown at all.
 */
export function knownFileName(path: string): string | undefined {
  const workflow = WORKFLOW.exec(path.trim());
  if (workflow !== null) return `.github/workflows/<file>.${workflow[1]}`;
  const name = lastSegment(path.trim());
  return KNOWN_NAMES.some((known) => known.test(name)) ? name : undefined;
}

/** A tool name fit to show: letters, digits and `_` only, as every file tool's name is. */
function toolName(tool: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(tool) ? tool : "File tool";
}

/** The shape of a file-tool call that the guardrail `ruleId` matched. */
export function fileShapeOf(tool: string, path: string, ruleId: string): string {
  const name = knownFileName(path);
  const shown = name ?? `<${FILE_KINDS[ruleId] ?? UNKNOWN_FILE_KIND}>`;
  return `${toolName(tool)} ${shown}`;
}
