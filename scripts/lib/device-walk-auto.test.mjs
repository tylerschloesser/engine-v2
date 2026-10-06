// M39f step 5/6: the service-held step machine of an auto round (auto-round.mjs), from the round log.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createAutoRound, foldItem, pageFor, withRung } from './device-walk/auto-round.mjs'
import { CHECKS } from './device-walk/checks.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents, replay } from './device-walk/rounds.mjs'

const { items } = parseChecks(
  readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8'),
)
const origins = { fixture: 'http://127.0.0.1:1' }

/** A machine over `ids` with a log in a temp dir and a fake phone API (append only). */
function rig(ids, params = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walk-auto-'))
  const file = join(dir, 'r.jsonl')
  mkdirSync(join(dir, 's'))
  const m = createAutoRound({
    file,
    items: items.filter((i) => ids.some((id) => i.id === id)),
    origins,
    params,
  })
  m.attach({ append: (e) => appendEvent(file, e) })
  let seq = 0
  const phone = (type, body = {}) => {
    const e = appendEvent(file, { type, src: { tab: 't', seq: ++seq }, ...body })
    m.react(e)
    return e
  }
  const series = (id, n, data) => {
    const path = join(dir, 's', `${id}-${n}.json`)
    writeFileSync(path, JSON.stringify(data))
    return phone('series', { id, n, path })
  }
  const events = () => readEvents(file)
  const step = () => m.stepFor(events(), Date.now())
  const results = () => events().filter((e) => e.type === 'result')
  return {
    m,
    file,
    phone,
    series,
    events,
    step,
    results,
    start: () => phone('walk', { phase: 'start' }),
  }
}

const sample = (over = {}) => ({
  isolated: true,
  adapter: 'apple/apple',
  raf_p50_ms: 16.6,
  raf_p95_ms: 16.9,
  raf_over20: 0,
  gpu_exec_p95_ms: 3,
  ...over,
})
const fillData = (over = {}, raf = {}) => ({
  windows: [
    { orientation: 'portrait', raf: { long25: 0, max: 18, frames: 100, ...raf } },
    { orientation: 'landscape', raf: { long25: 0, max: 18, frames: 100 } },
  ],
  steady: [sample(over)],
})
const bootData = (over = {}) => ({
  final: { isolated: true, adapter: 'a', workers_ready: true, delivery: 'posted Module', ...over },
})

