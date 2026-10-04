// M39f steps 10-12: the service side of the reference game's checks (checks.mjs entries and auto-round.mjs):
// M35 and M37b on the release build (DOM only), M39-large-save and M39-frame-shares on the bench build, M34
// against the bot partner. Criteria evaluation at, above and below each limit; the Mac-row rule.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { applyRound } from './device-walk/apply.mjs'
import { createAutoRound } from './device-walk/auto-round.mjs'
import { CHECKS, evaluate } from './device-walk/checks.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents, replay } from './device-walk/rounds.mjs'

const { items } = parseChecks(
  readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8'),
)
const ok = (r, name) => r.criteria.find((c) => c.name === name)?.ok

const dom = (over = {}) => ({
  capability: false,
  fatal: false,
  canvas: true,
  canvas_w: 1170,
  canvas_h: 2532,
  delivery_line: false,
  ...over,
})
const m35 = (over = {}, gpu = {}, extra = {}) => ({
  ready: true,
  dom: dom(over),
  raf: { p50: 16.7, p95: 16.9, max: 20, long25: 0, frames: 480 },
  gpu: { devices: 1, errors: 0, lost: 0, ...gpu },
  reloads: 0,
  ...extra,
})

describe('device-walk reference', () => {
  test('device-walk reference: M35 passes only on a clean DOM and device, and always asks for the confirm tap', () => {
    for (const id of ['M35-safari-build-mac', 'M35-safari-build-iphone']) {
      const clean = evaluate(CHECKS[id], m35())
      expect(clean.verdict, id).toBe('judge') // every hard row ok, "world drawn" is the person's
      expect(clean.criteria.filter((c) => c.ok === false)).toEqual([])
      expect(ok(clean, 'world_drawn')).toBe(null)
      expect(clean.metrics.raf_p95_ms).toBe(16.9)
    }
    const e = CHECKS['M35-safari-build-iphone']
    expect(ok(evaluate(e, m35({ capability: true })), 'capability_screen')).toBe(false)
    expect(ok(evaluate(e, m35({ fatal: true })), 'fatal_screen')).toBe(false)
    expect(ok(evaluate(e, m35({ canvas: false })), 'canvas_present')).toBe(false)
    expect(ok(evaluate(e, m35({ delivery_line: true })), 'delivery_line_absent')).toBe(false)
    expect(ok(evaluate(e, m35({}, { errors: 1 })), 'gpu_errors')).toBe(false)
    expect(ok(evaluate(e, m35({}, { lost: 1 })), 'device_lost')).toBe(false)
    expect(evaluate(e, m35({}, {}, { reloads: 1 })).verdict).toBe('fail')
    expect(evaluate(e, { ready: false }).verdict).toBe('fail') // no data at all is a failure, never a pass
  })

  const run = (over = {}) => ({
    run: 1,
    ms: 180_000,
    deviceLost: 1,
    gpuErrors: 0,
    rendererLost: false,
    rafResumed: true,
    frozen: false,
    ...over,
  })
  test('device-walk reference: M37b needs three runs, none frozen or black, no reload; the banner is allowed', () => {
    const e = CHECKS['M37b-ios-background']
    const three = [run(), run({ run: 2 }), run({ run: 3, rendererLost: true })]
    const good = evaluate(e, { runs: three, reloads: 0 })
    expect(good.verdict).toBe('judge') // drawn-again is the person's, per run
    expect(good.criteria.filter((c) => c.ok === false)).toEqual([])
    expect(good.metrics).toMatchObject({ device_lost_total: 3, renderer_lost_banners: 1 })
    expect(ok(evaluate(e, { runs: three.slice(0, 2), reloads: 0 }), 'runs_done')).toBe(false)
    const frozen = [...three.slice(0, 2), run({ run: 3, frozen: true })]
    expect(ok(evaluate(e, { runs: frozen, reloads: 0 }), 'black_or_frozen_runs')).toBe(false)
    // A tab Safari discarded: the reload report carries the runs that finished, and it is the failure.
    const killed = evaluate(e, {
      ready: false,
      reloaded: true,
      reloads: 1,
      runs: three.slice(0, 1),
    })
    expect(killed.verdict).toBe('fail')
    expect(ok(killed, 'reloads')).toBe(false)
  })

  const hud = (over = {}) => ({
    engine_mem_grows_sim: 0,
    engine_mem_grows_client: 0,
    tick_p95_ms: 4.2,
    main_p95_ms: 1.1,
    frame_p95_ms: 2.9,
    ...over,
  })
  const bench = (steady, final = steady.at(-1)) => ({
    ready: true,
    steady,
    final,
    windows: [{ raf: { long25: 0, max: 17, frames: 600 } }],
    reloads: 0,
  })
  test('device-walk reference: bench limits at, above and below (tick 10 ms; main 4 ms; client frame 8 ms) and the memory counters', () => {
    const large = CHECKS['M39-large-save']
    const shares = CHECKS['M39-frame-shares']
    expect(evaluate(large, bench([hud({ tick_p95_ms: 10 })])).verdict).toBe('pass')
    expect(ok(evaluate(large, bench([hud({ tick_p95_ms: 10.01 })])), 'tick_p95_ms')).toBe(false)
    // The worst steady window is read, not the last one.
    expect(
      ok(
        evaluate(large, bench([hud({ tick_p95_ms: 11 }), hud({ tick_p95_ms: 3 })])),
        'tick_p95_ms',
      ),
    ).toBe(false)
    const grew = hud({ engine_mem_grows_client: 1 })
    expect(ok(evaluate(large, bench([grew])), 'engine_mem_grows_client')).toBe(false)
    expect(ok(evaluate(large, bench([hud()])), 'engine_mem_grows_sim')).toBe(true)
    expect(evaluate(large, { ...bench([hud()]), reloads: 1 }).verdict).toBe('fail')
    expect(evaluate(large, { ready: false, steady: [], windows: [] }).verdict).toBe('fail')
    expect(evaluate(shares, bench([hud({ main_p95_ms: 4, frame_p95_ms: 8 })])).verdict).toBe('pass')
    expect(ok(evaluate(shares, bench([hud({ main_p95_ms: 4.01 })])), 'main_p95_ms')).toBe(false)
    expect(ok(evaluate(shares, bench([hud({ frame_p95_ms: 8.01 })])), 'frame_p95_ms')).toBe(false)
  })

  test('device-walk reference: the Run on numbers of the two bench rows are the ones the acceptance rows cite', () => {
    const r = evaluate(
      CHECKS['M39-large-save'],
      bench([hud({ tick_p95_ms: 6 }), hud({ tick_p95_ms: 5 })], hud({ tick_p95_ms: 5 })),
    )
    // `tick p95` (Tick time: phone sim worker), the memory counters of the Pass text, in HUD names.
    expect(r.metrics).toMatchObject({
      tick_p95_ms: 6,
      tick_p95_ms_last: 5,
      engine_mem_grows_sim: 0,
      engine_mem_grows_client: 0,
    })
    const f = evaluate(
      CHECKS['M39-frame-shares'],
      bench([hud({ main_p95_ms: 2, frame_p95_ms: 3 })]),
    )
    expect(f.metrics).toMatchObject({ main_p95_ms: 2, frame_p95_ms: 3 })
  })

  test('device-walk reference: --apply writes the numbers the phone Frame time and Tick time rows will cite into Run on', () => {
    const text = readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8')
    const ids = ['M39-large-save', 'M39-frame-shares']
    const sel = parseChecks(text).items.filter((i) => ids.includes(i.id))
    const large = evaluate(CHECKS['M39-large-save'], bench([hud({ tick_p95_ms: 6.5 })]))
    const shares = evaluate(
      CHECKS['M39-frame-shares'],
      bench([hud({ main_p95_ms: 1.25, frame_p95_ms: 3.5 })]),
    )
    const events = [
      { type: 'start', only: ids, mode: 'auto' },
      { type: 'result', id: 'M39-large-save', result: 'pass', by: 'auto', metrics: large.metrics },
      {
        type: 'result',
        id: 'M39-frame-shares',
        result: 'pass',
        by: 'auto',
        metrics: shares.metrics,
      },
    ]
    const { text: out } = applyRound(text, replay(events, sel), { round: 'demo', overrides: {} })
    const line = out
      .split('\n')
      .find((l) => l.startsWith('**Run on:**') && l.includes('M39-large-save PASS'))
    // Tick time: phone sim worker <- tick p95; Frame time: main rAF callback / client-worker frame <- main p95, frame p95.
    expect(line).toContain('M39-large-save PASS (numbers: tick_p95_ms_last=')
    expect(line).toMatch(/M39-large-save PASS \(numbers: [^)]*\btick_p95_ms=6\.5\b/)
    expect(line).toMatch(/engine_mem_grows_sim=0, engine_mem_grows_client=0/)
    expect(line).toMatch(/M39-frame-shares PASS \(numbers: [^)]*\bmain_p95_ms=1\.25\b/)
    expect(line).toMatch(/M39-frame-shares PASS \(numbers: [^)]*\bframe_p95_ms=3\.5\b/)
  })
})

