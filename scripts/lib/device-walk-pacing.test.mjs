// M39z (ADR 0056): what a check asserts on iOS and on Android. M09b passes on the engine-owned numbers on
// iOS (rAF limits advisory), a driven iOS attempt has no pacing verdict, and the large-save tick bar is the
// iPhone's (Android reports it).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createAutoRound } from './device-walk/auto-round.mjs'
import { CHECKS, evaluate } from './device-walk/checks.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents } from './device-walk/rounds.mjs'

const IOS = { platform: 'ios', driven: false }
const ANDROID = { platform: 'android', driven: false }
const row = (r, name) => r.criteria.find((c) => c.name === name)

const gap = (o = {}) => ({ t: 1000, gap: 22, at: 1, late: 0.1, stall: 6, tasks: [], ...o })
const win = (orientation, list, sample = {}) => ({
  orientation,
  raf: { long25: 0, max: 24, frames: 3600, p50: 16.7, p95: 18 },
  gaps: { total: list.length, kept: list.length, list },
  steady: [
    {
      isolated: true,
      adapter: 'apple/apple',
      raf_p50_ms: 16.7,
      raf_p95_ms: 18,
      raf_over20: 9,
      gpu_exec_p95_ms: 2.8,
      ...sample,
    },
  ],
})
const fill = (list = [gap(), gap({ gap: 21 })], sample = {}) => {
  const a = win('portrait', list, sample)
  const b = win('landscape', list, sample)
  return { windows: [a, b], steady: [...a.steady, ...b.steady] }
}

describe('device-walk pacing: M09b-fill-rate on iOS and Android', () => {
  const entry = CHECKS['M09b-fill-rate']

  test('device-walk pacing: iOS with rAF p95 18, 9 over 20 ms, GPU 2.8 and gaps with no stall passes, rAF numbers advisory', () => {
    const r = evaluate(entry, fill(), IOS)
    expect(r.verdict).toBe('pass')
    expect(row(r, 'raf_p95_ms')).toMatchObject({ value: 18, ok: true, advisory: true })
    expect(row(r, 'raf_over20_per_10s')).toMatchObject({ value: 9, ok: true, advisory: true })
    expect(row(r, 'engine_gap_causes')).toMatchObject({ value: 0, ok: true })
  })

  test('device-walk pacing: iOS with one gap carrying stall 30 fails; so does lateness 2.5', () => {
    const stalled = evaluate(entry, fill([gap(), gap({ stall: 30 })]), IOS)
    expect(stalled.verdict).toBe('fail')
    expect(row(stalled, 'engine_gap_causes')).toMatchObject({ value: 2, ok: false })
    const late = evaluate(entry, fill([gap({ late: 2.5 })]), IOS)
    expect(late.verdict).toBe('fail')
  })

  test('device-walk pacing: iOS still fails on GPU exec over 6 ms, and a gap without attribution is not a pass', () => {
    expect(evaluate(entry, fill(undefined, { gpu_exec_p95_ms: 6.5 }), IOS).verdict).toBe('fail')
    const bare = { ...gap(), stall: undefined }
    expect(evaluate(entry, fill([bare]), IOS).verdict).toBe('fail')
  })

  test('device-walk pacing: Android with rAF p95 18 fails on the rAF limits, and has no engine-gap row', () => {
    const r = evaluate(entry, fill(), ANDROID)
    expect(r.verdict).toBe('fail')
    expect(row(r, 'raf_p95_ms')).toMatchObject({ ok: false })
    expect(row(r, 'raf_p95_ms').advisory).toBeUndefined()
    expect(row(r, 'engine_gap_causes')).toBeUndefined()
  })

  test('device-walk pacing: M18-fill-rate-with-anchors keeps the rAF limits on iOS', () => {
    const r = evaluate(CHECKS['M18-fill-rate-with-anchors'], fill(), IOS)
    expect(row(r, 'raf_p95_ms')).toMatchObject({ ok: false })
    expect(row(r, 'engine_gap_causes')).toBeUndefined()
  })

  test('device-walk pacing: a driven iOS M09b records the pacing numbers with a note and no verdict on them', () => {
    const bad = fill([gap({ stall: 40 })], { raf_p95_ms: 20.5 })
    const r = evaluate(entry, bad, { platform: 'ios', driven: true })
    expect(r.verdict).toBe('pass')
    for (const n of ['raf_p95_ms', 'raf_over20_per_10s', 'engine_gap_causes'])
      expect(row(r, n)).toMatchObject({ ok: true, advisory: true })
    expect(r.notes.join(' ')).toMatch(/driven/)
    expect(
      evaluate(entry, fill(undefined, { gpu_exec_p95_ms: 7 }), { platform: 'ios', driven: true })
        .verdict,
    ).toBe('fail')
  })
})

