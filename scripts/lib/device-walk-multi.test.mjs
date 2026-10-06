// M39f step 2: the keyed server control (every variant at once, own ports and tunnel, builds of one app
// serialised) and the serve-time injection plugin's pure parts.
import { describe, expect, test } from 'vitest'
import {
  injectWalkTag,
  WALK_TAG,
  walkPreview,
  walkProxy,
} from '../../packages/engine/scripts/walk-preview-plugin.ts'
import { createMultiServerControl, variantKey } from './device-walk/servers.mjs'

/** A fake `spawnServe` that prints its URL lines after `delay` ms and records every start. */
function fake(delay = 5) {
  const started = []
  const spawnServe = (args, io) => {
    const child = { args, env: io.env, spawnedAt: performance.now(), readyAt: 0, stopped: false }
    child.stop = async () => {
      child.stopped = true
    }
    started.push(child)
    const n = started.length
    setTimeout(() => {
      child.readyAt = performance.now()
      io.onLine(`DEVICE_SERVE_URL=http://127.0.0.1:${io.env.ENGINE_TEST_PORT}`)
      if (args.includes('--tunnel'))
        io.onLine(`DEVICE_SERVE_TUNNEL_URL=https://t${n}.trycloudflare.com`)
    }, delay)
    return child
  }
  return { started, spawnServe }
}
const v = (over) => ({ app: 'fixture', ws: false, bench: false, tunnel: true, ...over })

describe('device-walk multi servers', () => {
  const mk = (f) =>
    createMultiServerControl({
      spawnServe: f.spawnServe,
      walkPort: 5555,
      basePort: 4500,
      wsBasePort: 4501,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    })

  test('device-walk multi: every variant starts at once with its own ports, tunnel and --walk', async () => {
    const f = fake()
    const c = mk(f)
    const urls = await c.ensureAll([v({ ws: 'puts' }), v({ app: 'reference', ws: 'default' })])
    expect(Object.keys(urls)).toEqual(['fixture-ws', 'reference-ws'])
    // Both were spawned before either was ready: parallel, not one after the other.
    expect(Math.max(...f.started.map((s) => s.spawnedAt))).toBeLessThan(
      Math.min(...f.started.map((s) => s.readyAt)),
    )
    expect(f.started.map((s) => s.env)).toEqual([
      { ENGINE_TEST_PORT: '4500', ENGINE_WS_PORT: '4501' },
      { ENGINE_TEST_PORT: '4510', ENGINE_WS_PORT: '4511' },
    ])
    for (const s of f.started) expect(s.args.join(' ')).toMatch(/--tunnel .*--walk 5555$/)
    expect(f.started[0].args).toEqual(['--tunnel', '--ws', 'puts', '--walk', '5555'])
    expect(c.urlFor('fixture-ws')).toMatch(/^https:\/\/t\d\.trycloudflare\.com$/)
    expect(c.urlFor('reference-ws')).not.toBe(c.urlFor('fixture-ws'))
    expect(c.urlFor('nope')).toBeNull()
  })

  test('device-walk multi: builds of one app are serialised, and a second server of a built app skips the build', async () => {
    const f = fake(15)
    const c = mk(f)
    await c.ensureAll([
      v({ app: 'reference', ws: 'default' }),
      v({ app: 'reference', bench: true, ws: false }),
      v({ key: 'fixture-b' }),
      v({ key: 'fixture-a' }),
    ])
    const by = (flag) => f.started.filter((s) => s.args.includes(flag))
    const [ref, bench] = [
      by('--bench'),
      f.started.find((s) => s.args.includes('--app') && !s.args.includes('--bench')),
    ]
    // The bench build started only after the release build of the same app was serving.
    expect(ref[0].spawnedAt).toBeGreaterThanOrEqual(bench.readyAt)
    // The second fixture reuses the first one's dist; the first (fixture-b) builds.
    const fixtures = f.started.filter((s) => !s.args.includes('--app'))
    expect(fixtures.map((s) => s.args.includes('--no-build'))).toEqual([false, true])
    expect(bench.args.includes('--no-build')).toBe(false)
    // Four servers, four distinct port pairs.
    expect(new Set(f.started.map((s) => s.env.ENGINE_TEST_PORT)).size).toBe(4)
  })

  test('device-walk multi: stopAll stops every child; variantKey is stable', async () => {
    const f = fake()
    const c = mk(f)
    await c.ensureAll([v(), v({ app: 'reference' })])
    await c.stopAll()
    expect(f.started.every((s) => s.stopped)).toBe(true)
    expect(variantKey(v({ app: 'reference', bench: true }))).toBe('reference-bench')
    expect(variantKey(v({ key: 'x' }))).toBe('x')
  })
})

