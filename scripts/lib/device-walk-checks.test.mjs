// M39f step 4: the machine-readable criteria of every walked device check (checks.mjs) against
// device-checks.md, which owns their meaning: ids both ways, the Pass-text hash, every quoted number.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { CHECKS, evaluate, passHash, read, valuesAt, walkable } from './device-walk/checks.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { OVERRIDES, servingFor } from './device-walk/serving.mjs'

const TEXT = readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8')
const { items } = parseChecks(TEXT)
const walked = items.filter((i) => !i.android && OVERRIDES[i.id]?.device !== 'none')
const budgets = JSON.parse(
  readFileSync(new URL('../../packages/engine/budgets.json', import.meta.url), 'utf8'),
)

/** Ids whose Pass text no longer hashes to the entry's `pass`, and ids on one side only. */
function drift(text) {
  const { items: its } = parseChecks(text)
  const ids = its.filter((i) => !i.android && OVERRIDES[i.id]?.device !== 'none')
  return {
    missing: ids.filter((i) => !CHECKS[i.id]).map((i) => i.id),
    extra: Object.keys(CHECKS).filter((id) => !ids.some((i) => i.id === id)),
    changed: ids
      .filter((i) => CHECKS[i.id] && CHECKS[i.id].pass !== passHash(i.pass))
      .map((i) => i.id),
  }
}

describe('device-walk checks', () => {
  test('device-walk checks: every non-Android, non-meta id has exactly one entry and the reverse', () => {
    expect(walked.length).toBe(44)
    expect(drift(TEXT)).toEqual({ missing: [], extra: [], changed: [] })
    expect(new Set(walked.map((i) => i.id)).size).toBe(Object.keys(CHECKS).length)
  })

  test('device-walk checks: editing a Pass line without its entry fails the drift check', () => {
    const edited = TEXT.replace(
      'rAF interval p95 ≤ 17.5 ms; intervals',
      'rAF interval p95 ≤ 18 ms; intervals',
    )
    expect(edited).not.toBe(TEXT)
    expect(drift(edited).changed).toEqual(['M09b-fill-rate'])
    // A row dropped from the markdown, or added to it, shows on the matching side.
    const dropped = TEXT.replace(/^- \[ \] \*\*M23-private\*\*.*$/m, '')
    expect(drift(dropped).extra).toEqual(['M23-private'])
    const added = TEXT.replace(
      '- [ ] **M23-private**',
      '- [ ] **M23-newcomer** *Pass:* x.\n- [ ] **M23-private**',
    )
    expect(drift(added).missing).toEqual(['M23-newcomer'])
  })

  test('device-walk checks: the classification and every entry shape', () => {
    const count = (c) => Object.values(CHECKS).filter((e) => e.class === c).length
    expect({
      auto: count('auto'),
      confirm: count('auto+confirm'),
      human: count('human'),
      retired: count('retired'),
    }).toEqual({ auto: 25, confirm: 10, human: 8, retired: 1 })
    expect(walkable('M35-capability')).toBe(false)
    expect(walkable('M39-rerun')).toBe(false)
    for (const [id, e] of Object.entries(CHECKS)) {
      expect(['auto', 'auto+confirm', 'human', 'retired'], id).toContain(e.class)
      expect(e.signal, id).toBeTruthy()
      expect(
        Array.isArray(e.criteria) && Array.isArray(e.acts) && Array.isArray(e.judges),
        id,
      ).toBe(true)
      if (e.class === 'human') expect(e.criteria, id).toEqual([])
      if (e.plan.built) expect(e.plan.collector, id).toBeTruthy()
    }
  })

  test('device-walk checks: a limit quoted from the Pass text is in the Pass text; budget and PRE-PLAN refs are real', () => {
    const preplan = readFileSync(new URL('../../PRE-PLAN.md', import.meta.url), 'utf8')
    for (const it of walked) {
      for (const c of CHECKS[it.id].criteria) {
        expect(c.ref, `${it.id} ${c.name}`).toMatch(
          /^(pass|Steps:|budgets\.json |PRE-PLAN §7 |hitch proxy|none: |\d{4} §)/,
        )
        if (c.ref === 'pass' && c.limit === 0)
          expect(it.pass, `${it.id} ${c.name}`).toMatch(/\b(0|no|zero|never|without)\b/i)
        else if (c.ref === 'pass' && typeof c.limit === 'number')
          expect(it.pass, `${it.id} ${c.name} limit ${c.limit}`).toMatch(
            new RegExp(`(^|[^\\d.])${String(c.limit).replace('.', '\\.')}([^\\d]|$)`),
          )
        if (c.ref === 'pass' && typeof c.limit === 'string')
          expect(it.pass, `${it.id} ${c.name}`).toContain(c.limit)
        if (c.ref.startsWith('budgets.json ')) {
          const key = c.ref.slice('budgets.json '.length).split(' ')[0]
          expect(budgets[key], `${it.id} ${c.name}`).toBe(c.limit)
        }
        if (c.ref.startsWith('PRE-PLAN §7 '))
          expect(preplan, `${it.id} ${c.name}`).toContain(
            c.ref.slice('PRE-PLAN §7 '.length).split(' (')[0],
          )
      }
    }
    // The three phone figures of the brief's own table (PRE-PLAN §7: tick, main, client-worker frame).
    const lim = (id, name) => CHECKS[id].criteria.find((c) => c.name === name).limit
    expect([
      lim('M39-large-save', 'tick_p95_ms'),
      lim('M39-frame-shares', 'main_p95_ms'),
      lim('M39-frame-shares', 'frame_p95_ms'),
    ]).toEqual([10, 4, 8])
  })

  test('device-walk checks: a built entry points at the page the serving derivation shows', () => {
    for (const it of walked) {
      const e = CHECKS[it.id]
      if (!e.plan.built || e.plan.variant !== 'fixture') continue
      expect(e.plan.page, it.id).toBe(servingFor(it).pages[0])
    }
  })
})

