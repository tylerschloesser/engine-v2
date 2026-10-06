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
| C. WDA via Appium | Signing works (cert created by `xcodebuild -allowProvisioningUpdates`, team `Z5N9W23WW4`, WDA built and installed). Launch blocked: **"Developer App Certificate is not trusted"**. Tyler must tap Trust (Settings > General > VPN & Device Management). Nothing past that was run. |

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

## Leg C (WDA), what was done and what is left

Done: `xcodebuild build-for-testing ... -allowProvisioningUpdates DEVELOPMENT_TEAM=Z5N9W23WW4` created the identity
`Apple Development: tylerschloesser@gmail.com (33F737MFNK)` (`security find-identity -v -p codesigning` -> 1) and built WDA for
`com.tylerschloesser.WebDriverAgentRunner`. Appium 4725 with `caps.json` (here) reached the install, then:
`The application could not be launched because the Developer App Certificate is not trusted` / `profile has not been explicitly trusted`.

Left, in order:
1. Tyler: phone Settings > General > VPN & Device Management > Apple Development: tylerschloesser@gmail.com > Trust.
2. `appium -p 4725 &` then `curl -X POST localhost:4725/session -d @caps.json` (the first run also builds, about 3 min; add
   `appium:usePreinstalledWDA`/`derivedDataPath` after that to skip it). Free-team profiles expire in 7 days: rebuild weekly.
3. Then try, untested: `mobile: pinch` (scale, velocity) with `bundleId com.apple.mobilesafari`, orientation
   `POST /session/:id/orientation` {LANDSCAPE}, `mobile: pressButton {name:"home"}`, `mobile: activateApp`, Control Center
   (swipe from top right, find Low Power Mode / Airplane by accessibility label; on iOS 27 these toggles may need coordinates),
   `/screenshot`. WDA drives the phone like a human, so Safari + page can run un-automated (no Guided Access banner) while WDA
   works in the foreground; the page's own readings then need Remote Automation off or a second channel (see below).

## Per check family

Legend: A = safaridriver, B = pymobiledevice3/devicectl, C = WDA (pending Trust; untested), H = human.

| Check | Verdict | Mechanism / what remains |
|---|---|---|
| M03 determinism page | fully automatable | A: load `determinism.html`, read banner and `crossOriginIsolated` (verified on device.html). |
| M08 worldgen ms/chunk | fully automatable | A: load, wait, read page output (bench page text; same read path as `__check`). |
| M09b fill rate (portrait/landscape 60 s) | caveat | A: portrait readings verified (rAF p50/p95/over20, GPU p95). Landscape needs rotation: C (or H). No screenshots inside the window (B). |
| M11-boot | fully automatable | A: `isolated`, adapter, `workers_ready`, `delivery` read (verified). |
| M11-gestures | caveat | A: pan, flick, tap, pull-down, no page zoom/scroll verified. Pinch, rotate: C (`mobile: pinch`, orientation). NaN check readable via `__check`. Two-finger A is impossible. |
| M11-memory | fully automatable | A: `?probe=memory&probeS=` and read the page (not run here). |
| M16 slice boot, round-trip | fully automatable | A: tap the Paint control (a tap works), read HUD/`__check`. |
| M16-coexist 10 min | fully automatable | A, if the session lasts 10 min (not tried; `newCommandTimeout` of safaridriver unknown). |
| M16-background / low power | still human, C likely | A blocks other apps (Guided Access). C: `activateApp`/Home + Control Center toggles. B can launch other apps only without a session; page state then is unreadable (no session), so the reading must come from the page itself (server-side beacon) or from C. |
| M18 anchors, pick | caveat | A: taps and pans work; continuous pinch for 30 s needs C. `pick_id` reads via `__check`. |
| M18-touch-ghost | fully automatable | A: tap then drag; cursor tile readings verified. |
| M23 OPFS latency, export/import | with caveat | A works for the latency page; the session store is ephemeral. |
| M23 kill-resume, world-busy, private, hidden-pause | with caveat / H | Kill-resume: B kill + relaunch via devicectl in ordinary Safari, but there is then no automation session to read the HUD (screenshot via B and read it, or an in-page beacon). Private browsing and second tab: C (tab switcher UI). |
| M29 socket resume (app switch, lock, Wi-Fi to cellular, airplane) | still human | Background and lock need C (Home/lock); airplane and Wi-Fi to cellular need Control Center via C; the on-page link log is readable only without A's block. |
| M34 two devices | with caveat | A for the phone side with the Mac as the second client (already done by `device-walk` bot partner). |
| M35 built game, capability screen | fully automatable | A for iPhone boot; the no-`navigator.gpu` case needs Settings toggling (C) or stays on desktop. |
| M37b renderer recovery under memory pressure | still human | needs several heavy apps in the foreground: C could launch them, not verified. |
| M38 hosted deployment | fully automatable | A against the hosted URL (https, so secure context without tunnel). Cellular leg: H or C. |
| M39 acceptance (large save, frame shares, full-game touch, two devices) | with caveat | A for pan/tap scripts and reading the bench HUD; sign-off and "feel" remain H. |

## Surprises
- The automation window renders `device.html` at a 980 px layout width (`viewport-fit=cover` only, no `width=device-width`),
  `visualViewport.scale 0.398`. Ordinary Safari after a B launch looks identical (screenshot: black page with a green block),
  so this is the page, not the driver. W3C coordinates are in layout px (0..980 x 0..1756).
- Safari relaunched by `devicectl --payload-url` or `dvt launch` with no session open showed the page; the green block in the screenshots was not investigated (Tyler's own look at a normal render is needed).
- `pymobiledevice3 webinspector launch|opened-tabs` hung even with Web Inspector on; `devicectl` (Xcode, no signing needed) is the working URL opener.
- Files: `wd.mjs`, `01-probe`, `02-gestures`, `03-pinch-debug`, `04-persist`, `05-screenshot-disturb`, `06-background`, `07-pmd3-lifecycle.sh`, `caps.json`.
