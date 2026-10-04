// `window.__check` of the reference game's check build (docs/plan/39f-device-auto-runner.md "The check
// reporter contract", steps 11-12). **Bench builds only** (`vite build --mode bench`, `__BENCH__`): `main.ts`
// reaches this file through `if (__BENCH__)`, so the release build has neither this code nor `__check`
// (`check-reporter-absent`), and `reference_bench_feature_identical` shows the bench cargo feature leaves a
// normal world bit-identical, which is why the one bench build can also be the check build.
//
// What `pnpm device:walk` reads here and the release build has no hook for: the bench HUD as numbers
// (`?bench=large-save`, M39-large-save and M39-frame-shares), the link, the roster, the remote circles and
// furnaces of the newest DrawList (M34), the own collect bar timed from tap to result (M34-own-timer-bar),
// and a per-frame record of the remote circles (M34-remote-motion). Diagnostic, like the bench HUD: it
// allocates, it is outside the zero-GC rule (`.claude/rules/hot-paths.md`), and the per-frame recorder runs
// only between `act.sample(true)` and `act.sample(false)`.
import type { Client, LinkState } from 'engine'
import { type DrawRecord, drawListRecords } from 'engine/test'
import type { BenchApi } from './bench.js'
import type { RefAction } from './bindings/RefAction.js'
import type { RefUi } from './bindings/RefUi.js'
import type { StartedGame } from './game.js'

export type CheckReading = number | string | boolean | null | string[]

/** `engine::client::{KIND_SPRITE, KIND_CIRCLE, KIND_RING}` (0018 section 2). */
const KIND_SPRITE = 0
const KIND_CIRCLE = 1
const KIND_RING = 2
/** `Ui.inventory` slots (`content::ItemId`): the same as `tests/helpers/script.ts`. */
const SLOT = { stone: 0, iron: 1, wood: 2, coal: 3, furnace: 4, ingot: 5 } as const

type Circle = { x: number; y: number; alpha: number }
type Frame = { t: number; circles: Circle[] }
export type Timed = {
  ok: boolean
  reason?: string
  durationMs?: number
  tapAt?: number
  fullAt?: number | null
  resultAt?: number | null
  /** `resultAt - fullAt`: negative is a result before the bar was full, large is a full bar left waiting. */
  gapMs?: number | null
  /** The bar's own fill (0..1) at the result. */
  fillAtResult?: number | null
}

declare global {
  interface Window {
    __check?: Record<string, unknown>
    __pageReady?: true
  }
}

