---
name: device-check
description: The manual device checklist -- every on-hardware check (iPhone 12 Safari, Pixel 5 Chrome, desktop Safari and Firefox on the Mac) with its page, steps, pass criteria and what to do on failure. Use when a change touches something only a real phone can show (WebGPU frame pacing, gestures, OPFS, backgrounding, reconnect, hosted COOP/COEP, memory), when asked to run or re-run the device checks, or to walk one check by hand.
---

# device-check

What automation cannot prove (ADR 0020 section 10; the Phase 1 risk that the engine only works on desktop): checks on real hardware. This file is the whole checklist and is walkable by hand. Item ids (`M03-determinism` etc.) are stable names: results and commit messages cite them.

A failed check does not block unrelated work. It becomes a fix or a plan change; where an ADR's number changes, write a superseding ADR (`write-adr` skill). Never retry an item to turn a fail into a pass: record the fail, then re-run after a fix.

## Devices

- **iPhone:** an iPhone 12 (12-class or newer), iOS 18.7 or newer, Safari. Low Power Mode off unless an item says otherwise; Auto-Lock **Never** for the round (set it back afterwards).
- **Android:** a Pixel 5 (Android 14; Chrome reports Android 10 in its user agent) on USB, driven from the Mac. It is evidence about Android, not a gate: the iPhone is the pass/fail device. Each `-android` row below carries the last Pixel round as a note, never as the item's pass. The Pixel has a PIN: never lock it or let it sleep while driving it.
- **Mac:** desktop Safari and Firefox, for items that name them. Desktop Chrome is covered by the automated suites, not here.

## Automation

There is no automated runner: the phone-round tool (`pnpm device:walk`) was deleted in Phase 4 ([ADR 0070](../../../docs/decisions/0070-phase-3-tooling-retired.md); its code is at tag `phase-3-complete`, its last round log, `tyler-m29`, at commit `ce78cfac`). Every item below is walked by hand from this file. The Mac can still drive the USB phones directly (WDA through Appium on the iPhone, `adb` on the Pixel) for a one-off.

**iOS frame pacing is judged from driverless runs only (ADR 0056).** A live driver session (WDA, Web Inspector attached) degrades WebKit's frame delivery. A driven iOS attempt of `M09b-fill-rate`, `M16-coexist`, `M29-net-heap` or `M34-remote-motion` records its rAF and hitch numbers as notes with no verdict on them (other criteria are judged as usual). The pass comes from a run with no driver: a plain Safari session.

## How to serve a page to the phone

WebGPU, OPFS and `crossOriginIsolated` need a secure context, so `http://<LAN IP>` never works. Every item starts "served as below"; if the HUD says "not isolated", the serving is wrong, not the engine: fix that first.

- **iPhone, fixture app:** on the Mac `pnpm device:serve --tunnel`; open the printed `https://` URL in Safari. Its `index.html` lists every fixture-app page; items name the page and URL parameters.
- **Mac browsers:** `pnpm device:serve` and the printed loopback URL (a secure context; no tunnel).
- **Android:** `pnpm device:serve`, `adb reverse` the printed port, open the `localhost` URL in Chrome.
- **Multiplayer fixture pages:** an `https` page cannot open `ws://`, so add `--ws [<fixture>]`: `device:serve` starts a real-time `games/reference-server` and proxies `/ws` on the page's own origin, tunnel included. Example: `pnpm device:serve --tunnel --ws puts`.
- **The reference game:** `pnpm device:serve --tunnel --app reference --ws` serves `games/reference` instead of the fixture app (same tunnel and proxy); single-player needs no `--ws`. Without `--tunnel` it is loopback (Mac). Plain `--app reference` is the release build; `?bench=large-save` exists **only in the bench build**: `pnpm device:serve --app reference --bench` (add `--tunnel` for the iPhone), then open `<printed URL>/?bench=large-save` (the printed `index.html` is the page; the release build ignores the parameter and has no `#bench-hud`).
- **Hosted deployment (M38 rows):** the reference server's `--static` handler serves the client and `/ws` on one origin and sets COOP/COEP on every response. The Fly machine used for the first round was destroyed at M39; redeploy it per the reference server's deploy recipe before running these rows. **An invite link needs `#k=`** (the world key in the URL fragment): without it the page plays a local single-player world, by design. Two devices in one hosted world must both open the `#k=` link.

---

## M03: Determinism page

Closes the phone run of ADR 0002. Last results: iPhone pass 2026-10-08.

**Open:** `determinism.html`.

- **M03-determinism** (ADR 0002). *Steps:* load the page, wait for the banner. *Pass:* one PASS banner; every checkpoint hash equals its golden (0 mismatches); the page shows `crossOriginIsolated: true`. *If it fails:* no fallback by design. Record the first divergent checkpoint and the user agent; plan a fix. Suspects in order: an observable NaN (ADR 0002 section 2), a toolchain difference.
- **M03-determinism-android**. Same page, Chrome. *Pass / If it fails:* as above. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): PASS banner, every hash and worldgen checkpoint and the reference `full-game.log` match, `crossOriginIsolated: true`.

