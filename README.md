<!-- cspell:words guardrails jsonl -->

# `@agenttrail/guard`

Local guardrails for Claude Code. Before your AI agent runs a command or touches a
file, the guard checks it against a guardrail library and answers one of three things:
**go ahead**, **ask the human**, or **no**.

**No account, no sign-up.** Out of the box the guard makes no network calls and sends
us nothing — not telemetry, not the commands it sees, not an install ping.

**The one exception is crash reporting, which is off unless you turn it on and sends
stack traces only.** Both halves of that sentence are true and you should have both.
When it is on, a crash is recorded to a file on your machine; nothing is transmitted
until you run `agenttrail-guard crash-report --send` yourself. Stack traces are
scrubbed for secrets *and* for file paths before they go anywhere — a raw stack
carries your username, your project's name and your client's name, and we do not want
those either. No commands, no file contents, no environment variables, ever.

```
agenttrail-guard crash-report            # what is on, and what is waiting
agenttrail-guard crash-report --enable   # opt in
agenttrail-guard crash-report --send     # transmit, only if you enabled it
agenttrail-guard crash-report --clear    # delete everything spooled
```

## Install

```sh
npx @agenttrail/guard init
```

That does two things, and nothing else. It writes its own two files under
`~/.agenttrail/guard/`, and it asks Claude Code to install the hook as a plugin.
**It never touches the `hooks` block in your `settings.json`** — Claude Code owns
that file, and the guard's hook lives inside the plugin instead.

`init` finishes by running a synthetic `rm -rf /` through the real guardrail engine and
showing you it being blocked. Nothing is executed; it is a demonstration, so you can
see it work before anything real runs through it.

Want to look before you leap? `npx @agenttrail/guard init --print` shows you exactly
what it would do and changes nothing.

## The commands

| | |
|---|---|
| `agenttrail-guard init` | Install the hook, seed the config, demonstrate itself. Safe to re-run. |
| `agenttrail-guard status` | What is enforcing, what it has been doing, and — if one guardrail keeps firing on something legitimate — the one line that silences just that guardrail. `--clear-history` empties the decision log. |
| `agenttrail-guard guardrails` | See and change what the guard enforces. |
| `agenttrail-guard scan` | Read the sessions already on your disk and say what your agent has been doing. |
| `agenttrail-guard uninstall` | Remove our plugin and only ours. Safe to re-run. Your settings stay in `~/.agenttrail/guard/` until you delete them. |

If you already have the agenttrail plugin installed, `init` will tell you so and
stop. Two hooks deciding on every tool call means two prompts and twice the latency,
for no benefit.

> **Status.** Every command above is implemented, and so is the decision log. The
> bundled catalog is the real guardrail library: 56 guardrails across 8 packs.

## When a guardrail is wrong

The most likely reason to remove this tool is one guardrail firing repeatedly on
something legitimate. `agenttrail-guard guardrails` is the alternative to hand-editing
JSON or uninstalling.

```
guardrails list [--pack <name>] [--enabled|--disabled]   what is on, and what is not
guardrails show <guardrail-id>                           everything about one guardrail
guardrails enable|disable <guardrail-id|pack>            turn a guardrail or a whole pack on/off
guardrails set-action <guardrail-id> block|ask|warn      change what a guardrail does
guardrails add <file.json>                               install a guardrail you wrote
guardrails remove <guardrail-id>                         delete one of your own guardrails
guardrails allow <guardrail-id> <pattern>                silence ONE guardrail on ONE shape
guardrails reset [<guardrail-id>|--all]                  undo your changes
guardrails validate [<file>]                             the same check CI runs
```

Shared flags: `--json`, `--quiet`, `--config <dir>`.

**`allow` is the one that matters.** It suppresses one guardrail on one command shape
and nothing else — the same guardrail keeps blocking everything else, and the others are
untouched. `agenttrail-guard status` names the guardrail that has been firing most and
prints the exact line to paste.

It will **refuse** a pattern that would quietly do more than you asked. `*`, `**` and
anything starting with `!` match every command, so allowlisting one would disable that
guardrail entirely while `guardrails list` still showed it enabled. Patterns are matched in
`/`-separated segments, so no `*` crosses a `/`; give `**` a segment of its own
(`./generated/**`) to cover a subtree.

