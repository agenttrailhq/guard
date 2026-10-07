// cspell:disable -- credential-SHAPED synthetic values and invented client names.
/**
 * Regression fixtures for secrets and account identifiers that reached a shared `scan`
 * report.
 *
 * Each case is a real command shape with a fabricated value of a realistic length. The
 * secret is assembled at runtime so no contiguous key-shaped literal sits in the source.
 * A case is checked two ways: through `redactForReport` directly, and end to end through
 * `aggregateScan` and both renderers, so a surface that skipped the composition fails too.
 *
 * `masked: false` rows are shapes that were already masked; they are kept so a later edit
 * cannot reopen them. `kept` rows pin text that stays readable on purpose.
 */

import { describe, expect, it } from "vitest";
import { compileAllowlist } from "../core/evaluate.js";
import { type ReportMeta, renderJson, renderReport } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, redactForReport, type ScanCorpus } from "../core/scan-report.js";
import type { GuardRule } from "../core/types.js";
import { session, toolUse, turn } from "./scan-fixtures.js";

const META: ReportMeta = { version: "0.1.0", generatedAt: new Date("2026-10-01T09:00:00.000Z") };

/**
 * Values are unique per case, so one case's leak can never be mistaken for another's. The
 * digit suffix is the case index; lengths stay realistic (36-character key, 32-hex account,
 * 12-digit account number).
 */
function valuesFor(i: number) {
  const n = String(i).padStart(2, "0");
  return {
    KEY: ["rdc", `9fQ2xLmB7vTzK1aWc4Yp8NsJ0eHuD3${n}`].join("_"),
    CF: ["0123456789abcdef", `0123456789abcd${n}`].join(""),
    AWS: ["1234", "5678", `90${n}`].join(""),
    GCP: `northwind-prod-4815${n}`,
    LOGIN: `svcdeploy${n}`,
  };
}

interface LeakCase {
  readonly name: string;
  readonly command: string;
  /** Substrings that must not survive. */
  readonly secrets: readonly string[];
  /** A harmless substring of the command, used to route it to its own finding. */
  readonly anchor: string;
  /** False when the shape was already masked before the pass was added (a lock-in). */
  readonly leaksToday: boolean;
}

interface Template {
  readonly name: string;
  /** `{KEY}`, `{CF}`, `{AWS}`, `{GCP}` and `{LOGIN}` are filled per case. */
  readonly command: string;
  /** Which placeholders must not survive. */
  readonly secrets: readonly ("KEY" | "CF" | "AWS" | "GCP" | "LOGIN")[];
  readonly anchor: string;
  readonly leaksToday: boolean;
}

const TEMPLATES: readonly Template[] = [
  {
    name: "name ending in _KEY",
    command: "ACMEVENDOR_KEY={KEY} python ingest.py",
    secrets: ["KEY"],
    anchor: "ingest.py",
    leaksToday: true,
  },
  {
    name: "exported name ending in _KEY",
    command: "export FOO_KEY={KEY} && ./run.sh",
    secrets: ["KEY"],
    anchor: "run.sh",
    leaksToday: true,
  },
  {
    name: "random value after an unnamed environment assignment",
    command: "MYVAR={KEY} node server.js",
    secrets: ["KEY"],
    anchor: "node server.js",
    leaksToday: true,
  },
  {
    name: "random value after --flag=",
    command: "deploytool --session={KEY} --verbose",
    secrets: ["KEY"],
    anchor: "deploytool --session",
    leaksToday: true,
  },
  {
    name: "raw Authorization header",
    command: 'curl -H "Authorization: {KEY}" https://api.example.com/v1/parse',
    secrets: ["KEY"],
    anchor: "v1/parse",
    leaksToday: true,
  },
  {
    name: "X-...-Key header",
    command: 'curl -H "X-AcmeVendor-Key: {KEY}" https://api.example.com/v1/jobs',
    secrets: ["KEY"],
    anchor: "v1/jobs",
    leaksToday: true,
  },
  {
    name: "X-...-Token header",
    command: 'curl -H "X-Api-Token: {KEY}" https://api.example.com/v1/tokens',
    secrets: ["KEY"],
    anchor: "v1/tokens",
    leaksToday: false,
  },
  {
    name: "key in a python -c string literal",
    command: "python -c \"import acmevendor; acmevendor.Client('{KEY}').run()\"",
    secrets: ["KEY"],
    anchor: "acmevendor.Client",
    leaksToday: true,
  },
  {
    name: "apiKey in node -e",
    command: "node -e \"client({apiKey: '{KEY}'}).sync()\"",
    secrets: ["KEY"],
    anchor: "sync()",
    leaksToday: false,
  },
  {
    name: "key as a plain positional argument",
    command: "uploadtool push {KEY} report.pdf",
    secrets: ["KEY"],
    anchor: "uploadtool push",
    leaksToday: true,
  },
  {
    name: "Cloudflare account id in an environment assignment",
    command: "CLOUDFLARE_ACCOUNT_ID={CF} npx wrangler deploy",
    secrets: ["CF"],
    anchor: "wrangler deploy",
    leaksToday: true,
  },
  {
    name: "Cloudflare account id as --account-id",
    command: "wrangler deploy --account-id {CF} --env production",
    secrets: ["CF"],
    anchor: "--env production",
    leaksToday: true,
  },
  {
    name: "Cloudflare account id as a bare wrangler operand",
    command: "npx wrangler kv namespace list {CF}",
    secrets: ["CF"],
    anchor: "kv namespace list",
    leaksToday: true,
  },
  {
    name: "AWS account number as --account",
    command: "aws s3 ls --account {AWS} --region us-east-1",
    secrets: ["AWS"],
    anchor: "--region us-east-1",
    leaksToday: true,
  },
  {
    name: "AWS account number in a slashless ARN",
    command: "aws sns publish --topic-arn arn:aws:sns:us-east-1:{AWS}:alerts --message hi",
    secrets: ["AWS"],
    anchor: "sns publish",
    leaksToday: true,
  },
  {
    name: "AWS account number in an ARN with a slash",
    command: "aws iam get-role --role-arn arn:aws:iam::{AWS}:role/deployer",
    secrets: ["AWS"],
    anchor: "iam get-role",
    leaksToday: false,
  },
  {
    name: "GCP project as --project",
    command: "gcloud run deploy api --project {GCP} --region us-central1",
    secrets: ["GCP"],
    anchor: "run deploy",
    leaksToday: true,
  },
  {
    name: "GCP project as --project=value",
    command: "gsutil ls --project={GCP} gs://",
    secrets: ["GCP"],
    anchor: "gsutil ls",
    leaksToday: true,
  },
  {
    name: "GCP project in an environment assignment",
    command: "GOOGLE_CLOUD_PROJECT={GCP} node deploy.js",
    secrets: ["GCP"],
    anchor: "deploy.js",
    leaksToday: true,
  },
  {
    name: "login in ssh -o User=",
    command: "ssh -o User={LOGIN} build-01 uptime",
    secrets: ["LOGIN"],
    anchor: "uptime",
    leaksToday: true,
  },
  {
    name: "login in user@host",
    command: "ssh {LOGIN}@build-01 uptime -p",
    secrets: ["LOGIN"],
    anchor: "uptime -p",
    leaksToday: false,
  },
  {
    name: "key past the display cap",
    command: `deploycli --note ${"x".repeat(200)} --label ACMEVENDOR_KEY={KEY}`,
    secrets: ["KEY"],
    anchor: "deploycli --note",
    leaksToday: true,
  },
];

