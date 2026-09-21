// `semantic.html`'s script (docs/plan/11-camera-and-input.md, Order of work step 5): the whole
// `client.input.recognize` -> `inputRing` -> client worker drain -> `on_input` -> `InputQueue` path
// against a real `fx-terrain` client, the same imperative debug-API pattern `topology.ts`/`gen.ts`
// use (a `Client`'s own shape is not itself serialisable across the CDP boundary `page.evaluate`'s
// return value crosses). `fx-terrain`, not `fx-hash`: this range's own `on_input` is added there
// (Files touched).
import type { CameraViewport } from '../../../../src/camera/transform.ts'
import { type Client, type ClientOptions, createClient } from '../../../../src/client.ts'
import { KeyState } from '../../../../src/input/keys.ts'
import { PointerSlots } from '../../../../src/input/pointers.ts'
import { WheelState } from '../../../../src/input/wheel.ts'
import { callParked, parkWorkers, resumeWorkers, stepFrame } from '../../../../src/test/client.ts'
import {
  attachCameraInputTestHooks,
  injectPointer,
  type PointerPhase,
} from '../../../../src/test/input.ts'
import { fixtureWasm } from './fixture-wasm.ts'

const wasm = await fixtureWasm('terrain')

type InputStats = { queueLen: number; tileX: number; tileY: number }

declare global {
  interface Window {
    __semCreateClient?: () => void
    __semReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __semSetup?: (viewport: CameraViewport) => void
    __semInjectPointer?: (
      phase: PointerPhase,
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
      pointerType?: 'mouse' | 'touch' | 'pen',
    ) => void
    /** Runs one `client.input.recognize()` pass only -- no worker wake (Deviations: separate from
     * `__semStepFrame` so a test can accumulate several recognized events in `inputRing` before
     * draining them all in one wake, instead of each `stepFrame`'s own `frame()` call clearing the
     * previous wake's already-decoded `InputQueue` before this wake's own drain runs). */
    __semRecognize?: (dtMs: number) => void
    __semStepFrame?: (dtMs: number) => void
    __semReadInputStats?: () => Promise<InputStats>
    __pageReady?: true
  }
}

let client: Client | undefined
let bundle: { pointers: PointerSlots; keys: KeyState; wheel: WheelState } | undefined
let viewport: CameraViewport | undefined

function requireClient(): Client {
  if (!client) throw new Error('semantic.ts: call __semCreateClient first')
  return client
}

window.__semCreateClient = () => {
  const canvas = document.createElement('canvas')
  const options: ClientOptions = {
    canvas,
    wasm,
    host: { kind: 'remote', url: 'ws://unused.invalid' },
    genWorkers: 1,
    // `flags: {}` (truthy): enables the `test-call` channel (`worker/test-call.ts`) `callParked`
    // needs (same reasoning `terrain-client.ts`/`gen.ts` already give their own clients).
    test: { flags: {} },
  }
  client = createClient(options)
  client.ready.catch(() => {})
}

window.__semReady = async () => {
  try {
    await requireClient().ready
    return { ok: true }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, code: err.code ?? '', message: err.message ?? String(e) }
  }
}

window.__semSetup = (vp) => {
  const c = requireClient()
  bundle = { pointers: new PointerSlots(), keys: new KeyState(), wheel: new WheelState() }
  viewport = vp
  attachCameraInputTestHooks(c, bundle)
}

window.__semInjectPointer = (phase, id, cssX, cssY, tMs, pointerType) => {
  injectPointer(requireClient(), phase, id, cssX, cssY, tMs, pointerType)
}

window.__semRecognize = (dtMs) => {
  const c = requireClient()
  if (!bundle || !viewport) throw new Error('semantic.ts: call __semSetup first')
  c.input.recognize(bundle, c.cameraState, viewport, dtMs)
}

window.__semStepFrame = (dtMs) => {
  stepFrame(requireClient(), dtMs)
}

window.__semReadInputStats = async () => {
  const c = requireClient()
  await parkWorkers(c)
  const { result } = await callParked(c, 'client', 'on_input', [0], 12)
  await resumeWorkers(c)
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  return {
    queueLen: view.getUint32(0, true),
    tileX: view.getInt32(4, true),
    tileY: view.getInt32(8, true),
  }
}

window.__pageReady = true
