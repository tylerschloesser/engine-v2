# Manual device checks

Tyler-run checks on real hardware: what Phase 3 cannot automate (`0020` §10, `PRE-PLAN.md` §9 risk 1). This file owns every manual check; briefs only link to their section here. One section per milestone marked **D** in `PLAN.md`, in `PLAN.md` order.

- **A driven round needs no person at the phone (M39j):** `pnpm device:walk --auto --drive ios|android --round <name> [--only <id-prefix,...>] [--timeout <seconds>]` with the phone on USB. The Mac does Tyler's part with real device actions (OS touches, rotation, Home, Airplane, Low Power, Safari relaunch) and answers judge sheets with a **screenshot and no verdict**: those rows stay open (`--status` lists them in `humanPending`, with `shots`) until the orchestrator reads the screenshot and records `pnpm device:walk --judge <round> <id> pass|fail|skip [--note ...]` (`by: orchestrator`). A thing the phone cannot do is recorded `skip` with `NotDrivable: <reason>`, never a pass. Android is `adb` over `adb reverse` (`--tunnel` for the items that need the real network), iOS is Appium/WDA through the tunnel (the first session can take about 5 minutes). The `device-round` skill has the commands. **Stay Tyler's, in any round:** `M11-pinch-desktop-safari` (the Mac trackpad), `M17b-harness-desktop-safari` and `-firefox` (Web Inspector and the Profiler), the human-class rows (`M38-*`, `M39-full-game-touch`, `M39-two-devices`), `M39-sign-off` and `M39-rerun`.
- **Run a round with `pnpm device:walk --auto --round <name> [--only <id-prefix,...>]`** (the `device-round` skill, M39f): Tyler scans **one** QR code and the phone walks the round itself, collecting what a browser can report and asking him only for what needs a person; the Mac's own browsers (desktop Safari and Firefox) and a bot partner for the two-device items are started by the tool. `--wait <round>` and `--status <round> --json` let another session follow it; `--apply <round> [--dry-run]` ticks items and writes the **Run on** lines below. `--manual` is the older one-item-at-a-time flow (Tyler types each result); the manual steps in the sections stay valid for a by-hand run. Before a round: Auto-Lock **Never** on the phone (set it back afterwards), Low Power Mode off. Phone self-test, run once (2026-10-03, iPhone, iOS 18.7, Safari 27.0, round `selftest-2026-10-03b`): the page stayed visible for the 6 min hold (0 hidden events), the two-origin hop worked, 9 of 9 taps arrived in order through the 20 s link cut (recovery 292 ms); the wake lock is best-effort only (iOS grants it per document, with a tap).
- A check never blocks the next milestone. A failed check opens a plan edit (`PLAN.md`, "How milestones work"); where an ADR's number changes, a superseding ADR.
- The implementer that lands a **D** milestone makes its section match what it built (exact page, URL parameters, HUD field names). Headings and item ids are stable: briefs link to the headings, and M39's `acceptance-check.mjs` looks up ticked ids. Add an item as `- [ ] **M<NN>-<slug>**`; never rename one.
- Tick an item when it passes. On FAIL leave it unticked, follow *If it fails*, re-run, and record both runs on the section's **Run on** line.

## Devices

