# Manual device checks

Tyler-run checks on real hardware: the things Phase 3 cannot automate (`0020` §10, `PRE-PLAN.md` §9 risk 1). One section per milestone marked **D** in `PLAN.md`. A check never blocks the next milestone; a failed check opens a plan edit (`PLAN.md`, "How milestones work"), and where an ADR number changes, a superseding ADR.

This file is a skeleton written in Phase 2. The session that lands a **D** milestone replaces the skeleton steps of its section with the exact page, URL parameters and thresholds it built, keeping the item ids. Other briefs append items under **More items**; keep ids unique (`M<NN>-<slug>`).

## Devices

- **iPhone**, 12-class or newer, iOS 26+, Safari. Assumed available. Low Power Mode off unless an item says otherwise.
- **Android**, mid-range 4 GB, Chrome: open question Q5 (`docs/plan/questions-for-tyler.md`). Default: no device, so Android items are marked *(Android, if Q5)* and skipped; desktop Chrome is covered by the automated suites, not by this file.
- **Mac** (Tyler's): desktop Safari and Firefox for the few items that name them.

## Serving a page to a phone

`crossOriginIsolated`, WebGPU and OPFS need a **secure context**. `http://<LAN IP>:port` is not one, so it will not work, and the page will report "not isolated". Every response must also carry the COOP/COEP pair of `0015` §3, including the worker script.

Serve per M03. `<<serve>>` TODO: replace this marker with the one command and URL form once M03 lands. M03's brief proposes `pnpm device:serve --tunnel` (a Cloudflare quick tunnel printing an `https://` URL; fallback `mkcert` + `preview.https`); M09b's brief names `pnpm device` for the device page. One of the two names must win before M11's section is run.

Multiplayer items (M29 onward) also need `wss://`: an HTTPS page cannot open `ws://` to a LAN address. M29's brief proxies `/ws` on the page's own HTTPS origin; use that.

## Recording a run

Under each section, add a row per run: `date · device + OS version · build hash shown by the page · item id · PASS / FAIL · numbers or notes`. On FAIL, follow the item's fallback, re-run, and record both rows.

---

## M11: first on-device run (camera and input)

First time engine code runs on the phone. Also the first scheduled run of the items owned by M03, M08 and M09b, which exist by now.

**Open:** `<<serve>>`, then the device page in Safari; the determinism page for `M03-determinism`.

- [ ] **M11-boot.** Page loads. *Pass:* HUD shows cross-origin isolated, a WebGPU adapter, and workers ready from a posted `Module`. *If it fails:* reopen with the `module=url` parameter; if that passes, plan edit making the URL path Safari's default (`0017` §4; `PRE-PLAN.md` risk 1: `instantiateStreaming` in the worker).
- [ ] **M03-determinism** (`0002`). Open the determinism page. *Pass:* every checkpoint hash equals its golden; one PASS banner. *If it fails:* there is no fallback by design: record the first divergent checkpoint and the user agent, open a plan edit; suspects in order are an observable NaN (`0002` §2) and a toolchain difference.
- [ ] **M11-memory** (`0015` §5 arena sizes and the whole-tab target). Run the memory probe: largest reservable memory; default topology beside a WebGPU context for two minutes; the same with every arena page touched. *Pass:* no reload in either two-minute run. *If it fails:* re-run with the smaller arenas the probe offers; if that survives, plan edit lowering the mobile defaults by a superseding ADR for `0015` §5. Record the largest reservation either way.
- [ ] **M09b-fill-rate** (`0018` Consequences). Maximum zoom-out, render scale 2, auto-pan, portrait then landscape, 60 s each. *Pass:* steady 60 fps and GPU time inside the share of `0018` §9; no hitch while chunks stream in. *If it fails,* in the order `0018` states: lower the render-scale cap (two steps), then drop neighbour reads below the pixel cutoff, then the per-chunk-quad fallback (a new brief). The first passing configuration becomes the mobile default.
- [ ] **M08-worldgen-ms-per-chunk** (`0008` §6). Run the worldgen bench page. *Pass:* at or under the per-chunk phone budget of `0008` §6. *If it fails:* revisit the budget and the gen-worker count (`0008` Consequences); plan edit.
- [ ] **M11-gestures** (`0019` §3). One-finger pan, flick, pinch to both zoom limits, tap a tile, pull down from the top edge, double-tap, rotate the phone. *Pass:* the world point stays under the finger; inertia glides and stops; the HUD shows the tapped tile; the page never scrolls, zooms or refreshes; rotation keeps the centre. *If it fails:* the named knob (inertia constant, tap thresholds, page CSS helper of `0019` §3) and a plan edit.
- [ ] *(Android, if Q5)* repeat every item above in Chrome.

**More items** (append below; keep the checkbox + Pass + If-it-fails shape):

**Runs:**

---

## M16: vertical slice on the phone

**Open:** `<<serve>>`, the M16 fixture page (single-player: main + client + sim + gen).

- [ ] **M16-round-trip.** Tap the fixture's action control ten times. *Pass:* each tap's result shows within a perceptible instant; the page's counters show ten `Confirmed`, zero ring drops.
- [ ] **M16-coexist** (`0015` §5 whole-tab target). Play and pan for ten minutes (`0020` §10). *Pass:* no reload, no visible hitch, `engine_mem_grows` stays 0 on every instance. *If it fails:* the smaller-arena configuration from M11-memory, then a plan edit for `0015` §5.
- [ ] **M16-background.** Switch to another app for 30 s and return; lock the screen for 60 s and return. *Pass:* the frame loop and the tick loop resume without a reload; the tick counter did not advance while hidden (`simulation.md`, idle worlds).
- [ ] **M16-low-power.** Turn Low Power Mode on. *Pass:* motion speed is unchanged at the halved frame rate (`0019` Context: time-based motion).

**More items:**

**Runs:**

---

## M18: picking and overlay anchoring

**Open:** `<<serve>>`, the device page with the anchors parameter (50 anchors).

- [ ] **M18-anchors** (`0019` Consequences). Pan, flick and pinch for 30 s with 50 DOM anchors mounted. *Pass:* zero swim between anchors and canvas, crisp text at every zoom, no visible style-recalc hitch while pinching. *If it fails:* the fallback `0019` states (per-anchor `translate()` writes from the same rAF callback); re-run; plan edit and a note against the overlay line of `0016`.
- [ ] **M18-fill-rate-with-anchors.** Repeat M09b-fill-rate with the anchors mounted (`0019` combines the two checks). *Pass / fallback:* as M09b-fill-rate.
- [ ] **M18-pick.** Tap small and overlapping drawables at three zoom levels. *Pass:* the HUD reports the topmost drawable's `pick_id` every time; a tap on a DOM widget reports nothing to the canvas.
- [ ] **M18-touch-ghost.** Tap to move the cursor tile, then drag. *Pass:* the ghost sits on the tapped tile; the drag pans.

**More items:**

**Runs:**

---

## M23: OPFS and world lifecycle

**Open:** `<<serve>>`, the OPFS latency page, then the M23 fixture world. OPFS also needs the secure context.

- [ ] **M23-opfs-latency** (`0005` Consequences; tunes only the log `sync` interval). Run the latency page; record the table. *Pass:* `flush` p95 inside the "keep" band of M23's brief (Planning decision 7). *If it fails:* apply that decision's retune rule; any change is a superseding ADR for the number in `0005`. Note whether the OPFS rename call exists (M23 decision 3).
- [ ] **M23-kill-resume.** Play two minutes, swipe-kill Safari, reopen. *Pass:* the world resumes; no admitted action is lost (`0005` loss windows).
- [ ] **M23-world-busy.** Open the same world in a second tab. *Pass:* the second tab shows `WorldBusy`; the first keeps playing.
- [ ] **M23-private.** Private Browsing. *Pass:* the page reports `durable: false` and still plays.
- [ ] **M23-hidden-pause.** Background 30 s, foreground. *Pass:* no ticks ran while hidden; no reload.
- [ ] **M23-export-import.** Export; the file arrives in Files; import under a new id. *Pass:* both worlds show the same hash.

**More items:**

**Runs:**

---

## M29: net worker and reconnect on a real network

**Open:** `<<serve>>` with `/ws` proxied on the same HTTPS origin; `games/reference-server` (or the M29 fixture server) on the Mac; the page with its link-log parameter.

- [ ] **M29-socket-resume** (`0013` Consequences; tunes only the dead timeout and the probe deadline). Three runs each: another app for 5 s, 30 s, 5 min; screen lock 60 s; Wi-Fi to cellular in the foreground; airplane mode 15 s. Copy from the link log: whether `close` was delivered or the socket went silent, the time from `visible` to `Welcome`, whether the page was discarded. *Pass:* the keep rule in M29's brief (Manual device checks, step 3). *If it fails:* that brief's tuning rule; any change is a new ADR amending `0013` Client policy.
- [ ] **M29-play-through-drop.** Keep panning during each drop. *Pass:* the game stays interactive on last known state; the indicator appears only after the delay of `0013`; no modal for short outages.
- [ ] **M29-net-heap.** Ten minutes connected with steady traffic. *Pass:* no visible periodic hitch (the net worker's garbage is quarantined, `0015`, `0016`).

**More items:**

**Runs:**

---

## M39: acceptance

Run on the final build, after every other section has a PASS row or a recorded plan edit.

**Open:** `<<serve>>`; the reference game, single-player, then through `games/reference-server`, then the hosted deployment of M38.

- [ ] **M39-rerun.** Re-run M11-boot, M03-determinism, M09b-fill-rate, M18-anchors, M23-kill-resume, M29-socket-resume on this build. *Pass:* each item's own criterion.
- [ ] **M39-full-game-touch.** Play the script of `34b-reference-scripted-single-player.md` by hand: spawn, mine to the unlock, craft, place with tap-then-confirm, fuel, smelt, take. *Pass:* every step works by touch; buttons and the furnace panel stay glued to their tiles; ten minutes without a reload or a visible hitch.
- [ ] **M39-two-devices.** Phone and Mac in one hosted world. *Pass:* each sees the other's circle move smoothly; roster dots follow a disconnect after the grace and the return; a furnace placed on one appears on the other.
- [ ] **M39-desktop-browsers** (`0018` Consequences: the zero-GC harness shape by hand). Desktop Safari and Firefox on the Mac: play five minutes. *Pass:* no validation error in the console, no periodic hitch.
- [ ] *(Android, if Q5)* M39-full-game-touch and M39-two-devices in Chrome.

**More items:**

**Runs:**

---

## Items owned by milestones without a **D** in `PLAN.md`

Sibling briefs link here; each should either get a **D** in `PLAN.md` or have its item run with the section named.

| Item | Owner brief | Run with |
|---|---|---|
| M03-determinism | `03-browser-harness.md` | M11 |
| M08-worldgen-ms-per-chunk | `08-worldgen-and-gen-worker.md` | M11 |
| M09b-fill-rate | `09b-terrain-art-and-lifecycle.md` | as soon as M09b is ticked; again in M11, M18, M39 |
| M34-own-timer-bar: own progress bars on a real network (`0012` completion gap; decision recorded in M34's Deviations) | `26-prediction-rendering-and-clocks.md`, `34-reference-multiplayer.md` | after M34 |
| M34-two-devices-lan: two devices, one LAN world through `games/reference-server` | `34-reference-multiplayer.md` | after M34 |
| M35 entries (real Safari loads the built reference game) | `35-packaging-and-adapters.md` | after M35 |
| M37 entry (background under memory pressure, renderer recovery) | `37-robustness-events.md` | after M37 |
| M38 section (hosted page on cellular; M29's steps over the real network) | `38-hosting-checks.md` | after M38 |
