/**
 * The leak patterns every committed fixture tree is held to, in one place.
 *
 * A recorded payload or session file comes off a real machine, so it arrives carrying the
 * home folder, an account email and real session ids. Each fixture is redacted before it
 * is committed — paths under `/home/user/`, the email as `<redacted>`, ids as
 * `00000000-0000-4000-8000-…` placeholders — and the suites that use these patterns fail
 * on anything that slipped through.
 *
 * Shared rather than copied because a pattern added for one app's fixtures is a pattern
 * the other app's fixtures should also be held to: a copy would drift the day someone
 * tightens one of them. Each pattern is proved to fire on a leak and not on its redacted
 * form, so a pattern edited into one that matches nothing cannot pass silently.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A placeholder id. Removed before scanning, so any id left is a real one. */
export const PLACEHOLDER_ID = /00000000-0000-4000-8000-\d{12}/g;

/** The text the patterns scan: a file with its placeholder ids removed. */
export function scanned(text: string): string {
  return text.replace(PLACEHOLDER_ID, "<id>");
}

/** Every file under `dir`, by its path from there, sorted. */
export function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = prefix === "" ? entry : `${prefix}/${entry}`;
      return statSync(join(dir, entry)).isDirectory() ? filesUnder(join(dir, entry), path) : [path];
    });
}

export interface Leak {
  readonly name: string;
  readonly pattern: RegExp;
  /** Text the pattern must match. Without it, a broken pattern would pass every fixture. */
  readonly leaked: string;
  /** The redacted form, which the pattern must not match. */
  readonly redacted: string;
}

export const LEAKS: readonly Leak[] = [
  {
    name: "a macOS home folder",
    pattern: /\/Users\//,
    leaked: '"/Users/someone/project"',
    redacted: '"/home/user/project"',
  },
  {
    name: "a Windows home folder",
    pattern: /[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)/i,
    leaked: String.raw`"C:\\Users\\someone\\project"`,
    redacted: String.raw`"C:\\project"`,
  },
  {
    name: "a home folder other than /home/user/",
    pattern: /\/home\/(?!user\/)[^/"\s]+\//,
    leaked: '"/home/someone/project"',
    redacted: '"/home/user/project"',
  },
  {
    name: "a home folder in a Cursor project folder name",
    pattern: /Users-[^-/"\s]+-/,
    leaked: '".cursor/projects/Users-someone-project/agent-transcripts"',
    redacted: '".cursor/projects/home-user-project/agent-transcripts"',
  },
  {
    name: "an email address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    leaked: '"user_email": "someone@example.com"',
    redacted: '"user_email": "<redacted>"',
  },
  {
    name: "a session, generation or tool id",
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    leaked: '"session_id": "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f"',
    redacted: '"session_id": "00000000-0000-4000-8000-000000000001"',
  },
];
