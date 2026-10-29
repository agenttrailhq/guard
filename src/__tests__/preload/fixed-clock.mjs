// Test-only preload: fixes the clock of a spawned process at AGENTTRAIL_TEST_NOW (an ISO time),
// so two runs of a built bundle print the same times wherever the page states one: the
// generated time, the title's date, the data block and how old the guardrail library is.
// Loaded with `node --import`, never shipped.
const at = process.env.AGENTTRAIL_TEST_NOW;
if (at !== undefined) {
  const fixed = Date.parse(at);
  if (Number.isNaN(fixed)) throw new Error(`AGENTTRAIL_TEST_NOW is not a time: ${at}`);
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate;
}
