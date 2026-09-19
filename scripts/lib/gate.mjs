// Pure parts of `pnpm gate` (scripts/gate.mjs): grouping changed paths, scanning a diff for
// test-disabling markers, and picking golden paths out of `git diff --name-status`. Nothing here
// touches git or the file system, so the test drives it with canned strings. Contract:
// docs/decisions/0025-phase-3-orchestration.md §3.

const MAX_GROUPS = 6

/** `packages/<name>` and `games/<name>` group together; everything else groups by its top segment. */
function groupOf(path) {
  const parts = path.split('/')
  return parts[0] === 'packages' || parts[0] === 'games' ? parts.slice(0, 2).join('/') : parts[0]
}

/** `packages/engine 17, scripts 3, docs 3`, biggest groups first, capped at `MAX_GROUPS` + more. */
export function groupPaths(paths) {
  const counts = new Map()
  for (const path of paths) counts.set(groupOf(path), (counts.get(groupOf(path)) ?? 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = sorted.slice(0, MAX_GROUPS).map(([group, n]) => `${group} ${n}`)
  const rest = sorted.length - MAX_GROUPS
  if (rest > 0) shown.push(`+${rest} more`)
  return shown.join(', ')
}

/** Golden paths out of `git diff --name-status[...]`: renames report their new-side path. */
export function findGoldens(nameStatusText) {
  const found = []
  for (const line of nameStatusText.split('\n')) {
    if (!line.trim()) continue
    const [status, ...rest] = line.split('\t')
    const path = status.startsWith('R') || status.startsWith('C') ? rest[1] : rest[0]
    if (path?.includes('/golden/')) found.push({ status, path })
  }
  return found
}

const MARKER_WORDS = [
  '.skip(',
  '.only(',
  '.todo(',
  '.skipIf(',
  '.fails(',
  'xit(',
  'xtest(',
  'xdescribe(',
  '#[ignore',
  'test.fixme',
  'test.skip',
]

// A leading `\b` on the word-shaped markers keeps e.g. `xit(` from matching inside `process.exit(`;
// the dotted and `#[` markers cannot false-positive that way, so they stay plain substrings.
const MARKER_PATTERNS = MARKER_WORDS.map((word) => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(/^[A-Za-z]/.test(word) ? `\\b${escaped}` : escaped)
})

const IGNORED_FILES = new Set([
  'scripts/gate.mjs',
  'scripts/lib/gate.mjs',
  'scripts/lib/gate.test.mjs',
])

/**
 * Test-disabling markers on `+` lines of a unified diff (`git diff -U0 <base>..HEAD`), skipping
 * `docs/` and the gate's own files (which contain the marker strings themselves).
 */
export function findMarkers(diffText) {
  const found = []
  let file = null
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4)
      file = path === '/dev/null' ? null : path.replace(/^b\//, '')
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    if (!file || file.startsWith('docs/') || IGNORED_FILES.has(file)) continue
    const content = line.slice(1)
    if (MARKER_PATTERNS.some((re) => re.test(content))) {
      found.push({ path: file, line: content.trim().slice(0, 80) })
    }
  }
  return found
}
