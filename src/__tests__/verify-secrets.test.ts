// cspell:words devpass Fingerprinter fingerprinters changeme IOSFODNN cret statted lnbm correcthorsebatterystaple
/**
 * The secrets check (`core/verify/secrets.ts`), on synthetic transcripts and a temporary git
 * repo built in the test.
 *
 * Every credential-shaped string is assembled at runtime from parts, never written whole as a
 * source literal: a checked-in credential shape trips secret push-protection even when it is
 * made up, and none of these is real.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFingerprinter } from "../core/verify/fingerprint.js";
import {
  alignValues,
  checkSecrets,
  credentialShaped,
  findValues,
  isLocalDev,
  looksLikePlaceholder,
} from "../core/verify/secrets.js";
import type { SecretsCheck, VerifyIO } from "../core/verify/types.js";
import { UNAVAILABLE_VERIFY_IO } from "../core/verify/verify.js";
import { createRealScanIO } from "../scan-io.js";
import { createRealVerifyIO } from "../verify-io.js";
import { type SessionEvent, writeCorpus } from "./verify-fixtures.js";

// ── Synthetic values, assembled at runtime ──────────────────────────────────────
const GITHUB = `ghp${"_"}Zq8xT2mN4pR7vW1kL9sD3fG6hJ0aB5cE8yU2`;
const AWS_ID = `AKIA${"Q7RZ2M4X8C1V5B3N"}`;
const DEPLOY = `k3Jd9Lq2${"Xw7Vn4Bz"}`;
const SLACK = `xoxb${"-"}4815162342-ZyXwVu98TsRq`;
const FIXTURE = `fx9Hd2Kq7${"Lm3Np8Rs4T"}`;
const LOCAL_URL = `postgres://app:${"devpass771"}@localhost:5432/app`;
const RANDOM_IN_PROMPT = `q8Zr2LmX9vT4kW7n${"B1cD5fH3jP6sY0gA2eR8"}`;
const RANDOM_IN_OUTPUT = `r9Ys3KnW8uS5jV6m${"C2bE4gG1kQ7tX9fB3dT7"}`;

const io = createRealScanIO();
const readLines = (path: string) => io.readLines(path);

/** A temporary git repo with `files` added to its index. */
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agenttrail-verify-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

/** The secrets check over one app's sessions. */
async function check(
  agent: "claude" | "codex" | "cursor",
  sessions: readonly (readonly SessionEvent[])[],
  options: { cwd?: string; io?: VerifyIO } = {},
): Promise<SecretsCheck> {
  const { corpus } = await writeCorpus(agent, sessions, { cwd: options.cwd });
  return checkSecrets({
    agent,
    files: corpus.files ?? [],
    readLines,
    io: options.io ?? createRealVerifyIO(),
    fingerprint: createFingerprinter(),
  });
}

