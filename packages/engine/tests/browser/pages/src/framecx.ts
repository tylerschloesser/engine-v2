// `framecx.html`'s script (docs/plan/18-picking-and-overlay.md Tests added: `framecx.
// tap_visible_in_frame`, `framecx.emit_visible_in_frame`): the one browser page that needs a real
// WASM `ClientSide::frame` to prove `cx.input()`/`client.input.emit` actually reach Rust -- every
// other picking/overlay/follow browser test in this milestone gets by on a hand-filled DrawList SAB
// over `real-camera.html` with no WASM at all (steps 1-3's own precedent), but *this* is exactly the
// thing that precedent cannot reach: whether an event written into `inputRing` is visible inside a
// real `frame()` call's own `FrameCx`. `fixtures/overlay`'s `OverlayClient::frame` records the last
// event's raw fields and forces a `ui` rerun (`cx.ui_dirty()`); this page reads it back through
// `client.onUi`, independent of any DOM (no rendering, no overlay -- `framecx.html` has no elements
// this script touches).
//
// No `frame-loop.ts` here (`Client.pick`/`camera.tick` are unused): `stepFrame` is `test/client.ts`'s
// own client-worker `frame()` trigger, all this page needs. `host: { kind: 'remote', ... }` unconnected
// (`real-camera.ts`'s own precedent): the client role's WASM instance runs regardless of any host
// link, and no sim/action round trip is needed to observe `frame()`.
import type { Client, ClientOptions } from '../../../../src/client.ts'
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { type InputKind, writeInputRecord } from '../../../../src/input/record.ts'
import { RingProducer } from '../../../../src/sab/ring.ts'
import { lastUi, stepFrame } from '../../../../src/test/client.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

/** `fixtures/overlay/src/lib.rs`'s own `OverlayUi` (hand-mirrored, not imported bindings: this
 * fixture is not in `scripts/build-fixtures.mjs`'s `BINDINGS_FIXTURES` set -- five plain numeric
 * fields are cheaper to keep in sync by hand than to add a bindings-export step for). */
type OverlayUi = {
  count: number
  last_kind: number
  last_pick_id: number
  last_tile_x: number
  last_tile_y: number
}

declare global {
  interface Window {
    __pageReady?: true
    __ready?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __stepFrame?: (dtMs: number) => void
    /** Writes one raw `inputRing` record directly (bypassing `input/semantic.ts`'s gesture
     * recognition entirely -- this page only needs *a* record of a given `kind` to reach `cx.
     * input()`, not a real tap gesture) and returns whether it was written (`false` = ring full). */
    __injectRawInput?: (kind: number, tileX: number, tileY: number, pickId: number) => boolean
    __emit?: (code: number, a?: number, b?: number) => boolean
    __lastUi?: () => OverlayUi | undefined
  }
}

const wasm = await fixtureWasm('overlay')
const canvas = document.createElement('canvas')
const clock = createManualClock()

const client: Client = createClient({
  canvas,
  wasm,
  host: { kind: 'remote', url: 'ws://unused.invalid' },
  genWorkers: 1,
  // An unconnected ('remote') host builds no real `WorldConfig` (`src/client.ts`'s own comment:
  // "only present for a local host"), so the client role's own `TerrainConfig` (`game_instance.rs`,
  // `{seed, params}`) needs `options.test.game` here -- unlike `real-camera.ts`'s own fixture
  // (`terrain`), whose hand-written pre-`GameInstance` `Instance` impl tolerates no config at all,
  // `fx-overlay` goes through `engine::export_game!`'s real `TerrainConfig::deserialize`.
  test: { clock, flags: {}, game: { seed: '0x1', params: null } },
} satisfies ClientOptions)
client.ready.catch(() => {})

window.__ready = async () => {
  try {
    await client.ready
    return { ok: true }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, code: err.code ?? '', message: err.message ?? String(e) }
  }
}
window.__stepFrame = (dtMs) => stepFrame(client, dtMs)

const inputRing = new RingProducer(clientTestHandle(client).sabs.inputRing)
window.__injectRawInput = (kind, tileX, tileY, pickId) => {
  const idx = inputRing.tryClaim()
  if (idx < 0) return false
  writeInputRecord(inputRing.slotView(idx), 0, {
    kind: kind as (typeof InputKind)[keyof typeof InputKind],
    button: 0,
    modifiers: 0,
    pointer: 0,
    seq: 0,
    tileX,
    tileY,
    fracX: 0,
    fracY: 0,
    pickId,
    timeMs: 0,
  })
  inputRing.commit()
  return true
}

window.__emit = (code, a, b) => client.input.emit(code, a, b)
window.__lastUi = () => lastUi<OverlayUi>(client)

window.__pageReady = true
