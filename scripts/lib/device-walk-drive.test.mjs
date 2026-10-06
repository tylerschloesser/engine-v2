// M39j: the device person and its backends (docs/plan/39j-device-driver.md). No phone: a fake backend records
// the calls, and the Android backend's adb and CDP are injected. The real-phone runs are evidence in the
// milestone report, not tests.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { CHECKS, MP_SCENARIOS } from './device-walk/checks.mjs'
import { assertBackend } from './device-walk/drive/backend.mjs'
import { createFakeBackend } from './device-walk/drive/fake-backend.mjs'
import { ACT_COVERAGE, devicePerson, HANDLERS } from './device-walk/drive/person.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const AGENT = join(REPO, 'scripts/lib/device-walk/agent')
const act = (text, id = 'M11-gestures', n = 1) => ({ id, n, kind: 'act', text })
const person = (b, ctx = {}) => devicePerson(b, { returnLagMs: 0, sleep: async () => {}, ...ctx })

describe('device-walk drive: coverage of every act prompt', () => {
  test('device-walk drive: every act string of checks.mjs is handled or listed NotDrivable, and nothing stale', () => {
    const names = new Set(HANDLERS.map((h) => h.name))
    const missing = []
    for (const [id, entry] of Object.entries(CHECKS))
      for (const a of entry.acts ?? []) {
        const rec = ACT_COVERAGE[id]?.find((r) => r.act === a)
        if (!rec) missing.push(`${id}: ${a}`)
        else {
          const ok = rec.handlers !== undefined || rec.notDrivable !== undefined
          if (!ok) missing.push(`${id}: ${a} (neither handlers nor notDrivable)`)
        }
      }
    expect(missing, 'acts the device person neither handles nor lists as NotDrivable').toEqual([])
    for (const [id, recs] of Object.entries(ACT_COVERAGE))
      for (const r of recs) {
        expect(CHECKS[id]?.acts, `${id} is a check with acts`).toContain(r.act)
        for (const h of r.handlers ?? []) expect(names.has(h), `${id}: handler ${h}`).toBe(true)
        for (const n of [r.notDrivable ?? []].flat())
          expect(
            typeof n === 'string' ? n : n.reason,
            `${id}: a NotDrivable has its reason`,
          ).toMatch(/\S{3}/)
      }
  })

  test('device-walk drive: every prompt text the agent can show is answered by a handler (or is not a phone prompt)', () => {
    // Static prefixes of the prompts in agent/*.js (each must still be in the source: a reworded prompt is red
    // here before it is a phone that waits for nobody) with a sample of the full text.
    const src = readdirSync(AGENT)
      .map((f) => readFileSync(join(AGENT, f), 'utf8'))
      .join('\n')
    const s = (n) => MP_SCENARIOS.find((x) => x.key === n).text.replace('{s}', '30')
    const prompts = [
      ['Pan with one finger for about', 'Pan with one finger for about 10 seconds.', 'pan'],
      ['Flick the world and let it glide', 'Flick the world and let it glide to a stop.', 'flick'],
      [
        'Pinch out to the furthest zoom',
        'Pinch out to the furthest zoom, then in to the closest.',
        'pinch',
      ],
      ["'Tap a tile.'", 'Tap a tile.', 'tap-tile'],
      [
        'Pull down from the very top edge',
        'Pull down from the very top edge of the page, then let go.',
        'pull-down',
      ],
      ['Double-tap anywhere', 'Double-tap anywhere.', 'double-tap'],
      ['Rotate the phone to ${want}', 'Rotate the phone to landscape.', 'rotate'],
      ['tap the highlighted ring', 'Zoom 2 of 3: tap the highlighted ring (1 of 3).', 'tap-ring'],
      ['Tap the highlighted button', 'Tap the highlighted button (it is numbered 26).', 'tap-ring'],
      [
        'Tap a tile (away from the little buttons)',
        'Tap a tile (away from the little buttons).',
        'tap-tile',
      ],
      ['Now drag the map with one finger', 'Now drag the map with one finger.', 'drag'],
      [
        'Turn Low Power Mode on',
        'Turn Low Power Mode on (Settings, Battery), then come back to this page.',
        'low-power',
      ],
      [
        'Low Power Mode looks on',
        'Low Power Mode looks on. Turn it off (Settings, Battery), then come back to this page.',
        'low-power-off',
      ],
      [
        'Swipe Safari away',
        'Swipe Safari away in the app switcher (close it), then open Safari again. If this tab is gone, scan the QR code on the Mac again.',
        'relaunch',
      ],
      [
        'Tap "Open second tab"',
        'Tap "Open second tab", look at the new tab, then come back to this one.',
        'second-tab',
      ],
      [
        'Open this link in a Private tab',
        'Open this link in a Private tab: http://x/world.html',
        'private-tab',
      ],
      [
        'Tap Export on the page',
        'Tap Export on the page (the file w.world downloads; check that it arrives in Files).',
        'file-picker',
      ],
      [
        'Now choose the downloaded file',
        'Now choose the downloaded file in Import, type the id walk-import, tap Import, then tap "Open the imported world".',
        'file-picker',
      ],
      [
        'Switch the phone off Wi-Fi now',
        'Switch the phone off Wi-Fi now (cellular, or a throttled link), keep this page in front, then tap the button.',
        'wifi',
      ],
      [
        'put this tab in the background under memory pressure',
        'Run 2 of 3: put this tab in the background under memory pressure (open the camera and a few heavy pages) for about 180 seconds, then come back to it.',
        'background',
      ],
      [
        'In ${browserName(item)}: pinch in and out',
        'In Safari: pinch in and out with the trackpad, over a landmark tile.',
        'mac-prompt',
      ],
      [
        'In ${b}: open ${tool}',
        'In Firefox: open the Profiler, start recording, press Run on the page, and stop the recording after the page prints its result.',
        'mac-prompt',
      ],
      // The leave and drop prompts come from checks.mjs (`plan.leaves`, MP_SCENARIOS), wrapped by the page.
      ['Drop ${next.run} of ${next.of}', `Drop 1 of 3 (app-30s): ${s('app-30s')}`, 'leave-app'],
      ['Drop ${next.run} of ${next.of}', `Drop 1 of 3 (lock-60s): ${s('lock-60s')}`, 'lock'],
      [
        'Drop ${next.run} of ${next.of}',
        `Drop 1 of 3 (wifi-cellular): ${s('wifi-cellular')}`,
        'wifi',
      ],
      [
        'Drop ${next.run} of ${next.of}',
        `Drop 1 of 3 (airplane-15s): ${s('airplane-15s')}`,
        'airplane',
      ],
    ]
    for (const [prefix, text, handler] of prompts) {
      expect(src, `agent source still says: ${prefix}`).toContain(prefix)
      const hit = HANDLERS.filter((h) => h.match.test(text)).map((h) => h.name)
      expect(hit[0], text).toBe(handler)
    }
    for (const id of ['M16-background', 'M23-hidden-pause'])
      for (const L of CHECKS[id].plan.leaves) {
        const text = L.text.replace('{s}', '30')
        expect(
          HANDLERS.some((h) => h.match.test(text)),
          `${id}: ${text}`,
        ).toBe(true)
      }
  })
})

