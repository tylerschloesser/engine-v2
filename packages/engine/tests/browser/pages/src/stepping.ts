// `stepping.html`'s script: builds a harness with one sim-role worker (the `hash` fixture, same
// config as `golden/scenario.json`) and assigns `window.__harness` (Seams, "Page contract used by
// every spec"). `stepping.spec.ts` drives everything else through `page.evaluate`.
import wasm from 'virtual:engine/wasm'
import scenario from '../../../../fixtures/hash/golden/scenario.json' with { type: 'json' }
import { Role } from '../../../../src/abi.ts'
import { createHarness, type Harness } from '../../../../src/test/harness.ts'

declare global {
  interface Window {
    __harness?: Harness
    __stepping?: { ready: boolean }
    /** `tests/browser/support/page.ts`'s `openPage` waits for this (`page.goto`'s `load` event does
     * not reliably wait out a module's top-level `await` chain: measured). */
    __pageReady?: true
  }
}

const harness = await createHarness({
  wasm,
  workers: [{ name: 'sim', role: Role.Sim, config: scenario.config }],
})
window.__harness = harness
window.__stepping = { ready: true }
window.__pageReady = true
