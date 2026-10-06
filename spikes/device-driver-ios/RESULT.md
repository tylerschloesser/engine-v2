# Spike: driving the engine's device checks on the iPhone over USB (2026-10-05)

Device: iPhone 12, iOS 27.0.1, Safari 27.0.1 (its UA still says `iPhone OS 18_7`), Mac Xcode 27.0, safaridriver 27.0.1,
pymobiledevice3 11.23.0 (`pipx install`), Appium 3.8.0 + xcuitest 12.15.0. Page under test: fixture app `device.html`
over a `device-serve.mjs --tunnel` copy on port 4620 (all processes started here were killed afterwards).
Scripts here are throwaway-quality plain Node `.mjs` plus one shell script; `wd.mjs` is a 40-line W3C client.

## Verdict per leg

| Leg | Result |
|---|---|
| A. safaridriver, no signing | Works once Remote Automation is on (first attempt: "Remote Automation is turned off"). Navigate, JS, `__check.readings()`, one-finger touch actions, screenshot all work. **Two-finger pinch does not: see below.** |
| B. pymobiledevice3, no signing | Works, no sudo (the CLI falls back to a no-root userspace tunnel by itself). Screenshot, process list, kill, launch by bundle id. URL open needs `xcrun devicectl ... --payload-url` (`pymobiledevice3 webinspector launch` hung, 90 s, with no output). |
| C. WDA via Appium | Works after Tyler's Trust tap. Rotate, Home and back, real two-finger pinch (both ways), Airplane Mode and Low Power Mode toggles and full screenshots all ran. Page JS is readable through Appium's WEBVIEW context while WDA drives (no Guided Access). Lock/unlock not tried (needs the passcode). |

## Leg A evidence (`01-probe.mjs`, `02-gestures.mjs`, `03-pinch-debug.mjs`, `04-persist.mjs`, `06-background.mjs`)

Session: `safaridriver -p 4630`, caps `{platformName:"iOS", browserName:"safari", "safari:deviceUDID":"0000...1E"}`.
Only one session at a time ("already paired with another WebDriver session" until `DELETE /session/<id>`).
`setWindowRect: false` in the returned capabilities.

```
coi true secure true
viewport [innerWidth 980, innerHeight 1756, dpr 3, visualViewport.scale 0.398, scroll 0,0, portrait-primary]
adapter.info {"vendor":"apple","architecture":"apple",...,"isFallbackAdapter":false}   workers ready: true
readings {"isolated":true,"adapter":"apple/apple","workers_ready":true,"delivery":"posted Module","orientation":"portrait",
 "canvas_w":1959,"canvas_h":3713,"tiles_across":12,"centre_x":0,"centre_y":0,"raf_p95_ms":17.68,"gpu_p95_ms":19.06,...}
```

Gestures (readings `tiles_across`, `centre_x/y`; all values finite after every action; `visualViewport.scale` and `scrollX/Y`
never changed, so the page itself did not zoom or scroll in any step):

| Action (W3C, `pointerType: touch`) | Readings change |
|---|---|
| pan 400 px left, 400 ms | centre_x 0 -> 2.579 |
| pan 300 px diagonal | centre 2.579,0 -> 0.646,-1.946 |
| flick (500 px in 60 ms) | centre_x 0.646 -> 3.878 (glide, then stop) |
| tap (490,900) | `taps` 0 -> 1, tap tile (-28,-8), cursor_valid true |
| double-tap | no change in taps or zoom (not examined further) |
| pull down from y=5 | centre_y -1.946 -> -6.444 (camera pans; page does not scroll or refresh) |
| pinch in / out, 10 runs | **`tiles_across` stays 12; centre drifts about 1.9 tiles per run** |

**Pinch finding.** The pointer log of a two-pointer action (`03-pinch-debug.mjs`) shows iOS safaridriver does not make two
simultaneous touches. The page saw one `pointerdown` (one pointerId), `touchstart` with `touches.length 1`, then
`touchmove` events whose x alternates between the two fingers' positions (440, 538, 440, 538, ...), and no `pointerup`.
So W3C actions cannot pinch on iOS. The M39g NaN pinch regression cannot be reproduced through safaridriver. Pinch
needs WDA (`mobile: pinch`, or XCUITest `twoFingerTap`/touch actions with two fingers), or `__check.act`/in-page synthetic input.

