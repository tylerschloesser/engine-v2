// `wiring.html`'s script: the only page that imports the real `virtual:engine/wasm` (M02b; other
// pages load fixtures through `fixture-wasm.ts`). Extended for M03 with the harness/worker wiring
// `wiring.spec.ts` drives: an `onLog` line from a plain main-thread `instantiate()` (no worker or
// isolation needed for that), the ABI version read off the module, and a `__createHarness` escape
// hatch so the spec can build a harness with its own config (the panicAtTick test needs one).
import wasm from 'virtual:engine/wasm'
import { Role } from '../../../../src/abi.ts'
import { instantiate } from '../../../../src/loader.ts'
import {
  createHarness,
  type Harness,
  type HarnessWorkerSpec,
} from '../../../../src/test/harness.ts'

declare global {
  interface Window {
    __wiring?: {
      url: string
      buildHash: string
      contentType: string | null
      crossOriginIsolated: boolean
      abiVersion: number
      logLines: string[]
    }
    __createHarness?: (workers: HarnessWorkerSpec[]) => Promise<Harness>
    /** The signal `tests/browser/support/page.ts`'s `openPage` waits for: `page.goto`'s `load`
     * event does not reliably wait out this module's top-level `await` chain (measured). */
    __pageReady?: true
  }
}

// One fetch: reading `res.headers` does not consume the body, so the same Response streams into
// `compileStreaming` (a second fetch of this dev-profile module, several MB with DWARF, made the
// suite flaky under three parallel browsers: measured).
const res = await fetch(wasm.url)
const module = await WebAssembly.compileStreaming(res)

const logLines: string[] = []
const probe = instantiate(
  module,
  Role.Sim,
  { arenaBytes: 1 << 20, game: { seed: '0x1', entities: 4 } },
  {
    onLog(_level, text) {
      logLines.push(text)
    },
  },
)

window.__wiring = {
  url: wasm.url,
  buildHash: wasm.buildHash,
  contentType: res.headers.get('content-type'),
  crossOriginIsolated: window.crossOriginIsolated,
  abiVersion: probe.call0(probe.x.engine_abi_version),
  logLines,
}

window.__createHarness = (workers) => createHarness({ wasm: module, workers })
window.__pageReady = true
