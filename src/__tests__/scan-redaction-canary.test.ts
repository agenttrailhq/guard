// cspell:words mcpcanary awscanary bearercanary slackcanary connpwcanary envsecretcanary
// cspell:words emailcanary pathcanary acmecocanary filecanary containercanary sshcanary
// cspell:words kubenscanary kubepodcanary sqlhostcanary sqldbcanary sqltablecanary
// cspell:words gitbranchcanary baretokencanary barepwcanary barekeycanary deploybot
// cspell:words slackcheck postgresql secretflag gitcomment
/**
 * The redaction canary corpus, as a standing regression.
 *
 * A uniquely-greppable token is planted for every class the report claims to redact, in
 * a synthetic transcript corpus, and each planted command is given a matching rule so it
 * actually reaches the report — a token in a command that never fires would trivially
 * "not leak", which is the false all-clear this suite is built to prevent. So corpus
 * HEALTH is asserted first: sessions, tool calls, findings and risky actions are all
 * non-zero, and every token is proven present in the input. Only then is the real claim
 * checked: ZERO survivors across both surfaces the report exposes, the HTML and the JSON.
 *
 * The classes split three ways: values the report now redacts structurally (an MCP
 * payload); shell gaps this change closes (a bare-flag secret, a kubectl resource name,
 * a SQL identifier, a branch in a comment); and the classes that already redacted and
 * must stay redacted (the five structured secrets, email, home paths, filenames,
 * container names, ssh hosts). One token that survives fails the build.
 */

import { describe, expect, it } from "vitest";
import { compileAllowlist } from "../core/evaluate.js";
import { type ReportMeta, renderJson, renderReport } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, type ScanCorpus } from "../core/scan-report.js";
import type { GuardRule } from "../core/types.js";
import { RULE_ENV_FILE, session, toolUse, turn } from "./scan-fixtures.js";

const META: ReportMeta = { version: "0.1.0", generatedAt: new Date("2026-09-08T09:00:00.000Z") };

// Slack and AWS shapes are assembled at runtime, never written as source literals: a
// checked-in credential-shaped string trips secret push-protection even when synthetic.
const SLACK_TOKEN = `xoxb${"-"}SLACKCANARYtoken000000`;
const AWS_KEY_ID = `AKIA${"AWSCANARY0123456"}`;

/** One planted case: the command, the substrings that must vanish, and a matching rule. */
interface Canary {
  /** What class this covers — for a readable failure, not asserted. */
  readonly label: string;
  /** The tool call to plant. */
  readonly use: ReturnType<typeof toolUse>;
  /** Uniquely-greppable substrings that must be present in the input and gone from output. */
  readonly tokens: readonly string[];
  /** A rule that matches the planted call, so it reaches the report. Undefined reuses one. */
  readonly rule?: GuardRule;
}

/** A rule matching a Bash command by a stable, non-canary anchor substring. */
function bashRule(id: string, anchor: string): GuardRule {
  return {
    id,
    category: "prod-infra",
    severity: "high",
    defaultAction: "warn",
    title: "Canary corpus probe",
    description: "Matches one planted command so its redacted shape reaches the report.",
    match: { any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: [anchor] }] },
  };
}

/** A Bash tool call. */
function cmd(command: string, id: string): ReturnType<typeof toolUse> {
  return toolUse("Bash", { command }, id);
}

const MCP_INPUT = {
  team: "MCPCANARY-team-uuid-0001",
  title: "MCPCANARY prose title for a client",
  meta: { note: "MCPCANARY-internal-note", count: 909042 },
  force: true,
};