**One word to get right.** You type `ask`, and the tool prints `ask` — but the value
stored in `config.json` and `guardrails.json` is `require_approval`. That is the vocabulary
the guardrail engine uses. Writing `"ask"` into either file by hand does not work:
`guardrails.json` reports it as invalid, and `config.json` **silently ignores it**, which is
why `status` now lists settings it had to drop.

## Seeing what already happened

```sh
agenttrail-guard scan
```

Claude Code already keeps a transcript of every session on your disk. `scan` reads
them, replays every tool call through the same guardrails the hook enforces, and tells
you what your agent has actually been doing — how many sessions, which guardrails would
have fired, which mistakes repeat, and exact token counts with the cache split.

It reads local files and nothing else. No account, no upload, and `scan` itself makes
no network call — the one exception anywhere in this tool is crash reporting, which is
off unless you turn it on, and which `scan` never touches.

You get two things: a summary in the terminal, and one self-contained
`agenttrail-guard-report.html` in the directory you ran it from. That file is a single
document with its styles inline. It references nothing outside itself, so it opens from
a `file://` URL with the wifi off and cannot phone home when someone else opens it.

**It is built to be shared, so it is redacted before it is written.** Every command goes
through the secret scrubber, then a path redactor, then an identifier redactor: `<path>`
stands for a filesystem path or URL, `<name>` / `<host>` / `<user>` / `<message>` for an
identifying operand of a command, and `[REDACTED:…]` for a secret. Working directories
and file paths appear nowhere in it, and the projects your sessions came from are a
*count* and never names, because the install is per-machine and your projects are your
business.

**Identifying names are a weaker claim than paths, and the difference matters.** A path
is structural — a token either has a separator or it does not — so redacting one is a
total rule. A name is not: `acme-prod-db` is a container to a human and an ordinary word
to a regex. The identifier redactor closes that by knowing a fixed list of tools —
container runtimes, `kubectl`, the database clients, `ssh`, and `git` messages — so it is
a deny-list, and it will miss the tool nobody thought of. **Redaction is thorough but not
a guarantee.** Run `scan --review` to read every line the file will contain before it is
written, and read it before you post it anywhere public.

**There is no money in it.** Counts are counts and token totals come straight off the
transcript, so both are exact. There is no dollar figure anywhere, not even one labelled
"estimated" — a risk number is a count multiplied by an assumption, and the assumption is
the part that is wrong.

```
scan --dir <root>   read transcripts from somewhere other than ~/.claude/projects
scan --json         print the result as JSON and write no file
scan --open         open the report once it is written
scan --review       print every line the report will contain, and ask before writing it
```

## What the guard does not do

Read this before you rely on it. A security tool that overstates its coverage is
worse than one that names the hole.

- **The guard does not see what the agent fetches from the web.** `WebFetch` is not
  intercepted, and there are no website guardrails in v1. The underlying engine can
  match on a command string and on a file path — it has no matcher for a URL — so a
  URL guardrail would have validated, installed, and then matched nothing, forever,
  without telling anyone. Rather than ship a channel whose guardrails only appear to
  work, v1 leaves web traffic out and says so here. `WebSearch` **is** covered,
  because a search query is ordinary text on the command channel.
- **It does not stop an action it cannot see.** The guard runs as a Claude Code
  `PreToolUse` hook. Anything the agent does outside a hooked tool is invisible to it.
- **It does not redact what it lets through.** The guard decides about a command; it
  never rewrites one. Secrets are redacted from what the guard itself *writes* — the
  decision log, the `scan` report and a crash report all go through the scrubber — but
  a command that contains a secret and is allowed still runs exactly as the agent
  wrote it.
- **Its redaction is good, not complete.** Every command written to `events.jsonl` is
  scrubbed first — AWS keys, GitHub and Slack tokens, JWTs, private keys, connection
  strings, `.env`-style assignments, emails, and card numbers all become
  `[REDACTED:…]`. What it does **not** catch is a secret passed as a bare command-line
  argument, with no `=` or `:` between the name and the value: the patterns are
  anchored to an assignment, so `--token abc123` reads as two ordinary words. Treat
  the log as scrubbed, not sanitized.
- **The `scan` report's name redaction is a deny-list.** Paths are redacted
  structurally, so that rule is total. Names are not: the identifier redactor knows a
  fixed list of tools — container runtimes, `kubectl`, the database clients, `ssh`, and
  `git` messages — and a bare operand naming a container, a namespace, a host or a
  database survives for any tool that is not on it. The pass exists because a container
  name is neither a secret shape nor a path, so the other two redactors do not catch it.