export function installCheck(game: StartedGame, bench?: BenchApi): void {
  const client: Client = game.client
  let link: LinkState | 'none' = 'none'
  let ui: RefUi | null = null
  let uiSeq = 0
  client.onLink((e) => {
    link = e.state
  })
  client.onUi<RefUi>((u) => {
    ui = u
    uiSeq++
  })
  let frames = 0
  const scratch: DrawRecord[] = []

  /** Circles of the newest DrawList without the own one (the circle just before the range ring), and furnaces. */
  function world(): { remote: Circle[]; furnaces: number; own: Circle | null } {
    drawListRecords(client, scratch)
    const circles: Circle[] = []
    let ringed = false
    let furnaces = 0
    for (const r of scratch) {
      if (r.kind === KIND_CIRCLE)
        circles.push({ x: r.pos[0], y: r.pos[1], alpha: (r.color >>> 24) & 0xff })
      else if (r.kind === KIND_RING) ringed = true
      else if (r.kind === KIND_SPRITE && (r.flags & 4) === 0) furnaces++ // flag 4: a predicted ghost
    }
    const own = ringed ? (circles.pop() ?? null) : null
    return { remote: circles, furnaces, own }
  }

  function roster(): string[] {
    return (ui?.roster ?? []).map(
      (p) => `${p.id}:${p.online ? 'online' : 'offline'}:${p.me ? 'me' : 'other'}`,
    )
  }

  // --- the frame recorder (M34-remote-motion) -----------------------------------------------------
  let sampling = false
  let recorded: Frame[] = []
  const tick = (): void => {
    frames++
    if (sampling) recorded.push({ t: performance.now(), circles: world().remote })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // --- the own collect bar (M34-own-timer-bar) --------------------------------------------------
  /**
   * Taps the Collect button of `tile` (the page's own UI path: `button.click()`), then times the bar:
   * the tap, the moment the CSS fill animation finishes (`animationend`), and the first `Ui` that has the
   * collect over with the item in the inventory. Resolves when the result arrived (or `timeoutMs`).
   */
  async function collectOnce(tile: { x: number; y: number }, timeoutMs = 20_000): Promise<Timed> {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-collect-tile="${tile.x},${tile.y}"]`,
    )
    if (!button) return { ok: false, reason: 'no collect button for that tile (out of range?)' }
    if (button.disabled)
      return { ok: false, reason: 'the button is disabled (a collect is running)' }
    const fill = button.querySelector<HTMLElement>('.collect-fill')
    const before = ui?.inventory[SLOT.stone] ?? 0
    const out: Timed = { ok: false, fullAt: null, resultAt: null, gapMs: null, fillAtResult: null }
    const onEnd = (e: AnimationEvent): void => {
      if (e.animationName === 'collect-fill-anim' && out.fullAt === null)
        out.fullAt = performance.now()
    }
    fill?.addEventListener('animationend', onEnd)
    out.tapAt = performance.now()
    button.click()
    const t0 = out.tapAt
    try {
      while (performance.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 8))
        if (out.durationMs === undefined) {
          const ms = Number.parseFloat(button.style.getPropertyValue('--collect-duration'))
          if (Number.isFinite(ms) && button.classList.contains('is-filling')) out.durationMs = ms
        }
        const u = ui
        const landed =
          u !== null && u.collecting === null && (u.inventory[SLOT.stone] ?? 0) > before
        if (landed && out.resultAt === null) {
          out.resultAt = performance.now()
          out.fillAtResult = fillOf(fill)
          // Give the animation's own end a moment to arrive if the result beat it.
          if (out.fullAt === null) await new Promise((r) => setTimeout(r, 400))
          break
        }
      }
    } finally {
      fill?.removeEventListener('animationend', onEnd)
    }
    if (out.resultAt === null) return { ...out, reason: 'no result in time' }
    out.ok = true
    const full = out.fullAt ?? null
    out.gapMs = full === null ? null : (out.resultAt ?? 0) - full
    return out
  }
  const fillOf = (el: HTMLElement | null | undefined): number | null => {
    if (!el) return null
    const m = /matrix\(([^,]+)/.exec(getComputedStyle(el).transform)
    return m ? Number(m[1]) : 0
  }

  const reading = (): Record<string, CheckReading> => {
    const w = world()
    const u = ui
    const r: Record<string, CheckReading> = {
      link,
      frames,
      ui_seen: u !== null,
      ui_seq: uiSeq,
      roster_n: u?.roster.length ?? 0,
      roster_offline_n: u?.roster.filter((p) => !p.online).length ?? 0,
      roster: roster(),
      remote_circles: w.remote.length,
      remote_alpha_min: w.remote.length ? Math.min(...w.remote.map((c) => c.alpha)) : null,
      furnaces: w.furnaces,
      inv_stone: u?.inventory[SLOT.stone] ?? 0,
      inv_furnace: u?.inventory[SLOT.furnace] ?? 0,
      collecting: u ? u.collecting !== null : false,
      in_range_n: u?.in_range.length ?? 0,
      spawn_x: u?.spawn.x ?? null,
      spawn_y: u?.spawn.y ?? null,
      centre_x: +client.cameraState.centreX.toFixed(3),
      centre_y: +client.cameraState.centreY.toFixed(3),
      tiles_across: +client.cameraState.tilesAcross.toFixed(2),
    }
    if (bench) {
      const h = bench.hud()
      Object.assign(r, {
        engine_mem_grows_sim: h.engineMemGrows.sim,
        engine_mem_grows_client: h.engineMemGrows.client,
        tick: h.tick,
        tick_p95_ms: +h.tickP95Ms.toFixed(3),
        main_p95_ms: +h.mainP95Ms.toFixed(3),
        frame_p95_ms: +h.frameP95Ms.toFixed(3),
        bench_frames: h.framesRendered,
        records: h.records,
        dropped: h.dropped,
        draw_calls_max: h.drawCallsMax,
        upload_bytes_max: h.uploadBytesMax,
        upload_drops: h.uploadDrops,
      })
    }
    return r
  }

  window.__check = {
    get ready() {
      return window.__pageReady === true
    },
    page: bench ? 'bench' : 'reference',
    readings: reading,
    errors: () =>
      [...document.querySelectorAll('.engine-fatal-message, .start-failure-text')].map(
        (e) => e.textContent ?? '',
      ),
    act: {
      /** The camera (and so the own player, which follows it) to a tile centre. */
      moveTo: async (a?: unknown) => {
        const { x, y, tiles } = a as { x: number; y: number; tiles?: number }
        client.camera.moveTo(x + 0.5, y + 0.5, { durationMs: 0, ...(tiles ? { tiles } : {}) })
      },
      /** A raw action, as the page's own UI would send it (a bot's `PlaceFurnace`). */
      dispatch: async (a?: unknown) => client.dispatch(a as RefAction),
      collectOnce: async (a?: unknown) => collectOnce(a as { x: number; y: number }),
      /** Start (true) or stop (false) the per-frame record of the remote circles; stop returns it. */
      sample: async (a?: unknown) => {
        if (a) {
          recorded = []
          sampling = true
          return null
        }
        sampling = false
        const out = recorded
        recorded = []
        return out
      },
      /** Craft recipe `n` by the page's own button. */
      craft: async (a?: unknown) => {
        document.querySelector<HTMLButtonElement>(`[data-craft-recipe="${String(a)}"]`)?.click()
      },
    },
  }
}
