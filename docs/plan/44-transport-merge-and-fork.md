# M44: Merge and fork outputs

Status: done (2026-10-12) · After: 43 · Tyler-dependent: no · Split 2026-10-11: the `fx-belts` ops, goldens and property tests moved to `44b-transport-merge-fork-goldens.md` (sizing rule); this half may run beside M43b (different crates)

## Goal
`Output::Merge` (side-loading) and `Output::Fork` (splitting) work as 0076 §1 states, for every speed the engine accepts, including several items crossing a line front in one tick; unit tests pin every boundary at speeds 24, 72 and 96 and the per-item reference covers both outputs; the `fx-belts` goldens and property tests are M44b.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§1 `Output`, §2)
3. `/Users/tyler/repos/belts/docs/dev/sideload.md` and `docs/dev/splitters.md` (the measured Factorio rules, to know what is simplified) and `games/reference/README.md` "Belts" (the simplifications the game asked for: geometric entry points, no buffer, no priority)
4. `docs/plan/42-transport-core.md` Deviations (how `advance` is structured)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`. Skills: `run-tests`.

## Scope
- `Merge { line, at }`: when the feeder's front item would cross position 0 this tick with overshoot `o`, the landing is `at - o` on `line` (clamped to `[0, line.len - 1]`); it transfers iff `SPACING` is clear on both sides of the landing (the target has already moved this tick, by the update order); else the item waits at the feeder's position 0 and everything behind it squashes. The feeder's follower is not constrained by a transferred item. Several items crossing in one tick (big steps) are tried front to back.
- `Fork { a, b }`: per feeder line a one-bit `toggle` (state, encoded and hashed) naming the preferred output. An item crossing goes to the preferred output if it has room at the landing `target.len - o` (the plain hand-off rule), else to the other, else it waits; the toggle flips only when the item went to the preferred side. A fork's targets are plain lines (their `len`, `speed` are theirs); the game builds a splitter from four input lines with forks onto four output lines.
- Update order treats a fork as feeding both targets and a merge as feeding its target (M42's graph builder takes both).
- Big steps: tests at `speed` 24, 72 and 96 (two or more crossings per tick) for `Next`, `Merge` and `Fork`.
- The per-item reference test (`transport_matches_per_item_reference`) gains `Merge` and `Fork` outputs with their own reference rules, random `set_out` to and from them, and speeds up to 96.

## Non-scope
- The `fx-belts` ops (`Merge`, `Fork`), the five goldens and the four property tests (M44b, split 2026-10-11).
- Factorio's 68-position entry offsets, push-back landing, the 51-position splitter buffer, priorities and filters (dropped by the game's rules). Who wires forks and merges (M52, M54). Forecast marking of fork decisions (M47).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/transport/` (`advance.rs`, `order.rs`, `codec.rs`, `mod.rs`), `crates/engine/tests/`.