describe("the four classes, from a synthetic corpus and a temporary repo", () => {
  const repo = repoWith({
    "test/fixtures/service.json": JSON.stringify({ SERVICE_TOKEN: FIXTURE }),
    "README.md": "nothing to see",
  });

  const first: SessionEvent[] = [
    { kind: "prompt", text: `use this token: ${GITHUB}` },
    { kind: "prompt", text: `and this one ${RANDOM_IN_PROMPT}` },
    {
      kind: "call",
      command: "cat ~/.aws/credentials",
      result: { text: `aws_access_key_id = ${AWS_ID}` },
    },
    { kind: "call", command: `export DEPLOY_TOKEN=${DEPLOY}`, result: { text: "" } },
    { kind: "reply", text: `The bot token is ${SLACK}.` },
    { kind: "call", command: `SERVICE_TOKEN=${FIXTURE} pnpm test`, result: { text: "ok" } },
    { kind: "call", command: "export API_TOKEN=your-api-token-here", result: { text: "" } },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable reference, as typed
    { kind: "call", command: "export GITHUB_TOKEN=${GITHUB_TOKEN}", result: { text: "" } },
    { kind: "call", command: "env | grep REQ", result: { text: `REQ ${RANDOM_IN_OUTPUT}` } },
    { kind: "call", command: `psql ${LOCAL_URL}`, result: { text: "" } },
  ];
  const second: SessionEvent[] = [{ kind: "prompt", text: `again: ${GITHUB}` }];

  it("sorts every value into exactly one class", async () => {
    const result = await check("claude", [first, second], { cwd: repo });
    expect(result.facts.classes).toEqual({
      "likely-real": 4,
      "committed-fixture": 1,
      placeholder: 4,
      "local-dev": 1,
    });
    // Of the four placeholders, two are random-looking strings with nothing marking them as a
    // credential: one printed by a command, one pasted into a prompt.
    expect(result.facts.setAside).toEqual({ unnamedOutputOnly: 2, namedNotCredentialShaped: 0 });
    expect(result.matches).toBe(10);
    expect(result.status).toBe("act");
    expect(result.facts.fixtureCheck).toBe("complete");
    expect(result.facts.reposChecked).toBe(1);
    expect(result.facts.filesRead).toBe(2);
  });

  it("records how each likely-real value got there and how many files hold it", async () => {
    const result = await check("claude", [first, second], { cwd: repo });
    expect(result.facts.items).toEqual([
      { kind: "github-token", via: ["pasted-into-prompt"], files: 2 },
      { kind: "aws-access-key", via: ["printed-by-command"], files: 1 },
      { kind: "named-token", via: ["typed-into-command"], files: 1 },
      { kind: "slack-bot-token", via: ["in-agent-reply"], files: 1 },
    ]);
    expect(result.facts.moreItems).toBe(0);
  });

  it("without the repo, the fixture stays likely real — never the other way", async () => {
    const result = await check("claude", [first], { io: UNAVAILABLE_VERIFY_IO, cwd: repo });
    expect(result.facts.classes["committed-fixture"]).toBe(0);
    expect(result.facts.classes["likely-real"]).toBe(5);
    expect(result.facts.fixtureCheck).toBe("unavailable");
    expect(result.facts.reposNotChecked).toBe(1);
  });

  it("a value in two ways records both", async () => {
    const result = await check("claude", [
      [
        { kind: "prompt", text: `token ${GITHUB}` },
        { kind: "call", command: `gh auth login --with-token ${GITHUB}`, result: { text: "" } },
      ],
    ]);
    expect(result.facts.items).toEqual([
      { kind: "github-token", via: ["pasted-into-prompt", "typed-into-command"], files: 1 },
    ]);
  });
});

describe("how it got there, for each app", () => {
  const events: SessionEvent[] = [
    { kind: "prompt", text: `here: ${GITHUB}` },
    { kind: "call", command: `export DEPLOY_TOKEN=${DEPLOY}`, result: { text: `id ${AWS_ID}` } },
    { kind: "reply", text: `use ${SLACK}` },
  ];

  it.each([
    ["claude", ["aws-access-key printed-by-command"]],
    ["codex", ["aws-access-key printed-by-command"]],
    // Cursor records no tool output, so nothing can have been printed.
    ["cursor", []],
  ] as const)("%s", async (agent, printed) => {
    const result = await check(agent, [events], { io: UNAVAILABLE_VERIFY_IO });
    const seen = result.facts.items.map((i) => `${i.kind} ${i.via.join(",")}`).sort();
    expect(seen).toEqual(
      [
        "github-token pasted-into-prompt",
        "named-token typed-into-command",
        "slack-bot-token in-agent-reply",
        ...printed,
      ].sort(),
    );
  });

  it("codex: a fixture is found in the repo its session names", async () => {
    const repo = repoWith({ "fixtures/a.env": `SERVICE_TOKEN=${FIXTURE}\n` });
    const result = await check(
      "codex",
      [[{ kind: "call", command: `SERVICE_TOKEN=${FIXTURE} make`, result: { text: "" } }]],
      { cwd: repo },
    );
    expect(result.facts.classes["committed-fixture"]).toBe(1);
    expect(result.status).toBe("clean");
  });
});

