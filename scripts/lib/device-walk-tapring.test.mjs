// M39r: where a tap landed is evidence. M18-pick runs in the agent's `vm` page (`fake-agent-page.mjs`) with a
// scripted `__check`; capture-phase events are fired at it the way the browser delivers them.
import { describe, expect, test } from 'vitest'
import { createFakePage } from './device-walk/fake-agent-page.mjs'

const BTN = { left: 190, top: 90, right: 204, bottom: 104, width: 14, height: 14 }
function setup(extra = {}) {
  const phases = []
  const st = { taps: 0, pick_id: 0 }
  const page = createFakePage({
    load: ['collect-touch.js'],
    buttons: [{ getBoundingClientRect: () => BTN }],
    check: {
      ready: true,
      errors: () => [],
      readings: () => ({ ...st, tiles_across: 40, orientation: 'portrait' }),
      act: {
        zoomTo: () => ({}),
        ringScreen: ({ pickId }) => ({ visible: pickId === 26, x: 197, tapY: 106 }),
        ringPhase: (a) => {
          phases.push(a?.pickId ?? null)
          return {}
        },
        buttonScreen: () => null,
      },
      ...extra,
    },
  })
  return { page, st, phases }
}
const ev = (type, tagName, id, x, y, t = 1) => ({
  type,
  target: { tagName, id },
  clientX: x,
  clientY: y,
  pointerType: 'touch',
  timeStamp: t,
})
const item = {
  id: 'M18-pick',
  n: 1,
  plan: { mode: 'pick', levels: [40] },
  opts: { timeoutMs: 1000, actTimeoutMs: 5000 },
}

describe('device-walk tap ring: the evidence says where a tap landed', () => {
  test('device-walk tap ring: a finished tap records the target of its pointerdown, pointerup and click, and the ring point and nearest button', async () => {
    const { page, st, phases } = setup()
    await page.connect()
    const run = page.kit.collectors.anchors(item)
    await page.advance(1000)
    page.fire('pointerdown', ev('pointerdown', 'BUTTON', '', 197, 108, 10))
    page.fire('pointerup', ev('pointerup', 'BUTTON', '', 197, 108, 11))
    page.fire('click', ev('click', 'BUTTON', '', 197, 108, 12))
    st.taps = 1
    st.pick_id = 26
    await page.advance(1500)
    const out = await run
    expect(out.pick.taps).toHaveLength(1)
    const t = out.pick.taps[0]
    expect(t.events.map((e) => [e.type, e.tag, e.x, e.y, e.pt])).toEqual([
      ['pointerdown', 'BUTTON', 197, 108, 'touch'],
      ['pointerup', 'BUTTON', 197, 108, 'touch'],
      ['click', 'BUTTON', 197, 108, 'touch'],
    ])
    expect(t.at).toMatchObject({ id: 26, zoom: 40, x: 197, y: 106 })
    expect(t.at.button).toMatchObject({ bottom: 104, gapPx: 2 })
    expect(t.at.view).toMatchObject({ dpr: 3 })
    // The ring phase: only that ring's button for the tap, then every button back.
    expect(phases).toEqual([26, null])
  })

  test('device-walk tap ring: an act timeout writes the last events and the asked tap into the evidence, not only actTimedOut', async () => {
    const { page } = setup()
    await page.connect()
    const run = page.kit.collectors.anchors(item)
    await page.advance(1000)
    page.fire('pointerdown', ev('pointerdown', 'BUTTON', 'b26', 197, 108, 10))
    page.fire('pointerup', ev('pointerup', 'BUTTON', 'b26', 197, 108, 11))
    await page.advance(6000)
    const out = await run
    expect(out).toMatchObject({ ready: true, actTimedOut: true })
    expect(out.tapLog.asked).toMatchObject({ id: 26, x: 197, y: 106 })
    expect(out.tapLog.events.map((e) => [e.type, e.tag, e.id])).toEqual([
      ['pointerdown', 'BUTTON', 'b26'],
      ['pointerup', 'BUTTON', 'b26'],
    ])
    expect(out.tapLog.tapsDone).toBe(0)
  })

  test('device-walk tap ring: the log is a fixed ring: 40 events keep the last 24 and write no new slot objects', async () => {
    const { page } = setup()
    await page.connect()
    const L = page.kit.touch.tapLog()
    const first = L.since(0)
    expect(first).toHaveLength(0)
    for (let i = 0; i < 40; i++) page.fire('click', ev('click', 'CANVAS', '', i, i, i))
    const got = L.since(0)
    expect(got).toHaveLength(24)
    expect(got[0].x).toBe(16)
    expect(got[23].x).toBe(39)
  })
})

describe('device-walk tap ring: only rings a finger can reach are asked for', () => {
  test('device-walk tap ring: a ring whose centre is under another element, or whose disc reaches the bar zone, is skipped and recorded, never asked', async () => {
    const st = { taps: 0, pick_id: 0 }
    const at = { 26: [197, 106], 16: [197, 300], 25: [100, 400], 36: [197, 700] }
    const asked = []
    const page = createFakePage({
      load: ['collect-touch.js'],
      elementAt: (x, y) => (x === 197 && y === 300 ? { tagName: 'DIV' } : { tagName: 'CANVAS' }),
      check: {
        ready: true,
        errors: () => [],
        readings: () => ({ ...st, tiles_across: 12, orientation: 'portrait' }),
        act: {
          zoomTo: () => ({}),
          ringScreen: ({ pickId }) =>
            at[pickId]
              ? { visible: true, x: at[pickId][0], tapY: at[pickId][1] }
              : { visible: false },
          ringPhase: (a) => {
            if (a?.pickId) asked.push(a.pickId)
            return {}
          },
          buttonScreen: () => null,
        },
      },
    })
    await page.connect()
    const run = page.kit.collectors.anchors({
      id: 'M18-pick',
      n: 1,
      plan: { mode: 'pick', levels: [12] },
      opts: { timeoutMs: 1000, actTimeoutMs: 8000 },
    })
    await page.advance(1000)
    for (const id of [26, 25]) {
      st.taps++
      st.pick_id = id
      await page.advance(1500)
    }
    await page.advance(3000)
    const out = await run
    expect(asked.sort()).toEqual([25, 26])
    expect(out.pick.skipped.map((s) => [s.id, s.under])).toEqual([
      [16, 'DIV'],
      [36, 'CANVAS'],
    ])
  })
})
