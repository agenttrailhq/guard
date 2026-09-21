// cspell:words Northwind
/**
 * `core/redact-mcp.ts` — the structural allow-list for MCP payloads.
 *
 * The claim under test is the inversion: a deny-list of known-sensitive fields leaks the
 * field nobody thought of, so a value is redacted BY DEFAULT and only what carries no
 * identity is kept. Each fence therefore checks both directions — the value is gone and
 * the structure that makes the shape worth reading is not.
 */

import { describe, expect, it } from "vitest";
import { MCP_VALUE_PLACEHOLDER, redactMcpPayload } from "../core/redact-mcp.js";

describe("values go, structure stays", () => {
  it("redacts a string value and keeps its key", () => {
    expect(redactMcpPayload('{"team":"abc-123-team-uuid"}')).toBe('{"team":"<value>"}');
  });

  it("redacts a number value too — a bare number can be a record id", () => {
    expect(redactMcpPayload('{"issue":4821}')).toBe('{"issue":"<value>"}');
  });

  it("keeps a boolean and a null — each names nobody", () => {
    expect(redactMcpPayload('{"force":true,"parent":null,"draft":false}')).toBe(
      '{"force":true,"parent":null,"draft":false}',
    );
  });

  it("recurses into nested objects and arrays, redacting every leaf value", () => {
    const input = '{"a":{"b":"secret-name"},"list":["one","two",3]}';
    expect(redactMcpPayload(input)).toBe(
      '{"a":{"b":"<value>"},"list":["<value>","<value>","<value>"]}',
    );
  });

  it("keeps a key even when the key itself names something — a key is schema, not data", () => {
    // The residual the header states: a key is kept. It is the field name, not the value.
    expect(redactMcpPayload('{"customerName":"Acme Holdings"}')).toBe('{"customerName":"<value>"}');
  });

  it("a bare string payload becomes a redacted string", () => {
    expect(redactMcpPayload('"just a prompt"')).toBe('"<value>"');
  });

  it("an empty object and empty string are handled without error", () => {
    expect(redactMcpPayload("{}")).toBe("{}");
    expect(redactMcpPayload("")).toBe("");
  });
});

describe("no raw value survives, over a realistic payload", () => {
  it("strips an id, a title and prose, keeping only keys and shape", () => {
    const input = JSON.stringify({
      team: "9f3c1a2e-team-uuid-0001",
      title: "Fix billing for Northwind",
      body: "Their invoices double-count tax on refunds.",
      priority: 2,
      confidential: true,
    });
    const out = redactMcpPayload(input);
    for (const leak of ["9f3c1a2e", "Northwind", "double-count", "invoices"]) {
      expect(input).toContain(leak);
      expect(out).not.toContain(leak);
    }
    // Structure kept: the keys and the one non-identifying boolean.
    for (const kept of ["team", "title", "body", "priority", "confidential", "true"]) {
      expect(out).toContain(kept);
    }
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = redactMcpPayload('{"a":"x","b":[1,"y"],"c":true}');
    expect(redactMcpPayload(once)).toBe(once);
  });
});

describe("the truncated / malformed fallback", () => {
  it("keeps keys and redacts string values in JSON text it cannot parse", () => {
    // A middle-truncated payload is invalid JSON; the text scanner still keeps keys and
    // redacts values by whether a `:` follows.
    const truncated = '{"keyA":"leak-one","keyB":…[truncated]…"keyC":"leak-two"}';
    const out = redactMcpPayload(truncated);
    expect(out).not.toContain("leak-one");
    expect(out).not.toContain("leak-two");
    expect(out).toContain("keyA");
    expect(out).toContain("keyC");
  });

  it("redacts the remainder when truncation severs a string open", () => {
    const severed = '{"note":"the client is Acme and the amount';
    const out = redactMcpPayload(severed);
    expect(out).not.toContain("Acme");
    expect(out).toContain(MCP_VALUE_PLACEHOLDER);
  });

  it("does not throw on arbitrary non-JSON text", () => {
    expect(() => redactMcpPayload("not json at all { : ] ")).not.toThrow();
  });
});