describe("states", () => {
  it("no transcript files is not-checked, not clean", async () => {
    const result = await checkSecrets({
      agent: "claude",
      files: [],
      readLines,
      io: UNAVAILABLE_VERIFY_IO,
      fingerprint: createFingerprinter(),
    });
    expect(result.status).toBe("not-checked");
  });

  it("a file that cannot be read keeps a check with nothing found from clean", async () => {
    const { corpus } = await writeCorpus("claude", [[{ kind: "prompt", text: "hello" }]]);
    const result = await checkSecrets({
      agent: "claude",
      files: [...(corpus.files ?? []), "/nonexistent/transcript.jsonl"],
      readLines,
      io: UNAVAILABLE_VERIFY_IO,
      fingerprint: createFingerprinter(),
    });
    expect(result.status).toBe("could-not-check");
    expect(result.facts.filesNotRead).toBe(1);
    expect(result.facts.filesRead).toBe(1);
  });

  it("nothing credential-shaped is clean", async () => {
    const result = await check("claude", [[{ kind: "prompt", text: "rename the button" }]]);
    expect(result.status).toBe("clean");
    expect(result.matches).toBe(0);
    expect(result.facts.fixtureCheck).toBe("not-needed");
  });

  it("only placeholders and local data is clean", async () => {
    const result = await check("claude", [
      [{ kind: "call", command: `psql ${LOCAL_URL}`, result: { text: "" } }],
    ]);
    expect(result.status).toBe("clean");
    expect(result.facts.classes["local-dev"]).toBe(1);
  });
});

