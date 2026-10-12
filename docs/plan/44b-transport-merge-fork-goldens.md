# M44b: Merge and fork goldens and properties (`fx-belts`)

Status: done (2026-10-12) · After: 43b, 44 · Tyler-dependent: no

## Goal
`fx-belts` drives M44's `Merge` and `Fork` through requests and pins them across runtimes: a saturated side-load at the early and the late entry, a contested target, a 50/50 fork, a blocked side, a big-step fork; and four seeded property tests (conservation, the spacing invariant, throughput, ring lap time) that M56 reuses. Split from M44 on 2026-10-11 (sizing rule), the same shape as M42b and M43b.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§1 `Output`, §2) and `games/reference/README.md` "Belts" (side-loading and splitter simplifications)
3. `docs/plan/44-transport-merge-and-fork.md` (Seams, Planning decisions, Deviations: the real `Merge`/`Fork` semantics as built)
4. `docs/plan/43b-transport-surgery-goldens.md` (Deviations: the ops and the golden pattern as they stand)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`. Skills: `run-tests` (`pnpm golden belts`).

## Scope
- `fx-belts` `Op` gains `Merge { line, into, at }` and `Fork { line, a, b }` (`set_out`), executed by `Belts::tick` like the other ops.
- Goldens (`pnpm golden belts`): `sideload-saturated` (one feeder lane onto an empty target at the early and the late entry), `sideload-contested` (target fed from behind at 1 item per 8 ticks, feeder saturated: the feeder fills gaps and never starves the target), `fork-50-50` (one input, both outputs draining: counts differ by at most 1 after 1,000 ticks), `fork-blocked-side` (one output dead-ended: everything goes to the other, the toggle holds), `big-step-fork` (speed 96 into a fork). Each native test asserts its property and the hash.
- Lift the scenario runner's 32-action cap (M43b Deviations: `runScriptScenario` in `packages/engine/tests/support/scenario.ts` sends every action through an encoder client whose pending queue, capacity 32, is never acked, so the 33rd action fails `OutOfMemory`; M43b's `inserter-like` golden runs its insert/remove pair for 14 ticks because of it): acknowledge the encoder client's queue as the real host does, or drain it per scripted tick, so a scenario may carry hundreds of actions; a native and a Node test with 40 actions prove it. This is the one edit outside `fixtures/belts/` this milestone makes.
- Properties as seeded scripted tests in `fixtures/belts/tests/props.rs` with helpers in `tests/common/props.rs` (M56 reuses them): `prop_conservation` (spawned = live + sunk + destroyed across random edits), `prop_spacing_invariant` (never under `SPACING` on a line or across a plain hand-off except a squashed pair a rescale made, checked every tick), `prop_throughput` (a saturated lane delivers `20 x speed / SPACING` items per second within 1 %), `prop_ring_lap_time` (a closed ring of four lines: an item laps in `total_len / speed` ticks, within one tick).

## Non-scope
- Any change to `engine::transport` (a defect found here is reported, fixed in the engine crate and recorded under M44's Deviations). Who wires forks and merges (M52, M54).

## Files, packages and crates touched
- `packages/engine/fixtures/belts/` (`src/lib.rs`, `tests/golden_scenarios.rs`, `tests/props.rs`, `tests/common/props.rs`, `golden/*.json`, `CLAUDE.md`); `packages/engine/tests/support/scenario.ts` (the action cap).

## Seams
**Provides:** the two ops; goldens `sideload-saturated`, `sideload-contested`, `fork-50-50`, `fork-blocked-side`, `big-step-fork`; `tests/common/props.rs` (M56).
**Consumes:** M44's `Output::Merge`/`Fork`, `TransportRead::toggle`; M43b's ops and golden pattern; M42b's request pattern.

## Planning decisions
- **Properties beside hashes** (0069 §3), and a property that cannot pass trivially (every property asserts the world did something: items sank, forked, lapped).

## Order of work
1. The two ops; a native smoke test each.
2. The five scenarios and their properties; `pnpm golden belts`; `pnpm test wasm -t determinism`.
3. The four property tests; `fixtures/belts/CLAUDE.md`; Deviations.

## Tests added
Rust suite (`fx-belts`): `belts_golden_sideload_saturated`, `belts_golden_sideload_contested`, `belts_golden_fork_50_50`, `belts_golden_fork_blocked_side`, `belts_golden_big_step_fork`, `prop_conservation`, `prop_spacing_invariant`, `prop_throughput`, `prop_ring_lap_time`. `wasm` suite: the goldens replay under Node and Bun through the discovery leg.

## Exit criteria
- [x] The five goldens match natively, under Node and under Bun; `fork-50-50` ends with output counts differing by at most 1; each had an inject-fail-revert.
- [x] The four properties pass, each with an inject-fail-revert (a removed room check reddens `prop_spacing_invariant` by a stated number).
- [x] The fast `rust` suite stays inside 10 s and `wasm` inside 7 s.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t belts_golden` · `pnpm test rust -t prop_` · `pnpm golden belts` · `pnpm test wasm -t determinism` · `pnpm test && pnpm lint`

## Budgets
- Fast-tier suite budgets: `rust` 10 s, `wasm` 7 s.

## Context artifacts
`fixtures/belts/CLAUDE.md` (ops, properties).

## Manual device checks
none

## Deviations
Steps 1-3 by the implementer (2026-10-12); the commit is the manager's.

**Built** (lines after): `fixtures/belts/src/lib.rs` 675 (`Op::Merge`, `Op::Fork`, `Op::Destroy`, `Thing::Destroyed` on a `"destroyed"` active list), `tests/golden_scenarios.rs` 1,373 (six goldens, `belts_op_merge`, `belts_op_fork`), `tests/props.rs` 474, `tests/common/props.rs` 267 (`World`, `Ledger`, `Gap`, `chain`, `pick`, `between`), six `golden/scenario-*.json` (114-168 lines; `forty-actions` 742) and their `golden-*.json`, `CLAUDE.md` 60 (cap 60); `packages/engine/tests/support/scenario.ts` 299. No engine file changed; the seven earlier `fx-belts` hashes did not move (new variants appended last, `Thing::Destroyed` exists only after a `Destroy`).

**The action cap.** `runScriptScenario` now acks the encoder as a host does: after each scripted tick that admitted actions it calls `sim_build_frame(0)` and hands the frame to the encoder's `on_frame` (its header's `ack_seq` pops the pending queue, `ClientCore::on_frame_single`), then drains the encoder's UI ring. Building a frame reads the world only: every existing golden (fixtures `hash`, `puts` script-a, `machines`, `belts`) replays unchanged under Node and Bun, and the native legs need no change. Proof: `forty-actions` (42 actions; native, Node, Bun to `52989225009eba9f`). Inject (the ack call removed): both legs red, "determinism: node matches golden belts/scenario-forty-actions.json: on_action at tick 92: OutOfMemory" (tick 92 sends seq 33), and the Bun leg the same.

**Goldens** (`maxLines` 16, `maxItems` 512, speed 24 unless stated; properties after every tick):
- `sideload-saturated` (tick 200, `ca66798654996996`): feeders (2 tiles, `period` 256 spawners) side-load onto empty sinking targets (2 tiles) at `at = 64` (chains 1 -> 0) and `at = 192` (3 -> 2). Per half: the feeder never waits (its items are the last tick's moved 24 plus the spawner's `max(488, tail + 64) - 24`); every crossing lands at `at - (24 - front)` and stays put; the target's items are exactly `SPACING` apart and ahead of the entry; ticks 100-200 sink what the spawner inserted within one item; over 50 landings per half.
- `sideload-contested` (tick 300, `1b443d5ec6c0b3e8`): target 4 tiles fed from behind (item 1, `period` 2048), feeder 2 tiles saturated (item 2) at `at = 512`. Item 1's spawner inserts every 8th tick (`spawned == t / 8`, never held) and every item 1 is the last tick's moved 24 (never waits); item 2 sunk = spawned - live; ticks 200-300 sink at least 37 (measured 38: saturated, the feeder fills every gap).
- `fork-50-50` (tick 1,000, `54478fae323f971f`): input 2 tiles saturated, fork onto two 2-tile sinks. Every tick `delivered(a) - delivered(b)` is 0 or 1 and `toggle == (a ahead)`; at the end the sunk counts differ by at most 1, both above 150, over 100 toggle flips.
- `fork-blocked-side` (tick 200, `1d024ee2c301f5d9`): fork onto chain 1 (1 tile, `DeadEnd`) and chain 2 (2 tiles, `Sink`). Chain 1 is full (0, 64, 128, 192) at tick 39 and nothing more reaches it; the toggle is `false` from tick 40 (the first delivery after) to the end; more than 50 items reach chain 2; conservation.
- `big-step-fork` (tick 60, `4a0c0f28e94706e6`): speed 96, 4-tile lines; items at rest at 0 and 64 fork in tick 5: item 1 onto `a` at 928, item 2 onto `b` at 992, toggle back to `false`; spawner from tick 10 (first item at 832); alternation as in `fork-50-50`; conservation.
- `forty-actions` (tick 160, `52989225009eba9f`): one 8-tile sink, 40 `Insert { pos: 1000 }` every 3 ticks; each lands at 976; `inserted == live + sunk`; 40 inserted, 40 sunk.

**Properties** (`tests/props.rs`, seeded `SimRng`, requests on a native `Sim`): `prop_conservation` (6 seeds x 300 ticks, random cut/join/destroy/insert/remove/take-front one tick in four; `spawned + inserted == live + sunk + removed + taken + destroyed`, dead lines' final sunk counts carried by `World`); `prop_spacing_invariant` (8 seeds x 400 ticks at a random speed of 24/48/72/96, random rescale/cut/join/insert/remove one tick in six on lines without a spawner; across the seeds 32 short pairs explained by a rescale window and 334 by a merge landing (whole-line excuses, replaced in Review fixes 1)); `prop_throughput` (6 seeds, speed 16-64 on a random `Next` then `Sink` path, 600 ticks after filling, within 1 %); `prop_ring_lap_time` (12 seeds, ring of four lines of 1-4 tiles at speed 8-96: one item, or four items `SPACING + speed` apart; every item moves exactly `speed` per tick mod the ring, laps take `floor`/`ceil(total / speed)`).

**Changed from the brief, and why.**
1. *`Op::Destroy` and `Thing::Destroyed` added.* `prop_conservation` needs destroys and a destroyed count; the count is its own entity, not a `Tally` field, so `inserter-like`'s hash stayed.
2. *A sixth golden, `forty-actions`*, is the cap's 40-action native/Node/Bun proof (no other scenario needs 33 actions).
3. *The spacing exception is wider than "the clamp to 0".* Any merge landing within `SPACING` of the target's front (`at - o`, clamped or not) may sit closer than `SPACING` to the target's `Next` tail: `insert_at`'s room rule (0079 §15) checks the target line only. Seen at every speed (seed 7, speed 24: gap 50 across chain 0 -> 1). The property excuses exactly that pair (computed from the feeder's positions the tick before) and a rescale's window; inserts stay `SPACING` from both ends of a line for the same line-local reason. A removed engine room check could not be injected (engine off limits); see the injects below.
4. *`prop_throughput` speeds stop at 64*: a spawner makes one `insert_back` a tick, so it saturates a lane only up to `SPACING` per tick.
5. *The packed-block ring is its own test, `prop_ring_lap_time_packed_block`*: it found the defect below (`#[ignore]`d until M44's fix, green since).
6. *Fork injects are in the fixture* (the toggle lives in the engine): `Fork` built with `a` and `b` swapped.
7. *`common/props.rs` is included by `#[path]`* from `props.rs`, not from `common/mod.rs`: the spike binaries include `common` and define their own `#[global_allocator]`, which conflicts with `fx_belts`'.

**Engine defect found, fixed in M44's cut-budget round (0079 §11): a packed pair crossing a cycle's cut waited a tick.** The cut's lowest id advanced first, so its front item was bounded by the target's tail as it stood *before* the target moved; a follower exactly `SPACING` behind held one tick, a packed block crossed spread to `SPACING + speed`, and the cut link carried at most `speed / (SPACING + speed)` items per tick (0.27 at speed 24, against 0.375 packed). Found by `prop_ring_lap_time_packed_block` (seed 6: speed 53, ring 2816, eight items at 0..448 on chain 0): "tick 0: item 2 moved 53 (ring 2816)", left 2059, right 2006. With M44's fix in the tree the test is un-ignored and green.

**Inject-fail-revert** (each injected, run, reverted from a saved copy and `cmp`-checked):
- `Merge` built with `at + 1` (`lib.rs`): `belts_golden_sideload_saturated` red "tick 21: half 0: target = moved + landing at at - o", left `[49]`, right `[48]`; `belts_golden_sideload_contested` red "ticks 200-300: the target sank 26".
- Scenario `sideload-saturated` `at` 64 -> 65: the same landing message; hash `1821e6711b632e2c` instead of `ca66798654996996` (read with `pnpm golden belts`, goldens restored).
- `Fork` with `a`/`b` swapped: `fork_50_50` "tick 21: alternation: a 0, b 1"; `fork_blocked_side` "tick 45: the toggle holds on the blocked side"; `big_step_fork` "tick 5: item 1 onto a", left `[(2, 992)]`; `belts_op_fork`.
- `golden-fork-50-50.json` `...971f` -> `...971e`: Node and Bun "checkpoint 0: got 54478fae323f971f, golden has 54478fae323f971e", native `assert_golden` red.
- `count_destroyed(.., n + 1)`: `prop_conservation` "seed 0 tick 62: spawned + inserted == live + sunk + removed + taken + destroyed", left 49, right 50.
- Spacing excuses removed: without the landing excuse "seed 1 tick 13 (speed 48): unexcused short pair Gap { line: LineId(1), target: Some(LineId(2)), gap: 48 }"; without the rescale excuse "seed 0 tick 263 (speed 48): unexcused short pair Gap { line: LineId(2), target: None, gap: 55 }". (Inserts anywhere on the line stayed green for these seeds.)
- Spawner `acc += 192` (three attempts in four ticks): `prop_throughput` "seed 0: speed 42, 4 + 6 tiles: 10 items/s, want 13.125". (A first inject, a refusal dropping the credit, is a no-op at `period` 256.)
- `create(.., speed + 1)`: `prop_ring_lap_time` "seed 0 tick 0: item 1 moved 76 (ring 1792)", left 869, right 870.
- The action cap restored: above.

**Results.** `pnpm test rust -t belts_golden` 13, `-t prop_` 4, `-t belts_op` 7; `pnpm golden belts` idempotent (13 hashes, the seven earlier ones unchanged); `pnpm test wasm -t determinism` 47 (35 before); `pnpm lint` green; full `pnpm test` green at load 5.9 (rust 3.9 s of 10, wasm 3.3 s of 7).

**Review fixes** (`m44b-review.md`, the manager's items; 2026-10-12, with M44's cut fix in the tree):
1. *Per-pair exceptions in `prop_spacing_invariant`.* A merge landing within `SPACING` of its target's front or back excuses only its own pair: the target's front item to its `Next` target's tail, or its tail item to the front of the line feeding it by `Next`, while that landed item (followed by kind, moving at most `speed` ahead a tick) is still the front or the tail. A rescale excuses pairs on the rescaled line or with it at one end, and the number of such pairs may never grow (dropped at 0; passed to a cut's back part and a join's front). The counts are pinned: `[("landing", 86), ("rescale", 73)]`. Per-pair keying exposed two more line-local cases the old whole-line excuse had hidden: (a) a landing near the target's *back* is short to its `Next` feeder's front (seed 2 tick 18, speed 48: landing 14 on a 62-long cut line, gap 50); now excused as above. (b) A plain hand-off onto an *empty* line shorter than `SPACING + speed` lands within `SPACING` of the line after's tail: the hand-off checks only its target's tail (seed 2 tick 19: landing 16 on the 62-long line, gap 32 to the next line's tail at 336 of 352). No edit in the property now makes a line shorter than `SPACING + speed` (cuts and rescales are bounded); the reference game's shortest lane (106 at speed 24) is above that bound. **For the manager:** (b), and the insert near a line's end (review finding 5), are engine semantics no ADR states (0079 §15 covers only the merge landing).
2. *Engine inject* (`crates/engine/src/transport/`, reverted byte-exactly, `cmp`-checked against copies; `items.rs` shows no diff, `advance.rs` only M44's): the `SPACING` room checks in `insert_at_slot` (`items.rs`, both sides) and in `land_fresh_at` (`advance.rs`, both sides) reduced to `< 1`, which drops the room rule for `insert_at` and both merge-landing paths. `prop_spacing_invariant` red: "seed 0 tick 12 (speed 48): unexcused short pair Gap { line: LineId(2), target: None, gap: 52 }". Control, engine intact: green with the pinned counts.
3. *Ack on every tick.* `runScriptScenario` builds connection 0's frame and feeds the encoder after every tick once connected, not only on ticks with actions, so the encoder's replica follows every `Global`/`OwnPlayer` change; before `sim_admit` it asserts that the uplink's first byte is `UplinkBatch` (`0x02`, `wire::MsgType`), so a `ResyncChunk` throws instead of being admitted. `pnpm golden belts` is idempotent (every `golden*.json` `cmp`-equal to the copy taken before), and `pnpm test wasm -t determinism` passes 47 tests, `machines` and `puts` included. Inject: expected type `0x04` -> "runScriptScenario: encoder uplink at tick 1 starts with message type 2, not UplinkBatch".
4. *Stale text:* the `prop_ring_lap_time` and `_packed_block` docs, `fixtures/belts/CLAUDE.md` and the defect paragraph above now say the defect was found here and fixed in M44.
5. *Nits:* `fixtures/belts/CLAUDE.md` rewrapped at 100 columns (60 lines).

Rerun after the fixes: `pnpm test rust -t prop_` 5, `-t belts_` 20, `pnpm golden belts` idempotent, `pnpm test wasm -t determinism` 47, `pnpm lint` green, full `pnpm test` green (started at load 1.5 / 4.9, which a foreign job took to 34 during the run: rust 4.7 s of 10, wasm 6.2 s of 7, browser 85 s of 60 WARN, timings not evidence).

**Manager's gate and review (2026-10-12).** Adversarial review (an Opus reviewer, read-only): no blocker; the spacing property's exceptions were per line and unpinned (now per pair with the counts pinned: landing 86, rescale 73), the engine inject the exit criterion asks for was done in the test (now in the engine, reverted byte-exactly: "seed 0 tick 12 (speed 48): unexcused short pair ... gap: 52"), the scenario runner acked only on ticks with actions (now every tick, and it asserts the uplink starts with `UplinkBatch`); all fixed in "Review fixes". The property found two own-line spacing cases no ADR stated, now 0079 §15 (a landing near the target's back against the feeder's front; a hand-off onto an empty line shorter than `SPACING + speed`). The ring property found the cut defect M44's cut rounds fixed (0079 §11). Reran on the final tree: `belts_` 20, `prop_` 5, `pnpm golden belts` idempotent (13 hashes), lint green, full `pnpm test` green at load 1.5/5.0 (rust 3.5 s of 10 s, wasm 3.3 s of 7 s with 213 tests). The reference game's reload test went red in three full runs during this gate; a base rate at the base commit `a5410075` (browser suite alone, three interleaved pairs under the suite's own load of 11-15) failed it 1 of 4 at the base and 0 of 3 here: pre-existing, not charged.
