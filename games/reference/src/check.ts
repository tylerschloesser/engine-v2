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
import { type DrawRecord, drawListRecords, drawListSeq } from 'engine/test'
import type { BenchApi } from './bench.js'
import { HIST_EDGES_MS } from './bench-stats.js'
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
type Frame = { t: number; circles: Circle[]; seq: number }
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

/**
 * The link and Ui as the client published them. `Client.onLink` and `onUi` are per-event and never replay, so
 * this subscribes through `watchClient` (called by `startGame`'s `onClient`, synchronously after `createClient`,
 * before its first `await`): on a first load (a cold tunnel, a first GPU init) `online` and the first Ui
 * publish otherwise fire before `installCheck` runs and `link` stays 'none' for good (M39n fix round 2).
 */
type Seen = { link: LinkState | 'none'; ui: RefUi | null; uiSeq: number }
const watched = new WeakMap<Client, Seen>()
export function watchClient(client: Client): void {
  if (watched.has(client)) return
  const seen: Seen = { link: 'none', ui: null, uiSeq: 0 }
  watched.set(client, seen)
  client.onLink((e) => {
    seen.link = e.state
  })
  client.onUi<RefUi>((u) => {
    seen.ui = u
    seen.uiSeq++
  })
}

export function installCheck(game: StartedGame, bench?: BenchApi): void {
  const client: Client = game.client
  watchClient(client) // a no-op when `startGame` already did it at creation
  const seen = watched.get(client) as Seen
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
    return (seen.ui?.roster ?? []).map(
      (p) => `${p.id}:${p.online ? 'online' : 'offline'}:${p.me ? 'me' : 'other'}`,
    )
  }

  // --- the frame recorder (M34-remote-motion) -----------------------------------------------------
  let sampling = false
  let recorded: Frame[] = []
  const tick = (): void => {
    frames++
    if (sampling) {
      const remote = world().remote
      recorded.push({ t: performance.now(), circles: remote, seq: drawListSeq(client) })
    }
    if (watch?.fill?.parentElement?.classList.contains('is-filling'))
      watch.lastFill = fillOf(watch.fill)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // --- the own collect bar (M34-own-timer-bar) --------------------------------------------------
  // The page's own collect UI (`ui/collect.ts`) stops the bar's CSS animation in the same `onUi` that
  // clears `collecting`, so the bar's fill cannot be read after the result: it is tracked every frame while
  // a collect is being watched (`lastFill`, at most one frame old) and read as of the result.
  type Watch = {
    fill: HTMLElement | null
    before: number
    lastFill: number | null
    resultAt: number | null
    fillAtResult: number | null
  }
  let watch: Watch | null = null
  const fillOf = (el: HTMLElement): number => {
    const m = /matrix\(([^,]+)/.exec(getComputedStyle(el).transform)
    return m ? Number(m[1]) : 0
  }
  client.onUi<RefUi>((u) => {
    const w = watch
    if (
      w &&
      w.resultAt === null &&
      u.collecting === null &&
      (u.inventory[SLOT.stone] ?? 0) > w.before
    ) {
      w.resultAt = performance.now()
      w.fillAtResult = w.lastFill
    }
  })

  /**
   * Taps the Collect button of `tile` (the page's own UI path: `button.click()`), then times the bar: the
   * tap, the moment the CSS fill animation finishes (`animationend`; none when the host's result arrives
   * first and the bar is cancelled part-way), and the first `Ui` that has the collect over with the item in
   * the inventory. `gapMs` is the result against the full bar: positive, a full bar left waiting; negative,
   * the result before the bar was full (read from the fill at the last frame when the bar never finished).
   */
  async function collectOnce(tile: { x: number; y: number }, timeoutMs = 20_000): Promise<Timed> {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-collect-tile="${tile.x},${tile.y}"]`,
    )
    if (!button) return { ok: false, reason: 'no collect button for that tile (out of range?)' }
    if (button.disabled)
      return { ok: false, reason: 'the button is disabled (a collect is running)' }
    const fill = button.querySelector<HTMLElement>('.collect-fill')
    const w: Watch = {
      fill,
      before: seen.ui?.inventory[SLOT.stone] ?? 0,
      lastFill: null,
      resultAt: null,
      fillAtResult: null,
    }
    const out: Timed = { ok: false, fullAt: null, resultAt: null, gapMs: null, fillAtResult: null }
    const onEnd = (e: AnimationEvent): void => {
      if (e.animationName === 'collect-fill-anim' && out.fullAt === null)
        out.fullAt = performance.now()
    }
    fill?.addEventListener('animationend', onEnd)
    watch = w
    out.tapAt = performance.now()
    button.click()
    try {
      while (performance.now() - out.tapAt < timeoutMs && w.resultAt === null) {
        await new Promise((r) => setTimeout(r, 8))
        if (out.durationMs === undefined && button.classList.contains('is-filling')) {
          const ms = Number.parseFloat(button.style.getPropertyValue('--collect-duration'))
          if (Number.isFinite(ms)) out.durationMs = ms
        }
      }
    } finally {
      fill?.removeEventListener('animationend', onEnd)
      watch = null
    }
    if (w.resultAt === null) return { ...out, reason: 'no result in time' }
    out.ok = true
    out.resultAt = w.resultAt
    out.fillAtResult = w.fillAtResult
    const full = out.fullAt ?? null
    out.gapMs =
      full !== null ? w.resultAt - full : -((1 - (w.fillAtResult ?? 1)) * (out.durationMs ?? 0))
    return out
  }

  const reading = (): Record<string, CheckReading> => {
    const w = world()
    const u = seen.ui
    const r: Record<string, CheckReading> = {
      link: seen.link,
      frames,
      ui_seen: u !== null,
      ui_seq: seen.uiSeq,
      roster_n: u?.roster.length ?? 0,
      roster_offline_n: u?.roster.filter((p) => !p.online).length ?? 0,
      roster: roster(),
      remote_circles: w.remote.length,
      // Where each remote circle is drawn, and the own one (null when the DrawList has no range ring, so the
      // own circle cannot be told from a remote one): what a partner counts as "the other player" (M39n).
      remote_xy: w.remote.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`),
      own_xy: w.own ? `${w.own.x.toFixed(2)},${w.own.y.toFixed(2)}` : null,
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
        tick_p50_ms: +h.tickP50Ms.toFixed(3),
        seal_p95_ms: +h.sealP95Ms.toFixed(3),
        sim_tick_p50_ms: +h.simTickP50Ms.toFixed(3),
        sim_tick_p95_ms: +h.simTickP95Ms.toFixed(3),
        frame_build_p95_ms: +h.frameBuildP95Ms.toFixed(3),
        resync_p95_ms: +h.resyncP95Ms.toFixed(3),
        catchup_ticks_per_10s: h.catchupTicksPer10s,
        // docs/plan/39s: the per-tick series of the last 4,096 sim_tick durations, summarised
        // (the whole ring is `tickSeries()`).
        tick_hist_edges_ms: HIST_EDGES_MS,
        tick_hist: h.tickSeries.counts,
        tick_top: h.tickSeries.top.map((t) => [t.tick, +t.ms.toFixed(3)]),
        tick_period: h.tickSeries.period,
        tick_period_r: +h.tickSeries.periodR.toFixed(3),
        tick_series_n: h.tickSeries.n,
        tick_missed: h.tickSeries.missed,
        // docs/plan/39y: `[p50, p95]` ms by `sim_tick` phase (sampled ones scaled; zeros off a bench-phases build).
        sim_phases_ms: h.phases,
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
    tickSeries: () => bench?.tickSeries() ?? [],
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
