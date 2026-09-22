// The Node helper that reads `packages/engine/budgets.json` (docs/decisions/0020 §9: the one
// budgets file; docs/plan/04-zero-gc-harness.md, Seams). Read once, cached: the file only changes
// between runs, never during one.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const path = fileURLToPath(new URL('../../budgets.json', import.meta.url))

export type IsolateBudget = {
  class: 'strict' | 'budgeted'
  bytesPerFrame?: number
  bytesPerMessage?: number
  formula: string
  attributionRoots: string[]
}

export type SoftwarePage = {
  frames: number
  /** `formula` is optional (docs/plan/13b-tick-timing-allocation.md): most pages' `main` figure
   * here has been `0` since ADR 0029 and needed no derivation; `sim-paced` is the first with a
   * real, measured, non-zero one and carries its own `formula` string per 0020 §9. */
  isolates: Record<string, { attributedBytesPerFrame: number; formula?: string }>
}

export type GcPageBudget = {
  isolates: Record<string, IsolateBudget>
  software: SoftwarePage | null
}

export type Budgets = {
  version: number
  gc: { pages: Record<string, GcPageBudget> }
  counters: Record<string, number>
}

let cached: Budgets | undefined

function load(): Budgets {
  cached ??= JSON.parse(readFileSync(path, 'utf8')) as Budgets
  return cached
}

/** Every registered `gc` page id (`budgets.json`'s `gc.pages` keys). */
export function gcPageIds(): string[] {
  return Object.keys(load().gc.pages)
}

/** `gc.pages.<pageId>`; throws naming the missing page (a page not yet in `budgets.json` is a bug,
 * never a silent pass). */
export function gcPage(pageId: string): GcPageBudget {
  const page = load().gc.pages[pageId]
  if (!page) throw new Error(`budgets: no gc page '${pageId}' in budgets.json`)
  return page
}

/** A dotted path into the budgets file (e.g. `counters.net.bytesPerTick`); throws when it does not
 * resolve to a number. */
export function budget(path: string): number {
  let value: unknown = load()
  for (const part of path.split('.')) {
    value =
      value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
  }
  if (typeof value !== 'number') throw new Error(`budgets: no number at '${path}' in budgets.json`)
  return value
}

/** Throws when `actual` exceeds the budget at `path` (0020 §9: raising a number is a reviewed
 * change, never something a test does for itself). */
export function expectWithinBudget(path: string, actual: number): void {
  const limit = budget(path)
  if (actual > limit) {
    throw new Error(`${path}: ${actual} exceeds budget ${limit}`)
  }
}
