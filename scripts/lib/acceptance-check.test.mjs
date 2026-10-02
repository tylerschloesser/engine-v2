// `scripts/acceptance-check.mjs` (docs/plan/39-acceptance.md): fixture tables over a throwaway
// repo layout. A missing test name, a gap row and an unticked device id each fail; a good table
// passes. Hermetic: nothing here reads the real `docs/plan/acceptance/`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { checkAcceptance } from '../acceptance-check.mjs'

const HEAD = '| # | Item | Evidence | Status |\n|---|---|---|---|\n'
let root

function put(rel, text) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Check a one-file table; returns the problem lines. */
function check(rows) {
  put('docs/plan/acceptance/unit-a.md', HEAD + rows)
  return checkAcceptance({ root }).problems
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'acceptance-check-'))
  put(
    'packages/engine/src/a.test.ts',
    [
      "import { test, it } from 'vitest'",
      "test('real title', () => {})",
      "it.skip('skipped title', () => {})",
      "test.each([1, 2])('each id %s', () => {})",
      "describe('outer', () => { test('nested title', () => {}) })",
    ].join('\n'),
  )
  put('packages/engine/crates/engine/src/x.rs', '#[test]\nfn rust_real() {}\n')
  put(
    'docs/plan/device-checks.md',
    '- [x] **M01-ticked** text\n- [ ] **M02-open** text\n- [x] **M03-thing-android** text\n',
  )
  put('docs/plan/acceptance/README.md', 'not a table\n')
  put('docs/plan/acceptance/budgets.md', '| a | b |\n| x | y |\n')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('acceptance-check', () => {
  test('a good table passes', () => {
    const rows = [
      '| R1 | one | test: unit "real title"; test: unit "nested title"; test: rust "rust_real" | covered |',
      '| R2 | two | test: unit "each id 7"; guard: x breaks; lint: tsc | covered |',
      '| R3 | three | device: M01-ticked | device |',
      '| R4 | four | - | not applicable (non-goal) |',
    ].join('\n')
    expect(check(rows)).toEqual([])
    expect(checkAcceptance({ root })).toMatchObject({ rows: 4, files: 1 })
  })

  test('a missing or skipped test name fails', () => {
    const problems = check(
      [
        '| R1 | one | test: unit "no such title" | covered |',
        '| R2 | two | test: unit "skipped title" | covered |',
        '| R3 | three | test: rust "rust_missing" | covered |',
      ].join('\n'),
    )
    expect(problems).toHaveLength(3)
    expect(problems[0]).toMatch(/^docs\/plan\/acceptance\/unit-a\.md:3 {2}.*no such title/)
    expect(problems[1]).toMatch(/skipped/)
  })

  test('a template title is found through the runner list, and only there', () => {
    put(
      'docs/plan/acceptance/unit-a.md',
      `${HEAD}| R1 | one | test: unit "sim clean"; test: unit "ghost clean" | covered |`,
    )
    const lister = () => new Map([['sim clean', { file: 'gc/suite.ts', skipped: false }]])
    const problems = checkAcceptance({ root, lister }).problems
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/ghost clean/)
  })

  test('a gap row fails', () => {
    const problems = check('| R1 | one | test: unit "real title" | gap |')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/gap/)
  })

  test('an unticked, unknown or android device id fails', () => {
    const problems = check(
      [
        '| R1 | one | device: M02-open | device |',
        '| R2 | two | device: M09-nope | device |',
        '| R3 | three | device: M03-thing-android | device |',
      ].join('\n'),
    )
    expect(problems).toHaveLength(3)
    expect(problems[0]).toMatch(/not ticked/)
  })

  test('a bare guard, a bad status and bad evidence fail', () => {
    const problems = check(
      [
        '| R1 | one | guard: breaks; device: M01-ticked | device |',
        '| R2 | two | test: unit "real title" | maybe |',
        '| R3 | three | by hand | covered |',
      ].join('\n'),
    )
    expect(problems.join('\n')).toMatch(/guard:.*no `test:` or `lint:`/)
    expect(problems.join('\n')).toMatch(/status "maybe"/)
    expect(problems.join('\n')).toMatch(/not test:/)
  })
})
