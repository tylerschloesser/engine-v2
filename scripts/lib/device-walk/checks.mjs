// The machine-readable criteria of every walked device check (M39f step 4; docs/plan/39f-device-
// auto-runner.md "The classification"). One entry per non-Android, non-meta id of device-checks.md, which
// stays the owner of the *meaning*: an entry quotes a number, it does not own one.
//
//   class    auto | auto+confirm | human | retired      (retired: no longer walked, Tyler 2026-10-03)
//   signal   where the verdict's numbers come from
//   plan     how the phone collects it: { page, variant, collector, ... built, delegation }. `built: false`
//            is a row whose adapter a later delegation writes; the round marks it `skip` with that note.
//   criteria [{ name, source, reduce?, op, limit, ref, group?, judge?, nullIs? }]   the service decides, never
//            the page. `nullIs: 'judge'`: a value the data cannot give (an item not in this round, two worlds
//            at different ticks) is a judge prompt, not a failure.
//   metrics  [{ name, source, reduce? }]        recorded in `result.metrics`, never gating
//   acts     what the person is asked to do (a prompt with a live "detected" tick)
//   judges   what only the person can judge (a judge prompt)
//   pass     8 hex digits of the item's own *Pass* text: editing the line without editing the entry fails
//            the drift test (`device-walk checks`)
//
// `ref` says where a limit comes from: `pass` (the number is written in the item's Pass text; the test
// finds it there), `budgets.json <key>`, `PRE-PLAN §7 <row>`, or an ADR section. `source` is a path into
// the collected data (`*` fans out over an array); `reduce` folds the fan-out (max, min, sum, all, ...).
import { createHash } from 'node:crypto'
import landmarks from '../../../games/reference/tests/fixtures/landmarks.json' with { type: 'json' }

export const SECOND = 1000

/** 8 hex digits of the whitespace-normalised Pass text. */
export function passHash(text) {
  return createHash('sha1')
    .update(String(text).replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 8)
}

// --- the shared criteria of the fill-rate family (M09b-fill-rate, M18-fill-rate-with-anchors) ----------
const fillRate = (extra = []) => [
  {
    name: 'windows_measured',
    source: 'windows.*.orientation',
    reduce: 'distinct',
    op: '>=',
    limit: 2,
    ref: 'Steps: portrait 60 s, then landscape 60 s (a completeness check, not a Pass number)',
  },
  {
    name: 'isolated',
    source: 'steady.*.isolated',
    reduce: 'all',
    op: '==',
    limit: true,
    ref: 'pass',
  },
  {
    name: 'adapter',
    source: 'steady.*.adapter',
    reduce: 'all',
    op: 'truthy',
    limit: true,
    ref: 'pass',
  },
  {
    name: 'raf_p95_ms',
    source: 'steady.*.raf_p95_ms',
    reduce: 'max',
    op: '<=',
    limit: 17.5,
    ref: 'pass',
  },
  {
    name: 'raf_over20_per_10s',
    source: 'steady.*.raf_over20',
    reduce: 'max',
    op: '<=',
    limit: 5,
    ref: 'pass',
  },
  {
    name: 'gpu_p95_ms',
    source: 'steady.*.gpu_p95_ms',
    reduce: 'max',
    op: '<=',
    limit: 6,
    ref: 'pass',
  },
  {
    name: 'hitch_gaps_over_25ms',
    source: 'windows.*.raf.long25',
    reduce: 'sum',
    op: 'proxy',
    limit: 0,
    ref: 'hitch proxy (39f Planning decisions): a count above 25 ms; any gap is a judge prompt',
    judge: 'borderline',
  },
  ...extra,
]
const fillMetrics = [
  { name: 'raf_gap_max_ms', source: 'windows.*.raf.max', reduce: 'max' },
  { name: 'frames', source: 'windows.*.raf.frames', reduce: 'sum' },
  { name: 'raf_p50_ms', source: 'steady.*.raf_p50_ms', reduce: 'median' },
]
// *If it fails* of M09b-fill-rate, in the order 0018 Consequences states: 1.5, then 1, then add cutoff 4
const FILL_LADDER = ['&scaleCap=1.5', '&scaleCap=1', '&scaleCap=1&cutoff=4']

/** A built entry of delegation 3 (the lifecycle and choreography checks of the fixture pages). */
/**
 * M17b (`human`, assisted): the harness page's own probe lines and errors are collected, the allocation
 * timeline and the GC markers are the person's (Web Inspector or the Firefox Profiler: nothing a page can
 * read). `criteria` stays empty for a `human` row; `assist.criteria` are what the page can say.
 */
const HARNESS_ASSIST = {
  criteria: [
    { name: 'gpu_errors', source: 'harness.errors', op: '==', limit: 0, ref: 'pass' },
    {
      name: 'allocation_and_gc_markers',
      source: 'harness.memoryTotal',
      op: '>=',
      limit: null,
      ref: "none: allocations and GC markers are read off the browser's own tool: the person types the two numbers",
      judge: 'always',
    },
  ],
  metrics: [
    { name: 'view_probe_passes', source: 'harness.viewProbe' },
    { name: 'sab_write_texture_ok', source: 'harness.sabWriteTexture' },
    { name: 'memory_total_bytes', source: 'harness.memoryTotal' },
  ],
}
const HARNESS_JUDGE =
  'from the Timelines panel (Safari) or the Profiler (Firefox) over the 600 frames: allocation growth in KB (at most about 70) and the GC pause markers (0); type both in the note'

const lifecycle = (page, extra = {}) => ({
  page,
  variant: 'fixture',
  built: true,
  delegation: 3,
  ...extra,
})

/** M29's six drops, three runs each (`device-checks.md`): what the person is told, and the absence the
 * service holds them to (+-30%: a run outside it is repeated). `ms: null`: no stated length. */
export const MP_SCENARIOS = [
  {
    key: 'app-5s',
    kind: 'hide',
    ms: 5 * SECOND,
    text: 'Switch to another app for {s} seconds, then come back to this page.',
  },
  {
    key: 'app-30s',
    kind: 'hide',
    ms: 30 * SECOND,
    text: 'Switch to another app for {s} seconds, then come back to this page.',
  },
  {
    key: 'app-5min',
    kind: 'hide',
    ms: 300 * SECOND,
    text: 'Switch to another app for {s} seconds, then come back to this page.',
  },
  {
    key: 'lock-60s',
    kind: 'hide',
    ms: 60 * SECOND,
    text: 'Lock the screen for {s} seconds, then unlock the phone and come back to this page.',
  },
  {
    key: 'wifi-cellular',
    kind: 'net',
    ms: null,
    text: 'Turn Wi-Fi off so the phone moves to cellular, keep this page in front, and wait until the link is back.',
  },
  {
    key: 'airplane-15s',
    kind: 'net',
    ms: 15 * SECOND,
    text: 'Turn airplane mode on for {s} seconds, then off, with this page in front.',
  },
]

const later = (delegation, page, extra = {}) => ({
  page,
  variant: 'fixture',
  collector: null,
  built: false,
  delegation,
  ...extra,
})

/** A built entry of delegation 4 (the reference game: the release build, or the bench build that is also its
 * check build, M39f step 11). `variant` is `reference` (release, no hooks, no server), `reference-bench`
 * (`vite build --mode bench` plus `--ws`: `window.__check`, `?bench=large-save`, the real-time server built
 * with the same cargo feature) or `fly` (not ours to inject into). */
const reference = (page, extra = {}) => ({
  page,
  variant: 'reference',
  built: true,
  delegation: 4,
  ...extra,
})

/**
 * M34 on the reference game's check build joined to the real-time server (`#k=`, an open server): the phone
 * is player 1, a Playwright Chromium on the Mac (`bot.mjs`) is player 2. `tiles`: the stone landmark of
 * `games/reference/tests/fixtures/landmarks.json` (checked against worldgen by `landmarks_fixture_current`)
 * and the free 2x2 of land `tests/helpers/script.ts` calls FURNACE_A (a unit test pins both).
 */
export const MP_TILES = { stone: landmarks.resources.stone, furnace: { x: -4, y: 1 } }
const mp = (extra) =>
  reference('#k=', {
    variant: 'reference-bench',
    collector: 'reference-mp',
    tiles: MP_TILES,
    ...extra,
  })

