<!-- cspell:words agenttrailhq hostnames -->

# Contributing to AgentTrail Guard

Thanks for helping make AI coding agents safer to run. Bug reports, rule ideas,
documentation fixes, and integration fixes are all welcome. You do not need to write code:
a small, reproducible example of an unexpected block or a missed action is one of the most
useful contributions.

By taking part, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a
security vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Where does my contribution go?

Code changes to Guard itself land here; the rules it enforces live in
[agenttrailhq/guardrails](https://github.com/agenttrailhq/guardrails). The README explains
[how the two fit together](README.md#guard-and-guardrails).

| You want to… | Where it goes |
| --- | --- |
| Report a bundled rule firing on a legitimate command (a false positive) | [Guardrails issues](https://github.com/agenttrailhq/guardrails/issues) |
| Report a dangerous command no rule catches | [Guardrails issues](https://github.com/agenttrailhq/guardrails/issues) |
| Contribute a rule, with matching and non-matching examples | [Guardrails](https://github.com/agenttrailhq/guardrails#contributing-a-rule) |
| Fix a hook, install, `status`, `scan`, or CLI problem | [Guard issues](https://github.com/agenttrailhq/guard/issues) and pull requests |
| Improve documentation | The repository the document lives in |

If you are not sure which repository fits, open a
[Guard issue](https://github.com/agenttrailhq/guard/issues) and describe what you saw.

## Reporting a bug or a false positive

Include:

- your Guard version (`agenttrail-guard --version`);
- your agent and its version;
- your operating system;
- the command or tool call involved;
- the guardrail id from `status`;
- what you expected to happen.

Share sanitized examples only: remove secrets, tokens, internal hostnames, and private
project details. `scan --review` shows you exactly what a report contains before you share
it.

## Trying a rule locally

To try a rule before proposing it, use `agenttrail-guard guardrails validate <file.json>`,
then `agenttrail-guard guardrails add <file.json>`. The rule format and what a contributed
rule needs are in the
[guardrails README](https://github.com/agenttrailhq/guardrails#contributing-a-rule).

## Development setup

Use the pnpm version pinned in `package.json`. CI runs on Node.js 22.

```sh
git clone https://github.com/agenttrailhq/guard.git
cd guard
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## Contribute with your coding agent

Using Claude Code, Cursor, or Codex CLI? From a fresh clone, paste this prompt into your agent
and fill in the last line of step 3:

```text
You are helping me contribute to AgentTrail Guard, the repository in this directory.
1. Read README.md and CONTRIBUTING.md before changing anything.
2. Run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm test`, and tell me about
   any failure before we start.
3. Help me make this change: <describe the bug or improvement>.
4. Add or update tests for any behavior change.
5. Run `pnpm lint`, `pnpm spell`, `pnpm typecheck`, and `pnpm test`. If the change affects
   the hook bundle, run `pnpm build` and include plugin/scripts/guard-hook.mjs.
6. Suggest a Conventional Commit message. Do not push, publish, or add secrets.
```

With Guard installed, your agent's commands are checked while it works on Guard.

## Before you open a pull request

Run the checks used in CI:

```sh
pnpm lint
pnpm spell
pnpm typecheck
```

- **Commit messages:** use Conventional Commits, such as `docs: clarify installation` or
  `fix: handle missing hook files`. CI checks commit messages on pull requests.
- **Tests:** add regression coverage for behavior changes.
- **The hook bundle:** it is committed because the plugin runs it directly. CI rebuilds it
  and checks that it matches the committed copy, so include the rebuilt bundle when a code
  change affects it.

## Find your way around

| Path | Contents |
| --- | --- |
| [src/commands/](src/commands/) | CLI commands: setup, status, scans, and guardrail management |
| [src/engine/](src/engine/) | Rule matching and policy evaluation |
| [src/core/](src/core/) | Agent payload mapping, configuration, logs, and report generation |
| [src/__tests__/](src/__tests__/) | Unit, integration, privacy, and runtime checks |
| [plugin/](plugin/) | Claude Code plugin and bundled scripts |

## License

AgentTrail Guard is licensed under the [Apache License 2.0](LICENSE). Under section 5 of
that license, a contribution you submit for inclusion is provided under the same terms,
unless you state otherwise.
