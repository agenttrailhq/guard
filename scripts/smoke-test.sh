#!/usr/bin/env bash
# Installs a packed @agenttrail/guard tarball into an empty directory with an empty HOME and runs
# it: the CLI prints its usage, the hook bundle denies `rm -rf /`, and it writes nothing for `ls`.
#
# Usage: bash scripts/smoke-test.sh <tarball>
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: bash scripts/smoke-test.sh <tarball>" >&2
  exit 2
fi

tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
work="$(mktemp -d)"
export HOME="$work/home"
mkdir -p "$HOME" "$work/consumer"
cd "$work/consumer"

npm init -y >/dev/null
npm install --no-audit --no-fund "$tarball" >/dev/null

./node_modules/.bin/agenttrail-guard --help >/dev/null
echo "  ok  agenttrail-guard --help"

hook=node_modules/@agenttrail/guard/plugin/scripts/guard-hook.mjs

# Prints what the hook writes to stdout for a Bash command.
hook_output() {
  node -e 'process.stdout.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: process.argv[1] } }))' "$1" |
    node "$hook"
}

got="$(hook_output 'rm -rf /' | node -e 'const o = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(o.hookSpecificOutput?.permissionDecision ?? "none")')"
if [ "$got" != "deny" ]; then
  echo "error: 'rm -rf /' returned $got, expected deny" >&2
  exit 1
fi
echo "  ok  rm -rf / -> deny"

# No output leaves the call to Claude Code's own permission prompt; "allow" would skip that prompt.
got="$(hook_output 'ls')"
if [ -n "$got" ]; then
  echo "error: 'ls' returned $got, expected no output" >&2
  exit 1
fi
echo "  ok  ls -> no output"
