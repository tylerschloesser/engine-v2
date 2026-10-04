// `pnpm acceptance:check` (docs/plan/39-acceptance.md, "Evidence check, mechanical"): reads the
// coverage tables in docs/plan/acceptance/ (format: that directory's README.md) and fails, one
// line per problem (`file:line  reason`), when
//   (a) a `test: <suite> "<title>"` entry names a title that is not a real, not-skipped test in
//       that suite's tree;
//   (b) a `device: <ID>` is not a ticked `- [x] **<ID>**` line of docs/plan/device-checks.md, or
//       is an `-android` id;
//   (c) a Status is `gap` or not one of the four allowed forms (or has no evidence it needs);
//   (d) a `guard:` entry has no `test:`/`lint:` entry beside it.
// Quiet on success: one line.
//
// Title lookup mirrors `packages/engine/src/engine-events.test.ts`'s `findTest` (a `test(`/`it(`
// string literal, a skipping modifier makes it skipped) rather than importing it: that one is
// TypeScript inside `src/` (typechecked, shipped config) and reads only the engine and reference
// trees as TS, while this needs Rust, `test.each` ids, template-literal titles and suite mapping.
// Matching is on the literal passed to `test(...)`, never the runner's `describe > title` path.

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bench', 'target', 'test-results', '.git'])
const SKIPPING = new Set(['skip', 'fixme', 'todo'])
// Modifiers that carry an argument list before the title's own call: `test.each(rows)('t')`,
// `test.skipIf(cond)('t')`.
const ARG_MODIFIERS = new Set(['each', 'runIf', 'skipIf'])
const TS_MODIFIERS = new Set([
  ...SKIPPING,
  ...ARG_MODIFIERS,
  'only',
  'slow',
  'fails',
  'concurrent',
  'sequential',
  'serial',
  'parallel',
])
const TS_FILE = /\.(test|spec)\.(ts|mjs)$/

/**
 * Suite id -> where its tests live, the way scripts/suites.mjs, vitest.config.ts and
 * packages/engine/playwright.config.ts place them. `files` picks the test files inside `dirs`.
 */
export const SUITE_TREES = {
  rust: {
    kind: 'rust',
    dirs: ['packages/engine/crates', 'packages/engine/fixtures', 'games/reference/sim'],
    files: /\.rs$/,
  },
  unit: {
    kind: 'ts',
    dirs: [
      'packages/engine/src',
      'packages/engine/tests/browser/gc',
      'packages/engine/tests/support',
      'scripts',
      'games/reference/src',
      'games/reference/scripts',
    ],
    files: /\.test\.(ts|mjs)$/,
  },
  wasm: { kind: 'ts', dirs: ['packages/engine/tests/wasm'], files: TS_FILE },
  netcode: {
    kind: 'ts',
    dirs: ['packages/engine/tests/netcode', 'games/reference/tests/netcode'],
    files: TS_FILE,
  },
  // Any `.ts` under the browser dirs: shared builders such as `gc/suite.ts` declare titles too.
  browser: {
    kind: 'ts',
    dirs: ['packages/engine/tests/browser', 'games/reference/tests/browser'],
    files: /\.ts$/,
  },
  'frame-bench': {
    kind: 'ts',
    dirs: ['packages/engine/tests/browser'],
    files: /\.ts$/,
  },
}

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

// --- reading declarations ------------------------------------------------------------------------

/** Index of the `)` matching the `(` at `open`, skipping string literals; -1 if unbalanced. */
function matchParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(text, i)
      if (end < 0) return -1
      i = end
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** Index of the quote closing the literal opened at `start` (template `${}` not nested-parsed). */
function stringEnd(text, start) {
  const q = text[start]
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === q) return i
    else if (q !== '`' && text[i] === '\n') return -1
  }
  return -1
}

