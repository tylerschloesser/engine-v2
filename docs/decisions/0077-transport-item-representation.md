# 0077: How items on a transport line are stored

Status: Accepted (2026-10-11, by the Amendment below: **B1, gap-encoded runs in a linked arena**, wins). Implements [0076](0076-transport-lines-engine-game-split.md) §1-§3; decided by the measurement of milestone 40 (`docs/plan/40-item-representation-spike.md`).

## Context

The per-tick advance of [0076](0076-transport-lines-engine-game-split.md) §2 must move 250,000 items over 50,000 belt tiles in a fraction of the 5 ms tick budget (Tyler, 2026-10-11), allocate nothing per tick, encode deterministically, and support what inserters will need later: inserting and removing an item in the middle of a line without a redesign. The prior project stored every item individually (`/Users/tyler/repos/belts` `PLAN.md` D3, D5: a doubly linked list per line, absolute positions) because its goldens compared positions; it measured nothing at this scale. Factorio stores gaps, not positions, and moves "uninterrupted stretches" as a unit (wiki Physics §6, as cited by the prior project). Tyler's stated lever: move runs of items that share a line and speed as one unit instead of updating every item every tick, and measure that against the per-item list before choosing.

Three facts shape the candidates: spacing is a constant (`SPACING = 64`, 0076 §1), so a packed run of `n` identical items is fully described by its first position and `n`; a line's items only ever move toward the front at the line's one speed, so all free-moving items on a line advance by the same amount; and a jammed line does not move at all.

## Decision

**1. Candidates.** The spike builds the advance loop (squash, plain hand-off with multi-item crossing, `insert_back`, `insert_at`, `remove_at`) for each and measures them on the same worlds:

- **A. Per-item list.** Each line: a doubly linked list of items front to back in a global arena (`item: u16, pos: u32, next, prev`), absolute positions from the front. Advance visits every item: `pos = max(pos - speed, leader + SPACING)`. O(items) per tick. Mid-line insert and remove are O(1) after an O(items on line) scan.
- **B. Gap-encoded runs.** Each line: a sequence of runs front to back, `Run { item: u16, count: u16, gap: u32 }`, where `gap` is the free distance from the run's first item to the item ahead (for the first run, to the line front). Positions are implicit prefix sums. A free-moving line advances by shrinking the first run's `gap` (O(1)); a jammed line (first gap 0, every other gap 0) costs O(1) to skip; only the compression front, where a moving run meets a stopped one, costs O(runs touched). A hand-off splits the front run (`count -= k`) and merges onto the target's back run when kinds match and the gap is 0, else appends a run. Mid-line insert splits a run in two; remove splits or shortens one; both O(runs on line) to locate.
  - B1: runs in a global arena as a doubly linked list per line.
  - B2: runs in a per-line contiguous `Vec` carved from one arena (fixed capacity per line, grown by surgery), so advance reads sequentially.

Both keep `0 <= pos <= len - 1`, the spacing invariant on a line and across plain hand-offs, zero per-tick allocation from a budget-sized arena ([0076](0076-transport-lines-engine-game-split.md) §8), `Codec` encoding in line order, and `split`/`join` in O(runs) or O(items) on the line.

**2. The measurement.** Native release, Tyler's machine, the standard belt world of milestone 40 (50,000 tiles, 250,000 items, lines merged by the fixture's own simple topology) in four regimes, 200 warm-up ticks then 1,200 measured, medians and p99: *flowing* (every line fed and draining), *jammed* (every line backed up), *mixed* (half the lines fed into dead ends so compression fronts move through the world; spawners and sinks on the rest), *inserter-like* (mixed plus 2,000 `insert_at`/`remove_at` calls per tick at random positions). Also: snapshot encode bytes and time for the mixed world and `no_alloc` over the measured ticks. The WASM-under-Node ratio of the winner is measured on the production module in milestone 45 and added to this ADR's amendment then (the spike is native-only).

