// cspell:disable -- hashes, digests and identifiers that only look like words.
/**
 * Ordinary developer text the long-random-string fallback must leave byte-identical.
 *
 * Everything here is a string a shell command or a tool call plausibly carries and that is
 * NOT a secret: commit hashes, content digests, lockfile integrity values, identifiers and
 * branch names, file names, URLs, encoded blobs. `redact-secrets.test.ts` asserts the whole
 * list survives unchanged and prints how many strings it measured, so the false-positive
 * rate is a number and not a guess.
 *
 * It is not a `*.test.ts`, so vitest does not collect it as a suite.
 */

/** Hex digests and ids, built by repetition so the file holds no real hash. */
const HEX_40 = "3b8390f6a1c2d4e5f60718293a4b5c6d7e8f9012";
const HEX_64 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const HEX_128 = HEX_64 + HEX_64.split("").reverse().join("");
const HEX_32 = "d41d8cd98f00b204e9800998ecf8427e";
const B64_INTEGRITY =
  "sha512-9yJZlO1sZ0q8YtHcA6xN3vZcPjR2eLmK5wQfT7uB1dGhI4oSnXyVbCkE0aWzrMtU+qpRgDf/H8j2L3w==";

export const QUIET_CORPUS: readonly string[] = [
  // Commit ids.
  `git show ${HEX_40}`,
  `git log --oneline ${HEX_40.slice(0, 7)}..${HEX_40.slice(7, 14)}`,
  `git cherry-pick ${HEX_40} ${HEX_40.split("").reverse().join("")}`,
  `git checkout -b backup-${HEX_40.slice(0, 12)}`,
  // Content digests.
  `sha256sum build.tar.gz # ${HEX_64}`,
  `echo "${HEX_64}  build.tar.gz" | sha256sum -c -`,
  `md5sum release.zip ${HEX_32}`,
  `sha512sum dist.tgz ${HEX_128}`,
  // Image digests and integrity.
  `docker pull alpine@sha256:${HEX_64}`,
  `docker inspect --format '{{.Id}}' sha256:${HEX_64}`,
  `"integrity": "${B64_INTEGRITY}"`,
  `resolution: {integrity: ${B64_INTEGRITY}}`,
  `integrity sha256-${"AbCdEf0123456789".repeat(3)}`,
  // UUIDs.
  "curl https://api.example.com/v1/items/123e4567-e89b-42d3-a456-426614174000",
  "kubectl get pod 7d9f8b6c-5d4e-4a1b-9c3d-2e1f0a9b8c7d",
  // Long identifiers and names.
  "git checkout feature/add-billing-export-for-enterprise-customers-with-seats",
  "git branch -m very-long-descriptive-branch-name-with-many-words-in-it-2026",
  "git push origin release-candidate-2026-10-07-hotfix-for-ingest-rate-limit",
  "pnpm --filter @acme/ledger-sync-with-a-very-long-package-name test",
  "export const useAuthenticatedOrganizationSubscriptionStatusQuery = () => null;",
  "class AbstractSingletonProxyFactoryBeanConfigurationManagerImplementation {}",
  "SELECT customer_subscription_billing_period_start_timestamp FROM billing_periods",
  "def test_that_the_organization_member_can_resolve_a_pending_approval_hold(): pass",
  "docker run --name integration-test-runner-for-the-scan-report-regression-suite alpine",
  "kubectl rollout status deployment/web-frontend-production-blue-green-v2-canary",
  "node_modules/.pnpm/@scope+very-long-package-name-with-hyphens@1.2.3_react@18.2.0/node_modules/x",
  "terraform apply -target=module.networking_primary_region_private_subnets_nat_gateway",
  "WHEREISTHELONGESTWORDINTHEENGLISHLANGUAGEWITHOUTANYDIGITSATALL",
  "the_quick_brown_fox_jumps_over_the_lazy_dog_and_keeps_running_far_away",
  "123456789012345678901234567890123456789012345678",
  // File names and URLs with hashes in them.
  "ls dist/assets/index-DfG3h9Kq2LmN8pQr5sTuVwXyZ01aBcD4eFg.js",
  "cat build/static/js/main.a1b2c3d4e5f60718293a4b5c6d7e8f90.chunk.js",
  "open https://example.com/blog/how-we-reduced-our-ingest-latency-by-forty-percent-in-q3",
  "curl -L https://github.com/acme/tool/releases/download/v1.2.3/tool_1.2.3_linux_amd64.tar.gz",
  "wget https://registry.npmjs.org/some-package/-/some-package-1.2.3.tgz",
  // Encoded blobs.
  "echo aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZyB3aXRoIHBhZGRpbmc= | base64 -d",
  `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">`,
  "curl 'https://example.com/search?q=hello%20world%20this%20is%20a%20long%20url%20encoded%20query'",
  // Timestamps and counters.
  "touch backup-20261007T093000Z-12345678901234567890.sql",
  "echo 1791290585678329 1791290585678330 1791290585678331 1791290585678332",
  // Ordinary prose and code.
  "echo 'Supercalifragilisticexpialidocious is a very long word with no digits at all'",
  "python -c \"print('the quick brown fox jumps over the lazy dog 1234567890 times today')\"",
  "grep -rn 'getOrganizationSubscriptionBillingPeriodStartTimestampFromLedger' src/",
  // Identifiers with digits in them: camelCase and PascalCase, versions, years, ordinals.
  "grep -rn getOrganizationSubscriptionBillingPeriodV2StartTimestamp src/",
  "export const useAuthenticatedOrganizationSubscriptionStatusQueryV3 = () => null;",
  "class AbstractSingletonProxyFactoryBeanConfigurationManagerImplementationV2 {}",
  "import { computeQuarterlyLedgerReconciliationSummary2026Q3 } from './ledger'",
  "const migrationRunnerForTenantSchemaVersion20261007Applied = true;",
  "def test_that_the_organization_member_can_resolve_hold_number_42(): pass",
  "docker run --name integration-test-runner-for-the-scan-report-suite-v2 alpine",
  // Bare folder and workspace names: not path-shaped, kept readable on purpose.
  "cd Q3Ledger2026ReconciliationWorkspaceTemplateFolder9",
  "cd quarterly-ledger-reconciliation-workspace-template-folder-2026-q3 && ls",
  "git -C OrganizationSubscriptionBillingWorkspace2026Archive status",
  "pnpm --filter customer-subscription-billing-reconciliation-workspace-v2 build",
  "mkdir -p NorthwindQuarterlyLedgerReconciliationWorkspaceTemplateFolder7",
  // Long values after an assignment: hashes, ids, digests, identifiers.
  `docker build --build-arg COMMIT=${HEX_40} .`,
  `BUILD_DIGEST=sha256:${HEX_64} ./publish.sh`,
  `export PKG_INTEGRITY=${B64_INTEGRITY}`,
  "export RELEASE_TAG=release-candidate-2026-10-07-hotfix-for-ingest-rate-limit",
  "kubectl label pod web version=release-candidate-2026-10-07-hotfix-for-ingest-rate-limit",
  "curl 'https://example.com/a?id=123e4567-e89b-42d3-a456-426614174000&v=2'",
  "TARGET=getOrganizationSubscriptionBillingPeriodV2StartTimestamp ./build.sh",
  `curl "https://example.com/blob?sha=${HEX_64}"`,
  `echo 'img=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='`,
  // Long hyphenated names with digit segments: pods, releases, deployments.
  "kubectl logs web-frontend-7d9f8b6c5d-x2k9q-canary-blue-green-2026-10-07",
  "git checkout web-frontend-7d9f8b6c5d-x2k9q-canary-blue-green-checkout-2026-10-07",
  "helm upgrade api-gateway-production-us-east-1-blue-6f7c9d8b5-abcde-2026-10-07 ./chart",
  // A label joined to a hash.
  `aws ecr describe-images --image-ids imageTag=main-${HEX_40}`,
  `docker tag app:latest registry.example.com/app:release_${HEX_64}`,
  // Names that merely end in key.
  "export MONKEY=banana KEYBOARD=qwerty TURKEY=dinner",
  "psql -c 'ALTER TABLE t ADD PRIMARY KEY (id)'",
];
