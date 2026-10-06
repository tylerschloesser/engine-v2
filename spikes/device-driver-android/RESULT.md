# Spike: can the Mac drive the device checks on a Pixel 5 over USB, no human?

Date 2026-10-05. Pixel 5 (`13061FDD4002VN`), Android 14, Chrome 154.0.8037.92, USB. Page: fixture app `device.html`
served by `ENGINE_TEST_PORT=4610 node packages/engine/scripts/device-serve.mjs --no-build` (no tunnel; `--no-build` so
`dist/` of the live iPhone round is never rewritten), phone reaches it as `http://localhost:4610` via `adb reverse`.
Code: this directory (plain Node `.mjs`, `@playwright/test` from the repo, raw CDP in `lib.mjs`). Screenshots/logs were
kept in the session scratchpad, not committed.

**Verdict: yes for most of it.** Everything a page can report (`__check.readings()`) is readable; pan, flick, tap,
double-tap, pull-down are real OS input (`adb shell input`); pinch is CDP-injected (not OS-level); rotation, Home/back,
force-stop, airplane flag are plain `adb`. A full M11-gestures equivalent runs in about 42 s (`11-m11-gestures.mjs`).

## 1. WebGPU works (`01-attach.mjs`)
`am start -a android.intent.action.VIEW -d http://localhost:4610/device.html com.android.chrome`, then
`adb forward tcp:9222 localabstract:chrome_devtools_remote` and `chromium.connectOverCDP('http://127.0.0.1:9222')`.
```
crossOriginIsolated true, isSecureContext true, SharedArrayBuffer function, hardwareConcurrency 8, deviceMemory 8
adapter: vendor qualcomm, architecture adreno-6xx, isFallbackAdapter false, maxBufferSize 1073741824
features: shader-f16, timestamp-query, texture-compression-astc/etc2, float32-blendable, ... (17)
readings: isolated true, adapter qualcomm/adreno-6xx, workers_ready true, delivery "posted Module"
```
- Chrome's UA is reduced ("Android 10; K"): do not parse it for the model. `navigator.gpu.requestAdapter().info.device`
  and `.description` are empty.
- Performance, not capability, is the issue: `device.html` boots at a canvas of 1960x3999 px (`render_scale 2`, dpr 2.75)
  and runs at about 40 fps: `raf_p50 16.7`, `raf_p95 50.1`, `raf_over20 ~134 per 10 s`, `gpu_p95 63-71 ms`. That fails the
  M09b numbers (p95 <= 17.5, GPU p95 <= 6) as served; M09b's `&scaleCap` ladder is the knob. Not investigated further.
- `device.html` has no `<meta name="viewport">`, so Chrome lays out at 980 CSS px (`innerWidth 980`, visual-viewport
  scale 0.4007). Touch coordinates from the OS are physical px; CSS px = physical / 1.102 (and minus the toolbar,
  about 290 px, which is in the way: `clientY = (y - 290) / 1.102`). Works, but a driver must convert.

## 2. Pan and flick (`02*`, `06*`)
`adb shell input swipe x1 y1 x2 y2 ms` reaches the page as `pointerType: touch` events, kernel-timed, a real OS path.
- Pan: finger left 400 px, `centre_x 0 -> +1.43` (right direction: the world follows the finger). Finger up: `centre_y +1.99`.
- **Surprise, probable engine bug on real Android input:** after a fast `adb` flick the glide goes the OPPOSITE way.
  `flick 80 ms, finger left`: `centre_x 33.8 -> -196.9` (expected positive), 5 of 5 fast runs. A CDP-injected flick with
  the same geometry glides the right way (`-27.0 -> +37.0`), and a 10 s slow `adb` swipe glides the right way (`0 -> 33.8`).
  The difference in what the page sees: OS input arrives as 6 to 9 events with large coalesced batches
  (`mm@45437:544/c28`), CDP input as one event per move (`/c1`). Trace in `06b-flick-events.mjs`. Suspect the velocity
  estimate in `input/` when `getCoalescedEvents` batches or a 1 ms gap between the last move and `up`. This is what
  an OS-level driver finds and CDP cannot. The glide itself decays and stops (`-196.89` stable one second later).

## 3. Pinch (`03`, `04`)
| Mechanism | Result |
|---|---|
| `adb shell sendevent /dev/input/event2 ...` (two-slot MT protocol B, `sec_touchscreen`) | DENIED: `Permission denied` (node is `root:input 0660`, shell is in group `input` but SELinux refuses). `adb root` refused (production build), no `su`. |
| `adb shell input` | single pointer only (`tap`, `swipe`, `motionevent`, `draganddrop`). No multi-touch. |
| CDP `Input.dispatchTouchEvent` with 2 touch points | WORKS. Page sees `pointerType: touch`, 2x `pointerdown`, `touchstart/2`, 40 `pointermove`. Zoom changes both ways. Injected inside Chrome, not OS input, so no Android gesture detector involved. |
| CDP `Input.synthesizePinchGesture` | WORKS (zoom 12 -> 41.8 for scale 0.3), page events have `pointerType ""` (not `touch`). Spread by 2.5x from the 12-tile minimum is a no-op (limit). |
| UiAutomator / UiAutomation `injectInputEvent` (true OS multi-touch) | Not tried: needs a small instrumentation APK; this Mac has the SDK build-tools but no JRE (`java` is a stub). `brew install openjdk` would unblock it. |

