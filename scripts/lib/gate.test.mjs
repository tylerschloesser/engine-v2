import { describe, expect, test } from 'vitest'
import { findGoldens, findMarkers, groupPaths } from './gate.mjs'

describe('groupPaths', () => {
  test('groups packages and games by two segments, everything else by one', () => {
    const paths = [
      'packages/engine/src/a.ts',
      'packages/engine/src/b.ts',
      'scripts/gate.mjs',
      'docs/spec/world.md',
    ]
    expect(groupPaths(paths)).toBe('packages/engine 2, docs 1, scripts 1')
  })

  test('caps at six groups and reports the rest', () => {
    const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((seg) => `${seg}/x.ts`)
    expect(groupPaths(paths)).toBe('a 1, b 1, c 1, d 1, e 1, f 1, +1 more')
  })
})

describe('findGoldens', () => {
  test('flags M and D, follows a rename to its new path, ignores non-golden paths', () => {
    // gate.mjs runs this once per --diff-filter (MDR, then A); the function itself just picks out
    // golden paths from whatever name-status text it is given.
    const text = [
      'M\tpackages/engine/fixtures/hash/golden/golden.json',
      'D\tpackages/engine/fixtures/other/golden/golden.json',
      'R100\told/golden/golden.json\tnew/golden/golden.json',
      'M\tpackages/engine/src/abi.ts',
    ].join('\n')
    expect(findGoldens(text)).toEqual([
      { status: 'M', path: 'packages/engine/fixtures/hash/golden/golden.json' },
      { status: 'D', path: 'packages/engine/fixtures/other/golden/golden.json' },
      { status: 'R100', path: 'new/golden/golden.json' },
    ])
  })
})

describe('findMarkers', () => {
  test('flags a marker on an added line but not on a removed or context line', () => {
    const diff = [
      'diff --git a/scripts/lib/foo.test.mjs b/scripts/lib/foo.test.mjs',
      '--- a/scripts/lib/foo.test.mjs',
      '+++ b/scripts/lib/foo.test.mjs',
      '@@ -1,3 +1,3 @@',
      " test('a', () => {})",
      "-test('b', () => {})",
      "+test.skip('b', () => {})",
    ].join('\n')
    expect(findMarkers(diff)).toEqual([
      { path: 'scripts/lib/foo.test.mjs', line: "test.skip('b', () => {})" },
    ])
  })

  test('ignores docs/ and the gate files themselves', () => {
    const diff = [
      '+++ b/docs/plan/03-foo.md',
      "+run `pnpm test -t '.skip('` to check",
      '+++ b/scripts/lib/gate.mjs',
      "+  'test.skip',",
    ].join('\n')
    expect(findMarkers(diff)).toEqual([])
  })

  test('does not mistake process.exit( for the xit( marker', () => {
    const diff = ['+++ b/scripts/foo.mjs', '+process.exit(code)'].join('\n')
    expect(findMarkers(diff)).toEqual([])
  })

  test('reports the count and per-file entries elsewhere', () => {
    const diff = [
      '+++ b/packages/engine/src/a.test.ts',
      "+test.only('x', () => {})",
      '+++ b/crates/engine/src/lib.rs',
      '+    #[ignore]',
    ].join('\n')
    expect(findMarkers(diff)).toEqual([
      { path: 'packages/engine/src/a.test.ts', line: "test.only('x', () => {})" },
      { path: 'crates/engine/src/lib.rs', line: '#[ignore]' },
    ])
  })
})
