// M39e: the QR encoder (decoded back with jsQR) and the server control (fake device-serve child).
import jsQR from 'jsqr'
import { describe, expect, test } from 'vitest'
import { encodeQr, MAX_BYTES, qrSvg, qrTerminal } from './device-walk/qr.mjs'
import { createServerControl } from './device-walk/servers.mjs'
import { servingFor } from './device-walk/serving.mjs'

function decode(text, { scale = 4, quiet = 4 } = {}) {
  const { size, dark } = encodeQr(text)
  const n = (size + 2 * quiet) * scale
  const px = new Uint8ClampedArray(n * n * 4).fill(255)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (!dark[y][x]) continue
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx) * 4
          px[i] = px[i + 1] = px[i + 2] = 0
        }
    }
  return jsQR(px, n, n)?.data
}

describe('device-walk qr', () => {
  test('device-walk qr: strings of every version 1-10 decode back exactly', () => {
    const base = 'https://quiet-fox-1234.trycloudflare.com/mp.html?linklog=1&x='
    const seen = new Set()
    for (const len of [1, 14, 26, 42, 62, 84, 106, 122, 152, 180, MAX_BYTES]) {
      const text = (base + 'abcdefghij0123456789'.repeat(12)).slice(0, len)
      expect(decode(text), `len ${len}`).toBe(text)
      seen.add(encodeQr(text).version)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  test('device-walk qr: UTF-8, the Fly URL and a tunnel URL decode; too long throws', () => {
    for (const t of [
      'https://engine-v2-ref.fly.dev/?linklog=1',
      'http://127.0.0.1:4173/device.html?autopan=1&tiles=256&scale=2',
      'héllo ✓',
    ])
      expect(decode(t)).toBe(t)
    expect(() => encodeQr('x'.repeat(MAX_BYTES + 1))).toThrow(/do not fit/)
  })

  test('device-walk qr: svg and terminal renderings are well formed', () => {
    const svg = qrSvg('https://example.com/')
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 (\d+) \1"/)
    const rows = qrTerminal('https://example.com/').split('\n')
    expect(rows.length).toBeGreaterThan(10)
    expect(new Set(rows.map((r) => [...r].length)).size).toBe(1)
  })
})

/** A fake `spawnServe`: records starts and stops; the test drives its output. */
function fake() {
  const started = []
  const spawnServe = (args, io) => {
    const child = { args, io, stopped: false, pid: 100 + started.length }
    child.stop = async () => {
      child.stopped = true
    }
    started.push(child)
    queueMicrotask(() => {
      io.onLine('building…')
      io.onLine('DEVICE_SERVE_URL=http://127.0.0.1:4173')
      if (args.includes('--tunnel'))
        io.onLine(`DEVICE_SERVE_TUNNEL_URL=https://t${started.length}.trycloudflare.com`)
    })
    return child
  }
  return { started, spawnServe }
}
const item = (over) => ({
  ...servingFor({ id: 'X', open: '`device.html`', lead: '', steps: '' }),
  ...over,
})

describe('device-walk servers', () => {
  const mk = (f, extra = {}) =>
    createServerControl({
      spawnServe: f.spawnServe,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
      ...extra,
    })

  test('device-walk servers: URLs are captured from the machine-readable lines', async () => {
    const f = fake()
    const c = mk(f)
    const urls = await c.ensure(item({ tunnel: true }))
    expect(urls).toEqual({
      loopback: 'http://127.0.0.1:4173',
      tunnel: 'https://t1.trycloudflare.com',
    })
    expect(f.started[0].args).toEqual(['--tunnel'])
    expect(c.status()).toMatchObject({
      status: 'ready',
      log: ['building…', expect.any(String), expect.any(String)],
    })
  })

  test('device-walk servers: a compatible variant is reused, a different one stops the old child first', async () => {
    const f = fake()
    const c = mk(f)
    await c.ensure(item({ tunnel: true }))
    await c.ensure(item({ tunnel: true }))
    await c.ensure(item({ tunnel: false, device: 'mac' })) // a tunnel server serves loopback too
    expect(f.started).toHaveLength(1)
    await c.ensure(item({ tunnel: true, app: 'reference' }))
    expect(f.started).toHaveLength(2)
    expect(f.started[0].stopped).toBe(true)
    expect(f.started[1].stopped).toBe(false)
  })

  test('device-walk servers: concurrent ensures serialise: one start, no overlap', async () => {
    const f = fake()
    const c = mk(f)
    await Promise.all([
      c.ensure(item({ tunnel: true })),
      c.ensure(item({ tunnel: true })),
      c.ensure(item({ tunnel: true, ws: 'puts' })),
    ])
    expect(f.started.map((s) => s.args)).toEqual([['--tunnel'], ['--tunnel', '--ws', 'puts']])
    expect(f.started[0].stopped).toBe(true)
  })

  test('device-walk servers: stopAll stops the child; a child that died is restarted by the next ensure', async () => {
    const f = fake()
    const c = mk(f)
    await c.ensure(item({ tunnel: true }))
    f.started[0].io.onExit(1)
    expect(c.status().status).toBe('failed')
    await c.ensure(item({ tunnel: true }))
    expect(f.started).toHaveLength(2)
    await c.stopAll()
    expect(f.started[1].stopped).toBe(true)
    expect(c.status().status).toBe('idle')
  })

  test('device-walk servers: exit before any URL fails with the log tail; a timeout stops the child', async () => {
    const dying = createServerControl({
      spawnServe: (args, io) => {
        queueMicrotask(() => {
          io.onLine('vite build failed')
          io.onExit(1)
        })
        return { stop: async () => {} }
      },
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    })
    await expect(dying.ensure(item({ tunnel: false }))).rejects.toThrow(
      /exited \(1\).*vite build failed/,
    )
    const f = { stopped: false }
    const silent = createServerControl({
      spawnServe: () => ({ stop: async () => (f.stopped = true) }),
      startTimeoutMs: 30,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
    })
    await expect(silent.ensure(item({ tunnel: false }))).rejects.toThrow(/no URL within 30 ms/)
    expect(f.stopped).toBe(true)
  })

  test('device-walk servers: ready waits for the probe of the tunnel URL', async () => {
    const f = fake()
    let calls = 0
    const c = mk(f, { probe: async (u) => (u.startsWith('https://') ? ++calls >= 3 : true) })
    await c.ensure(item({ tunnel: true }))
    expect(calls).toBe(3)
  })
})
