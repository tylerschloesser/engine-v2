// `mp/*` (docs/plan/29-net-worker-and-reference-server.md Tests added): browser specs against a
// real `startTestServer` (`support/test-server.ts`) on its own manual timer -- a real `ws` socket
// end to end (`mp.html`), stepped in lockstep with whatever the page under test just did, never a
// real wall-clock pacing race. `CloseCode` is `host/handshake.ts`'s own numeric constants, imported
// here only to assert the exact close code `mp/superseded` sees.
import { expect, test } from '@playwright/test'
import { CloseCode } from '../../src/host/handshake.js'
import { fixtureBuildDir } from '../support/fixtures.js'
import { openPage } from './support/page.js'
import { startTestServer, type TestServer } from './support/test-server.js'

declare global {
  interface Window {
    __mpClientReadyResult?: () => { ok: true } | { ok: false; code: string; message: string }
    __mpSetCamera?: (x: number, y: number, tilesAcross: number) => void
    __mpDispatchPaintAt?: (x: number, y: number) => number
    __mpDispatch?: (action: unknown) => number
    __mpConfirmed?: () => number
    __mpRejected?: () => number
    __mpUi?: () => unknown
    __mpLinkState?: () => string
    __mpLinkLog?: () => Array<{
      event: string
      state: string
      code?: number
      msSinceVisible: number
      discarded: boolean
    }>
    __mpRevealed?: () => boolean
    __mpProbeCenterPixel?: () => Promise<{ r: number; g: number; b: number; a: number }>
  }
}

/** `fixtureBuildDir('puts')`, resolved once per server (`startTestServer`'s own accepted union). */
const PUTS_DIR = fixtureBuildDir('puts')

function mpUrl(server: TestServer, extra = ''): string {
  return `/mp.html?url=${encodeURIComponent(server.url)}${extra}`
}

/** Ticks `server` every 20 ms in the background for the life of the returned disposer -- every
 * `mp/*` scenario but `mp/version-mismatch-reloads-once`/`mp/coep-worker-error-message` (neither
 * needs a tick at all: a `Reject`/a blocked worker are both decided before any world state is
 * touched, `server.ts`'s own `onMessage` handler, synchronous) needs the world to actually make
 * progress while a spec awaits a page-side condition. */
function tickInBackground(server: TestServer): { stop(): void; pause(): void; resume(): void } {
  let id: ReturnType<typeof setInterval> | null = setInterval(() => server.stepTick(), 20)
  return {
    pause() {
      if (id !== null) {
        clearInterval(id)
        id = null
      }
    },
    resume() {
      if (id === null) id = setInterval(() => server.stepTick(), 20)
    },
    stop() {
      if (id !== null) clearInterval(id)
      id = null
    },
  }
}

test('mp/reveal-waits-for-visible-chunks', async ({ page }) => {
  test.setTimeout(45_000)
  const server = await startTestServer({ fixture: PUTS_DIR, manualTimer: true })
  const ticks = tickInBackground(server)
  try {
    // Paused at first: the handshake never resolves until this spec lets it (`stepTick` is what
    // drains `pumpHandshakes`), so the very first probe is provably taken before any host tick.
    ticks.pause()
    await openPage(page, mpUrl(server))
    expect(await page.evaluate(() => window.__mpRevealed?.())).toBe(false)
    const beforeReveal = await page.evaluate(() => window.__mpProbeCenterPixel?.())
    // `render/terrain.ts`'s own `colorAttachment.clearValue`: opaque black.
    expect(beforeReveal).toEqual({ r: 0, g: 0, b: 0, a: 255 })

    ticks.resume()
    await page.waitForFunction(() => window.__mpRevealed?.() === true, { timeout: 20_000 })
    const afterReveal = await page.evaluate(() => window.__mpProbeCenterPixel?.())
    // `fx-puts`'s own `FlatWorldgen` (`Tile::new(1, 0, 0)`, pristine): not the clear colour.
    expect(afterReveal).not.toEqual({ r: 0, g: 0, b: 0, a: 255 })
  } finally {
    ticks.stop()
    await server.stop()
  }
})