const CANARIES: readonly Canary[] = [
  // ── Structural MCP redaction (the core of this change) ───────────────────────
  {
    label: "MCP payload values",
    use: toolUse("mcp__tracker__create_issue", MCP_INPUT, "mcp"),
    tokens: ["MCPCANARY", "909042"],
    rule: {
      id: "c.mcp",
      category: "prod-infra",
      severity: "high",
      defaultAction: "warn",
      title: "Canary corpus probe",
      description: "Matches the planted MCP call so its redacted payload reaches the report.",
      match: {
        any_of: [
          { kind: "execute_tool", label: "mcp__tracker__create_issue", detail_contains: ["team"] },
        ],
      },
    },
  },

  // ── Shell deny-list gaps this change closes ──────────────────────────────────
  {
    label: "bare-argument secrets",
    use: cmd(
      "deploybot --token BARETOKENCANARY01 --password BAREPWCANARY02 --key BAREKEYCANARY03",
      "sec",
    ),
    tokens: ["BARETOKENCANARY", "BAREPWCANARY", "BAREKEYCANARY"],
    rule: bashRule("c.secretflag", "deploybot --token"),
  },
  {
    label: "kubectl resource operand",
    use: cmd("kubectl -n KUBENSCANARY get pods KUBEPODCANARY", "kube"),
    tokens: ["KUBENSCANARY", "KUBEPODCANARY"],
    rule: bashRule("c.kube", "kubectl -n"),
  },
  {
    label: "SQL host, db and table",
    use: cmd(
      "psql -h SQLHOSTCANARY.internal -d SQLDBCANARY -c 'SELECT * FROM SQLTABLECANARY WHERE id=1'",
      "sql",
    ),
    tokens: ["SQLHOSTCANARY", "SQLDBCANARY", "SQLTABLECANARY"],
    rule: bashRule("c.sql", "psql -h"),
  },
  {
    label: "branch name in a comment",
    use: cmd("git push origin main # ship GITBRANCHCANARY to prod", "git"),
    tokens: ["GITBRANCHCANARY"],
    rule: bashRule("c.gitcomment", "git push origin"),
  },

  // ── Do-not-regress: classes that already redacted ────────────────────────────
  {
    label: "AWS access key id",
    use: cmd(`aws configure set aws_access_key_id ${AWS_KEY_ID}`, "aws"),
    tokens: ["AWSCANARY"],
    rule: bashRule("c.aws", "aws configure"),
  },
  {
    label: "bearer token",
    use: cmd("curl -H 'Authorization: Bearer BEARERCANARYtoken123' https://api.example/v1", "bear"),
    tokens: ["BEARERCANARY"],
    rule: bashRule("c.bearer", "curl -H"),
  },
  {
    label: "slack token",
    use: cmd(`printf slackcheck ${SLACK_TOKEN}`, "slk"),
    tokens: ["SLACKCANARY"],
    rule: bashRule("c.slack", "printf slackcheck"),
  },
  {
    label: "connection string password",
    use: cmd("psql 'postgresql://admin:CONNPWCANARY@db.internal'", "conn"),
    tokens: ["CONNPWCANARY"],
    rule: bashRule("c.conn", "psql 'postgresql"),
  },
  {
    label: ".env secret assignment",
    use: cmd("export APP_SECRET_TOKEN=ENVSECRETCANARY01", "env"),
    tokens: ["ENVSECRETCANARY"],
    rule: bashRule("c.env", "APP_SECRET_TOKEN"),
  },
  {
    label: "email",
    use: cmd("git config user.email EMAILCANARY.dev@example.test", "eml"),
    tokens: ["EMAILCANARY"],
    rule: bashRule("c.email", "git config user.email"),
  },
  {
    label: "home path",
    use: cmd("cat /Users/PATHCANARY/clients/ACMECOCANARY/build/index.js", "path"),
    tokens: ["PATHCANARY", "ACMECOCANARY"],
    rule: bashRule("c.path", "cat /Users"),
  },
  {
    label: "filename via a file tool",
    use: toolUse("Read", { file_path: "/etc/FILECANARY/.env.production" }, "file"),
    tokens: ["FILECANARY"],
    // Reuses the shared .env-file rule rather than a Bash rule.
  },
  {
    label: "container name",
    use: cmd("docker exec CONTAINERCANARY-db psql -U app", "cont"),
    tokens: ["CONTAINERCANARY"],
    rule: bashRule("c.container", "docker exec"),
  },
  {
    label: "ssh host and login",
    use: cmd("ssh deploy@SSHCANARY-01 uptime", "ssh"),
    tokens: ["SSHCANARY"],
    rule: bashRule("c.ssh", "ssh deploy@"),
  },
];

