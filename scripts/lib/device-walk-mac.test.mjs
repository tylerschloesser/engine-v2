// M39f step 14: the Mac's own browsers in an auto round (`client: 'both'`): which tab is handed which row, the
// legs of a row that runs in two browsers, the assisted `human` rows of M17b, a browser without WebGPU, and
// the Mac's facts kept apart from the phone's in the **Run on** line.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { applyRound } from './device-walk/apply.mjs'
import { browserOf, createAutoRound } from './device-walk/auto-round.mjs'
import { CHECKS, evaluate } from './device-walk/checks.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents, replay } from './device-walk/rounds.mjs'
import { readPristineChecks } from './device-walk/test-checks.mjs'

// Pristine (M39ad): a live --apply round ticks rows and adds Run on lines this test must not depend on.
const text = readPristineChecks(new URL('../../docs/plan/device-checks.md', import.meta.url))
const { items } = parseChecks(text)

function rig(ids, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walk-mac-'))
  const file = join(dir, 'r.jsonl')
  mkdirSync(join(dir, 's'))
  const attempts = []
  const legs = []
  const m = createAutoRound({
    file,
    items: items.filter((i) => ids.includes(i.id)),
    origins: { fixture: 'https://tunnel.example', 'reference-bench': 'https://tunnel2.example' },
    macOrigins: { fixture: 'http://127.0.0.1:1', 'reference-bench': 'http://127.0.0.1:2' },
    params: { client: 'both', ...extra },
    onAttempt: (a) => attempts.push(a),
    onLeg: (l) => legs.push(l),
  })
  m.attach({ append: (e) => appendEvent(file, e) })
  let seq = 0
  const phone = (type, body = {}, tab = 't') => {
    const e = appendEvent(file, { type, src: { tab, seq: ++seq }, ...body })
    m.react(e)
    return e
  }
  const series = (id, n, data, tab) => {
    const path = join(dir, 's', `${id}-${n}.json`)
    writeFileSync(path, JSON.stringify(data))
    return phone('series', { id, n, path }, tab)
  }
  const events = () => readEvents(file)
  return {
    m,
    file,
    attempts,
    legs,
    phone,
    series,
    events,
    step: (tab) => m.stepFor(events(), Date.now(), tab),
    results: () => events().filter((e) => e.type === 'result'),
    start: () => phone('walk', { phase: 'start' }),
  }
}

const ok = {
  ready: true,
  windows: [{ raf: { long25: 0 } }],
  gpu: { errors: 0 },
  pageErrors: 0,
  ran: true,
}