/** M35's criteria, the same for both builds of the row (Mac and iPhone): the DOM and the wrapped device. */
const m35Criteria = () => [
  {
    name: 'capability_screen',
    source: 'dom.capability',
    op: '==',
    limit: false,
    ref: 'pass',
  },
  { name: 'fatal_screen', source: 'dom.fatal', op: '==', limit: false, ref: 'pass' },
  { name: 'canvas_present', source: 'dom.canvas', op: '==', limit: true, ref: 'pass' },
  {
    name: 'delivery_line_absent',
    source: 'dom.delivery_line',
    op: '==',
    limit: false,
    ref: 'pass',
  },
  {
    name: 'gpu_errors',
    source: 'gpu.errors',
    op: '==',
    limit: 0,
    ref: 'none: a validation error or a lost device while the game boots means it did not play; the Pass text names no count',
  },
  {
    name: 'device_lost',
    source: 'gpu.lost',
    op: '==',
    limit: 0,
    ref: 'none: as gpu_errors',
  },
  {
    name: 'reloads',
    source: 'reloads',
    op: '==',
    limit: 0,
    ref: 'none: a reload is not a played game',
  },
  {
    name: 'world_drawn',
    source: 'dom.canvas_w',
    op: '>=',
    limit: null,
    ref: 'none: "the game plays" is the person\'s: one confirm tap (a release build has no hook that says what the canvas shows)',
    judge: 'always',
  },
]
const m35Metrics = [
  { name: 'canvas_w', source: 'dom.canvas_w' },
  { name: 'canvas_h', source: 'dom.canvas_h' },
  { name: 'raf_p50_ms', source: 'raf.p50' },
  { name: 'raf_p95_ms', source: 'raf.p95' },
  { name: 'raf_gap_max_ms', source: 'raf.max' },
  { name: 'raf_gaps_over_25ms', source: 'raf.long25' },
]

