// cspell:words pipenv composer bunx dlx
/**
 * The dependency check: package installs from commands that RAN, with lockfile restores left
 * out of the install count.
 *
 * An install adds or changes a package (`npm install <pkg>`, `pnpm add`, `pip install <pkg>`,
 * `cargo add`, `go get`). A restore installs what a lockfile or requirements file already
 * pins (`npm ci`, a bare `pnpm install`, `pip install -r requirements.txt`, `uv sync`,
 * `poetry install`), which brings in nothing new, so it is counted apart.
 *
 * No registry is asked about any package: the scan runs offline, so how old a package is is
 * not checked, and the facts say so.
 *
 * There is no card for dependencies. The facts ride on `Verification.dependencies`, for the
 * report's "left out" note and the notes on the dependency guardrails. Counts and fixed enums
 * only.
 */

import {
  type CorpusCalls,
  couldHideCount,
  executedText,
  heldHidingForms,
  isShell,
  programAndArgs,
  runStateOf,
  type SimpleCommand,
  simpleCommands,
} from "./calls.js";
import { couldHideTemplate, counted } from "./card-parts.js";
import type { SentenceTemplate } from "./cards.js";
import { PACKAGE_AGE_NOT_CHECKED, PACKAGE_MANAGERS } from "./command-facts.js";
import type { HidingForm } from "./types.js";

export { PACKAGE_AGE_NOT_CHECKED, PACKAGE_MANAGERS };

/** One of `PACKAGE_MANAGERS`. */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** What the dependency check found. Every count is of commands that ran. */
export interface DependencyFacts {
  /** Installs that added or changed a package. */
  readonly installs: number;
  /** Installs from a lockfile or requirements file, left out of `installs`. */
  readonly lockfileRestores: number;
  /** The managers the installs used, in `PACKAGE_MANAGERS` order. */
  readonly managers: readonly PackageManager[];
  /** Always `not-checked-offline`. */
  readonly packageAge: typeof PACKAGE_AGE_NOT_CHECKED;
  /** Install commands only mentioned, which did not run. */
  readonly mentioned: number;
  /** Install commands that could not be confirmed as run. */
  readonly unconfirmed: number;
  /** Calls that ran, or may have run, and could have run other commands this check does not read. */
  readonly couldHide: number;
  /** The hiding forms those calls hold, in `HIDING_FORMS` order. */
  readonly hidingForms: readonly HidingForm[];
}

declare module "./types.js" {
  interface Verification {
    /**
     * Package installs from commands that ran, with lockfile restores left out. Absent from a
     * verification made before this check existed.
     */
    readonly dependencies?: DependencyFacts;
  }
}

/** One install command, read. */
export interface InstallReading {
  readonly manager: PackageManager;
  readonly restore: boolean;
}

/** The words of `args` that are not options. */
function operandsOf(args: readonly string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

/** A JavaScript package manager's command. */
function readJs(
  manager: "npm" | "pnpm" | "yarn" | "bun",
  args: readonly string[],
): InstallReading | undefined {
  const words = operandsOf(args);
  const sub = words[0];
  const packages = words.slice(1);
  if (manager === "yarn" && sub === undefined) return { manager, restore: true };
  if (sub === "ci") return manager === "npm" ? { manager, restore: true } : undefined;
  if (sub === "install" || sub === "i") return { manager, restore: packages.length === 0 };
  if (sub === "add" || sub === "update" || sub === "up" || sub === "upgrade") {
    return { manager, restore: false };
  }
  return undefined;
}

/** `pip install`: a requirements file or the project itself is a restore. */
function readPip(args: readonly string[]): InstallReading | undefined {
  if (args[0] !== "install") return undefined;
  const rest = args.slice(1);
  const fromFile = rest.some((a) => a === "-r" || a.startsWith("--requirement") || a === "-c");
  const packages = rest.filter(
    (a, k) => !a.startsWith("-") && !["-r", "-c", "-e"].includes(rest[k - 1] ?? ""),
  );
  const project = rest.some((a) => a === "-e" || a === ".");
  return { manager: "pip", restore: fromFile || (project && packages.every((p) => p === ".")) };
}

/** What one simple command installs, if anything. */
function readSimple(simple: SimpleCommand): InstallReading | undefined {
  const { program, args } = programAndArgs(simple);
  switch (program) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return readJs(program, args);
    case "pip":
    case "pip3":
      return readPip(args);
    case "python":
    case "python3":
      return args[0] === "-m" && (args[1] === "pip" || args[1] === "pip3")
        ? readPip(args.slice(2))
        : undefined;
    case "uv": {
      if (args[0] === "sync") return { manager: "uv", restore: true };
      if (args[0] === "add") return { manager: "uv", restore: false };
      if (args[0] === "pip" && args[1] === "sync") return { manager: "uv", restore: true };
      if (args[0] === "pip") {
        const pip = readPip(args.slice(1));
        return pip === undefined ? undefined : { manager: "uv", restore: pip.restore };
      }
      return undefined;
    }
    case "poetry":
      if (args[0] === "install") return { manager: "poetry", restore: true };
      return args[0] === "add" || args[0] === "update"
        ? { manager: "poetry", restore: false }
        : undefined;
    case "pipenv": {
      if (args[0] === "sync") return { manager: "pipenv", restore: true };
      if (args[0] !== "install") return undefined;
      return { manager: "pipenv", restore: operandsOf(args.slice(1)).length === 0 };
    }
    case "cargo":
      return args[0] === "add" || args[0] === "install"
        ? { manager: "cargo", restore: false }
        : undefined;
    case "go":
      if (args[0] === "get" || args[0] === "install") return { manager: "go", restore: false };
      return args[0] === "mod" && args[1] === "download"
        ? { manager: "go", restore: true }
        : undefined;
    case "gem":
      return args[0] === "install" ? { manager: "gem", restore: false } : undefined;
    case "bundle":
    case "bundler":
      if (args[0] === "install") return { manager: "bundler", restore: true };
      return args[0] === "add" ? { manager: "bundler", restore: false } : undefined;
    case "composer":
      if (args[0] === "install") return { manager: "composer", restore: true };
      return args[0] === "require" || args[0] === "update"
        ? { manager: "composer", restore: false }
        : undefined;
    default:
      return undefined;
  }
}

