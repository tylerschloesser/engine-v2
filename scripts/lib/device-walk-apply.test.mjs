// M39e: `--apply`, `--status` and the CLI around them, on a scratch copy of device-checks.md.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { readDeviceChecks } from '../acceptance-check.mjs'
import { applyRound } from './device-walk/apply.mjs'
import { parseChecks, selectItems } from './device-walk/parse.mjs'
import { appendEvent, readEvents, replay } from './device-walk/rounds.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const REAL = join(REPO, 'docs/plan/device-checks.md')
const text = readFileSync(REAL, 'utf8')

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dwp-'))
  const checks = join(dir, 'device-checks.md')
  copyFileSync(REAL, checks)
  return { dir, checks, rounds: join(dir, 'rounds'), log: (r) => join(dir, 'rounds', `${r}.jsonl`) }
}
const walk = (s, ...args) =>
  spawnSync(
    process.execPath,
    [
      join(REPO, 'scripts/device-walk.mjs'),
      '--checks',
      s.checks,
      '--rounds-dir',
      s.rounds,
      ...args,
    ],
    { encoding: 'utf8' },
  )

function seed(file, evs) {
  let n = 0
  for (const e of evs)
    appendEvent(file, e, () => `2026-10-03T10:00:${String(n++).padStart(2, '0')}Z`)
}
const only = ['M03', 'M08']
const state = (file) =>
  replay(
    readEvents(file),
    selectItems(parseChecks(text).items, only).filter((i) => !i.android),
  )