const unescapeLiteral = (s) => s.replace(/\\(.)/g, '$1')
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A `test.each` title template as a whole-title regex: `%s`, `%d`, `%#`... match anything. */
function eachPattern(template) {
  const parts = unescapeLiteral(template).split(/(%%|%[sdifjoOp#$]|\$\{[^}]*\}|\$\w+(?:\.\w+)*)/)
  const body = parts
    .map((p, i) => (i % 2 === 0 ? escapeRegex(p) : p === '%%' ? '%' : '.+'))
    .join('')
  return new RegExp(`^${body}$`)
}

/** A template-literal title with `${...}` holes as a regex (a hole matches any text). */
function templatePattern(raw) {
  const parts = unescapeLiteral(raw).split(/(\$\{[^}]*\})/)
  return new RegExp(`^${parts.map((p, i) => (i % 2 === 0 ? escapeRegex(p) : '.+')).join('')}$`)
}

/** Every `test`/`it` declaration in a Vitest/Playwright file: `{ exact | pattern, skipped }`. */
export function readTsDeclarations(text) {
  const out = []
  const start = /\b(?:test|it)(?=[.(])/g
  for (let m = start.exec(text); m; m = start.exec(text)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue
    if (/[\w$.]/.test(text[m.index - 1] ?? '')) continue
    let i = m.index + m[0].length
    let skipped = false
    let each = false
    let ok = true
    while (text[i] === '.') {
      const name = /^\.(\w+)/.exec(text.slice(i))?.[1]
      if (!name || !TS_MODIFIERS.has(name)) {
        ok = false
        break
      }
      i += name.length + 1
      if (SKIPPING.has(name)) skipped = true
      if (name === 'each') each = true
      if (ARG_MODIFIERS.has(name)) {
        while (/\s/.test(text[i] ?? '')) i++
        if (text[i] !== '(') {
          ok = false
          break
        }
        const close = matchParen(text, i)
        if (close < 0) {
          ok = false
          break
        }
        i = close + 1
      }
    }
    if (!ok) continue
    while (/\s/.test(text[i] ?? '')) i++
    if (text[i] !== '(') continue
    i++
    while (/\s/.test(text[i] ?? '')) i++
    const q = text[i]
    if (q !== '"' && q !== "'" && q !== '`') continue
    const end = stringEnd(text, i)
    if (end < 0) continue
    const raw = text.slice(i + 1, end)
    if (each) out.push({ pattern: eachPattern(raw), skipped })
    else if (q === '`' && raw.includes('${')) out.push({ pattern: templatePattern(raw), skipped })
    else out.push({ exact: unescapeLiteral(raw), skipped })
    start.lastIndex = end
  }
  return out
}

/** Every `#[test] fn name` in a Rust file; `#[ignore]` counts as skipped. */
export function readRustDeclarations(text) {
  const out = []
  const re =
    /#\[(?:tokio::)?test(?:\([^\]]*\))?\]((?:\s*#\[[^\]]*\]|\s*\/\/[^\n]*)*)\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ exact: m[2], skipped: /#\[ignore\b/.test(m[1] ?? '') })
  }
  return out
}

/**
 * `(suite, title) -> { found: path | null, skipped }`, reading each suite's tree once. A literal
 * `test('title')` (or Rust fn) is found by the scan. A title that only a template or `test.each`
 * produces (`${pageId} clean`, `reference_race_same_spot 0 ms, winner 0`) is found in `lister(suite)`
 * when one is given (the runners' own `--list`: a `Map` of title -> file), and otherwise (the unit
 * test's hermetic fixtures) by matching the template's pattern.
 */
export function createTitleLookup(root, lister = null) {
  const cache = new Map()
  const index = (suite) => {
    const tree = SUITE_TREES[suite]
    const decls = []
    for (const dir of tree.dirs) {
      for (const path of walk(join(root, dir))) {
        if (!tree.files.test(path)) continue
        const text = readFileSync(path, 'utf8')
        const read = tree.kind === 'rust' ? readRustDeclarations : readTsDeclarations
        for (const d of read(text)) decls.push({ ...d, path: relative(root, path) })
      }
    }
    // scripts/suites.mjs names the Bun leg's tests (they are not `test(` literals).
    if (suite === 'wasm') {
      try {
        const suites = readFileSync(join(root, 'scripts', 'suites.mjs'), 'utf8')
        const block = /name: 'bun'[\s\S]*?tests: \[([\s\S]*?)\]/.exec(suites)?.[1] ?? ''
        for (const t of block.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
          decls.push({ exact: unescapeLiteral(t[1]), skipped: false, path: 'scripts/suites.mjs' })
        }
      } catch {}
    }
    return decls
  }
  const listed = new Map()
  return (suite, title) => {
    if (!cache.has(suite)) cache.set(suite, index(suite))
    const decls = cache.get(suite)
    const exact = decls.filter((d) => d.exact === title)
    const live = exact.find((d) => !d.skipped)
    if (live) return { found: live.path, skipped: false }
    if (exact[0]) return { found: exact[0].path, skipped: true }
    const patterned = decls.filter((d) => d.pattern?.test(title))
    if (lister && SUITE_TREES[suite].kind === 'ts') {
      if (!listed.has(suite)) listed.set(suite, lister(suite))
      // Vitest lists a `test.each`/template title unexpanded (`... %i ms ...`, `${when}`): such a
      // listed name matches the cited id as a pattern.
      const names = listed.get(suite)
      let entry = names.get(title)
      if (!entry) {
        for (const [name, e] of names) {
          if (/%[sdifjoOp#$]|\$\{/.test(name) && eachPattern(name).test(title)) {
            entry = e
            break
          }
        }
      }
      if (!entry) return { found: null, skipped: false }
      const skipped = entry.skipped || (patterned.length > 0 && patterned.every((d) => d.skipped))
      return { found: entry.file, skipped }
    }
    const livePattern = patterned.find((d) => !d.skipped)
    if (livePattern) return { found: livePattern.path, skipped: false }
    if (patterned[0]) return { found: patterned[0].path, skipped: true }
    return { found: null, skipped: false }
  }
}

/**
 * The runners' own title lists: `vitest list --json` (unit, wasm, netcode: a name is
 * `describe > ... > title`, so every ` > ` suffix is a title) and `playwright test --list
 * --reporter=json` (browser, frame-bench: `spec.title` is the bare title). Neither needs a browser
 * or a build; ~1 s each. Returns `suite -> Map(title -> { file, skipped })`; throws on a failed run.
 */
export function createRunnerLister(root) {
  const run = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (r.status !== 0 || !r.stdout) {
      throw new Error(
        `\`${cmd} ${args.join(' ')}\` failed: ${(r.stderr || r.error || '').toString().trim().split('\n')[0]}`,
      )
    }
    return JSON.parse(r.stdout)
  }
  const playwright = (projects) => {
    const args = ['exec', 'playwright', 'test', '--list', '--reporter=json']
    for (const p of projects) args.push('--project', p)
    const report = run('pnpm', args, join(root, 'packages', 'engine'))
    const out = new Map()
    const visit = (s) => {
      for (const spec of s.specs ?? []) {
        const skipped = (spec.tests ?? []).every((t) => t.expectedStatus === 'skipped')
        const prev = out.get(spec.title)
        if (!prev || (prev.skipped && !skipped)) out.set(spec.title, { file: spec.file, skipped })
      }
      for (const c of s.suites ?? []) visit(c)
    }
    for (const s of report.suites ?? []) visit(s)
    return out
  }
  return (suite) => {
    if (suite === 'frame-bench') return playwright(['frame-bench'])
    if (suite === 'browser') {
      return playwright([
        'chromium',
        'gc',
        'reference',
        'gc-reference',
        'webkit',
        'firefox',
        'packaging',
      ])
    }
    const out = new Map()
    for (const t of run('pnpm', ['exec', 'vitest', 'list', '--json', '--project', suite], root)) {
      const parts = t.name.split(' > ')
      for (let i = 0; i < parts.length; i++) {
        const title = parts.slice(i).join(' > ')
        if (!out.has(title)) out.set(title, { file: relative(root, t.file), skipped: false })
      }
    }
    return out
  }
}

// --- reading the tables --------------------------------------------------------------------------

/** Split on `; ` outside double quotes. */
function splitEvidence(cell) {
  const parts = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < cell.length; i++) {
    const c = cell[i]
    if (c === '"') inQuote = !inQuote
    if (!inQuote && c === ';' && cell[i + 1] === ' ') {
      parts.push(cur.trim())
      cur = ''
      i++
    } else cur += c
  }
  parts.push(cur.trim())
  return parts
}

/** Table data rows of one file: `{ line, cells }`, or `{ line, bad }` for a malformed row. */
export function readRows(text) {
  const rows = []
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim()
    if (!line.startsWith('|')) continue
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'))
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
    if (cells[0] === '#' && cells[1] === 'Item') continue
    if (cells.length !== 4) {
      rows.push({
        line: n + 1,
        bad: `row has ${cells.length} cells, expected 4 (escape a literal | as \\|)`,
      })
    } else rows.push({ line: n + 1, cells })
  }
  return rows
}

