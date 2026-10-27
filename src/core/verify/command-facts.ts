// cspell:words cloudflared frpc frps zrok devtunnel tmole loclx inlets rathole gost socat pipenv
/**
 * The fixed enums and the fact keys of the checks that read what commands and edits did:
 * tests, cloud, production infrastructure, unreviewed code, egress and dependencies.
 *
 * Kept in one module that imports nothing, so the place that lists every enum value and key a
 * verification may carry can take them from here without importing the checks themselves.
 * Every string these checks put in their facts is one of these values or keys.
 */

/** What an IAM change was about. */
export const IAM_SUBJECTS = [
  "access-keys",
  "policies",
  "roles",
  "users",
  "groups",
  "credentials",
  "other",
] as const;

/** Whether the database targets were supplied to the production check. */
export const DATABASE_CHECKS = ["checked", "not-available"] as const;

/** What kind of infrastructure a production guardrail is about. */
export const INFRA_KINDS = [
  "terraform",
  "kubernetes",
  "helm",
  "cloud-delete",
  "deploy",
  "prod-config",
  "other",
] as const;

/** What kind of upload a command made. */
export const UPLOAD_KINDS = [
  "http-upload",
  "file-copy",
  "cloud-storage",
  "paste",
  "raw-socket",
  "other",
] as const;

/**
 * Tunnel and relay programs, by the file name they run under. A program run through an
 * interpreter (a Node or Python tunnel client) shows as the interpreter, and is not here.
 *
 * The process list `VerifyIO` returns must keep these names for the egress check to see them:
 * where the seam reduces the list to a fixed set of ids, these are part of that set.
 */
export const TUNNEL_PROCESS_NAMES = [
  "ngrok",
  "cloudflared",
  "bore",
  "frpc",
  "frps",
  "chisel",
  "zrok",
  "devtunnel",
  "tmole",
  "loclx",
  "inlets",
  "rathole",
  "gost",
  "socat",
] as const;

/** Whether the process list could be read. */
export const PROCESS_CHECKS = ["checked", "could-not-check"] as const;

/** The package managers an install is counted under. */
export const PACKAGE_MANAGERS = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "uv",
  "poetry",
  "pipenv",
  "cargo",
  "go",
  "gem",
  "bundler",
  "composer",
] as const;

/** Package age is never looked up: the scan makes no network call. */
export const PACKAGE_AGE_NOT_CHECKED = "not-checked-offline";

/** Every enum whose values these checks' facts may hold. */
export const COMMAND_FACT_VALUE_ENUMS: readonly (readonly string[])[] = [
  IAM_SUBJECTS,
  DATABASE_CHECKS,
  INFRA_KINDS,
  UPLOAD_KINDS,
  TUNNEL_PROCESS_NAMES,
  PROCESS_CHECKS,
  PACKAGE_MANAGERS,
  [PACKAGE_AGE_NOT_CHECKED],
];

/** Every key these checks' facts may use. */
export const COMMAND_FACT_KEYS: readonly string[] = [
  // Tests.
  "thresholdsLowered",
  "autoUpdateReverts",
  "autoUpdateNow",
  "on",
  "off",
  "unread",
  "configsRewritten",
  "excludesAdded",
  "passWithNoTests",
  "ciStepsForcedTrue",
  "testFilesDeleted",
  "deletedAfterFailing",
  "deletedFailureUnknown",
  "unreadEdits",
  // Every check.
  "mentioned",
  "unconfirmed",
  "couldHide",
  // Cloud.
  "iamChanges",
  "iamSubjects",
  "autoScalingChanges",
  "s3Changes",
  "terraformChanges",
  "terraformAutoApprove",
  "localStack",
  // Production infrastructure.
  "databaseTargets",
  "local",
  "scratch",
  "other",
  "databaseCheck",
  "infraMatches",
  "infraKinds",
  "localInfra",
  // Unreviewed code.
  "pushesToMain",
  "commitsOnMain",
  "commitsNotOnMain",
  "pushesNotChecked",
  "pushesCreatingMain",
  // Egress.
  "uploads",
  "uploadKinds",
  "tunnelsStarted",
  "localOnly",
  "tunnelsRunning",
  "tunnelPrograms",
  "processCheck",
  // Dependencies.
  "dependencies",
  "installs",
  "lockfileRestores",
  "managers",
  "packageAge",
];
