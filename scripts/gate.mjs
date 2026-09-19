// `pnpm gate <base>`: the acceptance gate an orchestrating session runs after a sub-agent finishes
// a milestone (docs/decisions/0025-phase-3-orchestration.md §3). git + node:child_process only, no
// build or test run; at most ten lines. Exit 0: nothing flagged. Exit 1: dirty tree, an existing
// golden changed, or a test-disabling marker added. Exit 2: no usable <base>. Pure logic lives in
// scripts/lib/gate.mjs.
import { execFileSync } from 'node:child_process'
import { findGoldens, findMarkers, groupPaths } from './lib/gate.mjs'

const base = process.argv[2]
if (!base) {
  console.log('usage: pnpm gate <base>')
  process.exit(2)
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

try {
  execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], { stdio: 'ignore' })
} catch {
  console.log(`gate: "${base}" does not resolve to a commit`)
  process.exit(2)
}

const lines = []
let flagged = false

const dirty = git(['status', '--porcelain'])
  .split('\n')
  .filter((l) => l.trim() !== '')
flagged ||= dirty.length > 0
lines.push(dirty.length > 0 ? `tree: DIRTY (${dirty.length} paths)` : 'tree: clean')

const changed = git(['diff', '--name-only', `${base}..HEAD`])
  .split('\n')
  .filter(Boolean)
lines.push(`files: ${changed.length} changed${changed.length ? ` (${groupPaths(changed)})` : ''}`)

const goldensChanged = findGoldens(
  git(['diff', '--name-status', '--diff-filter=MDR', `${base}..HEAD`]),
)
const goldensAdded = findGoldens(git(['diff', '--name-status', '--diff-filter=A', `${base}..HEAD`]))
if (goldensChanged.length > 0) {
  flagged = true
  lines.push('goldens: CHANGED')
  const shown = goldensChanged.slice(0, 3)
  lines.push(...shown.map(({ path }) => `  ${path}`))
  if (goldensChanged.length > 3) lines.push(`  +${goldensChanged.length - 3} more`)
} else {
  lines.push(`goldens: none changed (${goldensAdded.length} added)`)
}

const markers = findMarkers(git(['diff', '-U0', `${base}..HEAD`]))
if (markers.length > 0) {
  flagged = true
  lines.push(`markers: ADDED ${markers.length}`)
  const shown = markers.slice(0, 3)
  lines.push(...shown.map(({ path, line }) => `  ${path}: ${line}`))
  if (markers.length > 3) lines.push(`  +${markers.length - 3} more`)
} else {
  lines.push('markers: none added')
}

const shortstat = git(['diff', '--shortstat', `${base}..HEAD`]).trim() || 'no changes'
const commits = git(['rev-list', '--count', `${base}..HEAD`]).trim()
lines.push(`diff: ${shortstat} (${commits} commits)`)

console.log(lines.join('\n'))
process.exit(flagged ? 1 : 0)
