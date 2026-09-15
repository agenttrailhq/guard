import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs before every test file: points HOME (and USERPROFILE) at a fresh temporary directory.
 *
 * Several suites run the real CLI and hook bundle, and `init` runs the real `claude plugin`
 * commands. Every child process inherits this environment, so none of them can read or write the
 * developer's own `~/.agenttrail/guard/` or `~/.claude/` configuration.
 */
const home = mkdtempSync(join(tmpdir(), "agenttrail-guard-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