## M08: Worldgen ms per chunk

Closes the deferred item of ADR 0008 Consequences. Last results: iPhone pass 2026-10-08 (median 0.1 ms/chunk).

**Open:** `worldgen-bench.html`.

- **M08-worldgen-ms-per-chunk** (ADR 0008 section 6). *Steps:* let the bench finish; record median ms/chunk, the golden result, the user agent and `hardwareConcurrency`. *Pass:* golden match, and median at or under the per-chunk budget of ADR 0008 section 6 (1 ms). *If it fails:* a golden mismatch is a determinism bug: stop and treat as M03-determinism. Over budget: revisit the default gen-worker count on phones and the world warmer's yield per gap (ADR 0008 Consequences).
- **M08-warn-threshold**. *Steps:* compute F = phone median / desktop median from the same page. *Pass:* phone median <= 0.5 ms (the ADR 0008 estimate holds) or F <= 5. *If it fails:* set `worldgenMsPerChunkWarn` in `packages/engine/budgets.json` to 1 ms / F and record F.
- **M08-android**. Both items in Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): median 0.29 ms/chunk, golden match, 8 cores; desktop Chrome 0.08 ms, F = 3.6.

## M09b: Terrain fill rate

Closes the deferred item of ADR 0018 Consequences; repeated by `M18-fill-rate-with-anchors` and the final re-run. Last results: iPhone pass 2026-10-08.

**Open:** `device.html?autopan=1&tiles=256&scale=2`.

- **M09b-fill-rate** (ADR 0018 section 9 GPU share; ADR 0018 Consequences). *Steps:* portrait 60 s, then landscape 60 s (on iOS Safari portrait only, no rotation, ADR 0057); copy the HUD numbers. *Pass:* both orientations measured (iOS Safari: one portrait window, every window portrait, ADR 0057); `isolated` and adapter lines green; rAF interval p95 <= 17.5 ms; intervals > 20 ms <= 5 per 10 s (on iOS Safari these two are advisory: recorded, never failed, ADR 0056); GPU execution p95 <= 6 ms (timestamp queries, `gpu_exec_p95_ms`; the queue latency is informational); on iOS Safari also no gap over 20 ms has an engine cause (`stall` under 16 ms and callback lateness under 2 ms for every gap in the measured windows, ADR 0056); no visible hitch while chunks stream in. *If it fails,* in the order ADR 0018 Consequences states: reopen with `&scaleCap=1.5`; then `&scaleCap=1`; then add `&cutoff=4`. The first passing configuration becomes the mobile default: change the `ClientOptions.render` defaults and add a superseding note to ADR 0018. None passes: the per-chunk-quad fallback of ADR 0018 (a new piece of work).
- **M09b-fill-rate-android**. Same, Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): portrait and landscape 60 s each: rAF p95 16.7 ms, 0 intervals over 20 ms, GPU exec p95 5.18 / 4.85 ms.

## M11: Boot, gestures and memory

First time engine code runs on the phone; do the M03, M08 and M09b sections in the same sitting. Last results: iPhone pass 2026-10-08; desktop Safari pinch pass 2026-10-10.

**Open:** `device.html`.

- **M11-boot** (ADR 0017 section 4; the Phase 1 risk that workers fail on the phone). *Steps:* open the URL. *Pass:* HUD shows `isolated`, an adapter, and "workers ready (posted Module)". *If it fails* with a worker error: reopen with `?module=url`; if that passes, make the URL path Safari's default (ADR 0017 section 4 fallback).
- **M11-gestures** (ADR 0019 section 3). *Steps:* one-finger pan 10 s, flick, pinch to both zoom limits, tap a tile, pull down from the top edge, double-tap, rotate the phone. *Pass:* the world point stays under the finger; the flick glides and stops; the HUD shows the tapped tile; the page never scrolls, zooms or refreshes; rotation keeps the centre. *If it fails:* name the knob (inertia constant, tap thresholds, page CSS helper of ADR 0019 section 3).
- **M11-memory** (ADR 0015 section 5 arena sizes and whole-tab target). *Steps:* `device.html?probe=memory`. The probe (1) grows a scratch memory in 64 MiB steps to 1 GiB (allocated and written a page at a time, so the OS actually commits it), (2) runs the default topology beside the WebGPU context with a scripted ~4 tiles/s pan for 2 min, (3) repeats (2) with `&touch=1`. The HUD prints each step's progress; record all three. *Pass:* (2) and (3) finish without a reload. *If it fails:* re-run with `&sim=64&client=32` (MiB); if that survives, lower the mobile defaults by a superseding ADR for ADR 0015 section 5. If (1) < 256 MiB, record the ceiling in the same ADR. *Known gap:* `&touch=1` re-runs the identical session rather than force-writing every arena page from main (no ABI export exists for that); if (2) passes but (3) shows a different ceiling anyway, note it.
- **M11-pinch-desktop-safari** (ADR 0019 section 3, Mac). *Steps:* `device.html` in desktop Safari on the loopback URL; trackpad pinch in and out over a landmark tile. *Pass:* the zoom follows the fingers about the cursor and the page itself never zooms. *If it fails:* the `gesturechange` listener or `preventDefault` in the engine's `input/wheel.ts`; the automated `camera.gesturechange_scale_zooms_about_cursor` covers only the maths.
- **M11-android**. All three phone items in Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): boot (adreno-6xx, workers ready); gestures by real touches (pan tracks the finger, flick glides and stops, pinch to 12 and 256 tiles, tap reports the tile under the finger, pull-down and double-tap leave the page unscrolled and unzoomed, rotation keeps the centre); memory probe 1024 MiB, both 2 min runs without a reload.

