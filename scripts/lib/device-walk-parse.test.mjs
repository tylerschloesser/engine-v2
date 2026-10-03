// M39e: the parser, serving derivation and round log of the device walkthrough tool.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseChecks, selectItems } from './device-walk/parse.mjs'
import { appendEvent, firstOpen, readEvents, replay } from './device-walk/rounds.mjs'
import { compatible, FLY_URL, pageUrl, serveArgs, servingFor } from './device-walk/serving.mjs'

const CHECKS = readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8')
const { items, sections } = parseChecks(CHECKS)
const byId = (id) => items.find((i) => i.id === id)
const serving = (id) => servingFor(byId(id))

describe('device-walk parse', () => {
  test('device-walk parse: every id of device-checks.md is found with its section, and ids match the acceptance reader', () => {
    const ids = [...CHECKS.matchAll(/^- \[[ xX]\] \*\*([^*]+)\*\*/gm)].map((m) => m[1])
    expect(items.map((i) => i.id)).toEqual(ids)
    const walked = items.filter((i) => !i.android)
    expect(walked.length).toBeGreaterThan(30)
    expect(byId('M03-determinism').section).toBe('M03')
    expect(byId('M23-hidden-pause').section).toBe('M23')
    expect(byId('M39-android').android).toBe(true)
    expect(sections.get('M03').runOnLine).toBeGreaterThan(0)
    for (const it of walked) expect(it.steps || it.pass || it.lead, it.id).toBeTruthy()
  })

  test('device-walk parse: steps, pass and if-fails split, including a multi-line bullet', () => {
    const it = byId('M23-opfs-latency')
    expect(it.steps).toMatch(/^run the latency page/)
    expect(it.pass).toMatch(/^`flush` p95 ≤ 10 ms/)
    expect(it.ifFails).toMatch(/^apply that decision/)
    expect(byId('M18-pick').ifFails).toBe('')
  })

  test('device-walk parse: --only matches id prefixes', () => {
    expect(selectItems(items, ['M03']).map((i) => i.id)).toEqual([
      'M03-determinism',
      'M03-determinism-android',
    ])
    expect(selectItems(items, ['M11-boot', 'M35-cap']).map((i) => i.id)).toEqual([
      'M11-boot',
      'M35-capability',
    ])
    expect(selectItems(items, undefined)).toBe(items)
  })
})

describe('device-walk serving', () => {
  test('device-walk serving: every non-Android item resolves to a variant with a page rule', () => {
    for (const it of items.filter((i) => !i.android)) {
      const s = servingFor(it)
      expect(['phone', 'mac', 'none'], it.id).toContain(s.device)
      expect(s.pages.length, it.id).toBeGreaterThan(0)
      if (s.device === 'phone' && !s.fly && s.app === 'fixture')
        expect(s.pages[0], it.id).toMatch(/\.html/)
    }
  })

  test('device-walk serving: variants for representative items', () => {
    expect(serving('M03-determinism')).toMatchObject({
      device: 'phone',
      app: 'fixture',
      tunnel: true,
      pages: ['determinism.html'],
    })
    expect(serving('M09b-fill-rate').pages).toEqual(['device.html?autopan=1&tiles=256&scale=2'])
    expect(serving('M11-memory').pages).toEqual(['device.html?probe=memory'])
    expect(serving('M11-pinch-desktop-safari')).toMatchObject({
      device: 'mac',
      tunnel: false,
      pages: ['device.html'],
    })
    expect(serving('M17b-harness-desktop-firefox')).toMatchObject({
      device: 'mac',
      pages: ['device.html?harness=1'],
    })
    expect(serving('M23-world-busy').pages).toEqual(['world.html'])
    expect(serving('M29-socket-resume')).toMatchObject({ ws: 'puts', pages: ['mp.html?linklog=1'] })
    expect(serving('M34-two-devices')).toMatchObject({
      app: 'reference',
      ws: 'default',
      pages: [''],
    })
    expect(serving('M35-safari-build-mac')).toMatchObject({
      device: 'mac',
      app: 'reference',
      ws: false,
    })
    expect(serving('M35-safari-build-iphone')).toMatchObject({ device: 'phone', tunnel: true })
    expect(serving('M38-hosted-boot')).toMatchObject({ fly: true, tunnel: false })
    expect(serving('M38-socket-resume').pages).toEqual(['?linklog=1'])
    expect(serving('M39-large-save')).toMatchObject({ bench: true, app: 'reference', ws: false })
    expect(serving('M39-desktop-browsers').device).toBe('mac')
    expect(serving('M39-rerun').device).toBe('none')
  })

  test('device-walk serving: flags, reuse rule and urls', () => {
    expect(serveArgs(serving('M29-socket-resume'))).toEqual(['--tunnel', '--ws', 'puts'])
    expect(serveArgs(serving('M39-large-save'))).toEqual([
      '--tunnel',
      '--app',
      'reference',
      '--bench',
    ])
    expect(serveArgs(serving('M34-two-devices'))).toEqual([
      '--tunnel',
      '--ws',
      '--app',
      'reference',
    ])
    const phone = serving('M35-safari-build-iphone')
    const mac = serving('M35-safari-build-mac')
    expect(compatible(phone, mac)).toBe(true) // a tunnel server also serves loopback
    expect(compatible(mac, phone)).toBe(false)
    expect(compatible(phone, serving('M34-two-devices'))).toBe(false)
    const urls = { loopback: 'http://127.0.0.1:4173', tunnel: 'https://x.trycloudflare.com' }
    expect(pageUrl(serving('M03-determinism'), urls, 'determinism.html')).toBe(
      'https://x.trycloudflare.com/determinism.html',
    )
    expect(pageUrl(mac, urls, '')).toBe('http://127.0.0.1:4173/')
    expect(pageUrl(serving('M38-socket-resume'), null, '?linklog=1')).toBe(`${FLY_URL}/?linklog=1`)
    expect(pageUrl(serving('M39-rerun'), urls, '')).toBeNull()
  })
})