const CATALOG = compileCatalog([
  RULE_ENV_FILE,
  ...CANARIES.map((c) => c.rule).filter((r): r is GuardRule => r !== undefined),
]);

const CORPUS: ScanCorpus = {
  sessions: [session([turn(CANARIES.map((c) => c.use))])],
  quarantined: 0,
  notRead: 0,
  projects: 1,
};

const RESULT = aggregateScan(CORPUS, CATALOG, compileAllowlist([]));
const HTML = renderReport(RESULT, META);
const JSON_TEXT = renderJson(RESULT, META);
const ALL_TOKENS = CANARIES.flatMap((c) => c.tokens);
const RAW_INPUT = JSON.stringify(CORPUS.sessions);

describe("corpus health — a non-firing corpus cannot produce a false all-clear", () => {
  it("read sessions, tool calls, findings and risky actions, all non-zero", () => {
    expect(RESULT.sessions).toBeGreaterThan(0);
    expect(RESULT.toolCalls).toBe(CANARIES.length);
    expect(RESULT.riskyActions).toBeGreaterThan(0);
    expect(RESULT.findings.length).toBeGreaterThan(0);
  });

  it("every planted class actually matched a rule and reached a finding", () => {
    // If a probe rule stopped matching, its command would silently drop out of the
    // report and its tokens would "not leak" for the wrong reason.
    expect(RESULT.riskyActions).toBe(CANARIES.length);
    expect(RESULT.findings.length).toBe(CATALOG.length);
  });

  it("every canary token really is present in the corpus input", () => {
    // The negative control: an assertion that a token is gone proves nothing unless the
    // token was there. `909042` is a number, so it is checked as a substring of the raw
    // serialized input rather than expecting it inside a specific command string.
    for (const token of ALL_TOKENS) {
      expect(RAW_INPUT, `"${token}" was never planted`).toContain(token);
    }
  });
});

describe("zero survivors — no planted token reaches either surface", () => {
  it.each(ALL_TOKENS)("%s reaches neither the HTML nor the JSON", (token) => {
    expect(HTML).not.toContain(token);
    expect(JSON_TEXT).not.toContain(token);
  });

  it("the report still reads as commands — structure survived the redaction", () => {
    // Over-redaction to a wall of placeholders would also pass "zero survivors" while
    // making the report useless, so a few shapes are pinned as still-legible.
    expect(HTML).toContain("kubectl -n &lt;name&gt; get pods &lt;name&gt;");
    expect(HTML).toContain("docker exec &lt;name&gt; psql -U app");
    expect(HTML).toContain("ssh &lt;user&gt;@&lt;host&gt;");
    // The MCP payload keeps its keys and shape while every value is gone.
    expect(HTML).toContain("&quot;team&quot;:&quot;&lt;value&gt;&quot;");
    expect(HTML).toContain("git push origin main #&lt;comment&gt;");
  });
});

describe("the two flagged fingerprint disclosures are now fully redacted", () => {
  it("drops the connection-string host and the AWS key-id last-4 from the report", () => {
    // These labels used to echo the connection-string host and the AWS key's last four
    // characters. Both fingerprint the environment a shared report is not meant to
    // disclose, so they are now fully redacted. Asserted so a later edit that re-adds a
    // hint is caught here.
    expect(HTML).not.toContain("host=db.internal");
    expect(HTML).not.toContain("db.internal");
    expect(JSON_TEXT).not.toContain("host=db.internal");
    expect(JSON_TEXT).not.toContain("db.internal");
    // The connection-string is still redacted — just without the host suffix.
    expect(HTML).toContain("secret:connection-string");
    expect(HTML).not.toContain("secret:connection-string:");
    // The AWS key-id is redacted with no trailing fingerprint.
    expect(HTML).toContain("secret:aws]");
    expect(HTML).not.toContain("secret:aws:");
    expect(HTML).not.toContain("3456");
    expect(JSON_TEXT).not.toContain("3456");
  });
});