describe('device-walk apply', () => {
  const events = [
    { type: 'start', only },
    { type: 'device', phone: 'iPhone 15', ios: '26.0' },
    { type: 'result', id: 'M03-determinism', result: 'fail', notes: 'hash 3' },
    { type: 'result', id: 'M03-determinism', result: 'pass', notes: 'rerun ok' },
    { type: 'result', id: 'M08-worldgen-ms-per-chunk', result: 'pass', numbers: '0.4 ms' },
    { type: 'result', id: 'M08-warn-threshold', result: 'skip' },
  ]

  test('device-walk apply: ticks passes, writes Run on lines, never ticks Android, leaves skips unticked', () => {
    const s = scratch()
    seed(s.log('r'), events)
    const { text: out, changes } = applyRound(text, state(s.log('r')), { round: 'r' })
    const { all, ticked } = readDeviceChecks(out)
    expect(ticked.has('M03-determinism')).toBe(true)
    expect(ticked.has('M08-worldgen-ms-per-chunk')).toBe(true)
    expect(ticked.has('M08-warn-threshold')).toBe(false)
    expect([...ticked].some((id) => id.endsWith('-android'))).toBe(false)
    expect(all).toEqual(readDeviceChecks(text).all)
    const run = out.split('\n').filter((l) => l.includes('[round r]'))
    expect(run).toHaveLength(2)
    expect(run[0]).toBe(
      '**Run on:** iPhone 15 iOS 26.0, 2026-10-03; **result:** M03-determinism PASS (rerun ok); Android: not run: no device [round r]',
    )
    expect(run[1]).toContain(
      'M08-worldgen-ms-per-chunk PASS (numbers: 0.4 ms); M08-warn-threshold SKIP',
    )
    expect(changes).toContain('tick M03-determinism')
    // Everything outside the touched lines is byte-identical.
    const before = text.split('\n')
    const after = out.split('\n')
    expect(after.length).toBe(before.length)
    expect(after.filter((l, i) => l !== before[i])).toHaveLength(4)
  })

  test('device-walk apply: a round run on an Android phone writes its Run on lines and ticks nothing (the ids are the iPhone rows)', () => {
    const s = scratch()
    seed(s.log('a'), [
      { type: 'start', only },
      {
        type: 'env',
        ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
      },
      { type: 'result', id: 'M03-determinism', result: 'pass', by: 'auto' },
    ])
    const { text: out, changes } = applyRound(text, state(s.log('a')), { round: 'a' })
    expect(readDeviceChecks(out).ticked.has('M03-determinism')).toBe(false)
    expect(changes.some((c) => /^tick /.test(c))).toBe(false)
    const run = out.split('\n').find((l) => l.includes('[round a]'))
    expect(run).toMatch(/Android/)
    expect(run).toContain('M03-determinism PASS')
    expect(run).not.toContain('Android: not run')
  })

  test('device-walk apply: an Android result in a hand-edited log is never ticked or written', () => {
    const s = scratch()
    seed(s.log('r'), [
      { type: 'result', id: 'M03-determinism-android', result: 'pass' },
      { type: 'result', id: 'M03-determinism', result: 'pass' },
    ])
    const all = selectItems(parseChecks(text).items, only) // Android rows included
    const { text: out } = applyRound(text, replay(readEvents(s.log('r')), all), { round: 'r' })
    expect(readDeviceChecks(out).ticked.has('M03-determinism-android')).toBe(false)
    expect(out).not.toContain('M03-determinism-android PASS')
  })

  test('device-walk apply: a second apply changes nothing; a changed result updates in place', () => {
    const s = scratch()
    seed(s.log('r'), events)
    const once = applyRound(text, state(s.log('r')), { round: 'r' })
    const twice = applyRound(once.text, state(s.log('r')), { round: 'r' })
    expect(twice.text).toBe(once.text)
    expect(twice.changes).toEqual([])
    appendEvent(s.log('r'), {
      type: 'result',
      id: 'M03-determinism',
      result: 'fail',
      notes: 'now bad',
    })
    const third = applyRound(once.text, state(s.log('r')), { round: 'r' })
    expect(third.changes.join('\n')).toMatch(/UNTICK M03-determinism.*recorded fail/)
    expect(third.text).toContain('M03-determinism FAIL (now bad)')
    expect(third.text.split('\n').filter((l) => l.includes('[round r]'))).toHaveLength(2)
  })

  test("device-walk apply: a second round adds a line and keeps the first round's", () => {
    const s = scratch()
    seed(s.log('a'), events)
    const a = applyRound(text, state(s.log('a')), { round: 'a' })
    seed(s.log('b'), [
      { type: 'start', only },
      { type: 'device', phone: 'iPhone 16', ios: '26.1' },
      { type: 'result', id: 'M03-determinism', result: 'pass' },
    ])
    const b = applyRound(a.text, state(s.log('b')), { round: 'b' })
    const m03 = b.text
      .split('\n')
      .filter((l) => l.startsWith('**Run on:**') && l.includes('M03-determinism'))
    expect(m03).toHaveLength(2)
    expect(m03[0]).toContain('[round a]')
    expect(m03[1]).toContain('iPhone 16')
  })

  test("device-walk apply: the CLI dry run writes nothing, apply writes, and acceptance:check's reader still parses", () => {
    const s = scratch()
    seed(s.log('demo'), events)
    const dry = walk(s, '--apply', 'demo', '--dry-run')
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain('tick M03-determinism')
    expect(dry.stdout).toContain('(dry run: nothing written)')
    expect(readFileSync(s.checks, 'utf8')).toBe(text)
    expect(walk(s, '--apply', 'demo').status).toBe(0)
    const applied = readFileSync(s.checks, 'utf8')
    expect(applied).not.toBe(text)
    expect(readDeviceChecks(applied).ticked.has('M03-determinism')).toBe(true)
    expect(walk(s, '--apply', 'demo').stdout).toContain('already up to date')
    expect(readFileSync(s.checks, 'utf8')).toBe(applied)
  })

  test('device-walk apply: --status --json reports counts, remaining ids and per-item history', () => {
    const s = scratch()
    seed(s.log('demo'), events)
    const out = JSON.parse(walk(s, '--status', 'demo', '--json').stdout)
    expect(out).toMatchObject({
      round: 'demo',
      total: 3,
      recorded: 3,
      only,
      device: { phone: 'iPhone 15', ios: '26.0' },
    })
    expect(out.counts).toMatchObject({ pass: 2, skip: 1, open: 0 })
    expect(out.items[0].history.map((h) => h.result)).toEqual(['fail', 'pass'])
    expect(walk(s, '--status', 'demo').stdout).toMatch(/3\/3 recorded/)
    expect(walk(s, '--status', 'nope').status).toBe(1)
  })
})
