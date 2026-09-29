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
import { openPage } from './support/page.js'
import { startTestServer, type TestServer } from './support/test-server.js'

const PUTS_DIR = fixtureBuildDir('puts')
// A fixed port, not `startTestServer`'s own default OS-assigned one (Deviations): `zeroGcSuite`'s
// `path` is a plain string, registered synchronously at file-load time, well before `test.beforeAll`
// ever runs -- there is no way to thread an async-discovered port into it. Worker-indexed (the same
// `TEST_PARALLEL_INDEX` convention `playwright.config.ts`'s own `cdpPort` uses) so two `gc` project
// workers that each pick up a test from this file never collide.
const PORT = 48_173 + Number(process.env.TEST_PARALLEL_INDEX ?? 0)
const BASE_PATH = `/gc-multiplayer-topology.html?url=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}`

let server: TestServer | undefined
let tickTimer: ReturnType<typeof setInterval> | undefined

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
const HEARTBEAT_MS = 2000

test.beforeAll(async () => {
  server = await startTestServer({ fixture: PUTS_DIR, manualTimer: true, port: PORT })
  tickTimer = setInterval(() => server?.stepTick(), HEARTBEAT_MS)
})

test.afterAll(async () => {
  if (tickTimer !== undefined) clearInterval(tickTimer)
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
    return await measure(page, browser, { pageId: 'multiplayer-topology', control: null })
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