describe('device-walk reference: which client walks a row', () => {
  function rig(ids, params = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'walk-ref-'))
    const file = join(dir, 'r.jsonl')
    mkdirSync(join(dir, 's'))
    const origins = { reference: 'http://127.0.0.1:1' }
    const m = createAutoRound({
      file,
      items: items.filter((i) => ids.includes(i.id)),
      origins,
      params,
    })
    m.attach({ append: (e) => appendEvent(file, e) })
    const events = () => readEvents(file)
    appendEvent(file, { type: 'walk', phase: 'start', src: { tab: 't', seq: 1 } })
    m.settle()
    return { m, events, results: () => events().filter((e) => e.type === 'result') }
  }

  test('device-walk reference: a Mac row is skipped on a phone with its reason, and walked by a Mac client', () => {
    const phone = rig(['M35-safari-build-mac', 'M35-safari-build-iphone'])
    expect(phone.m.variants()).toEqual(['reference'])
    const mac = phone.results().find((e) => e.id === 'M35-safari-build-mac')
    expect(mac).toMatchObject({ result: 'skip', by: 'auto' })
    expect(mac.notes).toMatch(/Mac browser row/)
    expect(
      phone.events().find((e) => e.type === 'attempt' && e.id === 'M35-safari-build-iphone'),
    ).toMatchObject({ n: 1, page: '', variant: 'reference' })

    const onMac = rig(['M35-safari-build-mac'], { client: 'mac' })
    expect(onMac.results()).toEqual([])
    expect(onMac.events().find((e) => e.type === 'attempt')).toMatchObject({
      id: 'M35-safari-build-mac',
      n: 1,
    })
  })
})