test('mp/two-pages', async ({ browser }) => {
  test.setTimeout(45_000)
  const server = await startTestServer({ fixture: PUTS_DIR, manualTimer: true })
  const ticks = tickInBackground(server)
  // Two contexts, not two pages of one context: each mints its own `localStorage.
  // engine.playerSecret` (`client/secret.ts`, one per origin) only when the contexts are actually
  // isolated -- the same-context case is `mp/superseded`'s own scenario, deliberately the opposite.
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()
    await openPage(pageA, mpUrl(server))
    await openPage(pageB, mpUrl(server))
    await pageA.waitForFunction(() => window.__mpLinkState?.() === 'online', { timeout: 20_000 })
    await pageB.waitForFunction(() => window.__mpLinkState?.() === 'online', { timeout: 20_000 })

    // Global scope (0003, `tests/netcode/CLAUDE.md`'s own `join-converges` precedent): no camera/
    // subscription dependency, so B needs no particular position to see it.
    await pageA.evaluate(() => window.__mpDispatch?.({ SetMotd: { n: 77 } }))
    await pageB.waitForFunction(
      () => (window.__mpUi?.() as { motd?: number } | null)?.motd === 77,
      { timeout: 20_000 },
    )
    // A's own replica converges too (it dispatched the action, but only ever *sees* the effect
    // through the same replicated `Global` scope every other client does -- no special-casing of
    // "my own action" on the read side): polled, not read once, since A's own next frame may not
    // have landed in the same instant B's did.
    await pageA.waitForFunction(
      () => (window.__mpUi?.() as { motd?: number } | null)?.motd === 77,
      { timeout: 20_000 },
    )
  } finally {
    ticks.stop()
    await server.stop()
    await contextA.close()
    await contextB.close()
  }
})

test('mp/reconnect', async ({ page }) => {
  test.setTimeout(45_000)
  const server = await startTestServer({ fixture: PUTS_DIR, manualTimer: true })
  const ticks = tickInBackground(server)
  try {
    await openPage(page, mpUrl(server))
    await page.waitForFunction(() => window.__mpLinkState?.() === 'online', { timeout: 20_000 })

    const seq = await page.evaluate(() => window.__mpDispatch?.({ SetMotd: { n: 5 } }))
    expect(typeof seq).toBe('number')

    // Kill first, *then* pause ticking: the kill itself needs no tick (a raw socket close), and
    // ticking stays live right up to it so the pre-kill connection's own heartbeats never starve.
    // Pausing only afterward, for just over 0013's own 1 s reconnect-indicator delay, *tries* to
    // guarantee the client shows `'reconnecting'` before the (now necessarily slower) reattach can
    // complete -- but a background `setInterval` can leave one tick already queued past `clearInterval`
    // (measured: this alone was sometimes enough for `pumpHandshakes` to finish the reattach before
    // this check ran), so the live read is best-effort, not asserted; the link log below is the
    // reliable record of what actually happened. A fast enough reattach legitimately never shows
    // `'reconnecting'` at all, by design (`client.ts`'s own `handleNetLink` doc comment: the 1 s
    // indicator delay exists precisely so a quick reconnect never flashes it).
    server.killClients()
    ticks.pause()
    await new Promise((r) => setTimeout(r, 1300))
    ticks.resume()

    await page.waitForFunction(() => window.__mpLinkState?.() === 'online', { timeout: 20_000 })
    const log = await page.evaluate(() => window.__mpLinkLog?.())
    expect(log?.some((e) => e.event === 'close' || e.event === 'silence')).toBe(true)

    // The pending action is applied exactly once (0013 Reconnect: resent actions apply nothing
    // twice) -- confirmed, then held steady across further real ticks.
    await expect
      .poll(() => page.evaluate(() => window.__mpConfirmed?.() ?? -1), { timeout: 10_000 })
      .toBe(1)
    await new Promise((r) => setTimeout(r, 500))
    expect(await page.evaluate(() => window.__mpConfirmed?.())).toBe(1)
  } finally {
    ticks.stop()
    await server.stop()
  }
})

