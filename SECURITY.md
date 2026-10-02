# Security Policy

## How to report

Email **[security@agenttrail.sh](mailto:security@agenttrail.sh)**. Keep vulnerability
details out of GitHub issues, pull requests, and discussions until a fix is released.

A useful report includes:

- what an attacker could do, and under which agent (Claude Code, Cursor, or Codex CLI);
- steps to reproduce, with your Guard version (`agenttrail-guard --version`), agent version,
  and operating system;
- a minimal payload or command that shows the problem, with secrets and private project
  details removed.

Before sending, please confirm the problem still occurs on the
[latest npm release](https://www.npmjs.com/package/@agenttrail/guard). We welcome
coordinated disclosure and will work with you on timing.

## In scope

Guard documents a small set of guarantees, and a way to break any of them is a
vulnerability:

- **It never answers `allow`.** A call Guard does not block or hold goes to the agent's own
  permission flow.
- **It never exits with code 2**, and writes at most one JSON object to stdout.
- **It sends nothing by default.** Crash reporting is off unless you turn it on, and then
  sends scrubbed stack traces only.
- **It writes only the files it documents** in [Files it keeps](README.md#files-it-keeps).

The details are in [Rules of the runtime](README.md#rules-of-the-runtime). For a plain-language
summary of what Guard reads, keeps, and sends, see
[Security & Trust](https://www.agenttrail.sh/security#guard).

## Out of scope

These are documented limits of the design, so please raise them in public instead:

- Behavior described in [What the guard does not do](README.md#what-the-guard-does-not-do),
  such as failing open, missing calls that never reach a hook, or not reading file contents.
- A dangerous command that no guardrail matches. That is a rule gap: open a
  [Guardrails issue](https://github.com/agenttrailhq/guardrails/issues).
