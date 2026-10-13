# M57: Measurements on browsers and phones

Status: not started · After: 56 · Tyler-dependent: no (Q5 default: `device:serve` + bench page, read by hand or a throwaway script)

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
The belts goldens hold in WebKit and Firefox; the belt bench page runs on the iPhone 12 (pass/fail) and the Pixel 5 (evidence) for tick time, frame time and memory with a dense belt world; the numbers are recorded by an ADR amending 0062's budget record; `device-check` rows exist for what only a phone shows.

## Read first
1. `docs/architecture/README.md`
2. `docs/architecture/testing-and-tooling.md` ("Determinism checks", "Manual device checks") and `.claude/skills/device-check/SKILL.md`
3. `docs/decisions/0062-budgets-as-measured-at-phase-3-exit.md` and `0056-ios-pacing-and-tick-bar.md`
4. `games/reference/CLAUDE.md` ("The bench page")
Skills: `device-check`, `run-tests`. Memory notes on Tyler's machine and phones apply (`cp`/`mv`/`rm` aliases; the Pixel has a PIN and is never put to sleep; not during his live round; every URL and step run end to end before it is handed to him).

## Scope (sketch)
- `determinism.spec.ts` `@engines` gains the `fx-belts` goldens; `pnpm test:slow browser -t "release variants"` includes them.
- The reference bench page gains `?bench=belts` (M45's world scaled to a viewport, spawners running, the camera over it at maximum zoom-out and at mid zoom, a slow pan); `window.__bench` reports tick p95, worker frame p95, main p95, records, `forecastSeenLate`.
- Phone runs through `pnpm device:serve --tunnel`: iPhone 12 Safari (pass/fail against the 0056 bar for tick, the 0018 §9 budgets for frames with the iOS reading of 0056), Pixel 5 Chrome (evidence); a throwaway script in the scratchpad may read `__bench` through WebDriver/adb; nothing from the deleted phone-round tool is revived.
- An ADR recording the belts budgets as measured (desktop proxies, phones, bytes), amending 0062; `device-check` rows `belts-frame-pacing` and `belts-memory` with their pages, steps and pass criteria.

- (Note 2026-10-12, M55 review) On a 390 px phone the construction palette wraps to two rows and its top row runs under the refusal-reason label (`build.ts`, 36 px above the bottom edge): check it in the phone round and move the label above the palette if it reads badly.

## Seams
**Provides:** `?bench=belts`, the device-check rows, the budgets ADR.
**Consumes:** M45 world, M50 bench page pattern, M56 builder.

## Exit criteria
- [ ] WebKit and Firefox replay every `fx-belts` golden to the same hashes.
- [ ] The iPhone 12 run is recorded (numbers in the ADR); a miss is a question to Tyler with the profile, not a widened budget.
- [ ] The `device-check` rows exist and were walked once by the session before being handed to Tyler.
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow browser` are green.

## Open questions (answered by earlier phases)
- M50: whether the tile-visual fallback is in; the phone frame numbers depend on it.
- M45: the phone `max_items`/`max_lines` defaults versus the memory read on the device.

## Deviations
(filled in during execution)
