# M39j: Device driver (the Mac does the person's part of a round)

Status: not started · After: 39i · Tyler-dependent: Q5 (default assumed: the Android rows run on the Pixel 5; Tyler offered it on 2026-10-05, "same with my pixel too")

## Goal
Tyler, 2026-10-05, mid-round: "Is it possible for you to fully instrument my iPhone when it's plugged in. Like swiping and reading screenshots and shit. Kinda pissed that I have to do all this manually still." The spikes say yes (`spikes/device-driver-ios/RESULT.md`, `spikes/device-driver-android/RESULT.md`; read both in full, they are the reading list's core). When this is done, `pnpm device:walk --auto --round <r> --drive ios|android` opens the runner on a USB-attached phone with no QR scan. A **device person** on the Mac answers every *act* prompt with real device actions: OS-level touches, rotation, Home/app switch, Control Center/Settings toggles, Safari relaunch. It answers *judge* prompts from screenshots and readings where the item's Pass text is mechanical. It leaves the others pending with a screenshot as evidence, for the orchestrator to judge with `--judge`. The orchestrator can then run a whole round with nobody at the phone.

## Read first
1. `docs/spec/overview.md`
2. Both spike `RESULT.md` files above, and their helper modules (`spikes/device-driver-android/lib.mjs`; `spikes/device-driver-ios/ap.mjs`, `wd.mjs`, `caps.json`, `11-wda-legs.mjs`, `19-wda-pinch-both.mjs`)
3. `docs/plan/39f-device-auto-runner.md` (Deviations: the round log, prompts, `--status --json`) and `scripts/lib/device-walk/fake-person.mjs` (the simulated person: `personHandlers`, prompt text → action; this milestone is its real-device twin)
Rules: `.claude/rules/hot-paths.md` (nothing injected into measured pages).

## Facts the implementer needs (measured by the spikes)
- **iPhone 12** (UDID `00008101-001845EE1A82001E`, iOS 27.0.1). Appium 3.8.0 global, xcuitest driver 12.15.0, WDA `com.tylerschloesser.WebDriverAgentRunner`, team `Z5N9W23WW4` (trusted). The first session after WDA is down takes up to about 4.5 min: client timeout ≥ 10 min. W3C two-finger actions pinch reliably; `mobile: pinch` does not (it once opened Safari's tab overview). WEBVIEW context runs page JS: pick the webview whose `location.href` matches. Rotation, Home plus `activateApp`, Airplane (Control Center) and Low Power (Settings → Battery; no Control Center tile) all work. Lock/unlock needs the passcode: not driven. safaridriver can't pinch, blocks the phone ("Guided Access") and wipes storage between sessions, so it is not the driver.
- **Pixel 5** (adb serial `13061FDD4002VN`, Android 14, Chrome 154). Use `adb shell input` for real OS touches (pan, flick, tap, pull-down). Pinch goes through CDP `Input.dispatchTouchEvent` with two points (OS multi-touch needs root). Rotation is `settings put system user_rotation`; Home and relaunch go through intents. Airplane is `cmd connectivity airplane-mode`. Battery Saver does not engage while charging: record it as not drivable. Use raw CDP, not Playwright `connectOverCDP`, for visibility (Playwright masks it). Coordinates: the fixture pages now lay out at device width (M39h); compute touch points from the page's `innerWidth`/`innerHeight` and the canvas rect, never from constants.
- **Both phones stay awake and unlocked.** Never sleep or lock either one, and never fake a battery unplug (Tyler; it turned the Pixel's screen off). Clean up afterwards: Airplane and Low Power off, rotation restored, adb reverse/forward removed, Appium/WDA stopped.
- **No screenshot inside a measuring window.** On the Pixel a capture raised the worst frame. Capture between windows; the agent knows when a window is open (the walk bar is removed during one).

## Scope
Cut into three delegations, each landing green on `main`.

**Delegation 1: the device person core and Android (steps 1-3).**
1. `scripts/lib/device-walk/drive/` with a `DeviceBackend` interface: `open(url)`, `readPage(js)`, `touch(points[], durationMs)` (1-2 fingers, CSS px), `swipe`, `tap`, `rotate(orientation)`, `home()`, `returnToBrowser()`, `relaunchBrowser(url)`, `setAirplane(on)`, `setLowPower(on)` (may throw `NotDrivable`), `screenshot(path)`, `cleanup()`. A `devicePerson(backend)` gives the same handler shape as `personHandlers`: prompt text → action, every act prompt of `checks.mjs` covered or listed as `NotDrivable` with the reason. A unit test fails if `checks.mjs` gains an act prompt the device person neither handles nor lists.
2. The Android backend (adb + raw CDP), from the spike's `lib.mjs`.
3. `--drive android`: `auto-round` opens the runner URL on the phone by intent (no QR), attaches, and lets the device person answer act prompts as they appear (from the round log's `prompt` events or the walk bar through page JS; pick one and justify it in Deviations). Judge prompts: where the item's Pass text is mechanical and the readings decide it, the existing auto criteria already do. Otherwise the person saves a screenshot to the item's evidence dir and leaves the judge pending. `pnpm device:walk --judge <round> <id> pass|fail|skip [--note ...]` records a judge result (`by: orchestrator`). Run M11-gestures and M09b-fill-rate end to end on the Pixel and paste the status rows.

**Delegation 2: iOS (steps 4-5).**
4. The iOS backend (Appium/WDA; WEBVIEW for page JS; W3C two-finger pinch; Control Center/Settings flows from the spike), with WDA warm-up and a long first-session timeout, plus `--drive ios`.
5. Run M11-gestures, M09b-fill-rate and M16-background end to end on the iPhone and paste the status rows.

**Delegation 3: the whole round and the records (steps 6-7).**
6. Run a full `m39-drive-ios` round and a full `m39-drive-android` round (Android rows of `device-checks.md` included, per Q5's default). Each item ends pass, fail, `NotDrivable` with its reason, or judge-pending with a screenshot. No retries to turn a fail into a pass: a fail is a finding.
7. Update the `device-round` skill (`.claude/skills/device-round/`) and `device-checks.md`'s header: how the orchestrator starts a driven round, judges pending items from screenshots and applies. Mark which items stay Tyler's (desktop trackpad pinch, M39 sign-off).

## Non-scope
Fixing anything a driven round finds: each finding becomes its own brief (the M39g/h/i pattern). The GPU-latency metric question (both phones read 12-14 ms GPU p95 idle and panning alike) is separate. Desktop Mac browsers keep the M39f path.

## Tests added
Unit (no phone): every act prompt in `checks.mjs` maps to a handler or a listed `NotDrivable`; the backend interface is implemented by a fake backend that records calls, so the device person's mapping is tested without hardware (prompt "Rotate the phone to landscape." → `rotate('landscape')`). `--judge` writes a `result` row the status and apply readers accept (round-trip through `rounds.mjs`). The real-phone runs are evidence in the report, not suite tests (no phone on CI).

## Exit criteria
- [ ] Delegation 1: Pixel M11-gestures and M09b-fill-rate driven end to end, status rows pasted, no QR scan.
- [ ] Delegation 2: iPhone M11-gestures, M09b-fill-rate and M16-background driven end to end, status rows pasted.
- [ ] Delegation 3: both full rounds driven; every item has a result or a stated `NotDrivable`/judge-pending; skill and header updated.
- [ ] The unit tests exist and each was seen red once.
- [ ] Both phones left awake, unlocked, toggles off, rotation restored, no Appium/WDA/adb rules left behind.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Context artifacts
`.claude/skills/device-round/SKILL.md` updated (driven rounds, `--judge`). Memory: Tyler's phones are test devices; keep screens on.

## Deviations
### Delegation 1 (steps 1-3): seams as built

- **Files** `scripts/lib/device-walk/drive/`: `backend.mjs` (`NotDrivable`, `finger(x1,y1,x2,y2)`, `BACKEND_METHODS`, `assertBackend`), `person.mjs` (`devicePerson(backend, ctx) -> { handlers, coverage, ctx, answer(prompt) }`, `HANDLERS`, `ACT_COVERAGE`), `android.mjs` (`createAndroidBackend({serial?, adb?, log?, ...injectables})`, `pickSerial`, `toScreen`, `offsetsFor`, `touchScript`), `cdp.mjs` (`cdpConnect(wsUrl)`), `loop.mjs` (`startDrive`, `passRunner`), `judge.mjs` (`judgeEvent`), `fake-backend.mjs` (`createFakeBackend`). Test: `scripts/lib/device-walk-drive.test.mjs` (20 tests, `unit`, 1.4 s).
- **Interface additions** (compatible): `tap(x, y, { count })` (double-tap is two taps in one shell call), Android-only `reverse(ports)` and `viewport()`. `readPage(js)` takes an expression and returns it by value. `answer(prompt)` returns `{status: done|pending|notDrivable|unmatched|error}`.
- **Prompt source, justified:** the round log's `prompt` events through `live.mjs openPrompts` (the same words the bar shows), not the bar through page JS. The log is the service's record of what is open, survives navigations and the bar being gone in a measuring window, costs the phone nothing, and needs nothing injected. Handlers that must tap a bar button find it through page JS (second tab, Redo). Each prompt is answered once (`id:n:kind:text`); no retries.
- **New log events** (ignored by older readers): `drive {id, n, kind, text, action, handler, reason?, error?}` per answered prompt; `shot {id, n, path}` per judge screenshot (`replay` item `shots`, `--status --json` row `shots`). A NotDrivable ends the row as `result skip, by: 'device', notes: 'NotDrivable: <reason>'`.
- **`--judge <round> <id> pass|fail|skip [--note ...]`** appends `result {by: 'orchestrator', attempt, criteria (null ones set by the verdict), metrics, evidence (repo-relative)}`; refused when the item has no open judge sheet or already has a result. Ladders are not advanced by it. The running `--auto --drive` process notices it (the loop calls `machine.settle()` every 250 ms). Screenshot: `test-results/device-walk/<round>/<id>-<n>-judge.png`.
- **CLI**: `--drive android|ios` (ios refuses: delegation 2). A driven round serves over `adb reverse` of each variant's loopback port (`--tunnel` to use tunnels instead), never auto-opens the monitor, and sets `params.client: 'phone'`. `startAutoRound` also returns `origins`. `auto-round.mjs` exports `rel`.
- **Placement of OS touches (measured, Pixel 5):** CSS px -> screen px is `(off + css) * dpr`, `offY = outerHeight - innerHeight - chin`, `offX = outerWidth - innerWidth`. The chin depends on the page: 0.5 CSS px for `viewport-fit=cover` pages (every fixture page and the runner), 24 for pages without it (the reference game). Each kind is learned once with one tap that capture-phase listeners swallow (so a page with agent pointer logs sees one extra `down` the first time only). Checked with taps at four points in portrait, landscape and portrait: every hit within 1 CSS px.
- **Android timings**: M11-gestures end to end 100 s (7 gestures, page boot, pre-flight idle check 30 s is extra); pan of "10 s" is one 11.5 s swipe; pinch 4 two-finger gestures of 0.76 s reach 12 -> 256 -> 12.
- **Act-prompt coverage** (`ACT_COVERAGE`, unit-tested against `checks.mjs`): handled: rotate (M09b, M11, M18 x2), pan, flick, pinch, tap tile, pull-down, double-tap, drag, tap ring/button (M18-pick, M18-touch-ghost), leave app via Home (M16-background, M23-hidden-pause, M29, M37b background without memory pressure), airplane (M29), relaunch (M23-kill-resume), second tab (M23-world-busy), Redo sheet, Low Power (handler calls `setLowPower`; the Pixel throws). NotDrivable with reason: lock screen (never locked), Wi-Fi switch (adb reverse: Wi-Fi is not the link; M34-own-timer-bar, M29 wifi-cellular), Private tab (Chrome ignores the incognito flag from adb; not tried on the phone), export/import (system file picker), Low Power on the Pixel (does not engage while charging), Mac-only and human-class rows. M34-two-devices: no phone prompt (the bot). Verified on the Pixel: rotate, pan, flick, pinch, tap, pull-down, double-tap, NotDrivable (low power). Handled but not yet run on the phone: leave app, airplane, relaunch, second tab, Redo, tap ring/drag.
- **Not done / for delegation 3**: `Drop` timing: Home-to-return adds about 0.7 s to the absence (`returnLagMs`, unmeasured), which matters for the 5 s drop (+-30%).

### Findings the driver made (not fixed here)

1. **M09b leaves the camera in `localStorage` and M11-gestures boots from it.** `engine:camera:v1:default` is saved at motion end; the fill-rate rungs use `tiles=256`, so M11 on the same origin starts at 256 tiles and "zoomed out" (needs 1.33x the start) can never tick: a person would be stuck too. Fake phones run in a fresh context so no suite saw it. Workaround for my run: cleared the origin's localStorage over CDP before the M11 round. Fix belongs to the agent/driver (clear the camera key before a check) or the order of the round.
2. **M09b-fill-rate fails on the Pixel on `gpu_p95_ms` only**: rAF p95 16.8 ms, 0 over 20 ms, 0 hitches, GPU p95 14.0 ms against 6 (the known GPU-latency metric question); all four ladder rungs fail the same way.
3. M11 judge sheet shows `rotation_keeps_centre 17.9` (no limit) with a 0.27-tile centre shift at 256 tiles; the flick glided 7.2 tiles (the direction fix of M39i is in).
4. `device:walk --auto` exited with 2 while its own signal-time shutdown was still restoring the phone (second `shutdown()` returned at once): fixed here (one shared promise); it had left `accelerometer_rotation` 0 once.

### Evidence (Pixel 5, round logs `docs/plan/device-rounds/m39j-pixel-{1,2,3}.jsonl`)

- M09b-fill-rate (pixel-1): `fail [auto] no configuration passed (tried the default, &scaleCap=1.5, &scaleCap=1, &scaleCap=1&cutoff=4)`; `raf_p95_ms=16.775 raf_over20_per_10s=0 gpu_p95_ms=13.99 (limit 6) hitch_gaps_over_25ms=0`.
- M11-gestures (pixel-2): all 7 prompts answered, `gestures_done 7/7, page_scrolled false, page_zoomed false, page_reloaded 0, cursor_tile_after_tap true`, tiles 12 to 256, flick glide 7.2 tiles; ends `waiting-for-human` on the judge sheet with `shots[0].path = test-results/device-walk/m39j-pixel-2/M11-gestures-1-judge.png`. `--judge pass --note "glides, stops"` on a scratch copy: `pass [orchestrator] M11-gestures  glides, stops`, state done.
- M16-low-power (pixel-3): `skip [device] M16-low-power  NotDrivable: Battery Saver does not engage while the Pixel is charging ...`.
- Left clean: reverse and forward lists empty, `accelerometer_rotation 1`, airplane 0, screen Awake, no tool processes.


### Delegation 2 (steps 4-5, iOS) and the two rulings: seams as built

- **iOS backend** `drive/ios.mjs`: `createIosBackend({ port?, call?, log? })` (`call` injects the HTTP client for the unit test), `pointerActions`, `tapActions`, `appiumCall(base, method, path, body, timeoutMs)` (`node:http`, 15 min default: fetch's own 5 min header timeout is shorter than a cold WDA). Extra methods: `platform: 'ios'` (the android one says `'android'`; the person's NotDrivable reasons differ by it), `start()` (Appium and the session; `--drive ios` calls it at once so the warm-up overlaps the servers; `open` waits for it), `raw`, `exec`, `viewport`. Appium is started by the backend if nothing answers on 4725 and killed in `cleanup()` together with WDA's `xcodebuild` (found by its `APPIUM_XCODEBUILD_WDA_MARKER`: it outlives a killed Appium). `IOS_TRACE=1` logs every Appium call; `DRIVE_SHOTS=<dir>` saves a screenshot after every answered act prompt (both backends).
- **`--drive ios`**: always through the tunnel (no `adb reverse`; plain http is not a secure context); `startAutoRound` is unchanged. Page JS runs in the webview whose origin is ours, **checked in the same script that runs the expression** (webview names are reassigned as tabs come and go; a cached one once pointed at a Safari extension page and the walk stalled). Touches: W3C actions in `NATIVE_APP`; the page offset in points (`(0, 47)` portrait on the iPhone 12, bottom toolbar) is learned per page size by one swallowed tap, retried three times.
- **Measured on the iPhone 12 (iOS 27.0.1)**: WDA session 9 to 58 s (WDA already installed; a cold start was not seen), M11-gestures end to end about 2 min after the 30 s idle check, M09b 4 rungs about 9 min. Appium serialises commands: a webview call that hangs (a stale Safari tab) blocks everything behind it, so every webview probe has an 8 s timeout; a second client probing the live session disturbs the driver (do not).
- **Handlers verified on the iPhone**: rotate, pan, flick, pinch (W3C two-finger), tap, pull-down, double-tap (`/actions` with two down/up pairs), Home + `activateApp` leave (M16-background's 30 s leave, M23-hidden-pause), Low Power on/off (Settings > Battery; on this iOS the row is a `Button`, and Settings reopens on its last page so the backend restarts it when the row is missing), Airplane on/off (tile tapped at (194, 163); the plane icon seen in a screenshot; Wi-Fi back after). Not run: relaunch, Redo, tap-ring/drag on iOS. NotDrivable on iOS: lock, Wi-Fi (no SIM: no cellular to move to), Private tab and second tab (Safari's tab switcher), export/import.
- **Ruling (a), camera persistence**: `agent.js` clears every `localStorage` key starting with `CAMERA_PREFIX` (`'engine:camera:v1:'`) when the URL carries `_fresh=1`, before the page boots (the agent is the first script of the head); the driver puts `_fresh=1` on every attempt it navigates to (assign, the new-attempt navigation, and `A.hop`'s extra) unless `plan.keepCamera`, which only `M23-kill-resume` sets (the reopened page restores what the first one saved; no other check in `device-checks.md` names a camera restore or a reload as the thing tested). `packages/engine/src/camera/persistence.ts` now exports `CAMERA_KEY_PREFIX` and builds `cameraStorageKey` from it. Test `device-walk drive: the agent clears the key prefix the engine saves its camera under` derives the prefix from the real `cameraStorageKey` and fails when `agent.js` differs. `agent.js` is 622 lines (the M39f note said 600: no test pins it). **Evidence**: `m39j-pixel-4` ran M09b (rung 4 at `tiles=256`) then M11-gestures in one round on the Pixel: M11 booted at 12 tiles and ticked `tiles 12 to 256`.
- **Ruling (b), world point under the finger**: criterion `world_point_drift_tiles`, `<= 1`, `ref` quoting 0019 §3 ("One-pointer drag pans (the world point under the finger stays under it)"). The pointer log records the world point under the first finger at touch-down (`worldUnder`, the same formula as `transform.ts` `screenToWorld`: a unit test compares them), a 40 ms timer compares it with the point under the finger's latest position through the pan, the maximum is the value. `flick_glides` is now the judge's only visual question; `rotation_keeps_centre` stays judged with no limit and its text reads `the centre moved 0.27 tiles (17.9 px) across the rotation` (metrics `centre_shift_tiles`, `rotation_shift_px`). Measured: Pixel 0.009 tiles (262 samples), iPhone 0.015 (237 samples).
- **Existing tests changed (a necessary consequence of (b), assertions kept)**: `device-walk-life.test.mjs` M11 test (fixture data gains `worldPointDriftTiles`, the rotation value is now the shown string, one new failing case for drift 1.5); `walk-touch.spec.ts` M11 (`rotation_keeps_centre` is a string with tiles and px; the drift criterion has limit 1). `pnpm test:slow browser -t "walk-touch: M11"`: pass (2 tests; it failed once under load average 10 with `gestures_done 6, glide 0.0`, and passed on the rerun).
- **Collector fix found on the iPhone**: `collect-touch.js` counted `gesturestart/gesturechange` as "the page zoomed" (`pageZoomed`, and the double-tap sheet's "page not zoomed" tick). WebKit sends them for every two-finger touch (the engine's own pinch input), so after the pinch step the tick could never come, for a person too (Chrome sends none). The page zooming is now `visualViewport.scale` moving (`P.zoomed`); the gesture count stays in the data as `pointer.gestureEvents`. A change to a criterion's meaning: for the orchestrator to ratify.
- **Unit tests**: `scripts/lib/device-walk-drive.test.mjs` 29 tests; each new one was seen red once (key prefix, `_fresh` per navigation and the keepCamera list, `worldUnder` formula, drift limit, iOS orientation call). Under load average 10 the CLI tests of `device-walk-phone`/`-apply` time out at 5 s on this Mac, also on a stashed clean tree: not caused by this work.

### Delegation 2: iPhone status rows (`docs/plan/device-rounds/m39j-ios-{1,2,3}.jsonl`, tunnel, WDA driving)

- **M09b-fill-rate** (ios-1): `fail [auto] no configuration passed (tried the default, &scaleCap=1.5, &scaleCap=1, &scaleCap=1&cutoff=4)`; last rung `raf_p95_ms 18.9 (limit 17.5)`, `raf_over20_per_10s 19 (5)`, `gpu_p95_ms 6.52 (6)`, `hitch_gaps_over_25ms 22`, `raf_gap_max_ms 64.3`. WDA, the tunnel and Appium run beside it, so these are not a quiet-phone number.
- **M11-gestures** (ios-1, after M09b in one round: (a) at work): all seven prompts answered; `gestures_done 7/7, page_scrolled false, page_zoomed false, page_reloaded 0, cursor_tile_after_tap true, world_point_drift_tiles 0.015 (limit 1)`; tiles 12 to 256, flick glided 7.6 tiles, `rotation_keeps_centre: the centre moved 0.01 tiles (0.5 px) across the rotation`; ends judge-pending on `flick_glides` with `test-results/device-walk/m39j-ios-1/M11-gestures-1-judge.png`. Left pending for the orchestrator (`--judge m39j-ios-1 M11-gestures pass|fail|skip`); the round process was stopped there, so M16-background ran in its own round.
- **M16-background** (ios-2): `skip [device] NotDrivable: the screen is never turned off or locked on these phones (Tyler); a lock needs the passcode`. The first leave (30 s, Home and `activateApp`) was answered before it. Evidence that the leave itself works: **M23-hidden-pause** (ios-3, the same 30 s Home leave) read `tick_delta 50, durable true, reloads 0` and sits on its judge sheet.
- **Pixel re-run** (`m39j-pixel-4`, M09b then M11 in one round): M09b `fail` (`gpu_p95_ms 13.925`); M11 `gestures_done 7/7`, `world_point_drift_tiles 0.009 (limit 1, 262 samples)`, `rotation_keeps_centre: the centre moved 0.16 tiles (10.9 px) across the rotation`, flick glided 28.3 tiles, tiles 12 to 256; judge-pending.
- Left clean: Airplane off (screenshot), Low Power off, rotation portrait, Auto-Lock already Never (read from Settings, not changed), no Appium/WDA/xcodebuild/cloudflared processes, no adb reverse/forward, Pixel `accelerometer_rotation 1`, screen Awake.

### Delegation 3 (steps 6-7): full rounds, findings, what was built on the way

**Outcome.** The Pixel's full round ran to its end (`m39j-full-android`: 45 rows, 38 recorded, 7 open = 6 judge sheets and the meta row `M39-rerun`). **The iPhone's full round did not finish** (`m39j-full-ios`: 9 rows recorded, then stopped): a first run hung on a 10 minute series (below), and after I restarted it the iPhone refuses to start WDA: `xcodebuild failed with code 65`, because iOS shows "Enter iPhone Passcode for XCTest: Enable UI Automation" on the phone (screenshot seen over `pymobiledevice3`). That needs Tyler's passcode once; nothing here can or should type it. Three more tries 20 to 90 minutes later failed the same way. When it is entered, `pnpm device:walk --auto --drive ios --round m39j-full-ios --timeout 36000` resumes from the log.

**Machine load** (`uptime`, 1/5/15 min) at the measuring items: 2.4 to 5.8 for both full rounds (two rounds ran at once, one per phone, ports 4173 and 4373); no item ran above 8, so no row carries a load note. Stale Safari tabs: 18 of them (Cloudflare error pages and "Device walk" runner pages) were closed before the iPhone rounds, only those; `ios.mjs` `closeStaleTabs()` does it once per backend at `open` (titles `trycloudflare`, `Cloudflare Tunnel`, `Can't Open Page`, `Device walk`).

**Home-to-return gap (M29's 5 s drop), measured with `device.html`, 4 runs each:** the old way (Home, sleep, intent) gave 4.35 s of absence on the Pixel (the `hidden` event comes 0.65 s after Home), inside the 3.5 to 6.5 s window but near its edge; the person's `leave-app` now counts the stated time from the page's own `hidden` beacon (polled, raced against a 1.2 s timer so a hidden page that does not answer DevTools cannot hold the walk: `world.html` did not, once: the walk waited 30 minutes on it), with `backend.hideLagMs` (Pixel 650, iPhone 300) as the fallback: **Pixel 5.13 to 5.22 s, iPhone 5.13 to 5.22 s** for a 5 s target. No compensation was needed beyond that; `returnLagMs` stays 0.

**Built on the way (each found by a driven round, each with a test seen red):**
1. **`phone-api.mjs` `MAX_BODY` 200 KB to 10 MB.** A 10 minute window's series (600 readings, about 250 KB) closed the phone's socket and the POST was refused: both rounds hung on M16-coexist for 30 minutes (found by status, then by reading the agent's `__walkAgent.state()` over CDP: connected, outbox empty... the series never left). Test `a 10 minute window's series ... is accepted over POST and over the socket`.
2. **Deferred judge sheets.** `defer {id, n}` event (written by the driver after the screenshot): the machine skips a deferred judge item (`parked`) for the current step and for `advance`, so the walk goes on and the row stays open for `--judge`. `--status --json` still lists it in `humanPending` and `shots`. Test in `device-walk-auto.test.mjs`.
3. **`--timeout <seconds>`** for `--auto` (default stays 90 min; a driven full round takes hours).
4. **An act that times out is a result** (`driver.js`): a collector returning null with no interruption used to leave the check hanging for ever (M18-pick sat 30 minutes); it now sends `{ready: true, actTimedOut: true}` and the service fails the criteria that have no value.
5. **The runner page is opened again while its tunnel name does not resolve yet** (`passRunner`: `chrome-error:` or `about:blank`, every 10 s up to 18 times).
6. **WDA start retried** (3 attempts, `pkill` of its xcodebuild marker between) - it did not help against the passcode sheet.
7. **`--apply` of an Android round** writes **Run on** lines and ticks nothing (the ids are the iPhone's rows; `-android` rows are never ticked, existing rule). Test `a round run on an Android phone writes its Run on lines and ticks nothing`.
8. **Debug aids**: `ANDROID_TRACE=1` (the page every `readPage` ran in), `DRIVE_SHOTS`, `IOS_TRACE` (see delegation 2).
9. `device-checks.md` header and `.claude/skills/device-round/SKILL.md`: driven rounds, `--judge`, what stays Tyler's; `Android:` line now says a Pixel on USB exists and its rounds tick nothing.

**Round log hygiene.** Because of restarts (items 1, 4, 5) some rows of `m39j-full-android` are not clean: `M18-pick`, `M23-world-busy`, `M23-hidden-pause`, `M34-two-devices`, `M34-own-timer-bar`, `M34-remote-motion` failed while a restart or a driver defect was in play (null criteria = nothing was measured). I reran only those, in fresh rounds (`m39j-dbg-android`, `m39j-dbg2-android`, `m39j-android-redo`, `m39j-android-redo2`); the first results stay in the full round's log and history. A rerun is reported next to the original, never in place of it.

#### Pixel 5 full round `m39j-full-android` (tunnel, 45 rows)

| id | result | by | one line |
|---|---|---|---|
| M03-determinism, M08-worldgen-ms-per-chunk, M08-warn-threshold | pass | auto | |
| M09b-fill-rate | fail | auto | no rung passes: `gpu_p95 13.2` (limit 6); rAF p95 and hitches fine (the known GPU-latency question) |
| M11-boot, M11-memory | pass | auto | memory ceiling 1024 MiB, no reload |
| M11-gestures | open | | judge sheet (flick glides, rotation) with screenshot |
| M11-pinch-desktop-safari, M17b-harness-desktop-safari/-firefox, M35-safari-build-mac, M39-desktop-browsers | skip | auto | Mac rows, not a phone round's |
| M16-slice-boot | open | | judge sheet (inherits M11-gestures) |
| M16-round-trip, M16-coexist | pass | auto | coexist: 600 paints, no hitch gap over 25 ms, `engine_mem_grows` 0 |
| M16-background | skip | device | NotDrivable: lock the screen (never locked); the first 30 s leave was done |
| M16-low-power | skip | device | NotDrivable: Battery Saver does not engage while charging |
| M18-anchors, M18-touch-ghost | open | | judge sheets |
| M18-fill-rate-with-anchors | fail | auto | no rung passes: `gpu_p95 19.0` |
| M18-pick | fail | auto | **driver unresolved, not a measurement** (null criteria): see finding 4 |
| M23-opfs-latency, M23-kill-resume | pass | auto | kill-resume: relaunch by intent, world resumed, 0 admitted actions lost |
| M23-world-busy | fail (original) | auto | CDP timeout reading the page; **rerun `m39j-dbg-android`: pass** (second tab busy, banner shown, first tab keeps playing) |
| M23-private | skip | device | NotDrivable: Chrome ignores the incognito flag from adb |
| M23-hidden-pause | fail (original) | auto | my restart killed the attempt; **rerun `m39j-android-redo`: judge sheet** `tick_delta 40`, `durable true`, 0 reloads |
| M23-export-import | skip | device | NotDrivable: system file picker |
| M29-socket-resume, M29-play-through-drop | skip | device | NotDrivable: lock the screen (the 5 s, 30 s and 5 min app drops ran before it) |
| M29-net-heap | fail | auto | **adapter error**: `Cannot read properties of undefined (reading 'paint')` (`mp.html` has no `__check.act.paint`), then `pagehide` interruption: finding 3 |
| M34-two-devices | fail | auto | `ready: false`, null criteria; **rerun twice, same**: the phone does not report the bot's player: finding 5 |
| M34-own-timer-bar | fail (original) | auto | `ready: false`; **rerun: skip, NotDrivable** (Wi-Fi to cellular not built) |
| M34-remote-motion | fail | auto | **rerun `m39j-dbg2-android`, joined: `remote_moved 0` (limit 1), `fade_missing 1`**: finding 5 |
| M35-safari-build-iphone | open | | judge sheet ("the game plays", `world_drawn 785`) |
| M35-capability | skip | auto | retired |
| M37b-ios-background | open | | judge sheet; `drawn_again_per_run false` (backgrounded with Home, no memory pressure) |
| M38-hosted-boot, -socket-resume, -remote-motion, M39-full-game-touch, M39-two-devices, M39-sign-off | skip | auto | human rows |
| M39-large-save | fail | auto | `tick_p95 26.1 ms` against 10 (sim-worker tick time on the Pixel); no reload, `engine_mem_grows` 0 |
| M39-frame-shares | pass | auto | main p95 0.9 ms, frame p95 5.3 ms |
| M39-rerun | open | | meta row |

#### iPhone 12 `m39j-full-ios` (stopped after 9 rows; see Outcome)

M03, M08 x2, M11-boot, M11-memory, M16-round-trip: pass (auto). M09b-fill-rate: fail (auto; `raf_p95 18.9`, `raf_over20 19`, `gpu_p95 6.52`, 22 hitch gaps: delegation 2's run). M11-pinch-desktop-safari, M35-capability: skip. **Open judge sheets:** M11-gestures, M16-slice-boot. Everything after M16-round-trip is open: M16-coexist and the rest need the passcode first.

#### Judge-pending (screenshots under `test-results/device-walk/<round>/`, untracked)

- `m39j-full-android`: M11-gestures, M16-slice-boot, M18-anchors, M18-touch-ghost, M35-safari-build-iphone, M37b-ios-background (`<id>-1-judge.png` each).
- `m39j-android-redo`: M23-hidden-pause (`M23-hidden-pause-1-judge.png`).
- `m39j-full-ios`: M11-gestures, M16-slice-boot.
- Record with `pnpm device:walk --judge <round> <id> pass|fail|skip --note "..."`.

#### Findings (none fixed here; each is a candidate brief)

1. **M09b, M18-fill-rate, M39-large-save on the Pixel and M09b on the iPhone fail on GPU p95 / tick p95** (13 to 19 ms against 6; tick 26 ms against 10): the numbers, not the driver.
2. **M18-pick cannot be done on a 392 px phone at 40 tiles.** A ring sits under its own button; a finger's touch area snaps to the button (Chrome's touch adjustment: `elementFromPoint` says canvas, the real tap's target is BUTTON). 11 px under the ring's anchor picks it, 9 hits the button, 15 misses the ring. A person has the same trouble. The driver's nudge (tap just under the button's box) did not make the collector's `ask` see the tap in two runs: unresolved.
3. **`M29-net-heap`'s adapter dies on `mp.html`** (`window.__check.act.paint` undefined) and its interruption record races the previous page's `pagehide`.
4. **M18-pick's and every `ask`'s silent hang** (fixed here, item 4 above) was in M39f's driver.
5. **M34 on the Pixel through the tunnel:** `joined()` (check ready, link online, UI seen) was false in two of three runs, and when it joined the bot's player never moved in the phone's view (`remote_moved 0`). Not diagnosed (the bot is the Mac's headless Chromium on the same tunnel).
6. **The iPhone needs the passcode again for "Enable UI Automation"** after a session ended; a driven iOS round cannot start without it.
7. **Backgrounding a page that DevTools cannot read** (`world.html` hidden, Pixel): Runtime.evaluate never answered; the leave now ignores it.
8. **`M23-world-busy` read of the bar timed out once with the first tab on `world.html`** (CDP 15 s) and passed in a clean rerun: an unexplained flake, perhaps the choice of one of the 22 Chrome tabs. `--drive android` does not close Chrome's old tabs; `closeStaleTabs` exists only for iOS.
9. M37b and M16-background ran on the Pixel without memory pressure or lock (NotDrivable or partial): their rows say so.

**Not verified:** any iPhone item after M16-round-trip; relaunch, Redo and the Wi-Fi/cellular switch on either phone; the `--judge` flow on the full rounds' sheets (done on a scratch copy in delegation 1).

### Delegation 3, second pass (coordinator's rulings after the Pixel gate): iPhone round to its end, M18 re-run, what was fixed

**Outcome.** `m39j-full-ios` ran to its end: 37 of 45 rows recorded, 8 open (7 judge sheets and `M39-rerun`). Plus `m39j-ios-redo` (4 items) and `m39j-ios-lp` (M16-low-power on the fixed backend). `m39j-android-m18` re-ran M18-anchors and M18-touch-ghost on the Pixel; their judge screenshots are now of the item with its sheet. No Appium, WDA, xcodebuild, cloudflared, vite or reference-server process is left; the Pixel is awake with rotation restored and no adb forward or reverse; the iPhone has Airplane and Low Power off, **Battery Percentage back off** (see below) and Safari in front.

**Fixed (each with a unit test seen red):**
1. **iOS opens the runner itself and waits boundedly.** `open()` lists the webviews with `mobile: getContexts` (id, title, url) and enters only one whose URL is one of our origins (extension pages, `about:blank` and `data:text/html` error pages are never entered: switching into a wedged one is what timed out). It waits up to 60 s, opens the URL again once, waits 60 s more, then throws `Safari did not load <url> in two minutes (it shows: ...)`. One log line when the set of pages changes, not one per poll.
2. **Shutdown in about 10 s.** Every step has a deadline (`drive/deadline.mjs`: loop 2 s, phone cleanup 6 s, monitor 1 s, servers 4 s); `abortAll()` ends in-flight Appium requests first; the process exits after 12 s whatever happens. Signals within 2 s of the first count as one (pnpm forwards a Ctrl-C on top of the terminal's, and the first version of this took that for "stuck" and exited without restoring the phone: found by a test run that left `accelerometer_rotation 0`); a later one leaves at once. Measured: 1 to 6 s on both phones. A shut-down Android backend no longer sets an adb forward up (a handler still running after cleanup had).
3. **Judge screenshots are of the item.** A resumed round found the old judge prompts still open and photographed the runner page over the good shots (`m39j-full-android`'s anchors and touch-ghost): a prompt an earlier process answered is now recognised from the log (`drive` after an act prompt, `defer` after a judge prompt) and skipped; and a judge shot waits (about 10 s) until the walk bar shows its sheet, the shot says `unverified: true` if it never did.
4. **Silent phone.** The agent pings every few seconds, even inside a 10 minute window; a phone not heard from for 3 minutes is sent back to the join URL (3 times at most, logged as `drive {action: 'reopened'}`). An mp.html page whose agent never started hung the iPhone round for 40 minutes.
5. **A late series is not a second verdict**: the page was still finishing M23-private when the driver had already recorded its NotDrivable skip, and the service turned the row into a fail (iPhone).
6. **The Low Power flow** returns to Safari when it fails (a frozen check page sat behind Settings for 22 minutes), and finds the switch again before every click, checks its identifier and **puts "Battery Percentage" back if it moved**: a stale element reference had flipped Tyler's Battery Percentage setting on (it was off before, the failed `m39j-ios-redo` run left it on, a screenshot showed it, and I turned it back off with a WDA session). `m39j-ios-lp`: Low Power Mode on, `low_power_detected true`, `flick_distance_ratio 0.768`, judge-pending.
7. **WDA sessions**: one `POST /session` per tool process, logged `ios: WDA session #N (start|reconnect): starting (xcodebuild | reusing the running WDA) at <time>`; a session Appium drops is replaced by one with `useNewWDA: false` (no new xcodebuild); `appium:newCommandTimeout` is 10 h (it was 30 min and expired under a 1 h wait). `WDA failed with code 65` is treated as the passcode sheet: ONE line ("iPhone shows the XCTest passcode sheet ... Tyler must enter the passcode or turn the passcode off"), a 120 s pause (`IOS_SHEET_PAUSE_S`), one more try, then the tool stops with that message. `backend.sessionCount()` and `sessions()` list them.
8. Runner page opened again while its tunnel name does not resolve yet (Android and iOS), Android leave not waiting on a hidden page DevTools cannot read (delegation 3, first pass).

**WDA sessions created for the iPhone work this pass** (from my logs; each line is an xcodebuild launch unless it says reused): `m39j-full-ios` process 1 (04:05 UTC): 1 session; then failed launches: 1 + 3 + 3, then 3 more at 15:08 UTC (11 with the one in `m39j-ios-redo`); sessions that came up: 15:03 UTC (reused 3 s after a clean WDA), 15:46 UTC (my one probe with `showXcodeLog`), the resumed round (1), `m39j-ios-redo` (1 failed launch, 1 up after 130 s), the Battery Percentage repair (1), `m39j-ios-lp` (1). **That is 7 sessions up and 11 failed launches in about 12 hours (not counting the coordinator's own resume)**; none of them was per item (each process held one). The passcode sheet came with the failed launches.

#### iPhone 12 `m39j-full-ios` (45 rows)

| id | result | by | one line |
|---|---|---|---|
| M03, M08 ×2, M11-boot, M11-memory, M16-round-trip, M18-fill-rate-with-anchors, M18-pick, M23-opfs-latency, M23-kill-resume, M39-frame-shares | pass | auto | M18-pick passes on the iPhone (the tap lands) |
| M09b-fill-rate | fail | auto | no rung: rAF p95 19.1 (17.5), 21 over 20 ms (5), 12 hitch gaps |
| M11-gestures, M16-slice-boot | pass | orchestrator | judged by you |
| M16-coexist | open | | judge sheet (`hitch_gaps_over_25ms 15`) |
| M16-background | skip | device | NotDrivable: lock (the 30 s leave ran first) |
| M16-low-power | fail (first run) / open (rerun) | auto | first run: my click flipped Battery Percentage, LPM never on (driver bug, fixed); **rerun `m39j-ios-lp`: detected, ratio 0.768, judge sheet** |
| M18-anchors, M18-touch-ghost, M23-hidden-pause, M34-remote-motion, M35-safari-build-iphone, M37b-ios-background | open | | judge sheets |
| M23-world-busy | skip | device | NotDrivable: back to the first tab needs Safari's tab switcher |
| M23-private | skip (after the fix; fail first) | device | NotDrivable (Private mode is the tab switcher's UI); the first run showed a fail from the late series (fixed); rerun `m39j-ios-redo` skip |
| M23-export-import | skip | device | NotDrivable: file picker |
| M29-socket-resume, M29-play-through-drop | skip | device | NotDrivable: lock (5 s, 30 s and 5 min drops ran first) |
| M29-net-heap | fail | auto | adapter error `undefined is not an object (evaluating 'check().act[name]')`: the same `mp.html` adapter bug as on the Pixel; rerun, same |
| M34-two-devices | fail | auto | `ready false` (never joined with the bot): same on the Pixel, same on a rerun |
| M34-own-timer-bar | skip | device | NotDrivable: no SIM |
| M39-large-save | fail | auto | `tick_p95 12.2 ms` (limit 10); no reload, no memory growth |
| other rows | skip | auto | Mac rows, retired M35-capability, human rows |

**Judge-pending (screenshots, untracked under `test-results/device-walk/<round>/<id>-1-judge.png`):** `m39j-full-ios`: M16-coexist, M18-anchors, M18-touch-ghost, M23-hidden-pause, M34-remote-motion, M35-safari-build-iphone, M37b-ios-background; `m39j-ios-lp`: M16-low-power; `m39j-android-m18`: M18-anchors, M18-touch-ghost (the shot shows the item page with its sheet; touch-ghost: `ghost_on_tile 0,-1`, the ghost is not visible in the picture).

**Findings added:** (10) the `mp.html` adapter (`__check.act`) is missing on both phones (M29-net-heap); (11) M34-two-devices never joins on either phone; (12) M18-pick passes on the iPhone and fails to land on the Pixel (touch adjustment to the ring's button); (13) iOS asks for the passcode on new WDA sessions: not automatable; (14) a click on a stale XCUITest element reference can hit a different switch: never click without checking the element's identifier; (15) `device-serve` orphans (vite preview, reference-server) survive a SIGKILLed tool and hold the ports 4173-4204: the next run fails with "device-serve exited (1)"; `reapStale` does not know them (not fixed).

