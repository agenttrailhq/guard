// cspell:words kubectl kubeconfig apiserver doas ionice setsid caffeinate mywrap
/**
 * The production infrastructure check (`core/verify/prod-infra.ts`): database targets classed
 * "other", taken as counts per class (synthetic here; the destructive-commands check supplies
 * them), and production guardrail matches that ran.
 */

import { describe, expect, it } from "vitest";
import { compileCatalog } from "../core/rules.js";
import { readCalls } from "../core/verify/calls.js";
import {
  checkProdInfra,
  type DatabaseTargetCounts,
  type ProdInfraFacts,
  prodInfraCard,
  prodInfraStatus,
  targetsOnlyThisMachine,
} from "../core/verify/prod-infra.js";
import { UNAVAILABLE_VERIFY_IO, verifyScan } from "../core/verify/verify.js";
import {
  type CommandEvent,
  callsOf,
  OK,
  SHIPPED,
  writeCommandCorpus,
} from "./verify-command-fixtures.js";
import { writeCorpus } from "./verify-fixtures.js";

const DELETE = `kubectl delete ${"deployment"} web -n staging`;
const DEPLOY = "vercel deploy --prod";

/** A session with nothing in it but a prompt. */
const QUIET: CommandEvent[] = [{ kind: "prompt", text: "hello" }];

async function prod(
  events: readonly CommandEvent[],
  databaseTargets: DatabaseTargetCounts | undefined,
  agent: "claude" | "codex" | "cursor" = "claude",
) {
  return checkProdInfra({ calls: await callsOf(agent, [events]), ...SHIPPED, databaseTargets });
}

describe("database targets, from the counts passed in", () => {
  it("targets classed other are review, and the chip counts them", async () => {
    const check = await prod(QUIET, { local: 2, scratch: 1, other: 3 });
    expect(check.status).toBe("review");
    expect(check.facts).toMatchObject({
      databaseCheck: "checked",
      databaseTargets: { local: 2, scratch: 1, other: 3 },
      infraMatches: 0,
    });
    const card = prodInfraCard(check, { ranEvidence: "tool-result" }) as ReturnType<
      typeof prodInfraCard
    > & {
      chip?: { count: number; label: { text: string } };
    };
    expect(card.chip?.count).toBe(3);
    expect(card.chip?.label.text).toBe("production databases touched");
    expect(card.found.map((s) => s.template)).toEqual([
      "prod.databases",
      "prod.databases-local",
      "prod.infra-none",
    ]);
  });

  it("a target that could not be resolved is never local: unconfirmed, and never clean", async () => {
    const check = checkProdInfra({
      calls: await callsOf("claude", [QUIET]),
      ...SHIPPED,
      databaseTargets: { local: 4, scratch: 0, other: 0 },
      databaseTargetsUnresolved: 2,
    });
    expect(check.facts.unconfirmed).toBe(2);
    expect(check.facts.databaseTargets).toEqual({ local: 4, scratch: 0, other: 0 });
    expect(check.status).not.toBe("clean");
  });

  it("scan wiring: the destructive-commands check's database classes reach this check", async () => {
    // A database command to a host off this machine, and one whose host is a variable.
    const remote = ["psql -h db.example.com -c ", '"', "DROP TABLE t", '"'].join("");
    const variable = ["psql -h ", '"', "$DB_HOST", '"', " -c ", '"', "DROP TABLE t", '"'].join("");
    for (const [command, other, unconfirmed] of [
      [remote, 1, 0],
      [variable, 0, 1],
    ] as const) {
      const { corpus } = await writeCorpus("claude", [
        [{ kind: "call", command, result: { text: "" } }],
      ]);
      const outcome = await verifyScan({
        corpus,
        ...SHIPPED,
        readLines: () => (async function* () {})(),
        io: UNAVAILABLE_VERIFY_IO,
      });
      const prodInfra = outcome.verification.categories["prod-infra"];
      if (!("facts" in prodInfra)) throw new Error("no facts");
      expect(prodInfra.facts.databaseCheck, command).toBe("checked");
      expect(prodInfra.facts.databaseTargets.other, command).toBe(other);
      expect(prodInfra.facts.unconfirmed, command).toBeGreaterThanOrEqual(unconfirmed);
      expect(prodInfra.status, command).not.toBe("clean");
    }
  });

  it("only local and scratch targets, and no infra match: clean, with a zero chip", async () => {
    const check = await prod(QUIET, { local: 4, scratch: 2, other: 0 });
    expect(check.status).toBe("clean");
    const card = prodInfraCard(check, { ranEvidence: "tool-result" }) as {
      chip?: { count: number };
    };
    expect(card.chip?.count).toBe(0);
  });

  it("no counts passed in: never clean", async () => {
    const check = await prod(QUIET, undefined);
    expect(check.facts.databaseCheck).toBe("not-available");
    expect(check.facts.databaseTargets).toEqual({ local: 0, scratch: 0, other: 0 });
    expect(check.status).toBe("could-not-check");
    expect(prodInfraCard(check, { ranEvidence: "tool-result" }).found.map((s) => s.text)).toContain(
      "Database targets could not be checked, so this is not a clean result.",
    );
  });
});