- **iPhone:** 12-class or newer, iOS 26+, Safari. Low Power Mode off unless an item says otherwise.
- **Android:** a Pixel 5 (Android 14, Chrome) on USB, driven by the Mac (`--drive android`, M39j; Tyler offered it, Q5's default). A round run on it is evidence about Android: `--apply` writes its **Run on** lines and ticks nothing, and every `-android` row below stays unticked ("not run" until Tyler decides what a Pixel result is worth there). The iPhone rows are ticked from iPhone rounds only. Desktop Chrome is covered by the automated suites, not here.
- **Mac** (Tyler's): desktop Safari and Firefox, for the items that name them.

## How to serve a page to the phone

Mechanism, rationale and the `mkcert` alternative: [M03's brief](03-browser-harness.md), Planning decisions, "Determinism on a physical phone". The tunnel is approved (Q7). WebGPU, OPFS and `crossOriginIsolated` need a secure context, so `http://<LAN IP>` never works.

- **iPhone:** on the Mac run `pnpm device:serve --tunnel`; open the printed `https://` URL in Safari. Its `index.html` lists every fixture-app page; items below name the page and its parameters.
- **Android** *(unused: no device, Q5)*: if a device ever appears, `pnpm device:serve`, then the `adb reverse` step of M03's brief, then the `localhost` URL in Chrome.
- **Mac browsers:** `pnpm device:serve` and the loopback URL it prints (loopback is a secure context; no tunnel).
- **Multiplayer items (M29 onward):** an `https` page cannot open `ws://`, so add `--ws [<fixture>]`: `device:serve` then starts a real-time `games/reference-server` and proxies `/ws` on the page's own origin, through the tunnel too (built in M29).
- **The reference game** (M34, M35, M37b, M39): `pnpm device:serve --tunnel --app reference --ws` serves `games/reference` instead of the fixture app, same tunnel and proxy (built in M29). **`?bench=large-save` is only in the bench build** (`vite build --mode bench`, `games/reference/dist-bench/`); plain `--app reference` serves the release build, where the parameter is ignored and no `#bench-hud` exists. For M39-large-save and M39-frame-shares serve the bench build: `pnpm device:serve --app reference --bench`, plus `--tunnel` for the iPhone (`pnpm device:serve --tunnel --app reference --bench`), then open `<printed URL>/?bench=large-save` (the bench build is the production page alone, so the printed `index.html` is the page). Single-player needs no `--ws`.
- Every item starts with "served as above". If the HUD says "not isolated", the serving is wrong, not the engine: fix that first.

---

## M03: Determinism page

When: the page exists from M03; first scheduled run is in the M11 sitting. Closes the deferred phone run of `0002`.

**Open** (served as above): `determinism.html`.

- [x] **M03-determinism** (`0002`). *Steps:* load the page, wait for the banner. *Pass:* one PASS banner; every checkpoint hash equals its golden (0 mismatches); the page shows `crossOriginIsolated: true`. *If it fails:* no fallback by design. Record the first divergent checkpoint and the user agent; open a plan edit. Suspects in order: an observable NaN (`0002` §2), a toolchain difference.
- [ ] **M03-determinism-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. Same page, Chrome. *Pass / If it fails:* as above.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M03-determinism PASS (numbers: fixtures=3, checkpoint_mismatches=0); Android: not run: no device [round m39ad-iphone-driven]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M03-determinism PASS (numbers: fixtures=3, checkpoint_mismatches=0) [round m39y-full-pixel]

---

## M08: Worldgen ms per chunk

When: the page exists from M08; first scheduled run is in the M11 sitting. Closes the deferred item of `0008` Consequences.

**Open** (served as above): `worldgen-bench.html`.

- [x] **M08-worldgen-ms-per-chunk** (`0008` §6). *Steps:* let the bench finish; record median ms/chunk, the golden result, the user agent and `hardwareConcurrency`. *Pass:* golden match, and median at or under the per-chunk budget of `0008` §6 (1 ms). *If it fails:* golden mismatch is a determinism bug: stop and treat as M03-determinism. Over budget: plan edit revisiting the default gen-worker count on phones (M08b) and M13's warmer yield per gap (`0008` Consequences).
- [x] **M08-warn-threshold**. *Steps:* compute F = phone median / desktop median from the same page. *Pass:* phone median ≤ 0.5 ms (the estimate in `0008` holds) or F ≤ 5. *If it fails:* set `worldgenMsPerChunkWarn` in `budgets.json` to 1 ms / F and record F.
- [ ] **M08-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. Both items in Chrome.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M08-worldgen-ms-per-chunk PASS (numbers: median_ms=0.1, cores=4, median_ms_per_chunk=0.1); M08-warn-threshold PASS (numbers: phone_median_ms=0.1, desktop_median_ms=0.08, F=1.25, warn_if_failing_ms=0.8); Android: not run: no device [round m39ad-iphone-driven]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M08-worldgen-ms-per-chunk PASS (numbers: median_ms=0.295, cores=8, median_ms_per_chunk=0.295); M08-warn-threshold PASS (numbers: phone_median_ms=0.295, desktop_median_ms=0.08, F=3.688, warn_if_failing_ms=0.271) [round m39y-full-pixel]

---

## M09b: Terrain fill rate

When: as soon as M09b is ticked; repeated by M18-fill-rate-with-anchors and M39-rerun. Closes the deferred item of `0018` Consequences.

**iOS frame pacing is judged from driverless runs only (`0056`).** A live driver session degrades WebKit's frame delivery (M39v: with the inspector attached or not). A *driven* iOS attempt of this check, M16-coexist, M29-net-heap or M34-remote-motion records its rAF and hitch numbers with a note and no pass or fail verdict on them (the other criteria of the item are judged as usual); the item's tick comes from a driverless round with Tyler.

**Open** (served as above): `device.html?autopan=1&tiles=256&scale=2`.

- [x] **M09b-fill-rate** (`0018` §9 GPU share; `0018` Consequences). *Steps:* portrait 60 s, then landscape 60 s (on iOS Safari portrait only, no rotation, `0057`); copy the HUD numbers. *Pass:* both orientations measured (on iOS Safari one portrait window, every window portrait, `0057`); `isolated` and adapter lines green; rAF interval p95 ≤ 17.5 ms; intervals > 20 ms ≤ 5 per 10 s (on iOS Safari these two are advisory: recorded and shown, never failed, `0056`); GPU execution p95 ≤ 6 ms (timestamp queries, `gpu_exec_p95_ms`; the queue latency is informational, M39k); on iOS Safari also no gap over 20 ms has an engine cause (`stall` under 16 ms and callback lateness under 2 ms for every gap in the measured windows, `0056`); no visible hitch while chunks stream in. *If it fails,* in the order `0018` Consequences states: reopen with `&scaleCap=1.5`; then `&scaleCap=1`; then add `&cutoff=4`. The first passing configuration becomes the mobile default: plan edit changing the `ClientOptions.render` defaults, plus a superseding ADR note for `0018`. None passes: plan edit for the per-chunk-quad fallback of `0018` (a new brief).
- [ ] **M09b-fill-rate-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. Same, Chrome.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M09b-fill-rate PASS (numbers: raf_gap_max_ms=23.1, frames=3591, raf_p50_ms=16.7, gpu_exec_p50_ms=1.7, gpu_latency_p95_ms=6.96, windows_measured=1, raf_p95_ms=17.56, raf_over20_per_10s=4, gpu_exec_p95_ms=2.426, hitch_gaps_over_25ms=0, engine_gap_causes=0); Android: not run: no device [round m39ad-iphone-qr]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M09b-fill-rate FAIL (no configuration passed (tried the default, &scaleCap=1.5, &scaleCap=1, &scaleCap=1&cutoff=4); numbers: raf_gap_max_ms=29.3, frames=7184, raf_p50_ms=16.7, gpu_exec_p50_ms=1.921, gpu_latency_p95_ms=7.34, windows_measured=2, raf_p95_ms=18, raf_over20_per_10s=13, gpu_exec_p95_ms=2.777, hitch_gaps_over_25ms=1); Android: not run: no device [round m39r-iphone]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M09b-fill-rate PASS (numbers: raf_gap_max_ms=16.9, frames=7179, raf_p50_ms=16.7, gpu_exec_p50_ms=5.505, gpu_latency_p95_ms=13.68, windows_measured=2, raf_p95_ms=16.8, raf_over20_per_10s=0, gpu_exec_p95_ms=5.898, hitch_gaps_over_25ms=0) [round m39y-full-pixel]

---

## M11: Boot, gestures and memory

When: M11 ticked. First time engine code runs on the phone: run the M03, M08 and M09b sections in the same sitting.

**Open** (served as above): `device.html`.

- [x] **M11-boot** (`0017` §4; `PRE-PLAN.md` §9 risk 1). *Steps:* open the URL. *Pass:* HUD shows `isolated`, an adapter, and "workers ready (posted Module)". *If it fails* with a worker error: reopen with `?module=url`; if that passes, plan edit making the URL path Safari's default (`0017` §4 fallback). M35 item (c) reads this result.
- [x] **M11-gestures** (`0019` §3). *Steps:* one-finger pan 10 s, flick, pinch to both zoom limits, tap a tile, pull down from the top edge, double-tap, rotate the phone. *Pass:* the world point stays under the finger; the flick glides and stops; the HUD shows the tapped tile; the page never scrolls, zooms or refreshes; rotation keeps the centre. *If it fails:* name the knob (inertia constant, tap thresholds, page CSS helper of `0019` §3) in a plan edit.
- [x] **M11-memory** (`0015` §5 arena sizes and whole-tab target). *Steps:* `device.html?probe=memory`. The probe (1) grows a scratch memory in 64 MiB steps to 1 GiB (allocated and written a page at a time, so the OS actually commits it, not just reserves it), (2) runs the default topology beside the WebGPU context with a scripted ~4 tiles/s pan for 2 min, (3) repeats (2) with `&touch=1`. The HUD prints each step's own progress; record all three. *Pass:* (2) and (3) finish without a reload. *If it fails:* re-run with `&sim=64&client=32` (MiB); if that survives, plan edit lowering the mobile defaults by a superseding ADR for `0015` §5. If (1) < 256 MiB, record the ceiling in the same ADR. *Known gap (M11 Deviations):* `&touch=1` re-runs the identical session rather than force-writing every arena page from main (no ABI export exists for that yet) -- if (2) passes but (3) shows a different ceiling anyway, note it, since the two runs are not yet meaningfully different.
- [x] **M11-pinch-desktop-safari** (`0019` §3, Mac). *Steps:* `device.html` in desktop Safari on the loopback URL; trackpad pinch in and out over a landmark tile. *Pass:* the zoom follows the fingers about the cursor and the page itself never zooms. *If it fails:* the `gesturechange` listener or `preventDefault` of M11's `input/wheel.ts`; the automated `camera.gesturechange_scale_zooms_about_cursor` covers only the maths.
- [ ] **M11-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All three in Chrome.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M11-boot PASS (numbers: adapter=apple/apple, delivery=posted Module); M11-gestures PASS (orchestrator from readings (driven): centre moved 0.3 px across rotation, flick glided 9.8 tiles and stopped, zoom 12-256 tiles, drift 0.016 tiles, no page scroll/zoom/reload.; numbers: tiles_min=12, tiles_max=256, flick_speed_px_ms=18.61, glide_tiles=9.84, world_point_samples=236, rotation_shift_px=0.3, centre_shift_tiles=0.004, gestures_done=7, page_reloaded=0, world_point_drift_tiles=0.016); M11-memory PASS (numbers: scratch_ceiling_mib=1024, last_line=probe=memory: complete, reloads=0); Android: not run: no device [round m39ad-iphone-driven]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores + Mac, 2026-10-07; **result:** M11-boot PASS (numbers: adapter=qualcomm/adreno-6xx, delivery=posted Module); M11-gestures FAIL (numbers: tiles_min=12, tiles_max=256, flick_speed_px_ms=7.29, glide_tiles=15.5, world_point_samples=4, rotation_shift_px=2.9, centre_shift_tiles=0.046, gestures_done=6, page_reloaded=0, world_point_drift_tiles=0.089); M11-memory PASS (numbers: scratch_ceiling_mib=1024, last_line=probe=memory: complete, reloads=0); M11-pinch-desktop-safari SKIP (a Mac browser row: it is walked in a Mac tab, which a phone round does not open (M39f delegation 5); walk it by hand with --manual) [round m39y-full-pixel]
**Run on:** Mac, 2026-10-10; **result:** M11-pinch-desktop-safari PASS; Android: not run: no device [round tyler-mac]

---

## M16: Vertical slice on the phone

When: M16 ticked (`PRE-PLAN.md` §8 item 9: first on-device run of the slice).

**Open** (served as above): `slice.html` (single-player: main + client + sim + gen, fixture `puts`; HUD fields `confirmed`, `rejected`, `ring drops`, `engine_mem_grows`, `tick`); `determinism.html` for the first item.

- [x] **M16-slice-boot**. *Steps:* re-run M03-determinism on this build, then open the slice page. *Pass:* M03's criterion; the slice page shows `isolated`, an adapter, workers ready, terrain drawn; pan and pinch behave as M11-gestures.
- [x] **M16-round-trip** (`0004`). *Steps:* tap the page's Paint control 10 times. *Pass:* HUD shows `confirmed 10`, `rejected 0`, `ring drops 0`; each result appears with no perceptible delay.
- [x] **M16-coexist** (`0015` §5 whole-tab target; `0020` §10). *Steps:* play and pan for 10 min. *Pass:* no reload, no visible hitch, `engine_mem_grows` = 0 on every instance. *If it fails:* the smaller-arena parameters of M11-memory, then the plan edit of M11-memory.
- [x] **M16-background** (`simulation.md`, idle worlds). *Steps:* another app for 30 s and return; lock the screen for 60 s and return. *Pass:* frame loop and tick loop resume without a reload; the HUD `tick` did not advance while hidden.
- [x] **M16-low-power** (`0019` Context, time-based motion). *Steps:* turn Low Power Mode on, pan and flick. *Pass:* motion speed unchanged at the halved frame rate: the scripted flick's glide distance at the halved rate is at least 0.95 and at most 1.05 of the one at the normal rate.
- [ ] **M16-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M16-coexist PASS (driverless (Tyler's QR run, no WDA/inspector): 6 gaps >25 ms in 10 min, max 28.5 ms (one missed 60 Hz frame); 0 reloads, engine memory flat. Not a visible hitch, same reading as m39v-ios-driverless-1 (11 gaps, max 58.1 ms).; numbers: raf_gap_max_ms=28.5, paints=600, reloads=0, engine_mem_grows=0, hitch_gaps_over_25ms=6); Android: not run: no device [round m39ad-iphone-qr]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M16-slice-boot PASS (orchestrator: inherits M11-gestures (pass, same round); screenshot shows slice isolated, apple adapter, workers ready, session live.); M16-round-trip PASS (numbers: confirm_latency_max_ms=48.36, confirm_latency_median_ms=31.78, confirmed=10, rejected=0, ring_drops=0); M16-background SKIP (NotDrivable: the screen is never turned off or locked on these phones (Tyler); a lock needs the passcode); Android: not run: no device [round m39ad-iphone-driven]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M16-coexist FAIL (proxy 74 rAF gaps >25 ms in 600 paints, max 54.2 ms (Pixel 0); a still cannot show no hitch. Ran before Low Power Mode was left on (green battery at 6:26), so valid: finding 5 not fixed on the iPhone by M39p's quiet windows.; numbers: raf_gap_max_ms=54.2, paints=600, reloads=0, engine_mem_grows=0, hitch_gaps_over_25ms=74); M16-low-power PASS (numbers: rafp50_normal_ms=16.7, rafp50_low_power_ms=33.4, flick_release_ratio=1, flick_distance_ratio=1.001, flick_distance_ratio_max=1.001); Android: not run: no device [round m39r-iphone]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M16-low-power PASS (numbers: rafp50_normal_ms=16.72, rafp50_low_power_ms=33.42, flick_release_ratio=1, flick_distance_ratio=1.001, flick_distance_ratio_max=1.001); Android: not run: no device [round m39u-iphone]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M16-slice-boot SKIP (inherits M11-gestures, whose fail is a driver gap (the pan swipe in landscape after M09b passed at rung 0; diagnosis test-results/m39y-pixel-fails-diagnosis.md); re-run after M39aa.); M16-round-trip PASS (numbers: confirm_latency_max_ms=50.525, confirm_latency_median_ms=49.965, confirmed=10, rejected=0, ring_drops=0); M16-coexist PASS (numbers: raf_gap_max_ms=16.9, paints=600, reloads=0, engine_mem_grows=0, hitch_gaps_over_25ms=0); M16-background SKIP (NotDrivable: the screen is never turned off or locked on these phones (Tyler); a lock needs the passcode); M16-low-power SKIP (NotDrivable: Battery Saver does not engage while the Pixel is charging (low_power flips, the system keeps it off); faking a battery unplug turns the screen off and is not allowed) [round m39y-full-pixel]
**Run on:** iPhone (model not recorded), 2026-10-10; **result:** M16-background PASS; Android: not run: no device [round tyler-phone]

---

## M17b: Desktop Safari and Firefox harness run

When: M17b ticked. On the Mac, not the phone. Closes the deferral of `0018` Consequences (the CDP instrument of `0016` is Chromium-only).

**Open:** `pnpm device:serve` (no tunnel), then the loopback URL + `device.html?harness=1`, in Safari current and in Firefox current.

- [x] **M17b-harness-desktop-safari**. *Steps:* Web Inspector → Timelines → JavaScript Allocations, record, press "run" on the page, stop after it prints. *Pass:* the page prints no GPU error and unchanged memory sizes; over the 600 frames the allocation timeline grows by no more than the main-thread budget of `0016` × 600 (about 70 KB) and shows 0 GC pause markers. *If it fails:* validation error on a SAB-backed upload → make M09's staged-copy path the default for that browser. Visible periodic GC → capture the allocation call tree; plan edit naming the site. Probe differences are recorded only.
- [x] **M17b-harness-desktop-firefox**. *Steps:* Profiler with "JS Allocations" enabled, same sequence. *Pass / If it fails:* as above.

**Run on:** Mac, 2026-10-07; **result:** M17b-harness-desktop-safari SKIP (a Mac browser row: it is walked in a Mac tab, which a phone round does not open (M39f delegation 5); walk it by hand with --manual); M17b-harness-desktop-firefox SKIP (a Mac browser row: it is walked in a Mac tab, which a phone round does not open (M39f delegation 5); walk it by hand with --manual) [round m39y-full-pixel]
**Run on:** Mac, 2026-10-10; **result:** M17b-harness-desktop-safari PASS; M17b-harness-desktop-firefox PASS [round tyler-mac]

---

## M18: Picking and overlay anchoring

When: M18 ticked. Closes the deferred item of `0019` Consequences, which combines it with the fill-rate check of `0018`.

**Open** (served as above): `device.html?anchors=50` (a real, connected `fx-overlay` client, not the M09b/M17b terrain scene: 50 small text buttons, each `client.overlay.anchor`-ed to the exact world tile one of `extract()`'s own 50 pickable rings sits at; 4 markers, each `client.overlay.anchorSlot`-ed to one of `extract()`'s own `DrawList::anchor`-published circles orbiting the origin; a cursor-anchored ghost tracks the mouse/last tap). `&anchorMode=translate` switches the fallback per-anchor `translate()` mechanism on (default: the custom-property mechanism). HUD fields: `isolated`, `adapter.info`, `camera` (`tilesAcross`, `centre`), `pick_id` (the last canvas tap's `pick_id`, `-` on a miss or before any tap; unchanged by a tap on a button), `rAF interval p50/p95/worst`, `rAF intervals >20ms`, `GPU latency p95`, `frames rendered` -- the same fields `M09b-fill-rate` reports, so the same pass criteria apply directly on this page.

- [x] **M18-anchors** (`0019` Consequences). *Steps:* pan slowly, flick, then pinch in and out continuously for 30 s; repeat in landscape. *Pass:* every button stays centred on its ring and every marker stays on its moving circle (zero swim, no lag or jitter); text crisp at every zoom; buttons respond to taps without moving the camera; HUD rAF p95 ≤ 17.5 ms during the pinch. *If it fails:* reopen with `&anchorMode=translate` (the fallback `0019` Consequences states). If that passes: plan edit making `translate` the default on iOS (everywhere if desktop cost is equal), a superseding ADR for `0019`, and a note against the overlay line of `0016`. If both fail: screen capture and a plan edit; what remains is in-canvas drawables for anything that must not swim.
- [x] **M18-fill-rate-with-anchors**. *Steps:* on the same `device.html?anchors=50` page (this milestone's own fixture, not `fx-terrain`, so "M09b-fill-rate with anchors added" is this page directly, not a URL combination), portrait 60 s then landscape 60 s, panning/pinching continuously; copy the HUD numbers. *Pass / If it fails:* as `M09b-fill-rate` (rAF interval p95 ≤ 17.5 ms; intervals > 20 ms ≤ 5 per 10 s; GPU execution p95 ≤ 6 ms (timestamp queries, `gpu_exec_p95_ms`; M39k); no visible hitch), reopening with `&anchorMode=translate` first if it fails (this section's own fallback) before `M09b-fill-rate`'s own `&scaleCap`/`&cutoff` ladder.
- [x] **M18-pick** (`0019` §4). *Steps:* at three zoom levels (`&tiles=`), tap several rings (small and, near the grid's own 3-tile spacing, close together) and a button. *Pass:* the HUD's `pick_id` reports the topmost ring's id every time (0 misses); a tap on a button leaves `pick_id` unchanged (never reaches the canvas).
- [x] **M18-touch-ghost** (`0019` §4, cursor tile and ghost). *Steps:* tap to move the cursor tile, then drag. *Pass:* the ghost (a translucent square, `extract()`'s own `ANCHOR_CURSOR_TILE` draw) sits on the tapped tile; the drag pans.
- [ ] **M18-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M18-anchors PASS (orchestrator from screenshots at two zooms: labels crisp and on their tiles; anchor_max_error 0.016 px, jitter 0.014 px over 1797 frames.; numbers: anchor_jitter_px=0.014, anchor_probe_frames=1797, anchor_max_error_px=0.016, raf_p95_ms=17.12); M18-fill-rate-with-anchors PASS (numbers: raf_gap_max_ms=21, frames=7182, raf_p50_ms=16.7, gpu_exec_p50_ms=0.604, gpu_latency_p95_ms=4.48, windows_measured=2, raf_p95_ms=17.04, raf_over20_per_10s=1, gpu_exec_p95_ms=0.67, hitch_gaps_over_25ms=0); M18-touch-ghost FAIL; Android: not run: no device [round m39ad-iphone-driven]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M18-pick PASS (numbers: rings_tapped=8, pick_misses=0); Android: not run: no device [round m39r-iphone]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M18-anchors PASS (screenshot: labels 1-20 crisp on their anchors; anchor_max_error_px 0.511, rAF p95 16.77 (a still cannot show swim; the measured error is sub-pixel).; numbers: anchor_jitter_px=0.451, anchor_probe_frames=1796, anchor_max_error_px=0.511, raf_p95_ms=16.77); M18-fill-rate-with-anchors PASS (numbers: raf_gap_max_ms=17, frames=7181, raf_p50_ms=16.7, gpu_exec_p50_ms=1.835, gpu_latency_p95_ms=16.085, windows_measured=2, raf_p95_ms=16.77, raf_over20_per_10s=0, gpu_exec_p95_ms=2.228, hitch_gaps_over_25ms=0); M18-pick PASS (numbers: rings_tapped=8, pick_misses=0); M18-touch-ghost PASS (numbers: ghost_tile=tapped tile 0,-1; ghost anchored to 0,-1) [round m39y-full-pixel]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-09; **result:** M18-fill-rate-with-anchors PASS (numbers: raf_gap_max_ms=20.7, frames=7185, raf_p50_ms=16.7, gpu_exec_p50_ms=0.601, gpu_latency_p95_ms=4.22, windows_measured=2, raf_p95_ms=17.16, raf_over20_per_10s=1, gpu_exec_p95_ms=0.668, hitch_gaps_over_25ms=0); M18-touch-ghost PASS (numbers: ghost_tile=tapped tile 0,-1; ghost anchored to 0,-1); Android: not run: no device [round m39af-proof]

---

## M23: OPFS and world lifecycle

When: M23 ticked. Closes the deferred OPFS latency item of `0005` Consequences; it tunes only the log `sync` interval.

**Open** (served as above): `opfs-latency.html` (a worker runs 1,200 appends of 64 B with a `flush()`
every 20th, then 20 scratch writes of 1 MiB and 10 of 8 MiB each with its own `flush()`, then prints a
p50/p95/max table for `append`/`flush`/`scratch 1 MiB`/`scratch 8 MiB` plus `move()`/
`navigator.locks` availability booleans); then `world.html` (fixture `puts` with persistence on;
`?world=<id>`, default `device`; HUD shows `world`, `worldBusy`, `loadFailed`, `hash`, `tick`,
`durable`, `persisted`, `usage`, `quota` -- `hash`/`tick` refresh only on a discrete event, page load
or a Paint tap, never on a timer, so a step that needs a fresh reading taps Paint first; Export,
Import (a file picker plus a new-id field) and Delete buttons over `client.exportWorld`/
`importWorld`/`deleteWorld`; Export triggers a real file download named `<worldId>.world`).

- [x] **M23-opfs-latency** (`0005` Consequences). *Steps:* run the latency page; copy the whole
  printed table. *Pass:* `flush` p95 ≤ 10 ms, the keep band of [M23's brief](23-persistence-opfs-and-lifecycle.md),
  Planning decision 7, which owns the bands. *If it fails:* apply that decision's retune rule; any
  change is a new ADR superseding the number in `0005`. `move()` missing → slot files, M23 Planning
  decision 3.
- [x] **M23-kill-resume** (`0005` loss windows). *Steps:* play 2 min, swipe-kill Safari, reopen.
  *Pass:* the world resumes; 0 admitted actions lost.
- [x] **M23-world-busy**. *Steps:* open the same world in a second tab. *Pass:* the second tab shows
  the `WorldBusy` banner; the first keeps playing.
- [x] **M23-private**. *Steps:* open the page in Private Browsing. *Pass:* the HUD reports
  `durable: false` and the world still plays.
- [x] **M23-hidden-pause**. *Steps:* tap Paint once (a fresh `tick` reading), background 30 s,
  foreground, tap Paint again. *Pass:* the second `tick` reading is only a few ticks past the first
  (not ~600, the 30 s-at-20-Hz a still-running world would rack up) and `durable` stays `true`; no
  reload. *Why tap Paint, not just read the HUD:* `hash`/`tick` refresh only on that discrete event
  (Deviations, steps 3-4 of [M23's brief](23-persistence-opfs-and-lifecycle.md)), never on a timer, so
  the number sitting on screen while backgrounded proves nothing on its own about whether ticking
  actually stopped.
- [ ] **M23-export-import**. *Steps:* tap Export (a `<worldId>.world` file download; confirm it
  arrives in Files); note the HUD `hash`. Reload the page (or open a second tab) with a fresh
  `?world=<other-id>`, choose the downloaded file in the Import file picker, type the new id, tap
  Import; then open `world.html?world=<other-id>` directly. *Pass:* the new world's own HUD `hash`
  (after a Paint tap, to force a fresh reading) equals the exported world's `hash`.
- [ ] **M23-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M23-opfs-latency PASS (numbers: append_p95_ms=0.02, scratch_1mib_p95_ms=2.32, scratch_8mib_p95_ms=8.3, move_available=true, locks_available=true, flush_p95_ms=0.1); M23-kill-resume PASS (numbers: admitted_before=88, tick_before=2452, tick_last_action=2402, tick_after=2433, admitted_actions_lost=0); M23-world-busy SKIP (NotDrivable: coming back to the first tab needs Safari's tab switcher: not driven yet); M23-private SKIP (NotDrivable: Safari's Private mode is the tab switcher's UI: not driven yet); M23-hidden-pause PASS (orchestrator from readings: hidden 30.2 s, tick_delta 60 (not ~600), durable, 0 reloads; same as earlier rounds.; numbers: hidden_ms=30234, tick_delta=60, reloads=0); M23-export-import SKIP (NotDrivable: the export lands in Downloads and the import needs the system file picker; not driven yet); Android: not run: no device [round m39ad-iphone-driven]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M23-opfs-latency PASS (numbers: append_p95_ms=0.035, scratch_1mib_p95_ms=4.64, scratch_8mib_p95_ms=39.235, move_available=true, locks_available=true, flush_p95_ms=0.255); M23-kill-resume PASS (numbers: admitted_before=81, tick_before=2452, tick_last_action=2402, tick_after=2433, admitted_actions_lost=0); M23-world-busy PASS (numbers: first_tick_delta=20); M23-private SKIP (NotDrivable: Chrome ignores the incognito flag of an intent sent from adb (only Chrome itself may open an Incognito tab by intent)); M23-hidden-pause PASS (tick_delta 40 across the hide (a few, not about 600); durable, reloads 0.; numbers: hidden_ms=30115, tick_delta=40, reloads=0); M23-export-import SKIP (NotDrivable: the export lands in Downloads and the import needs the system file picker; not driven yet) [round m39y-full-pixel]
**Run on:** iPhone (model not recorded), 2026-10-10; **result:** M23-world-busy PASS; M23-private PASS; M23-export-import FAIL ("a world already exists at id device" Also note that I can't see any fucking world in these tests guy what the fuck); Android: not run: no device [round tyler-phone]

---

## M29: Net worker and reconnect

When: M29 ticked. Closes the iOS worker-socket resume item (`PRE-PLAN.md` §10; `0013` Consequences); it tunes only the dead timeout and the probe deadline of `0013`.

**Open:** on the Mac `pnpm device:serve --tunnel --ws puts` (starts the real-time server and proxies `/ws`); on the phone `mp.html?linklog=1` on the printed URL.

- [ ] **M29-socket-resume** (`0013` Client policy). *Steps:* three runs each of: another app 5 s; 30 s; 5 min; screen lock 60 s; Wi-Fi → cellular in the foreground; airplane mode 15 s. Per run copy from the on-page link log: `close` delivered (ms after `visible`) or silence; ms from `visible` to `Welcome`; page discarded or not. *Pass:* `visible → Welcome` median ≤ 1.5 s and max ≤ 4 s: keep the `0013` numbers. *If it fails:* silence with median > 2 s → lower the probe deadline toward one heartbeat interval plus margin; prompt `close` everywhere → numbers stay, note it. Any change is a new ADR amending `0013` Client policy.
- [ ] **M29-play-through-drop** (`0013` Client policy). *Steps:* keep panning during each drop above. *Pass:* the game stays interactive on last known state; the indicator appears only after the delay `0013` states; no modal for short outages.
- [x] **M29-net-heap** (`0015` §2, `0016`). *Steps:* 10 min connected with steady traffic. *Pass:* no visible periodic hitch (the net worker's garbage stays off the main thread).
- [ ] **M29-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M29-socket-resume SKIP (NotDrivable: the screen is never turned off or locked on these phones (Tyler); a lock needs the passcode); M29-play-through-drop SKIP (NotDrivable: the screen is never turned off or locked on these phones (Tyler); a lock needs the passcode); Android: not run: no device [round m39ad-iphone-driven]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M29-net-heap SKIP (invalid run: Low Power Mode left on by the driver after M16-low-power (yellow battery in the screenshot); 17977 of ~36000 frames over 25 ms is the 30 Hz Low Power cap. Driver defect, re-run owed after the fix.; numbers: raf_gap_max_ms=47.2, paints=2400, reloads=0, hitch_gaps_over_25ms=17977); Android: not run: no device [round m39r-iphone]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M29-net-heap PASS (10 min, 35,985 frames, rAF p50 16.7 / p95 17, reloads 0. 9 gaps >25 ms: 7 are 25-29 ms jitter (finding 5 family), 2 single dropped frames (50.2, 52.4 ms). They come in pairs ~32 s apart, pairs ~130 s apart (158/190, 285/317, 419/456, 557/588 s): a weak quasi-period for M39v's attribution, not a visible periodic hitch. Low Power was off (M39u).; numbers: raf_gap_max_ms=52.4, paints=2400, reloads=0, hitch_gaps_over_25ms=9); Android: not run: no device [round m39u-iphone]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M29-socket-resume SKIP (0 runs measured: the drive loop's watchdog (15bd65e) reopened the page during the 300 s leave, and the new page's prompt was deduplicated, so nothing answered it. Driver regression, re-run after M39aa.; numbers: runs=0, discarded_runs=false, survived_runs=false); M29-play-through-drop FAIL (the same runs as M29-socket-resume); M29-net-heap PASS (numbers: raf_gap_max_ms=16.9, paints=2400, reloads=0, hitch_gaps_over_25ms=0) [round m39y-full-pixel]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M29-net-heap PASS (driverless (--open ios, no WDA, no person): 4 gaps >25 ms in 10 min, max 25.9 ms (just over one 60 Hz frame), 2400 confirmed, 0 rejected, 0 reloads; not a visible periodic hitch, same reading as m39ad M16-coexist and m39v-ios-driverless-1.; numbers: raf_gap_max_ms=25.9, paints=2400, reloads=0, hitch_gaps_over_25ms=4); Android: not run: no device [round m39ad-iphone-qr]
**Run on:** iPhone (model not recorded), 2026-10-10; **result:** M29-socket-resume FAIL (didn't load at all...); M29-play-through-drop FAIL (also didn't load); Android: not run: no device [round tyler-phone]

---

## M34: Reference multiplayer on real devices

When: M34 ticked. Holds the item M26 owns (own-timer feel) and the item M30 owns (remote motion).

**Open:** on the Mac `pnpm device:serve --tunnel --app reference --ws`; the reference game on the phone on the printed URL, joined through the invite link; the same world in desktop Chrome on the Mac.

- [x] **M34-two-devices**. *Steps:* phone and Mac join one LAN world; collect on one, place on the other. *Pass:* each sees the other's circle and changes; roster dots go hollow after a disconnect plus the grace of `0013` and fill on return.
- [x] **M34-own-timer-bar** (`0012` completion gap; owner [M26's brief](26-prediction-rendering-and-clocks.md), Planning decisions). The rule is decided: stretch over `duration + lead` (Q10). *Steps:* start own timers on Wi-Fi, then on a throttled or cellular link. *Pass:* each bar starts at the tap and reaches full as the result arrives, with no full bar left waiting and no result before the bar is full. *If it fails:* a bar that waits or overshoots is a lead-estimate or `own_progress` bug: record RTT and the gap, fix under M26.
- [x] **M34-remote-motion** (`0012` "Remote motion"; owner M30). *Steps:* move on the Mac and watch the phone; then close the Mac's page. *Pass:* the remote circle moves without snapping: while it moves its drawn position changes on at least 0.9 of the frames and is never still for more than 50 ms, and it never steps back against its walking direction by more than 0.15 tiles; when its player leaves it disappears within 1000 ms (`0013`: presence vanishes at once on a clean close; the fade of `0012` is for a stalled link). *If it fails:* plan edit against M30's adaptive delay.
- [ ] **M34-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M34-own-timer-bar SKIP (NotDrivable: the iPhone has no SIM, so there is no cellular to move to: Wi-Fi off is no network at all); Android: not run: no device [round m39ad-iphone-driven]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M34-two-devices PASS (screenshot: remote purple circle beside the furnace, both roster dots; all auto criteria pass. Ran with Low Power Mode left on (yellow battery), which does not affect these criteria.; numbers: bot_roster_n=2, hollow_after_ms=10406, remote_entity_seen=1, furnace_seen=1, sees_its_circle=1); M34-remote-motion FAIL (numbers: max_jump_tiles=0.98, travel_tiles=42.662, frames=336, moving_frames_changed_ratio=0.983, max_still_ms=134, repeated_frames=24, vanish_ms=203, fade_missing=1, fade_min_alpha=255, remote_moved=42.662, snaps=3, vanished_at_once=203, no_snap_and_fades=0.98); Android: not run: no device [round m39r-iphone]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M34-remote-motion NOT APPLIED (wrong pass: the backward lurch M39ab fixed, M39l Deviations; owed driverless) (written criteria pass: changed on 0.991 of moving frames, max still 17 ms, vanished in 215 ms. Proxy: 12 snaps, max jump 0.707 tiles (the Pixel's passing m39n-pixel-2: 3 snaps, max 0.851). The extra snaps follow repeated frames (79 vs Pixel 21): catch-up after a repeated frame, the finding-5 display jitter (M39v), not remote motion. Low Power was off (M39u).; numbers: max_jump_tiles=0.707, travel_tiles=42.586, frames=622, moving_frames_changed_ratio=0.991, max_still_ms=17, repeated_frames=79, vanish_ms=215, fade_missing=1, fade_min_alpha=255, remote_moved=42.586, snaps=12, vanished_at_once=215, no_snap_and_fades=0.707); Android: not run: no device [round m39u-iphone]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M34-two-devices PASS (screenshot: the remote's purple circle drawn by the furnace; all auto criteria pass (bot_sees_phone, roster dot hollow then filled). A Teams notification covered the top bar, which is irrelevant here.; numbers: bot_roster_n=2, hollow_after_ms=10225, remote_entity_seen=1, furnace_seen=1, sees_its_circle=1); M34-own-timer-bar SKIP (NotDrivable: switching the Pixel from Wi-Fi to cellular (`svc wifi disable`, `svc data enable`) is not built yet; over adb reverse the Wi-Fi state would change nothing the page sees); M34-remote-motion FAIL (numbers: max_jump_tiles=64, travel_tiles=106.714, frames=683, moving_frames_changed_ratio=0.975, max_still_ms=167, repeated_frames=10, vanish_ms=184, fade_missing=1, fade_min_alpha=255, remote_moved=106.714, snaps=2, vanished_at_once=184, no_snap_and_fades=64) [round m39y-full-pixel]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M34-remote-motion PASS (driverless (--open ios, no WDA, no person), after M39ab: max_backstep_tiles 0 (the lurch is gone), 2 snaps, max jump 0.574 tiles (the Pixel's passing m39n-pixel-2: 3 snaps, 0.851), changed on 0.989 of moving frames, max still 17 ms, vanished at once in 217 ms. No snap a person would see.; numbers: max_jump_tiles=0.574, travel_tiles=41.622, frames=622, moving_frames_changed_ratio=0.989, max_still_ms=17, max_backstep_tiles=0, repeated_frames=78, vanish_ms=217, fade_missing=1, fade_min_alpha=255, remote_moved=41.622, snaps=2, vanished_at_once=217, no_snap_and_fades=0.574); Android: not run: no device [round m39ad-iphone-qr]
**Run on:** iPhone (model not recorded), 2026-10-10; **result:** M34-own-timer-bar PASS; Android: not run: no device [round tyler-phone]

---

## M35: Built reference game in real Safari

When: M35 ticked.

**Open:** the `vite build` + `vite preview` output of `games/reference` (`pnpm device:serve --app reference`): on the Mac over loopback; on the iPhone with `--tunnel`.

- [x] **M35-safari-build-mac** (`0017` §4). *Steps:* load in desktop Safari. *Pass:* the game plays. M35 built item (c)'s automatic fallback (a refused posted `Module` re-sends setup with the `.wasm` URL), so either delivery passes, and the reference game shows no delivery line. *If it fails:* a defect (the fallback did not engage, or something else broke); note the page's error text and the Web Inspector console.
- [x] **M35-safari-build-iphone**. Same on the iPhone. *Pass / If it fails:* as above.
- [ ] **M35-capability** (`0018` §7). *Steps:* open the game in a browser with no `navigator.gpu` (for example Safari with the WebGPU feature flag off). *Pass:* the capability screen appears with `no-webgpu`; no blank page.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M35-safari-build-iphone PASS (orchestrator from screenshot: reference game world drawn with HUD; 0 GPU errors, 0 device lost, rAF p95 17.2 ms.; numbers: canvas_w=1688, canvas_h=780, raf_p50_ms=16.7, raf_p95_ms=17.2, raf_gap_max_ms=21.6, raf_gaps_over_25ms=0, gpu_errors=0, device_lost=0, reloads=0, world_drawn=1688) [round m39ad-iphone-driven]
**Run on:** Mac + Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M35-safari-build-mac SKIP (a Mac browser row: it is walked in a Mac tab, which a phone round does not open (M39f delegation 5); walk it by hand with --manual); M35-safari-build-iphone PASS (screenshot: the reference world is drawn and playable (world_drawn 785), no capability or fatal screen, 0 GPU errors.; numbers: canvas_w=785, canvas_h=1603, raf_p50_ms=16.7, raf_p95_ms=16.76, raf_gap_max_ms=16.8, raf_gaps_over_25ms=0, gpu_errors=0, device_lost=0, reloads=0, world_drawn=785); M35-capability SKIP (retired from the device list: covered by capability.spec.ts (Tyler 2026-10-03: retired from the device list)) [round m39y-full-pixel]
**Run on:** Mac, 2026-10-10; **result:** M35-safari-build-mac PASS [round tyler-mac]

---

## M37b: Renderer recovery after backgrounding

When: M37 ticked (the `rendererLost` prompt is M37's `status.ts`; M37b builds the recovery).

**Open:** the reference game on the iPhone (`pnpm device:serve --tunnel --app reference`).

- [x] **M37b-ios-background** (`0018` §8). *Steps:* play; background the tab for several minutes under memory pressure (camera app, a few heavy pages); return. Three runs. *Pass:* every run ends with the world drawn again without a reload, or with the `rendererLost` prompt; 0 frozen or black canvases. *If it fails:* record which; plan edit against the device-loss sequence of `0018` §8.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M37b-ios-background PASS (orchestrator from readings and screenshot: all 3 memory-pressure backgroundings drawn again (frames resumed, no renderer-lost banner, device lost 0), 0 reloads.; numbers: device_lost_total=0, uncaptured_errors_total=0, renderer_lost_banners=0, leave_ms_min=179455, runs_done=3, reloads=0) [round m39ad-iphone-driven]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M37b-ios-background PASS (3 of 3 runs drawn again (frames resumed, canvas present, no renderer-lost banner, device lost 0); the screenshot shows the world after run 3.; numbers: device_lost_total=0, uncaptured_errors_total=0, renderer_lost_banners=0, leave_ms_min=180139, runs_done=3, reloads=0) [round m39y-full-pixel]

---

## M38: Hosted deployment

When: M38 ticked. Q6: the Workers plan and the Fly machine are approved; the Cloudflare Pages deploy is not, so there is no static host. The Fly machine serves the client (`games/reference-server --static`, which sets COOP/COEP on every response) and `/ws` on one origin (M38's brief, Scope B).

**Not checked here, carried forward:** the COOP/COEP listings of `0015` §3 on a real static host, and a cross-origin `wss`. Unverified; open item in [M39b](39b-phase-4-handoff.md).

**Open:** the Fly URL on the iPhone, **on cellular** (Wi-Fi off); add `?linklog=1` for M38-socket-resume (the hosted build's link log, M38's brief, Planning decisions). No local serving.

- [x] **M38-hosted-boot** (COOP/COEP from the reference server's static handler on a real deployment; same-origin `wss`). *Steps:* open the URL. *Pass:* the page is cross-origin isolated, gets an adapter, and reaches `online` on the same Fly origin, including the first load that wakes a stopped machine. *If it fails:* compare with `scripts/check-coi.mjs <url>`; plan edit against the `--static` handler or the Fly recipe.
- [ ] **M38-socket-resume**. *Steps:* with `?linklog=1`, each step of M29-socket-resume once over the real network; record `visible → Welcome` from the on-page log. *Pass / If it fails:* as M29-socket-resume.
- [ ] **M38-remote-motion**. *Steps:* M34-remote-motion with the phone on cellular and the Mac on Wi-Fi. *Pass / If it fails:* as M34-remote-motion.
- First dial to a stopped machine may show `reconnecting` for about 1 s; an error screen is a failure.

**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores, 2026-10-07; **result:** M38-hosted-boot SKIP (not automated yet (M39f delegation 4): walk it by hand with --manual); M38-socket-resume SKIP (not automated yet (M39f delegation 4): walk it by hand with --manual); M38-remote-motion SKIP (not automated yet (M39f delegation 4): walk it by hand with --manual) [round m39y-full-pixel]
**Run on:** iPhone 12 (Safari Private tab) iOS 18.7, 2026-10-10; **result:** M38-hosted-boot PASS (Tyler, in session: https://engine-v2-ref.fly.dev loads and plays on the iPhone and the Mac (deploy of f335a460, after a stopped machine woke); deployed/coi-and-online green the same hour) [round tyler-hosted-2026-10-10]

---

## M39: Acceptance

When: last. On the final build, after every other section has a result line. M39 re-runs rather than trusting old ticks (M39's brief, Planning decisions).

**Open:** the reference game: single-player, then through `games/reference-server`, then the hosted deployment of M38; the fixture pages served as above for the re-run.

- [ ] **M39-rerun**. *Steps:* untick and re-run every item of every section above on the final build. *Pass:* each item's own criterion; every section gets a new **Run on** line.
- [x] **M39-large-save** (`0007` §8; handed over by M07, Planning decision 11; `?bench=large-save[&scale=n][&pan=tiles/s]` from M36, bench build only). *Steps:* load the standard large save on the iPhone in single-player; play 10 min; read the HUD (`#bench-hud`: `engine_mem_grows: sim n, client n`, `tick`, `main p95`, `frame p95`, `tick p95`) **after at least 10 s** (`tick p95` is inflated early: the first tick visits all 262,144 furnaces). *Pass:* `engine_mem_grows` = 0 (sim and client), no tab reload, and the bench HUD's `tick p95` on the iPhone 12 is at or under the phone sim-worker figure of the Tick time row (`PRE-PLAN.md` §7; owner `0010`); on Android the `tick p95` is reported, not judged (`0056`). *If it fails* on memory: decide which default drops first (`0007` §8: entities are the memory problem), by ADR; on tick time: plan edit against M36's tick benchmark, or an ADR changing the number.
- [x] **M39-frame-shares** (`PRE-PLAN.md` §7 Frame time row, baseline-phone shares; owner `0018` §9). *Steps:* on the same `?bench=large-save` page, zoom out fully over the dense base and pan slowly for 60 s; copy the bench HUD (after the first 10 s; `?pan=` sets a steady pan, desktop proxy numbers: main p95 0.10 ms, frame p95 0.23 ms). *Pass:* `main p95` and `frame p95` are each at or under that row's phone figure for the main rAF callback and the client-worker `frame` (the GPU share is M09b-fill-rate's). *If it fails:* run the `profile-frame` skill on the desktop proxy for the same view; plan edit against the share that missed.
- [x] **M39-full-game-touch**. *Steps:* play the script of `34b-reference-scripted-single-player.md` by hand: spawn, mine to the unlock, craft, place with tap-then-confirm, pick the empty furnace up and place it again, fuel, smelt, take. *Pass:* every step works by touch; buttons and the furnace panel stay glued to their tiles; 10 min with no reload and no visible hitch.
- [x] **M39-two-devices**. *Steps:* phone and Mac in one hosted world (LAN world if M38 was not run). *Pass:* each sees the other's circle move smoothly; roster dots follow a disconnect after the grace and the return; a furnace placed on one appears on the other.
- [ ] **M39-desktop-browsers**. *Steps:* desktop Safari and Firefox on the Mac, 5 min of play each. *Pass:* 0 validation errors in the console; no periodic hitch.
- [ ] **M39-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. M39-full-game-touch and M39-two-devices in Chrome.
- [x] **M39-sign-off**. *Steps:* Tyler plays the reference game from start to furnace output, single-player and with a second player. *Pass:* Tyler signs off. *If it fails:* each objection becomes a plan edit.

**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-08; **result:** M39-large-save FAIL (numbers: tick_p95_ms_last=10.9, main_p95_ms_last=0.36, frame_p95_ms_last=1.32, ticks=36002, raf_gap_max_ms=35.6, tick_p50_ms_median=9.28, sim_tick_p50_ms_median=8.24, sim_tick_p95_ms_max=10.74, seal_p95_ms_max=0.02, frame_build_p95_ms_max=1.28, resync_p95_ms_max=0.1, catchup_ticks_per_10s_max=0, tick_missed_last=1, engine_mem_grows_sim=0, engine_mem_grows_client=0, reloads=0, tick_p95_ms=11.82); M39-frame-shares PASS (numbers: main_p95_ms_last=0.28, frame_p95_ms_last=1.38, tick_p95_ms=11.12, raf_gap_max_ms=24.9, main_p95_ms=0.3, frame_p95_ms=1.38, reloads=0); Android: not run: no device; **sign-off:** <Tyler, date>  [round m39ad-iphone-driven]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M39-large-save FAIL (numbers: tick_p95_ms_last=12.94, main_p95_ms_last=0.42, frame_p95_ms_last=2.52, ticks=36001, raf_gap_max_ms=48.6, tick_p50_ms_median=10.76, sim_tick_p50_ms_median=9.4, sim_tick_p95_ms_max=12.4, seal_p95_ms_max=0.02, frame_build_p95_ms_max=1.72, resync_p95_ms_max=0.12, catchup_ticks_per_10s_max=0, engine_mem_grows_sim=0, engine_mem_grows_client=0, reloads=0, tick_p95_ms=13.86); Android: not run: no device [round m39r-iphone]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-07; **result:** M39-large-save FAIL (numbers: tick_p95_ms_last=11.26, main_p95_ms_last=0.28, frame_p95_ms_last=1.56, ticks=36002, raf_gap_max_ms=21.5, tick_p50_ms_median=9.8, sim_tick_p50_ms_median=8.64, sim_tick_p95_ms_max=10.2, seal_p95_ms_max=0.02, frame_build_p95_ms_max=1.62, resync_p95_ms_max=0.2, catchup_ticks_per_10s_max=0, engine_mem_grows_sim=0, engine_mem_grows_client=0, reloads=0, tick_p95_ms=11.48); Android: not run: no device [round m39u-iphone]
**Run on:** Android, Android 10, Chrome 154.0.0.0, adapter qualcomm/adreno-6xx, 8 cores + Mac, 2026-10-07; **result:** M39-large-save FAIL (numbers: tick_p95_ms_last=26.36, main_p95_ms_last=0.91, frame_p95_ms_last=4.99, ticks=36001, raf_gap_max_ms=33.5, tick_p50_ms_median=11.655, sim_tick_p50_ms_median=10.42, sim_tick_p95_ms_max=23.84, seal_p95_ms_max=0.03, frame_build_p95_ms_max=3.485, resync_p95_ms_max=0.195, catchup_ticks_per_10s_max=0, tick_missed_last=12, engine_mem_grows_sim=0, engine_mem_grows_client=0, reloads=0, tick_p95_ms=27.075); M39-frame-shares PASS (numbers: main_p95_ms_last=0.965, frame_p95_ms_last=4.56, tick_p95_ms=26.75, raf_gap_max_ms=16.9, main_p95_ms=0.965, frame_p95_ms=4.65, reloads=0); M39-full-game-touch SKIP (not automated yet (M39f delegation 4): walk it by hand with --manual); M39-two-devices SKIP (not automated yet (M39f delegation 4): walk it by hand with --manual); M39-desktop-browsers SKIP (a Mac browser row: it is walked in a Mac tab, which a phone round does not open (M39f delegation 5); walk it by hand with --manual); M39-sign-off SKIP (not automated yet (M39f delegation 4): walk it by hand with --manual) [round m39y-full-pixel]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-09; **result:** M39-large-save FAIL (numbers: tick_p95_ms_last=9.98, main_p95_ms_last=0.38, frame_p95_ms_last=1.86, ticks=36003, raf_gap_max_ms=35.6, tick_p50_ms_median=8.4, sim_tick_p50_ms_median=7.08, sim_tick_p95_ms_max=8.7, seal_p95_ms_max=0.02, frame_build_p95_ms_max=1.68, resync_p95_ms_max=0.14, catchup_ticks_per_10s_max=0, tick_period_last=20, tick_missed_last=0, engine_mem_grows_sim=0, engine_mem_grows_client=0, reloads=0, tick_p95_ms=10.32); Android: not run: no device [round m39ae-iphone-large-save]
**Run on:** iPhone, iOS 18.7, Safari 27.0.1, adapter apple/apple, 4 cores, 2026-10-09; **result:** M39-large-save PASS (numbers: tick_p95_ms_last=8.98, main_p95_ms_last=0.4, frame_p95_ms_last=2.44, ticks=36008, raf_gap_max_ms=94.3, tick_p50_ms_median=7.16, sim_tick_p50_ms_median=6.34, sim_tick_p95_ms_max=8.54, seal_p95_ms_max=0.02, frame_build_p95_ms_max=1.16, resync_p95_ms_max=0.1, catchup_ticks_per_10s_max=0, tick_period_last=20, tick_missed_last=0, engine_mem_grows_sim=0, engine_mem_grows_client=0, reloads=0, tick_p95_ms=9.34); Android: not run: no device [round m39ag-iphone-large-save]
**Run on:** iPhone 12 (Safari Private tab) iOS 18.7, 2026-10-10; **result:** M39-two-devices PASS (Tyler, in session: iPhone + Mac on https://engine-v2-ref.fly.dev/#k= see each other’s circles move and the roster follows (Tyler: "that works"); the furnace part was offered as optional and not confirmed: automated by reference_shared_world; the bare URL without #k= is single-player by design, which first looked like a failure); Android: not run: no device [round tyler-hosted-2026-10-10]
**Run on:** iPhone 12 iOS 18.7, 2026-10-10; **result:** M39-full-game-touch PASS (Tyler, in session ("all that looks good"): the 34b script by touch on https://engine-v2-ref.fly.dev (single-player, deploy of f335a460 with M39aj zoom fixes)); M39-sign-off PASS (Tyler signs off (2026-10-10): single-player and with a second player on the #k= link. Declined making the bare hosted URL join the shared world (keep: no #k= means a local world)); Android: not run: no device [round tyler-play-2026-10-10]
