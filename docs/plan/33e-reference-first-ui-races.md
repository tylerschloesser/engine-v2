# M33e: The reference page's first-`Ui` races

Status: not started · After: 33d · Tyler-dependent: no

Written by the orchestrator at M33d's gate (2026-09-30). Two reference browser tests fail intermittently with a cause M30's Deviations already diagnosed ("Left, pre-existing", `docs/plan/30-interpolation.md`). They have reddened gates at M30, M32, M33 and M33d, M34 adds more browser tests to the same page, and one of the two is a production glitch a player can hit.

## Goal
A player who moves the camera before the first `Ui` arrives is not snapped back to spawn. `reference_player_circle_lags_and_settles` and `reference_craft_flow` no longer depend on when the first `Ui` reaches the main thread. Each fix has a test that is red without it, deterministically.

## The evidence
- **`reference_player_circle_lags_and_settles`**: `Expected: < 0.05, Received: 29.5` at `player.spec.ts:43`, every time exactly 29.5, so the circle is at x = 0.5, the spawn tile. `games/reference/src/game.ts`'s one-shot spawn move (`spawnDecided`, about line 120) calls `client.camera.moveTo(spawn, { durationMs: 0 })` on the first `Ui` without checking whether the camera has moved since the page started. `client.onUi` rides the real rAF, so under load the first `Ui` lands during the test's 128 settle frames and undoes its `__setCamera(30, 0, 20)`. Rates: 2 in 16 on M30's base, 1 in 15 at M30's head, 1 full-suite run and 1 of 15 targeted runs at M33d's gate (1-minute load 5-7).
- **`reference_craft_flow`**: `Expected: [], Received: undefined`: the test reads `uiState` before the first `Ui` was delivered. Once in M33's CI round, once in 15 targeted runs at M33d's gate, once for M33d's implementer.
- M30 already fixed the same race in `panTo` (it waits for a non-null `Ui`) and primed `lastUi` in `test-entry.ts`. Those fixes are the pattern; these two tests were left.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/30-interpolation.md` (Deviations: "Cause and fix 2" and "Left, pre-existing")
3. `docs/plan/20b-reference-player-and-collect-ui.md` (Scope and Deviations on the spawn `moveTo`)

Rules that apply: `games/reference/CLAUDE.md`. Skill: `run-tests`.

## Scope
- **Production:** the spawn move happens only if the camera has not been moved since the client was created. Decide how `game.ts` knows (the camera's state against what it was at creation, or a flag set by the first camera write); keep the decision in one small function that a test can call without a page. A fresh session with an untouched camera still starts on the spawn tile.
- **Tests:** every reference test helper that returns or reads `Ui` waits for a non-null one first (the `panTo` pattern). `reference_craft_flow` reads through such a helper. Do not change what either failing test asserts.

## Non-scope
Delivering `onUi` inside `stepFrame` under a manual clock (an engine change; ledger row, not decided here). `paced_session_lands_periodic_snapshots`. Any engine file.

## Files, packages and crates touched
`games/reference/` only (`src/game.ts`, `src/test-entry.ts`, `tests/helpers/game.ts`, tests).

## Seams
**Provides:** nothing new by name; `openGame`, `uiState`, `panTo` keep their signatures. **Consumes:** `client.camera.moveTo`, `client.onUi` (M16b, M20b); `pumpUntil` (M30).

## Planning decisions
- **Fix the glitch, not the test's timing.** Waiting for the first `Ui` before `__setCamera` in `player.spec.ts` would hide a defect a player can hit on a slow first frame. With the production fix the test needs no wait: its first `__setCamera` precedes the `Ui`, and the spawn move is then skipped.
- **The red must be deterministic.** The race cannot be forced by load. Either test the decision function directly, or give the test page a way to hold back `onUi` delivery until the test has moved the camera. A fix shown only by "it stopped flaking in N runs" is not accepted alone.

## Order of work
1. The spawn-move decision function, its red test, the fix. 2. Helpers wait for a non-null `Ui`; an injection that makes a late `Ui` deterministic shows `reference_craft_flow`'s old read failing and the new one passing. 3. Repeats.

## Tests added
- `spawn_move_skipped_once_camera_moved` and `spawn_move_applies_to_untouched_camera` (wherever `games/reference` can run a DOM-free TypeScript test; if it has no such suite, one browser test on `/test.html` that holds back the first `Ui`, named `reference_pan_before_first_ui_keeps_camera`, under 3 s, and no other new browser test).
- No test is weakened; `reference_new_player_spawns_on_land` still passes.

## Exit criteria
- [ ] The tests above pass by name and were red before the fix (red lines in the report).
- [ ] `reference_player_circle_lags_and_settles` and `reference_craft_flow`: 30 targeted foreground runs of the pair, 0 failures, with the 1-minute load recorded; a failure that matches a Chrome crash report at that minute is excluded and named.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t "player_circle_lags_and_settles|reference_craft_flow"` · `pnpm test browser -t reference`.

## Budgets
`browser` is at 42-44 s of 48 s (ADR 0036): at most one new browser test.

## Context artifacts
`games/reference/CLAUDE.md`: one line, "`onUi` arrives on the real rAF: a helper that reads `Ui` waits for a non-null one; page code that acts on the first `Ui` checks what the player did meanwhile".

## Manual device checks
None.

## Deviations
- Decision: `games/reference/src/spawn.ts` `shouldMoveToSpawn(restored, atCreation, now)`; `poseOf(cameraState)` is snapshotted in `startGame` before the `onUi` subscription. "Moved" = `centreX`, `centreY` or `tilesAcross` differ from the snapshot; viewport, velocity and frame time (written by `stepFrame`/resize) do not count.
- Tests: `spawn_move_applies_to_untouched_camera`, `spawn_move_skipped_once_camera_moved` in `src/spawn.test.ts` (unit suite already covers `games/*/src`; no new browser test). Red with the old `!restored`-only rule: `expected true to be false` at spawn.test.ts:12.
- Helper: `readUi(page)` in `tests/helpers/game.ts`; `test-entry.ts` `?lateUi=n` makes the first n `__uiState()` reads null. `reference_craft_flow` opens `/test.html?lateUi=3` and reads via `readUi` (assertions unchanged). Old read under `?lateUi=3`: `Expected: [] Received: undefined`, craft-flow.spec.ts:18.
- Repeat: 30 runs of the pair, 0 failures; load 5.40/10.09/9.48 before, 8.68/9.31/9.30 after. `browser -t reference`: 27 pass, 9.6 s.
