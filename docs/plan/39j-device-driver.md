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
(filled in during Phase 3)