## M16: Vertical slice on the phone

First on-device run of the slice. Last results: iPhone coexist and round-trip pass 2026-10-08, background pass 2026-10-10, low-power pass 2026-10-07. Desktop Chrome 154 (the Phase 3 desktop criterion: ten presses of `slice.html`'s Paint control) pass 2026-10-10, driven by Playwright with real clicks on `pnpm device:serve`: `confirmed 10`, `rejected 0`, `ring drops 0`, `engine_mem_grows` 0 on every instance, `tick` advancing, each result 28-67 ms after its click.

**Open:** `slice.html` (single-player: main + client + sim + gen, fixture `puts`; HUD fields `confirmed`, `rejected`, `ring drops`, `engine_mem_grows`, `tick`); `determinism.html` for the first item.

- **M16-slice-boot**. *Steps:* re-run M03-determinism on this build, then open the slice page. *Pass:* M03's criterion; the slice page shows `isolated`, an adapter, workers ready, terrain drawn; pan and pinch behave as M11-gestures.
- **M16-round-trip** (ADR 0004). *Steps:* tap the page's Paint control 10 times. *Pass:* HUD shows `confirmed 10`, `rejected 0`, `ring drops 0`; each result appears with no perceptible delay.
- **M16-coexist** (ADR 0015 section 5 whole-tab target; ADR 0020 section 10). *Steps:* play and pan for 10 min. *Pass:* no reload, no visible hitch, `engine_mem_grows` = 0 on every instance. Frame pacing is judged driverless only (ADR 0056). *If it fails:* the smaller-arena parameters of M11-memory, then its fallback.
- **M16-background** (`docs/architecture/simulation.md`, idle worlds). *Steps:* another app for 30 s and return; lock the screen for 60 s and return. *Pass:* frame loop and tick loop resume without a reload; the HUD `tick` did not advance while hidden. `slice.html`'s world is in memory and only a persisted world pauses: on Android Chrome its `tick` advances while hidden by design; check the pause itself on the reference game's page (start a collect, hide 20 s: it must still be running on return).
- **M16-low-power** (ADR 0019 Context, time-based motion). *Steps:* turn Low Power Mode on, pan and flick; turn it off afterwards. *Pass:* motion speed unchanged at the halved frame rate: the scripted flick's glide distance at the halved rate is at least 0.95 and at most 1.05 of the one at the normal rate.
- **M16-android**. All items in Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): slice boot; ten real Paint taps `confirmed 10`, `rejected 0`, `ring drops 0`; 10 min / 1,182 pans with `engine_mem_grows` 0 and no reload; background: resumes without a reload (the slice world is in memory and keeps ticking, see M16-background; the reference page's persisted world paused across a 20 s hide). Screen lock and Low Power not run: the Pixel has a PIN, and Battery Saver does not engage while it charges.

## M17b: Desktop Safari and Firefox harness run

On the Mac, not the phone. Closes the deferral of ADR 0018 Consequences (the CDP instrument of ADR 0016 is Chromium-only). Last results: both pass 2026-10-10.

**Open:** `pnpm device:serve` (no tunnel), then the loopback URL + `device.html?harness=1`, in current Safari and current Firefox.

- **M17b-harness-desktop-safari**. *Steps:* Web Inspector, Timelines, JavaScript Allocations, record, press "run" on the page, stop after it prints. *Pass:* the page prints no GPU error and unchanged memory sizes; over the 600 frames the allocation timeline grows by no more than the main-thread budget of ADR 0016 x 600 (about 70 KB) and shows 0 GC pause markers. *If it fails:* a validation error on a SAB-backed upload means making the staged-copy upload path the default for that browser. Visible periodic GC: capture the allocation call tree and name the site. Probe differences are recorded only.
- **M17b-harness-desktop-firefox**. *Steps:* Profiler with "JS Allocations" enabled, same sequence. *Pass / If it fails:* as above.

## M18: Picking and overlay anchoring

Closes the deferred item of ADR 0019 Consequences, which combines it with the fill-rate check of ADR 0018. Last results: iPhone anchors, fill-rate and pick pass 2026-10-07 to 2026-10-09; touch-ghost pass 2026-10-09.

**Open:** `device.html?anchors=50` (a real, connected `fx-overlay` client, not the M09b terrain scene: 50 small text buttons, each `client.overlay.anchor`-ed to the exact world tile one of `extract()`'s 50 pickable rings sits at; 4 markers, each `client.overlay.anchorSlot`-ed to one of `extract()`'s `DrawList::anchor`-published circles orbiting the origin; a cursor-anchored ghost tracks the mouse or last tap). `&anchorMode=translate` switches the fallback per-anchor `translate()` mechanism on (default: the custom-property mechanism). HUD fields: `isolated`, `adapter.info`, `camera` (`tilesAcross`, `centre`), `pick_id` (the last canvas tap's id, `-` on a miss or before any tap; unchanged by a tap on a button), `rAF interval p50/p95/worst`, `rAF intervals >20ms`, `GPU latency p95`, `frames rendered` (the same fields as `M09b-fill-rate`, so the same pass criteria apply).

- **M18-anchors** (ADR 0019 Consequences). *Steps:* pan slowly, flick, then pinch in and out continuously for 30 s; repeat in landscape. *Pass:* every button stays centred on its ring and every marker stays on its moving circle (zero swim, no lag or jitter); text crisp at every zoom; buttons respond to taps without moving the camera; HUD rAF p95 <= 17.5 ms during the pinch. *If it fails:* reopen with `&anchorMode=translate`. If that passes: make `translate` the default on iOS (everywhere if desktop cost is equal) by a superseding ADR for ADR 0019 and a note against the overlay line of ADR 0016. If both fail: screen capture; what remains is in-canvas drawables for anything that must not swim.
- **M18-fill-rate-with-anchors**. *Steps:* on the same `device.html?anchors=50` page (not `fx-terrain`), portrait 60 s then landscape 60 s, panning and pinching continuously; copy the HUD numbers. *Pass / If it fails:* as `M09b-fill-rate` (rAF p95 <= 17.5 ms; intervals > 20 ms <= 5 per 10 s; GPU execution p95 <= 6 ms; no visible hitch), reopening with `&anchorMode=translate` first before `M09b-fill-rate`'s `&scaleCap` / `&cutoff` ladder.
- **M18-pick** (ADR 0019 section 4). *Steps:* at three zoom levels (`&tiles=`), tap several rings (small and, near the grid's 3-tile spacing, close together) and a button. *Pass:* the HUD's `pick_id` reports the topmost ring's id every time (0 misses); a tap on a button leaves `pick_id` unchanged (never reaches the canvas).
- **M18-touch-ghost** (ADR 0019 section 4, cursor tile and ghost). *Steps:* tap to move the cursor tile, then drag. *Pass:* the ghost (a translucent square, `extract()`'s `ANCHOR_CURSOR_TILE` draw) sits on the tapped tile; the drag pans.
- **M18-android**. All items in Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): fill rate with anchors rAF p95 16.75 ms, 0 over 20 ms, GPU p95 1.97 / 1.77 ms; anchor probe max error 1.26 / 0.92 px, jitter 1.17 / 0.86 px (swim not judged by eye: a CDP screenshot omits the WebGPU canvas); pick 0 misses at 12/24/40 tiles, button taps leave `pick_id`; touch ghost on the tapped tile, drag pans.

## M23: OPFS and world lifecycle

Closes the deferred OPFS latency item of ADR 0005 Consequences; it tunes only the log `sync` interval. Last results: iPhone latency, kill-resume, hidden-pause pass 2026-10-08; world-busy and private pass 2026-10-10; export-import pass 2026-10-10 (hash comparison at equal ticks not taken; the archive round trip is automated in the M23 persistence specs).

**Open:** `opfs-latency.html` (a worker runs 1,200 appends of 64 B with a `flush()` every 20th, then 20 scratch writes of 1 MiB and 10 of 8 MiB each with its own `flush()`, then prints a p50/p95/max table for `append`/`flush`/`scratch 1 MiB`/`scratch 8 MiB` plus `move()` / `navigator.locks` availability booleans); then `world.html` (fixture `puts` with persistence on; `?world=<id>`, default `device`; HUD shows `world`, `worldBusy`, `loadFailed`, `hash`, `tick`, `durable`, `persisted`, `usage`, `quota`; `hash` and `tick` refresh only on a discrete event, page load or a Paint tap, never on a timer, so a step needing a fresh reading taps Paint first; Export, Import (a file picker plus a new-id field) and Delete buttons over `client.exportWorld` / `importWorld` / `deleteWorld`; Export triggers a real file download named `<worldId>.world`).

- **M23-opfs-latency** (ADR 0005 Consequences). *Steps:* run the latency page; copy the whole printed table. *Pass:* `flush` p95 <= 10 ms (the keep band). *If it fails:* retune the log `sync` interval by a new ADR superseding the number in ADR 0005. `move()` missing: use slot files instead of rename.
- **M23-kill-resume** (ADR 0005 loss windows). *Steps:* play 2 min, swipe-kill Safari, reopen. *Pass:* the world resumes; 0 admitted actions lost.
- **M23-world-busy**. *Steps:* open the same world in a second tab. *Pass:* the second tab shows the `WorldBusy` banner; the first keeps playing.
- **M23-private**. *Steps:* open the page in Private Browsing. *Pass:* the HUD reports `durable: false` and the world still plays.
- **M23-hidden-pause**. *Steps:* tap Paint once (a fresh `tick` reading), background 30 s, foreground, tap Paint again. *Pass:* the second `tick` reading is only a few ticks past the first (not ~600, the 30 s at 20 Hz a still-running world would rack up) and `durable` stays `true`; no reload. *Why tap Paint, not just read the HUD:* `hash` / `tick` refresh only on that discrete event, so the number sitting on screen while backgrounded proves nothing about whether ticking stopped.
- **M23-export-import**. *Steps:* tap Export (a `<worldId>.world` download; confirm it arrives in Files); note the HUD `hash`. Reload the page (or open a second tab) with a fresh `?world=<other-id>`, choose the downloaded file in the Import file picker, type the new id, tap Import (importing onto an id that already has a world fails: use a new id); then open `world.html?world=<other-id>` directly. *Pass:* the new world's HUD `hash` (after a Paint tap, at the same tick count) equals the exported world's `hash`.
- **M23-android**. All items in Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): `flush` p95 0.93 ms; kill-resume (12 confirmed paints, force-stop, reopened at tick 714 >= 713 with the same hash); world-busy; hidden pause +59 ticks over 30 s, durable. Export produces the archive and the page's file input imports it, but the file did not reach Downloads (unconfirmed); Private not run (Chrome ignores an incognito intent).

## M29: Net worker and reconnect

Closes the iOS worker-socket resume item (ADR 0013 Consequences); it tunes only the dead timeout and the probe deadline of ADR 0013. Last results: `M29-net-heap` pass 2026-10-08 (driverless); `M29-socket-resume` and `M29-play-through-drop` pass 2026-10-10 on the iPhone 12 (12 drops, app-5s and app-30s by hand, app-5min and lock-60s driven over USB): `visible` to `Welcome` median 0 ms, max 111 ms (a 0 is a link that had already reconnected while hidden), interactive and no dialog in every run. **Closed as not applicable** (Tyler, 2026-10-10): Wi-Fi to cellular (no SIM) and airplane 15 s (iOS keeps Wi-Fi on in airplane mode on this phone, so the socket only resets; a real outage needs Wi-Fi off too). The four drops that ran cover the resume path; a phone with a SIM walks them if the link code changes. The link log lists rows newest first. Android: see M29-android.

**Open:** on the Mac `pnpm device:serve --tunnel --ws puts` (starts the real-time server and proxies `/ws`); on the phone `mp.html?linklog=1` on the printed URL.

- **M29-socket-resume** (ADR 0013 Client policy). *Steps:* three runs each of: another app 5 s; 30 s; 5 min; screen lock 60 s; Wi-Fi to cellular in the foreground; airplane mode 15 s. Per run copy from the on-page link log: `close` delivered (ms after `visible`) or silence; ms from `visible` to `Welcome`; page discarded or not. *Pass:* `visible` to `Welcome` median <= 1.5 s and max <= 4 s: keep the ADR 0013 numbers. *If it fails:* silence with median > 2 s: lower the probe deadline toward one heartbeat interval plus margin; prompt `close` everywhere: numbers stay, note it. Any change is a new ADR amending ADR 0013 Client policy.
- **M29-play-through-drop** (ADR 0013 Client policy). *Steps:* keep panning during each drop above. *Pass:* the game stays interactive on last known state; the indicator appears only after the delay ADR 0013 states; no modal for short outages.
- **M29-net-heap** (ADR 0015 section 2, ADR 0016). *Steps:* 10 min connected with steady traffic. *Pass:* no visible periodic hitch (the net worker's garbage stays off the main thread). Frame pacing is judged driverless only (ADR 0056).
- **M29-android**. All items in Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): another app 5 s / 30 s: the socket survives (0 ms); 5 min: `Welcome` 32 ms after `visible`; 15 s outages through a proxy that stops forwarding (Wi-Fi off cannot drop an `adb reverse` link): online 383-872 ms after the outage ends, `reconnecting` shown, no modal, no reload.

## M34: Reference multiplayer on real devices

Holds the own-timer feel and remote motion items. Last results: iPhone two-devices pass 2026-10-07, remote-motion pass 2026-10-08 (driverless), own-timer-bar pass 2026-10-10 (judged by eye). Desktop Chrome 154, two windows on the invite link (`pnpm device:serve --app reference --bench --ws`, the check build's `__check`), pass 2026-10-10 after the fixes of ADR 0073: remote motion changed on 0.998 of moving frames, never still over 8 ms, no backstep, no snap, gone 63 ms after its window closed; own bars full within -16..+25 ms of the result unthrottled and 9-83 ms under "Slow 4G" from page load (ten collects and a craft). DevTools throttling does not reach a WebSocket: "Slow 4G" was a TCP proxy delaying each direction 281 ms. Before ADR 0073 the bars were full 250-350 ms early and the timing that the iPhone pass judged by eye could not have shown it. Walk the remote within the watcher's subscription: a remote that leaves it holds, then jumps when it returns.

**Open:** on the Mac `pnpm device:serve --tunnel --app reference --ws`; the reference game on the phone on the printed URL, joined through the invite link (the URL **with its `#k=` fragment**; without it the page is a local single-player world); the same world in desktop Chrome on the Mac.

- **M34-two-devices**. *Steps:* phone and Mac join one LAN world; collect on one, place on the other. *Pass:* each sees the other's circle and changes; roster dots go hollow after a disconnect plus the grace of ADR 0013 and fill on return.
- **M34-own-timer-bar** (ADR 0012 completion gap). The rule is decided: the bar stretches over `duration + lead`. *Steps:* start own timers on Wi-Fi, then on a throttled or cellular link (a Wi-Fi-only iPhone with no SIM cannot do cellular: throttle instead). *Pass:* each bar starts at the tap and reaches full as the result arrives, with no full bar left waiting and no result before the bar is full. *If it fails:* a bar that waits or overshoots is a lead-estimate or `own_progress` bug: record RTT and the gap and fix in the prediction/clock code.
- **M34-remote-motion** (ADR 0012 "Remote motion"). *Steps:* move on the Mac and watch the phone; then close the Mac's page. *Pass:* the remote circle moves without snapping: while it moves its drawn position changes on at least 0.9 of the frames and is never still for more than 50 ms, and it never steps back against its walking direction by more than 0.15 tiles; when its player leaves it disappears within 1000 ms (ADR 0013: presence vanishes at once on a clean close; the fade of ADR 0012 is for a stalled link). Frame pacing is judged driverless only (ADR 0056). *If it fails:* revisit the adaptive remote delay.
- **M34-android**. All items in Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): Pixel and desktop Chrome in one LAN world (both rosters, both circles); remote motion changed on 1.0 of moving frames, max still 0 ms, no backstep or snap, gone 201 ms after close; own bars within -72..+17 ms direct and -24..+67 ms under a 281 ms-each-way proxy from load.

## M35: Built reference game in real Safari

Last results: Mac and iPhone pass 2026-10-08 to 2026-10-10. `M35-capability` was retired from the device list (covered by the automated `capability.spec.ts`); the entry stays for completeness.

**Open:** the `vite build` + `vite preview` output of `games/reference` (`pnpm device:serve --app reference`): on the Mac over loopback; on the iPhone with `--tunnel`.

- **M35-safari-build-mac** (ADR 0017 section 4). *Steps:* load in desktop Safari. *Pass:* the game plays. A refused posted `Module` automatically re-sends setup with the `.wasm` URL, so either delivery passes, and the reference game shows no delivery line. *If it fails:* a defect (the fallback did not engage, or something else broke); note the page's error text and the Web Inspector console.
- **M35-safari-build-iphone**. Same on the iPhone. *Pass / If it fails:* as above.
- **M35-capability** (ADR 0018 section 7; retired, optional). *Steps:* open the game in a browser with no `navigator.gpu` (for example Safari with the WebGPU feature flag off). *Pass:* the capability screen appears with `no-webgpu`; no blank page.

## M37b: Renderer recovery after backgrounding

The `rendererLost` prompt is the client status code's; M37b builds the recovery. Last results: iPhone pass 2026-10-08.

**Open:** the reference game on the iPhone (`pnpm device:serve --tunnel --app reference`).

- **M37b-ios-background** (ADR 0018 section 8). *Steps:* play; background the tab for several minutes under memory pressure (camera app, a few heavy pages); return. Three runs. *Pass:* every run ends with the world drawn again without a reload, or with the `rendererLost` prompt; 0 frozen or black canvases. *If it fails:* record which; revisit the device-loss sequence of ADR 0018 section 8.

## M38: Hosted deployment

The Fly machine serves the client (`games/reference-server --static`, which sets COOP/COEP on every response) and `/ws` on one origin. Last results: `M38-hosted-boot` pass 2026-10-10 (iPhone and Mac); the other two rows are not run.

**Not checked, carried forward:** the COOP/COEP listings of ADR 0015 section 3 on a real static host, and a cross-origin `wss`. Unverified.

**Open:** the hosted URL on the iPhone, **on cellular** (Wi-Fi off); add `?linklog=1` for M38-socket-resume. No local serving. For any two-device row, both devices open the invite link **with `#k=`**; the bare URL plays a local single-player world.

- **M38-hosted-boot** (COOP/COEP from the reference server's static handler on a real deployment; same-origin `wss`). *Steps:* open the URL. *Pass:* the page is cross-origin isolated, gets an adapter, and reaches `online` on the same origin, including the first load that wakes a stopped machine. *If it fails:* compare with `scripts/check-coi.mjs <url>`; fix the `--static` handler or the Fly recipe.
- **M38-socket-resume**. *Steps:* with `?linklog=1`, each step of M29-socket-resume once over the real network; record `visible` to `Welcome` from the on-page log. *Pass / If it fails:* as M29-socket-resume.
- **M38-remote-motion**. *Steps:* M34-remote-motion with the phone on cellular and the Mac on Wi-Fi. *Pass / If it fails:* as M34-remote-motion.
- First dial to a stopped machine may show `reconnecting` for about 1 s; an error screen is a failure.

## M39: Acceptance

Run last, on the final build, after every section above has a result: re-run rather than trusting old passes. Last results: `M39-large-save` pass 2026-10-09 (iPhone); `M39-frame-shares` pass 2026-10-08; `M39-full-game-touch`, `M39-two-devices` and `M39-sign-off` passed with Tyler 2026-10-10; `M39-rerun` and `M39-desktop-browsers` not run.

**Open:** the reference game: single-player, then through `games/reference-server`, then the hosted deployment; the fixture pages served as above for the re-run. Two-device rows use the invite link with `#k=`.

- **M39-rerun**. *Steps:* re-run every item of every section above on the final build. *Pass:* each item's own criterion.
- **M39-large-save** (ADR 0007 section 8; `?bench=large-save[&scale=n][&pan=tiles/s]`, bench build only). *Steps:* load the standard large save on the iPhone in single-player; play 10 min; read the HUD (`#bench-hud`: `engine_mem_grows: sim n, client n`, `tick`, `main p95`, `frame p95`, `tick p95`) **after at least 10 s** (`tick p95` is inflated early: the first tick visits all 262,144 furnaces). *Pass:* `engine_mem_grows` = 0 (sim and client), no tab reload, and the bench HUD's `tick p95` on the iPhone 12 is at or under the phone sim-worker figure of the Tick time row (the figure in the engine budgets, `docs/architecture/testing-and-tooling.md`; owner ADR 0010); on Android the `tick p95` is reported, not judged (ADR 0056). *If it fails* on memory: decide by ADR which default drops first (ADR 0007 section 8: entities are the memory problem); on tick time: the tick benchmark, or an ADR changing the number.
- **M39-frame-shares** (Frame time row, baseline-phone shares; owner ADR 0018 section 9). *Steps:* on the same `?bench=large-save` page, zoom out fully over the dense base and pan slowly for 60 s; copy the bench HUD (after the first 10 s; `?pan=` sets a steady pan; desktop proxy numbers: main p95 0.10 ms, frame p95 0.23 ms). *Pass:* `main p95` and `frame p95` are each at or under that row's phone figure for the main rAF callback and the client-worker `frame` (the GPU share is M09b-fill-rate's). *If it fails:* run the `profile-frame` skill on the desktop proxy for the same view; fix the share that missed.
- **M39-full-game-touch**. *Steps:* play the reference game by hand on the phone: spawn, mine to the unlock, craft, place with tap-then-confirm, pick the empty furnace up and place it again, fuel, smelt, take. *Pass:* every step works by touch; buttons and the furnace panel stay glued to their tiles; 10 min with no reload and no visible hitch.
- **M39-two-devices**. *Steps:* phone and Mac in one hosted world (LAN world if the hosted deployment is not up), both through the `#k=` invite link. *Pass:* each sees the other's circle move smoothly; roster dots follow a disconnect after the grace and the return; a furnace placed on one appears on the other.
- **M39-desktop-browsers**. *Steps:* desktop Safari and Firefox on the Mac, 5 min of play each. *Pass:* 0 validation errors in the console; no periodic hitch.
- **M39-android**. M39-full-game-touch and M39-two-devices in Chrome. Pixel 5, Android 14, Chrome 155, driven over adb + CDP, 2026-10-10 (notes, not passes): full game by real taps on the production page (to the ingot, no reload); large save 10 min `engine_mem_grows` 0, tick p95 19.4 ms (reported); frame shares main p95 0.78 ms, client `frame` p95 5.08 ms (both under 0062, the client share ~3.7x the iPhone's). Two devices: see M34-android (furnace sync across devices not checked).
- **M39-sign-off**. *Steps:* Tyler plays the reference game from start to furnace output, single-player and with a second player. *Pass:* Tyler signs off. *If it fails:* each objection becomes a work item.

## M53b: Items on belts on the phone

Tyler's judgement of the item clock's lead (ADR 0078 A12: items are drawn at the follower's tick plus a fraction, so they lead the entity motion, drawn at the render time, by the interpolation delay; 4 ticks at the median profile). Last results: not run.

**Open:** on the Mac `pnpm device:serve --tunnel --app reference --ws`; the reference game on the phone on the printed URL through the invite link (`#k=`), and the same world in desktop Chrome on the Mac. Not during Tyler's own round; never sleep the Pixel (its PIN).

- **M53-item-lead** (ADR 0078 A12). *Steps:* on the Mac, place a spawner facing east, three belts and a despawner in front of it; open the spawner's popover and give the left lane iron and the right lane coal (the item buttons; one tap runs a lane at the belt's saturation, 7.5/s); watch from the phone at the default zoom, then zoomed in on the spawner and on the despawner; on the Mac pick the spawner up and place it again. *Pass:* Tyler accepts the lead: items appear at the spawner and vanish at the despawner about 200 ms before the entity motion around them (a placed or picked-up belt) shows it, items move smoothly along the run with no backstep, and none is drawn past the despawner's front edge. Default if Tyler has not judged by his next round: accept. *If it fails:* write milestone M49b (a lagged follower: sections 12 and 13 buffered for the delay and the follower stepped at the render time, ADR 0078 A12) and record Tyler's words in ADR 0078.

## M57: Belts on the phone

The belt rows of ADR 0080 that only a phone can give. Last results: not run (at M57's gate the iPhone was paired over the network but not on the USB cable, and no Pixel was attached; the Mac-driven path below was verified up to the device step).

**Open:** on the Mac `pnpm device:serve --tunnel --app reference --bench`, then `<printed https URL>/?bench=belts&zoom=max` and `&zoom=mid` in Safari (the bench build only; a release build ignores `?bench=`). The page writes a field of 48 saturated belt runs (12,264 belts, 98,304 items at the phone pair's caps 12,288 / 98,304) at genesis and pans over it; the field fills in about 140 s, so read the HUD after that. Auto-Lock **Never** for the round, Low Power off; the Mac can drive the reading through safaridriver (the spike's leg A at tag `phase-3-complete`, `spikes/device-driver-ios/wd.mjs`: a W3C session with `safari:deviceUDID`, `/url`, then `window.__bench.hud()` every 10 s; a session blocks the phone, so end it) or through WebDriverAgent (needs Tyler's passcode tap per session); pacing on iOS is judged driverless only (ADR 0056). Desktop reference figures (Chromium, 1280 x 720): max tick p95 0.215 ms / frame p95 0.595 / main 0.370 / GPU 1.022; mid 0.270 / 1.980 / 0.305 / 0.752, about 7,100 items drawn.

- **M57-belts-tick** (ADR 0080, 0056's bar). *Steps:* `?bench=belts&zoom=max`, wait for the field to fill (HUD `tick` past 3,000), copy `tick p95` over the next 60 s. *Pass:* `tick p95` <= 10 ms on the iPhone 12 (the phone sim worker's bar, 0056). *If it fails:* record the figure and the `sim_phases` split; the levers are the field's size (`&scale=`) and the per-line cost in `advance` (0079 §19 (d)): a question to Tyler with the profile, never a widened bar.
- **M57-belts-frame-pacing** (ADR 0018 §9, 0056; driverless on iOS). *Steps:* the same page at `zoom=max` for 60 s after the fill, then `zoom=mid` for 60 s; copy `main p95`, `frame p95`, `rAF p95`, `over 20 ms`, `GPU p95` from the HUD. *Pass:* `frame p95` <= 8 ms and `main p95` <= 4 ms at both zooms; `GPU p95` <= 6 ms where the phone reports it (`gpuUnavailable` otherwise, recorded); rAF p95 <= 17.5 ms and <= 5 over 20 ms per 10 s advisory on iOS. *If it fails:* the ladder of 0018 Consequences (`&scale=0.5` as the scale cap stand-in), then the tile-visual fallback of 0076 Consequences as a new piece of work after Tyler sees the numbers.
- **M57-belts-memory** (ADR 0015 §5, 0079 §21; question 15). *Steps:* 60 s at each zoom after the fill, then background the tab 30 s and return. *Pass:* no reload; `engine_mem_grows` 0 for `sim` and `client` throughout. *If it fails:* the shipped world's caps fall to the phone pair (question 15's fallback) by a 0080 amendment; a reload on the 8.2 MB page is a 0015 §5 question.
- **M57-belts-android**. All three in Chrome on the Pixel 5 over `adb reverse` (evidence, not a pass; never let it sleep: its PIN). Not run.
- **M57-palette-look** (M55 review note). *Steps:* in the reference game on the phone (release build, `--app reference --ws`), open construction mode, pick the underground tool, place a belt on a resource tile so the refusal reason shows. *Pass:* the palette's two rows and the refusal label read without overlapping. *If it fails:* move the label above the palette (`build.ts`).