describe("production guardrail matches that ran", () => {
  it("commands and edits that ran are counted by kind", async () => {
    const check = await prod(
      [
        { kind: "shell", command: DELETE, result: OK },
        { kind: "shell", command: DEPLOY, result: OK },
        {
          kind: "edit",
          path: "/p/config/prod/app.yaml",
          old: "replicas: 3",
          new: "replicas: 1",
          result: OK,
        },
        { kind: "shell", command: "kubectl get pods", result: OK },
      ],
      { local: 0, scratch: 0, other: 0 },
    );
    expect(check.facts).toMatchObject({
      infraMatches: 3,
      infraKinds: ["kubernetes", "deploy", "prod-config"],
    });
    expect(check.status).toBe("review");
    expect(check.matches).toBe(3);
  });

  it.each([
    `kubectl --context kind-local delete ${"namespace"} scratch`,
    `kubectl delete ${"deployment"} web --context=minikube`,
    `helm uninstall web --kube-context docker-desktop`,
    `kubectl --context k3d-dev delete ${"pod"} x`,
  ])("a local cluster is not production: %s", async (command) => {
    const check = await prod([{ kind: "shell", command, result: OK }], {
      local: 0,
      scratch: 0,
      other: 0,
    });
    expect(check.facts).toMatchObject({ infraMatches: 0, localInfra: 1 });
    expect(check.status).toBe("clean");
    const found = prodInfraCard(check, { ranEvidence: "tool-result" }).found.map((s) => s.text);
    // The two lines agree: the local match is named, and the none line says "other".
    expect(found).toEqual([
      "No database command that ran targeted a database beyond local and scratch ones.",
      "1 match targeted this machine (a local Kubernetes cluster or LocalStack) and is not counted.",
      "No other command or edit that ran matched a production infrastructure guardrail.",
    ]);
  });

  it("with no local match, the none line has no 'other'", async () => {
    const check = await prod(QUIET, { local: 0, scratch: 0, other: 0 });
    expect(prodInfraCard(check, { ranEvidence: "tool-result" }).found.map((s) => s.text)).toContain(
      "No command or edit that ran matched a production infrastructure guardrail.",
    );
  });

  it.each([
    `kubectl delete ${"deployment"} web`,
    `kubectl --context prod-eu delete ${"deployment"} web`,
    `kubectl --context kind-local get pods && kubectl --context prod delete ${"pod"} x`,
    // A local context name with something that points it at another cluster.
    `kubectl --context kind-local --server https://prod.example.invalid delete ${"pod"} x`,
    `kubectl --context kind-local -s https://prod.example.invalid delete ${"pod"} x`,
    `kubectl --context=kind-local --server=https://prod.example.invalid delete ${"pod"} x`,
    `kubectl --context kind-local --kubeconfig /etc/prod.yaml delete ${"pod"} x`,
    `kubectl --context kind-local --cluster prod delete ${"pod"} x`,
    `KUBECONFIG=/etc/prod.yaml kubectl --context kind-local delete ${"pod"} x`,
    `export KUBECONFIG=/etc/prod.yaml; kubectl --context kind-local delete ${"pod"} x`,
    `helm uninstall web --kube-context docker-desktop --kube-apiserver https://prod.example.invalid`,
    `helm uninstall web --kube-context docker-desktop --kubeconfig /etc/prod.yaml`,
  ])("a production or unnamed context still counts: %s", async (command) => {
    const check = await prod([{ kind: "shell", command, result: OK }], {
      local: 0,
      scratch: 0,
      other: 0,
    });
    expect(check.facts).toMatchObject({ infraMatches: 1, localInfra: 0 });
    expect(check.status).toBe("review");
  });

  // A local cluster first, then a production delete behind a word before it. The first command
  // must not set the call aside as local.
  const PROD = `kubectl --context prod-cluster delete ${"deployment"} web`;
  const LOCAL_FIRST = "kubectl --context kind-dev get pods && ";

  it.each([
    ["sudo --user root", `sudo --user root ${PROD}`],
    ["sudo --chdir /tmp", `sudo --chdir /tmp ${PROD}`],
    ["nice --adjustment 5", `nice --adjustment 5 ${PROD}`],
    ["doas", `doas ${PROD}`],
    ["ionice -c3", `ionice -c3 ${PROD}`],
    ["setsid", `setsid ${PROD}`],
    ["caffeinate -i", `caffeinate -i ${PROD}`],
    ["npx --yes", `npx --yes ${PROD}`],
    ["env -S", `env -S '${PROD}'`],
    ["env --split-string", `env --split-string='${PROD}'`],
    ["su -c", `su root -c '${PROD}'`],
    ["script -qc", `script -qc '${PROD}' /dev/null`],
    ["flock -c", `flock /tmp/x.lock -c '${PROD}'`],
    ["watch", `watch -n 1 '${PROD}'`],
    ["an unknown wrapper", `mywrap ${PROD}`],
    ["an unknown wrapper with a value", `mywrap --as root ${PROD}`],
  ])("after a local command, %s: counted, never set aside as local", async (_label, rest) => {
    const command = `${LOCAL_FIRST}${rest}`;
    expect(targetsOnlyThisMachine(command)).toBe(false);
    const check = await prod([{ kind: "shell", command, result: OK }], {
      local: 0,
      scratch: 0,
      other: 0,
    });
    expect(check.facts.localInfra, command).toBe(0);
    expect(check.status, command).not.toBe("clean");
  });

  it("the worst case: a local get, then sudo --user root against production, is review", async () => {
    const command = `${LOCAL_FIRST}sudo --user root ${PROD}`;
    const check = await prod([{ kind: "shell", command, result: OK }], {
      local: 0,
      scratch: 0,
      other: 0,
    });
    expect(check.facts).toMatchObject({
      infraMatches: 1,
      localInfra: 0,
      infraKinds: ["kubernetes"],
    });
    expect(check.status).toBe("review");
  });

  it("fails closed: any program it does not read, or a hiding form, is not local", () => {
    const local = `kubectl --context kind-dev delete ${"pod"} x`;
    expect(targetsOnlyThisMachine(local)).toBe(true);
    expect(targetsOnlyThisMachine(`cd deploy && FOO=1 && ${local}`)).toBe(true);
    expect(targetsOnlyThisMachine(`${local} | grep deleted`)).toBe(true);
    expect(targetsOnlyThisMachine(`make deploy && ${local}`)).toBe(false);
    expect(targetsOnlyThisMachine(`${local} && terraform apply`)).toBe(false);
    expect(targetsOnlyThisMachine(`${local} $(cat more)`)).toBe(false);
    expect(targetsOnlyThisMachine(`${local}; echo 'open`)).toBe(false);
    expect(targetsOnlyThisMachine(`${local} && bash -c 'kubectl delete ${"pod"} y'`)).toBe(false);
  });

  it("an AWS call is local only when every endpoint it names is this machine", () => {
    const ec2 = "aws ec2 terminate-instances --instance-ids i-1";
    expect(targetsOnlyThisMachine(`${ec2} --endpoint-url http://localhost:4566`)).toBe(true);
    expect(
      targetsOnlyThisMachine(
        `${ec2} --endpoint-url http://localhost:4566 --endpoint-url https://ec2.example.invalid`,
      ),
    ).toBe(false);
    expect(
      targetsOnlyThisMachine(
        `aws --endpoint-url=https://ec2.example.invalid ec2 terminate-instances --instance-ids i-1 --endpoint-url http://localhost:4566`,
      ),
    ).toBe(false);
    expect(targetsOnlyThisMachine(ec2)).toBe(false);
  });

  it("only mentioned, or unconfirmed, is not counted", async () => {
    const check = await prod(
      [
        { kind: "shell", command: `cat > runbook.md <<EOF\n${DELETE}\nEOF`, result: OK },
        { kind: "shell", command: DELETE },
      ],
      { local: 0, scratch: 0, other: 0 },
    );
    expect(check.facts).toMatchObject({ infraMatches: 0, mentioned: 1, unconfirmed: 1 });
    expect(check.status).toBe("could-not-check");
  });

  it("Cursor: nothing confirmed, so not clean", async () => {
    const check = await prod(
      [{ kind: "shell", command: DELETE }],
      { local: 0, scratch: 0, other: 0 },
      "cursor",
    );
    expect(check.status).toBe("could-not-check");
  });

  it("Codex: counted, and the card carries the Codex caveat", async () => {
    const check = await prod(
      [{ kind: "shell", command: DELETE, result: OK }],
      { local: 0, scratch: 0, other: 0 },
      "codex",
    );
    expect(check.facts.infraMatches).toBe(1);
    expect(prodInfraCard(check, { ranEvidence: "output-record" }).codexCaveat).toBe(true);
  });

  it("a guardrail you added in the production category counts, as your own", async () => {
    const catalog = compileCatalog([
      {
        id: "my.prod-db",
        category: "prod-infra",
        severity: "high",
        defaultAction: "require_approval",
        title: "My production database",
        description: "Matches the production database host.",
        match: { any_of: [{ kind: "execute_tool", detail_contains: ["zebra-prod-db"] }] },
      },
    ]);
    const { corpus } = await writeCommandCorpus("claude", [
      [{ kind: "shell", command: "psql -h zebra-prod-db -c 'select 1'", result: OK }],
    ]);
    const check = checkProdInfra({
      calls: readCalls(corpus, catalog, SHIPPED.allowlist),
      catalog,
      allowlist: SHIPPED.allowlist,
      databaseTargets: { local: 0, scratch: 0, other: 0 },
    });
    expect(check.facts.infraMatches).toBe(1);
    expect(check.facts.infraKinds).toEqual(["other"]);
  });
});

describe("the tone", () => {
  const base: ProdInfraFacts = {
    databaseTargets: { local: 0, scratch: 0, other: 0 },
    databaseCheck: "checked",
    infraMatches: 0,
    infraKinds: [],
    localInfra: 0,
    mentioned: 0,
    unconfirmed: 0,
    couldHide: 0,
    hidingForms: [],
  };
  it.each([
    [{ databaseTargets: { local: 0, scratch: 0, other: 1 } }, "review"],
    [{ infraMatches: 1 }, "review"],
    [{ infraMatches: 1, databaseCheck: "not-available" }, "review"],
    [{ databaseCheck: "not-available" }, "could-not-check"],
    [{ unconfirmed: 1 }, "could-not-check"],
    [{ mentioned: 2 }, "clean"],
    [{ couldHide: 1 }, "could-not-check"],
    [{ localInfra: 2 }, "clean"],
    [{}, "clean"],
  ] as const)("%j is %s", (over, tone) => {
    expect(prodInfraStatus({ ...base, ...over } as ProdInfraFacts)).toBe(tone);
  });
});
