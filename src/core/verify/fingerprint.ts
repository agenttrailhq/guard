// cspell:words fingerprinter fingerprinters Fingerprinter
/**
 * The join key for a credential-shaped value: a keyed hash, so the same value seen in two
 * transcripts counts once, without the value itself being the key.
 *
 * HMAC-SHA-256 under a random key made for this run and held only in memory. The key is never
 * written, so a fingerprint means nothing outside the run that made it: it cannot be checked
 * against a guessed value later, and two runs give the same value different fingerprints.
 * Fingerprints are used inside one run and never written to the report, the JSON, a log or
 * the terminal.
 */

import { createHmac, randomBytes } from "node:crypto";

/** Hex characters kept from the digest: 128 bits, far past any collision a scan could meet. */
const FINGERPRINT_HEX = 32;

/** Bytes of key material. */
const KEY_BYTES = 32;

/** Maps a value to its fingerprint for this run. */
export type Fingerprinter = (value: string) => string;

/**
 * A fingerprinter under a fresh random key.
 *
 * `key` exists for tests that need two fingerprinters to agree. Production passes nothing.
 */
export function createFingerprinter(key: Uint8Array = randomBytes(KEY_BYTES)): Fingerprinter {
  // Copied, so a caller that reuses or clears its buffer cannot change this one's key.
  const own = Buffer.from(key);
  return (value: string): string =>
    createHmac("sha256", own).update(value, "utf8").digest("hex").slice(0, FINGERPRINT_HEX);
}