describe("the fixture search through the seam", () => {
  const events: SessionEvent[] = [
    { kind: "call", command: `SERVICE_TOKEN=${FIXTURE} make`, result: { text: "" } },
  ];

  /** A seam whose repo answers are scripted. */
  function scripted(answers: {
    top?: Awaited<ReturnType<VerifyIO["git"]>>;
    files?: Awaited<ReturnType<VerifyIO["git"]>>;
    read?: Awaited<ReturnType<VerifyIO["readFile"]>>;
    dir?: boolean;
  }): { io: VerifyIO; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      io: {
        git: (_cwd, args) => {
          calls.push([...args]);
          if (args[0] === "rev-parse") {
            return Promise.resolve(answers.top ?? { ok: true, stdout: "/repo\n" });
          }
          return Promise.resolve(answers.files ?? { ok: true, stdout: "a.txt\0b.txt\0" });
        },
        isDirectory: () => answers.dir ?? true,
        readFile: () => Promise.resolve(answers.read ?? { ok: true, text: "nothing" }),
        processNames: () => Promise.resolve({ ok: false, reason: "missing" }),
      },
    };
  }

  it("never passes a value on a command line", async () => {
    const { io: seam, calls } = scripted({});
    await check("claude", [events], { io: seam, cwd: "/repo" });
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["ls-files", "-z"],
    ]);
    expect(JSON.stringify(calls)).not.toContain(FIXTURE);
  });

  it("a listing that times out is could-not-check for that repo", async () => {
    const { io: seam } = scripted({ files: { ok: false, reason: "timeout" } });
    const result = await check("claude", [events], { io: seam, cwd: "/repo" });
    expect(result.facts.fixtureCheck).toBe("unavailable");
    expect(result.facts.reposNotChecked).toBe(1);
    expect(result.facts.classes["likely-real"]).toBe(1);
  });

  it("a budget that runs out mid-repo leaves the repo unchecked", async () => {
    const { io: seam } = scripted({ read: { ok: false, reason: "budget" } });
    const result = await check("claude", [events], { io: seam, cwd: "/repo" });
    expect(result.facts.reposNotChecked).toBe(1);
  });

  it("a folder that is not in a repo is not a failure", async () => {
    const { io: seam } = scripted({ top: { ok: false, reason: "not-a-repo" } });
    const result = await check("claude", [events], { io: seam, cwd: "/repo" });
    expect(result.facts.reposNotChecked).toBe(0);
    expect(result.facts.fixtureCheck).toBe("unavailable");
  });

  it("a working directory that is gone is a repo that could not be checked", async () => {
    const { io: seam } = scripted({ dir: false });
    const result = await check("claude", [events], { io: seam, cwd: "/gone/repo" });
    expect(result.facts.reposNotChecked).toBe(1);
  });

  it("a gone working directory whose parent is there but is no repo still could not be checked", async () => {
    const calls: string[][] = [];
    const seam: VerifyIO = {
      ...scripted({}).io,
      isDirectory: (path) => path === "/projects",
      git: (cwd, args) => {
        calls.push([cwd, ...args]);
        return Promise.resolve({ ok: false, reason: "not-a-repo" });
      },
    };
    const result = await check("claude", [events], { io: seam, cwd: "/projects/deleted-app" });
    expect(calls).toEqual([["/projects", "rev-parse", "--show-toplevel"]]);
    expect(result.facts.reposNotChecked).toBe(1);
    expect(result.facts.fixtureCheck).toBe("unavailable");
  });

  it.each([
    "//host/share/app",
    "\\\\host\\share\\app",
    "/net/host/app",
  ])("a working directory on a network path %s is never statted or run in", async (cwd) => {
    const touched: string[] = [];
    const seam: VerifyIO = {
      ...scripted({}).io,
      isDirectory: (path) => {
        touched.push(path);
        return true;
      },
      git: (dir) => {
        touched.push(dir);
        return Promise.resolve({ ok: true, stdout: "/repo\n" });
      },
    };
    const result = await check("claude", [events], { io: seam, cwd });
    expect(touched).toEqual([]);
    expect(result.facts.reposNotChecked).toBe(1);
  });

  it("a binary file is skipped, and a file holding the value marks it a fixture", async () => {
    const reads = [
      { ok: true as const, text: `\0${FIXTURE}` },
      { ok: true as const, text: `x ${FIXTURE} y` },
    ];
    const seam: VerifyIO = {
      ...scripted({}).io,
      readFile: () => Promise.resolve(reads.shift() ?? { ok: false, reason: "missing" }),
    };
    const result = await check("claude", [events], { io: seam, cwd: "/repo" });
    expect(result.facts.classes["committed-fixture"]).toBe(1);
  });

  it("a binary file that holds the value does not make it a fixture", async () => {
    const seam: VerifyIO = {
      ...scripted({}).io,
      readFile: () => Promise.resolve({ ok: true, text: `\0${FIXTURE}` }),
    };
    const result = await check("claude", [events], { io: seam, cwd: "/repo" });
    expect(result.facts.classes["committed-fixture"]).toBe(0);
    expect(result.facts.classes["likely-real"]).toBe(1);
    expect(result.facts.fixtureCheck).toBe("complete");
  });

  it("a token value must stand as a whole token; one glued inside a longer token is not it", async () => {
    const reads = [`prefix${FIXTURE}suffix`, `{"SERVICE_TOKEN":"${FIXTURE}"}`];
    let read = 0;
    const seam: VerifyIO = {
      ...scripted({ files: { ok: true, stdout: "a\0b\0" } }).io,
      readFile: () => Promise.resolve({ ok: true, text: reads[read++] ?? "" }),
    };
    const result = await check("claude", [events], { io: seam, cwd: "/repo" });
    expect(read).toBe(2);
    expect(result.facts.classes["committed-fixture"]).toBe(1);

    const gluedOnly: VerifyIO = {
      ...scripted({}).io,
      readFile: () => Promise.resolve({ ok: true, text: `prefix${FIXTURE}suffix` }),
    };
    const glued = await check("claude", [events], { io: gluedOnly, cwd: "/repo" });
    expect(glued.facts.classes["committed-fixture"]).toBe(0);
  });

  it("a value with separators in it is searched as a substring", async () => {
    const jwt = [{ alg: "HS256" }, { sub: "1" }, "signature0"]
      .map((part) =>
        Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url"),
      )
      .join(".");
    const seam: VerifyIO = {
      ...scripted({}).io,
      readFile: () => Promise.resolve({ ok: true, text: `const token = "${jwt}";` }),
    };
    const result = await check(
      "claude",
      [[{ kind: "call", command: `curl -H "x-session: ${jwt}" api`, result: { text: "" } }]],
      { io: seam, cwd: "/repo" },
    );
    expect(result.facts.classes["committed-fixture"]).toBe(1);
  });

  it("the search's own time is charged, and when the budget runs out the rest is not checked", async () => {
    // Two repos, two files each. The value is only in the second file of the first repo.
    const { corpus: first } = await writeCorpus("claude", [events], { cwd: "/r1" });
    const { corpus: second } = await writeCorpus("claude", [events], { cwd: "/r2" });
    const gitCalls: string[][] = [];
    const charges: number[] = [];
    const reads: string[] = [];
    let clock = 0;
    const seam: VerifyIO = {
      git: (cwd, args) => {
        gitCalls.push([cwd, ...args]);
        if (args[0] === "rev-parse") return Promise.resolve({ ok: true, stdout: `${cwd}\n` });
        return Promise.resolve({ ok: true, stdout: "one\0two\0" });
      },
      isDirectory: () => true,
      readFile: (path) => {
        reads.push(path);
        return Promise.resolve({ ok: true, text: path.endsWith("two") ? FIXTURE : "nothing" });
      },
      processNames: () => Promise.resolve({ ok: false, reason: "missing" }),
      charge: (ms) => {
        charges.push(ms);
        return false;
      },
    };
    const result = await checkSecrets({
      agent: "claude",
      files: [...(first.files ?? []), ...(second.files ?? [])],
      readLines,
      io: seam,
      fingerprint: createFingerprinter(),
      now: () => {
        clock += 7;
        return clock;
      },
    });
    expect(charges).toEqual([7]);
    expect(reads).toEqual(["/r1/one"]);
    expect(gitCalls.filter((c) => c[1] === "ls-files")).toEqual([["/r1", "ls-files", "-z"]]);
    expect(result.facts.classes["committed-fixture"]).toBe(0);
    expect(result.facts.classes["likely-real"]).toBe(1);
    expect(result.facts.reposNotChecked).toBe(2);
    expect(result.facts.fixtureCheck).toBe("unavailable");
  });

  it("a budget that is spent on the listing stops the search too", async () => {
    const seam: VerifyIO = {
      ...scripted({ files: { ok: false, reason: "budget" } }).io,
    };
    const result = await check("claude", [events], { io: seam, cwd: "/repo" });
    expect(result.facts.reposNotChecked).toBe(1);
    expect(result.facts.fixtureCheck).toBe("unavailable");
  });

  it("the real seam charges the search and says when the budget is gone", () => {
    const seam = createRealVerifyIO({ totalBudgetMs: 10 });
    expect(seam.charge?.(4)).toBe(true);
    expect(seam.charge?.(6)).toBe(false);
  });
});