/** Device check ids of docs/plan/device-checks.md: `{ all, ticked }`. */
export function readDeviceChecks(text) {
  const all = new Set()
  const ticked = new Set()
  for (const m of text.matchAll(/^- \[([ xX])\] \*\*([^*]+)\*\*/gm)) {
    all.add(m[2])
    if (m[1] !== ' ') ticked.add(m[2])
  }
  return { all, ticked }
}

// A short parenthetical note may follow the title: `test: unit "x" (what it asserts)`.
const TEST_ENTRY = /^test: (\S+) "(.*)"(?: \([^"]*\))?$/
// Files under docs/plan/acceptance/ that are not coverage tables (their own column layouts).
const NOT_COVERAGE = new Set([
  'README.md',
  'budgets.md',
  'deferred-ledger-audit.md',
  'plan-audit.md',
])
const STATUS_NA = /^not applicable \(.+\)$/

/**
 * Check every table. Returns `{ problems: string[], rows, files }`; `problems` are
 * `file:line  reason` lines.
 */
export function checkAcceptance({ root = REPO, lister = null, deviceChecks = null } = {}) {
  const dir = join(root, 'docs', 'plan', 'acceptance')
  const problems = []
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !NOT_COVERAGE.has(f))
    .sort()
  let devices = { all: new Set(), ticked: new Set() }
  try {
    // `deviceChecks`: another copy of the checklist (the device-round demonstration's applied scratch copy).
    devices = readDeviceChecks(
      readFileSync(deviceChecks ?? join(root, 'docs', 'plan', 'device-checks.md'), 'utf8'),
    )
  } catch {
    problems.push('docs/plan/device-checks.md:1  cannot read the device checklist')
  }
  const lookup = createTitleLookup(root, lister)
  let rowCount = 0
  if (files.length === 0) problems.push('docs/plan/acceptance:1  no acceptance tables found')

  for (const file of files) {
    const rel = `docs/plan/acceptance/${file}`
    const rows = readRows(readFileSync(join(dir, file), 'utf8'))
    if (rows.length === 0) problems.push(`${rel}:1  no table rows`)
    for (const row of rows) {
      const at = `${rel}:${row.line}`
      if (row.bad) {
        problems.push(`${at}  ${row.bad}`)
        continue
      }
      rowCount++
      const [id, , evidenceCell, statusCell] = row.cells
      const label = `row ${id}`
      const bad = (reason) => problems.push(`${at}  ${label}: ${reason}`)

      const status = statusCell
      const statusOk =
        status === 'covered' || status === 'device' || status === 'gap' || STATUS_NA.test(status)
      if (status === 'gap') bad('status is `gap`')
      else if (!statusOk)
        bad(`status "${status}" is not covered, device, gap or not applicable (<reason>)`)

      const kinds = { test: 0, device: 0, lint: 0, guard: 0, adr: 0 }
      const entries = evidenceCell === '-' ? [] : splitEvidence(evidenceCell)
      for (const entry of entries) {
        const kind = /^(test|device|guard|lint|adr): /.exec(entry)?.[1]
        if (!kind) {
          bad(`evidence entry "${entry}" is not test:/device:/guard:/lint:/adr:`)
          continue
        }
        kinds[kind]++
        const body = entry.slice(kind.length + 2).trim()
        if (kind === 'test') {
          const m = TEST_ENTRY.exec(entry)
          if (!m) bad(`test entry "${entry}" is not \`test: <suite> "<title>"\``)
          else if (!SUITE_TREES[m[1]]) bad(`unknown suite "${m[1]}" in "${entry}"`)
          else {
            let r
            try {
              r = lookup(m[1], m[2])
            } catch (e) {
              bad(`cannot list the ${m[1]} suite's tests: ${e.message}`)
              continue
            }
            const { found, skipped } = r
            if (!found) bad(`test "${m[2]}" is not in the ${m[1]} tree`)
            else if (skipped) bad(`test "${m[2]}" is skipped (${found})`)
          }
        } else if (kind === 'device') {
          if (/-android$/.test(body))
            bad(`device check ${body} is an Android check: never evidence`)
          else if (!devices.all.has(body))
            bad(`device check ${body} is not in docs/plan/device-checks.md`)
          else if (!devices.ticked.has(body)) bad(`device check ${body} is not ticked`)
        } else if (body === '') bad(`empty ${kind} entry`)
        else if (kind === 'adr' && !/^\d{4}\b/.test(body))
          bad(`adr entry "${entry}" is not \`adr: <NNNN> <§>\``)
      }

      if (kinds.guard > 0 && kinds.test + kinds.lint === 0) {
        bad('`guard:` has no `test:` or `lint:` entry beside it')
      }
      if (status !== 'gap' && statusOk && !STATUS_NA.test(status)) {
        if (kinds.test + kinds.device + kinds.lint === 0)
          bad(`status ${status} needs a test:, device: or lint: entry`)
        else if (status === 'covered' && kinds.test + kinds.lint === 0)
          bad('status covered needs a test: or lint: entry')
        else if (status === 'device' && kinds.device === 0)
          bad('status device needs a device: entry')
      }
      if (STATUS_NA.test(status) && entries.length === 0 && evidenceCell !== '-') {
        bad('not applicable row needs `-` or an adr: entry as evidence')
      }
    }
  }
  return { problems, rows: rowCount, files: files.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--device-checks')
  const { problems, rows, files } = checkAcceptance({
    lister: createRunnerLister(REPO),
    deviceChecks: at > 0 ? process.argv[at + 1] : null,
  })
  if (problems.length > 0) {
    for (const p of problems) console.log(p)
    process.exit(1)
  }
  console.log(`acceptance pass ${rows} rows in ${files} files`)
}
