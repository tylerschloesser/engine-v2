# PLAN: belts

The index of the belts effort: milestone order, dependencies and progress. One brief per milestone lives in `docs/plan/<NN>-<slug>.md` (format and rules: `docs/plan/README.md`); the manager session of `PROMPT.md` reads the brief and delegates or does the work. Requirements are Tyler's (`games/reference/README.md` "Belts", `docs/architecture/README.md`); decisions are ADRs ([0076](docs/decisions/0076-transport-lines-engine-game-split.md) the engine/game split, [0077](docs/decisions/0077-transport-item-representation.md) the item representation, [0078](docs/decisions/0078-transport-forecast-replication.md) forecasts); working rules are [0069](docs/decisions/0069-working-rules-learned-in-phase-3.md). Numbering continues from Phase 3 (which ended at M39) so a milestone id is unambiguous in comments and ADRs.

## How milestones work

- **One milestone = one brief**, done by the manager or by one sub-agent it briefs with files ([0021](docs/decisions/0021-context-architecture.md) §3; delegation rules in `PROMPT.md`). The manager ticks the box here when every exit criterion in the brief is met and verified by its gate; the implementer records deviations in the brief's **Deviations** (and a new ADR when a decision changes).
- **The table is in execution order.** Take the first unticked row whose **After** milestones are all ticked. A `b`/`c` suffix is a split made to meet the sizing rule, not a lesser milestone. A row that needs Tyler first (an answer, a phone in his hands) is skipped while another row is ready.
- **Sizing rule every brief meets:** one new subsystem or one vertical cut; at most three packages or crates touched; reading list of `docs/architecture/README.md` plus at most three files; roughly 1,500 lines of new code and tests or fewer; verification that runs in minutes. An implementer that finds its milestone too big stops at a step boundary and reports; the manager splits it (new brief, new row) rather than letting it overrun.
- **Phases** end in a tagged, green, pushed commit and a plan revision (below). Tags: `belts-core-complete` after M45, `belts-replicated` after M48, `belts-playable` after M53, `belts-complete` after M58. Everything is on `main`.
- **T** = planned on an assumed default that Tyler has not answered (the line is marked **(assumed)** in `games/reference/README.md` "Belts"). **D** = a manual device check is added to the `device-check` skill; device checks never block the next milestone, and a failed check opens a plan edit.

## How this plan is revised

The plan is revised from measurements, at every phase end and whenever a milestone's Deviations change what a later milestone must do. The manager makes the edit in the same commit as the measurement or the gate that caused it:

