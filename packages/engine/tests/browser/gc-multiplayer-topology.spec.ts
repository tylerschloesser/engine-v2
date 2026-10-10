// `gc/multiplayer-topology` + `gc/net-negative-control` (docs/plan/
// 29-net-worker-and-reference-server.md, this cut's own step 5): a real `createClient()`
// multiplayer topology (`host: { kind: 'remote' }` -- client + gen0 + net, no sim worker) over a
// real loopback `ws` socket, `zeroGcSuite`-generated exactly like every other production-topology
// gc page, plus this brief's own hand-built control.
//
// **GC test pacing** (Planning decisions): "the test steps the server one tick, awaits the downlink
// ring counter, steps a frame, for the 0016 window. Real 20 Hz pacing would cost 30 s." --
// `gc/instrument.ts`'s own `measure()` drives up to 600+ frames inside *one* CDP round trip (there
// is no hook for Node to step a real tick between individual page frames of that call without
// rebuilding `measure()` itself for this one page, judged too invasive for every other `gc` page in
// this cut), so a real per-frame server tick is approximated two different ways instead, each suited
// to what it drives (Deviations; see `HEARTBEAT_MS`/`runNetInjectParse`'s own comments for why a
// single shared cadence could not serve both): a slow background heartbeat keeps the session itself
// alive for every test in this file, and `net`'s own deterministic once-per-`drive()`-frame trigger
// (`gc-multiplayer-topology.ts`'s own `online` dispatch) gives every negative control -- generic
// `object`/`burst` and this file's own hand-built `netInjectParse` alike -- a reliable, wall-clock-
// independent chance to fire, matching the same "exactly once per measured frame" discipline every
// other isolate's own `body()` already has for free.
import { type Browser, expect, type Page, test } from '@playwright/test'
import { fixtureBuildDir } from '../support/fixtures.js'
import { measure } from './gc/instrument.js'
import { zeroGcSuite } from './gc/suite.js'
import { type MovingRemote, startMovingRemote } from './support/moving-remote.js'
import { openPage } from './support/page.js'
import { startTestServer, type TestServer } from './support/test-server.js'

declare global {
  interface Window {
    __step?: (dtMs: number) => Promise<void>
    __setRebase?: () => void
    __probe?: () => Promise<{ rows: { mode: string }[]; delayMs: number; renderTime: number }>
  }
}

const PRESENCE_DIR = fixtureBuildDir('presence')
// A fixed port, not `startTestServer`'s own default OS-assigned one (Deviations): `zeroGcSuite`'s
// `path` is a plain string, registered synchronously at file-load time, well before `test.beforeAll`
// ever runs -- there is no way to thread an async-discovered port into it. Worker-indexed (the same
// `TEST_PARALLEL_INDEX` convention `playwright.config.ts`'s own `cdpPort` uses) so two `gc` project
// workers that each pick up a test from this file never collide.
// Below 32768: Linux (CI) hands out ephemeral source ports from 32768-60999 and macOS from 49152, so a
// fixed listen port in those ranges can already be held by an outgoing connection (EADDRINUSE on
// CI runs 37705847137 and 37956458910 at 48282).
const PORT = 28_173 + Number(process.env.TEST_PARALLEL_INDEX ?? 0)
const BASE_PATH = `/gc-multiplayer-topology.html?url=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}`

let server: TestServer | undefined
let tickTimer: ReturnType<typeof setInterval> | undefined
let remote: MovingRemote | undefined