- **A guardrail's id and title are printed as their author wrote them.** For the shipped
  library that is our words. For a guardrail *you* added to `guardrails.json` it is yours,
  and nothing redacts it: a title reading "AcmeCorp internal audit" appears in the report
  verbatim. Paths and secrets pasted into a title *are* taken out — the title goes
  through the same three passes as a command — but a name you chose is not something a
  redactor can distinguish from a word. Run `scan --review` to read every line, commands
  and guardrail names both, before the file is written.
- **The 30-day limit on the decision log is a ceiling, not a sweep.** Old records are
  dropped when the log is compacted, and compaction happens when it crosses 1 MiB. On
  a machine that stops using Claude Code, the last half-megabyte of records stays
  until either another decision is recorded or you run `status --clear-history`. The
  bound that always holds is the size one.
- **It is one developer on one machine.** Nothing syncs, nothing is shared with a
  team, and there is no approval queue.

## Rules of the runtime

Three properties hold on every single invocation, and each has a test that fails the
build if it stops holding:

1. **It always exits 0, and can never exit 2.** Exit 2 is Claude Code's blocking
   signal and overrides the JSON decision, including `allow`. The hook bundle
   contains no `process.exit` at all, so this is structural rather than a pattern
   someone remembered to grep for.
2. **It writes at most one JSON object to stdout and nothing else**: exactly one JSON object
   when it blocks, asks or warns, and no output when nothing matches. Output that
   does not start `{` and end `}` is discarded as plain text and the tool call
   proceeds. One stray log line would make the guard decorative.
3. **It fails open, and never answers `allow`.** A PreToolUse `allow` skips Claude
   Code's own permission prompt, so the guard leaves every call it does not block or
   hold to Claude Code's normal permission flow. A parse error or internal throw gives
   no decision, only a message that the call was not checked. If our code has a bug,
   your command goes through Claude Code's normal permission flow.

## Files it keeps

Four files, all under `~/.agenttrail/guard/`, all written at mode `0600`. The guard
writes nothing else anywhere — not in your project, not in your Claude Code settings
— with exactly one exception: `scan` writes `agenttrail-guard-report.html` into the
directory you run it from, because that file is for you to read and share.

- `config.json` — enabled packs, per-guardrail action overrides, and the
  per-guardrail allowlist. Written by `init` if it is absent, and never overwritten after that.
- `guardrails.json` — your own guardrails, enforced alongside the bundled ones. Starts as
  `[]`; `guardrails add` writes to it. One here that is invalid is skipped, not fatal,
  and **`status` is where you find out** — a hook's stderr goes to a debug log you will
  never read, so that is the only place it can tell you. A file that is corrupt
  entirely is ignored, and the bundled guardrails keep working.
- `events.jsonl` — the guard's own record of what it decided. One line per tool call
  that matched a guardrail: the time, the tool, the decision, the guardrail id, and the
  command. It is what lets `status` tell you which guardrail is the noisy one.

  We say we send you nothing, and separately we keep a file listing commands your
  assistant ran. Both are true, so here is exactly what that file is. **It never
  leaves your machine** — nothing in the guard transmits it, and there is no code path
  that could. **Every command in it is scrubbed before it is written**, not on the way
  out. **It does not grow forever**: it is capped at 1 MiB, and older records are
  dropped past 30 days. **You can empty it whenever you like** with
  `agenttrail-guard status --clear-history`, and deleting the file outright is always
  safe — the guard simply starts a new one.
- `crashes/` — crash reports waiting to be sent, and only if you turned crash
  reporting on. Scrubbed stack traces only, capped at 20 files and 30 days. Nothing
  here is transmitted unless you run `crash-report --send` yourself, and deleting the
  directory is always safe.

`uninstall` deliberately leaves all of them in place. They are your settings, and
finding them silently gone after a reinstall would be worse than finding them there.

## Building this from source

```sh
pnpm install
pnpm build
pnpm test
```

`dependencies` is empty: the published package bundles everything it runs, including the
rule-matching engine in `src/engine/` and the guardrail library. The library is its own package,
`@agenttrail/guardrails`. Guardrail contributions belong there, and
`agenttrail-guard guardrails validate <file>` runs the same schema check locally that its CI runs on
a pull request.

## License

Apache-2.0.