- **Split a row** when a milestone exceeds the sizing rule: add `<NN>b` after it with its own brief; the original brief's Non-scope names what moved.
- **Add a row** when a gate finds work no row holds (a defect, a missing test, a measurement that needs a fix): a new brief, placed in execution order, with the gate that found it named in the brief's Goal.
- **Rewrite a later brief** when a measurement answers one of its open questions or changes its approach: the brief's Planning decisions cite the measurement (milestone and Deviations section); a short brief is filled in to the full template at the start of its phase at the latest.
- **Record a moved decision** in the brief's Deviations and in an ADR (`write-adr` skill) when an accepted decision changes or a Proposed ADR (0077, 0078) is accepted, superseded or amended; a changed game rule is a dated line in `games/reference/README.md` after Tyler's answer; a changed default quoted in `docs/architecture/README.md` is his.
- **Plan-level decisions** (an order change, a dropped row, a budget that moved with Tyler's answer) are listed under "Plan-level decisions" below, one line each with the date.

## Milestones

| | # | Brief | Lands | After | Marks |
|---|---|---|---|---|---|
| [x] | 40 | `40-item-representation-spike.md` | `fx-belts` fixture skeleton; native spike of the item representations of 0077 on the standard belt world (50,000 tiles, 250,000 items), four regimes; 0077 amended to Accepted with the winner | — | |
| [ ] | 41 | `41-forecast-spike.md` | native spike of the dirty-marking and cheap forecast of 0078 on the spike sim: correction rate, estimated bytes, tracker cost; 0078 confirmed or revised | 40 | |
| [ ] | 42 | `42-transport-core.md` | `engine::transport` in `Store`: lines, runs (the winner), `advance`, `DeadEnd`/`Next`/`Sink`, update order, `insert_back`, codec/hash/snapshot, `WorldRead`/`WorldWrite` accessors, `max_lines`/`max_items`, `no_alloc_transport`, first `fx-belts` goldens | 40 | |
| [ ] | 43 | `43-transport-surgery-and-geometry.md` | `split`/`join`/`extend`/`shrink`/`rescale`/`destroy`, `insert_at`/`remove_at`/`front`, segment geometry, derived chunk set and tile index, edit-while-running goldens | 42 | |
| [ ] | 44 | `44-transport-merge-and-fork.md` | `Output::Merge` and `Output::Fork`, big-step crossings (`speed >= SPACING`), side-load and splitter goldens, conservation and throughput properties | 43 | |
| [ ] | 45 | `45-transport-scale-benchmark.md` | `slow_tick_belts_large` at the stated scale with baseline `belts-tick.json` (limit 5 ms), the Node twin (WASM ratio, warn-only), `max_lines`/`max_items` defaults checked on the phone split. **Core complete.** | 41, 44 | |
| [ ] | 46 | `46-line-structure-replication.md` | section `LineStructs` (12), chunk-snapshot membership by anchor, replica structure store, chunk hash of structures only, netcode convergence with belts, `no_alloc_wire` extended | 45 | |
| [ ] | 47 | `47-forecasts-and-corrections.md` | host dirty marking in `advance`, cheap forecast builder, section `Forecasts` (13), replica forecast store with `pos_at(render_t)`, correction counters, the saturated-viewport scenario and the 16 KB/s budget row | 46 | |
| [ ] | 48 | `48-transport-prediction-join-and-edits.md` | `Unknown` under prediction, predicted belt without items, edits during flow replicate consistently, late join at scale measured, degrade and overflow rules of 0078 §7. **Replicated.** | 47 | |
| [ ] | 49 | `49-draw-items-and-interpolation.md` | `transport::draw_items` with the game style, geometry evaluation at `render_time`, pixel-size LOD, `fx-belts` drawables golden native vs `.wasm`, zero-GC page `gc-belts` | 48 | |
| [ ] | 50 | `50-dense-viewport-frame-budget.md` | `bench.frame_belts`: a dense viewport at maximum zoom-out under the desktop proxies, the fallback decision (animated tile visual) if missed | 49 | |
| [ ] | 51 | `51-reference-belt-entities-and-placement.md` | belt, spawner and despawner entities, `PlaceBelt`/`RotateBelt`/`PickUpBelt`, construction mode with rotate, predicted ghost, generated belt and item art, `SCHEMA_VERSION` bump | 48 | T |
| [ ] | 52 | `52-reference-belt-topology.md` | host tick-rule topology: shapes R1-R7, straight-through join/split, curves with rescale, side-load merges, the tile index, the full-game golden extended | 51 | T |
| [ ] | 53 | `53-reference-spawner-despawner-and-items.md` | spawner and despawner tick rules, the configuration panel, item style and `draw_items` on the reference page, belt animation, browser tests. **Playable.** | 49, 52 | |
| [ ] | 54 | `54-reference-splitters.md` | the 2x1 splitter entity on `Fork`, rotate, art, tests | 53 | T |
| [ ] | 55 | `55-reference-undergrounds.md` | entrance and exit entities, nearest-exit pairing within the span, the hidden line, art, tests | 53 | T |
| [ ] | 56 | `56-belt-scenarios.md` | complex scenarios natively and in the browser: balancers, loops, mixed speeds (fixture), saturated splitters, side-loaded undergrounds; conservation, throughput and lap-time properties | 50, 54, 55 | |
| [ ] | 57 | `57-belt-measurements-browsers-and-phones.md` | WebKit and Firefox determinism with belts, phone runs of the belt bench page (tick and frame), budgets recorded by ADR, `device-check` rows | 56 | D |
| [ ] | 58 | `58-belts-docs-and-cleanup.md` | `docs/architecture/transport.md`, every doc a belts commit made wrong, nested `CLAUDE.md` files, a rule file if an invariant emerged, the plan folded into a decisions ADR, `PLAN.md`/`docs/plan/`/`PROMPT.md` deleted, tag `belts-complete` | 57 | |

## Plan-level decisions

- 2026-10-11: engine `Merge` and `Fork` primitives are built in the core phase (M44) because the line abstraction needs them to be right before replication; the reference game's splitter and underground entities follow playability (M54, M55).
- 2026-10-11: the item representation and the forecast scheme are measured by native spikes (M40, M41) before any production code; the spikes ship nothing.
- 2026-10-11: Tyler's Q4-Q7 defaults stand (placement, phone automation, art, numbers); recorded as dated lines in `games/reference/README.md` "Belts".
