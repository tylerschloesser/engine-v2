# 0077: How items on a transport line are stored

Status: Proposed (2026-10-11). Implements [0076](0076-transport-lines-engine-game-split.md) §1-§3; decided by measurement in milestone 40 (`docs/plan/40-item-representation-spike.md`), which amends this ADR to Accepted with the winner and the numbers, or supersedes it.

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
- Factorio FFF-176 "Belt optimisation" (https://www.factorio.com/blog/post/fff-176) describes the gap representation and the "segments" merged across tiles; cited from memory of the prior project's reading list, to be re-read and dated by milestone 40.