describe('device-walk auto', () => {
  test('device-walk auto: idle until Start, then the first check opens an attempt and the phone is told where to go', () => {
    const r = rig(['M03-determinism', 'M11-boot'])
    expect(r.step()).toMatchObject({ kind: 'walk', phase: 'idle', total: 2 })
    r.start()
    expect(r.step()).toMatchObject({
      phase: 'run',
      item: {
        id: 'M03-determinism',
        n: 1,
        rung: 0,
        origin: origins.fixture,
        page: 'determinism.html',
        plan: { collector: 'global', globals: ['__determinism'] },
      },
      progress: { done: 0, total: 2 },
    })
    expect(r.events().filter((e) => e.type === 'attempt')).toEqual([
      expect.objectContaining({ id: 'M03-determinism', n: 1, variant: 'fixture', rung: 0 }),
    ])
  })

  test('device-walk auto: a collected attempt is judged on the service: criteria, a result by auto, the next check opens', () => {
    const r = rig(['M11-boot', 'M03-determinism'])
    r.start()
    r.series('M03-determinism', 1, {
      dom: { banner: 'PASS' },
      g: { __determinism: { fixtures: { a: { pass: true } }, crossOriginIsolated: true } },
    })
    const [res] = r.results()
    expect(res).toMatchObject({ id: 'M03-determinism', result: 'pass', by: 'auto', attempt: 1 })
    expect(res.criteria.every((c) => c.ok)).toBe(true)
    expect(r.step()).toMatchObject({ phase: 'run', item: { id: 'M11-boot', n: 1 } })
    r.series('M11-boot', 1, bootData())
    expect(r.step()).toMatchObject({ phase: 'done', progress: { done: 2, total: 2 } })
    expect(r.m.done()).toBe(true)
    // The log replays as M39e's state: result, notes, numbers from metrics, attempts with their criteria.
    const s = replay(r.events(), r.m.list).items.get('M11-boot')
    expect(s).toMatchObject({ result: 'pass', by: 'auto' })
    expect(s.attempts).toEqual([
      expect.objectContaining({
        n: 1,
        status: 'done',
        outcome: 'pass',
        criteria: expect.any(Array),
      }),
    ])
  })

  test('device-walk auto: a failed check without a ladder records fail with its criteria; stale data is ignored', () => {
    const r = rig(['M03-determinism'])
    r.start()
    r.series('M03-determinism', 1, {
      dom: { banner: 'FAIL' },
      g: { __determinism: { fixtures: { a: { pass: false } }, crossOriginIsolated: true } },
    })
    const [res] = r.results()
    expect(res.result).toBe('fail')
    expect(res.criteria.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'banner',
      'checkpoint_mismatches',
    ])
    const n = r.events().length
    r.series('M03-determinism', 1, { dom: { banner: 'PASS' } }) // a resend after the verdict
    expect(r.results()).toHaveLength(1)
    expect(r.events().length).toBe(n + 1) // only the series event itself was logged
  })

  test('device-walk auto: ladder rungs are further attempts; a rung that passes leaves the check failed, with the configuration in its notes', () => {
    const r = rig(['M09b-fill-rate'])
    r.start()
    expect(r.step().item.page).toBe('device.html?autopan=1&tiles=256&scale=2')
    r.series('M09b-fill-rate', 1, fillData({ raf_p95_ms: 22 }))
    expect(r.results()).toHaveLength(0) // no verdict yet: the first fallback is next
    expect(r.step()).toMatchObject({
      phase: 'run',
      item: { n: 2, rung: 1, page: 'device.html?autopan=1&tiles=256&scale=2&scaleCap=1.5' },
    })
    r.series('M09b-fill-rate', 2, fillData({ raf_p95_ms: 19 }))
    expect(r.step().item.page).toMatch(/&scaleCap=1$/)
    r.series('M09b-fill-rate', 3, fillData({ raf_p95_ms: 16 }))
    const [res] = r.results()
    expect(res).toMatchObject({ result: 'fail', by: 'auto', attempt: 3 })
    expect(res.notes).toBe('fails in its default configuration; passes with &scaleCap=1')
    expect(res.metrics.ladder_pass).toBe('&scaleCap=1')
    expect(res.criteria.find((c) => c.name === 'raf_p95_ms')).toMatchObject({
      value: 22,
      ok: false,
    }) // the default's
    const attempts = replay(r.events(), r.m.list).items.get('M09b-fill-rate').attempts
    expect(attempts.map((a) => [a.n, a.rung, a.outcome])).toEqual([
      [1, 0, 'fail'],
      [2, 1, 'fail'],
      [3, 2, 'pass'],
    ])
    expect(r.m.done()).toBe(true)
  })

  test('device-walk auto: every rung failing is one fail result naming what was tried', () => {
    const r = rig(['M11-boot'])
    r.start()
    r.series('M11-boot', 1, bootData({ workers_ready: false }))
    expect(r.step().item).toMatchObject({ n: 2, page: 'device.html?module=url' })
    r.series('M11-boot', 2, bootData({ workers_ready: false, delivery: 'url' }))
    const [res] = r.results()
    expect(res.result).toBe('fail')
    expect(res.notes).toBe('no configuration passed (tried the default, ?module=url)')
  })

  test('device-walk auto: a hitch proxy that is not clean asks one judge question; the answer settles it as mixed', () => {
    const r = rig(['M09b-fill-rate'])
    r.start()
    r.series('M09b-fill-rate', 1, fillData({}, { long25: 3 }))
    expect(r.results()).toHaveLength(0)
    const s = r.step()
    expect(s.phase).toBe('judge')
    expect(s.judge).toMatchObject({ id: 'M09b-fill-rate', n: 1 })
    expect(s.judge.text).toContain('hitch_gaps_over_25ms 3 (limit 0)')
    r.phone('answer', { id: 'M09b-fill-rate', n: 1, value: 'pass', note: 'smooth' })
    const [res] = r.results()
    expect(res).toMatchObject({ result: 'pass', by: 'mixed', notes: 'smooth' })
    expect(res.criteria.find((c) => c.name === 'hitch_gaps_over_25ms')).toMatchObject({
      ok: true,
      by: 'human',
    })
    // A "no" is a failure and moves down the ladder like a measured one.
    const r2 = rig(['M09b-fill-rate'])
    r2.start()
    r2.series('M09b-fill-rate', 1, fillData({}, { long25: 3 }))
    r2.phone('answer', { id: 'M09b-fill-rate', n: 1, value: 'fail' })
    expect(r2.results()).toHaveLength(0)
    expect(r2.step().item).toMatchObject({ n: 2, rung: 1 })
  })

  test('device-walk auto: an attempt hidden mid-measurement waits for "Redo this check", discards late data, and retries the same rung', () => {
    const r = rig(['M09b-fill-rate'])
    r.start()
    r.series('M09b-fill-rate', 1, fillData({ raf_p95_ms: 22 })) // rung 1 now
    r.phone('attempt', { id: 'M09b-fill-rate', n: 2, status: 'interrupted', reason: 'hidden' })
    expect(r.step()).toMatchObject({ phase: 'redo', item: { n: 2, rung: 1 } })
    expect(
      r
        .events()
        .filter((e) => e.type === 'attempt' && e.status !== 'interrupted' && e.status !== 'done'),
    ).toHaveLength(2)
    r.series('M09b-fill-rate', 2, fillData()) // data that raced the hide: refused
    expect(r.results()).toHaveLength(0)
    expect(foldItem(r.events(), 'M09b-fill-rate').attempts.get(2).status).toBe('interrupted')
    r.phone('redo', { id: 'M09b-fill-rate', n: 2 })
    expect(r.step()).toMatchObject({ phase: 'run', item: { n: 3, rung: 1 } })
    r.series('M09b-fill-rate', 3, fillData())
    expect(r.results()[0]).toMatchObject({ result: 'fail', attempt: 3 })
  })

  test('device-walk auto: a page that reloads mid-attempt retries by itself, twice, then fails', () => {
    const r = rig(['M03-determinism'])
    r.start()
    for (let n = 1; n <= 2; n++) {
      r.phone('attempt', { id: 'M03-determinism', n, status: 'interrupted', reason: 'reload' })
      expect(r.step()).toMatchObject({ phase: 'run', item: { n: n + 1 } })
    }
    r.phone('attempt', { id: 'M03-determinism', n: 3, status: 'interrupted', reason: 'reload' })
    expect(r.results()[0]).toMatchObject({ result: 'fail', by: 'auto' })
    expect(r.results()[0].notes).toBe('the page reloaded 3 times during the attempt')
  })

  test('device-walk auto: a reload shows as hidden first; the new document reporting it decides: a probe that must not reload fails, anything else retries', () => {
    const r = rig(['M11-memory'])
    r.start()
    r.phone('attempt', { id: 'M11-memory', n: 1, status: 'interrupted', reason: 'pagehide' })
    expect(r.step().phase).toBe('redo') // looks like a hide until the new document says otherwise
    r.series('M11-memory', 1, {
      reloaded: true,
      reloads: 1,
      final: { steps: ['(1) ceiling: 512 MiB reached', '(2) touch=0: 3s / 120s'] },
    })
    const done = r.events().find((e) => e.type === 'attempt' && e.status === 'done')
    expect(done.outcome).toBe('fail')
    expect(done.criteria.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'step_2_finished',
      'step_3_finished',
      'reloads',
    ])
    expect(done.metrics.last_line).toBe('(2) touch=0: 3s / 120s')
    expect(r.step()).toMatchObject({ phase: 'run', item: { n: 2, rung: 1 } }) // the ladder's rung follows
    // Any other check: the new document reports `reload` over the hide and the service retries by itself.
    const q = rig(['M03-determinism'])
    q.start()
    q.phone('attempt', { id: 'M03-determinism', n: 1, status: 'interrupted', reason: 'hidden' })
    q.phone('attempt', { id: 'M03-determinism', n: 1, status: 'interrupted', reason: 'reload' })
    expect(q.step()).toMatchObject({ phase: 'run', item: { n: 2, rung: 0 } })
  })

  test('device-walk auto: "Redo previous" on a finished check starts it again from its default configuration', () => {
    const r = rig(['M11-boot', 'M03-determinism'])
    r.start()
    r.series('M03-determinism', 1, {
      dom: { banner: 'PASS' },
      g: { __determinism: { fixtures: { a: { pass: true } }, crossOriginIsolated: true } },
    })
    r.phone('redo', { id: 'M03-determinism', n: 1 })
    // the open attempt of the next check finishes first; then the redone one is the first without a result
    r.series('M11-boot', 1, bootData())
    expect(r.step()).toMatchObject({ phase: 'run', item: { id: 'M03-determinism', n: 2, rung: 0 } })
    expect(r.results()).toHaveLength(2)
    const s = replay(r.events(), r.m.list).items.get('M03-determinism')
    expect(s.result).toBeNull() // cleared by the redo until the new attempt finishes
    expect(s.history.map((h) => h.redo ?? h.result)).toEqual(['pass', true])
  })

  test('device-walk auto: rows no adapter covers yet (a later delegation, or human) are skipped with that note, not left hanging', () => {
    const r = rig(['M39-sign-off', 'M38-hosted-boot', 'M35-capability', 'M03-determinism'])
    expect(r.m.list.map((i) => i.id)).toEqual([
      'M03-determinism',
      'M38-hosted-boot',
      'M39-sign-off',
    ])
    r.start()
    r.series('M03-determinism', 1, {
      dom: { banner: 'PASS' },
      g: { __determinism: { fixtures: { a: { pass: true } }, crossOriginIsolated: true } },
    })
    const res = r.results()
    expect(res.map((x) => [x.id, x.result])).toEqual([
      ['M03-determinism', 'pass'],
      ['M38-hosted-boot', 'skip'],
      ['M39-sign-off', 'skip'],
    ])
    expect(res[1].notes).toBe(
      'not automated yet (M39f delegation 4): walk it by hand with --manual',
    )
    expect(res[2].notes).toBe(
      'not automated yet (M39f delegation 4): walk it by hand with --manual',
    )
    expect(r.step().phase).toBe('done')
  })

  test('device-walk auto: M08-warn-threshold waits for the Mac-side desktop median; a failed helper opens it with null', () => {
    const r = rig(['M08-warn-threshold'])
    r.start()
    expect(r.step().phase).toBe('wait')
    expect(r.events().some((e) => e.type === 'attempt')).toBe(false)
    r.m.setDesktopMedian(0.1)
    expect(r.step()).toMatchObject({ phase: 'run', item: { id: 'M08-warn-threshold', n: 1 } })
    r.series('M08-warn-threshold', 1, { g: { __worldgenBench: { medianMs: 0.9 } } })
    const [res] = r.results()
    expect(res).toMatchObject({ result: 'fail' })
    expect(res.metrics).toMatchObject({ F: 9, desktop_median_ms: 0.1 })
    const r2 = rig(['M08-warn-threshold'])
    r2.start()
    r2.m.setDesktopMedian(null)
    r2.series('M08-warn-threshold', 1, { g: { __worldgenBench: { medianMs: 0.4 } } })
    expect(r2.results()[0].result).toBe('pass') // phone median under 0.5 ms needs no F
  })

  test('device-walk auto: ladders and pages: rungs replace or extend the query, the probe length is a test knob only', () => {
    expect(withRung('device.html', '?module=url')).toBe('device.html?module=url')
    expect(withRung('device.html?probe=memory', '&sim=64&client=32')).toBe(
      'device.html?probe=memory&sim=64&client=32',
    )
    expect(withRung('a.html', '&x=1')).toBe('a.html?x=1')
    expect(pageFor(CHECKS['M11-memory'], 0, {})).toBe('device.html?probe=memory')
    expect(pageFor(CHECKS['M11-memory'], 1, { probeS: 5 })).toBe(
      'device.html?probe=memory&sim=64&client=32&probeS=5',
    )
    expect(pageFor(CHECKS['M09b-fill-rate'], 0, { probeS: 5 })).toBe(
      'device.html?autopan=1&tiles=256&scale=2',
    )
  })

  test('device-walk auto: a page hint never decides: the service judges the data against checks.mjs', () => {
    const r = rig(['M03-determinism'])
    r.start()
    r.series('M03-determinism', 1, {
      dom: { banner: 'FAIL' },
      g: { __determinism: { fixtures: { a: { pass: false } }, crossOriginIsolated: true } },
      pass: true,
      verdictHints: [{ criterion: 'banner', ok: true }],
    })
    expect(r.results()[0].result).toBe('fail')
  })
})

