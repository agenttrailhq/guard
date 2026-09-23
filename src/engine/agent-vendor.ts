export const AGENT_VENDORS = [
  "claude-code",
  "cursor",
  "codex",
  "replit-agent",
  "devin",
  "aider",
  "windsurf",
  "github-copilot",
] as const;

export type AgentVendor = (typeof AGENT_VENDORS)[number];

export type TraceVendor = AgentVendor | "";

export const AGENT_VENDOR_LABELS: Readonly<Record<AgentVendor, string>> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "replit-agent": "Replit Agent",
  devin: "Devin",
  aider: "Aider",
  windsurf: "Windsurf",
  "github-copilot": "GitHub Copilot",
};

export function isAgentVendor(value: unknown): value is AgentVendor {
  return typeof value === "string" && (AGENT_VENDORS as readonly string[]).includes(value);
}
