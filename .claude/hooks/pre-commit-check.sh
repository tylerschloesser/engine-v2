#!/usr/bin/env bash
# PreToolUse gate on `git commit` (docs/decisions/0021 §6): the two checks that need no compile.
# Exit 0 silently for anything that is not a commit or cannot be parsed; exit 2 with the fix
# command on stderr when a check fails. Tested by scripts/lib/pre-commit-check.test.mjs.

input=$(cat)

# Prints the tool call's cwd and exits 0 only when some shell segment of the command is a
# `git commit` (the `if` pattern in settings.json also fires on commands that merely contain one).
cwd=$(node -e '
  const { tool_input, cwd } = JSON.parse(process.argv[1])
  const word = String.raw`(?:"[^"]*"|\x27[^\x27]*\x27|\S+)`
  const commit = new RegExp(String.raw`^git(?:\s+-[cC]\s+${word})*\s+commit(?:\s|$)`)
  const isCommit = tool_input.command
    .split(/&&|\|\||[;|\n`]|\$\(/)
    .map((s) => s.trim().replace(/^(?:\w+=\S*\s+)+/, ""))
    .some((s) => commit.test(s))
  if (!isCommit) process.exit(1)
  console.log(cwd || ".")
' "$input" 2>/dev/null) || exit 0

top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || top=$CLAUDE_PROJECT_DIR
cd "$top" 2>/dev/null || exit 0

if [ ! -x node_modules/.bin/biome ]; then
  echo 'run: pnpm install' >&2
  exit 2
fi

# Both checks at once, on the working tree (not the index: `git add -A && git commit` has staged
# nothing when this fires).
tmp=$(mktemp -d)
trap 'command rm -rf "$tmp"' EXIT
node_modules/.bin/biome check . >"$tmp/biome" 2>&1 &
biome_pid=$!
cargo fmt --check >"$tmp/rustfmt" 2>&1
rustfmt_status=$?
wait "$biome_pid"
biome_status=$?

[ "$biome_status" -eq 0 ] && [ "$rustfmt_status" -eq 0 ] && exit 0

if [ "$biome_status" -ne 0 ]; then
  head -n 30 "$tmp/biome" >&2
  echo 'fix: pnpm exec biome check --write .' >&2
fi
if [ "$rustfmt_status" -ne 0 ]; then
  head -n 30 "$tmp/rustfmt" >&2
  echo 'fix: cargo fmt' >&2
fi
exit 2