**Persistence.** OPFS, localStorage and cookies written in one session are gone in the next (`ls: null, opfs: [], cookie: ""`,
quota 41 GB, `persisted: false`): the automation session uses an ephemeral store. M23 kill/resume or world-busy across
sessions cannot be shown inside safaridriver; it can be shown in ordinary Safari (see B).

**Human, background, rotate.** While a session is open, launching another app fails with `Guided Access active
(FBSOpenApplicationErrorDomain error 1)` (devicectl), and `pymobiledevice3 developer dvt launch com.apple.Preferences`
fails with "Failed to launch process". Safari stays frontmost and visible (`visibilityState visible`, frames kept climbing),
so a session blocks the human and cannot background the app. Rotation: no endpoint in safaridriver (`setWindowRect false`).

## Leg B evidence (`05-screenshot-disturb.mjs`, `07-pmd3-lifecycle.sh`)

```
pymobiledevice3 developer dvt screenshot s0.png      # 1.3 s wall, full-screen 1170x2532 PNG, incl. status bar and Safari chrome
process-id-for-bundle-id com.apple.mobilesafari -> 2514 ;  proclist -> 2211 lines (bundleIdentifier, name, pid)
developer dvt kill 2514 -> pid lookup returns 0 ;  launch com.apple.Preferences ; launch com.apple.mobilesafari -> new pid 3019
xcrun devicectl device process launch --device <udid> --payload-url <https url> com.apple.mobilesafari   # opens the URL, no signing
```
Safari's tab was restored after kill and relaunch (the page showed again). Without a session the human is not blocked.

Screenshot during the 10 s rAF/GPU window (`device.html`, 10 s rolling windows, three 1.3 to 1.7 s screenshots inside):

| window | p50 | p95 | worst | >20 ms | gpu p95 |
|---|---|---|---|---|---|
| baseline x3, no shot | 16.7 | 17.2 / 17.5 / 17.6 | 18.5 / 25.5 / 22.9 | 0 / 3 / 2 | 18.4 / 18.1 / 18.9 |
| with 3 shots, run 1 | 16.7 | 17.7 | 22.9 | 4 | 18.5 |
| with 3 shots, run 2 | 16.7 | 17.66 | 24.0 | 7 | 19.9 |
| after, no shot | 16.7 | 17.72 | 21.4 | 2 | 24.6 |

p95s moved by 0.1 ms; the >20 ms count hit 7 once (budget 5 per 10 s) and the gpu p95 was also 24.6 on an undisturbed window.
Inconclusive but suspect: do not screenshot inside a measuring window; screenshot before or after it.

## Leg C evidence (`ap.mjs`, `11-wda-legs.mjs`, `12-wda-pinch.mjs`, `13` to `19`)

Setup: `appium -p 4725` then `POST /session` with `caps.json` (Xcode team `Z5N9W23WW4`, `updatedWDABundleId com.tylerschloesser.WebDriverAgentRunner`,
`allowProvisioningUpdates`, `bundleId com.apple.mobilesafari`). Free-team profile: expires in 7 days.
`xcodebuild build-for-testing -allowProvisioningUpdates` created the cert `Apple Development: tylerschloesser@gmail.com (33F737MFNK)`; the first launch failed
with "Developer App Certificate is not trusted"; after Tyler's Trust it ran.

Page readings come from Appium contexts: `GET /contexts` lists `NATIVE_APP` and several `WEBVIEW_*` (Safari extension pages too); switch to each and pick the one whose
`location.href` contains `device.html`; `execute/sync` then runs page JS (`window.__check.readings()`). `crossOriginIsolated` true. Switch to `NATIVE_APP` to send touches.
Open the page with `mobile: deepLink {url, bundleId: com.apple.mobilesafari}` (118 ms). Viewport here is 390x844 points, canvas 780x1478 (the page still had the old viewport meta
in this dist: see surprises).