**3. The rule for choosing.** The candidate with the lowest *mixed* median wins unless another is within 10 % of it, in which case the simpler (A, then B2, then B1) wins. Whatever wins must hold `advance <= 3 ms` median in the mixed regime (the rest of the 5 ms tick is the forecast tracker of [0078](0078-transport-forecast-replication.md), the game's tick rules and frame building, measured in milestone 45); if none does, milestone 40 stops and reports with the profile. Expected (pre-registered, so a surprise is a finding): B beats A by more than 5x in flowing and jammed, by 2-3x in mixed, and loses in inserter-like only if the per-call scan dominates, which a per-line run count under 64 should prevent.

**4. What the winner fixes for later milestones.** Positions are never stored for a run's second and later items; "an item's position" is always computed (prefix sum) and tests assert on computed positions. A run is the unit the forecast of [0078](0078-transport-forecast-replication.md) describes, so even if A wins the forecast encoder groups packed, same-kind neighbours into runs on the wire.

## Alternatives rejected

- **Decide without measuring.** Tyler asked for the measurement; the per-call scan cost of B under inserter load is the one number intuition cannot give.
- **Per-line SoA typed arrays** (the prior project's D3). A WASM port of a JS idiom; the same as A with worse locality across lines.
- **Storing runs as `(item, count)` with explicit gap entries** (a uniform node type). Equivalent to B with twice the nodes in a packed line; not measured separately.
- **A spatial grid of items per tile.** Items would move between cells every few ticks; the line is the natural container.

## Consequences

- Milestone 40 is a native-only spike in `packages/engine/fixtures/belts/` and ships no production code; milestone 42 builds the winner from the spike's shape, not its code.
- The amendment that accepts this ADR records the table of medians, p99, encode size and allocation for every candidate and regime, and the rule applied.
- Trigger to revisit: an inserter milestone measuring `insert_at` above its budget in the chosen representation, or a game needing a second spacing.

## Sources

- [0076](0076-transport-lines-engine-game-split.md) §1-§3, §8.
- Prior project: `PLAN.md` D3, D5, D16 (its 5,000-tile budget, never measured in WASM); `docs/12-belt-physics-measurements.md` §3a-§3c, §6 (quoted Factorio statements on aggregate movement).
- Factorio FFF-176 "Belts optimization for 0.15" (https://www.factorio.com/blog/post/fff-176, published 2017-02-03, re-read 2026-10-11): "We no longer store absolute coordinates of items, instead we store the distance between items"; a free-flowing stretch updates only its terminal gaps ("you only increment/decrement those terminal gap sizes, and do not touch items at all"); a compressed belt "will stay that way forever", so the index of the last positive gap only decreases; adjacent belts are merged into one transport line. Candidate B is this scheme with runs of same-kind items collapsed to a count.
- Milestone 40's spike: `packages/engine/fixtures/belts/tests/spike_repr.rs` (until milestone 45 deletes it), its Deviations in `docs/plan/40-item-representation-spike.md`, the record `test-results/rust/bench/spike-item-representation.json` (not tracked).

## Amendment (2026-10-11, milestone 40): the measurement and the winner

**A1. The table.** Native release on Tyler's MacBook Pro (Apple M3 Max, the bench-gate fingerprint machine), the standard belt world of milestone 40 (seed 7: 3,810 lines, 50,000 belt tiles, 250,000 items at build; `speed = 24`), 200 warm-up ticks then 1,200 measured; each cell the median of three runs by the implementer, confirmed within 2 % by the manager's own run. "Tick" is the game phase (spawners, the inserter-like calls) plus `advance`; "advance" is `advance` alone. Encode: the whole world once into a `SliceSink`. Allocation: `thread_live_bytes` delta over the 1,200 ticks.

| Candidate | Regime | Tick median µs | p99 µs | Advance median µs | Encode bytes | Encode µs | Alloc B |
|---|---|---|---|---|---|---|---|
| A | flowing | 1,390 | 1,729 | 1,387 | 753,957 | 2,076 | 0 |
| B1 | flowing | 25.9 | 36.3 | 23.3 | 1,004,006 | 3,140 | 0 |
| B2 | flowing | 26.0 | 32.7 | 24.5 | 1,004,006 | 3,140 | 0 |
| A | jammed | 516 | 549 | 516 | 754,520 | 2,059 | 0 |
| B1 | jammed | 9.5 | 11.7 | 9.5 | 1,004,520 | 3,102 | 0 |
| B2 | jammed | 12.1 | 15.5 | 12.0 | 1,004,520 | 3,136 | 0 |
| A | mixed | 647 | 774 | 645 | 979,155 | 2,759 | 0 |
| **B1** | **mixed** | **20.1** | **36.2** | **16.8** | 714,520 | 2,252 | 0 |
| B2 | mixed | 24.0 | 37.0 | 21.1 | 714,520 | 2,253 | 0 |
| A | inserter-like | 1,868 | 2,256 | 1,431 | 604,889 | 1,688 | 0 |
| B1 | inserter-like | 408 | 467 | 51.8 | 692,278 | 2,057 | 0 |
| B2 | inserter-like | 153 | 184 | 39.7 | 692,278 | 2,192 | 0 |

**A2. The rule of §3 applied.** Lowest mixed median: B1 at 20.1 µs; B2 is 19 % above it, outside the 10 % band, so the simplicity tie-break does not apply and **B1 wins**. B1's mixed advance (16.8 µs median, 36 µs p99) is 0.6 % of the 3 ms budget, so the budget holds with two orders of magnitude to spare. Every candidate passed the shared rule cases (`repr_rule_cases`, 17 cases) and gave identical `(item, position)` lists tick by tick (`repr_candidates_agree`), and none allocated per tick.

**A3. Against the pre-registered expectations.** B beats A by 54x flowing and 43-54x jammed (expected: more than 5x). In mixed B beats A by 32x, not the expected 2-3x: the expectation assumed compression fronts cost B something comparable to A's per-item walk, but B's cost is per line (about 4.4 ns per line: the line header and its front run; profile in A5) plus the runs a front actually touches, and A's is per item. B does not lose in inserter-like: at 2,000 `insert_at`/`remove_at` calls per tick B1 is 4.6x and B2 12x faster than A, because the per-call scan over runs is shorter than A's scan over items.

**A4. What the spike found that the ADR did not predict.**
- *B2 is 2.7x faster than B1 under inserter load* (153 versus 408 µs): the per-call scan reads a contiguous ring instead of chasing links. B1 is kept because the rule as written selects it, because 408 µs at 2,000 calls per tick is still 14 % of the 3 ms budget for a load far above anything 2 to 8 players' inserters produce (inserters are designed for, not built, in this effort), and because B1's surgery (`join`, `split`, milestone 43) relinks nodes in O(1) where B2 must move runs between fixed-capacity rings and re-size a ring when `len` grows. The trigger in Consequences stands with B2 as the measured fallback; a B1 store can also place one line's runs contiguously by allocation policy if the scan ever matters.
- *Encode size depends on kind alternation, not on the store.* Where kinds alternate every item is its own run and B's bytes are 33 % above A's (flowing, jammed); where same-kind runs pack, B is 27 % below (mixed). A real game's belts carry mostly same-kind streams; the forecast encoder of [0078](0078-transport-forecast-replication.md) groups the same way.
- *The inserter-like regime drains*: random `remove_at` calls succeed more often than random `insert_at` calls (682k removed versus 400k inserted over 1,400 ticks; 186,750 items at the end against 315,444 in mixed), so its per-call numbers are measured on a thinning world. Kept as §2 words it; milestone 45's gated benchmark is the mixed regime.
- *The B1-over-B2 margin is partly implementation.* B2's ring re-reads its line header (`base`, `head`, `mask`) on every run access (`Ring::slot`, 10.6 % of B2's mixed samples); hoisting it might bring B2 inside the 10 % band, where §3's tie-break would pick B2. Not measured: B1 is chosen for the surgery reason above, which §3's simplicity order did not weigh, and both are two orders of magnitude inside the budget. B1's arena is also fresh in the spike (nodes laid out in line order at build; the free list scatters them only slowly), locality a production arena loses with age; milestone 45's gated benchmark runs the production store and is where ageing would show.
- *Spawners keep their fractional rate* (`acc += rate256`, success subtracts 256, a refusal holds `acc` at 256); the prior project's `min(256, ..)` cap dropped the fraction and starved the flowing world to 216k items.

**A5. Profile of B1, mixed.** Instruments Time Profiler (`xctrace` 27.0), release with symbols, the measured window repeated 150 times: 88 % of samples in `advance`; self time `advance_line` 44.5 %, `Linked::get` 6.4 %, `Vec<Line>` indexing 5.4 %, the order loop 4.2 %, `Linked::first` 3.9 %. The cost is the per-line visit, not the items. (B2 for comparison: `advance_line` 56.2 %, the ring's index arithmetic `Ring::slot` 10.6 %.)

**A6. What the winner fixes for milestone 42** (adds to §4). The production store is B1's shape: `Run { item: u16, count: u16, gap: u32 }` nodes in one budget-sized arena with a doubly linked list per line; positions are prefix sums, never stored; canonical form (two adjacent runs with gap 0 and the same item merge, so a same-kind jam is one run); a free-moving line costs O(1) because once a run moves the full `speed` every run behind it does too with unchanged gaps; a stopped line costs O(1) through a per-line cache of the first run that may still have a gap (the "jam" cursor, invalidated by a mid-line insert or remove); only the compression front is walked. Hand-offs, `insert_back`, `insert_at` and `remove_at` are as the spike's `common/repr_b.rs` does them; milestone 42 writes them again as production code against `engine::transport`'s arena and `Codec`, not by copying the spike.

**A6b. Two rules the spike settled for milestones 42 and 43.** (i) A squashed pair across a plain hand-off is legal and handled by the squash rule: `insert_at` and `insert_back` check spacing on their own line only (an item inserted at the back of a target line may sit under `SPACING` from the feeder's front item, as 12 §3c's "however it arose" pair; the feeder's item then holds and closes to `SPACING` by `min(speed, gap_after - SPACING)`), so §1's "spacing invariant across plain hand-offs" holds for items that *moved* there, not for inserts, and the `codec` decode check of milestone 42 validates spacing within a line only. (ii) Every run merge guards `count` against `u16` overflow (the spike's `insert_at` merges do not; a merged line long enough to pack 65,536 same-kind items is 1,024 tiles, legal under `max_lines`).

**A7. Deferred to milestone 45.** The WASM-under-Node ratio of the winner on the production module, and the whole-tick number that `belts-tick.json` gates.
