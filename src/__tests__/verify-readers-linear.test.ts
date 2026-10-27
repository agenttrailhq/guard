// cspell:words procsubs
/**
 * Every reader of a command's text stays linear in its length. A transcript can hold one very
 * long command, and a reader that is quadratic or worse on it would stall the whole scan.
 *
 * Each reader gets each 100,000-character input below once. The ceiling is far above what a
 * linear reading takes (a few milliseconds to a few tens), and far below what a quadratic one
 * takes on the same input (tens of seconds), so it holds under load and still fails on any
 * super-linear reader. The shapes include the ones that were not linear: many simple commands
 * that each write a file, a long pipeline, many lines, and long runs of blanks.
 */
import { describe, expect, it } from "vitest";
import { patchEdits, programAndArgs, simpleCommands } from "../core/verify/calls.js";
import { localFixCommand } from "../core/verify/cards.js";
import { readCloud } from "../core/verify/cloud.js";
import { readInstalls } from "../core/verify/deps.js";
import { readEgress, tunnelProgramOf } from "../core/verify/egress.js";
import { bareHost, endpointsLocal, hostOf, isLocalHost } from "../core/verify/hosts.js";
import { targetsOnlyThisMachine } from "../core/verify/prod-infra.js";
import { commandHidingForms, executedView } from "../core/verify/ran.js";
import {
  addsExclude,
  changesFilesUnread,
  deletedTestPaths,
  isCiFile,
  isTestConfig,
  isTestPath,
  lowersThreshold,
  namesAsFailing,
  shellWrittenPaths,
} from "../core/verify/tests.js";
import { pushedRefs, readPushes } from "../core/verify/unreviewed.js";
import { isAllowedGitCall } from "../verify-io.js";
import { fixText } from "./verify-command-fixtures.js";

/** The longest one reading of a 100,000-character input may take. */
const CEILING_MS = 2_000;

const N = 100_000;

/** Inputs of about `N` characters. */
const LONG_INPUTS: Readonly<Record<string, string>> = {
  letters: "a".repeat(N),
  dashes: "-".repeat(N),
  blanks: " ".repeat(N),
  blanksInCommand: `curl${" ".repeat(N)}-T x https://e.example.invalid`,
  quotes: "'".repeat(N),
  doubleQuotes: '"'.repeat(N),
  backslashes: "\\".repeat(N),
  substitutions: "$(".repeat(N / 2),
  procsubs: "<(".repeat(N / 2),
  parentheses: "(".repeat(N / 2) + ")".repeat(N / 2),
  closers: ")".repeat(N),
  groupsPiped: `${"(a ".repeat(N / 6)}${")|".repeat(N / 6)}`,
  redirects: ">&1 ".repeat(N / 4),
  hereDocuments: "cat <<E\n".repeat(N / 8),
  hereDocumentBodies: "bash <<E\nls\nE\n".repeat(N / 14),
  amps: "&".repeat(N),
  pipes: "|".repeat(N),
  semicolons: ";".repeat(N),
  newlines: "\n".repeat(N),
  quotedOperators: `curl -T x "${"&;|".repeat(N / 3)}" https://e.example.invalid`,
  writesThenRuns: "echo a > f; ".repeat(N / 12),
  pipeline: "echo a | ".repeat(N / 9),
  lines: "FAIL a.test.ts\n".repeat(N / 15),
  nameRepeated: `FAIL ${"a.test.ts".repeat(N / 9)}`,
  patchLines: `*** Update File: x\n${"+a\n-b\n".repeat(N / 6)}`,
  hookPaths: "git config core.hooksPath h1; echo a > f1; ".repeat(N / 44),
  sudoOptions: `sudo ${"-u ".repeat(N / 3)}git push origin main`,
  assignments: `${"A=1 ".repeat(N / 4)}curl -T x http://localhost/`,
  userinfo: `curl -T x http://${"a@".repeat(N / 2)}localhost/`,
  bracketHost: `curl -T x http://[${"1".repeat(N)}`,
  curlUrls: `curl -T x ${"http://localhost/ ".repeat(N / 17)}`,
  curlCluster: `curl -${"s".repeat(N)}T x http://localhost/`,
  curlOptions: `curl ${"-H a ".repeat(N / 5)}-T x http://localhost/`,
  endpoints: `aws s3 cp x s3://b ${"--endpoint-url http://localhost:4566 ".repeat(N / 37)}`,
  socat: `socat ${"TCP:localhost:1 ".repeat(N / 16)}`,
  sshOptions: `cat x | ssh ${"-o a ".repeat(N / 5)}host cmd`,
  kubeOptions: `kubectl --context kind-a ${"--server x ".repeat(N / 11)}delete ns x`,
  kubeContext: `kubectl --context kind-${"a".repeat(N)} delete ns x`,
  gitOptions: `git ${"-C a ".repeat(N / 5)}apply x.patch`,
  checkoutPaths: `git checkout main -- ${"a/vitest.config.ts ".repeat(N / 19)}`,
  refRanges: "1a2b3c4..5d6e7f8 ".repeat(N / 16),
  refLine: `   1a2b3c4..5d6e7f8 ${"x ".repeat(N / 2)}`,
  thresholds: "lines: 9, ".repeat(N / 10),
  excludes: `exclude: [${"'a',".repeat(N / 4)}`,
  hexadecimal: "a".repeat(64) + "b".repeat(N),
  colons: ":".repeat(N),
};