describe("finding values", () => {
  it("recovers each value and its kind, and nothing else of the text", () => {
    const found = findValues(`a ${GITHUB} b AWS=${AWS_ID} c`);
    expect(found.values.map((v) => [v.kind, v.value])).toEqual([
      ["github-token", GITHUB],
      ["aws-access-key", AWS_ID],
    ]);
    expect(found.unaligned).toBe(false);
  });

  it("ignores personal data the report also redacts, which is not a credential", () => {
    expect(findValues("mail priya@example.org").values).toEqual([]);
  });

  it("a text with nothing in it gives nothing", () => {
    expect(findValues("plain words")).toEqual({ values: [], unaligned: false });
  });

  it("drops the scrubber's private sentinel character before looking", () => {
    const sentinel = String.fromCharCode(0xe000);
    const found = findValues(`x${sentinel} ${GITHUB}`);
    expect(found.values.map((v) => v.value)).toEqual([GITHUB]);
  });

  it("aligns placeholders separated by literal text", () => {
    expect(alignValues("A1xB22y", ["A", "x", "y"])).toEqual([
      [1, 2],
      [3, 6],
    ]);
  });

  it("lets a value contain the literal that follows it, when the rest still lines up", () => {
    // The literal after the first value is "X", and the second value must not be empty.
    expect(alignValues("aXbXc", ["", "X", ""])).toEqual([
      [0, 1],
      [2, 5],
    ]);
    expect(alignValues("aXYb", ["", "X", "Y", ""])).toBeUndefined();
  });

  it("keeps the context after a value, for reading a URL's host", () => {
    const url = `https://u:${DEPLOY}@localhost:8080/x`;
    const [found] = findValues(`curl ${url}`).values;
    expect(found?.kind).toBe("url-credentials");
    expect(found?.after.startsWith("@localhost")).toBe(true);
  });

  it("gives up on text that cannot be lined up", () => {
    expect(alignValues("abc", ["x", "c"])).toBeUndefined();
    expect(alignValues("abc", ["a", "c"])).toEqual([[1, 2]]);
    expect(alignValues("ac", ["a", "c"])).toBeUndefined();
  });
});