describe('device-walk auto: a series after the check has its result (M39j)', () => {
  test("device-walk auto: a late series does not turn the driver's NotDrivable skip into a second verdict", () => {
    const r = rig(['M23-private'])
    r.start()
    appendEvent(r.file, {
      type: 'result',
      id: 'M23-private',
      result: 'skip',
      by: 'device',
      notes: 'NotDrivable: x',
    })
    r.series('M23-private', 1, { ready: true })
    const rows = r.events().filter((e) => e.type === 'result' && e.id === 'M23-private')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ result: 'skip', by: 'device' })
    expect(r.events().some((e) => e.type === 'attempt' && e.status === 'done')).toBe(false)
  })
})

describe('device-walk auto: a deferred judge sheet (M39j)', () => {
  test('device-walk auto: a deferred judge sheet stays open while the walk goes on, and a result closes it', () => {
    const r = rig(['M11-gestures', 'M16-slice-boot'])
    r.start()
    r.series('M11-gestures', 1, {
      steps_done: 7,
      reloads: 0,
      pointer: { pageScrolled: false, pageZoomed: false, worldPointDriftTiles: 0.1 },
      camera: { judged: 'zoom 12 to 256' },
      rotation: { shown: 'the centre moved 0.1 tiles (5 px)' },
      final: { cursor_valid: true },
    })
    expect(r.step()).toMatchObject({ phase: 'judge', item: { id: 'M11-gestures' } })
    appendEvent(r.file, { type: 'defer', id: 'M11-gestures', n: 1 })
    r.m.settle()
    expect(foldItem(r.events(), 'M11-gestures').last.deferred).toBe(true)
    expect(r.step()).toMatchObject({ phase: 'run', item: { id: 'M16-slice-boot' } })
    expect(r.results().some((e) => e.id === 'M11-gestures')).toBe(false)
    expect(r.m.done()).toBe(false)
  })
})