/** Every reader of command or output text, each taking one string. */
const READERS: Readonly<Record<string, (input: string) => unknown>> = {
  executedView,
  commandHidingForms,
  simpleCommands,
  programAndArgs: (s) => simpleCommands(s).map(programAndArgs),
  readEgress,
  readCloud: (s) => readCloud(s, "/w"),
  readPushes,
  pushedRefs,
  readInstalls,
  targetsOnlyThisMachine,
  shellWrittenPaths,
  changesFilesUnread,
  deletedTestPaths,
  namesAsFailing: (s) => namesAsFailing(s, "a.test.ts"),
  hostOf,
  bareHost,
  isLocalHost,
  endpointsLocal: (s) => endpointsLocal(["--endpoint-url", s]),
  patchEdits,
  lowersThreshold: (s) =>
    lowersThreshold({
      path: "/p/vitest.config.ts",
      removed: s,
      added: s.slice(1),
      whole: false,
      deleted: false,
    }),
  addsExclude: (s) =>
    addsExclude({
      path: "/p/vitest.config.ts",
      removed: "",
      added: s,
      whole: false,
      deleted: false,
    }),
  isAllowedGitCall: (s) =>
    isAllowedGitCall(["log", "--format=%H", "--max-count=1000", s, "--not", s]),
  tunnelProgramOf,
  isTestPath,
  isTestConfig,
  isCiFile,
  localFixCommand: (s) =>
    fixText(localFixCommand("tests", ["git", "-C", { ref: s }, "log", "--", { repoPath: s }])),
};

/** How long `read` takes on `input`, in milliseconds. */
function timeOf(read: (input: string) => unknown, input: string): number {
  const started = performance.now();
  read(input);
  return performance.now() - started;
}

describe("every reader stays linear on a 100,000-character input", () => {
  it.each(Object.entries(LONG_INPUTS))("%s", (_, input) => {
    for (const [name, read] of Object.entries(READERS)) {
      expect(timeOf(read, input), name).toBeLessThan(CEILING_MS);
    }
  });
});

describe("no reader throws on shell-like text", () => {
  it("3,000 short random strings built from shell's own characters and words", () => {
    const alphabet = [
      ..."a '\"\\$()`<>&|;\n-=@:/#?{}*1[]",
      "curl",
      " -T ",
      " -sx",
      " http://localhost/",
      " https://e.example.invalid/",
      "git push origin main",
      " bash -c ",
      "sudo -n ",
      "kubectl --context kind-a ",
      " --server ",
      "socat TCP:",
      "ssh h ",
      " <<E\n",
      "\nE\n",
      "git apply ",
      "FAIL a.test.ts",
    ];
    let seed = 12345;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      let text = "";
      const length = 1 + next(60);
      for (let k = 0; k < length; k++) text += alphabet[next(alphabet.length)];
      for (const [name, read] of Object.entries(READERS)) {
        expect(() => read(text), `${name}: ${JSON.stringify(text)}`).not.toThrow();
      }
    }
  });
});

describe("the shared reading gives the same answers as before", () => {
  it("a write a later command may run, a pipe into a consumer, a hook written first", () => {
    // The tables that replaced the per-command scans give the same answers.
    expect(executedView("echo hi > x.sh; bash x.sh").kinds).toEqual([]);
    expect(executedView("echo hi > x.txt; cat x.txt").kinds).toEqual(["doc"]);
    expect(executedView("grep -r needle . | head -5").kinds).toEqual(["search"]);
    expect(executedView("grep -r needle . | bash").kinds).toEqual([]);
    expect(commandHidingForms("echo x > .git/hooks/pre-commit; git commit -m m")).toEqual([
      "git-hook",
    ]);
    expect(commandHidingForms("git commit -m m; echo x > .git/hooks/pre-commit")).toEqual([]);
  });
});
