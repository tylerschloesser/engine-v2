# M40: Item representation spike

Status: done (2026-10-11) · After: — · Tyler-dependent: no

## Goal
A native, throwaway benchmark decides [0077](../decisions/0077-transport-item-representation.md): the per-item list (A) against gap-encoded runs (B1 linked, B2 contiguous), each with the same advance rule, on the standard belt world of 50,000 tiles and 250,000 items in four regimes, with medians, p99, snapshot bytes and allocation. The `fx-belts` fixture crate exists as a skeleton (a valid `Game`, no belt rules yet) so the spike and every later belt test have a home. 0077 is amended to Accepted with the table and the winner, or superseded if no candidate meets the advance budget.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§1 vocabulary, §2 the per-tick rule, §3 the item primitives)
3. `docs/decisions/0077-transport-item-representation.md` (whole: the candidates, the measurement, the rule for choosing)
4. `/Users/tyler/repos/belts/docs/12-belt-physics-measurements.md` (§3a-§3c: capacity, domain, the squash rule) and `docs/dev/sim.md` "Per tick" (the prior project's loop, as a cross-check of the rule; its code is not transferable)
Rules that apply: `.claude/rules/determinism.md` (the spike is sim-grade code even though it ships nothing). Skills: `.claude/skills/run-tests/SKILL.md` ("The slow tier and the benchmarks").

## Scope
- `packages/engine/fixtures/belts/` (`fx-belts`): a minimal `Game` on the `fx-machines` shape (one entity type, `Action::Noop`, flat worldgen, `export_game!`), its `CLAUDE.md`, a line in `fixtures/CLAUDE.md`. It must build through `pnpm test`'s `fixtures` step and pass the allowlist and ABI-registry tests, nothing more.
- `fixtures/belts/tests/spike_repr.rs`: the spike. Three candidate modules implementing one trait `Repr { fn advance(&mut self, order: &[LineIdx]); fn insert_back; fn insert_at; fn remove_at; fn encode(&self, sink) }` with the 0076 §2 rule: squash against the leader (on this line, or on the plain target's rearmost item for a hand-off), plain `Next` hand-off with multi-item crossing, `DeadEnd`, `Sink`, `insert_back` at `max(len - speed, tail + SPACING)`. No `Merge`, no `Fork`, no surgery (M43, M44).
- `fixtures/belts/tests/common/world.rs`: `bench_world(seed, regime) -> BenchWorld`: a deterministic layout of merged lines totalling 50,000 tiles and about 250,000 items at `speed = 24`, `len` per line a multiple of 256, regimes per 0077 §2 (`Flowing`, `Jammed`, `Mixed`, `InserterLike`), with spawners (`insert_back` of a cycling item id every `k` ticks per lane) feeding and sinks draining as the regime needs. Reused by M45's real benchmark, so it takes the line specs as plain data (`LineSpec { len, speed, out, items_at_rest }`) rather than calling a candidate directly.
- The measurement: 200 warm-up ticks, 1,200 measured, per candidate and regime, `slow_spike_item_representation` printing one `BENCH_SAMPLE {json}` line per cell (median µs, p99 µs, max µs, encode bytes, encode µs, `thread_live_bytes` delta over the measured ticks). Release profile through the `run_in_release` pattern of `games/reference/sim/tests/common/bench_run.rs` (copy the 76 lines into `fixtures/belts/tests/common/`; M45 moves the helper into `engine::testing`).
- The write-up: the table in Deviations and in the 0077 amendment, the rule of 0077 §3 applied, and a profile (`cargo flamegraph` or `perf`-equivalent on macOS: `samply` or Instruments; whichever is installed, named in Deviations) of the winner's mixed regime, naming the top five self-time functions.

## Non-scope
- Production `engine::transport` code (M42 builds the winner from this spike's shape, not its files). The WASM-under-Node ratio (M45). `Merge`/`Fork`, surgery, geometry, forecasts (M41 builds its tracker on this spike).

## Files, packages and crates touched
- `packages/engine/fixtures/belts/` (new crate; the workspace glob `packages/engine/fixtures/*` picks it up; `build-fixtures.mjs` builds every directory).
- `packages/engine/fixtures/CLAUDE.md` (one line).
- `docs/decisions/0077-transport-item-representation.md` (Status line and an "Amendment" section at the end with the table), `docs/decisions/README.md` row.

## Seams
**Provides:** `fx-belts` crate and `fixtures/belts/CLAUDE.md`; `tests/common/world.rs` `bench_world`, `BenchWorld`, `LineSpec`, `Regime`; the measured table (0077 Amendment) and the winning candidate's name; `spike_repr.rs` stays in the tree as `slow_*` until M45 deletes it (its numbers are in the ADR).
**Consumes:** `engine::testing` (feature `testing`), `abi::arena::thread_live_bytes` (`crates/engine/CLAUDE.md` "Tests"), the bench-gate conventions (`scripts/lib/bench-gate.mjs` is not used: a spike records, it does not gate).

## Planning decisions
- **A spike, not a benchmark gate.** No baseline file and no `gate()` call: the result is a decision, recorded once. M45 is the gated benchmark on the production code.
- **Same rule, three stores.** The candidates share one `advance` specification written as a table-driven unit test (`repr_rule_cases`: squash, boundary crossing at `speed` 24 and 72, dead end, sink, `insert_back` landing) that every candidate passes before it is timed; a candidate that fails the rule cases is not timed.
- **Item ids cycle through 6 values** so B's run merging sees both packed-same-kind and alternating-kind streams (a worst case for runs: alternating kinds never merge). The mixed regime uses both halves.
- **Order is fixed per world** (reverse topological over the generated `Next` links, computed once by the world builder), the same array for every candidate.
- **No `Merge`/`Fork`**: their per-boundary cost is identical across candidates; the question is the per-item versus per-run cost of plain motion and the per-call cost of mid-line insert and remove.

## Order of work
1. `fx-belts` skeleton; `pnpm test` green with the new fixture in the build (allowlist, ABI registry, size tests pick it up automatically).
2. `bench_world` and its determinism test (`bench_world_is_deterministic`: two builds, equal line specs and items; `bench_world_counts`: tile and item totals within 1 % of 50,000 and 250,000).
3. `repr_rule_cases`; candidate A; A passes the cases.
4. Candidates B1 and B2; both pass the cases; `repr_candidates_agree`: 200 ticks of the mixed world at 1/64 scale give identical item multisets per line for all three.
5. The timing run in release (one `BENCH_SAMPLE` per cell), the allocation check, the profile of the winner.
6. Amend 0077 (Status, Amendment section, index row), write Deviations, commit.

## Tests added
Rust suite (`fx-belts`): `bench_world_is_deterministic`, `bench_world_counts`, `repr_rule_cases` (one table, every candidate), `repr_candidates_agree`, `repr_no_alloc_small` (each candidate: `thread_live_bytes` unchanged over 100 ticks of the 1/64 mixed world; fast tier). Slow tier: `slow_spike_item_representation` (the measurement, release).

## Exit criteria
- [x] `fx-belts` builds in `pnpm test`'s `fixtures` step and the fast `rust` suite stays inside its 10 s budget (the spike's fast tests run on the 1/64 world).
- [x] Every candidate passes `repr_rule_cases` and `repr_candidates_agree`; each had an inject-fail-revert (a wrong squash bound reddens the cases; a dropped item reddens the agreement test).
- [x] `slow_spike_item_representation` prints twelve `BENCH_SAMPLE` cells (3 candidates x 4 regimes) plus encode figures; the table is in Deviations and in 0077's Amendment with the rule of 0077 §3 applied and the winner named; the winner's mixed median is at most 3 ms, or the milestone stops and reports with the profile.
- [x] `repr_no_alloc_small` reports 0 for every candidate.
- [x] 0077's Status is `Accepted` (or `Superseded by` a new ADR) and `docs/decisions/README.md` says so.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t repr_` · `pnpm test rust -t bench_world` · `pnpm test:slow rust -t slow_spike_item_representation` (prints the cells; about a minute in release) · `pnpm test && pnpm lint`

## Budgets
- None gated here. The advance budget of 0077 §3 (3 ms median, mixed) is the decision threshold, written into the amendment; M45 turns the whole tick into the gated `belts-tick` baseline.

## Context artifacts
`packages/engine/fixtures/belts/CLAUDE.md` (what the fixture pins, the bench world, how to run the spike); one line in `fixtures/CLAUDE.md`. No skill, no rule.

## Manual device checks
none

## Deviations

**The table** (steps 2-5; native release, Tyler's MacBook Pro, 2026-10-11; each cell the median of three `pnpm test:slow rust -t slow_spike_item_representation` runs, which agreed within 7 % and with two earlier runs at load ~1.9; 200 warm-up ticks, 1,200 measured; seed 7). The world: 3,810 lines, 50,000 tiles, 250,000 items at build. "Tick" is the spawners, the inserter-like calls and `advance`; "advance" is `advance` alone. Encode: the whole world once into a `SliceSink`, median of five.

| Candidate | Regime | Tick median µs | p99 µs | max µs | Advance median µs | Encode bytes | Encode µs | Alloc delta B |
|---|---|---|---|---|---|---|---|---|
| A | flowing | 1390.5 | 1729.1 | 2519.7 | 1386.9 | 753,957 | 2076 | 0 |
| B1 | flowing | 25.9 | 36.3 | 42.6 | 23.3 | 1,004,006 | 3140 | 0 |
| B2 | flowing | 26.0 | 32.7 | 39.3 | 24.5 | 1,004,006 | 3140 | 0 |
| A | jammed | 515.8 | 548.9 | 568.3 | 515.8 | 754,520 | 2059 | 0 |
| B1 | jammed | 9.5 | 11.7 | 21.6 | 9.5 | 1,004,520 | 3102 | 0 |
| B2 | jammed | 12.1 | 15.5 | 21.4 | 12.0 | 1,004,520 | 3136 | 0 |
| A | mixed | 647.4 | 774.1 | 808.1 | 645.3 | 979,155 | 2759 | 0 |
| B1 | mixed | 20.1 | 36.2 | 42.0 | 16.8 | 714,520 | 2252 | 0 |
| B2 | mixed | 24.0 | 37.0 | 42.7 | 21.1 | 714,520 | 2253 | 0 |
| A | inserter-like | 1868.0 | 2256.0 | 3356.1 | 1430.7 | 604,889 | 1688 | 0 |
| B1 | inserter-like | 408.0 | 466.6 | 488.8 | 51.8 | 692,278 | 2057 | 0 |
| B2 | inserter-like | 152.9 | 183.9 | 216.2 | 39.7 | 692,278 | 2192 | 0 |

**The rule of 0077 §3 applied.** Mixed tick medians: B1 20.1 µs, B2 24.0 µs, A 647.4 µs. B2 is 19 % above B1 (outside 10 %), so **B1 (linked runs) wins**; its mixed advance (16.8 µs, tick 20.1 µs) is far inside 3 ms. Against the pre-registered expectations: B beats A by 54x (flowing) and 43-54x (jammed), as expected (> 5x); by 32x in mixed (expected 2-3x: a finding; the gap closes only at compression fronts and B walks nothing else); and B does not lose in inserter-like (B1 4.6x, B2 12x faster than A). For the manager: B2 is 2.7x faster than B1 in inserter-like (per-call scans read contiguous runs), the mixed difference is 4 µs (0.1 % of the 3 ms budget), and 0077's revisit trigger is inserter cost; the rule as written names B1. Encode: where kinds alternate, every item is its own run and B's bytes are 33 % above A's (flowing, jammed); in mixed B is 27 % below.

**Profile of the winner's mixed regime.** Instruments Time Profiler (`xctrace` 27.0; `samply` not installed), release with symbols (`CARGO_PROFILE_RELEASE_STRIP=false CARGO_PROFILE_RELEASE_DEBUG=line-tables-only`), `SPIKE_ONLY=B1/mixed SPIKE_PROFILE_REPEAT=150` (the measured window re-run 150 times from the warmed state: 4.0 s of samples, 88 % in `advance`). Top five self-time: `ReprB<Linked>::advance_line` 44.5 %, `Linked::get` 6.4 %, `Vec<Line>` indexing (`self.lines[l]`) 5.4 %, `ReprB::advance` (the order loop) 4.2 %, `Linked::first` 3.9 %. The cost is per line (3,810 lines, ~4.4 ns each: the line header and the front run), not per item. B2 for comparison: `advance_line` 56.2 %, `Ring::slot` (the ring's index arithmetic) 10.6 %.

**Inject-fail-revert** (each reverted, then green):
- A squash bound from the leader's old position (`leader = if p >= 0 { pos } else { p }` in A): `repr_rule_cases` red, `A 'squash against the leader's new position' op 1: line 0 (item, pos)`, left `[(1, 0), (2, 74), (3, 176)]`, right `[(1, 0), (2, 64), (3, 176)]`. The same in B's walk (`d = (g - last_d).min(speed)`): the same assertion for `B1`, same numbers. (A first try, `bound = leader + SP - 1`, hit the dead-end `unreachable!` instead of an assertion, so the injection was changed to the meaningful wrong bound.)
- A hand-off in A dropping the item when `(target.len + p) % 7 == 0`: `repr_candidates_agree` red, `Mixed tick 0 line 0: B1 vs A`.
- `core::mem::forget(Vec::<u32>::with_capacity(order.len()))` in B's `advance`: `repr_no_alloc_small` red, `B1 Mixed`, left `31200` (100 ticks x 78 lines x 4 B), right `0`.

**Changed from the brief, and why.**
- Spawners: `acc += rate256` per tick, an attempt at `acc >= 256`, success subtracts 256, a refusal holds `acc` at 256. The prior project's `acc = min(256, acc + rate)` drops the fraction, so rate 60 gave one item per 5 ticks, not per 4.27 (measured: flowing fell to 216k items). `rate256 = 256` is a saturated input.
- World layout (not specified): belt chains of 1-6 lines of 4-48 tiles, two lanes each; tiles = lane-tiles / 2. Flowing: every chain sinks, items spread, spawner rate 60 (spacing 102.4, the 2.5 items per lane-tile of the target). Jammed: chains dead-end, items packed from each chain's front (62.5 % of capacity, so the rear of each chain is empty), no spawner. Mixed: lane 0 of each belt chain sinks a packed stream (saturated spawner), lane 1 dead-ends with ~1 item per lane-tile and rate 24, so compression fronts move all window; alternate belt chains same-kind or cycling. Inserter-like drains: random removals succeed more often than inserts (682k removed, 400k inserted over 1,400 ticks; 186,750 items at the end vs 315,444 in mixed). Kept as 0077 §2 words it.
- B's implementation choices: runs merge when a gap closes to 0 with the same item (canonical form, so a same-kind jam is one run); a per-line `jam` cache (the first run that may have a gap) gives the O(1) skip of a stopped line, and a mid-line insert or remove invalidates it; B2 is a power-of-two ring per line (front pop and back push O(1), a mid-line change shifts the shorter side), not a plain `Vec`. B1 and B2 share the advance code over a `RunStore` trait.
- Rule cases: no squashed pair (gap < 64): B's gap is unsigned and no in-scope primitive makes one (only rescale, M44). 12 §3c's observed advance of 6 is reproduced at speed 8 with a leader stopping 4 short of a dead end. `remove_at` takes the front item on a tie; `insert_at` checks spacing on its own line only.
- `repr_candidates_agree` compares exact `(item, pos)` lists every tick (stronger than multisets) on the 1/64 mixed and inserter-like worlds, plus sink and call counts; `repr_no_alloc_small` covers both worlds too.
- `bench_run.rs`: `repo_root` is `../../../..` (the verbatim copy pointed at `packages/`); added `run_in_release_samples` (the original returns one sample); the outer run also writes `test-results/rust/bench/spike-item-representation.json`, since nextest hides a passing test's output. `SPIKE_ONLY` / `SPIKE_PROFILE_REPEAT` (and `Repr: Clone`) exist for the profile.
- JSON cells carry one extra field, `advanceMedianUs`.
- Fast tier: the spike's five fast tests take 0.02 s; `pnpm test` rust suite 1.6 s / 10 s.

**Manager's gate and review (2026-10-11).** The manager reran every verification command: `repr_` 3 tests and `bench_world` 2 tests green, `pnpm lint` green, `slow_spike_item_representation` reproduced every cell within 2 % (its record is in 0077's Amendment A1), full `pnpm test` green three times (one `browser` red in between, `[gc] sim-paced clean`, at a one-minute load of 11.9 from the manager's own back-to-back runs; 5 of 5 green alone at load 3.9: not charged; a second load red in the same session, the reference game's `reference_furnace_pick_up` at load 9.95 with Spotlight's `mds` at 45 % CPU, 6 of 6 green alone at load 3.9: not charged). End-of-window item counts, identical for the three candidates at full scale: flowing 250,049, jammed 250,000, mixed 315,444, inserter-like 186,750. The `reference` build step read 7 s in two runs of four and under budget in the others with nothing recompiled: variance in the Vite plugin's cargo call, not charged. Adversarial review (an Opus reviewer briefed with this file, 0076 §1-§3, 0077, 0069 and 12 §3a-§3c; read-only) found no rule error and nine findings; the manager fixed the five test gaps and recorded the rest in 0077's Amendment A4:
- Added rule cases: a squashed pair across a hand-off (`insert_at` checks its own line only, so 12 §3c's "however it arose" pair is reachable; the rear holds, then closes by exactly 6 at speed 8); two items of one `count > 1` run crossing at speed 72 and merging on the target's back run (a B branch only the agreement test had reached); the refusal boundaries (`insert_at` at 63, `remove_at` at 33). 20 cases now.
- `bench_world_counts` asserts the literals 50,000 / 250,000 and 781 / 3,906 exactly (it had compared against `TILES`/`ITEMS` with 1 %: 0069 §2).
- `repr_no_alloc_small` also asserts the `thread_high_water_bytes` delta, after padding live bytes up to the mark, so an allocation freed inside the tick is seen.
- Inject-fail-revert of the additions (each reverted, then green): A's `insert_at` refusing only under 63 (`< SP - 1`): red, `op 0: insert_at 163`, left `Ok(())`, right `Err(NoRoom)`; A's `remove_at` reaching 33: red, `op 2: remove_at 133`, left `Some(1)`, right `None`; B's front item ignoring a squashed pair (`p = (pos0 - speed).max(bound)` unconditionally): red, `B1 'squashed pair across a hand-off ...' op 3: line 1`, left `[(2, 2)]`, right `[(2, 0)]`; a `Vec::with_capacity(16)` allocated and dropped in B's `advance`: red, `B1 Mixed`, left `(0, 64)`, right `(0, 0)` (the live counter alone read 0); `TILES = 49_000`: red, `flowing: tiles`, left `49000`, right `50000`.
- Not changed, recorded for M42/M43 in 0077 A4 and the M42 brief: B2's `Ring::slot` re-reads the line header on every access (10.6 % of its samples), so part of the 19 % may be implementation; B1's fresh arena gives it line-ordered locality a production arena loses with age; `insert_at`'s merges have no `u16` count overflow guard (unreachable at these line lengths).
