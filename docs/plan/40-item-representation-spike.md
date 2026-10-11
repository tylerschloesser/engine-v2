# M40: Item representation spike

Status: not started · After: — · Tyler-dependent: no

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
- [ ] `fx-belts` builds in `pnpm test`'s `fixtures` step and the fast `rust` suite stays inside its 10 s budget (the spike's fast tests run on the 1/64 world).
- [ ] Every candidate passes `repr_rule_cases` and `repr_candidates_agree`; each had an inject-fail-revert (a wrong squash bound reddens the cases; a dropped item reddens the agreement test).
- [ ] `slow_spike_item_representation` prints twelve `BENCH_SAMPLE` cells (3 candidates x 4 regimes) plus encode figures; the table is in Deviations and in 0077's Amendment with the rule of 0077 §3 applied and the winner named; the winner's mixed median is at most 3 ms, or the milestone stops and reports with the profile.
- [ ] `repr_no_alloc_small` reports 0 for every candidate.
- [ ] 0077's Status is `Accepted` (or `Superseded by` a new ADR) and `docs/decisions/README.md` says so.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t repr_` · `pnpm test rust -t bench_world` · `pnpm test:slow rust -t slow_spike_item_representation` (prints the cells; about a minute in release) · `pnpm test && pnpm lint`

## Budgets
- None gated here. The advance budget of 0077 §3 (3 ms median, mixed) is the decision threshold, written into the amendment; M45 turns the whole tick into the gated `belts-tick` baseline.

## Context artifacts
`packages/engine/fixtures/belts/CLAUDE.md` (what the fixture pins, the bench world, how to run the spike); one line in `fixtures/CLAUDE.md`. No skill, no rule.

## Manual device checks
none

## Deviations
(filled in during execution)