Limits: `tiles_across` stays within 12 to 256; 6 spreads reach 12, 8 pinches reach 256, always finite
(`11-m11-gestures.mjs`: `31.03 12 12 ... 99 256 256`; `centre_*` finite too). Raw pinch of 20 steps takes 1.4 s.

## 4. Tap, double-tap, pull-down (`05*`)
- `adb shell input tap`: page `clientXY (490,644)` for physical `(540,1000)`; HUD `tap_tile` equals the page's own
  `__check.act.tileUnder(clientXY)` in 4 of 4 (e.g. `(-28,-47)`, `(-55,11)`), `cursor_tile` same.
- Double-tap (two `input tap` 0 ms apart): `taps` +1 (the engine coalesces), `tiles_across` unchanged, visual-viewport scale
  0.4007 unchanged. Pull-down from y=330 and 420 (just under the toolbar): `performance.timeOrigin` identical,
  `window.__m` marker alive, `scrollY 0`, visual viewport `offsetTop 0`: no reload, scroll or zoom. (The drag does pan
  the camera, as it should.) A pull from y=0 is the Android notification shade, not the page: not meaningful.

## 5. Rotation (`07-rotation.mjs`)
`settings put system accelerometer_rotation 0; settings put system user_rotation 1` (3 = reverse landscape).
`orientation` flips in 139 to 274 ms (`canvas 1960x3999 -> 1960x892`; `screen.orientation landscape-primary` /
`-secondary`), `centre_x` kept to within 0.002 tiles; restored to `accelerometer_rotation 1, user_rotation 0`.

