import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("tests run with an isolated home directory", () => {
  it("HOME is a temporary directory created for the test run", () => {
    expect(process.env.HOME).toContain("agenttrail-guard-test-home-");
    expect(process.env.USERPROFILE).toBe(process.env.HOME);
  });

  it("os.homedir() resolves to it, so the real IO sees the same directory", () => {
    expect(homedir()).toBe(process.env.HOME);
    expect(homedir().startsWith(tmpdir())).toBe(true);
  });
});
