/**
 * `redactMcpPayload` — the identifying VALUES out of a serialized MCP tool input.
 *
 * ── Why the other three passes cannot do this ────────────────────────────────
 * An `mcp__*` tool call reaches `scan` as `mapper.ts`'s `safeStringify(input)` — one
 * JSON blob on the command channel. The three passes `scan` composes for a command
 * (`scrubText` → `redactPaths` → `redactIdentifiers`) each miss a JSON value:
 *
 *   - `scrubText` matches a secret SHAPE. A team id, a record id, or a sentence of
 *     free-text prose is none of the fourteen shapes it knows.
 *   - `redactPaths` matches path STRUCTURE — a separator. An opaque id has none.
 *   - `redactIdentifiers` matches operand POSITION inside a KNOWN shell command, from a
 *     deny-list of shell tools. An MCP server is never on that list, so the whole blob
 *     passes through untouched.
 *
 * So a JSON payload is displayed and written verbatim, carrying whatever the caller put
 * in it. This module closes that.
 *
 * ── Allow-list, not deny-list — the inversion that matters ───────────────────
 * A deny-list of "known-sensitive fields" leaks every field nobody thought of. So a
 * value is REDACTED BY DEFAULT and only what cannot carry identity is kept:
 *
 *   - a string value  → `<value>`  (an id, a name, a URL, a sentence of prose)
 *   - a number value  → `<value>`  (a bare number can be a record id or a count that
 *                                   identifies)
 *   - `true` / `false` / `null`    → kept: each is one of a fixed set and names nobody
 *   - object / array structure     → kept, and each element/value is redacted in turn
 *   - object KEYS                  → kept: a key is the tool's schema (`team`, `title`),
 *                                   not the caller's data, and keeping it is what makes
 *                                   the shape worth reading — `{"team":"<value>"}` says
 *                                   what the call did without saying to whom.
 *
 * A key is the one thing kept that a caller could in principle abuse (an object used as
 * a map, whose keys are ids). That residual is narrow, and a secret-SHAPED key is still
 * caught downstream, because `scan` runs the standard secret scrubber over the result of
 * this pass as a second layer.
 *
 * ── Truncation ────────────────────────────────────────────────────────────────
 * The mapper middle-truncates an oversized payload, so the string handed here may be
 * invalid JSON with a marker spliced into the middle. `JSON.parse` then fails and a
 * text scanner takes over: it keeps a string that a `:` follows (a key) and redacts
 * every other string (a value), and if truncation cut a string open it redacts the
 * remainder and stops, since nothing after a severed quote is trustworthy structure.
 * A bare number in the severed tail is the one thing the fallback does not reach; the
 * parseable path — every payload under the cap — redacts numbers too.
 *
 * ── Total and pure ───────────────────────────────────────────────────────────
 * Never throws and does no I/O: a malformed or empty blob yields a safe, redacted
 * string rather than an error, because this runs on the display path of a tool whose
 * first rule is to fail open without leaking.
 */

/** What an identifying MCP payload value is replaced with. */
export const MCP_VALUE_PLACEHOLDER = "<value>";

/** Redact one parsed JSON node: values go, structure and keys stay. */
function redactNode(node: unknown): unknown {
  if (node === null) return null;
  const t = typeof node;
  if (t === "string" || t === "number") return MCP_VALUE_PLACEHOLDER;
  if (t === "boolean") return node;
  if (Array.isArray(node)) return node.map(redactNode);
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = redactNode(value);
    }
    return out;
  }
  // `bigint`/`function`/`undefined` never come out of `JSON.parse`; redact defensively.
  return MCP_VALUE_PLACEHOLDER;
}

/**
 * Redact string VALUES in JSON TEXT, keeping keys. The fallback for a blob `JSON.parse`
 * rejects — a truncated payload, or one the mapper could not serialize cleanly.
 *
 * A string is a key when a `:` follows it (whitespace aside) and a value otherwise. A
 * string with no closing quote was cut by truncation, so its remainder is redacted and
 * the scan stops there.
 */
function redactJsonTextValues(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i] as string;
    if (ch !== '"') {
      out += ch;
      i++;
      continue;
    }

    // Read one JSON string literal, honoring backslash escapes.
    let j = i + 1;
    let terminated = false;
    while (j < n) {
      const c = text[j] as string;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === '"') {
        terminated = true;
        break;
      }
      j++;
    }

    if (!terminated) {
      // Truncation severed this string; nothing after it is trustworthy structure.
      return `${out}"${MCP_VALUE_PLACEHOLDER}"`;
    }

    // Does a `:` follow (whitespace aside)? Then this string is a KEY — keep it.
    let k = j + 1;
    while (k < n) {
      const c = text[k] as string;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") k++;
      else break;
    }
    if (text[k] === ":") {
      out += text.slice(i, j + 1);
    } else {
      out += `"${MCP_VALUE_PLACEHOLDER}"`;
    }
    i = j + 1;
  }

  return out;
}

/**
 * Redact the identifying values out of a serialized MCP tool input.
 *
 * Keeps the JSON structure and its keys; replaces every leaf value that could carry
 * identity with {@link MCP_VALUE_PLACEHOLDER}. Compose it BEFORE the command passes: the
 * result is valid JSON carrying only placeholders, and running the standard scrubber
 * over it afterwards is a harmless second layer.
 */
export function redactMcpPayload(serialized: string): string {
  if (serialized.length === 0) return serialized;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return redactJsonTextValues(serialized);
  }

  try {
    return JSON.stringify(redactNode(parsed)) ?? MCP_VALUE_PLACEHOLDER;
  } catch {
    // `JSON.stringify` of an all-placeholder tree does not throw; guarded anyway.
    return redactJsonTextValues(serialized);
  }
}