/** The installs in a shell text. */
export function readInstalls(command: string): InstallReading[] {
  const out: InstallReading[] = [];
  for (const simple of simpleCommands(command)) {
    const reading = readSimple(simple);
    if (reading !== undefined) out.push(reading);
  }
  return out;
}

/** Run the dependency check. See the module header. Pure; never throws. */
export function checkDependencies(calls: CorpusCalls): DependencyFacts {
  const managers = new Set<PackageManager>();
  let installs = 0;
  let lockfileRestores = 0;
  let mentioned = 0;
  let unconfirmed = 0;
  for (const call of calls.calls) {
    if (!isShell(call) || readInstalls(call.command).length === 0) continue;
    const state = runStateOf(calls.agent, call, (command) => readInstalls(command).length > 0);
    if (state === "mentioned") mentioned += 1;
    else if (state === "unknown") unconfirmed += 1;
    else {
      for (const reading of readInstalls(executedText(call.command))) {
        if (reading.restore) lockfileRestores += 1;
        else {
          installs += 1;
          managers.add(reading.manager);
        }
      }
    }
  }
  return {
    installs,
    lockfileRestores,
    managers: PACKAGE_MANAGERS.filter((m) => managers.has(m)),
    packageAge: PACKAGE_AGE_NOT_CHECKED,
    mentioned,
    unconfirmed,
    couldHide: couldHideCount(calls),
    hidingForms: heldHidingForms(calls),
  };
}

// ── Sentences, for the report's "left out" note and the dependency guardrails' notes ─────

/** A template that states a count when it is above zero. */
function whenAny(
  id: string,
  count: (f: DependencyFacts) => number,
  say: (n: number, f: DependencyFacts) => string,
): SentenceTemplate<DependencyFacts> {
  return { id, render: (f) => (count(f) > 0 ? say(count(f), f) : undefined) };
}

/** The "left out" note's line: lockfile restores are not counted as installs. */
export const LOCKFILE_RESTORES_LEFT_OUT: SentenceTemplate<DependencyFacts> = whenAny(
  "deps.restores-left-out",
  (f) => f.lockfileRestores,
  (n) => `${counted(n, "lockfile restore was", "lockfile restores were")} left out.`,
);

/** The dependency sentences. */
export const DEPENDENCY_SENTENCES: readonly SentenceTemplate<DependencyFacts>[] = [
  whenAny(
    "deps.installs",
    (f) => f.installs,
    (n, f) =>
      `${counted(n, "install that ran", "installs that ran")} added or changed packages, with ${f.managers.join(", ")}.`,
  ),
  {
    id: "deps.none",
    render: (f) =>
      f.installs === 0 && f.couldHide === 0 && f.unconfirmed === 0
        ? "No install that ran added or changed a package."
        : undefined,
  },
  couldHideTemplate("deps.could-hide"),
  LOCKFILE_RESTORES_LEFT_OUT,
  {
    id: "deps.package-age",
    render: () => "Package age: not checked, because the scan runs offline.",
  },
];
