// `pnpm device:walk --auto` core (M39f): start the phone API with the step machine, one fixture server per
// variant the walked checks need (`--walk`, a tunnel each unless `tunnel: false`), the Mac-side desktop
// median for M08-warn-threshold, print the QR of the runner page and wait for the round to finish. The
// CLI flags, `--wait` and the live Mac UI are delegation 5; this is the part a fake phone drives today.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserOf, createAutoRound } from './auto-round.mjs'
import { createBots } from './bot.mjs'
import { CHECKS, MP_TILES } from './checks.mjs'
import { desktopMedian } from './desktop-median.mjs'
import { createPhoneApi } from './phone-api.mjs'
import { qrSvg, qrTerminal } from './qr.mjs'
import { appendEvent, readEvents } from './rounds.mjs'
import { createMultiServerControl } from './servers.mjs'
import { pagePaths, warmTunnel, wsHandshake } from './warm.mjs'

/**
 * What each variant of `checks.mjs` is served as. `fixture-ws`: the fixture app with `--ws puts` (the real-time
 * server `mp.html` dials). `reference`: the release build, no hooks, no server. `reference-bench`: the bench
 * build (`vite build --mode bench`, the reference game's check build: `window.__check`, `?bench=large-save`)
 * with the real-time server built with the same cargo feature, so a phone and the Mac bot join one world.
 * `reference-ws`: the release build with its server (the human M39 rows; never walked by the agent).
 */
export const VARIANTS = {
  fixture: { app: 'fixture', ws: false, bench: false },
  'fixture-ws': { app: 'fixture', ws: 'puts', bench: false },
  reference: { app: 'reference', ws: false, bench: false },
  'reference-ws': { app: 'reference', ws: 'default', bench: false },
  'reference-bench': { app: 'reference', ws: 'default', bench: true },
}
const serving = (key) => {
  if (!VARIANTS[key]) throw new Error(`no serving for the variant "${key}" (auto-cli.mjs VARIANTS)`)
  return VARIANTS[key]
}

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
 *   api: object, machine: object, origins: Record<string, string> }>}
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
  // A retired check (M35-capability: `capability.spec.ts` covers it, Tyler's ruling) is not walked and is
  // recorded as such, so a finished round has no open row.
  for (const it of items) {
    const entry = CHECKS[it.id]
    if (entry?.class === 'retired' && !it.android)
      if (!readEvents(file).some((e) => e.type === 'result' && e.id === it.id))
        appendEvent(file, {
          type: 'result',
          id: it.id,
          result: 'skip',
          by: 'auto',
          notes: `retired from the device list: ${entry.signal}`,
        })
  }
  const origins = {}
  // The Mac's own browsers (step 14, `plan.device: 'mac'`): loopback origins, one tab per browser, opened by
  // `o.openMac(browser, url)` when a Mac row opens an attempt (or its next leg); a tab of that browser heard
  // from in the last 30 s is alive and polls the step, so none is opened beside it.
  const macOrigins = {}
  const macSeen = {}
  let macN = 0
  const openLeg = (plan, k) => {
    const browser = plan.browsers?.[k]
    const origin = macOrigins[plan.variant]
    if (!browser || !origin || !o.openMac) return
    if (Date.now() - (macSeen[browser] ?? 0) < 30_000) return
    const url = `${origin}/__walk/runner.html?walk=${token}&run=${encodeURIComponent(round)}&tab=mac${browser}-${++macN}`
    log(`opening ${browser} on the Mac: ${url}`)
    o.openMac(browser, url)
  }
  // The Mac bot partner of M34 (`bot.mjs`): started when an attempt of a check with `plan.bot` opens, one at a
  // time, on the check build's loopback origin (the bot is on the Mac). Built once the servers are up.
  let bots = null
  const machine = createAutoRound({
    file,
    items,
    origins,
    macOrigins,
    params: o.params,
    evidenceBase: REPO,
    onLeg: (l) => openLeg(l.plan, l.k),
    onAttempt: (a) => {
      if (a.plan.device === 'mac') openLeg(a.plan, 0)
      if (!bots) return
      for (const other of bots.active()) if (other !== a.id) bots.finish(other)
      bots.start(a)
    },
  })
  const api = createPhoneApi({
    file,
    round,
    token,
    seriesDir,
    ...machine.hooks,
    observe: (msg, at) => {
      if (String(msg.tab).startsWith('mac')) macSeen[browserOf(msg.tab)] = at
    },
  })
  machine.attach(api)
  const walkPort = await api.listen(0)
  const control = createMultiServerControl({
    spawnServe,
    walkPort,
    basePort: o.basePort ?? Number(process.env.ENGINE_TEST_PORT ?? 4173),
    wsBasePort: o.wsBasePort ?? Number(process.env.ENGINE_WS_PORT ?? 4174),
  })
  const stop = async () => {
    await bots?.stop()
    await control.stopAll()
    await api.close()
  }
  try {
    const keys = machine.variants()
    log(`starting ${keys.length} server(s): ${keys.join(', ')}`)
    await control.ensureAll(keys.map((key) => ({ key, ...serving(key), tunnel })))
    // A cold quick tunnel serves its first loads without COOP/COEP for a while: the Mac loads each variant's page,
    // scripts and module through it until they all carry the headers, before any attempt can open (M39n).
    if (tunnel)
      await Promise.all(
        keys.map((key) => {
          const u = control.urlsFor(key)
          if (!u.tunnel) return null
          const s = serving(key)
          const dist = join(REPO, 'games/reference', s.bench ? 'dist-bench' : 'dist')
          return (o.warm ?? warmTunnel)({
            origin: u.tunnel,
            paths: s.app === 'reference' ? pagePaths(dist) : ['/'],
            log,
          })
        }),
      )
    for (const key of keys) {
      const u = control.urlsFor(key)
      origins[key] = control.urlFor(key)
      macOrigins[key] = u.loopback ?? origins[key]
      for (const x of [u.loopback, u.tunnel, origins[key]]) if (x) api.allowHost(x)
      if (u.loopback) api.allowHost(u.loopback.replace('127.0.0.1', 'localhost'))
    }
    if (keys.includes('reference-bench'))
      bots = createBots({
        file,
        append: (e) => api.append(e),
        origin: control.urlsFor('reference-bench').loopback,
        tiles: MP_TILES,
        launch: o.launchBot,
        timings: o.botTimings,
        log,
        serverLog: () => control.logFor('reference-bench'),
        handshake: () =>
          (o.handshake ?? wsHandshake)({ origin: control.urlsFor('reference-bench').loopback }),
      })
    if (machine.needsDesktopMedian()) {
      const loopback = control.urlsFor('fixture').loopback
      log('running worldgen-bench.html in headless Chromium for the desktop median...')
      const run = o.desktop ?? ((url) => desktopMedian({ url }))
      run(loopback).then(
        (v) => machine.setDesktopMedian(v ?? null),
        () => machine.setDesktopMedian(null),
      )
    }
    // Only Mac rows: no phone is needed, the first Mac tab opens by itself and starts the walk.
    if (machine.macOnly()) {
      const firstRow = machine.list.find((i) => CHECKS[i.id].plan.built)
      if (firstRow) openLeg(CHECKS[firstRow.id].plan, 0)
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
    return { finished, stop, joinUrl, token, api, machine, origins }
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
