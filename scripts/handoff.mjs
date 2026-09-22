// `pnpm handoff`: the staleness checks `PROMPT.md`'s status block needs at a milestone's `done`
// commit (docs/plan/15g-handoff-checks.md). Quiet on success like `pnpm gate`: one line per check,
// details only on failure. Runs the four structural checks that also run inside `pnpm test`'s
// `unit` suite (scripts/lib/handoff.test.mjs), then the suite-count check, which is only meaningful
// here: State's ground marker is legitimately stale between a milestone's start and its `done`
// commit, so it never runs as a unit-suite invariant. Node + git only, no build or test run of its
// own -- run `pnpm test` first, this command reads what that run already wrote to `test-results/`.
// Exit 0: nothing flagged. Exit 1: any check flagged. Exit 2: no usable ground.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareGround,
  countParens,
  findMissingBriefs,
  findStaleUpcomingRefs,
  findStatusMismatches,
  isStatusDone,
  parseBunLegCount,
  parseGroundMarker,
  parsePlanRows,
  parseRustSummary,
} from './lib/handoff.mjs'
import { parsePlaywrightJson, parseVitestJson } from './lib/report.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
const readMaybe = (path) => {
  try {
    return read(path)
  } catch {
    return null
  }
}

const planText = read('PLAN.md')
const promptText = read('PROMPT.md')
const rows = parsePlanRows(planText)

const lines = []
let flagged = false

// 1. No milestone PROMPT.md names as upcoming/current is already ticked in PLAN.md (defect 2).
const staleRefs = findStaleUpcomingRefs(rows, promptText)
if (staleRefs.length > 0) {
  flagged = true
  lines.push(`milestones: STALE ${staleRefs.length}`)
  for (const ref of staleRefs)
    lines.push(`  M${ref.id}: ticked in PLAN.md, PROMPT.md says "${ref.phrase}"`)
} else {
  lines.push('milestones: none stale')
}

// 2. Balanced parens across PROMPT.md (defect 3).
const { open, close } = countParens(promptText)
if (open !== close) {
  flagged = true
  lines.push(`parens: UNBALANCED (${open} open, ${close} close)`)
} else {
  lines.push(`parens: balanced (${open}/${close})`)
}

// 3. Every brief PLAN.md references exists on disk.
const existingBriefs = new Set(readdirSync(join(root, 'docs/plan')))
const missingBriefs = findMissingBriefs(rows, existingBriefs)
if (missingBriefs.length > 0) {
  flagged = true
  lines.push(`briefs: MISSING ${missingBriefs.length}`)
  for (const row of missingBriefs) lines.push(`  M${row.id}: ${row.brief}`)
} else {
  lines.push(`briefs: all present (${rows.length})`)
}

// 4. Every ticked row's brief says `Status: done`, and no unticked row's brief does.
const doneByBrief = new Map(
  rows
    .filter((r) => existingBriefs.has(r.brief))
    .map((r) => [r.brief, isStatusDone(read(`docs/plan/${r.brief}`))]),
)
const statusMismatches = findStatusMismatches(rows, doneByBrief)
if (statusMismatches.length > 0) {
  flagged = true
  lines.push(`status: MISMATCHED ${statusMismatches.length}`)
  for (const m of statusMismatches) {
    lines.push(
      `  M${m.id}: PLAN.md ${m.ticked ? 'ticked' : 'unticked'}, brief Status is ${m.done ? 'done' : 'not done'}`,
    )
  }
} else {
  lines.push(`status: consistent (${rows.length})`)
}

// 5. The suite-count check (defect 1): State's ground marker against a fresh `pnpm test` run.
const marker = parseGroundMarker(promptText)
if (marker === null) {
  console.log(lines.join('\n'))
  console.log(
    'ground: NO MARKER found in PROMPT.md (docs/plan/15g-handoff-checks.md Deviations has the shape)',
  )
  process.exit(2)
}

const rustLog = readMaybe('test-results/rust/output.log')
const unitReport = readMaybe('test-results/unit/report.json')
const wasmReport = readMaybe('test-results/wasm/report.json')
const wasmBunLog = readMaybe('test-results/wasm/bun.log')
const browserReport = readMaybe('test-results/browser/report.json')

if (!rustLog || !unitReport || !wasmReport || !wasmBunLog || !browserReport) {
  console.log(lines.join('\n'))
  console.log('ground: no test-results/ report found -- run `pnpm test` first')
  process.exit(2)
}

const actual = {
  rust: parseRustSummary(rustLog),
  unit: parseVitestJson(unitReport).tests,
  wasm: parseVitestJson(wasmReport).tests + (parseBunLegCount(wasmBunLog) ?? 0),
  browser: parsePlaywrightJson(browserReport).tests,
}
if (actual.rust === null) {
  console.log(lines.join('\n'))
  console.log('ground: could not read a tests-run count from test-results/rust/output.log')
  process.exit(2)
}

const groundMismatches = compareGround(marker, actual)
if (groundMismatches.length > 0) {
  flagged = true
  lines.push(`ground: STALE ${groundMismatches.length}`)
  for (const m of groundMismatches)
    lines.push(`  ${m.suite}: marker ${m.marker}, actual ${m.actual}`)
} else {
  lines.push(
    `ground: rust ${actual.rust}, unit ${actual.unit}, wasm ${actual.wasm}, browser ${actual.browser} (matches marker)`,
  )
}

console.log(lines.join('\n'))
process.exit(flagged ? 1 : 0)
