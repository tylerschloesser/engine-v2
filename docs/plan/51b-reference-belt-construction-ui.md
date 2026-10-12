# M51b: Reference game: belt tools in construction mode (UI, browser tests)

Status: not started · After: 51 · Tyler-dependent: no (M51 carries the rule lines)

Split from M51 on 2026-10-12: the TypeScript half of placing belts.

## Goal
From construction mode a player picks a tool (furnace when one is in inventory; belt, spawner, despawner always), rotates it with a DOM button or `R`, sees a direction-aware ghost, and places, rotates or picks up belts by mouse or by touch (tap moves, Confirm places), with browser tests on the reference page and the test-page hooks the drivers need.

## Read first
1. `docs/plan/51-reference-belt-entities-and-placement.md` Deviations (what M51 built: `Tool`, `UiPlacing`, `LOCAL.PLACE_MODE` with a tool argument, `LOCAL.ROTATE_TOOL`, the belt ghost sprite), `games/reference/CLAUDE.md` (Conventions: construction mode, `Ui`, the DOM modules), `games/reference/README.md` "Belts" (Placement).
2. `games/reference/src/ui/build.ts`, `src/ui/furnace.ts` (the panel pattern), `src/test-entry.ts` (hooks), `tests/helpers/game.ts`, `tests/browser/place-mouse.spec.ts`, `place-touch.spec.ts`, `furnace.spec.ts`.
Rules: `.claude/rules/hot-paths.md` (the DOM layer is outside the zero-GC rule but emits input on the per-frame path only through fixed slots). Skills: `run-tests`, `device-check`.

## Scope
- `src/ui/build.ts`: a tool palette (Build → the four tools; the furnace tool shown only while `ui.can_build`), a rotate button and the `R` key while a belt tool is active (emit `LOCAL.ROTATE_TOOL`), the mouse tap dispatching `PlaceBelt { at, dir, kind }` from `Ui.placing`, the touch flow (tap moves the ghost anchor for a 1x1 footprint; Confirm places), Escape ends the mode; pick-up and rotate of a placed belt through a tap on it (a belt tap opens no panel in M51b: a small anchored two-button popover `Rotate` / `Pick up`, dispatching `RotateBelt`/`PickUpBelt`; the furnace tap keeps its panel).
- `src/test-entry.ts` hooks `__dispatchPlaceBelt`, `__dispatchRotateBelt`, `__dispatchPickUpBelt`; `tests/helpers/game.ts` `placeBelt`, `rotateBelt`, `pickUpBelt`, `BELT` sprite ids; `tests/helpers/script.ts` steps (not yet used by `fullGame()`: the golden stays).
- Browser tests: `reference_belt_place_rotate_pickup` (mouse: pick the belt tool, rotate twice, place, the real sprite's direction, tap → rotate, tap → pick up), `reference_belt_ghost_predicted` (the ghost sprite shows the direction and the valid/invalid tint; after a tap the `PREDICTED` sprite then the real one), `reference_belt_touch_confirm` (tap moves, Confirm places), `reference_belt_keyboard_rotate` (`R`), `reference_belt_tool_palette` (the furnace tool appears only with a furnace in inventory; the belt tools always).
- Docs: `games/reference/CLAUDE.md` (the tools, the popover, the hooks), `README.md` "Not implemented".

## Non-scope
The spawner configuration panel (M53); lines (M52); art (M51).

## Files touched
`games/reference/src/ui/build.ts`, `src/ui/belt.ts` (new, the popover), `src/game.ts` (wiring), `src/test-entry.ts`, `tests/helpers/{game,script}.ts`, `tests/browser/belt-*.spec.ts` (new), `README.md`, `CLAUDE.md`, `assets/*.css` if styles live there.

## Exit criteria
- [ ] The five browser tests pass with an inject-fail-revert each; the existing place/furnace specs unchanged.
- [ ] `pnpm test` and `pnpm lint` green; the browser suite within its 60 s budget (say the total).

## Verification commands
`pnpm test browser -t reference_belt` · `pnpm test browser -t reference_` · `pnpm --filter reference typecheck` · `pnpm test && pnpm lint`

## Budgets
The browser suite 60 s (54.6 s used after M49); `gc.pages.reference*` unchanged (the DOM layer).

## Deviations
(filled in during execution)