describe('device-walk round log', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'dw-')), 'r.jsonl')
  const sel = selectItems(items, ['M03', 'M08'])
  let n = 0
  const now = () => `2026-10-03T00:00:${String(n++).padStart(2, '0')}Z`

  test('device-walk round log: a changed result keeps the earlier one; redo reopens; cursor resumes', () => {
    const f = tmp()
    appendEvent(f, { type: 'start', only: ['M03', 'M08'] }, now)
    appendEvent(f, { type: 'device', phone: 'iPhone 15', ios: '26.0' }, now)
    appendEvent(f, { type: 'cursor', id: 'M03-determinism' }, now)
    appendEvent(f, { type: 'result', id: 'M03-determinism', result: 'fail', notes: 'hash 3' }, now)
    appendEvent(
      f,
      { type: 'result', id: 'M03-determinism', result: 'pass', notes: 'rerun ok' },
      now,
    )
    appendEvent(f, { type: 'cursor', id: 'M08-warn-threshold' }, now)
    let st = replay(readEvents(f), sel)
    const s = st.items.get('M03-determinism')
    expect(s.result).toBe('pass')
    expect(s.history.map((h) => h.result)).toEqual(['fail', 'pass'])
    expect(s.history[0].notes).toBe('hash 3')
    expect(st.cursor).toBe('M08-warn-threshold')
    expect(st.device.phone).toBe('iPhone 15')
    expect(st.only).toEqual(['M03', 'M08'])
    appendEvent(f, { type: 'redo', id: 'M03-determinism' }, now)
    st = replay(readEvents(f), sel)
    expect(st.items.get('M03-determinism').result).toBeNull()
    expect(st.items.get('M03-determinism').history.map((h) => h.result)).toEqual([
      'fail',
      'pass',
      null,
    ])
    expect(firstOpen(sel, st)).toBe('M03-determinism')
  })

  test('device-walk round log: editing notes under one result is one history row', () => {
    const f = tmp()
    for (const notes of ['a', 'ab', 'abc'])
      appendEvent(f, { type: 'result', id: 'M03-determinism', result: 'pass', notes }, now)
    const s = replay(readEvents(f), sel).items.get('M03-determinism')
    expect(s.history).toHaveLength(1)
    expect(s.notes).toBe('abc')
  })

  test('device-walk round log: a truncated last line is skipped and the next append starts a new line', () => {
    const f = tmp()
    appendEvent(f, { type: 'result', id: 'M03-determinism', result: 'pass' }, now)
    appendFileSync(f, '{"type":"result","id":"M08-warn-thre')
    expect(replay(readEvents(f), sel).items.get('M08-warn-threshold').result).toBeNull()
    appendEvent(f, { type: 'result', id: 'M08-warn-threshold', result: 'fail' }, now)
    const st = replay(readEvents(f), sel)
    expect(st.items.get('M03-determinism').result).toBe('pass')
    expect(st.items.get('M08-warn-threshold').result).toBe('fail')
    expect(readFileSync(f, 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
  })

  test('device-walk round log: events for ids outside the walked set are ignored', () => {
    const f = tmp()
    writeFileSync(f, '{"type":"result","id":"NOPE","result":"pass"}\n')
    expect(replay(readEvents(f), sel).items.has('NOPE')).toBe(false)
  })
})