describe('device-walk mac', () => {
  test('device-walk mac: the phone walks its rows first; a Mac row is handed only to a Mac tab, on the loopback origin', () => {
    const r = rig(['M35-safari-build-mac', 'M11-boot'])
    expect(r.m.list.map((i) => i.id)).toEqual(['M11-boot', 'M35-safari-build-mac'])
    expect(r.m.macOnly()).toBe(false)
    r.start()
    expect(r.step('t')).toMatchObject({
      phase: 'run',
      item: { id: 'M11-boot', origin: 'https://tunnel.example' },
    })
    // The Mac tab waits for its own row.
    expect(r.step('macsafari-1')).toMatchObject({ phase: 'wait', waitFor: 'phone' })
    r.series('M11-boot', 1, {
      ready: true,
      final: { isolated: true, adapter: 'apple/x', workers_ready: true, delivery: 'posted Module' },
    })
    expect(r.step('t')).toMatchObject({ phase: 'wait', waitFor: 'mac' })
    expect(r.attempts.at(-1)).toMatchObject({ id: 'M35-safari-build-mac' })
    expect(r.attempts.at(-1).plan.browsers).toEqual(['safari'])
    expect(r.step('macsafari-1')).toMatchObject({
      phase: 'run',
      item: { id: 'M35-safari-build-mac', variant: 'reference' },
    })
  })

  test('device-walk mac: a round of only Mac rows needs no phone', () => {
    expect(rig(['M11-pinch-desktop-safari', 'M39-desktop-browsers']).m.macOnly()).toBe(true)
    expect(rig(['M11-pinch-desktop-safari', 'M03-determinism']).m.macOnly()).toBe(false)
  })

  test('device-walk mac: a row in two browsers: each tab gets its own leg, leg-done opens the next, the last leg sends the data', () => {
    const r = rig(['M39-desktop-browsers'])
    r.start()
    const safari = 'macsafari-1'
    const ff = 'macfirefox-2'
    expect(r.step(safari)).toMatchObject({
      phase: 'run',
      item: {
        id: 'M39-desktop-browsers',
        origin: 'http://127.0.0.1:2',
      },
    })
    expect(r.step(ff)).toMatchObject({ phase: 'wait', waitFor: 'mac safari' })
    r.phone(
      'reading',
      { id: 'M39-desktop-browsers', n: 1, key: 'leg:0', data: { k: 0, browser: 'safari' } },
      safari,
    )
    expect(r.legs).toEqual([])
    r.phone(
      'reading',
      { id: 'M39-desktop-browsers', n: 1, key: 'leg-done', data: { k: 0 } },
      safari,
    )
    expect(r.legs).toEqual([expect.objectContaining({ id: 'M39-desktop-browsers', n: 1, k: 1 })])
    expect(r.step(safari)).toMatchObject({ phase: 'wait', waitFor: 'mac firefox' })
    expect(r.step(ff)).toMatchObject({
      phase: 'run',
      item: { state: { 'leg:0': { browser: 'safari' } } },
    })
    r.series('M39-desktop-browsers', 1, ok, ff)
    expect(r.results()).toEqual([
      expect.objectContaining({ id: 'M39-desktop-browsers', result: 'pass', by: 'auto' }),
    ])
  })

  test('device-walk mac: Firefox without WebGPU is recorded and the row is skip with that evidence; a failure elsewhere stays a failure', () => {
    const r = rig(['M39-desktop-browsers'])
    r.start()
    r.series('M39-desktop-browsers', 1, {
      ...ok,
      unsupported: ['firefox: no navigator.gpu (Firefox/143.0)'],
    })
    expect(r.results()[0]).toMatchObject({ result: 'skip', by: 'auto' })
    expect(r.results()[0].notes).toContain('firefox: no navigator.gpu')
    const f = rig(['M39-desktop-browsers'])
    f.start()
    f.series('M39-desktop-browsers', 1, {
      ...ok,
      gpu: { errors: 2 },
      unsupported: ['firefox: no navigator.gpu'],
    })
    expect(f.results()[0]).toMatchObject({ result: 'fail' })
    // A hitch gap above 25 ms is a judge prompt, never a skip.
    const h = rig(['M39-desktop-browsers'])
    h.start()
    h.series('M39-desktop-browsers', 1, {
      ...ok,
      windows: [{ raf: { long25: 3 } }],
      unsupported: ['firefox: no navigator.gpu'],
    })
    expect(h.step('macsafari-1').phase).toBe('judge')
  })

  test('device-walk mac: M17b is a human row the page assists: its errors are judged by the service, the allocation numbers are one judge sheet', () => {
    const entry = CHECKS['M17b-harness-desktop-safari']
    expect(entry.class).toBe('human')
    expect(entry.criteria).toEqual([])
    const bad = evaluate(entry, { harness: { ran: true, errors: 1, memoryTotal: 1 } })
    expect(bad.verdict).toBe('fail')
    expect(bad.criteria.find((c) => c.name === 'gpu_errors')).toMatchObject({ value: 1, ok: false })
    const r = rig(['M17b-harness-desktop-safari'])
    r.start()
    expect(r.step('macsafari-1')).toMatchObject({ phase: 'run' })
    expect(r.step('macfirefox-2')).toMatchObject({ phase: 'wait', waitFor: 'mac safari' })
    r.series(
      'M17b-harness-desktop-safari',
      1,
      { harness: { ran: true, errors: 0, memoryTotal: 4096, viewProbe: true } },
      'macsafari-1',
    )
    const judge = r.step('macsafari-1')
    expect(judge.phase).toBe('judge')
    expect(judge.judge.text).toMatch(/Timelines panel/)
    r.phone(
      'answer',
      { id: 'M17b-harness-desktop-safari', n: 1, value: 'pass', note: '40 KB, 0 markers' },
      'macsafari-1',
    )
    expect(r.results()[0]).toMatchObject({ result: 'pass', by: 'mixed', notes: '40 KB, 0 markers' })
    // No WebGPU in the browser at all (Firefox here): recorded, the row is skip with that evidence.
    const none = rig(['M17b-harness-desktop-firefox'])
    none.start()
    none.series(
      'M17b-harness-desktop-firefox',
      1,
      {
        ready: false,
        noRun: true,
        unsupported: ['firefox: no navigator.gpu'],
        harness: { ran: false },
      },
      'macfirefox-1',
    )
    expect(none.results()[0]).toMatchObject({ result: 'skip', by: 'auto' })
    // A harness that never ran is a failure, not a pass by absence.
    expect(evaluate(entry, { harness: { ran: false, errors: null } }).verdict).toBe('fail')
  })

  test('device-walk mac: the pinch row asks the person only whether the zoom follows the cursor', () => {
    const r = rig(['M11-pinch-desktop-safari'])
    r.start()
    r.series(
      'M11-pinch-desktop-safari',
      1,
      { pointer: { pageZoomed: false }, camera: { tilesAcrossChanged: true, pinchEvents: 12 } },
      'macsafari-1',
    )
    expect(r.step('macsafari-1').phase).toBe('judge')
    r.phone('answer', { id: 'M11-pinch-desktop-safari', n: 1, value: 'pass' }, 'macsafari-1')
    expect(r.results()[0]).toMatchObject({ result: 'pass', by: 'mixed' })
    const z = rig(['M11-pinch-desktop-safari'])
    z.start()
    z.series(
      'M11-pinch-desktop-safari',
      1,
      { pointer: { pageZoomed: true }, camera: { tilesAcrossChanged: true, pinchEvents: 12 } },
      'macsafari-1',
    )
    expect(z.results()[0]).toMatchObject({ result: 'fail', by: 'auto' })
  })

  test('device-walk mac: a Mac tab id names its browser', () => {
    expect(browserOf('macsafari-3')).toBe('safari')
    expect(browserOf('macfirefox-abc')).toBe('firefox')
  })

  test("device-walk mac: a Mac tab's env never replaces the phone's; Run on names the Mac's browsers and adapters", () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-mac-'))
    const file = join(dir, 'r.jsonl')
    const phoneUa =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1'
    const macUa =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15'
    appendEvent(file, {
      type: 'env',
      ua: phoneUa,
      gpu: { vendor: 'apple', architecture: 'apple' },
      src: { tab: 'ab', seq: 1 },
    })
    appendEvent(file, {
      type: 'env',
      ua: macUa,
      gpu: { vendor: 'apple', architecture: 'metal-3' },
      src: { tab: 'macsafari-1', seq: 1 },
    })
    appendEvent(file, {
      type: 'result',
      id: 'M11-pinch-desktop-safari',
      result: 'pass',
      by: 'mixed',
    })
    appendEvent(file, { type: 'result', id: 'M11-boot', result: 'pass', by: 'auto' })
    const walked = items.filter((i) => ['M11-pinch-desktop-safari', 'M11-boot'].includes(i.id))
    const st = replay(readEvents(file), walked)
    expect(st.env.ua).toBe(phoneUa)
    expect([...st.macEnvs.keys()]).toEqual([macUa])
    const { text: out } = applyRound(text, st, { round: 'r', overrides: {} })
    const runOn = out
      .split('\n')
      .find((l) => l.startsWith('**Run on:**') && l.includes('M11-pinch-desktop-safari PASS'))
    expect(runOn).toMatch(/iPhone, iOS 18\.7/)
    expect(runOn).toMatch(/Mac \(macOS; Safari 26\.1, adapter apple\/metal-3\)/)
  })
})