// A slow, steady heartbeat cadence for the whole file's lifetime -- just enough real server
// traffic that a genuinely-dead connection would show up, not a throughput source for any test's
// own measurement (Deviations: a first attempt ticked much faster here, as this brief's own
// "steps the server one tick ... for the 0016 window" reads literally, to give `net` real traffic
// to receive during every test -- but real message *volume* scales with however much real wall-
// clock time a given run happens to take, and a page running measurably slower under a sibling
// isolate's own `burst` control (real GC work takes real time) let measurably more of these real
// ticks land inside the very same window, inflating `net`'s own reading by collateral, non-`net`
// causes -- found live: `neg burst {main,client,gen0}` each pushed `net`'s own clean reading up by
// ~20-30 B/frame, into the same range `net`'s own `object` control's real ~24 B/frame delta needed
// to stay visible against, an unresolvable conflict for any single ceiling). `net`'s own
// deterministic, per-drive()-frame trigger (`gc-multiplayer-topology.ts`'s own `online` dispatch,
// wired to `worker/net.ts`'s `linkControl`) already gives every negative control -- `net`'s own
// included -- a reliable, wall-clock-independent chance to fire; this interval only keeps the
// session itself alive and gives `gc/net-negative-control`'s own *default* traffic (its own test
// below adds much more on top, for the duration of that one test alone).
//
// **2000, not 400 (M29b fix round 2): the same collateral mechanism, still leaking, under CI's own
// `GC_MODE=software`+`ENGINE_GPU=swiftshader` specifically.** CI's own `report.json` (two
// independent runs, the same three tests both times): `neg burst main` measured `net` at a raw
// 235.59 B/frame against its 226 B/frame ceiling (`B.net = false` -- `gc/analyse.ts`'s own
// `verdict()`, the `else`/`rawB` branch every isolate but `main` takes in *both* modes, ADR 0029) --
// `neg burst client`/`neg burst gen0` failed the identical way. Every sibling isolate's own `burst`
// control makes the *whole page* run measurably slower in real wall-clock time (real allocation,
// real GC pressure) -- worse under software rendering (swiftshader) and CI's own weaker CPU than on
// a fast dev machine, where the post-split hardware-mode check ("no collateral effect left to
// tolerate") was verified but software mode never was. A slower real window lets more of this
// file's own real, Node-side `setInterval(..., HEARTBEAT_MS)` ticks land inside it -- each one a
// genuine downlink message `net`'s real `onMessage` callback has to process, adding real bytes
// regardless of which isolate the negative control under test actually targets. Same fix shape as
// the *volume* problem already solved for `gc/net-negative-control`'s own dedicated ticker (this
// file's own history, above): fewer real ticks per real second means fewer land inside any one
// window, however long that window takes to run. `2000` stays comfortably under `net/link.ts`'s own
// `DEAD_MS` (3000, `docs/decisions/0013-sessions-and-integrity.md`), a 1000 ms safety margin against
// scheduling jitter -- this interval's only real job (keeping the session from going `'dead'`
// between/during tests), unlike `net`'s own reading, does not depend on ticking *often*.
//
// **M30: `HEARTBEAT_MS` (2000, above) is replaced by `REMOTE_STEP_MS`.** The page holds a camera at
// the origin and a second player (`support/moving-remote.ts`, a real loopback `ws` client on the
// same `presence` fixture) walks a curve there: every step is a new presence sample the host relays
// into the page's own interpolation path, so the background tick is now also the walker's step.
// Real presence traffic is the point (exit criterion: zero-GC with one moving remote), so the
// cadence is 10x faster than the keep-alive it replaces; the budget rows below were re-measured.
const REMOTE_STEP_MS = 200

test.beforeAll(async () => {
  server = await startTestServer({ fixture: PRESENCE_DIR, manualTimer: true, port: PORT })
  remote = await startMovingRemote(server.url, 'presence', () => server?.stepTick())
  tickTimer = setInterval(() => {
    remote?.step()
    server?.stepTick()
  }, REMOTE_STEP_MS)
})

test.afterAll(async () => {
  if (tickTimer !== undefined) clearInterval(tickTimer)
  remote?.leave()
  await server?.stop()
})

zeroGcSuite({
  pageId: 'multiplayer-topology',
  path: BASE_PATH,
  // Production-topology page, same reasoning as `topology`/`gen`/`echo` (orchestrator decision 2 of
  // 06b): no spare `postMessage` type for a message-driven tick.
  controlKinds: ['object', 'burst'],
})

// `gc/net-negative-control` (Scope; this brief's own Consumes note: "not one of `zeroGcSuite`'s
// generated `object`/`burst` pair", "unaffected by [ADR 0026's] tagging rule" -- so this test is not
// `@slow` by that rule; see the tier note below for why it stays fast tier anyway): opens the same
// page with `?netInjectParse=1` (`worker/net.ts`'s own `injectParseConnection`, wired only through
// `TestFlags.netInjectParse`) and asserts the resulting verdict fails `net` specifically while every
// sibling isolate (`main`/`client`/`gen0`) still passes both assertions -- the isolate-only-failure
// shape every other negative control in this suite already proves, but for a hand-injected defect
// class (message parsing) rather than the generic `object`/`burst` allocation shapes `zeroGcSuite`
// itself knows how to generate.
async function runNetInjectParse(page: Page, browser: Browser) {
  await openPage(page, `${BASE_PATH}&netInjectParse=1`)
  // Extra traffic, on top of the shared `HEARTBEAT_MS` background ticker, for the duration of this
  // one test only: this control's own reliability needs real downlink message *volume*
  // specifically (`injectParseConnection` only fires on a genuine `onMessage`), which the shared,
  // slow keep-alive rate alone does not give inside the well-under-a-second a clean run actually
  // takes. Scoped to this test (started after `openPage`, stopped in `finally`) so it never
  // perturbs any other test's own measurement (`HEARTBEAT_MS`'s own doc comment: this is exactly
  // the coupling that made the shared ticker's own rate a bad place for it).
  const extraTicks = setInterval(() => server?.stepTick(30), 5)
  try {
    // `verdictIsolate: 'net'` (M29b fix round 4): this control applies no `zeroGcSuite`-managed
    // `control` at all (its own defect is `?netInjectParse=1`, page-side), but it *is* testing
    // `net`'s own defect -- without this, `net`'s own wide software-mode collateral ceiling
    // (`budgets.json`'s `gc.pages['multiplayer-topology'].software.isolates.net`, meant only to
    // tolerate a *sibling* isolate's own control) would silently swallow this control's own signal
    // too under `GC_MODE=software` (`gc/analyse.ts`'s `verdict()` own doc comment has the finding).
    return await measure(page, browser, {
      pageId: 'multiplayer-topology',
      control: null,
      verdictIsolate: 'net',
    })
  } finally {
    clearInterval(extraTicks)
  }
}

