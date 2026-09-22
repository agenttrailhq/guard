# Changelog

All notable changes to `@agenttrail/guard` are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is below `1.0.0`, a **breaking change bumps the minor** and anything else the patch.
For this package, breaking means a change to the installed hook entry (which silently stops
the guard checking an existing install until it is re-approved) or a removed command or flag;
adding a command, a flag, or support for a new agent is a feature.

## [Unreleased]

## [0.4.0] - 2026-09-21

### Added

- **Codex CLI support** — install and enforce the guardrails in Codex CLI alongside Claude
  Code and Cursor; `init` / `uninstall` / `scan` / `status` take `--agent codex`. Codex
  trusts the hook entry it approved, so the entry is frozen and a new release keeps that
  approval. `scan --agent codex` reads Codex sessions from its transcripts.

### Changed

- `init` run through `npx` now closes by pointing at a global install
  (`npm i -g @agenttrail/guard`) instead of a command not yet on PATH; the README documents
  the global install as the single path.
- `status` renders each recent-decision command on one line (flattened and truncated), labels
  the list `latest N of M`, and declines to offer a `guardrails allow` line when the command
  cannot be a single line to paste.
- `status` and the scan report state plainly, for an app whose hook cannot raise a prompt,
  that an `ask` verdict there is recorded but was not asked.

## [0.3.0] - 2026-09-21

### Added

- **Cursor support** — install and enforce the guardrails in Cursor (via its hooks)
  alongside Claude Code; `init` / `uninstall` / `scan` take `--agent <claude|cursor>`.
- **Redesigned `scan` report** — a branded, self-contained HTML report with match totals and
  top findings, `--out` / `--artifact` / open-by-default, and a `share-report` skill.

### Changed

- Bundled catalog re-pinned to `@agenttrail/guardrails@0.2.0` — **74 guardrails across 11
  packs**, carrying the leading-flag, compound-mention and `block-curl-pipe-to-shell` fixes.
- Hardened `scan` redaction (heredoc bodies, UUIDs, `op`/`gh` free text, and whole-value
  slots even when only part was a secret).
- `status` shows how many packs are enabled of the available (`N of M packs`), names the
  active bundle, and clears stale plugin-cache directories on uninstall; `scan` labels token
  totals as cache reads (cumulative); `crash-report` states that no send endpoint ships by
  default.

> `0.2.0` and `0.3.0` were prepared during development but did not publish to npm; their
> changes reach npm for the first time in `0.4.0`.

## [0.1.0] - 2026-09-15

### Added

- First stable release: installs a Claude Code PreToolUse hook that blocks, holds or warns
  against a bundled 56-guardrail library, with `init` / `status` / `scan` / `uninstall` /
  `guardrails` and the local decision log. No account, no network.
