# M53: Reference game: spawner, despawner and items on screen

Status: not started · After: 49, 52 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
Items flow on the reference page: a spawner belt creates its configured item on its configured lane at its rate (integer accumulator, waits when full), a despawner's lines end in `Sink`, the configuration panel sets both (a predicted `ConfigureBelt` action), items draw through `transport::draw_items` with the game's item style, belt sprites animate by the global tick, and the forecasts keep motion smooth in single-player and multiplayer. Phase end: tag `belts-playable`.

## Read first
1. `docs/architecture/README.md`
2. `games/reference/README.md` ("Belts": Spawner and despawner, Art, Motion on the client) and `games/reference/CLAUDE.md` ("Furnace": the panel pattern, machines sleep)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§3 `insert_back`, §5)
4. `docs/plan/49-draw-items-and-interpolation.md` Deviations (`ItemStyle`)
Rules that apply: `.claude/rules/hot-paths.md` (`client.rs`), `.claude/rules/prediction.md`.

## Scope (sketch)
- `rules/belts/spawn.rs`: spawners on an active list; per lane `acc += rate; while acc >= HZ { try insert_back }` (0006's accumulator), capped so a stall never bursts; a despawner's lines get `Sink` in `topology.rs`.
- `ConfigureBelt { tile, lane, item, rate }` action (predicted: an entity put), `Ui.belt` panel like `Ui.furnace`, `src/ui/belt.ts`.
- `RefClient::extract`: belt sprites with frame from `view.clocks()` tick phase, `draw_items` with `ItemStyle` (six item squares, `min_px_per_tile`); the gc reference page covers the new per-frame path.
- Browser tests: configure a spawner, see items appear and reach a despawner (DrawList counts and a pixel readback of an item square); netcode: two clients see the same item counts after settle; the full-game script gains a belt passage with a spawner and despawner (the headless and DOM drivers agree).

## Seams
**Provides:** `ConfigureBelt`, `Ui.belt`, `rules::belts::spawn`, `content::ITEM_STYLE`, tag `belts-playable`.
**Consumes:** M49 `draw_items`, M52 topology, M44 `Sink`.

## Exit criteria
- [ ] Rust: `spawner_rate_accumulator_never_bursts`, `despawner_sinks_and_counts`; browser: `reference_belt_items_flow` (readback), `reference_belt_panel`; netcode: `reference_belt_items_converge`; `gc-reference` still green with items moving.
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow browser -t reference_` are green; tag `belts-playable` on the pushed commit.

## Open questions (answered by earlier phases)
- M47: whether a spawner's inserts are forecast (`period`) or corrections; the panel's rate unit follows.
- M50: the sprite path or the tile-visual fallback for belt art.

## Deviations
(filled in during execution)