describe('device-walk criteria', () => {
  const fill = CHECKS['M09b-fill-rate']
  const sample = (over = {}) => ({
    isolated: true,
    adapter: 'apple/apple',
    raf_p50_ms: 16.6,
    raf_p95_ms: 16.9,
    raf_over20: 0,
    gpu_exec_p95_ms: 3,
    ...over,
  })
  const win = (orientation, over = {}, raf = {}) => ({
    orientation,
    steady: [sample(over)],
    raf: { long25: 0, max: 18, frames: 3600, ...raf },
  })
  const data = (a, b) => ({
    windows: [a, b],
    steady: [...a.steady, ...b.steady],
  })

  test('device-walk criteria: limits at, above and below (rAF p95 17.5, gaps 5 per 10 s, GPU 6)', () => {
    const run = (over) => evaluate(fill, data(win('portrait', over), win('landscape')))
    expect(run({ raf_p95_ms: 17.5, raf_over20: 5, gpu_exec_p95_ms: 6 }).verdict).toBe('pass')
    const high = run({ raf_p95_ms: 17.6 })
    expect(high.verdict).toBe('fail')
    expect(high.criteria.find((c) => !c.ok)).toMatchObject({
      name: 'raf_p95_ms',
      value: 17.6,
      limit: 17.5,
      ok: false,
    })
    expect(run({ raf_over20: 6 }).criteria.find((c) => !c.ok).name).toBe('raf_over20_per_10s')
    expect(run({ gpu_exec_p95_ms: 6.1 }).criteria.find((c) => !c.ok).name).toBe('gpu_exec_p95_ms')
    expect(run({ raf_p95_ms: 12, gpu_exec_p95_ms: 1 }).verdict).toBe('pass')
  })

  test('device-walk criteria: the GPU criterion reads gpu_exec_p95_ms; a null reading is a judge prompt, never a pass', () => {
    const run = (over) => evaluate(fill, data(win('portrait', over), win('landscape')))
    expect(run({ gpu_exec_p95_ms: 6.0 }).verdict).toBe('pass')
    const over = run({ gpu_exec_p95_ms: 6.1 })
    expect(over.verdict).toBe('fail')
    expect(over.criteria.find((c) => c.name === 'gpu_exec_p95_ms')).toMatchObject({ ok: false })
    const none = run({ gpu_exec_p95_ms: null, gpu_latency_p95_ms: 13.2 })
    expect(none.verdict).toBe('judge')
    expect(none.criteria.find((c) => c.name === 'gpu_exec_p95_ms')).toMatchObject({
      value: null,
      ok: null,
    })
    // The old latency reading alone no longer decides, and is recorded as a metric.
    expect(run({ gpu_exec_p95_ms: 3, gpu_latency_p95_ms: 14 }).verdict).toBe('pass')
    expect(run({ gpu_exec_p95_ms: 3, gpu_latency_p95_ms: 14 }).metrics.gpu_latency_p95_ms).toBe(14)
  })

  test('device-walk criteria: the worst window of the two orientations decides', () => {
    const r = evaluate(fill, data(win('portrait'), win('landscape', { raf_p95_ms: 20 })))
    expect(r.verdict).toBe('fail')
    expect(r.criteria.find((c) => c.name === 'raf_p95_ms').value).toBe(20)
  })

  test('device-walk criteria: one orientation only is a failed completeness check, not a pass', () => {
    const r = evaluate(fill, { windows: [win('portrait')], steady: win('portrait').steady })
    expect(r.criteria.find((c) => c.name === 'windows_measured')).toMatchObject({
      value: 1,
      limit: 2,
      ok: false,
    })
    expect(r.verdict).toBe('fail')
  })

  test('device-walk criteria: the hitch proxy is clean, or a judge prompt, never an automatic fail', () => {
    const clean = evaluate(fill, data(win('portrait'), win('landscape')))
    expect(clean.verdict).toBe('pass')
    const gap = evaluate(fill, data(win('portrait', {}, { long25: 2 }), win('landscape')))
    expect(gap.verdict).toBe('judge')
    expect(gap.criteria.find((c) => c.name === 'hitch_gaps_over_25ms')).toMatchObject({
      value: 2,
      ok: null,
    })
    // A hard failure elsewhere still wins over a pending judge.
    const both = evaluate(
      fill,
      data(win('portrait', { raf_p95_ms: 30 }, { long25: 9 }), win('landscape')),
    )
    expect(both.verdict).toBe('fail')
  })

  test('device-walk criteria: a missing reading is a failed criterion, not an absent one', () => {
    const r = evaluate(CHECKS['M11-boot'], { final: { isolated: true, workers_ready: true } })
    expect(r.criteria.filter((c) => !c.ok).map((c) => c.name)).toEqual(['adapter', 'delivery'])
  })

  test('device-walk criteria: M08-warn-threshold passes on phone median <= 0.5 ms or on F <= 5', () => {
    const warn = CHECKS['M08-warn-threshold']
    const g = (ms) => ({ g: { __worldgenBench: { medianMs: ms } } })
    expect(evaluate(warn, g(0.5), { desktopMedianMs: 0.01 }).verdict).toBe('pass') // F 50 but median ok
    expect(evaluate(warn, g(0.6), { desktopMedianMs: 0.12 }).verdict).toBe('pass') // F 5
    const bad = evaluate(warn, g(0.9), { desktopMedianMs: 0.1 }) // F 9
    expect(bad.verdict).toBe('fail')
    expect(bad.metrics).toMatchObject({ F: 9, desktop_median_ms: 0.1, warn_if_failing_ms: 0.111 })
  })

  test('device-walk criteria: determinism needs the banner, every checkpoint and isolation', () => {
    const det = CHECKS['M03-determinism']
    const ok = {
      dom: { banner: 'PASS\ncrossOriginIsolated: true' },
      g: {
        __determinism: {
          fixtures: { hash: { pass: true }, reference: { pass: true } },
          crossOriginIsolated: true,
        },
      },
    }
    expect(evaluate(det, ok).verdict).toBe('pass')
    const bad = structuredClone(ok)
    bad.g.__determinism.fixtures.hash.pass = false
    const r = evaluate(det, bad)
    expect(r.criteria.find((c) => !c.ok)).toMatchObject({
      name: 'checkpoint_mismatches',
      value: 1,
      limit: 0,
    })
    bad.g.__determinism.crossOriginIsolated = false
    expect(
      evaluate(det, bad)
        .criteria.filter((c) => !c.ok)
        .map((c) => c.name),
    ).toEqual(['checkpoint_mismatches', 'cross_origin_isolated'])
  })

  test('device-walk criteria: memory passes on both finished steps with no reload; a reload is the failure', () => {
    const mem = CHECKS['M11-memory']
    const steps = [
      'probe=memory: (1) scratch memory ceiling',
      '(1) ceiling: 1024 MiB reached',
      '(2) touch=0: completed without a reload',
      '(3) touch=1: completed without a reload',
      'probe=memory: complete',
    ]
    const good = evaluate(mem, { final: { steps }, reloads: 0 })
    expect(good.verdict).toBe('pass')
    expect(good.metrics.scratch_ceiling_mib).toBe(1024)
    const killed = evaluate(mem, {
      final: { steps: steps.slice(0, 3).concat('(3) touch=1: 40s / 120s') },
      reloads: 1,
    })
    expect(killed.verdict).toBe('fail')
    expect(killed.criteria.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'step_3_finished',
      'reloads',
    ])
    expect(killed.metrics.last_line).toBe('(3) touch=1: 40s / 120s')
  })

  test('device-walk criteria: opfs flush p95 limit 10 ms (at, above)', () => {
    const e = CHECKS['M23-opfs-latency']
    const d = (p95) => ({ g: { __opfsLatencyResult: { flush: { p95 }, append: { p95: 1 } } } })
    expect(evaluate(e, d(10)).verdict).toBe('pass')
    expect(evaluate(e, d(10.01)).verdict).toBe('fail')
  })

  test('device-walk criteria: path reading, wildcards and reducers', () => {
    const o = { a: [{ v: 1 }, { v: 3 }, { v: 2 }], m: { x: { p: true }, y: { p: false } } }
    expect(valuesAt(o, 'a.*.v')).toEqual([1, 3, 2])
    expect(read(o, 'a.*.v', 'max')).toBe(3)
    expect(read(o, 'a.*.v', 'median')).toBe(2)
    expect(read(o, 'm.*.p', 'count-false')).toBe(1)
    expect(read(o, 'nope.*.p', 'max')).toBeNull()
  })
})