describe('device-walk pacing: the hitch proxies of driven iOS attempts', () => {
  const coexist = (long25) => ({
    reloads: 0,
    steady: [{ engine_mem_grows: 0 }],
    windows: [{ raf: { long25, max: 106 } }],
  })

  test('device-walk pacing: a driven iOS M16-coexist attempt has no hitch verdict', () => {
    const e = CHECKS['M16-coexist']
    const driven = evaluate(e, coexist(50), { platform: 'ios', driven: true })
    expect(driven.verdict).toBe('pass')
    expect(row(driven, 'hitch_gaps_over_25ms')).toMatchObject({ value: 50, advisory: true })
    expect(driven.notes.length).toBeGreaterThan(0)
    // Driverless, and on Android, the proxy still asks the person.
    expect(evaluate(e, coexist(11), IOS).verdict).toBe('judge')
    expect(evaluate(e, coexist(11), { platform: 'android', driven: true }).verdict).toBe('judge')
    // The memory criterion is not pacing.
    const grows = { ...coexist(0), steady: [{ engine_mem_grows: 1 }] }
    expect(evaluate(e, grows, { platform: 'ios', driven: true }).verdict).toBe('fail')
  })

  test('device-walk pacing: M29-net-heap and M34-remote-motion leave the hitch proxy unjudged when driven on iOS', () => {
    const heap = evaluate(
      CHECKS['M29-net-heap'],
      { reloads: 0, windows: [{ raf: { long25: 7, max: 90 } }] },
      { platform: 'ios', driven: true },
    )
    expect(heap.verdict).toBe('pass')
    const snaps = CHECKS['M34-remote-motion'].criteria.find((c) => c.name === 'snaps')
    expect(snaps.pacing).toBe(true)
  })
})

describe('device-walk pacing: M39-large-save', () => {
  const entry = CHECKS['M39-large-save']
  const save = (p95) => ({
    reloads: 0,
    steady: [{ engine_mem_grows_sim: 0, engine_mem_grows_client: 0, tick_p95_ms: p95 }],
  })

  test('device-walk pacing: an Android large-save with tick p95 26 is reported, not failed', () => {
    const r = evaluate(entry, save(26), ANDROID)
    expect(r.verdict).toBe('pass')
    expect(row(r, 'tick_p95_ms')).toMatchObject({ value: 26, limit: 10, ok: true, advisory: true })
    expect(r.metrics.tick_p95_ms).toBe(26)
  })

  test('device-walk pacing: an iOS large-save with tick p95 11.5 fails; 10 passes', () => {
    expect(evaluate(entry, save(11.5), IOS).verdict).toBe('fail')
    expect(evaluate(entry, save(10), IOS).verdict).toBe('pass')
    // Android memory is still judged.
    const grows = save(26)
    grows.steady[0].engine_mem_grows_sim = 1
    expect(evaluate(entry, grows, ANDROID).verdict).toBe('fail')
  })
})

describe('device-walk pacing: the round passes platform and driver mode to the verdict', () => {
  const { items } = parseChecks(
    readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8'),
  )
  const UA = {
    ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    android:
      'Mozilla/5.0 (Linux; Android 14; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  }
  const run = (ua, inspector) => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-pacing-'))
    const file = join(dir, 'r.jsonl')
    mkdirSync(join(dir, 's'))
    const m = createAutoRound({
      file,
      items: items.filter((i) => i.id === 'M09b-fill-rate'),
      origins: { fixture: 'http://127.0.0.1:1' },
      params: {},
      inspector,
    })
    m.attach({ append: (e) => appendEvent(file, e) })
    const send = (type, body) =>
      m.react(appendEvent(file, { type, src: { tab: 't', seq: 1 }, ...body }))
    send('env', { ua })
    send('walk', { phase: 'start' })
    const path = join(dir, 's', 'x.json')
    writeFileSync(path, JSON.stringify(fill()))
    send('series', { id: 'M09b-fill-rate', n: 1, path })
    return readEvents(file).find((e) => e.type === 'attempt' && e.status === 'done')
  }

  test('device-walk pacing: the same data passes on an iPhone, fails on a Pixel', () => {
    expect(run(UA.ios, undefined).outcome).toBe('pass')
    expect(run(UA.ios, 'attached').notes?.join(' ')).toMatch(/driven/)
    expect(run(UA.android, 'attached').outcome).toBe('fail')
  })
})
