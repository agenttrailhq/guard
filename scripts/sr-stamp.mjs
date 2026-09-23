#!/usr/bin/env node
// @semantic-release/exec prepare for @agenttrail/guard: sync src/core/version.ts (VERSION)
// and plugin/.claude-plugin/plugin.json (version) to the release version. @semantic-release/npm
// bumps package.json; cli.test.ts and plugin-skill.test.ts pin these to it. `pnpm build` (run
// after this in the prepareCmd) re-inlines VERSION into the committed plugin bundles.
import { readFileSync, writeFileSync } from "node:fs";
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error(`sr-stamp: bad version ${JSON.stringify(version)}`);
  process.exit(2);
}
const root = new URL((process.env.GUARD_ROOT ? process.env.GUARD_ROOT + "/" : "../"), import.meta.url);
function sub(rel, re, label) {
  const p = new URL(rel, root);
  const before = readFileSync(p, "utf8");
  const after = before.replace(re, `$1${version}$2`);
  if (after === before) { console.error(`sr-stamp: no substitution in ${rel}`); process.exit(1); }
  writeFileSync(p, after);
  console.error(`sr-stamp: ${label}=${version}`);
}
sub("src/core/version.ts", /(export const VERSION = ")[^"]*(";)/, "VERSION");
sub("plugin/.claude-plugin/plugin.json", /("version":\s*")[^"]*(")/, "plugin.version");