describe("placeholder and local dev classing", () => {
  const as = (
    value: string,
    kind: "named-secret" | "database-url" | "url-credentials" = "named-secret",
    after = "",
  ) => ({
    value,
    kind,
    after,
  });

  it.each([
    "your-api-key-here",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable reference, as typed
    "${API_KEY}",
    "$API_KEY",
    "<token>",
    "changeme",
    "xxxxxxxxxxxx",
    "password",
    "aaaaaaaaaa",
    `AKIA${"IOSFODNN7EXAMPLE"}`,
    "sk-...",
    "process.env.TOKEN",
  ])("%s is a placeholder", (value) => {
    expect(looksLikePlaceholder(as(value))).toBe(true);
  });

  it.each([DEPLOY, FIXTURE, GITHUB])("%s is not", (value) => {
    expect(looksLikePlaceholder(as(value))).toBe(false);
  });

  it("a database URL on localhost is local dev data; one on another host is not", () => {
    expect(isLocalDev(as(LOCAL_URL, "database-url"))).toBe(true);
    expect(isLocalDev(as(`postgres://a:${DEPLOY}@127.0.0.1`, "database-url"))).toBe(true);
    expect(isLocalDev(as(`postgres://a:${DEPLOY}@host.docker.internal`, "database-url"))).toBe(
      true,
    );
    expect(isLocalDev(as(`postgres://a:${DEPLOY}@db.internal`, "database-url"))).toBe(false);
    expect(isLocalDev(as(`postgres://a:${DEPLOY}@db`, "database-url"))).toBe(false);
  });

  it("an IPv6 loopback in brackets is local dev data", () => {
    // The redaction stops the host at the first ":", so the bracket is read from what follows.
    expect(isLocalDev(as(`postgres://a:${DEPLOY}@[`, "database-url", "::1]:5432/app"))).toBe(true);
    expect(isLocalDev(as(`u:${DEPLOY}`, "url-credentials", "@[::1]:8080/x"))).toBe(true);
    expect(isLocalDev(as(`postgres://a:${DEPLOY}@[`, "database-url", "2001:db8::7]:5432"))).toBe(
      false,
    );
  });

  it("finds an IPv6 loopback database URL in text as local dev data", async () => {
    const result = await check("claude", [
      [
        {
          kind: "call",
          command: `psql postgres://app:${DEPLOY}@[::1]:5432/app`,
          result: { text: "" },
        },
      ],
    ]);
    expect(result.facts.classes["local-dev"]).toBe(1);
    expect(result.facts.classes["likely-real"]).toBe(0);
  });

  it("the placeholder test reads the secret, not the host — except a host reserved for examples", () => {
    expect(
      looksLikePlaceholder(as(`postgres://a:${DEPLOY}@prod.sample-corp.io`, "database-url")),
    ).toBe(false);
    expect(looksLikePlaceholder(as(`postgres://a:${DEPLOY}@db.example.com`, "database-url"))).toBe(
      true,
    );
    expect(looksLikePlaceholder(as(`u:${DEPLOY}`, "url-credentials", "@api.example/x"))).toBe(true);
    expect(looksLikePlaceholder(as(`postgres://a:${DEPLOY}@ci.test`, "database-url"))).toBe(true);
    expect(looksLikePlaceholder(as(`postgres://a:changeme@db.prod.io`, "database-url"))).toBe(true);
  });

  it("a URL credential reads its host from what follows it", () => {
    expect(isLocalDev(as(`u:${DEPLOY}`, "url-credentials", "@localhost:8080/x"))).toBe(true);
    expect(isLocalDev(as(`u:${DEPLOY}`, "url-credentials", "@api.vendor.dev/x"))).toBe(false);
    expect(isLocalDev(as(DEPLOY))).toBe(false);
  });
});