| Action | Time | Evidence |
|---|---|---|
| new session, WDA already running | 3 to 4 s | |
| new session, WDA not running (cold start) | up to 4.5 min | first call timed out in my script at 250 s while WDA was still starting; retry then took 28 s total. Use a 10 min client timeout. |
| rotate to LANDSCAPE (`POST /orientation`) | 1.0 s (+2.5 s settle) | readings `orientation: landscape`, canvas 1688x780, one `resize` event 844x280; PORTRAIT 0.5 s back: `portrait`, 780x1478 |
| `mobile: pressButton home`, 5 s, `mobile: activateApp` | 0.5 s + 0.3 s | page got `visibilitychange` `hidden` at 31.997 s and `visible` at 36.179 s; `frames` kept counting after return; no reload |
| W3C two-touch pinch via WDA `POST /actions` | 1.3 to 1.4 s each | page sees 2 pointerIds, `gesturestart`, ~37 `gesturechange`, 2 `pointerup`; `visualViewport.scale` stays 1 |
| `mobile: pinch {scale, velocity}` | 0.9 to 3.3 s | real two-finger events arrive, but `scale 2.5` left `tiles_across` at 12 (already at its minimum) and `scale 0.3` over the page opened Safari's tab overview once (the screenshot showed it): prefer W3C actions inside the page |
| full-screen screenshot (`GET /screenshot`) | 0.25 to 0.6 s | PNG 1170x2532 with status bar and Safari chrome |
| open Control Center (`mobile: dragFromToForDuration` 360,2 -> 360,500) | 2.3 to 2.6 s | |
| tap Airplane Mode tile (`mobile: tap 194,163`) on, then off | 0.6 s, 0.7 s | tile `On`, status bar plane icon, Wi-Fi tile `Off`; then `Off`, Wi-Fi back (`.Woodhouse`); ended OFF |
| Low Power Mode on and off | 2.0 s, 1.8 s | see below; value `0 -> 1 -> 0`, ended OFF |

Pinch results (W3C, two fingers 600 ms, readings `tiles_across`, always finite). Pinch IN (fingers together, zoom out): 12 -> 81.8 -> 256 (limit);
second run 12 -> 85.0 -> 256. Pinch OUT from 256: 33.6 -> 12 (limit) -> 12. So both limits are reached in a few gestures and nothing went NaN.
No `visualViewport` change, no page scroll.

