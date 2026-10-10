// `HostServices` for a wall-clock-paced server process (0009), shared by `nodeHostServices`,
// `bunHostServices` and `denoHostServices` (M35b step 1): every
// runtime has `setTimeout`, so the three adapters differ by name only. Not an `exports` subpath.
import { systemClock, systemScheduler } from './clock.js'
import type { HostServices } from './server.js'
import type { Storage } from './storage/types.js'

/** `HostServices.timer.every` (0009) over `systemScheduler.setTimer`/`clearTimer` only -- never
 * `requestFrame`/`cancelFrame` (`systemScheduler`'s own other half, backed by `requestAnimationFrame`,
 * which does not exist under Node): a repeating `setTimeout` chain, stopped by calling the returned
 * function. */
function everyViaSetTimer(ms: number, fn: () => void): () => void {
  let stopped = false
  let id: number
  function tick(): void {
    if (stopped) return
    fn()
    id = systemScheduler.setTimer(tick, ms)
  }
  id = systemScheduler.setTimer(tick, ms)
  return () => {
    stopped = true
    systemScheduler.clearTimer(id)
  }
}

/**
 * `hostServices({ wasm, storage, onIdle?, onFatal? })` (docs/plan/
 * 27-server-entrypoint-and-netcode-harness.md, Scope): `createWorldServer`'s `HostServices`
 * (0009), `clock`/`timer` supplied from `systemClock`/`systemScheduler` (M03) -- the real, wall-
 * clock-paced counterpart `engine/test`'s `VirtualClock`-backed harness never uses. The `ws`
 * attachment (a real socket `Connection` adapter) is M29; this only builds the object
 * `createWorldServer` itself takes.
 */
export function hostServices(opts: {
  wasm: WebAssembly.Module
  storage: Storage
  onIdle?: () => void
  onFatal?: (f: { tick: number; message: string }) => void
}): HostServices {
  return {
    wasm: opts.wasm,
    storage: opts.storage,
    clock: systemClock,
    timer: { every: everyViaSetTimer },
    scheduler: systemScheduler,
    ...(opts.onIdle !== undefined ? { onIdle: opts.onIdle } : {}),
    ...(opts.onFatal !== undefined ? { onFatal: opts.onFatal } : {}),
  }
}
