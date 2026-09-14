/**
 * The local crash spool — `~/.agenttrail/guard/crashes/*.json`.
 *
 * ── This module is why the "no network" guarantee survives ───────────────────
 * `hook` and `scan` CAPTURE here and do nothing else. They never send. The only
 * transmitter is `crash-report --send`, a separate command the user runs
 * deliberately, so `net/crash-transport.ts` is absent from the import graph of both
 * barred entry points and `no-network.test.ts` can prove that with a parser rather
 * than assert it about a boolean.
 *
 * Everything here is best-effort. A crash report is never worth failing a tool call
 * over, so every function swallows and reports failure in its return value.
 */

import type { GuardIO } from "../io.js";
import type { CrashRecord } from "./crash-record.js";
import { crashesDir } from "./paths.js";

/** At most this many spooled crashes. Oldest evicted first. */
export const MAX_SPOOLED = 20;

/** Spooled crashes older than this are dropped unsent. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Only files we wrote. Prevents `--clear` touching anything else in the dir. */
const SPOOL_NAME = /^crash-(\d+)-[a-z0-9]+\.json$/;

/** One spooled crash, with the filename it came from. */
export interface SpooledCrash {
  readonly name: string;
  readonly record: CrashRecord;
}

/** Milliseconds encoded in a spool filename, or `undefined` if it is not one of ours. */
function stampOf(name: string): number | undefined {
  const m = SPOOL_NAME.exec(name);
  if (m?.[1] === undefined) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Our spool files, oldest first. Anything else in the directory is ignored. */
function ourFiles(io: GuardIO, dir: string): { name: string; stamp: number }[] {
  const out: { name: string; stamp: number }[] = [];
  for (const name of io.listDir(dir)) {
    const stamp = stampOf(name);
    if (stamp !== undefined) out.push({ name, stamp });
  }
  out.sort((a, b) => a.stamp - b.stamp || a.name.localeCompare(b.name));
  return out;
}

/**
 * Spool one crash. Returns `false` if it could not be written, which is not an
 * error any caller should act on — the alternative to a missing crash report is a
 * frozen agent, and we chose the missing report.
 *
 * Bounds are applied on every write rather than on a timer: there is no daemon to
 * run a timer in, and a burst of crashes is exactly when the bound matters.
 */
export function spoolCrash(io: GuardIO, record: CrashRecord, now: number): boolean {
  const dir = crashesDir(io.homedir());
  if (!io.mkdirp(dir)) return false;

  const name = `crash-${now}-${Math.random().toString(36).slice(2, 10)}.json`;
  const ok = io.writeFileAtomic(`${dir}/${name}`, `${JSON.stringify(record)}\n`);
  if (!ok) return false;

  pruneSpool(io, now);
  return true;
}

/** Drop anything over the count or age bound. Best-effort; never throws. */
export function pruneSpool(io: GuardIO, now: number): void {
  const dir = crashesDir(io.homedir());
  const files = ourFiles(io, dir);

  for (const f of files) {
    if (now - f.stamp > MAX_AGE_MS) io.deleteFile(`${dir}/${f.name}`);
  }

  const fresh = files.filter((f) => now - f.stamp <= MAX_AGE_MS);
  const excess = fresh.length - MAX_SPOOLED;
  for (let i = 0; i < excess; i += 1) {
    const f = fresh[i];
    if (f !== undefined) io.deleteFile(`${dir}/${f.name}`);
  }
}

/**
 * Read the spool, oldest first.
 *
 * A file that is missing, unreadable, not JSON, or not shaped like a record is
 * SKIPPED rather than fatal — one corrupt file must not make `--send` impossible for
 * the rest, and a half-written file is a normal consequence of a machine losing
 * power mid-write.
 */
export function readSpool(io: GuardIO): readonly SpooledCrash[] {
  const dir = crashesDir(io.homedir());
  const out: SpooledCrash[] = [];
  for (const { name } of ourFiles(io, dir)) {
    const text = io.readFile(`${dir}/${name}`);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const rec = parsed as Partial<CrashRecord>;
    if (typeof rec.v !== "number" || typeof rec.errorName !== "string") continue;
    out.push({ name, record: parsed as CrashRecord });
  }
  return out;
}

/** Delete one spooled crash by name. Used after a successful send. */
export function deleteSpooled(io: GuardIO, name: string): boolean {
  if (stampOf(name) === undefined) return false; // never delete a foreign file
  return io.deleteFile(`${crashesDir(io.homedir())}/${name}`);
}

/** Delete every spooled crash. `crash-report --clear`. */
export function clearSpool(io: GuardIO): number {
  const dir = crashesDir(io.homedir());
  let n = 0;
  for (const { name } of ourFiles(io, dir)) {
    if (io.deleteFile(`${dir}/${name}`)) n += 1;
  }
  return n;
}