## Seams
**Provides:** `Output::Merge`, `Output::Fork`, `TransportRead::toggle(line)`, `set_out` accepting them (M44b's ops, goldens and properties consume them).
**Consumes:** M42 `advance`, M43 surgery and 0079 §8/§11-§12 (the hand-off bound, the cut rule, squashed pairs).

## Planning decisions
- **Toggle per feeder line, not per lane pair.** Factorio's measured input-toggle rule (splitters.md) interleaves two inputs; here each input alternates alone and the "blocked side goes to the other" rule gives the same 50/50 over time for one or two inputs. Simpler state, no cross-line coupling in `advance`. Recorded as a simplification in the game's rules.
- **Merge refuses rather than pushing back** (the prior project's "no pushing" candidate, which Factorio contradicts): the squash rule on the feeder makes the refused item wait; the stream behind compresses; a later tick finds room. Simpler, and the same primitive `insert_at` uses.
- **The feeder's follower is unconstrained after a transfer** (measured in Factorio; also what the gap representation gives for free, since the transferred item leaves the feeder's run).

## Order of work
1. `Merge` with unit tests at every boundary (landing at 0, at `len - 1`, exactly occupied, clear on one side only); big steps.
2. `Fork` and the toggle; unit tests; codec and hash cover the toggle.
3. Order builder with multi-target outputs; cycle test with a fork in the loop.
4. The per-item reference extended; `no_alloc_transport` extended with a merge and a fork in its world.
5. Deviations, commit.

## Tests added
Rust suite: `merge_landing_and_room_rule`, `merge_waits_and_squashes`, `merge_big_step_two_items`, `fork_alternates_and_flips_on_preferred_only`, `fork_blocked_side_routes_to_other`, `fork_both_blocked_waits`, `fork_big_step`, `order_fork_feeds_both`, `codec_covers_toggle`; `transport_matches_per_item_reference` extended.

## Exit criteria
- [x] Every unit test passes with an inject-fail-revert recorded (a flipped toggle on a diverted item reddens `fork_alternates_*`; a landing off by one reddens `merge_landing_*`; a removed room check reddens the reference test by a stated tick).
- [x] The per-item reference agrees with the store over 300 ticks with merges, forks and speeds up to 96.
- [x] `no_alloc_transport` still reports 0 with a merge and a fork in its world.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t merge_` · `pnpm test rust -t fork_` · `pnpm test rust -t transport_` · `pnpm test && pnpm lint`

## Budgets
- As M42 (allocation; fast-tier suite budgets).

## Context artifacts
`crates/engine/CLAUDE.md`: no change expected.

## Manual device checks
none

## Deviations
Steps 1-4 by the implementer (2026-10-11); step 5 (commit) is the manager's.

**Files** (`crates/engine/`, lines after): `src/transport/advance.rs` 470 (`merge_land`, `fork_land`, `try_hand_off`, `land_fresh_at`; the walk keeps cut landings), `order.rs` 190 (two-link Tarjan, component walk), `codec.rs` 360, `mod.rs` 836 (`set_out`/`set_speed`, `TransportRead::toggle`, docs), `surgery.rs` 593 (redirects), `line.rs` 285 (`alt_slot`, `toggle`, `fresh_mid`, `bound_targets`); `src/predict/predicting.rs` forwards `toggle`. Tests: new `tests/main/transport_outputs.rs` 705 (registered in `tests/main.rs`), `tests/main/transport_rules.rs` (reference extended; the reserved-bytes pin; a stale message), `tests/no_alloc_transport.rs` 518.

**Rules as built.** The front item of a `Merge`/`Fork` line has no leader (`p = pos - speed`, the squash bound only from the item ahead on the feeder); at `p < 0` (`o = -p`) it tries to transfer; on success the next item has no leader again, on refusal `p = 0` and the ordinary walk squashes the rest. *Merge*: landing `clamp(at - o, 0, line.len - 1)` (`i64`); onto a target that has advanced this tick it is exactly `insert_at_slot` (refusal = `NoRoom`: inside a run, or within `SPACING` of the item before or after; the store-wide count is restored after). Any `at` is accepted by `set_out` (the clamp covers a target shortened later); a merge target has no 0079 §8 bound. *Fork*: preferred = `toggle ? b : a`; room iff the target is empty or `tail + SPACING <= len - o` (`len - o` is in `[0, len - 1]` by §8, so no clamp is needed; debug-asserted); preferred, else other, else wait; the toggle flips only on a preferred delivery. `set_out` refuses `a == b` and any output naming the line itself (`Unsupported`, checked before `NoLine` and `BadSpeed`), and a fork target shorter than the feeder's speed (`BadSpeed`; `set_speed` too). Every `set_out` clears the toggle (a new output starts on `a`); the toggle is `false` on every non-fork line.

**Merge across a cycle cut (new mechanism, not in the brief).** A fork's landing is a back landing, so 0079 §11's `fresh_runs` covers it unchanged; a merge's can fall in the middle of a line that has not advanced. Refusing such a landing would deadlock a loop whose side-load is the cut link; letting it move again breaks 0079 §11. Built: `land_fresh_at` applies `insert_at`'s room rule over the line as it stands, never joins a moving run, and either joins the cut's back block (`fresh_runs += 1`: landing behind the line's last item or in front of the block's first) or becomes its own one-item run marked `count == 0` (`Line::fresh_mid`), which exists only inside `advance`: the target's walk restores the count, keeps the item in place (`d = 0`, its gap widens by what the item ahead moved), holds the items behind it, and skips the early exit while any is ahead (like a squashed line). Pinned by `merge_across_a_cut_stays_and_holds` (in-block, middle, front-with-squash cases) and the reference's merge-cut cycle (37 mid-line cut landings per run).

**Order.** Call-stack entries carry the next link to try in their top 2 bits (slots below 2^30, debug-asserted), so Tarjan takes two links with no new scratch. A component of several lines: its lowest id first (0079 §11 unchanged), then depth-first post-order from it over the component's links (`a` before `b`), using `on_stack` as the visit mark and the call stack above the outer walk (disjoint lines, so within the reserved `n`); for a simple cycle that is exactly M42's order. The cut links (hand-offs onto a line that has not advanced yet) are the lowest id's own out-links plus the walk's back edges to a non-root ancestor; a link into the lowest id lands on a line that has already advanced (wording corrected in the review fixes).

**Codec.** Tag 3 `Merge` + line + at; tag 4 `Fork` + a + b + toggle `u8`: the toggle is encoded only with a fork (the brief said "per line"; per fork line keeps every existing record and golden byte-identical: `store_golden_bytes.hex`, `persist_snapshot_golden_bytes.hex` and every `fx-belts` golden unchanged, `pnpm test rust` green with M43b's work in the tree). Decode rejects a toggle byte other than 0/1, `a == b`, an output naming itself or a missing line, and a `Next`/`Fork` target shorter than the feeder's speed.

**Redirects** (`surgery.rs` module doc), as the brief chose: `destroy` turns `Next`/`Merge` into it into `DeadEnd` and a fork with it as a target into `Next(other)` (toggle cleared). `split(line, at)`: `Next` and fork targets move to the back part; a merge moves (`at_m - at`) only if `at_m >= at`, else it stays on the front part (geometry: the entry point is where it was). `join(front, back)`: everything naming `back` names `front`, a merge at `at_m + front.len` (saturating); a fork left with both targets `front` becomes `Next(front)`. `join` refuses (`Unsupported`) when `front`'s output names `back` in any form. `feeders_fit` (0079 §8 for surgery) counts fork feeders, not merges.

**Line record 80 -> 88 B** (`alt_slot`, `toggle`, `fresh_mid`): `reserved_bytes` at the recommended caps is 16,482,320 B (was 16,220,176); `transport_reserved_bytes_at_the_defaults` updated (373 B per line). 0079 §14's figures are now stale (manager: ADR).

**Touched (0079 §9).** A transfer marks both the feeder (`crossed`) and the target (the landing); a refused attempt changes no state and marks nothing unless the feeder's items moved.

**Tests.** The nine listed, plus `next_big_step_hands_off_two_items` (`Next` at 24/72/96), `order_cycle_with_a_fork` (1 -> 2, 2 forks to 1 and 3, 3 -> 4 -> 2: order `[1, 4, 3, 2]`, 300 ticks conserved, round trip), `merge_across_a_cut_stays_and_holds`, `outputs_refusals`, `outputs_follow_surgery`. Reference (`transport_matches_per_item_reference`): its order is now a recursive Tarjan with the same component rule (the M42 path walk handled one link only); per-item cut marks (positions) replace the back count; `Merge`/`Fork` rules written from the `Output` docs; eight feeders at 24/72/96, a cycle cut on a merge, a cycle cut on a fork, a random `set_out` to/from both outputs on a third of the ticks (own stream, seed 44, refusals compared), toggles and outputs compared every tick for 400 ticks. One run counts: 220 merges landed, 2,598 refused, 37 mid-line cut landings, 155 preferred and 214 diverted fork deliveries, 1,049 fork waits, 106 big-step ticks, 161 cut transfers; the test asserts floors for each. `no_alloc_transport`: a merge feeder (96) and a fork feeder (72) onto two fast drains, a cycle cut on a merge (its ring forks back and to a drain, so it never jams; the mid-line cut path runs inside the window, checked by a probe), the churn line cycling `Next`/`Merge`/`Fork`; `transport_merge_fork_no_alloc` asserts more than 100 merge transfers (146) and 50 toggle flips (73), live and high-water 0.

**Inject-fail-revert** (each injected with a script, the named test run, reverted from the saved copy):
- Toggle flipped on a diverted delivery -> `fork_alternates_and_flips_on_preferred_only`: "speed 24: tick 0: a diverted item never flips the toggle".
- Merge landing `at - o + 1` -> `merge_landing_and_room_rule`: "speed 24: at - o", left `[206]`, right `[205]`.
- Room check removed from `land_fresh_at` (the merge-across-a-cut behind check) -> `transport_matches_per_item_reference`: "tick 3: line 66", left `[]`, right `[(2, 0)]`. The fork room check removed instead trips `land`'s debug assertion "landing inside the spacing" inside the same test (no tick in the message).
- Fork's `b` dropped from the order (`succ(_, 1)` = none) -> `order_fork_feeds_both`: "both targets before the fork", left `[3, 1, 5, 2, 4]`, right `[3, 4, 1, 5, 2]` (and `order_cycle_with_a_fork`: `[1, 2, 4, 3]` vs `[1, 4, 3, 2]`).
- A mid-line cut landing allowed to move -> `merge_across_a_cut_stays_and_holds`: "at 724, [500, 900]", `(2, 676)` vs `(2, 700)`.
- Toggle not decoded -> `codec_covers_toggle`: "the toggle round-trips".
- Split keeping a moved merge's `at` -> `outputs_follow_surgery`: `Merge { line: 8, at: 300 }` vs `at: 100`. The reference test stays green under this one (its splits never hit a merge target past the entry point in 400 ticks): the redirect is pinned by the unit test only.

**Open.** A blocked side-load re-checks its room every tick; see the review fixes (1) for the walk and its measured cost.

**Review fixes** (review `m44-review.md`, the manager's decisions):
1. *Blocked side-load cost.* (a) `Transport::locate` (`items.rs`, now 271 lines) finds the runs around a position walking from the nearer end: from the front by prefix sums, or from `tail_pos` back through `prev` (a run's first item is `last - SPACING x (count - 1)`, the previous run's last `first - SPACING - gap`). `insert_at` and both merge paths use it, so a side-load near the back of a long line costs O(runs behind its entry point). (b) `slow_blocked_sideloads_cost` (`transport_outputs.rs`, slow tier, M45's input for the per-merge cursor; a debug build re-runs itself with `cargo test --release`): a 1,000-tile main (4,000 alternating-kind runs, packed, dead end) with 50 merges blocked in its last 50 tiles. `advance` median **7.7 µs** of 200 ticks (min 4.9, max 16.0) in release on the Mac at load about 12. The same run walking from the front only (injected): **164.1 µs** (min 163.2).
2. *A merge's `at` follows its target's surgery* (`surgery.rs` `move_merge_points`, module doc). `extend_front(T, by)` adds `by` (saturating). `shrink_front` subtracts it; an entry point with `at < by` falls off the front and the merge becomes `DeadEnd`, like a destroyed target. `rescale` maps `at` to `floor(at x new / old)` (capped at `u32::MAX`). `extend_back`/`shrink_back` leave it. Changed feeders are touched. The reference implements the same rule, and `outputs_follow_surgery` steps through all six edits.
3. *`m == at` split boundary.* `outputs_follow_surgery` now splits exactly at a merge's entry point: it moves to the back part at 0. A landing straddling a cut (`m >= cut`, `o > m - cut`) clamps to 0 on the back part and is room-checked against the back part only, so it may form a legal cross-boundary squashed pair across the new hand-off (0079 §12). This is the same clamp 0079 §15 states for every merge.
4. *`set_out` with the line's current output is a no-op*: no toggle reset, no `graph_dirty`, no touch. Documented on `TransportWrite::set_out`; the reference does the same. A new counter `Transport::order_recomputes()` (tests and tools, not state) observes the order. Test: `outputs_same_set_out_is_a_no_op`.
5. *Cut-link wording* fixed in `order.rs`'s `emit_component` doc, the Order paragraph above and `order_cycle_with_a_fork`'s doc. The cut links are the lowest id's out-links plus the walk's back edges to a non-root ancestor (1 -> 2 and 4 -> 2 in that test).
6. *Canonical form for in-block landings.* A landing in front of or among the cut's back block merges with a packed same-kind block neighbour: the run behind it (taking the landing's gap), or the run ahead (only if that run is in the block), or both (one run removed, `fresh_runs - 1`), each with the `u16` guard. Test: `merge_across_a_cut_joins_a_packed_block`. Two cut feeders land 936 and 1000 (same kind, packed) on a line that has not advanced; the result is one run, and the store's `encode` equals that of a store where the same items were placed with `insert_at`.

Inject-fail-revert for the fixes (each reverted):
- Backward walk's previous-run position `+ 1` -> `merge_landing_and_room_rule` "speed 24: landing 192: exactly SPACING from 128" and `merge_across_a_cut_joins_a_packed_block` `(1, 935)` vs `(1, 936)`. A first mutant (`last < pos` -> `<=`) was equivalent: the room check refuses that case anyway.
- `extend_front` redirect dropped -> `outputs_follow_surgery` "extend_front 256", `at: 200` vs `at: 456`.
- Split `m >= at` -> `>` -> `outputs_follow_surgery` "at == cut", `Merge { line: 1, at: 200 }` vs `{ line: 3, at: 0 }`.
- No-op check removed -> `outputs_same_set_out_is_a_no_op` "the same fork keeps its toggle".
- In-block merge with the run ahead disabled -> `merge_across_a_cut_joins_a_packed_block` "one run for the packed pair", `[(5,1,476), (1,1,396), (1,1,0)]` vs `[(5,1,476), (1,2,396)]`.

**Manager's gate and review (2026-10-12).** Reran: `merge_` 6, `fork_` 7, `outputs_` 3, `transport_` 57, `no_alloc` 16, `belts_` 12, `pnpm lint` green; full `pnpm test` green at load 1.4 (rust 3.6 s of 10 s). Two earlier full runs at a one-minute load under 4 but a five-minute load of 11-13 (an hour of back-to-back suites) went red on the reference game's `reference_world_mismatch_reloads_once_onto_the_new_world`, which passed 5 of 5 alone at load 9 and in the quiet run: contention, not charged (the run-tests skill already names it). Adversarial review (an Opus reviewer, read-only): no correctness defect in `advance` or the cut mechanism; six findings, all fixed in "Review fixes": a blocked side-load's walk from the front every tick (now from the nearer end: 7.7 µs against 164 µs median for 50 blocked side-loads on a 1,000-tile alternating main line, `slow_blocked_sideloads_cost`, M45's input for a per-merge cursor), a merge's `at` left behind by `extend_front`/`shrink_front`/`rescale` (now follows them), the `m == at` split boundary (pinned), `set_out` with an identical output (a no-op, the toggle kept), the cut-link wording, canonical form after an in-block landing. Decisions are [0079](../decisions/0079-transport-core-decisions.md) §15-§16.
