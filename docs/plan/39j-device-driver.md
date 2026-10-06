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