Control Center, iOS 27 on this phone: it opens on the connectivity page (Airplane Mode tile, Wi-Fi, AirDrop, Cellular, Bluetooth); the main page has no Low Power Mode tile
(Add a Control would change Tyler's layout; I tapped `+` once, which put Control Center in edit mode, and left it with Home, not changing anything). The toggle is in
Settings > Battery: `mobile: activateApp com.apple.Preferences` (session created with `appium:bundleId com.apple.Preferences`), tap the Battery row
(100,705), then the switch with accessibility id `LOW_POWER_MODE_IDENTIFIER_SWITCH` (click, read attribute `value`). The phone has no SIM ("No SIM"), so Airplane Mode here
only drops Wi-Fi: the Wi-Fi to cellular and airplane steps of M29 cannot be exercised on this device, but Wi-Fi off/on can.

Not done: lock/unlock (Tyler wants the screen on; WDA unlock needs the passcode). Final state: unlocked, Safari in front, Airplane Mode OFF, Low Power Mode OFF.
Flaky: the first Control Center drag sometimes lands on the last-used page; Appium and the 4620 server were killed once by an external cleanup mid-run.

## Per check family

Legend: A = safaridriver, B = pymobiledevice3/devicectl, C = WDA (pending Trust; untested), H = human.

| Check | Verdict | Mechanism / what remains |
|---|---|---|
| M03 determinism page | fully automatable | A: load `determinism.html`, read banner and `crossOriginIsolated` (verified on device.html). Or C's WEBVIEW context. |
| M08 worldgen ms/chunk | fully automatable | A or C-webview: load, wait, read page output. |
| M09b fill rate | fully automatable (C) | portrait readings verified; landscape via C `POST /orientation` (verified, canvas 1688x780). No screenshots inside the window (B/C). |
| M11-boot | fully automatable | A or C-webview: `isolated`, adapter, `workers_ready`, `delivery` read. |
| M11-gestures | fully automatable (C) | C: pan/flick/tap via W3C touch, pinch both ways via W3C two-touch (verified, finite, limits 12 and 256), rotate, pull-down. A cannot pinch. Judging "world point stays under the finger" needs a position assertion on top. |
| M11-memory | fully automatable | A or C-webview with `?probe=memory&probeS=`. |
| M11-pinch-desktop-safari | still human | Mac trackpad; not the phone. |
| M16 slice boot, round-trip, coexist | fully automatable | C-webview taps and readings; 10 min hold is just time (WDA `newCommandTimeout` 600 s in caps.json; raise it). |
| M16-background | fully automatable (C) | Home + `activateApp` verified: `hidden` then `visible`, no reload. Lock for 60 s needs the passcode (not tried). |
| M16-low-power | fully automatable (C) | Settings > Battery switch verified on/off; readings via webview unverified under Low Power. |
| M18 anchors, pick, fill rate with anchors | fully automatable (C) | continuous pinch and landscape via C; `pick_id` through webview readings. |
| M18-touch-ghost | fully automatable | A or C. |
| M23 OPFS latency, export/import | fully automatable (C) | A's session store is ephemeral; C drives real Safari with a persistent store (export needs the download UI: unverified). |
| M23 kill-resume | with caveat | B kill then `devicectl --payload-url` relaunch restored the tab; read results with the webview after C reattach or by screenshot. |
| M23 world-busy, private | with caveat | second tab and Private Browsing are Safari UI: C taps (tab overview verified by accident). |
| M23 hidden-pause | fully automatable (C) | Home + wait 30 s + `activateApp`; read `tick` before and after. |
| M29 socket resume | with caveat | app switch 5 s / 30 s / 5 min: C. Airplane: C toggle verified (phone has no SIM, so no real cellular fallback; Wi-Fi off/on works). Screen lock: passcode. |
| M34 two devices | fully automatable | C for the phone, the Mac as second client (the walk's bot partner). |
| M35 built game, capability screen | with caveat | iPhone boot: C. "no `navigator.gpu`" needs the Safari WebGPU feature flag toggled in Settings > Apps > Safari > Advanced (C can navigate, unverified). |
| M37b renderer recovery under memory pressure | with caveat | C can launch heavy apps (Camera, pages in other tabs), then return; "memory pressure" is not controllable, results are probabilistic. |
| M38 hosted deployment | fully automatable | A or C against the real URL; the cellular leg needs a SIM (none). |
| M39 acceptance | with caveat | scripted large-save / frame-share runs and two-device play via C; "feel" and Tyler's sign-off stay human. |

## Surprises
- Under safaridriver the page laid out at 980 px (`visualViewport.scale 0.398`, W3C coordinates 0..980) because the dist then had `viewport-fit=cover` without `width=device-width`;
  under WDA/ordinary Safari at that dist it laid out at 390 px. The orchestrator says the dist now has the M39h viewport fix (innerWidth about 390); scripts in `02-gestures.mjs` use 980-wide coordinates and need rescaling.
- Safari relaunched by `devicectl --payload-url` or `dvt launch` with no session open showed the page; the green block in the screenshots was not investigated (Tyler's own look at a normal render is needed).
- `pymobiledevice3 webinspector launch|opened-tabs` hung even with Web Inspector on; `devicectl` (Xcode, no signing needed) is the working URL opener.
- WDA reads the page and drives real touches at once; safaridriver is only for reads and one-finger touch and blocks the phone. If one tool must be chosen, it is Appium/WDA.
- Files: `wd.mjs`, `ap.mjs`, `10` to `19` (WDA legs), `01-probe`, `02-gestures`, `03-pinch-debug`, `04-persist`, `05-screenshot-disturb`, `06-background`, `07-pmd3-lifecycle.sh`, `caps.json`.
