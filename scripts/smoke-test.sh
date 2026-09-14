#!/usr/bin/env bash
# Installs a packed @agenttrail/guard tarball into an empty directory with an empty HOME and runs
# it: the CLI prints its usage, and the hook bundle denies `rm -rf /` and allows `ls`.
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

# Prints the permission decision the hook returns for a Bash command.
decision() {
  node -e 'process.stdout.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: process.argv[1] } }))' "$1" |
    node "$hook" |
    node -e 'const o = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(o.hookSpecificOutput.permissionDecision)'
}

got="$(decision 'rm -rf /')"
if [ "$got" != "deny" ]; then
  echo "error: 'rm -rf /' returned $got, expected deny" >&2
  exit 1
fi
echo "  ok  rm -rf / -> deny"

got="$(decision 'ls')"
if [ "$got" != "allow" ]; then
  echo "error: 'ls' returned $got, expected allow" >&2
  exit 1
fi
echo "  ok  ls -> allow"
