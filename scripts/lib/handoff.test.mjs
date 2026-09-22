// The always-on half of docs/plan/15g-handoff-checks.md: structural invariants over `PLAN.md` and
// `PROMPT.md` that must hold at every commit, mid-milestone included (the way
// scripts/lib/context-artifacts.test.mjs already asserts repo-document invariants). The
// suite-count check lives only in `pnpm handoff` (scripts/handoff.mjs) because State's figures are
// legitimately stale between a milestone's start and its `done` commit -- tested separately below,
// on synthetic data only, never against the live repo.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  compareGround,
  countParens,
  findMissingBriefs,
  findStaleUpcomingRefs,
  findStatusMismatches,
  findUpcomingRefs,
  formatGroundMarker,
  isStatusDone,
  parensAreBalanced,
  parseBunLegCount,
  parseGroundMarker,
  parsePlanRows,
  parseRustSummary,
} from './handoff.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const planText = readFileSync(`${root}/PLAN.md`, 'utf8')
const promptText = readFileSync(`${root}/PROMPT.md`, 'utf8')
const rows = parsePlanRows(planText)

// Wrapped in one outer `describe('handoff', ...)` so `pnpm test unit -t handoff`
// (docs/plan/15g-handoff-checks.md, Verification commands) runs the whole file: vitest's `-t`
// matches against the full "describe > describe > test" name, not the file path.
describe('handoff', () => {
  describe('parsePlanRows', () => {
    test('parses the real PLAN.md table into plausible rows', () => {
      expect(rows.length).toBeGreaterThan(60)
      expect(rows[0]).toEqual({ ticked: true, id: '01', brief: '01-scaffolding.md' })
      expect(rows.every((r) => /^[0-9]{2}[a-z]?$/.test(r.id))).toBe(true)
      expect(rows.every((r) => r.brief.endsWith('.md'))).toBe(true)
    })

    test('skips the header and separator rows', () => {
      const table = [
        '| | # | Brief | Lands | After | Marks |',
        '|---|---|---|---|---|---|',
        '| [x] | 01 | `01-a.md` | thing | — | |',
        '| [ ] | 02 | `02-b.md` | other | 01 | |',
      ].join('\n')
      expect(parsePlanRows(table)).toEqual([
        { ticked: true, id: '01', brief: '01-a.md' },
        { ticked: false, id: '02', brief: '02-b.md' },
      ])
    })
  })

  describe('findUpcomingRefs / findStaleUpcomingRefs (defect 2)', () => {
    test('matches each of the four real phrasings', () => {
      const text =
        '**M16 next** and separately M17 in flight, also M18 is ready, then M19 on current order.'
      expect(findUpcomingRefs(text)).toEqual([
        { id: '16', phrase: 'M16 next' },
        { id: '17', phrase: 'M17 in flight' },
        { id: '18', phrase: 'M18 is ready' },
        { id: '19', phrase: 'M19 on current order' },
      ])
    })

    test('does not match historical narrative naming a ticked milestone ("M15b landed...")', () => {
      const planRows = [{ ticked: true, id: '15b', brief: '15b-x.md' }]
      const text = '**M15b landed the ring connection** and the client replica renders it.'
      expect(findStaleUpcomingRefs(planRows, text)).toEqual([])
    })

    // Defect 2, reproduced with the actual sentence from PROMPT.md at e4e2c9d (before 0968273 fixed
    // it): "The next milestone that adds browser tests — M15b on current order — must take 0020 §4's
    // next rung..." -- M15b was already ticked in PLAN.md when this sentence still stood.
    test('flags the real defect-2 sentence when its milestone is ticked, and stops flagging once fixed', () => {
      const planRows = [{ ticked: true, id: '15b', brief: '15b-x.md' }]
      const stale =
        'M13b was a defect fix that could not be deferred. The next milestone that adds ' +
        'browser tests — M15b on current order — must take 0020 §4’s next rung before it ' +
        'is accepted, and has no headroom left to defer with.'
      expect(findStaleUpcomingRefs(planRows, stale)).toEqual([
        { id: '15b', phrase: 'M15b on current order' },
      ])

      const fixed =
        'M13b was a defect fix that could not be deferred. That era’s standing instruction ' +
        '— the next milestone that adds browser tests must take 0020 §4’s next rung — has ' +
        'since been overtaken by measurement and must not be reused.'
      expect(findStaleUpcomingRefs(planRows, fixed)).toEqual([])
    })

    test('a ref to an unticked milestone is not stale', () => {
      const planRows = [{ ticked: false, id: '16', brief: '16-x.md' }]
      expect(findStaleUpcomingRefs(planRows, '**M16 is ready and unblocked**')).toEqual([])
    })

    test('real repo: no milestone PROMPT.md names as upcoming is already ticked in PLAN.md', () => {
      expect(findStaleUpcomingRefs(rows, promptText)).toEqual([])
    })
  })

  describe('countParens / parensAreBalanced (defect 3)', () => {
    test('counts open and close independently', () => {
      expect(countParens('a (b) (c (d))')).toEqual({ open: 3, close: 3 })
      expect(countParens('no parens here')).toEqual({ open: 0, close: 0 })
    })

    // The defect class (docs/plan/15g-handoff-checks.md Why: "a string-replace edit that closed a
    // clause early"): an edit drops the close paren that belonged to an outer clause and leaves the
    // next one to close it instead, so the file gains a `)` it never balances.
    test('flags a string-replace edit that leaves an extra close paren, passes once reverted', () => {
      const broken =
        'the next milestone — M15b on current order — must take the next rung ' +
        '(`deferred-ledger.md`)).'
      expect(parensAreBalanced(broken)).toBe(false)
      const fixed =
        'the next milestone — M15b on current order — must take the next rung ' +
        '(`deferred-ledger.md`).'
      expect(parensAreBalanced(fixed)).toBe(true)
    })

    test('real repo: PROMPT.md has balanced parens', () => {
      expect(parensAreBalanced(promptText)).toBe(true)
    })
  })

  describe('findMissingBriefs', () => {
    test('flags a PLAN.md row whose brief file does not exist, passes once it does', () => {
      const planRows = [
        { ticked: true, id: '01', brief: '01-a.md' },
        { ticked: false, id: '02', brief: '02-does-not-exist.md' },
      ]
      const existing = new Set(['01-a.md'])
      expect(findMissingBriefs(planRows, existing)).toEqual([planRows[1]])
      expect(findMissingBriefs(planRows, new Set(['01-a.md', '02-does-not-exist.md']))).toEqual([])
    })

    test('real repo: every PLAN.md brief exists under docs/plan/', () => {
      const existing = new Set(readdirSync(`${root}/docs/plan`))
      expect(findMissingBriefs(rows, existing)).toEqual([])
    })
  })

  describe('isStatusDone / findStatusMismatches', () => {
    test('reads the Status: line, ignoring a trailing parenthetical', () => {
      expect(isStatusDone('Status: done · After: 01 · Tyler-dependent: no')).toBe(true)
      expect(isStatusDone('Status: done (2026-09-19) · After: 01 · Tyler-dependent: no')).toBe(true)
      expect(isStatusDone('Status: not started · After: 01 · Tyler-dependent: no')).toBe(false)
    })

    test('flags a ticked row whose brief is not done, and an unticked row whose brief is', () => {
      const planRows = [
        { ticked: true, id: '01', brief: '01-a.md' },
        { ticked: false, id: '02', brief: '02-b.md' },
        { ticked: true, id: '03', brief: '03-c.md' },
      ]
      const doneByBrief = new Map([
        ['01-a.md', false], // ticked but not done: stale
        ['02-b.md', true], // not ticked but done: stale
        ['03-c.md', true], // ticked and done: fine
      ])
      expect(findStatusMismatches(planRows, doneByBrief)).toEqual([
        { ...planRows[0], done: false },
        { ...planRows[1], done: true },
      ])
    })

    test('a brief that could not be read (findMissingBriefs already flags it) is skipped, not double-reported', () => {
      const planRows = [{ ticked: true, id: '01', brief: '01-missing.md' }]
      expect(findStatusMismatches(planRows, new Map())).toEqual([])
    })

    test('real repo: every ticked row is done, every unticked row is not', () => {
      const doneByBrief = new Map(
        rows.map((r) => [
          r.brief,
          isStatusDone(readFileSync(`${root}/docs/plan/${r.brief}`, 'utf8')),
        ]),
      )
      expect(findStatusMismatches(rows, doneByBrief)).toEqual([])
    })
  })

  // The ground-marker parsing/formatting/comparison logic is unit-tested here on synthetic data only
  // (docs/plan/15g-handoff-checks.md Planning decisions: the suite-count check itself is
  // `pnpm handoff`'s, never the unit suite's, because it is legitimately stale mid-milestone).
  describe('ground marker (defect 1)', () => {
    test('formats and parses round-trip', () => {
      const ground = { rust: 275, unit: 157, wasm: 43, browser: 110 }
      const marker = formatGroundMarker(ground)
      expect(marker).toBe('<!-- handoff:ground rust=275 unit=157 wasm=43 browser=110 -->')
      expect(parseGroundMarker(`some text ${marker} more text`)).toEqual(ground)
    })

    test('returns null with no marker present', () => {
      expect(parseGroundMarker('no marker here')).toBe(null)
    })

    // Defect 1, reproduced: State's stale M14-era line claimed rust 235/unit 154/wasm 41/browser 98
    // while the tree actually measured 275/157/43/110.
    test('flags the real defect-1 numbers against the tree that superseded them, passes once updated', () => {
      const stale = { rust: 235, unit: 154, wasm: 41, browser: 98 }
      const actual = { rust: 275, unit: 157, wasm: 43, browser: 110 }
      expect(compareGround(stale, actual)).toEqual([
        { suite: 'rust', marker: 235, actual: 275 },
        { suite: 'unit', marker: 154, actual: 157 },
        { suite: 'wasm', marker: 41, actual: 43 },
        { suite: 'browser', marker: 98, actual: 110 },
      ])
      expect(compareGround(actual, actual)).toEqual([])
    })

    test('parseRustSummary reads nextest’s plain-text summary line', () => {
      const log = [
        '        PASS [   0.056s] (275/275) fx-worldgen::cache_invisible cache_invisible_real_worldgen',
        '──────────',
        '     Summary [   0.294s] 275 tests run: 275 passed, 0 skipped',
      ].join('\n')
      expect(parseRustSummary(log)).toBe(275)
      expect(parseRustSummary('no summary line here')).toBe(null)
    })

    test('parseBunLegCount reads the last JSON line’s tests array', () => {
      const log = 'ignored first line\n{"tests":[{"name":"a","ok":true},{"name":"b","ok":true}]}'
      expect(parseBunLegCount(log)).toBe(2)
      expect(parseBunLegCount('not json')).toBe(null)
    })
  })
})