const CASES: readonly LeakCase[] = TEMPLATES.map((t, i) => {
  const v = valuesFor(i);
  const fill = (text: string) =>
    text.replace(/\{(KEY|CF|AWS|GCP|LOGIN)\}/g, (_m, k: keyof typeof v) => v[k]);
  return {
    name: t.name,
    command: fill(t.command),
    secrets: t.secrets.map((k) => v[k]),
    anchor: t.anchor,
    leaksToday: t.leaksToday,
  };
});

/** A rule that matches one case through its anchor, so the command reaches the report. */
function ruleFor(index: number, anchor: string): GuardRule {
  return {
    id: `r.leak-${index}`,
    category: "prod-infra",
    severity: "high",
    defaultAction: "warn",
    title: "Regression probe",
    description: "Matches one planted command so its redacted shape reaches the report.",
    match: { any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: [anchor] }] },
  };
}

describe("redactForReport masks every planted secret and identifier", () => {
  it.each(CASES)("$name", ({ command, secrets }) => {
    for (const secret of secrets) {
      // Negative control: the value really is in the input.
      expect(command).toContain(secret);
    }
    const out = redactForReport(command);
    for (const secret of secrets) {
      expect(out).not.toContain(secret);
    }
  });
});

describe("end to end through the HTML and JSON surfaces", () => {
  const catalog = compileCatalog(CASES.map((c, i) => ruleFor(i, c.anchor)));
  const corpus: ScanCorpus = {
    sessions: [
      session([turn(CASES.map((c, i) => toolUse("Bash", { command: c.command }, `leak-${i}`)))]),
    ],
    quarantined: 0,
    notRead: 0,
    projects: 1,
  };
  const result = aggregateScan(corpus, catalog, compileAllowlist([]));
  const html = renderReport(result, META);
  const json = renderJson(result, META);

  it("the report copy still says redaction is not a guarantee, and names the new classes", () => {
    expect(html).toContain("Redaction is thorough but not a guarantee");
    expect(html).toContain("secret:generic");
    expect(html).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(html).toContain("a best guess");
    expect(html).toContain("both are guesses");
  });

  it("every planted command reached a finding", () => {
    expect(result.toolCalls).toBe(CASES.length);
    expect(result.riskyActions).toBe(CASES.length);
  });

  it.each(
    CASES.flatMap((c) => c.secrets.map((s) => [c.name, s] as const)),
  )("%s: the value reaches neither surface", (_name, secret) => {
    expect(html).not.toContain(secret);
    expect(json).not.toContain(secret);
  });
});

describe("kept readable on purpose", () => {
  it.each([
    ["a branch pushed as a plain operand", "git push origin acme-billing-fix"],
    ["a branch created with checkout -b", "git checkout -b acme-billing-fix"],
    ["a bare folder after cd", "cd clientco-app && ls"],
    ["a bare folder as a git -C operand", "git -C clientco-app status"],
    ["a 40-character git sha", "git show 3b8390f6a1c2d4e5f60718293a4b5c6d7e8f9012"],
  ])("%s", (_name, command) => {
    expect(redactForReport(command)).toBe(command);
  });
});
