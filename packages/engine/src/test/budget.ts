// `assertBudget` (docs/plan/31-rates-and-integrity.md Seams; docs/decisions/0020-testing-strategy.md
// §9): the exact value a scenario recorded, and the ceiling it may never pass.
//
// A row lives at `counters.net.<row>` in `packages/engine/budgets.json`:
//   { "counter": "<dotted path into the counters object>", "exact": N, "ceiling": M, "source": "..." }
// `assertBudget(counters, 'net.<row>')` reads `counter` out of `counters`, then requires
// `value === exact` and `value <= ceiling`. `exact` is a recorded fact, so a change to it is a
// reviewed edit of `budgets.json`, never something a test does for itself.

interface NetRow {
  counter: string
  exact: number
  ceiling: number
  source: string
}

let cached: unknown

function loadBudgets(): unknown {
  if (cached !== undefined) return cached
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  const fs = proc?.getBuiltinModule?.('node:fs') as
    | { readFileSync(path: URL, enc: 'utf8'): string }
    | undefined
  if (!fs) throw new Error('assertBudget: needs Node (it reads packages/engine/budgets.json)')
  cached = JSON.parse(fs.readFileSync(new URL('../../budgets.json', import.meta.url), 'utf8'))
  return cached
}

function at(root: unknown, path: string): unknown {
  let v = root
  for (const part of path.split('.')) {
    v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined
  }
  return v
}

/** The row's recorded numbers; throws naming a missing or malformed row. */
export function netBudgetRow(row: string): NetRow {
  const r = at(loadBudgets(), `counters.${row}`) as Partial<NetRow> | undefined
  if (
    !r ||
    typeof r.counter !== 'string' ||
    typeof r.exact !== 'number' ||
    typeof r.ceiling !== 'number' ||
    typeof r.source !== 'string'
  ) {
    throw new Error(
      `assertBudget: budgets.json has no complete row 'counters.${row}' (needs counter, exact, ceiling, source)`,
    )
  }
  return r as NetRow
}

/** Throws (message names `row`) unless `counters[row.counter] === row.exact` and it is at most
 * `row.ceiling`. */
export function assertBudget(counters: object, row: string): void {
  const r = netBudgetRow(row)
  const value = at(counters, r.counter)
  if (typeof value !== 'number') {
    throw new Error(`assertBudget ${row}: counters has no number at '${r.counter}'`)
  }
  if (value > r.ceiling) {
    throw new Error(`assertBudget ${row}: ${r.counter} = ${value} exceeds ceiling ${r.ceiling}`)
  }
  if (value !== r.exact) {
    throw new Error(
      `assertBudget ${row}: ${r.counter} = ${value}, recorded exact value is ${r.exact} (ceiling ${r.ceiling})`,
    )
  }
}
