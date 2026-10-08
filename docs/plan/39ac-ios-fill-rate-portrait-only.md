# M39ac: the iPhone's driverless M09b measures portrait only

Status: not started · After: 39ab · Tyler-dependent: no (Tyler agreed 2026-10-07)

## Goal
ADR 0056 judges iOS frame-pacing items only from driverless QR runs. M09b-fill-rate measures one 60 s window per orientation, with a "Rotate the phone to landscape/portrait." prompt between them (`scripts/lib/device-walk/agent/driver.js`, about lines 112-260), and every ladder rung repeats both. A page cannot rotate an iPhone (Safari has no `screen.orientation.lock`), so in a driverless run Tyler has to turn the phone, up to 4 times. The landscape window adds nothing to the fill-rate question on a phone: it is the same pixel count with a different aspect. Resize handling is covered elsewhere, by M11-gestures' rotation criterion (`rotation_keeps_centre`), which the driver can do without skewing timing. Tyler agreed on 2026-10-07 to measure portrait only there. When this is done, M09b on iOS asks for no rotation, and passes or fails on its portrait windows alone.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0056-ios-pacing-and-tick-bar.md`
3. `docs/plan/39z-ios-pacing-and-tick-bar.md` Deviations (`verdictContext`, the platform from the round's `env`)

## Scope
1. **Collector.** M09b's fill-rate collector measures one portrait window per rung and shows no rotate prompt when the page is on iOS. Decide iOS at the page from the user agent, the same rule as `verdictContext` (iPhone, iPad, iPod). If the phone starts in landscape, the one prompt asks for portrait once. Android and desktop are unchanged: both orientations, as now.
2. **Criteria.** On iOS `windows_measured` needs 1 window, every portrait, and the record says portrait-only. Android stays at 2. Update the M09b **Pass** text in `docs/plan/device-checks.md` and its `pass:` hash.
3. **ADR 0057** (`write-adr` skill), short, amending ADR 0056: iOS M09b is portrait-only, why (same pixel count; a page cannot rotate; rotation on the driverless leg needs a person; resize is covered by M11's rotation criterion), and that Tyler agreed on 2026-10-07.
4. **Tests** (`pnpm test tools`), red first: an iOS fake page runs M09b with no rotate prompt and passes on 1 portrait window per rung; an iOS page starting in landscape gets exactly one "portrait" prompt; an Android page still gets the landscape prompt and needs 2 windows.

## Non-scope
M18-anchors' orientations; any limit; re-running rounds (the orchestrator's).

## Files touched
`scripts/lib/device-walk/agent/driver.js`, `scripts/lib/device-walk/checks.mjs`, their tests, `docs/plan/device-checks.md` (the M09b section only), the new ADR.

## Exit criteria
- [ ] The three tests exist, pass, and were seen red (red lines pasted).
- [ ] ADR 0057 exists; the M09b Pass text and hash match.
- [ ] `pnpm test tools` green (pasted line).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test tools` (targeted, foreground). No phone runs.

## Manual device checks
The orchestrator's driverless iPhone round with Tyler.

## Deviations
(filled in during Phase 3)
