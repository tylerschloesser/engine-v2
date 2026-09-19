// `gc-loop.html`'s script (docs/plan/04-zero-gc-harness.md, Scope): one sim-role worker named `sim`
// on fixture `hash`. Per frame: `stepFrame` + `stepTick`; per tick the worker copies a fixed block
// SAB -> `Rx`, calls `sim_admit`, `sim_tick`, `sim_build_frame`, copies the fixed frame block
// `Tx` -> SAB through view pairs created at init (`harness-worker.ts`'s `coreTick`); main reads that
// block once per frame. `hash` is this whole pages app's default fixture (packages/engine/CLAUDE.md,
// "Browser test pages"), so this page imports the real virtual module like `wiring.html` does.
import wasm from 'virtual:engine/wasm'
import scenario from '../../../../fixtures/hash/golden/scenario.json' with { type: 'json' }
import { Role } from '../../../../src/abi.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createHarness, type Harness } from '../../../../src/test/harness.ts'

declare global {
  interface Window {
    __harness?: Harness
    /** `tests/browser/support/page.ts`'s `openPage` waits for this (`page.goto`'s `load` event does
     * not reliably wait out a module's top-level `await` chain: measured, M03). */
    __pageReady?: true
  }
}

// `hash`'s `Rx` region is 64 B (fixtures/hash/src/lib.rs: `layout.region(RegionId::Rx, 64)`) and its
// `Tx` region is `FRAME_BYTES` = 64 B; both blocks below are sized to match exactly, so every copy
// is a whole-block `set()` with no `subarray()` (0014 §4, .claude/rules/hot-paths.md).
const RX_TX_BYTES = 64
const rx = new SharedArrayBuffer(RX_TX_BYTES)
const tx = new SharedArrayBuffer(RX_TX_BYTES)
// Preallocated at init, read every frame, never recreated (.claude/rules/hot-paths.md).
const txView = new Uint8Array(tx)

const harness = await createHarness({
  wasm,
  workers: [{ name: 'sim', role: Role.Sim, config: scenario.config, rxTx: { rx, tx } }],
})

installGcPage(harness, {
  drive(_frame) {
    harness.stepFrame(1000 / 60)
    harness.stepTick()
    // Main reads the block the worker just copied `Tx` into (Scope): a plain read through the
    // preallocated view, not used for anything but keeping the read real.
    void txView[0]
  },
})

window.__harness = harness
window.__pageReady = true
