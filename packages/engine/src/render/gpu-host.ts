// `GpuHost` (M37b Scope; docs/decisions/0018-renderer.md §8): owns the
// current `GpuResources`, watches its device's `lost` promise and, on a loss, drops it and builds
// another. The loss sequence: `device.lost` -> request adapter -> device -> `GpuResources` again
// (art re-fetched, visual table rewritten from `tiles.json`) -> subscribers told (the frame loop
// reconfigures the canvas and re-points the upload drain) -> `FLAG_RENDERER_RESET` set on the
// control block, which the client worker answers with `upload_requeue_all` at its next wake.
//
// While `current` is `null` nothing here blocks: the frame loop keeps integrating the camera and
// skips upload/encode/submit (`frame-loop.ts`).
import type { Client } from '../client.js'
import { type Clock, systemClock } from '../clock.js'
import { FLAG_RENDERER_RESET } from '../sab/control.js'
import { NoAdapterError } from './device.js'
import { createGpuResources, type GpuResources, type GpuResourcesOptions } from './gpu-resources.js'

export type GpuHostOptions = GpuResourcesOptions & {
  /** Gets `FLAG_RENDERER_RESET` after each successful rebuild. Normally the same client as
   * `GpuResourcesOptions.client`. */
  client: Client
  /** The injected clock the repeated-loss window reads (0018 §8). Default `systemClock`. */
  clock?: Clock
}

export interface GpuHost {
  /** The live resources, or `null` while the device is lost and the rebuild has not finished (or
   * after the renderer was given up on). A plain read, no allocation. */
  readonly current: GpuResources | null
  /** Number of successful rebuilds so far (0 until the first loss recovers). */
  readonly generation: number
  /** Calls `cb` with the new resources after each rebuild and with `null` when a loss is observed;
   * returns the unsubscribe. Subscribers run in registration order. */
  onChange(cb: (resources: GpuResources | null) => void): () => void
  /** Resolves once no rebuild is in flight: with `current` (possibly still `null` if the rebuild
   * failed). Immediately when healthy. */
  settled(): Promise<GpuResources | null>
  dispose(): void
}

/** 0018 §8: a second loss within this many ms of the previous one gives up (`rendererLost`). */
export const REPEATED_LOSS_WINDOW_MS = 10_000

export async function createGpuHost(opts: GpuHostOptions): Promise<GpuHost> {
  const listeners: Array<(resources: GpuResources | null) => void> = []
  let current: GpuResources | null = await createGpuResources(opts)
  let generation = 0
  let rebuilding: Promise<void> | null = null
  let disposed = false
  let lastDrawablesEnabled: boolean | null = null
  const clock = opts.clock ?? systemClock
  let lastLossAt: number | null = null
  /** Set once `rendererLost` was raised: no further attempt, ever (0018 §8). */
  let gaveUp = false

  function notify(resources: GpuResources | null): void {
    for (const cb of listeners.slice()) cb(resources)
  }

  function watch(resources: GpuResources): void {
    void resources.device.device.lost.then(() => {
      if (disposed || current !== resources) return
      onLost()
    })
  }

  function giveUp(reason: 'no-adapter' | 'repeated-loss'): void {
    gaveUp = true
    opts.client.raiseRendererLost(reason)
  }

  function onLost(): void {
    if (gaveUp) return
    lastDrawablesEnabled = current?.drawables?.isEnabled() ?? null
    current = null
    notify(null)
    const now = clock.now()
    const repeated = lastLossAt !== null && now - lastLossAt < REPEATED_LOSS_WINDOW_MS
    lastLossAt = now
    if (repeated) {
      giveUp('repeated-loss')
      return
    }
    rebuilding = rebuild().finally(() => {
      rebuilding = null
    })
  }

  async function rebuild(): Promise<void> {
    let next: GpuResources
    try {
      next = await createGpuResources(opts)
    } catch (e) {
      // No adapter (or no `navigator.gpu`): the game is told and the renderer stays down (0018 §8).
      // Any other failure is loud and treated the same way: there is nothing else to retry with.
      if (!(e instanceof NoAdapterError))
        console.error('GPU device lost and could not be rebuilt:', e)
      if (!disposed) giveUp('no-adapter')
      return
    }
    if (disposed) {
      next.device.device.destroy()
      return
    }
    // The drawables pass's on/off switch is page state, not GPU state: carry it over.
    if (lastDrawablesEnabled !== null) next.drawables?.setEnabled(lastDrawablesEnabled)
    current = next
    generation += 1
    watch(next)
    notify(next)
    opts.client.setFlags(FLAG_RENDERER_RESET)
  }

  watch(current)

  return {
    get current() {
      return current
    },
    get generation() {
      return generation
    },
    onChange(cb) {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    async settled() {
      while (rebuilding) await rebuilding
      return current
    },
    dispose() {
      disposed = true
    },
  }
}
