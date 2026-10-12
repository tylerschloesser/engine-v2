# M51: Reference game: belt entities and placement

Status: not started · After: 48 · Tyler-dependent: T (the **(assumed)** lines of `games/reference/README.md` "Belts": lanes, shape rules, no belts over resources)

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
(Note 2026-10-11, 0079 §5: the reference game must set `WorldConfig.params.maxLines`/`maxItems` (recommended 32,768 / 262,144) in every place it builds a world config, since the engine default is 0; the netcode soak's 8 MiB sim arena then needs either the soak's own smaller caps or a larger arena, decided here with the memory measured.)

The reference game has belt, spawner and despawner entities a player can place, rotate and pick up from construction mode, predicted as ghosts, with generated belt and item art; no lines yet (M52 maps them). Every rule line this milestone implements cites `games/reference/README.md` "Belts".

## Read first
1. `docs/architecture/README.md`
2. `games/reference/README.md` ("Belts", "Crafting and building") and `games/reference/CLAUDE.md` ("Conventions": placement, construction mode, adding an item)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§6, §9)
4. `.claude/skills/add-action-type/SKILL.md`
Rules that apply: `.claude/rules/prediction.md`, `.claude/rules/determinism.md`.

## Scope (sketch)
- `RefEntity` becomes an enum (`Furnace`, `Belt { origin, dir, kind: Belt | Spawner | Despawner, shape (derived, written by M52), spawn: [Option<(item, rate)>; 2] }`); prototypes and footprints; `SCHEMA_VERSION` bump; the full-game golden re-recorded (reviewed diff).
- Actions `PlaceBelt { tile, dir, kind }`, `RotateBelt { tile }`, `PickUpBelt { tile }` (addressed by tile, 0022 §6; `growth` declared); `can_place` by traits (belts carry `NOT_BUILDABLE`; may not cover a resource: the assumed line).
- Construction mode: a belt tool with a rotate control (DOM button and keyboard `R`), the ghost shows direction; touch: tap moves, Confirm places (the furnace pattern).
- Art: `gen-assets.mjs` emits belt sprites (straight, left curve, right curve, spawner and despawner marks; 8 animation frames of lane marks; FLIP/rotation by direction through `param` or four sprites) and six item squares (one per `ItemId`), deterministic; `sprites.json` frame counts.
- Browser tests on the reference page: place, rotate, pick up, predicted ghost then real; netcode: two players placing on the same tile (one rejected).

## Seams
**Provides:** `RefEntity::Belt`, the three actions, `content::{BELT_PROTO, SPRITE_BELT_*, SPRITE_ITEM_*}`, `src/ui/build.ts` belt tool, `tests/helpers/game.ts` `placeBelt`.
**Consumes:** M48 (the engine side complete), the furnace placement code (M33), `add-action-type`.

## Exit criteria
- [ ] Rust: `place_belt_rules` (traits, resources, occupied), `rotate_keeps_entity`, `pickup_despawns`; browser: `reference_belt_place_rotate_pickup`, `reference_belt_ghost_predicted`; netcode: `reference_belt_same_tile_race`.
- [ ] `gen_assets_reproducible` still passes; the full-game golden is re-recorded once with a reviewed diff.
- [ ] `pnpm test` and `pnpm lint` are green.

## Open questions (answered by earlier phases)
- Tyler: the **(assumed)** lines this milestone builds on; asked in the batch before the phase starts (`PROMPT.md`: ask early, batched, with the default).

## Deviations
(filled in during execution)