describe('device-walk drive: the device person on a recording backend', () => {
  const run = async (text, o = {}, ctx = {}) => {
    const b = createFakeBackend(o)
    const out = await person(b, ctx).answer(act(text))
    return { b, out }
  }

  test('device-walk drive: "Rotate the phone to landscape." is rotate("landscape")', async () => {
    const { b, out } = await run('Rotate the phone to landscape.')
    expect(out.status).toBe('done')
    expect(b.calls.filter((c) => c.m !== 'readPage')).toEqual([
      { m: 'rotate', args: ['landscape'] },
    ])
  })

  test('device-walk drive: pan is one slow drag of the stated time, flick a fast short one, from the page size', async () => {
    const pan = (
      await run('Pan with one finger for about 10 seconds.', { view: { w: 400, h: 800 } })
    ).b.calls.find((c) => c.m === 'swipe')
    expect(pan.args[4]).toBe(11_500)
    expect(pan.args.slice(0, 4)).toEqual([340, 560, 60, 240])
    const flick = (
      await run('Flick the world and let it glide to a stop.', { view: { w: 400, h: 800 } })
    ).b.calls.find((c) => c.m === 'swipe')
    expect(flick.args).toEqual([300, 400, 100, 400, 80])
    const land = (
      await run('Flick the world and let it glide to a stop.', { view: { w: 851, h: 284 } })
    ).b.calls.find((c) => c.m === 'swipe')
    expect(land.args).toEqual([638.25, 142, 212.75, 142, 80])
  })

  test('device-walk drive: pinch goes together until the limit, then apart, two fingers each time', async () => {
    const { b } = await run('Pinch out to the furthest zoom, then in to the closest.', {
      tiles: [12, 40, 130, 262, 100, 30, 12],
    })
    const touches = b.calls.filter((c) => c.m === 'touch')
    expect(touches.length).toBeGreaterThanOrEqual(6)
    for (const t of touches) expect(t.args[0]).toHaveLength(2)
    const gap = (t) =>
      Math.abs(t.args[0][0].to.x - t.args[0][1].to.x) -
      Math.abs(t.args[0][0].from.x - t.args[0][1].from.x)
    expect(gap(touches[0])).toBeLessThan(0) // together first (the page opens at its closest zoom)
    expect(gap(touches.at(-1))).toBeGreaterThan(0) // apart at the end
  })

  test('device-walk drive: tap, double-tap, pull-down, drag and the ring come from the page, not constants', async () => {
    const c = (r) => r.b.calls.filter((x) => x.m !== 'readPage')
    expect(c(await run('Tap a tile.'))).toEqual([{ m: 'tap', args: [200, 400] }])
    expect(c(await run('Double-tap anywhere.'))).toEqual([
      { m: 'tap', args: [200, 400, { count: 2 }] },
    ])
    expect(c(await run('Pull down from the very top edge of the page, then let go.'))[0]).toEqual({
      m: 'swipe',
      args: [200, 6, 200, 300, 500],
    })
    expect(c(await run('Now drag the map with one finger.'))[0].args).toEqual([
      280, 400, 120, 400, 600,
    ])
    expect(c(await run('Zoom 1 of 3: tap the highlighted ring (1 of 3).'))).toEqual([
      { m: 'tap', args: [123, 234] },
    ])
    expect(
      c(await run('Tap "Open second tab", look at the new tab, then come back to this one.')),
    ).toEqual([
      { m: 'tap', args: [50, 700] },
      { m: 'returnToBrowser', args: [] },
    ])
  })

  test('device-walk drive: leaving the app is Home, the wait, the way back; airplane is on, wait, off', async () => {
    const { b } = await run(
      'Drop 1 of 3 (app-5s): Switch to another app for 0.2 seconds, then come back to this page.',
    )
    expect(b.names().filter((n) => n !== 'readPage')).toEqual(['home', 'returnToBrowser'])
    const a = await run('Turn airplane mode on for 0.1 seconds, then off, with this page in front.')
    expect(a.b.calls.filter((x) => x.m === 'setAirplane').map((x) => x.args[0])).toEqual([
      true,
      false,
    ])
  })

  test('device-walk drive: what a phone cannot do is NotDrivable with its reason, never a pass', async () => {
    const lock = await run(
      'Lock the screen for 60 seconds, then unlock the phone and come back to this page.',
    )
    expect(lock.out).toMatchObject({ status: 'notDrivable', handler: 'lock' })
    expect(lock.out.reason).toMatch(/never/)
    expect(lock.b.names()).toEqual([])
    const low = await run(
      'Turn Low Power Mode on (Settings, Battery), then come back to this page.',
      { lowPower: 'notDrivable' },
    )
    expect(low.out).toMatchObject({
      status: 'notDrivable',
      reason: 'the fake phone has no Low Power Mode',
    })
    expect((await run('Open this link in a Private tab: http://x/')).out.status).toBe('notDrivable')
    expect((await run('A prompt nobody wrote a handler for.')).out).toEqual({ status: 'unmatched' })
  })

  test('device-walk drive: a judge sheet is a screenshot and a pending answer, nothing tapped', async () => {
    const b = createFakeBackend()
    const out = await person(b, { shotPath: (p) => `/x/${p.id}-${p.n}-judge.png` }).answer({
      id: 'M11-gestures',
      n: 2,
      kind: 'judge',
      text: 'the flick glides',
    })
    expect(out).toEqual({ status: 'pending', shot: '/x/M11-gestures-2-judge.png' })
    expect(b.calls).toEqual([{ m: 'screenshot', args: ['/x/M11-gestures-2-judge.png'] }])
  })

  test('device-walk drive: the fake backend implements the interface', () => {
    assertBackend(createFakeBackend())
    expect(() => assertBackend({ open() {} })).toThrow(/lacks: readPage/)
  })
})