## 6. Device state
| Action | Command | Result |
|---|---|---|
| Home, then back | `input keyevent KEYCODE_HOME`; `am start -n com.android.chrome/com.google.android.apps.chrome.Main` | Works. `visibilityState` hidden then visible, frames advanced 0 in 3 s hidden, loop resumes (about 40 fps), page not reloaded. |
| Force-stop | `am force-stop com.android.chrome` then relaunch by intent | Works (every `open()` does it; also closes the phone's other tabs). |
| Airplane mode | `cmd connectivity airplane-mode enable/disable` | Flag flips without root (`airplane_mode_on 1/0`). USB/CDP unaffected. `navigator.onLine` stayed `true` in both runs and the page was hidden then, so no network effect was shown. Needs a retest with the page visible and a socket page (M29). |
| Battery Saver | `settings put global low_power 1` | Setting flips but while CHARGING the system keeps `Battery Saver is currently: OFF`; no change in fps (41.0 vs 40.3). One earlier run with a faked unplug engaged it; that is off-limits now (it defeats stay-awake). Finding: not testable while plugged in. |
| Screen off/on, lock | not tested | Not tested (Tyler: keep the screen on). One early run did lock the keyguard (no credential; `wm dismiss-keyguard` cleared it on the second try). |
| Low-power frame rate (M16-low-power) | n/a | The saver did not engage, so the halved-rate claim is untested. |

Surprise: Playwright `connectOverCDP` makes the page report `visibilityState "visible"` and `hasFocus` true while the app is
backgrounded (no `visibilitychange` events at all); raw CDP (`lib.mjs: rawCdp`) reports `hidden`/`false` and the events.
Use raw CDP (or `Runtime.evaluate` over the websocket) for every background/foreground check.

## 7. Screenshots and recording (`10-capture.mjs`)
- `adb exec-out screencap -p`: about 0.33 s each, 1080x2340 PNG (about 70 KB). The shots show the Chrome toolbar
  (`localhost:4610/device`) over a black canvas (at 256 tiles the terrain is near black; at boot, 12 tiles, a green
  quadrant). The HUD text did not show in them although it is in the DOM; not investigated. Landscape is 2340x1080.
- `screenrecord --time-limit 10` works (570 KB mp4 pulled via `adb pull`).
- Disturbance (rolling 10 s window, same page state, scene already GPU bound):

| window | raf_p95 | raf_worst | raf_over20 | gpu_p95 |
|---|---|---|---|---|
| idle | 50.14 | 50.4 | 134 | 63.3 |
| screencap x10 in 10 s | 50.14 | 66.9 | 141 | 79.1 |
| idle again | 50.15 | 50.3 | 134 | 70.9 |
| screenrecord 10 s | 50.14 | 83.5 | 164 | 60.9 |

  p95 is unchanged, but worst, over-20 count and (for the capture) GPU p95 rise, and idle-to-idle GPU p95 itself moves
  63 to 71. Do not capture inside a measuring window; capture between windows.

## 8. Timing: scripted M11-gestures (`11-m11-gestures.mjs`), 41.8 s total
boot 1.9 s, 10 s pan 12.8 s, flick 6.7 s, pinch both limits 12 s, tap 2 s, pull-down and double-tap 2.8 s, rotation 3.5 s.
Result: 6 PASS, 1 FAIL (the flick glide direction above: a real finding, not a driver error).

## Per check family (device-checks.md)
Legend: AUTO = fully automatable, CAVEAT = automatable with a caveat, HUMAN = still a person. All "Android: not run"
rows in device-checks.md could be run this way; the iPhone rows are untouched by this spike.

| Section | Verdict | Mechanism |
|---|---|---|
| M03 determinism | AUTO | open `determinism.html` by intent, wait for the banner via CDP, read `crossOriginIsolated`. Not run here; same attach path as `device.html`. |
| M08 worldgen ms/chunk | AUTO | open `worldgen-bench.html`, read the printed table via CDP. Not run here. |
| M09b fill rate | CAVEAT | readings give rAF p50/p95, over-20 and GPU p95 by orientation (rotation by settings). Caveat: the page already fails the budget on this phone (p95 50 ms); CDP attached over USB and captures add noise; "no visible hitch" stays a judgement (a video can be pulled). |
| M11 boot, gestures, memory | CAVEAT | boot and memory probe: AUTO via readings. Gestures: pan, flick, tap, double-tap, pull-down real OS input; pinch is CDP-injected, not OS. Flick glide found to differ by input source. Memory probe is a 2 min wait. |
| M11 pinch desktop Safari | HUMAN | Mac trackpad, not the phone (out of scope of this spike). |
| M16 slice | CAVEAT | boot and round-trip (`__check.act.paint`) AUTO; background by Home/intent AUTO (raw CDP); coexist 10 min is a wait; low-power NOT tested (saver does not engage while charging); screen lock NOT tested (Tyler: keep the screen on). |
| M18 anchors, picking | CAVEAT | `pick_id`, taps, anchor error probe (`anchor_err_max_px`, `anchor_jitter_px`) are numbers; pinch via CDP. Compositor-side swim is invisible to JS: judge by screenshot or video only. |
| M23 OPFS, lifecycle | CAVEAT | latency table AUTO; kill/resume = `am force-stop` + intent AUTO; second-tab WorldBusy AUTO (two intents); background pause by Home AUTO; export download lands in `/sdcard/Download` (`adb pull`). Private browsing: Chrome Incognito intent (`--ez create_new_tab true` with `incognito`) not tried: unverified. |
| M29 net worker, reconnect | CAVEAT | Home, 5 s to 5 min, airplane flag AUTO to drive; but this rig uses USB/`adb reverse`, so the Wi-Fi to cellular and a real link cut are not exercised by airplane mode here (flag flips, CDP stays up). The socket must go over the real network: serve with a tunnel, not `adb reverse`. Wi-Fi/cellular switch: `svc wifi disable` / `svc data enable` (not tried). |
| M34 reference multiplayer | CAVEAT | two clients: phone through CDP plus a Playwright desktop browser (the walker already does this). Own-timer feel and remote-motion smoothness need numbers, not looking: derive from page readings. |
| M35 safari build | HUMAN | Safari/WebKit only; Android Chrome cannot stand in. `M35-capability` (no `navigator.gpu`) could run in Chrome with `--disable-features`, but is a Safari item. |
| M37b backgrounding | CAVEAT | iPhone item. Android analogue: Home, memory pressure via `am send-trim-memory` / heavy app, then return and read `rendererLost`; not tried. |
| M38 hosted | CAVEAT | cellular + the Fly URL: open by intent, read readings. Needs the phone on cellular (Wi-Fi off via `svc wifi disable`, not tried) and no `adb reverse`. |
| M39 acceptance | CAVEAT | re-runs of the above AUTO/CAVEAT. `M39-full-game-touch` is a scripted tap sequence (feasible: taps and tile readings), 10 min wait. `M39-sign-off` HUMAN (Tyler). |

## Driver gotchas
- Use `raw CDP` for visibility; Playwright hides background state.
- `adb exec-out screencap` redirect in zsh needs `>|` if the file exists (noclobber); `cp/rm` aliases per CLAUDE.md.
- Chrome's other tabs (3 open) are all attached through the same 9222 socket: match the page by URL prefix.
- Do not run `dumpsys battery unplug`: it defeats `stay_on_while_plugged_in`.
- Teardown: `adb reverse --remove tcp:4610`, `adb forward --remove tcp:9222`, kill the server (`lib.mjs: teardown`).
