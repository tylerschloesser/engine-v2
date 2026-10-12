# M44: Merge and fork outputs

Status: not started · After: 43 · Tyler-dependent: no · Split 2026-10-11: the `fx-belts` ops, goldens and property tests moved to `44b-transport-merge-fork-goldens.md` (sizing rule); this half may run beside M43b (different crates)

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
- [ ] Every unit test passes with an inject-fail-revert recorded (a flipped toggle on a diverted item reddens `fork_alternates_*`; a landing off by one reddens `merge_landing_*`; a removed room check reddens the reference test by a stated tick).
- [ ] The per-item reference agrees with the store over 300 ticks with merges, forks and speeds up to 96.
- [ ] `no_alloc_transport` still reports 0 with a merge and a fork in its world.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t merge_` · `pnpm test rust -t fork_` · `pnpm test rust -t transport_` · `pnpm test && pnpm lint`

## Budgets
- As M42 (allocation; fast-tier suite budgets).

## Context artifacts
`crates/engine/CLAUDE.md`: no change expected.

## Manual device checks
none

## Deviations
(filled in during execution)
