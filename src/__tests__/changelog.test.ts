// cspell:words releaserc
/**
 * The changelog header.
 *
 * semantic-release's changelog plugin writes the `changelogTitle` from `.releaserc.json` at the
 * top of `CHANGELOG.md`, then the new release's notes, then the rest of the file. It removes the
 * old title first, but only when the file starts with exactly that string. If the two drift
 * apart, every release lands above a stale header instead of below it. This pins the file to the
 * configured title so a mismatch fails CI rather than the next release.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8");
}

function changelogTitle(): string {
  const config = JSON.parse(read(".releaserc.json")) as { plugins?: unknown[] };
  for (const plugin of config.plugins ?? []) {
    if (Array.isArray(plugin) && plugin[0] === "@semantic-release/changelog") {
      const title = (plugin[1] as { changelogTitle?: unknown } | undefined)?.changelogTitle;
      if (typeof title !== "string") throw new Error("the changelog plugin sets no changelogTitle");
      return title;
    }
  }
  throw new Error(".releaserc.json has no @semantic-release/changelog plugin");
}

describe("CHANGELOG.md", () => {
  const title = changelogTitle();
  const changelog = read("CHANGELOG.md");

  it("starts with the changelogTitle semantic-release writes", () => {
    expect(changelog.startsWith(`${title}\n\n`)).toBe(true);
  });

  it("has exactly one top-level heading", () => {
    expect(changelog.match(/^# /gm)).toHaveLength(1);
  });

  it("puts the newest release directly under the header", () => {
    expect(changelog.slice(title.length).trimStart().startsWith("## [")).toBe(true);
  });

  it("has no Unreleased section, which semantic-release never fills", () => {
    expect(changelog).not.toMatch(/^## \[Unreleased\]/m);
  });
});
