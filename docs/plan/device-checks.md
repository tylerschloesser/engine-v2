# Manual device checks

Tyler-run checks on real hardware: what Phase 3 cannot automate (`0020` §10, `PRE-PLAN.md` §9 risk 1). This file owns every manual check; briefs only link to their section here. One section per milestone marked **D** in `PLAN.md`, in `PLAN.md` order.

- A check never blocks the next milestone. A failed check opens a plan edit (`PLAN.md`, "How milestones work"); where an ADR's number changes, a superseding ADR.
- The implementer that lands a **D** milestone makes its section match what it built (exact page, URL parameters, HUD field names). Headings and item ids are stable: briefs link to the headings, and M39's `acceptance-check.mjs` looks up ticked ids. Add an item as `- [ ] **M<NN>-<slug>**`; never rename one.
- Tick an item when it passes. On FAIL leave it unticked, follow *If it fails*, re-run, and record both runs on the section's **Run on** line.

## Devices

- **iPhone:** 12-class or newer, iOS 26+, Safari. Low Power Mode off unless an item says otherwise.
- **Android:** none. Tyler's answer to Q5 (`questions-for-tyler.md`) is iPhone only. Every `-android` row below is kept so the gap stays visible, is marked "not run: no device", and is never ticked; a **Run on** line records it as "Android: not run: no device". Desktop Chrome is covered by the automated suites, not here.
- **Mac** (Tyler's): desktop Safari and Firefox, for the items that name them.

## How to serve a page to the phone

Mechanism, rationale and the `mkcert` alternative: [M03's brief](03-browser-harness.md), Planning decisions, "Determinism on a physical phone". The tunnel is approved (Q7). WebGPU, OPFS and `crossOriginIsolated` need a secure context, so `http://<LAN IP>` never works.

- **iPhone:** on the Mac run `pnpm device:serve --tunnel`; open the printed `https://` URL in Safari. Its `index.html` lists every fixture-app page; items below name the page and its parameters.
- **Android** *(unused: no device, Q5)*: if a device ever appears, `pnpm device:serve`, then the `adb reverse` step of M03's brief, then the `localhost` URL in Chrome.
- **Mac browsers:** `pnpm device:serve` and the loopback URL it prints (loopback is a secure context; no tunnel).
- **Multiplayer items (M29 onward):** an `https` page cannot open `ws://`, so add `--ws [<fixture>]`: `device:serve` then starts a real-time `games/reference-server` and proxies `/ws` on the page's own origin, through the tunnel too (built in M29).
- **The reference game** (M34, M35, M37b, M39): `pnpm device:serve --tunnel --app reference --ws` serves `games/reference` instead of the fixture app, same tunnel and proxy (built in M29).
- Every item starts with "served as above". If the HUD says "not isolated", the serving is wrong, not the engine: fix that first.

---

## M03: Determinism page

When: the page exists from M03; first scheduled run is in the M11 sitting. Closes the deferred phone run of `0002`.

**Open** (served as above): `determinism.html`.

- [ ] **M03-determinism** (`0002`). *Steps:* load the page, wait for the banner. *Pass:* one PASS banner; every checkpoint hash equals its golden (0 mismatches); the page shows `crossOriginIsolated: true`. *If it fails:* no fallback by design. Record the first divergent checkpoint and the user agent; open a plan edit. Suspects in order: an observable NaN (`0002` §2), a toolchain difference.
- [ ] **M03-determinism-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. Same page, Chrome. *Pass / If it fails:* as above.

**Run on:** <device, OS, date>; **result:** <PASS / FAIL, notes, plan edit link>

---

## M08: Worldgen ms per chunk

When: the page exists from M08; first scheduled run is in the M11 sitting. Closes the deferred item of `0008` Consequences.

**Open** (served as above): `worldgen-bench.html`.

- [ ] **M08-worldgen-ms-per-chunk** (`0008` §6). *Steps:* let the bench finish; record median ms/chunk, the golden result, the user agent and `hardwareConcurrency`. *Pass:* golden match, and median at or under the per-chunk budget of `0008` §6 (1 ms). *If it fails:* golden mismatch is a determinism bug: stop and treat as M03-determinism. Over budget: plan edit revisiting the default gen-worker count on phones (M08b) and M13's warmer yield per gap (`0008` Consequences).
- [ ] **M08-warn-threshold**. *Steps:* compute F = phone median / desktop median from the same page. *Pass:* phone median ≤ 0.5 ms (the estimate in `0008` holds) or F ≤ 5. *If it fails:* set `worldgenMsPerChunkWarn` in `budgets.json` to 1 ms / F and record F.
- [ ] **M08-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. Both items in Chrome.

**Run on:** <device, OS, date>; **result:** <median ms/chunk, F, PASS / FAIL>

---

## M09b: Terrain fill rate

When: as soon as M09b is ticked; repeated by M18-fill-rate-with-anchors and M39-rerun. Closes the deferred item of `0018` Consequences.

**Open** (served as above): `device.html?autopan=1&tiles=256&scale=2`.

- [ ] **M09b-fill-rate** (`0018` §9 GPU share; `0018` Consequences). *Steps:* portrait 60 s, then landscape 60 s; copy the HUD numbers. *Pass:* `isolated` and adapter lines green; rAF interval p95 ≤ 17.5 ms; intervals > 20 ms ≤ 5 per 10 s; GPU latency p95 ≤ 6 ms; no visible hitch while chunks stream in. *If it fails,* in the order `0018` Consequences states: reopen with `&scaleCap=1.5`; then `&scaleCap=1`; then add `&cutoff=4`. The first passing configuration becomes the mobile default: plan edit changing the `ClientOptions.render` defaults, plus a superseding ADR note for `0018`. None passes: plan edit for the per-chunk-quad fallback of `0018` (a new brief).
- [ ] **M09b-fill-rate-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. Same, Chrome.

**Run on:** <device, OS, date>; **result:** <HUD numbers per orientation, configuration that passed>

---

## M11: Boot, gestures and memory

When: M11 ticked. First time engine code runs on the phone: run the M03, M08 and M09b sections in the same sitting.

**Open** (served as above): `device.html`.

- [ ] **M11-boot** (`0017` §4; `PRE-PLAN.md` §9 risk 1). *Steps:* open the URL. *Pass:* HUD shows `isolated`, an adapter, and "workers ready (posted Module)". *If it fails* with a worker error: reopen with `?module=url`; if that passes, plan edit making the URL path Safari's default (`0017` §4 fallback). M35 item (c) reads this result.
- [ ] **M11-gestures** (`0019` §3). *Steps:* one-finger pan 10 s, flick, pinch to both zoom limits, tap a tile, pull down from the top edge, double-tap, rotate the phone. *Pass:* the world point stays under the finger; the flick glides and stops; the HUD shows the tapped tile; the page never scrolls, zooms or refreshes; rotation keeps the centre. *If it fails:* name the knob (inertia constant, tap thresholds, page CSS helper of `0019` §3) in a plan edit.
- [ ] **M11-memory** (`0015` §5 arena sizes and whole-tab target). *Steps:* `device.html?probe=memory`. The probe (1) grows a scratch memory in 64 MiB steps to 1 GiB (allocated and written a page at a time, so the OS actually commits it, not just reserves it), (2) runs the default topology beside the WebGPU context with a scripted ~4 tiles/s pan for 2 min, (3) repeats (2) with `&touch=1`. The HUD prints each step's own progress; record all three. *Pass:* (2) and (3) finish without a reload. *If it fails:* re-run with `&sim=64&client=32` (MiB); if that survives, plan edit lowering the mobile defaults by a superseding ADR for `0015` §5. If (1) < 256 MiB, record the ceiling in the same ADR. *Known gap (M11 Deviations):* `&touch=1` re-runs the identical session rather than force-writing every arena page from main (no ABI export exists for that yet) -- if (2) passes but (3) shows a different ceiling anyway, note it, since the two runs are not yet meaningfully different.
- [ ] **M11-pinch-desktop-safari** (`0019` §3, Mac). *Steps:* `device.html` in desktop Safari on the loopback URL; trackpad pinch in and out over a landmark tile. *Pass:* the zoom follows the fingers about the cursor and the page itself never zooms. *If it fails:* the `gesturechange` listener or `preventDefault` of M11's `input/wheel.ts`; the automated `camera.gesturechange_scale_zooms_about_cursor` covers only the maths.
- [ ] **M11-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All three in Chrome.

**Run on:** <device, OS, date>; **result:** <per item; largest reservation in MiB>

---

## M16: Vertical slice on the phone

When: M16 ticked (`PRE-PLAN.md` §8 item 9: first on-device run of the slice).

**Open** (served as above): `slice.html` (single-player: main + client + sim + gen, fixture `puts`; HUD fields `confirmed`, `rejected`, `ring drops`, `engine_mem_grows`, `tick`); `determinism.html` for the first item.

- [ ] **M16-slice-boot**. *Steps:* re-run M03-determinism on this build, then open the slice page. *Pass:* M03's criterion; the slice page shows `isolated`, an adapter, workers ready, terrain drawn; pan and pinch behave as M11-gestures.
- [ ] **M16-round-trip** (`0004`). *Steps:* tap the page's Paint control 10 times. *Pass:* HUD shows `confirmed 10`, `rejected 0`, `ring drops 0`; each result appears with no perceptible delay.
- [ ] **M16-coexist** (`0015` §5 whole-tab target; `0020` §10). *Steps:* play and pan for 10 min. *Pass:* no reload, no visible hitch, `engine_mem_grows` = 0 on every instance. *If it fails:* the smaller-arena parameters of M11-memory, then the plan edit of M11-memory.
- [ ] **M16-background** (`simulation.md`, idle worlds). *Steps:* another app for 30 s and return; lock the screen for 60 s and return. *Pass:* frame loop and tick loop resume without a reload; the HUD `tick` did not advance while hidden.
- [ ] **M16-low-power** (`0019` Context, time-based motion). *Steps:* turn Low Power Mode on, pan and flick. *Pass:* motion speed unchanged at the halved frame rate.
- [ ] **M16-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** <device, OS, date>; **result:** <per item>

---

## M17b: Desktop Safari and Firefox harness run

When: M17b ticked. On the Mac, not the phone. Closes the deferral of `0018` Consequences (the CDP instrument of `0016` is Chromium-only).

**Open:** `pnpm device:serve` (no tunnel), then the loopback URL + `device.html?harness=1`, in Safari current and in Firefox current.

- [ ] **M17b-harness-desktop-safari**. *Steps:* Web Inspector → Timelines → JavaScript Allocations, record, press "run" on the page, stop after it prints. *Pass:* the page prints no GPU error and unchanged memory sizes; over the 600 frames the allocation timeline grows by no more than the main-thread budget of `0016` × 600 (about 70 KB) and shows 0 GC pause markers. *If it fails:* validation error on a SAB-backed upload → make M09's staged-copy path the default for that browser. Visible periodic GC → capture the allocation call tree; plan edit naming the site. Probe differences are recorded only.
- [ ] **M17b-harness-desktop-firefox**. *Steps:* Profiler with "JS Allocations" enabled, same sequence. *Pass / If it fails:* as above.

**Run on:** <browser versions, macOS, date>; **result:** <printed probe lines, allocation growth, PASS / FAIL>

---

## M18: Picking and overlay anchoring

When: M18 ticked. Closes the deferred item of `0019` Consequences, which combines it with the fill-rate check of `0018`.

**Open** (served as above): `device.html?anchors=50` (50 text buttons anchored to tiles, each over an in-canvas ring; 4 slot anchors on moving circles).

- [ ] **M18-anchors** (`0019` Consequences). *Steps:* pan slowly, flick, then pinch in and out continuously for 30 s; repeat in landscape. *Pass:* every label stays centred on its ring (zero swim, no lag or jitter); text crisp at every zoom; buttons respond to taps without moving the camera; HUD rAF p95 ≤ 17.5 ms during the pinch. *If it fails:* reopen with `&anchorMode=translate` (the fallback `0019` Consequences states). If that passes: plan edit making `translate` the default on iOS (everywhere if desktop cost is equal), a superseding ADR for `0019`, and a note against the overlay line of `0016`. If both fail: screen capture and a plan edit; what remains is in-canvas drawables for anything that must not swim.
- [ ] **M18-fill-rate-with-anchors**. *Steps:* M09b-fill-rate with `&anchors=50` added. *Pass / If it fails:* as M09b-fill-rate.
- [ ] **M18-pick** (`0019` §4). *Steps:* tap small and overlapping drawables at three zoom levels; tap a DOM button. *Pass:* the HUD reports the topmost drawable's `pick_id` every time (0 misses); a tap on a DOM widget reports nothing to the canvas.
- [ ] **M18-touch-ghost** (`0019` §4, cursor tile and ghost). *Steps:* tap to move the cursor tile, then drag. *Pass:* the ghost sits on the tapped tile; the drag pans.
- [ ] **M18-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** <device, OS, date>; **result:** <per item; anchor mode that passed>

---

## M23: OPFS and world lifecycle

When: M23 ticked. Closes the deferred OPFS latency item of `0005` Consequences; it tunes only the log `sync` interval.

**Open** (served as above): `opfs-latency.html`, then `world.html` (fixture `puts` with persistence; HUD adds `hash`, `durable`, `persisted`; Export / Import / Delete buttons; `?world=<id>`).

- [ ] **M23-opfs-latency** (`0005` Consequences). *Steps:* run the latency page; copy the whole table (p50 / p95 / max for `append`, `flush`, both snapshot writes; `move()` and `navigator.locks` availability). *Pass:* `flush` p95 ≤ 10 ms, the keep band of [M23's brief](23-persistence-opfs-and-lifecycle.md), Planning decision 7, which owns the bands. *If it fails:* apply that decision's retune rule; any change is a new ADR superseding the number in `0005`. `move()` missing → slot files, M23 Planning decision 3.
- [ ] **M23-kill-resume** (`0005` loss windows). *Steps:* play 2 min, swipe-kill Safari, reopen. *Pass:* the world resumes; 0 admitted actions lost.
- [ ] **M23-world-busy**. *Steps:* open the same world in a second tab. *Pass:* the second tab shows `WorldBusy`; the first keeps playing.
- [ ] **M23-private**. *Steps:* open the page in Private Browsing. *Pass:* the page reports `durable: false` and still plays.
- [ ] **M23-hidden-pause**. *Steps:* background 30 s, foreground. *Pass:* the HUD `tick` did not advance while hidden; no reload.
- [ ] **M23-export-import**. *Steps:* export; confirm the file arrives in Files; import it under a new id. *Pass:* both worlds show the same hash.
- [ ] **M23-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** <device, OS, date>; **result:** <latency table; per item>

---

## M29: Net worker and reconnect

When: M29 ticked. Closes the iOS worker-socket resume item (`PRE-PLAN.md` §10; `0013` Consequences); it tunes only the dead timeout and the probe deadline of `0013`.

**Open:** on the Mac `pnpm device:serve --tunnel --ws puts` (starts the real-time server and proxies `/ws`); on the phone `mp.html?linklog=1` on the printed URL.

- [ ] **M29-socket-resume** (`0013` Client policy). *Steps:* three runs each of: another app 5 s; 30 s; 5 min; screen lock 60 s; Wi-Fi → cellular in the foreground; airplane mode 15 s. Per run copy from the on-page link log: `close` delivered (ms after `visible`) or silence; ms from `visible` to `Welcome`; page discarded or not. *Pass:* `visible → Welcome` median ≤ 1.5 s and max ≤ 4 s: keep the `0013` numbers. *If it fails:* silence with median > 2 s → lower the probe deadline toward one heartbeat interval plus margin; prompt `close` everywhere → numbers stay, note it. Any change is a new ADR amending `0013` Client policy.
- [ ] **M29-play-through-drop** (`0013` Client policy). *Steps:* keep panning during each drop above. *Pass:* the game stays interactive on last known state; the indicator appears only after the delay `0013` states; no modal for short outages.
- [ ] **M29-net-heap** (`0015` §2, `0016`). *Steps:* 10 min connected with steady traffic. *Pass:* no visible periodic hitch (the net worker's garbage stays off the main thread).
- [ ] **M29-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** <device, OS, network, date>; **result:** <table of runs: close/silence, ms to Welcome, discarded>

---

## M34: Reference multiplayer on real devices

When: M34 ticked. Holds the item M26 owns (own-timer feel) and the item M30 owns (remote motion).

**Open:** on the Mac `pnpm device:serve --tunnel --app reference --ws`; the reference game on the phone on the printed URL, joined through the invite link; the same world in desktop Chrome on the Mac.

- [ ] **M34-two-devices**. *Steps:* phone and Mac join one LAN world; collect on one, place on the other. *Pass:* each sees the other's circle and changes; roster dots go hollow after a disconnect plus the grace of `0013` and fill on return.
- [ ] **M34-own-timer-bar** (`0012` completion gap; owner [M26's brief](26-prediction-rendering-and-clocks.md), Planning decisions). The rule is decided: stretch over `duration + lead` (Q10). *Steps:* start own timers on Wi-Fi, then on a throttled or cellular link. *Pass:* each bar starts at the tap and reaches full as the result arrives, with no full bar left waiting and no result before the bar is full. *If it fails:* a bar that waits or overshoots is a lead-estimate or `own_progress` bug: record RTT and the gap, fix under M26.
- [ ] **M34-remote-motion** (`0012` "Remote motion"; owner M30). *Steps:* move on the Mac and watch the phone; then turn the Mac's Wi-Fi off. *Pass:* the remote circle moves without snapping; it fades per `0012` when its player drops. *If it fails:* plan edit against M30's adaptive delay.
- [ ] **M34-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. All items in Chrome.

**Run on:** <devices, OS, network, date>; **result:** <per item>

---

## M35: Built reference game in real Safari

When: M35 ticked.

**Open:** the `vite build` + `vite preview` output of `games/reference` (`pnpm device:serve --app reference`): on the Mac over loopback; on the iPhone with `--tunnel`.

- [ ] **M35-safari-build-mac** (`0017` §4). *Steps:* load in desktop Safari. *Pass:* the game plays; the debug line reports wasm delivery `module` (`url` only if M35 item (c) built the automatic fallback). *If it fails:* M35 item (c): the automatic `wasmUrl` fallback becomes required; plan edit.
- [ ] **M35-safari-build-iphone**. Same on the iPhone. *Pass / If it fails:* as above.
- [ ] **M35-capability** (`0018` §7). *Steps:* open the game in a browser with no `navigator.gpu` (for example Safari with the WebGPU feature flag off). *Pass:* the capability screen appears with `no-webgpu`; no blank page.

**Run on:** <device / browser, OS, date>; **result:** <delivery mode per browser>

---

## M37b: Renderer recovery after backgrounding

When: M37 ticked (the `rendererLost` prompt is M37's `status.ts`; M37b builds the recovery).

**Open:** the reference game on the iPhone (`pnpm device:serve --tunnel --app reference`).

- [ ] **M37b-ios-background** (`0018` §8). *Steps:* play; background the tab for several minutes under memory pressure (camera app, a few heavy pages); return. Three runs. *Pass:* every run ends with the world drawn again without a reload, or with the `rendererLost` prompt; 0 frozen or black canvases. *If it fails:* record which; plan edit against the device-loss sequence of `0018` §8.

**Run on:** <device, OS, date>; **result:** <per run: redrawn / prompt / reload / black>

---

## M38: Hosted deployment

When: M38 ticked. Q6: the Workers plan and the Fly machine are approved; the Cloudflare Pages deploy is not, so there is no static host. The Fly machine serves the client (`games/reference-server --static`, which sets COOP/COEP on every response) and `/ws` on one origin (M38's brief, Scope B).

**Not checked here, carried forward:** the COOP/COEP listings of `0015` §3 on a real static host, and a cross-origin `wss`. Unverified; open item in [M39b](39b-phase-4-handoff.md).

**Open:** the Fly URL on the iPhone, **on cellular** (Wi-Fi off); add `?linklog=1` for M38-socket-resume (the hosted build's link log, M38's brief, Planning decisions). No local serving.

- [ ] **M38-hosted-boot** (COOP/COEP from the reference server's static handler on a real deployment; same-origin `wss`). *Steps:* open the URL. *Pass:* the page is cross-origin isolated, gets an adapter, and reaches `online` on the same Fly origin, including the first load that wakes a stopped machine. *If it fails:* compare with `scripts/check-coi.mjs <url>`; plan edit against the `--static` handler or the Fly recipe.
- [ ] **M38-socket-resume**. *Steps:* with `?linklog=1`, each step of M29-socket-resume once over the real network; record `visible → Welcome` from the on-page log. *Pass / If it fails:* as M29-socket-resume.
- [ ] **M38-remote-motion**. *Steps:* M34-remote-motion with the phone on cellular and the Mac on Wi-Fi. *Pass / If it fails:* as M34-remote-motion.

**Run on:** <device, OS, carrier, date>; **result:** <per item; ms to Welcome>

---

## M39: Acceptance

When: last. On the final build, after every other section has a result line. M39 re-runs rather than trusting old ticks (M39's brief, Planning decisions).

**Open:** the reference game: single-player, then through `games/reference-server`, then the hosted deployment of M38; the fixture pages served as above for the re-run.

- [ ] **M39-rerun**. *Steps:* untick and re-run every item of every section above on the final build. *Pass:* each item's own criterion; every section gets a new **Run on** line.
- [ ] **M39-large-save** (`0007` §8; handed over by M07, Planning decision 11; `?bench=large-save` from M36). *Steps:* load the standard large save on the iPhone in single-player; play 10 min. *Pass:* `engine_mem_grows` = 0, no tab reload, and the bench HUD's `tick p95` is at or under the phone sim-worker figure of the Tick time row (`PRE-PLAN.md` §7; owner `0010`). *If it fails* on memory: decide which default drops first (`0007` §8: entities are the memory problem), by ADR; on tick time: plan edit against M36's tick benchmark, or an ADR changing the number.
- [ ] **M39-frame-shares** (`PRE-PLAN.md` §7 Frame time row, baseline-phone shares; owner `0018` §9). *Steps:* on the same `?bench=large-save` page, zoom out fully over the dense base and pan slowly for 60 s; copy the bench HUD. *Pass:* `main p95` and `frame p95` are each at or under that row's phone figure for the main rAF callback and the client-worker `frame` (the GPU share is M09b-fill-rate's). *If it fails:* run the `profile-frame` skill on the desktop proxy for the same view; plan edit against the share that missed.
- [ ] **M39-full-game-touch**. *Steps:* play the script of `34b-reference-scripted-single-player.md` by hand: spawn, mine to the unlock, craft, place with tap-then-confirm, pick the empty furnace up and place it again, fuel, smelt, take. *Pass:* every step works by touch; buttons and the furnace panel stay glued to their tiles; 10 min with no reload and no visible hitch.
- [ ] **M39-two-devices**. *Steps:* phone and Mac in one hosted world (LAN world if M38 was not run). *Pass:* each sees the other's circle move smoothly; roster dots follow a disconnect after the grace and the return; a furnace placed on one appears on the other.
- [ ] **M39-desktop-browsers**. *Steps:* desktop Safari and Firefox on the Mac, 5 min of play each. *Pass:* 0 validation errors in the console; no periodic hitch.
- [ ] **M39-android** *(Android. **Not run: no device** (Q5). Skipped; never tick.)*. M39-full-game-touch and M39-two-devices in Chrome.
- [ ] **M39-sign-off**. *Steps:* Tyler plays the reference game from start to furnace output, single-player and with a second player. *Pass:* Tyler signs off. *If it fails:* each objection becomes a plan edit.

**Run on:** <device model, OS version, date>; **result:** <per item>; **sign-off:** <Tyler, date>
