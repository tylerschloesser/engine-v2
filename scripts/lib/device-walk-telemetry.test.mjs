// M39ad step 1: the phone API counts and names every refused phone request and every runner page it serves.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createPhoneApi } from './device-walk/phone-api.mjs'
import { fullStatus } from './device-walk/status.mjs'

const TOKEN = 'a'.repeat(32)
let open = []
afterEach(async () => {
  for (const a of open) await a.close()
  open = []
})

async function boot(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dwt-'))
  writeFileSync(join(dir, 'runner.html'), '<title>runner</title>')
  const api = createPhoneApi({
    file: join(dir, 'r.jsonl'),
    round: 'r',
    token: TOKEN,
    seriesDir: join(dir, 'series'),
    runnerPath: join(dir, 'runner.html'),
    ...extra,
  })
  const port = await api.listen(0)
  open.push(api)
  return { api, base: `http://127.0.0.1:${port}` }
}

describe('device-walk phone telemetry', () => {
  test('device-walk telemetry: a wrong token and a wrong host are counted by reason, with the last one named', async () => {
    const seen = []
    const { api, base } = await boot({ onRefusal: (r, first) => seen.push([r.reason, first]) })
    await fetch(`${base}/__walk/runner.html?walk=${'b'.repeat(32)}`)
    await fetch(`${base}/__walk/runner.html?walk=${'c'.repeat(32)}`)
    await new Promise((resolve) => {
      const u = new URL(`${base}/__walk/runner.html?walk=${TOKEN}`)
      request(u, { headers: { host: 'evil.example' } }, (res) =>
        res.resume().on('end', resolve),
      ).end()
    })
    const r = api.requests()
    expect(r.served).toBe(0)
    expect(r.refused).toEqual({ token: 2, host: 1 })
    expect(r.last).toMatchObject({ reason: 'host', host: 'evil.example', token: TOKEN.slice(0, 8) })
    // the first of each reason is flagged (the tool prints one line for it)
    expect(seen).toEqual([
      ['token', true],
      ['token', false],
      ['host', true],
    ])
  })

  test('device-walk telemetry: a served runner page is counted; a warm-up fetch is not the phone', async () => {
    const { api, base } = await boot()
    await fetch(`${base}/__walk/runner.html?walk=${TOKEN}`)
    await fetch(`${base}/__walk/runner.html?walk=${TOKEN}&warm=1`)
    expect(api.requests()).toMatchObject({ served: 1, warm: 1, refused: {} })
  })

  test('device-walk telemetry: --status --json carries phone.requests', () => {
    const live = {
      pid: 1,
      joinUrl: 'u',
      phone: { lastSeen: null },
      requests: { served: 2, refused: { host: 1 }, last: { reason: 'host' } },
    }
    const s = fullStatus({
      round: 'r',
      file: 'f',
      items: [],
      events: [{ type: 'start', mode: 'auto' }],
      overrides: {},
      live,
      now: 0,
      alive: true,
    })
    expect(s.phone.requests).toEqual(live.requests)
  })
})