describe('device-walk preview plugin', () => {
  test('device-walk plugin: nothing without ENGINE_WALK_PORT; with it only a preview hook and the /__walk proxy', () => {
    expect(walkPreview(undefined)).toEqual([])
    expect(walkProxy(undefined)).toEqual({})
    const [p] = walkPreview('4999')
    expect(Object.keys(p).sort()).toEqual(['apply', 'configurePreviewServer', 'name'])
    expect(p.apply).toBe('serve')
    expect(walkProxy('4999')['/__walk']).toEqual({
      target: 'http://127.0.0.1:4999',
      ws: true,
      changeOrigin: false,
    })
  })

  test('device-walk plugin: the tag goes right after <head>, once, and before any page script', () => {
    const out = injectWalkTag(
      '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/a.js"></script></head></html>',
    )
    expect(out.indexOf(WALK_TAG)).toBeLessThan(out.indexOf('<meta'))
    expect(out.split(WALK_TAG)).toHaveLength(2)
    expect(injectWalkTag('<p>no head</p>').startsWith(WALK_TAG)).toBe(true)
  })
})

describe('device-walk reapStale', () => {
  test('device-walk reap: only servers whose owning tool is gone are killed; a live owner and legacy entries are kept', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { reapStale } = await import('./device-walk/spawn-serve.mjs')
    const file = join(mkdtempSync(join(tmpdir(), 'dwreap-')), 'pids.json')
    writeFileSync(
      file,
      JSON.stringify([
        { pid: 11, owner: 1 }, // owner gone: reaped
        { pid: 12, owner: 2 }, // owner alive (somebody else's round): kept
        99934, // legacy bare number: owner unknown, kept
        { pid: 14 }, // no owner recorded: kept
        { pid: 13, owner: 1 }, // owner gone, but the pid is no longer a device-serve: dropped, not killed
      ]),
    )
    const killed = []
    const out = reapStale({
      file,
      isAlive: (p) => p === 2,
      command: (p) => (p === 13 ? 'vim' : 'node device-serve.mjs'),
      kill: (pid, sig) => killed.push([pid, sig]),
    })
    expect(out).toEqual([11])
    expect(killed).toEqual([[11, 'SIGTERM']])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
      { pid: 12, owner: 2 },
      99934,
      { pid: 14 },
    ])
  })
})

describe('device-walk reapOrphans', () => {
  test("device-walk reap: the orphaned vite preview, reference-server and tunnel of a SIGKILLed run are reaped; a live tool's servers and strangers are not", async () => {
    const { reapOrphans } = await import('./device-walk/spawn-serve.mjs')
    const list = () => [
      {
        pid: 101,
        ppid: 1,
        command:
          'node ./node_modules/.bin/../vite/bin/vite.js preview --config packages/engine/tests/browser/pages/vite.config.ts --host 127.0.0.1',
        ports: [4173],
      },
      {
        pid: 102,
        ppid: 1,
        command: 'node /Users/x/repos/engine-v2/games/reference-server --game /g --port 4184',
        ports: [4184],
      },
      { pid: 103, ppid: 1, command: 'cloudflared tunnel --url http://127.0.0.1:4193', ports: [] },
      { pid: 104, ppid: 1, command: 'node /somewhere/else/server.js', ports: [4180] }, // a stranger on the port: not ours
      { pid: 105, ppid: 55, command: 'node vite.js preview --host 127.0.0.1', ports: [4183] }, // its tool is alive
      {
        pid: 106,
        ppid: 1,
        command: 'node /Users/x/other/vite.js preview --host 127.0.0.1',
        ports: [3000],
      }, // another project's vite, off our ports: not ours
      { pid: 107, ppid: 1, command: 'cloudflared tunnel --url http://127.0.0.1:8080', ports: [] }, // not ours
    ]
    const killed = []
    const out = reapOrphans({ list, kill: (pid, sig) => killed.push([pid, sig]) })
    expect(out).toEqual([101, 102, 103])
    expect(killed.every(([, sig]) => sig === 'SIGTERM')).toBe(true)
  })
})
