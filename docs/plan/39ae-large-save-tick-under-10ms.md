# M39ae: the large-save tick fits 10 ms on the iPhone

Status: done (2026-10-08) · After: 39ad · Tyler-dependent: no (Q18 (a), 2026-10-07: the iPhone 12 at p95 is the bar, ADR 0056 §3)

## Goal
M39-large-save fails on the iPhone 12 in every round: `tick_p95_ms` 11.48 (`m39u-iphone`), 12.22, 13.86, and **11.82 on 2026-10-08** (`m39ad-iphone-driven`; `sim_tick` p50 8.24, p95 max 10.74). The bar is 10 ms (ADR 0010, ADR 0056 §3), so the per-tick cost has to drop by about 20 %. M39y measured where it goes (its Deviations: the phase table, and the conclusion that the phones pay a **cold wake**, so every byte and cache line a tick touches costs about 3x native). It fixed the quadratic drain and listed the remaining candidates. When this is done, the per-tick work at full scale is at least **20 % cheaper on the paced measurement** (Node, the release bench `.wasm`, 50 ms sleep between ticks: M39y's "Node paced 20 Hz" row, p50 3.19 ms after M39y), with state unchanged: same goldens, same hashes, same canonical encoding. The iPhone proof run is the orchestrator's.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39y-wasm-tick-cost.md` (Deviations: the phase table, step 5, the candidate list, the gate's conclusion)
3. `docs/decisions/0056-ios-pacing-and-tick-bar.md` §3; `docs/decisions/0007-world-model.md` (the sections on entity storage and the change log you touch)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
Measure first (step 1), then take M39y's candidates in order of measured cost, each its own commit with a before/after row:
1. **Baseline.** `pnpm test:slow wasm -t tick-phases` and `games/reference/sim/tests/bench_phases.rs` (`slow_phases_large_save`) on the current tree; paste the per-phase table (native, Node back to back, Node paced), three runs each, and the load average.
2. **`TimerWheel::by_entity`** (`sim/timers.rs:30`, a `BTreeMap<EntityId, Tick>` touched by every `wake_at`/cancel): replace it with a dense, id-indexed structure, or remove it if the bucket can carry what it answers. Ids come from an untrusted snapshot: a dense table needs a bound checked at load (reject or fall back, never allocate from an attacker-chosen id), and the fallback must still be deterministic. State the bound and where it is enforced.
3. **`chunk_versions.insert`** in `Host::tick` (`host/mod.rs:~1771`): skip the repeated insert for a chunk already stamped this tick.
4. **The `put_entity` write path** (`authority.rs:652-700`: `entity_scopes`, the change log): avoid re-recording an entity already recorded this tick, and any per-call map lookup that a tick-local cache answers.
5. Anything else the step-1 table puts above 0.15 ms native that a smaller working set would cut. Name it in Deviations first.
Stop rule: after each candidate, re-run the paced row. When the cumulative paced p50 is ≤ 80 % of the step-1 baseline, stop and report. If all candidates together don't get there, stop and report the table: do not start a storage redesign (that's Tyler's call, Q18 (c)).

## Non-scope
Any change to state, the snapshot format, goldens or determinism hashes; the furnace count or the save; the limit, the criterion, `budgets.json`; thread priority, busy-waits or keeping the worker awake (a mask: ADR 0056 and M39s); the Pixel.

## Files touched
`packages/engine/crates/engine/src/{sim/timers.rs,host/mod.rs,authority.rs}` and what a candidate strictly needs in the engine crate; their tests. Nothing in `games/reference/` except bench output.

## Seams
**Provides:** none new (internal). **Consumes:** M39y's `bench-phases` counters and `tick-phases @slow`, M39s's tick ring.

## Tests added
- For a dense `by_entity` (if done): a snapshot with an out-of-bound id is rejected or takes the fallback, deterministically (a test that fails if the bound check is removed: inject and paste the red).
- Every existing golden, hash and determinism test passes unchanged (`pnpm test rust`, `pnpm test wasm`); paste that no golden file shows in `git status`.
- No new test may assert a timing.

## Exit criteria
- [x] Step-1 baseline table and a per-candidate before/after table pasted (three runs each, load average stated).
- [x] Paced Node `sim_tick` p50 ≤ 80 % of the step-1 baseline, or the stop report with the table.
- [x] Goldens and hashes unchanged (`git status` shows no golden; `pnpm test rust` and `pnpm test wasm` pass, pasted lines).
- [x] The bound test (if step 2 adds a table) exists and was seen red.
- [x] `pnpm test:slow browser -t "large-save|bench"` passes (pasted).
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test rust`, `pnpm test wasm`, `pnpm test:slow wasm -t tick-phases`, the native `slow_phases_large_save` (release), `pnpm test:slow browser -t "large-save|bench"`. All foreground, bounded. Check `uptime` before each timing run; the Mac is shared (load 5-10 is normal; ratios within one run are the evidence).

## Budgets
`PRE-PLAN.md` §7 tick row (10 ms, ADR 0010), held by the iPhone per ADR 0056 §3: measured by M39-large-save on the phone (the orchestrator's driverless `--open ios` run).

## Manual device checks
M39-large-save on the iPhone, by the orchestrator, after this lands.

## Deviations
**M39ae, step 1 (baseline) and step 2 (one commit, `36e00bab`); the stop rule was met after step 2, so candidates 3-5 were not done.**

Load average at the runs: 3-7 (baseline and after, interleaved by session; the browser test ran at 20). `sim_tick` ms p50 / p95; "Node paced" is the release bench `.wasm`, 50 ms sleep (`tick-phases @slow`), "native" is `slow_phases_large_save` (release).

| run (load) | native | Node back to back | Node paced |
|---|---|---|---|
| base 1 (3.8-6.6) | 1.128 / 1.211 | 1.530 / 1.759 | 3.195 / 7.027 |
| base 2 | 1.128 / 1.196 | 1.525 / 1.778 | 3.223 / 7.034 |
| base 3 | 1.134 / 1.189 | 1.530 / 1.799 | 3.249 / 7.085 |
| step 2, run 1 (6-9) | 0.777 / 0.854 | 1.097 / 1.242 | 2.528 / 5.442 |
| step 2, run 2 | 0.768 / 0.820 | 1.095 / 1.251 | 2.575 / 6.358 |
| step 2, run 3 | 0.775 / 0.872 | 1.093 / 1.284 | 2.542 / 6.569 |

Median paced p50: 3.223 -> 2.542 ms = **78.9 %** (-21.1 %; the three step-2 runs are 78.4, 79.9, 78.8 %). Native -31 %, Node back to back -28 %. Phases, paced p50 (base median -> step 2 median): drain 0.75 -> 0.32, wake_at 0.63 -> 0.25, put 1.11 -> 1.12, advance 0.73 -> 0.93 (noise; native advance fell 0.233 -> 0.166), changes 0.24 -> 0.24. Margin to the 80 % line is thin (run 2 is 79.9 %).

**Step 2 change** (`sim/timers.rs` only): `by_entity` is now `Reverse`, a `Vec<Option<Tick>>` indexed by id for `id < DENSE_LIMIT` (`1 << 20`, 8 MB at most) plus a `BTreeMap` overflow for larger ids, and a live count. Bound: ids come from an untrusted snapshot (`TimerWheel::decode`); the table grows in exactly one place (`Reverse::insert`), only for `id < DENSE_LIMIT`, capped to the bound, so no id sizes an allocation beyond 8 MB. Both paths answer the same, so the canonical bytes and hashes are unchanged. Also `next_due` uses `BTreeMap::first_entry` (one tree walk instead of `iter().next()` then `get_mut`, then `remove`). No state, order or encoding change.

**Test**: `sim::timers::tests::huge_id_never_grows_the_dense_table` (no timing). Seen red with the bound removed (`DENSE_LIMIT = u32::MAX`): `FAIL rust engine sim::timers::tests::huge_id_never_grows_the_dense_table ... timers.rs:253:9: and sized by small ids only`; green restored.

**Verification**: `pnpm test rust` -> `rust pass 805 tests`; `pnpm test wasm` -> `wasm pass 172 tests`; `pnpm test:slow wasm -t tick-phases` pass (x6 above); `pnpm test:slow browser -t "large-save|bench"` -> `browser pass 3 tests 78s`; `git status` showed only `sim/timers.rs` modified (no golden). `cargo clippy --workspace --all-targets` clean. Not run: full `pnpm test`/`pnpm lint` (the orchestrator's gate). Note (pre-existing, not mine): `cargo clippy -p engine --all-targets --features bench-phases` fails to compile the lib tests (`assert_golden_bytes` not found), because that feature combination lacks `testing`.

Not done: candidates 3 (`chunk_versions.insert`), 4 (`put_entity` write path: `put` is now the largest phase at 1.1 ms paced, 0.36 native; each furnace is put once per tick, so "already recorded this tick" would skip nothing) and 5; they are the room for margin if the iPhone proof falls short. The entity table itself is a `BTreeMap<EntityId, Entity>` (`store/mod.rs:94`), the likely next cost and a storage change (Q18 (c)).
- **Gate (orchestrator):** accepted. `pnpm test` (rust 805) and `pnpm lint` green; no golden. Dense `by_entity` capped at `DENSE_LIMIT` 2^20 ids x 8 B (`Option<Tick>`, `Tick(u32)`) = 8 MB, grown only for ids under the cap; the bound test was red with the cap removed. Paced p50 78.9 % of baseline (one run 79.9 %: thin margin); the phone decides.