test('mp/superseded', async ({ browser }) => {
  test.setTimeout(45_000)
  const server = await startTestServer({ fixture: PUTS_DIR, manualTimer: true })
  const ticks = tickInBackground(server)
  const context = await browser.newContext()
  try {
    const pageA = await context.newPage()
    await openPage(pageA, mpUrl(server))
    await pageA.waitForFunction(() => window.__mpLinkState?.() === 'online', { timeout: 20_000 })

    // Same context: `localStorage.engine.playerSecret` is shared, so page B dials with the exact
    // same identity (0013 "the same secret in a second tab: newest wins").
    const pageB = await context.newPage()
    await openPage(pageB, mpUrl(server))
    await pageB.waitForFunction(() => window.__mpLinkState?.() === 'online', { timeout: 20_000 })

    await pageA.waitForFunction(() => window.__mpLinkState?.() === 'superseded', {
      timeout: 20_000,
    })
    const log = await pageA.evaluate(() => window.__mpLinkLog?.())
    expect(log?.[0]).toEqual(
      expect.objectContaining({ event: 'close', code: CloseCode.Superseded }),
    )

    // "Opens no socket": the link is terminal (`net/link.ts` -- superseded never redials on its
    // own); the newest log entry stays that same `close`, not a later `open`, even after more
    // real time and more host ticks pass.
    await new Promise((r) => setTimeout(r, 500))
    expect(await pageA.evaluate(() => window.__mpLinkState?.())).toBe('superseded')
    const logAfter = await pageA.evaluate(() => window.__mpLinkLog?.())
    expect(logAfter?.[0]?.event).toBe('close')
  } finally {
    ticks.stop()
    await server.stop()
    await context.close()
  }
})

test('mp/version-mismatch-reloads-once', async ({ page }) => {
  test.setTimeout(45_000)
  const server = await startTestServer({ fixture: PUTS_DIR, manualTimer: true })
  try {
    // No ticking needed at all (`server.ts`'s own `onMessage` handler): a build-hash mismatch is
    // decided synchronously, the instant the `Hello` bytes arrive, never gated on a tick.
    await page.goto(mpUrl(server, '&corruptBuildHash=1'))
    // Registered before the `__pageReady` wait below (not after): the reload can only happen once
    // the client has actually dialed and been rejected, strictly later, so this listener is always
    // in place in time -- registering it after risks missing a reload fast enough to beat the CDP
    // round trip back to this test.
    const reload = page.waitForEvent('load', { timeout: 20_000 })
    await page.waitForFunction(() => window.__pageReady === true)

    // The default handler's own reload (0013 "Build-hash handshake"): a real navigation, to the
    // exact same URL, guarded by `sessionStorage['engine.reloadedFrom']` so it happens only once.
    await reload
    await page.waitForFunction(() => window.__pageReady === true)

    // The second mismatch (same corrupted hash): the guard already matches, so this time it is
    // `updating`, not a second reload.
    await page.waitForFunction(() => window.__mpLinkState?.() === 'updating', { timeout: 20_000 })
    let navigatedAgain = false
    page.once('load', () => {
      navigatedAgain = true
    })
    await new Promise((r) => setTimeout(r, 1500))
    expect(navigatedAgain).toBe(false)
    expect(await page.evaluate(() => window.__mpLinkState?.())).toBe('updating')
  } finally {
    await server.stop()
  }
})

test('mp/coep-worker-error-message', async ({ page }) => {
  // Unchanged from M06 (Scope): `start.worker_blocked_error`'s own scenario (pattern B pointed at
  // the built worker chunk served with COOP but no COEP), proven here on a page that auto-creates
  // its client at load instead of `topology.html`'s imperative `__createClient` -- no server, no
  // real network, needed at all (the rejection happens before any dial).
  await page.goto('/mp.html?blockedWorker=1')
  await page.waitForFunction(() => window.__pageReady === true)
  const r = await page.evaluate(() => window.__mpClientReadyResult?.())
  expect(r?.ok).toBe(false)
  expect(r && !r.ok ? r.code : undefined).toBe('worker-blocked')
  expect(r && !r.ok ? r.message : '').toMatch(/COEP/)
})
