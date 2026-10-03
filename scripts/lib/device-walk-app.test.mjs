// M39e: the walkthrough's HTTP app over a fake server control.
import { mkdtempSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from './device-walk/app.mjs'
import { parseChecks, selectItems } from './device-walk/parse.mjs'

const CHECKS = readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8')
const items = selectItems(parseChecks(CHECKS).items, ['M03', 'M38-hosted'])

let open = []
afterEach(async () => {
  for (const s of open) await new Promise((r) => s.close(r))
  open = []
})

async function boot() {
  const ensured = []
  const control = {
    status: () => ({
      status: 'ready',
      args: ['--tunnel'],
      urls: { loopback: 'http://127.0.0.1:4173', tunnel: 'https://t.trycloudflare.com' },
      log: [],
      error: null,
    }),
    ensure: async (w) => ensured.push(w),
    stopAll: async () => {},
  }
  const file = join(mkdtempSync(join(tmpdir(), 'dwa-')), 'r.jsonl')
  const app = createApp({ round: 'r', items, file, control })
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
  open.push(app.server)
  const base = `http://127.0.0.1:${app.server.address().port}`
  const post = (body, headers = { 'content-type': 'application/json' }) =>
    fetch(`${base}/api/event`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { app, base, ensured, post, file }
}

describe('device-walk app', () => {
  test('device-walk app: state lists the walked items (no Android), the position and the page URL', async () => {
    const { app, base, ensured } = await boot()
    app.begin(['M03', 'M38-hosted'])
    const s = await (await fetch(`${base}/api/state`)).json()
    expect(s.items.map((i) => i.id)).toEqual(['M03-determinism', 'M38-hosted-boot'])
    expect(s).toMatchObject({ total: 2, position: 1, cursor: 'M03-determinism' })
    expect(s.items[0].urls).toEqual(['https://t.trycloudflare.com/determinism.html'])
    expect(s.items[1].urls).toEqual(['https://engine-v2-ref.fly.dev/'])
    expect(ensured).toHaveLength(1) // the fly item needs no server
  })

  test('device-walk app: results, redo and cursor persist through the log; bad input is refused', async () => {
    const { base, post, file, ensured } = await boot()
    let s = await (
      await post({ type: 'result', id: 'M03-determinism', result: 'pass', notes: 'ok' })
    ).json()
    expect(s.items[0]).toMatchObject({ result: 'pass', notes: 'ok' })
    await post({ type: 'result', id: 'M03-determinism', result: 'fail', notes: 'again' })
    s = await (await post({ type: 'cursor', id: 'M38-hosted-boot' })).json()
    expect(s.position).toBe(2)
    expect(s.items[0].history.map((h) => h.result)).toEqual(['pass', 'fail'])
    expect(ensured).toHaveLength(0)
    expect((await post({ type: 'result', id: 'M03-determinism', result: 'maybe' })).status).toBe(
      400,
    )
    expect((await post({ type: 'nope' })).status).toBe(400)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3)
    // A page on another origin cannot post (no JSON content type without a preflight) nor use another Host.
    expect(
      (await post({ type: 'redo', id: 'M03-determinism' }, { 'content-type': 'text/plain' }))
        .status,
    ).toBe(415)
    const status = await new Promise((resolve) => {
      const port = Number(new URL(base).port)
      request(
        { host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example' } },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      ).end()
    })
    expect(status).toBe(403)
  })

  test('device-walk app: /api/qr serves an SVG and the UI page loads', async () => {
    const { base } = await boot()
    const svg = await (
      await fetch(`${base}/api/qr?text=${encodeURIComponent('https://x.test/a?b=1')}`)
    ).text()
    expect(svg).toMatch(/^<svg /)
    const html = await (await fetch(`${base}/`)).text()
    expect(html).toContain('Device walkthrough')
  })
})