describe("the fingerprint", () => {
  it("is stable within a run, differs across runs, and is never the value", () => {
    const run = createFingerprinter();
    expect(run(GITHUB)).toBe(run(GITHUB));
    expect(run(GITHUB)).not.toBe(createFingerprinter()(GITHUB));
    expect(run(GITHUB)).not.toContain(GITHUB.slice(4, 12));
    expect(run(GITHUB)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("two fingerprinters under one key agree, and a reused buffer cannot change it", () => {
    const key = new Uint8Array(32).fill(7);
    const a = createFingerprinter(key);
    const before = a(DEPLOY);
    key.fill(9);
    expect(a(DEPLOY)).toBe(before);
    expect(createFingerprinter(new Uint8Array(32).fill(7))(DEPLOY)).toBe(before);
  });
});

describe("a value found by its name must look like a credential itself", () => {
  it.each([
    "count(usage.output_tokens)",
    "result.tokens",
    "boolean",
    "EMPTY_TOKEN_TOTALS",
    "agenttrail-report-theme",
    "/-----BEGIN",
    "./secrets/dev.pem",
    "~/.ssh/id_ed25519",
    "S3cret",
    "string):",
  ])("%s is not", (value) => {
    expect(credentialShaped(value)).toBe(false);
  });

  it.each([DEPLOY, FIXTURE, "hunter2!xyz", "pa55-w0rd-77"])("%s is", (value) => {
    expect(credentialShaped(value)).toBe(true);
  });

  it("source code read by a command is a false positive, not a credential", async () => {
    const code = [
      "const secret = getSecret();",
      'const config = { token: "auth", password: string };',
      "export const API_KEY = process.env.API_KEY;",
      "tokens: count(usage.output_tokens),",
    ].join("\n");
    const result = await check("claude", [
      [{ kind: "call", command: "cat src/config.ts", result: { text: code } }],
    ]);
    expect(result.facts.classes["likely-real"]).toBe(0);
    expect(result.status).toBe("clean");
  });

  it("a format with its own shape needs no such test", () => {
    expect(looksLikePlaceholder({ value: GITHUB, kind: "github-token", after: "" })).toBe(false);
  });
});

describe("limits", () => {
  it("past the held-value cap a value is still classed, and the fixture test says it was incomplete", async () => {
    const { corpus } = await writeCorpus("claude", [
      [
        { kind: "prompt", text: `one ${GITHUB}` },
        { kind: "call", command: `export DEPLOY_TOKEN=${DEPLOY}`, result: { text: "" } },
        // An unnamed random string seen only in output stays a false positive past the cap.
        { kind: "call", command: "env", result: { text: `id ${RANDOM_IN_OUTPUT}` } },
      ],
    ]);
    const result = await checkSecrets({
      agent: "claude",
      files: corpus.files ?? [],
      readLines,
      io: UNAVAILABLE_VERIFY_IO,
      fingerprint: createFingerprinter(),
      maxHeldValues: 1,
    });
    expect(result.facts.classes).toEqual({
      "likely-real": 2,
      "committed-fixture": 0,
      placeholder: 1,
      "local-dev": 0,
    });
    expect(result.facts.fixtureCheck).toBe("unavailable");
  });

  it("past the cap, a repo that was searched makes the fixture test partial", async () => {
    const repo = repoWith({ "x.txt": "nothing" });
    const { corpus } = await writeCorpus(
      "claude",
      [[{ kind: "prompt", text: `${GITHUB} and ${AWS_ID}` }]],
      { cwd: repo },
    );
    const result = await checkSecrets({
      agent: "claude",
      files: corpus.files ?? [],
      readLines,
      io: createRealVerifyIO(),
      fingerprint: createFingerprinter(),
      maxHeldValues: 1,
    });
    expect(result.facts.fixtureCheck).toBe("partial");
    expect(result.facts.classes["likely-real"]).toBe(2);
  });

  it("a long output repeated across files is read once and still counted per file", async () => {
    const filler = "x ".repeat(400);
    const withValue = `${filler} AWS=${AWS_ID}`;
    const result = await check("claude", [
      [
        { kind: "call", command: "a", result: { text: filler } },
        { kind: "call", command: "b", result: { text: withValue } },
      ],
      [
        { kind: "call", command: "a", result: { text: filler } },
        { kind: "call", command: "b", result: { text: withValue } },
      ],
    ]);
    expect(result.facts.items).toEqual([
      { kind: "aws-access-key", via: ["printed-by-command"], files: 2 },
    ]);
  });
});

describe("what was set aside is counted, not dropped", () => {
  it("counts unnamed output-only strings and named values that are not credential-shaped", async () => {
    const result = await check("claude", [
      [
        { kind: "call", command: "env", result: { text: `id ${RANDOM_IN_OUTPUT}` } },
        { kind: "reply", text: `request ${RANDOM_IN_PROMPT}` },
        {
          kind: "call",
          command: "export DB_PASSWORD=correcthorsebatterystaple",
          result: { text: "" },
        },
        { kind: "call", command: "export API_TOKEN=your-api-token-here", result: { text: "" } },
      ],
    ]);
    expect(result.facts.classes.placeholder).toBe(4);
    // `your-api-token-here` is a plain stand-in and is not among the set-aside values.
    expect(result.facts.setAside).toEqual({ unnamedOutputOnly: 2, namedNotCredentialShaped: 1 });
    expect(result.status).toBe("clean");
  });

  it("a value set aside in output is likely real once a credential's name is seen with it", async () => {
    const result = await check("claude", [
      [
        { kind: "call", command: "env", result: { text: `id ${RANDOM_IN_OUTPUT}` } },
        {
          kind: "call",
          command: `curl -H "X-Api-Key: ${RANDOM_IN_OUTPUT}" api`,
          result: { text: "" },
        },
      ],
    ]);
    expect(result.facts.setAside.unnamedOutputOnly).toBe(0);
    expect(result.facts.classes["likely-real"]).toBe(1);
  });
});

describe("a text whose values cannot be recovered is never clean", () => {
  it("unplaced > 0 with nothing else found is could-not-check", async () => {
    // More placeholders in one text than the alignment search will step through.
    const keys = Array.from({ length: 6_000 }, (_, i) => `AKIA${String(i).padStart(16, "0")}`);
    const result = await check("claude", [[{ kind: "prompt", text: keys.join(" ") }]]);
    expect(result.facts.unplaced).toBe(1);
    expect(result.facts.classes["likely-real"]).toBe(0);
    expect(result.status).toBe("could-not-check");
  });
});