/** @type {Record<string, object>} */
export const CHECKS = {
  'M03-determinism': {
    pass: '5764dd23',
    class: 'auto',
    signal: 'window.__determinism (fixtures[*].pass, crossOriginIsolated) and the #result banner',
    plan: {
      page: 'determinism.html',
      variant: 'fixture',
      collector: 'global',
      globals: ['__determinism'],
      dom: { banner: '#result' },
      built: true,
      delegation: 2,
    },
    criteria: [
      {
        name: 'banner',
        source: 'dom.banner',
        reduce: 'first-line',
        op: '==',
        limit: 'PASS',
        ref: 'pass',
      },
      {
        name: 'checkpoint_mismatches',
        source: 'g.__determinism.fixtures.*.pass',
        reduce: 'count-false',
        op: '==',
        limit: 0,
        ref: 'pass',
      },
      {
        name: 'cross_origin_isolated',
        source: 'g.__determinism.crossOriginIsolated',
        op: '==',
        limit: true,
        ref: 'pass',
      },
    ],
    metrics: [{ name: 'fixtures', source: 'g.__determinism.fixtures.*.pass', reduce: 'len' }],
    acts: [],
    judges: [],
  },
  'M08-worldgen-ms-per-chunk': {
    pass: 'f2f4cbda',
    class: 'auto',
    signal: 'window.__worldgenBench (medianMs, pass, hardwareConcurrency)',
    plan: {
      page: 'worldgen-bench.html',
      variant: 'fixture',
      collector: 'global',
      globals: ['__worldgenBench'],
      built: true,
      delegation: 2,
    },
    criteria: [
      {
        name: 'golden_match',
        source: 'g.__worldgenBench.pass',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      {
        name: 'median_ms_per_chunk',
        source: 'g.__worldgenBench.medianMs',
        op: '<=',
        limit: 1,
        ref: '0008 §6',
      },
    ],
    metrics: [
      { name: 'median_ms', source: 'g.__worldgenBench.medianMs' },
      { name: 'cores', source: 'g.__worldgenBench.hardwareConcurrency' },
    ],
    acts: [],
    judges: [],
  },
  'M08-warn-threshold': {
    pass: '4d243664',
    class: 'auto',
    signal:
      'phone median from window.__worldgenBench; desktop median from the same page in headless Chromium on the Mac',
    plan: {
      page: 'worldgen-bench.html',
      variant: 'fixture',
      collector: 'global',
      globals: ['__worldgenBench'],
      derive: 'worldgen-F',
      needs: 'desktopMedianMs',
      built: true,
      delegation: 2,
    },
    criteria: [
      {
        name: 'phone_median_ms',
        source: 'g.__worldgenBench.medianMs',
        op: '<=',
        limit: 0.5,
        ref: 'pass',
        group: 'either',
      },
      { name: 'F', source: 'derived.F', op: '<=', limit: 5, ref: 'pass', group: 'either' },
    ],
    metrics: [
      { name: 'phone_median_ms', source: 'g.__worldgenBench.medianMs' },
      { name: 'desktop_median_ms', source: 'derived.desktopMedianMs' },
      { name: 'F', source: 'derived.F' },
      { name: 'warn_if_failing_ms', source: 'derived.warnMs' },
    ],
    acts: [],
    judges: [],
  },
  'M09b-fill-rate': {
    pass: '8e59fb30',
    class: 'auto',
    signal:
      'device.html __check.readings() (the HUD numbers as numbers), one 60 s window per orientation',
    plan: {
      page: 'device.html?autopan=1&tiles=256&scale=2',
      variant: 'fixture',
      collector: 'fill-rate',
      windowMs: 60 * SECOND,
      warmupMs: 10 * SECOND,
      ladder: FILL_LADDER,
      built: true,
      delegation: 2,
    },
    criteria: fillRate(),
    metrics: fillMetrics,
    acts: ['rotate the phone once between the two windows'],
    judges: ['no visible hitch (asked only when the rAF-gap proxy is not clean)'],
  },
  'M11-boot': {
    pass: 'ec578891',
    class: 'auto',
    signal: 'device.html __check.readings() (workers_ready, delivery, isolated, adapter)',
    plan: {
      page: 'device.html',
      variant: 'fixture',
      collector: 'check',
      ladder: ['?module=url'],
      built: true,
      delegation: 2,
    },
    criteria: [
      { name: 'isolated', source: 'final.isolated', op: '==', limit: true, ref: 'pass' },
      { name: 'adapter', source: 'final.adapter', op: 'truthy', limit: true, ref: 'pass' },
      { name: 'workers_ready', source: 'final.workers_ready', op: '==', limit: true, ref: 'pass' },
      { name: 'delivery', source: 'final.delivery', op: '==', limit: 'posted Module', ref: 'pass' },
    ],
    metrics: [
      { name: 'adapter', source: 'final.adapter' },
      { name: 'delivery', source: 'final.delivery' },
    ],
    acts: [],
    judges: [],
  },
  'M11-gestures': {
    pass: '027f879c',
    class: 'auto+confirm',
    signal:
      'agent pointer log (scroll, visualViewport, gesture events, flick speed and glide, pull-down, double tap); __check camera (tiles across range, the tapped tile against the tile under the finger, centre across the rotation); reload nonce',
    plan: lifecycle('device.html', { collector: 'gestures', reloadIsFail: true }),
    criteria: [
      {
        name: 'gestures_done',
        source: 'steps_done',
        op: '>=',
        limit: 7,
        ref: 'Steps: the seven gestures of the item (a completeness check, not a Pass number)',
      },
      {
        name: 'page_scrolled',
        source: 'pointer.pageScrolled',
        op: '==',
        limit: false,
        ref: 'pass',
      },
      { name: 'page_zoomed', source: 'pointer.pageZoomed', op: '==', limit: false, ref: 'pass' },
      { name: 'page_reloaded', source: 'reloads', op: '==', limit: 0, ref: 'pass' },
      {
        name: 'cursor_tile_after_tap',
        source: 'final.cursor_valid',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      {
        name: 'world_point_drift_tiles',
        source: 'pointer.worldPointDriftTiles',
        op: '<=',
        limit: 1,
        ref: '0019 §3: "One-pointer drag pans (the world point under the finger stays under it)"; the Pass text names no tolerance, one tile is the allowance for the frame between an event and the camera (measured at touch-down against the latest finger position, every 40 ms of the pan)',
      },
      {
        name: 'rotation_keeps_centre',
        source: 'rotation.shown',
        op: '==',
        limit: null,
        ref: 'none: the Pass text names no tolerance, so the shift is shown to the judge in tiles and CSS px',
        judge: 'always',
      },
      {
        name: 'flick_glides',
        source: 'camera.judged',
        op: '==',
        limit: null,
        ref: 'none: the Pass text says "stays under the finger" and "glides and stops": the person\'s, with the zoom range and the glide shown',
        judge: 'always',
      },
    ],
    metrics: [
      { name: 'tiles_min', source: 'camera.tilesMin' },
      { name: 'tiles_max', source: 'camera.tilesMax' },
      { name: 'flick_speed_px_ms', source: 'pointer.flickSpeed' },
      { name: 'glide_tiles', source: 'pointer.glide' },
      { name: 'world_point_samples', source: 'pointer.worldPointSamples' },
      { name: 'rotation_shift_px', source: 'rotation.centreShiftPx' },
      { name: 'centre_shift_tiles', source: 'rotation.centreShiftTiles' },
    ],
    acts: [
      'one-finger pan 10 s, flick, pinch in and out, tap a tile, pull down from the top edge, double-tap, rotate',
    ],
    judges: ['the flick glides and stops; the centre kept across the rotation'],
  },
  'M11-memory': {
    pass: '5bcd5bb2',
    class: 'auto',
    signal:
      'device.html?probe=memory __check.readings().steps[]; a reload (boot nonce) is the failure',
    plan: {
      page: 'device.html?probe=memory',
      variant: 'fixture',
      collector: 'memory',
      completeSteps: 'probe=memory: complete',
      reloadIsFail: true,
      ladder: ['&sim=64&client=32'],
      built: true,
      delegation: 2,
    },
    criteria: [
      {
        name: 'step_2_finished',
        source: 'final.steps',
        op: 'has',
        limit: '(2) touch=0: completed without a reload',
        ref: 'pass: "(2) and (3) finish without a reload"; the limit is the probe\'s own line saying so',
      },
      {
        name: 'step_3_finished',
        source: 'final.steps',
        op: 'has',
        limit: '(3) touch=1: completed without a reload',
        ref: 'pass: "(2) and (3) finish without a reload"; the limit is the probe\'s own line saying so',
      },
      { name: 'reloads', source: 'reloads', op: '==', limit: 0, ref: 'pass' },
    ],
    metrics: [
      { name: 'scratch_ceiling_mib', source: 'final.steps', reduce: 'ceiling-mib' },
      { name: 'last_line', source: 'final.steps', reduce: 'last' },
    ],
    acts: [],
    judges: [],
  },
  'M11-pinch-desktop-safari': {
    pass: 'a000bc21',
    class: 'auto+confirm',
    signal:
      'agent on Mac Safari: gesturechange count and scale, visualViewport.scale, __check tilesAcross',
    // A Mac browser's tab (`device: 'mac'`, `browsers`: the service opens it, `mac-browser.mjs`); the
    // collector is `collect-mac.js`: trackpad pinch events and the page's own zoom, never a touch gesture.
    plan: later(5, 'device.html', {
      collector: 'pinch-desktop',
      device: 'mac',
      browsers: ['safari'],
      built: true,
    }),
    criteria: [
      { name: 'page_zoomed', source: 'pointer.pageZoomed', op: '==', limit: false, ref: 'pass' },
      {
        name: 'zoom_changed',
        source: 'camera.tilesAcrossChanged',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      {
        name: 'zoom_follows_cursor',
        source: 'camera.pinchEvents',
        op: '>=',
        limit: null,
        ref: 'none: "about the cursor" is the person\'s; the pinch events seen are shown to the judge',
        judge: 'always',
      },
    ],
    metrics: [],
    acts: ['trackpad pinch in and out over a landmark tile'],
    judges: ['the zoom follows the fingers about the cursor'],
  },
  'M16-slice-boot': {
    pass: 'ece04a7b',
    class: 'auto+confirm',
    signal:
      'slice.html __check.readings() (isolated, adapter, workers, terrain drawn: the __probeTile readback); M03 from this round',
    plan: lifecycle('slice.html', {
      collector: 'slice',
      mode: 'boot',
      inherit: { m03: 'M03-determinism' },
    }),
    criteria: [
      {
        name: 'm03_criterion',
        source: 'm03.pass',
        op: '==',
        limit: true,
        ref: 'pass',
        nullIs: 'judge',
      },
      { name: 'isolated', source: 'final.isolated', op: '==', limit: true, ref: 'pass' },
      { name: 'adapter', source: 'final.adapter', op: 'truthy', limit: true, ref: 'pass' },
      { name: 'workers_ready', source: 'final.workers_ready', op: '==', limit: true, ref: 'pass' },
      { name: 'terrain_drawn', source: 'final.terrain_drawn', op: '==', limit: true, ref: 'pass' },
      {
        name: 'pan_pinch_as_m11',
        source: 'gestures',
        op: '==',
        limit: null,
        ref: 'none: the Pass text says "as M11-gestures": one confirm tap',
        judge: 'always',
      },
    ],
    metrics: [],
    acts: [],
    judges: ['pan and pinch behave as in M11-gestures (inherited when that item is in this round)'],
  },
  'M16-round-trip': {
    pass: 'bcc277ca',
    class: 'auto',
    signal:
      '__check.act.paint x10 (verdict and click-to-verdict time per paint), final confirmed/rejected/ring drops',
    plan: lifecycle('slice.html', { collector: 'slice', mode: 'roundtrip' }),
    criteria: [
      { name: 'confirmed', source: 'final.confirmed', op: '==', limit: 10, ref: 'pass' },
      { name: 'rejected', source: 'final.rejected', op: '==', limit: 0, ref: 'pass' },
      { name: 'ring_drops', source: 'final.ring_drops', op: '==', limit: 0, ref: 'pass' },
    ],
    // "No perceptible delay" names no number in the Pass text, so the latency is recorded, not judged.
    metrics: [
      { name: 'confirm_latency_max_ms', source: 'latency.*', reduce: 'max' },
      { name: 'confirm_latency_median_ms', source: 'latency.*', reduce: 'median' },
    ],
    acts: [],
    judges: [],
  },
  'M16-coexist': {
    pass: 'a8d52217',
    class: 'auto',
    signal:
      '?autopan=1 slice, one scripted Paint a second, __check engine_mem_grows, reload nonce, rAF long-frame counters, 10 min',
    plan: lifecycle('slice.html', {
      query: 'autopan=1',
      collector: 'slice',
      mode: 'coexist',
      windowMs: 600 * SECOND,
      warmupMs: 10 * SECOND,
      reloadIsFail: true,
    }),
    criteria: [
      { name: 'reloads', source: 'reloads', op: '==', limit: 0, ref: 'pass' },
      {
        name: 'engine_mem_grows',
        source: 'steady.*.engine_mem_grows',
        reduce: 'max-known',
        op: '==',
        limit: 0,
        ref: 'pass',
      },
      {
        name: 'hitch_gaps_over_25ms',
        source: 'windows.*.raf.long25',
        reduce: 'sum',
        op: 'proxy',
        limit: 0,
        ref: 'hitch proxy (39f Planning decisions): a count above 25 ms; any gap is a judge prompt',
        judge: 'borderline',
      },
    ],
    metrics: [
      { name: 'raf_gap_max_ms', source: 'windows.*.raf.max', reduce: 'max' },
      { name: 'paints', source: 'paints' },
    ],
    acts: [],
    judges: ['no visible hitch (only when the proxy is not clean)'],
  },
  'M16-background': {
    pass: '10fe26ba',
    class: 'auto',
    signal:
      'visibility events (the page is left twice, on purpose), __check tick at hidden versus at visible, frames resume, no reload (nonce)',
    plan: lifecycle('slice.html', {
      collector: 'slice',
      mode: 'background',
      reloadIsFail: true,
      leaves: [
        {
          text: 'Switch to another app for {s} seconds, then come back to this page.',
          ms: 30 * SECOND,
        },
        {
          text: 'Lock the screen for {s} seconds, then unlock the phone and come back to this page.',
          ms: 60 * SECOND,
        },
      ],
    }),
    criteria: [
      {
        name: 'left_twice',
        source: 'hidden.rounds.*',
        reduce: 'len',
        op: '>=',
        limit: 2,
        ref: 'Steps: another app 30 s, then lock 60 s (a completeness check, not a Pass number)',
      },
      { name: 'reloads', source: 'reloads', op: '==', limit: 0, ref: 'pass' },
      {
        name: 'tick_advanced_while_hidden',
        source: 'hidden.rounds.*.tickDelta',
        reduce: 'max',
        op: '<=',
        limit: 0,
        ref: 'pass',
      },
      {
        name: 'frame_loop_resumed',
        source: 'hidden.rounds.*.rafResumed',
        reduce: 'all',
        op: '==',
        limit: true,
        ref: 'pass',
      },
    ],
    metrics: [
      { name: 'hidden_ms', source: 'hidden.rounds.*.ms', reduce: 'min' },
      { name: 'tick_delta_max', source: 'hidden.rounds.*.tickDelta', reduce: 'max' },
    ],
    acts: ['leave the app for 30 s and return; lock the screen for 60 s and return'],
    judges: [],
  },
  'M16-low-power': {
    pass: '39cfc710',
    class: 'auto',
    signal:
      'Low Power Mode as a ~30 Hz rAF (the agent recorder); one scripted flick (__check.act.flick) at normal cadence, one at the halved one',
    plan: lifecycle('slice.html', { collector: 'slice', mode: 'lowpower' }),
    criteria: [
      {
        name: 'low_power_detected',
        source: 'lowPower.detected',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      {
        name: 'flick_distance_ratio',
        source: 'lowPower.distanceRatio',
        op: '>=',
        limit: null,
        ref: 'none: the Pass text says unchanged, so the ratio is shown to the judge',
        judge: 'always',
      },
    ],
    metrics: [
      { name: 'rafp50_normal_ms', source: 'lowPower.p50Normal' },
      { name: 'rafp50_low_power_ms', source: 'lowPower.p50Low' },
    ],
    acts: ['turn Low Power Mode on'],
    judges: [
      'flick distance at the halved frame rate against the one at 60 Hz (ratio near 1 = unchanged)',
    ],
  },
  'M17b-harness-desktop-safari': {
    pass: '4c162c7f',
    class: 'human',
    signal:
      'window.__deviceHarness probe lines and errors; the allocation timeline is Web Inspector only',
    plan: later(5, 'device.html?harness=1', {
      collector: 'harness',
      device: 'mac',
      browsers: ['safari'],
      built: true,
      assist: true,
    }),
    criteria: [],
    assist: HARNESS_ASSIST,
    metrics: [],
    acts: ['read the allocation growth and GC marker count off the Timelines panel'],
    judges: [HARNESS_JUDGE],
  },
  'M17b-harness-desktop-firefox': {
    pass: '0f644141',
    class: 'human',
    signal: 'as the Safari item; Firefox Profiler',
    plan: later(5, 'device.html?harness=1', {
      collector: 'harness',
      device: 'mac',
      browsers: ['firefox'],
      built: true,
      assist: true,
    }),
    criteria: [],
    assist: HARNESS_ASSIST,
    metrics: [],
    acts: ['read the allocation growth off the Profiler'],
    judges: [HARNESS_JUDGE],
  },
  'M18-anchors': {
    pass: 'dab2b88b',
    class: 'auto+confirm',
    signal:
      "__check anchor probe (every button's box against where worldToScreen puts its ring, per frame: max px error and jitter) under a scripted pan and zoom sweep, in both orientations; rAF p95 of the sweep alone",
    plan: lifecycle('device.html?anchors=50', {
      collector: 'anchors',
      mode: 'swim',
      windowMs: 15 * SECOND,
      warmupMs: 3 * SECOND,
    }),
    criteria: [
      {
        name: 'anchor_max_error_px',
        source: 'anchors.maxErrorPx',
        op: '<=',
        limit: null,
        ref: 'none: the Pass text says zero swim, so the number is shown to the judge',
        judge: 'always',
      },
      {
        name: 'raf_p95_ms',
        source: 'steady.*.raf_p95_ms',
        reduce: 'max',
        op: '<=',
        limit: 17.5,
        ref: 'pass',
      },
    ],
    metrics: [
      { name: 'anchor_jitter_px', source: 'anchors.jitterPx' },
      { name: 'anchor_probe_frames', source: 'anchors.frames' },
    ],
    acts: ['rotate the phone once between the two stretches (the pan and zoom are scripted)'],
    judges: ['no swim, text crisp at every zoom'],
  },
  'M18-fill-rate-with-anchors': {
    pass: '530d7b25',
    class: 'auto',
    signal:
      'as M09b-fill-rate on ?anchors=50 with the scripted pan and zoom sweep (__check.act.sweep), ladder &anchorMode=translate first',
    plan: lifecycle('device.html?anchors=50', {
      collector: 'fill-rate',
      sweep: true,
      windowMs: 60 * SECOND,
      warmupMs: 10 * SECOND,
      ladder: ['&anchorMode=translate', ...FILL_LADDER],
    }),
    criteria: fillRate(),
    metrics: fillMetrics,
    acts: ['rotate once'],
    judges: ['no visible hitch (only when the proxy is not clean)'],
  },
  'M18-pick': {
    pass: 'f47c72cf',
    class: 'auto',
    signal:
      'pick_id in __check; the bar highlights a target ring at three zoom levels and the page knows the expected id; a tap on a button must leave pick_id and the tap count unchanged',
    plan: lifecycle('device.html?anchors=50', { collector: 'anchors', mode: 'pick' }),
    criteria: [
      { name: 'pick_misses', source: 'pick.misses', op: '==', limit: 0, ref: 'pass' },
      {
        name: 'button_tap_changed_pick',
        source: 'pick.buttonChanged',
        op: '==',
        limit: false,
        ref: 'pass',
      },
    ],
    metrics: [{ name: 'rings_tapped', source: 'pick.taps.*', reduce: 'len' }],
    acts: ['tap the highlighted rings at three zoom levels, then a button'],
    judges: [],
  },
  'M18-touch-ghost': {
    pass: 'c02c078f',
    class: 'auto',
    signal:
      "cursorTile after a tap against the tile under the finger (worked out from the pointer's own position); the ghost's draw-list record and the tile it is anchored to; the camera centre moved by a drag",
    plan: lifecycle('device.html?anchors=50', { collector: 'anchors', mode: 'ghost' }),
    criteria: [
      {
        name: 'cursor_tile_matches_tap',
        source: 'ghost.tileMatches',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      { name: 'drag_pans', source: 'ghost.centreMoved', op: '==', limit: true, ref: 'pass' },
      {
        name: 'ghost_drawn',
        source: 'ghost.drawn',
        op: '==',
        limit: true,
        ref: 'pass: "the ghost (a translucent square, `extract()`\'s own `ANCHOR_CURSOR_TILE` draw)" is in the draw list the renderer reads (page state; not a pixel readback)',
      },
      {
        name: 'ghost_on_tapped_tile',
        source: 'ghost.onTapped',
        op: '==',
        limit: true,
        ref: 'pass: "sits on the tapped tile": the tile the driver tapped (the page\'s `tileUnder` of the up point) is the tile the ghost is anchored to (the cursor tile)',
      },
    ],
    metrics: [{ name: 'ghost_tile', source: 'ghost.tapped' }],
    acts: ['tap to move the cursor tile, then drag'],
    judges: [],
  },
  'M23-opfs-latency': {
    pass: 'db650cb0',
    class: 'auto',
    signal: 'window.__opfsLatencyResult (flush p95, move() and locks booleans)',
    plan: {
      page: 'opfs-latency.html',
      variant: 'fixture',
      collector: 'global',
      globals: ['__opfsLatencyResult'],
      built: true,
      delegation: 2,
    },
    criteria: [
      {
        name: 'flush_p95_ms',
        source: 'g.__opfsLatencyResult.flush.p95',
        op: '<=',
        limit: 10,
        ref: 'pass',
      },
    ],
    metrics: [
      { name: 'append_p95_ms', source: 'g.__opfsLatencyResult.append.p95' },
      { name: 'scratch_1mib_p95_ms', source: 'g.__opfsLatencyResult.scratchWrite1MiB.p95' },
      { name: 'scratch_8mib_p95_ms', source: 'g.__opfsLatencyResult.scratchWrite8MiB.p95' },
      { name: 'move_available', source: 'g.__opfsLatencyResult.moveAvailable' },
      { name: 'locks_available', source: 'g.__opfsLatencyResult.locksAvailable' },
    ],
    acts: [],
    judges: [],
  },
  'M23-kill-resume': {
    pass: '71786b62',
    class: 'auto',
    signal:
      'a play phase of Paints, then hash, tick and admitted count kept on the service (`reading before`); after the reopen the same three from __check/__worldHashAndTick',
    plan: lifecycle('world.html', {
      query: 'world=walk-kill',
      collector: 'world',
      mode: 'kill',
      resumable: true,
      keepCamera: true, // the reopened page restores what the first one saved
    }),
    criteria: [
      { name: 'world_resumed', source: 'after.resumed', op: '==', limit: true, ref: 'pass' },
      { name: 'admitted_actions_lost', source: 'after.lost', op: '==', limit: 0, ref: 'pass' },
    ],
    metrics: [
      { name: 'admitted_before', source: 'before.admitted' },
      { name: 'tick_before', source: 'before.tick' },
      { name: 'tick_last_action', source: 'before.lastActionTick' },
      { name: 'tick_after', source: 'after.tick' },
    ],
    acts: ['swipe-kill Safari and reopen it (the QR code again if the tab is gone)'],
    judges: [],
  },
  'M23-world-busy': {
    pass: '84503370',
    class: 'auto',
    signal:
      'two tabs of one world report: __check world_busy true in the second (and the banner shown), the first still playing',
    plan: lifecycle('world.html', {
      query: 'world=walk-busy',
      collector: 'world',
      mode: 'busy',
    }),
    criteria: [
      { name: 'second_tab_busy', source: 'second.worldBusy', op: '==', limit: true, ref: 'pass' },
      {
        name: 'second_tab_banner',
        source: 'second.banner',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      {
        name: 'first_keeps_playing',
        source: 'first.superseded',
        op: '==',
        limit: false,
        ref: 'pass',
      },
    ],
    metrics: [{ name: 'first_tick_delta', source: 'first.tickDelta' }],
    acts: ['tap "Open second tab", look at it, come back to this tab'],
    judges: [],
  },
  'M23-private': {
    pass: '7d0fb74f',
    class: 'auto',
    signal:
      'the Private tab (opened from a link on the bar) reports durable:false from __check, and a Paint still advances tick',
    plan: lifecycle('world.html', {
      query: 'world=walk-private',
      collector: 'world',
      mode: 'private',
      tolerate: ['noOpfs', 'world'],
    }),
    criteria: [
      { name: 'durable', source: 'final.durable', op: '==', limit: false, ref: 'pass' },
      {
        name: 'tick_advanced',
        source: 'paint.tickDelta',
        op: '>=',
        limit: 1,
        ref: 'pass: "the world still plays", read as a Paint tap advancing tick by at least one',
      },
    ],
    metrics: [],
    acts: ['open the link in a Private tab (the bar offers it, with Copy link)'],
    judges: [],
  },
  'M23-hidden-pause': {
    pass: '40758c59',
    class: 'auto',
    signal:
      'Paint (a fresh tick), the page is left for 30 s (visibility events), Paint again; __check durable; reload nonce',
    plan: lifecycle('world.html', {
      collector: 'world',
      mode: 'hidden-pause',
      reloadIsFail: true,
      leaves: [
        {
          text: 'Switch to another app for {s} seconds, then come back to this page.',
          ms: 30 * SECOND,
        },
      ],
    }),
    criteria: [
      {
        name: 'tick_delta',
        source: 'hidden.tickDelta',
        op: '<=',
        limit: null,
        ref: 'none: the Pass text says a few ticks, not about 600; the number is shown to the judge',
        judge: 'always',
      },
      { name: 'durable', source: 'final.durable', op: '==', limit: true, ref: 'pass' },
      { name: 'reloads', source: 'reloads', op: '==', limit: 0, ref: 'pass' },
    ],
    metrics: [{ name: 'hidden_ms', source: 'hidden.ms' }],
    acts: ['leave the app for 30 s'],
    judges: ['the second tick is only a few ticks past the first (not about 600)'],
  },
  'M23-export-import': {
    pass: 'ba6dc55f',
    class: 'auto+confirm',
    signal:
      "the page's own Export, Import and the second world (opened from the bar) read through __check; the download and the picker are real",
    plan: lifecycle('world.html', {
      query: 'world=walk-export',
      collector: 'world',
      mode: 'export',
      tolerate: ['world'],
      importId: 'walk-import',
    }),
    criteria: [
      {
        name: 'exported',
        source: 'export.bytes',
        op: '>=',
        limit: 1,
        ref: 'Steps: Export downloads a file',
      },
      { name: 'imported_loads', source: 'import.loaded', op: '==', limit: true, ref: 'pass' },
      {
        name: 'hash_equal',
        source: 'import.hashEqual',
        op: '==',
        limit: true,
        ref: 'pass',
        nullIs: 'judge',
      },
      {
        name: 'download_in_files',
        source: 'export.bytes',
        op: '>=',
        limit: null,
        ref: "none: the Pass text names no number; whether the file reached Files is the person's to say",
        judge: 'always',
      },
    ],
    metrics: [
      { name: 'ticks_apart', source: 'import.ticksApart' },
      { name: 'export_bytes', source: 'export.bytes' },
    ],
    acts: [
      'tap Export, choose the file in Import (id walk-import), tap Import, open the imported world',
    ],
    judges: ['the exported file arrived in Files (hashes are compared only at equal ticks)'],
  },
  'M29-socket-resume': {
    pass: 'a59a15f9',
    class: 'auto',
    signal:
      "six drops x three runs: the absence timed from the page's visibility and online events (the service holds each run to +-30% of its stated time), __mpLinkLog rows (close or silence, visible to Welcome), the discard flag",
    plan: lifecycle('mp.html?linklog=1&autopan=1', {
      variant: 'fixture-ws',
      collector: 'mp',
      mode: 'drops',
      scenarios: MP_SCENARIOS,
      runsEach: 3,
      resumable: true,
    }),
    criteria: [
      {
        name: 'visible_to_welcome_median_ms',
        source: 'runs.*.welcomeMs',
        reduce: 'median',
        op: '<=',
        limit: 1500,
        ref: 'pass: "median ≤ 1.5 s" in ms',
        nullIs: 'judge',
      },
      {
        name: 'visible_to_welcome_max_ms',
        source: 'runs.*.welcomeMs',
        reduce: 'max-known',
        op: '<=',
        limit: 4000,
        ref: 'pass: "max ≤ 4 s" in ms',
        nullIs: 'judge',
      },
    ],
    metrics: [
      { name: 'runs', source: 'runs.*.scenario', reduce: 'len' },
      { name: 'discarded_runs', source: 'runs.*.discarded', reduce: 'any' },
      { name: 'survived_runs', source: 'runs.*.survived', reduce: 'any' },
    ],
    acts: ['do each drop for the stated time'],
    judges: [],
  },
  'M29-play-through-drop': {
    pass: '4b9a2320',
    class: 'auto',
    signal:
      'the same runs as M29-socket-resume (read from them when both are in the round), the scripted pan (?autopan=1) across every drop, frames and camera moving after each, no dialog element in the DOM',
    plan: lifecycle('mp.html?linklog=1&autopan=1', {
      variant: 'fixture-ws',
      collector: 'mp',
      mode: 'drops',
      scenarios: MP_SCENARIOS,
      runsEach: 3,
      resumable: true,
      reuse: 'M29-socket-resume',
    }),
    criteria: [
      {
        name: 'stayed_interactive',
        source: 'runs.*.interactive',
        reduce: 'all',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      {
        name: 'modal_for_short_outage',
        source: 'runs.*.dialog',
        reduce: 'any',
        op: '==',
        limit: false,
        ref: 'pass',
      },
    ],
    metrics: [],
    acts: [],
    judges: [],
  },
  'M29-net-heap': {
    pass: 'f9a5c4f1',
    class: 'auto',
    signal:
      '10 min connected, four scripted Paints a second (steady traffic), rAF long-frame count and max (hitch proxy)',
    plan: lifecycle('mp.html?linklog=1', {
      variant: 'fixture-ws',
      collector: 'mp',
      mode: 'netheap',
      windowMs: 600 * SECOND,
      warmupMs: 10 * SECOND,
      reloadIsFail: true,
    }),
    criteria: [
      { name: 'reloads', source: 'reloads', op: '==', limit: 0, ref: 'pass' },
      {
        name: 'hitch_gaps_over_25ms',
        source: 'windows.*.raf.long25',
        reduce: 'sum',
        op: 'proxy',
        limit: 0,
        ref: 'hitch proxy (39f Planning decisions): a count above 25 ms; any gap is a judge prompt',
        judge: 'borderline',
      },
    ],
    metrics: [
      { name: 'raf_gap_max_ms', source: 'windows.*.raf.max', reduce: 'max' },
      { name: 'paints', source: 'paints' },
    ],
    acts: [],
    judges: ['no visible periodic hitch (only when the proxy is not clean)'],
  },
  'M34-two-devices': {
    pass: '27919208',
    class: 'auto+confirm',
    signal:
      'bot partner on the Mac (Playwright Chromium, scripted by the service: collect, craft, place, disconnect, return); check build `__check` roster dots and remote circles and furnaces on both sides',
    plan: mp({ mode: 'two', bot: 'two' }),
    criteria: [
      {
        name: 'remote_entity_seen',
        source: 'final.remote_entities',
        op: '>=',
        limit: 1,
        ref: 'Steps: phone and Mac join one world; the other player is at least one remote circle',
      },
      {
        name: 'furnace_seen',
        source: 'final.furnaces',
        op: '>=',
        limit: 1,
        ref: 'Steps: collect on one, place on the other: the placed furnace is at least one sprite on the other side',
      },
      { name: 'bot_sees_phone', source: 'botView.sawPhone', op: '==', limit: true, ref: 'pass' },
      {
        name: 'roster_dot_hollow_after_drop',
        source: 'roster.hollowAfterDrop',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      {
        name: 'roster_dot_filled_on_return',
        source: 'roster.filledOnReturn',
        op: '==',
        limit: true,
        ref: 'pass',
      },
      {
        name: 'sees_its_circle',
        source: 'final.remote_entities',
        op: '>=',
        limit: null,
        ref: 'none: "each sees the other\'s circle" is the person\'s eyes: one confirm tap',
        judge: 'always',
      },
    ],
    metrics: [
      { name: 'bot_roster_n', source: 'botView.roster_n' },
      { name: 'hollow_after_ms', source: 'roster.hollowAfterMs' },
    ],
    acts: ['collect on one device, place on the other (the bot does the Mac half)'],
    judges: ['I see its circle'],
  },
  'M34-own-timer-bar': {
    pass: '259f2df2',
    class: 'auto',
    signal:
      'check build `__check.act.collectOnce`: the tap, the moment the bar finishes filling (`animationend`) and the first `Ui` with the item in the inventory, per link (Wi-Fi, then a throttled or cellular link)',
    // `timer.toleranceMs`: the resolution of the measurement, not a Pass number: one 20 Hz tick (50 ms) plus
    // two frames. A result earlier than that before the bar is full, or a full bar left waiting for longer
    // than that, is what the Pass text forbids.
    plan: mp({ mode: 'timer', timer: { toleranceMs: 100 } }),
    criteria: [
      {
        name: 'links_measured',
        source: 'links.*',
        reduce: 'len',
        op: '>=',
        limit: 2,
        ref: 'Steps: start own timers on Wi-Fi, then on a throttled or cellular link',
      },
      {
        name: 'timers_completed',
        source: 'timers.*.ok',
        reduce: 'all',
        op: '==',
        limit: true,
        ref: 'none: a collect with no result in time is a failed run, not a bar',
      },
      {
        name: 'result_before_bar_full',
        source: 'timers.*.resultBeforeFull',
        reduce: 'any',
        op: '==',
        limit: false,
        ref: 'pass',
      },
      {
        name: 'bar_waiting_after_full',
        source: 'timers.*.fullWaiting',
        reduce: 'any',
        op: '==',
        limit: false,
        ref: 'pass',
      },
    ],
    metrics: [
      { name: 'gap_ms_min', source: 'timers.*.gapMs', reduce: 'min' },
      { name: 'gap_ms_max', source: 'timers.*.gapMs', reduce: 'max' },
      { name: 'bar_ms_median', source: 'timers.*.durationMs', reduce: 'median' },
      { name: 'runs', source: 'timers.*.ok', reduce: 'len' },
    ],
    acts: ['switch the phone off Wi-Fi when asked'],
    judges: [],
  },
  'M34-remote-motion': {
    pass: 'f469a332',
    class: 'auto+confirm',
    signal:
      'check build `__check.act.sample`: the remote circle of the bot from the newest DrawList every frame, jump against the neighbouring frames (a snap), and its alpha after the bot disconnects',
    // `snap`: what counts as a snap is a definition of the measurement, not a Pass number: a jump of more
    // than `factor` times the median step of the `window` frames either side, and of more than `floorTiles`
    // (a circle at rest has a median step of 0). A snap is a judge prompt, never a failure by itself.
    plan: mp({
      mode: 'motion',
      bot: 'motion',
      derive: 'motion',
      snap: { factor: 4, floorTiles: 0.25, window: 5 },
    }),
    criteria: [
      {
        name: 'remote_moved',
        source: 'derived.travelTiles',
        op: '>=',
        limit: 1,
        ref: 'Steps: move on the Mac and watch the phone: a remote circle that never moved shows nothing about snapping',
      },
      {
        name: 'snaps',
        source: 'derived.snaps',
        op: 'proxy',
        limit: 0,
        ref: 'hitch proxy (39f Planning decisions): a count of jumps above the snap definition; any is a judge prompt',
        judge: 'borderline',
      },
      {
        name: 'fade_missing',
        source: 'derived.fadeMissing',
        op: 'proxy',
        limit: 0,
        // 1 when the circle was never drawn with an alpha under 255 after the bot went. `0012` fades an avatar
        // after 2 s of silence (a dropped link: the Mac's Wi-Fi off); a bot that closes its page is a clean
        // close, which `0013` makes vanish at once. So "no fade seen" is a judge prompt, never a failure.
        ref: 'hitch proxy (39f Planning decisions): 1 when no fade was seen; the person judges, never an automatic failure',
        judge: 'borderline',
      },
      {
        name: 'no_snap_and_fades',
        source: 'derived.maxJumpTiles',
        op: '<=',
        limit: null,
        ref: 'none: "moves without snapping" and "it fades" are seen by the person: one confirm tap, with the largest jump shown',
        judge: 'always',
      },
    ],
    metrics: [
      { name: 'max_jump_tiles', source: 'derived.maxJumpTiles' },
      { name: 'travel_tiles', source: 'derived.travelTiles' },
      { name: 'frames', source: 'derived.frames' },
      { name: 'fade_min_alpha', source: 'derived.minAlpha' },
    ],
    acts: [],
    judges: ['it fades, no snap'],
  },
  'M35-safari-build-mac': {
    pass: 'c814759c',
    class: 'auto+confirm',
    signal:
      'release build, DOM only: no capability or fatal screen, canvas present and sized, no delivery line, the wrapped device (errors, loss), frame cadence from the agent',
    // `device: 'mac'`: walked in a Mac browser tab (the service opens it, delegation 5 step 14); a phone
    // that reaches it is told it is not its row (`params.client`, auto-round.mjs).
    plan: reference('', {
      collector: 'reference-dom',
      device: 'mac',
      browsers: ['safari'],
      observeMs: 8 * SECOND,
      built: true,
    }),
    criteria: [...m35Criteria()],
    metrics: m35Metrics,
    acts: [],
    judges: ['the game plays (world drawn)'],
  },
  'M35-safari-build-iphone': {
    pass: '0f644141',
    class: 'auto+confirm',
    signal: 'as M35-safari-build-mac',
    plan: reference('', { collector: 'reference-dom', observeMs: 8 * SECOND, built: true }),
    criteria: [...m35Criteria()],
    metrics: m35Metrics,
    acts: [],
    judges: ['the game plays (world drawn)'],
  },
  'M35-capability': {
    pass: 'ca8f9fbb',
    class: 'retired',
    signal: 'covered by capability.spec.ts (Tyler 2026-10-03: retired from the device list)',
    plan: later(4, '', { variant: 'reference', collector: null, retired: true }),
    criteria: [],
    metrics: [],
    acts: [],
    judges: [],
  },
  'M37b-ios-background': {
    pass: '533b2c8b',
    class: 'auto+confirm',
    signal:
      'release build, DOM only: three deliberate leaves; per run the wrapped device (lost, uncapturederror), the renderer-lost banner, the agent rAF resuming; the boot nonce (a reload is a failure)',
    plan: reference('', {
      collector: 'reference-bg',
      built: true,
      reloadIsFail: true,
      // `ms`: how long "several minutes" is for one leave (a run outside 70% of it asks again); `runs`: 3.
      leaves: { runs: 3, ms: 180 * SECOND },
    }),
    criteria: [
      {
        name: 'runs_done',
        source: 'runs.*',
        reduce: 'len',
        op: '>=',
        limit: 3,
        ref: 'Steps: three runs',
      },
      {
        name: 'black_or_frozen_runs',
        source: 'runs.*.frozen',
        reduce: 'any',
        op: '==',
        limit: false,
        ref: 'pass',
      },
      { name: 'reloads', source: 'reloads', op: '==', limit: 0, ref: 'pass' },
      {
        name: 'drawn_again_per_run',
        // The measured facts of each run in words (frames resumed, canvas present, banner, device lost): the page and
        // the collector were right, the value shown used to be "any renderer-lost banner" (false), which read as
        // "not drawn again". A black canvas is not measurable from the page: that stays the judge's.
        source: 'summary',
        op: '==',
        limit: null,
        ref: "none: a black canvas cannot be told from the page; every run's facts are shown with it",
        judge: 'always',
      },
    ],
    metrics: [
      { name: 'device_lost_total', source: 'runs.*.deviceLost', reduce: 'sum' },
      { name: 'uncaptured_errors_total', source: 'runs.*.gpuErrors', reduce: 'sum' },
      { name: 'renderer_lost_banners', source: 'runs.*.rendererLost', reduce: 'count-true' },
      { name: 'leave_ms_min', source: 'runs.*.ms', reduce: 'min' },
    ],
    acts: ['background the tab under memory pressure for several minutes, three times'],
    judges: ['drawn again, per run'],
  },
  'M38-hosted-boot': {
    pass: '51b3d834',
    class: 'human',
    signal:
      'none on the page (the Fly origin is not ours to inject into); scripts/check-coi.mjs attached',
    plan: later(4, '', { variant: 'fly', collector: null }),
    criteria: [],
    metrics: [],
    acts: ['open the URL on cellular'],
    judges: ['the page is isolated, has an adapter and reaches online'],
  },
  'M38-socket-resume': {
    pass: '5935fc23',
    class: 'human',
    signal: 'none (as above); the on-page ?linklog=1 rows are read by eye',
    plan: later(4, '?linklog=1', { variant: 'fly', collector: null }),
    criteria: [],
    metrics: [],
    acts: ['the M29 drops, copy the rows'],
    judges: ['visible to Welcome median and max'],
  },
  'M38-remote-motion': {
    pass: '1725e8ec',
    class: 'human',
    signal: 'none',
    plan: later(4, '', { variant: 'fly', collector: null }),
    criteria: [],
    metrics: [],
    acts: ['as M34-remote-motion by hand'],
    judges: ['moves without snapping; fades when its player drops'],
  },
  'M39-large-save': {
    pass: '85d26f8a',
    class: 'auto',
    signal:
      'bench build `window.__check.readings()` (the bench HUD as numbers, once a second) read after the first 10 s: engine_mem_grows sim and client, tick p95; reload nonce; 10 min',
    // The HUD is read after `warmupMs` only: the first tick visits all 262,144 furnaces, so `tick p95` is
    // inflated early (device-checks.md). The criteria read the worst steady sample, never the last one.
    plan: reference('?bench=large-save', {
      variant: 'reference-bench',
      collector: 'bench',
      windowMs: 600 * SECOND,
      warmupMs: 10 * SECOND,
      reloadIsFail: true,
    }),
    criteria: [
      {
        name: 'engine_mem_grows_sim',
        source: 'steady.*.engine_mem_grows_sim',
        reduce: 'max',
        op: '==',
        limit: 0,
        ref: 'pass',
      },
      {
        name: 'engine_mem_grows_client',
        source: 'steady.*.engine_mem_grows_client',
        reduce: 'max',
        op: '==',
        limit: 0,
        ref: 'pass',
      },
      { name: 'reloads', source: 'reloads', op: '==', limit: 0, ref: 'pass' },
      {
        name: 'tick_p95_ms',
        source: 'steady.*.tick_p95_ms',
        reduce: 'max',
        op: '<=',
        limit: 10,
        ref: 'PRE-PLAN §7 Tick time (0010)',
      },
    ],
    // What `docs/plan/acceptance/budgets.md` cites for "Tick time: phone sim worker": the worst steady
    // `tick p95` (the criterion's own value) and the last HUD reading (what a person copying the HUD gets).
    metrics: [
      { name: 'tick_p95_ms_last', source: 'final.tick_p95_ms' },
      { name: 'main_p95_ms_last', source: 'final.main_p95_ms' },
      { name: 'frame_p95_ms_last', source: 'final.frame_p95_ms' },
      { name: 'ticks', source: 'final.tick' },
      { name: 'raf_gap_max_ms', source: 'windows.*.raf.max', reduce: 'max' },
    ],
    acts: [],
    judges: [],
  },
  'M39-frame-shares': {
    pass: '11772ba9',
    class: 'auto',
    signal:
      'bench build `window.__check.readings()` main p95 and frame p95 after the first 10 s, scripted pan (`pan=2`), `zoom=max` (bench-only parameter)',
    plan: reference('?bench=large-save&pan=2&zoom=max', {
      variant: 'reference-bench',
      collector: 'bench',
      windowMs: 60 * SECOND,
      warmupMs: 10 * SECOND,
      reloadIsFail: true,
    }),
    criteria: [
      {
        name: 'main_p95_ms',
        source: 'steady.*.main_p95_ms',
        reduce: 'max',
        op: '<=',
        limit: 4,
        ref: 'PRE-PLAN §7 Frame time (0018 §9)',
      },
      {
        name: 'frame_p95_ms',
        source: 'steady.*.frame_p95_ms',
        reduce: 'max',
        op: '<=',
        limit: 8,
        ref: 'PRE-PLAN §7 Frame time (0018 §9)',
      },
      {
        name: 'reloads',
        source: 'reloads',
        op: '==',
        limit: 0,
        ref: 'none: a reload would restart the window',
      },
    ],
    // "Frame time: main rAF callback, phone" and "client-worker `frame`, phone" of the acceptance budgets:
    // the criteria's worst steady values above, and the last HUD reading beside them.
    metrics: [
      { name: 'main_p95_ms_last', source: 'final.main_p95_ms' },
      { name: 'frame_p95_ms_last', source: 'final.frame_p95_ms' },
      { name: 'tick_p95_ms', source: 'steady.*.tick_p95_ms', reduce: 'max' },
      { name: 'raf_gap_max_ms', source: 'windows.*.raf.max', reduce: 'max' },
    ],
    acts: [],
    judges: [],
  },
  'M39-full-game-touch': {
    pass: '0193cb28',
    class: 'human',
    signal: 'telemetry only (reload, long frames, errors, rAF); the verdict is the play',
    plan: later(4, '', { variant: 'reference', collector: null }),
    criteria: [],
    metrics: [],
    acts: ['play the script of 34b by touch for 10 min'],
    judges: ['every step works by touch, buttons stay glued, no reload, no visible hitch'],
  },
  'M39-two-devices': {
    pass: 'ebfa92cb',
    class: 'human',
    signal: 'telemetry only; the real second device is the point',
    plan: later(4, '', { variant: 'reference-ws', collector: null }),
    criteria: [],
    metrics: [],
    acts: ['phone and Mac in one world'],
    judges: ['each sees the other move smoothly; roster dots follow; a furnace appears on both'],
  },
  'M39-desktop-browsers': {
    pass: '0d24a819',
    class: 'auto',
    signal:
      'Mac Safari and Firefox tabs opened by the service: console and uncapturederror capture, long-frame proxy',
    // The check build (`reference-bench`) so the pan is scripted (`__check.act.moveTo`), in each Mac browser in
    // turn (`browsers`): the legs report through the round log and the last one sends the attempt's data.
    // A browser with no `navigator.gpu` (Firefox) is recorded as unsupported: the row is then `skip`.
    plan: later(5, '', {
      variant: 'reference-bench',
      collector: 'desktop-play',
      device: 'mac',
      browsers: ['safari', 'firefox'],
      windowMs: 5 * 60 * SECOND,
      warmupMs: 0,
      built: true,
    }),
    criteria: [
      { name: 'validation_errors', source: 'gpu.errors', op: '==', limit: 0, ref: 'pass' },
      { name: 'page_errors', source: 'pageErrors', op: '==', limit: 0, ref: 'pass' },
      {
        name: 'ran_in_every_browser',
        source: 'ran',
        op: '==',
        limit: true,
        ref: 'none: a browser that never started the game did not play it',
      },
      {
        name: 'hitch_gaps_over_25ms',
        source: 'windows.*.raf.long25',
        reduce: 'sum',
        op: 'proxy',
        limit: 0,
        ref: 'hitch proxy (39f Planning decisions): a count above 25 ms; any gap is a judge prompt',
        judge: 'borderline',
      },
    ],
    metrics: [],
    acts: [],
    judges: ['no periodic hitch (only when the proxy is not clean)'],
  },
  'M39-sign-off': {
    pass: '6412cbd1',
    class: 'human',
    signal: 'none',
    plan: later(4, '', { variant: 'reference-ws', collector: null }),
    criteria: [],
    metrics: [],
    acts: [],
    judges: ['Tyler signs off'],
  },
}

// --- evaluation -------------------------------------------------------------------------------------

/** Values at `path` in `obj`; a `*` fans out over an array or an object's values. Always an array. */
export function valuesAt(obj, path) {
  let cur = [obj]
  for (const key of path.split('.')) {
    const next = []
    for (const v of cur) {
      if (v === null || v === undefined) continue
      if (key === '*') {
        if (Array.isArray(v)) next.push(...v)
        else if (typeof v === 'object') next.push(...Object.values(v))
      } else if (typeof v === 'object' && key in v) next.push(v[key])
    }
    cur = next
  }
  return cur
}

const num = (x) => typeof x === 'number' && Number.isFinite(x)

const REDUCERS = {
  max: (v) => (v.every(num) && v.length ? Math.max(...v) : null),
  min: (v) => (v.every(num) && v.length ? Math.min(...v) : null),
  sum: (v) => (v.every(num) ? v.reduce((a, b) => a + b, 0) : null),
  median: (v) => {
    const s = v.filter(num).sort((a, b) => a - b)
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null
  },
  all: (v) => v.length > 0 && v.every(Boolean),
  any: (v) => v.some(Boolean),
  'count-false': (v) => v.filter((x) => !x).length,
  len: (v) => v.length,
  distinct: (v) => new Set(v).size,
  'first-line': (v) => (typeof v[0] === 'string' ? (v[0].split('\n')[0] ?? '').trim() : null),
  last: (v) => {
    const a = v.at(-1)
    return Array.isArray(a) ? (a.at(-1) ?? null) : (a ?? null)
  },
  /** Largest of the readings the page could give; null readings (not taken yet) are ignored. */
  'max-known': (v) => {
    const k = v.filter(num)
    return k.length ? Math.max(...k) : null
  },
  'count-true': (v) => v.filter((x) => x === true).length,
  'ceiling-mib': (v) => {
    const line = (v[0] ?? []).find?.((l) => /^\(1\) ceiling: (\d+) MiB reached/.test(l))
    return line ? Number(/(\d+) MiB/.exec(line)[1]) : null
  },
}

/** `source` folded by `reduce` (default: the single value, or null when absent). */
export function read(data, source, reduce) {
  const v = valuesAt(data, source)
  if (reduce) return REDUCERS[reduce](v)
  return v.length ? v[0] : null
}

const OPS = {
  '<=': (v, l) => num(v) && v <= l,
  '>=': (v, l) => num(v) && v >= l,
  '==': (v, l) => v === l,
  truthy: (v) => !!v,
  has: (v, l) => Array.isArray(v) && v.some((x) => String(x).includes(l)),
}

const medianOfAll = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0
}

/**
 * M34-remote-motion's numbers from the phone's raw per-frame record of the remote circle (`frames`:
 * `[t, x, y]` for each frame the circle was in the DrawList). A *snap* is a frame-to-frame jump above
 * `floorTiles` and above `factor` times the median jump of the `window` frames on either side (the
 * "expected step": a circle at rest has median 0, which is why the floor exists). The definition lives
 * here, beside the criterion, and the page only reports what it saw.
 */
export function analyseMotion(frames, { factor, floorTiles, window: w }) {
  const jumps = []
  let travel = 0
  for (let i = 1; i < frames.length; i++) {
    const d = Math.hypot(frames[i][1] - frames[i - 1][1], frames[i][2] - frames[i - 1][2])
    jumps.push(d)
    travel += d
  }
  let snaps = 0
  let max = 0
  jumps.forEach((d, i) => {
    max = Math.max(max, d)
    const near = [...jumps.slice(Math.max(0, i - w), i), ...jumps.slice(i + 1, i + 1 + w)]
    if (d > floorTiles && d > factor * medianOfAll(near)) snaps++
  })
  return {
    frames: frames.length,
    travelTiles: +travel.toFixed(3),
    maxJumpTiles: +max.toFixed(3),
    snaps,
  }
}

/**
 * The fade after the other player's socket is gone (`frames`: `[t, circles, alpha]` per frame, `alpha` the
 * first remote circle's byte, null with none): it fades when the circle is drawn with an alpha under 255
 * (0012: "fade an avatar after 2 s of silence"); `vanished` when it ends up not drawn at all.
 */
export function analyseFade(frames) {
  const drawn = frames.filter((f) => f[1] >= 1 && typeof f[2] === 'number')
  const minAlpha = drawn.length ? Math.min(...drawn.map((f) => f[2])) : null
  const last = frames.at(-1)
  const fades = minAlpha !== null && minAlpha < 255
  return {
    fades,
    fadeMissing: fades ? 0 : 1,
    minAlpha,
    fadeFrames: drawn.filter((f) => f[2] < 255).length,
    vanished: !!last && last[1] === 0 && drawn.length > 0,
  }
}

const DERIVE = {
  motion: (data, _ctx, entry) => ({
    ...analyseMotion(data.motionFrames ?? [], entry.plan.snap),
    ...analyseFade(data.fadeFrames ?? []),
  }),
  /** F = phone median / desktop median (`0008` Consequences; the M08-warn-threshold item). */
  'worldgen-F'(data, ctx) {
    const phone = read(data, 'g.__worldgenBench.medianMs')
    const desktop = ctx.desktopMedianMs ?? null
    const F = num(phone) && num(desktop) && desktop > 0 ? phone / desktop : null
    return {
      desktopMedianMs: desktop,
      F: F === null ? null : +F.toFixed(3),
      warnMs: F === null ? null : +(1 / F).toFixed(4),
    }
  },
}

const round = (v) => (typeof v === 'number' ? +v.toFixed(3) : v)

/**
 * Judge the collected `data` of one attempt against an entry. Returns
 * `{ verdict: 'pass'|'fail'|'judge', criteria: [{name, value, limit, ok}], metrics }`: `ok` is `true`,
 * `false`, or `null` for a hitch proxy that is not clean (a judge prompt decides) or a criterion the
 * page could not report. Criteria sharing a `group` pass when any one does. `judge: 'always'` rows only
 * ever ask the person.
 */
export function evaluate(entry, data, ctx = {}) {
  const root = { ...data }
  if (entry.plan.derive) root.derived = DERIVE[entry.plan.derive](data, ctx, entry)
  const rows = [...entry.criteria, ...(entry.assist?.criteria ?? [])].map((c) => {
    const value = read(root, c.source, c.reduce)
    let ok
    if (c.op === 'proxy') ok = num(value) ? (value <= c.limit ? true : null) : null
    else if (value === null || value === undefined) ok = c.nullIs === 'judge' ? null : false
    else ok = !!OPS[c.op](value, c.limit)
    if (c.judge === 'always') ok = null
    return { c, row: { name: c.name, value: round(value ?? null), limit: c.limit, ok } }
  })
  const groups = new Map()
  for (const { c, row } of rows)
    if (c.group) groups.set(c.group, [...(groups.get(c.group) ?? []), row])
  const settled = []
  for (const { c, row } of rows) {
    if (!c.group) settled.push(row.ok)
    else if (!settled.includes(`g:${c.group}`)) {
      const g = groups.get(c.group)
      settled.push(`g:${c.group}`)
      settled.push(
        g.some((r) => r.ok === true) ? true : g.some((r) => r.ok === null) ? null : false,
      )
    }
  }
  const flat = settled.filter((x) => typeof x !== 'string')
  const verdict = flat.includes(false) ? 'fail' : flat.includes(null) ? 'judge' : 'pass'
  const metrics = {}
  for (const m of [...(entry.metrics ?? []), ...(entry.assist?.metrics ?? [])]) {
    const v = read(root, m.source, m.reduce)
    if (v !== null && v !== undefined) metrics[m.name] = round(v)
  }
  for (const r of rows) if (typeof r.row.value === 'number') metrics[r.row.name] ??= r.row.value
  return { verdict, criteria: rows.map((r) => r.row), metrics }
}

/** Entries that a round walks: not retired, not meta (a missing entry is not walked either). */
export const walkable = (id) => !!CHECKS[id] && CHECKS[id].class !== 'retired'