// Tier: fast, not `@slow`. Unlike `zeroGcSuite`'s own generated `burst` negatives (ADR 0026: real GC
// work, tens of thousands of bytes/frame, seconds of tracing), this control's own cost is a real but
// small per-message `JSON.parse`/`TextDecoder.decode` pair -- the same order of magnitude as the
// `object` control's own single small allocation (which ADR 0026 also leaves fast-tier for every
// page), not the `burst` control's. It runs once, like `object`, not once per isolate: there is
// nothing isolate-specific to vary (the injected parse only ever runs inside `net`'s own
// `Connection.onMessage`).
test('gc/net-negative-control', async ({ page, browser }) => {
  const r = await runNetInjectParse(page, browser)
  expect(r.crossOriginIsolated, 'crossOriginIsolated').toBe(true)
  expect(r.errors, 'page errors').toEqual([])
  for (const name of ['main', 'client', 'gen0', 'net']) {
    expect(r.presentIsolates, `${name} thread present in trace`).toContain(name)
  }
  expect(r.verdict.pass, JSON.stringify(r.verdict)).toBe(false)
  // `net` fails at least one assertion (a real per-message allocation may or may not cross the
  // young-generation scavenge threshold that trips assertion A -- `zero_gc_action`'s own budgets.json
  // formula documents the same "real but too small to force a GC event" possibility -- but it always
  // costs real, measured bytes, so assertion B is the one this control is guaranteed to trip).
  expect(r.verdict.B.net, JSON.stringify(r.verdict)).toBe(false)
  for (const name of ['main', 'client', 'gen0']) {
    expect(r.verdict.A[name], `A.${name}: ${JSON.stringify(r.verdict)}`).toBe(true)
    expect(r.verdict.B[name], `B.${name}: ${JSON.stringify(r.verdict)}`).toBe(true)
  }
})

// `rebase-on-visible` (M30 Tests added, browser suite): the real
// multiplayer topology with the moving remote above. Tab return is `frame-loop.ts`'s `resume()`
// setting `CB_FLAGS.FLAG_REBASE` (proved by `viewport.spec.ts`'s `lifecycle: hidden stops visible
// rebases`, which cannot run a client worker); this test sets that same bit, jumps the injected
// clock 5 s as a hidden tab would have, and steps one frame: the client worker must consume the
// flag, snap the interpolation delay back to its initial value and drop every remote, so the first
// frame after the return is `interp` or `hold` (or the remote is simply not drawn yet), never a
// sweep or an extrapolation.
test('rebase-on-visible', async ({ page }) => {
  await openPage(page, BASE_PATH)
  // Frames until the remote is being drawn; the background interval steps the walker and the host.
  let settled: { rows: { mode: string }[]; delayMs: number } | undefined
  for (let i = 0; i < 300 && settled === undefined; i++) {
    const p = await page.evaluate(async () => {
      await window.__step?.(50)
      return window.__probe?.()
    })
    if (p && p.rows.length === 1 && p.delayMs > 0) settled = p
    else await page.waitForTimeout(20)
  }
  if (!settled) throw new Error('rebase-on-visible: the moving remote never became visible')
  // Quiet the walker and the host for the critical section (any frame still in flight lands
  // first), so no relayed sample can land in the frame that follows the return.
  if (tickTimer !== undefined) clearInterval(tickTimer)
  tickTimer = undefined
  try {
    await page.waitForTimeout(150)
    const before = await page.evaluate(async () => {
      await window.__step?.(50)
      return window.__probe?.()
    })
    expect(before?.rows.length, 'the remote is drawn before the return').toBe(1)

    // Return from the background: the flag, a 5 s jump of the injected clock, one frame.
    const after = await page.evaluate(async () => {
      window.__setRebase?.()
      await window.__step?.(5000)
      return window.__probe?.()
    })
    expect(after?.delayMs, 'the delay is back at its initial value').toBe(250)
    // Every remote was dropped: nothing is drawn (and so nothing extrapolated) until the host
    // relays its sample again.
    expect(after?.rows.length, 'the remotes are dropped').toBe(0)

    // The relay restores the remote.
    tickTimer = setInterval(() => {
      remote?.step()
      server?.stepTick()
    }, REMOTE_STEP_MS)
    let back: { rows: { mode: string }[] } | undefined
    for (let i = 0; i < 100 && back === undefined; i++) {
      const p = await page.evaluate(async () => {
        await window.__step?.(50)
        return window.__probe?.()
      })
      if (p && p.rows.length > 0) back = p
      else await page.waitForTimeout(20)
    }
    if (!back) throw new Error('rebase-on-visible: the remote never came back')
    // (No mode assertion here: the injected clock runs at its own pace against the host's real
    // one, so a relayed sample may legitimately be behind `render_t` by then.)
    expect(back.rows.length, 'the relay restores the remote').toBe(1)
  } finally {
    if (tickTimer === undefined) {
      tickTimer = setInterval(() => {
        remote?.step()
        server?.stepTick()
      }, REMOTE_STEP_MS)
    }
  }
})
