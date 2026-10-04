// `pnpm device:walk --auto` core (M39f): start the phone API with the step machine, one fixture server per
// variant the walked checks need (`--walk`, a tunnel each unless `tunnel: false`), the Mac-side desktop
// median for M08-warn-threshold, print the QR of the runner page and wait for the round to finish. The
// CLI flags, `--wait` and the live Mac UI are delegation 5; this is the part a fake phone drives today.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAutoRound } from './auto-round.mjs'
import { desktopMedian } from './desktop-median.mjs'
import { createPhoneApi } from './phone-api.mjs'
import { qrSvg, qrTerminal } from './qr.mjs'
import { appendEvent, readEvents } from './rounds.mjs'
import { createMultiServerControl } from './servers.mjs'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * Start the servers and the phone API and print the QR; resolves with `joinUrl` as soon as the phone can
 * scan it. `finished()` resolves true when every walked check has a result (false on timeout or abort);
 * the servers stay up until `stop()`.
 * @param {{ round: string, file: string, seriesDir: string, items: object[], only?: string[],
 *   spawnServe: Function, tunnel?: boolean, params?: object, basePort?: number, wsBasePort?: number,
 *   log?: (s: string) => void, timeoutMs?: number, signal?: AbortSignal, pollMs?: number,
 *   desktop?: (url: string) => Promise<number|null> }} o
 * @returns {Promise<{ finished(): Promise<boolean>, stop(): Promise<void>, joinUrl: string, token: string,
 *   api: object, machine: object }>}
 */
export async function startAutoRound(o) {
  const {
    round,
    file,
    seriesDir,
    items,
    spawnServe,
    tunnel = true,
    log = console.log,
    pollMs = 300,
  } = o
  const token = randomBytes(16).toString('hex')
  if (!readEvents(file).some((e) => e.type === 'start'))
    appendEvent(file, { type: 'start', only: o.only ?? null, mode: 'auto' })
  const origins = {}
  const machine = createAutoRound({ file, items, origins, params: o.params, evidenceBase: REPO })
  const api = createPhoneApi({ file, round, token, seriesDir, ...machine.hooks })
  machine.attach(api)
  const walkPort = await api.listen(0)
  const control = createMultiServerControl({
    spawnServe,
    walkPort,
    basePort: o.basePort ?? Number(process.env.ENGINE_TEST_PORT ?? 4173),
    wsBasePort: o.wsBasePort ?? Number(process.env.ENGINE_WS_PORT ?? 4174),
  })
  const stop = async () => {
    await control.stopAll()
    await api.close()
  }
  try {
    const keys = machine.variants()
    log(`starting ${keys.length} server(s): ${keys.join(', ')}`)
    // `fixture-ws`: the fixture app with `--ws puts` (the real-time server `mp.html` dials through `/ws`).
    await control.ensureAll(
      keys.map((key) => ({
        key,
        app: 'fixture',
        ws: key === 'fixture-ws' ? 'puts' : false,
        bench: false,
        tunnel,
      })),
    )
    for (const key of keys) {
      const u = control.urlsFor(key)
      origins[key] = control.urlFor(key)
      for (const x of [u.loopback, u.tunnel, origins[key]]) if (x) api.allowHost(x)
      if (u.loopback) api.allowHost(u.loopback.replace('127.0.0.1', 'localhost'))
    }
    if (machine.needsDesktopMedian()) {
      const loopback = control.urlsFor('fixture').loopback
      log('running worldgen-bench.html in headless Chromium for the desktop median...')
      const run = o.desktop ?? ((url) => desktopMedian({ url }))
      run(loopback).then(
        (v) => machine.setDesktopMedian(v ?? null),
        () => machine.setDesktopMedian(null),
      )
    }
    const first = origins[keys[0]]
    const joinUrl = `${first}/__walk/runner.html?walk=${token}&run=${encodeURIComponent(round)}`
    mkdirSync(seriesDir, { recursive: true })
    writeFileSync(join(seriesDir, 'qr.svg'), qrSvg(joinUrl))
    log(`\nScan with the iPhone camera (opens in Safari):\n${qrTerminal(joinUrl)}\n${joinUrl}\n`)
    const finished = async () => {
      const deadline = Date.now() + (o.timeoutMs ?? 90 * 60_000)
      while (!machine.done() && Date.now() < deadline && !o.signal?.aborted)
        await new Promise((r) => setTimeout(r, pollMs))
      return machine.done()
    }
    return { finished, stop, joinUrl, token, api, machine }
  } catch (e) {
    await stop()
    throw e
  }
}

/** `startAutoRound`, then wait for the round to finish. */
export async function runAutoRound(o) {
  const r = await startAutoRound(o)
  return { ...r, done: await r.finished() }
}
