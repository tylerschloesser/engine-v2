# M39ag: the large-save pass gets margin under 10 ms on the iPhone

Status: done (2026-10-09) · After: 39ae · Tyler-dependent: no (Q18 (a); ADR 0056 §3)

## Goal
After M39ae, the iPhone's driverless M39-large-save (`docs/plan/device-rounds/m39ae-iphone-large-save.jsonl`, 2026-10-09) still fails by 3 %: `tick_p95_ms` **10.32** (limit 10; it was 11.82). `sim_tick` alone is now p50 7.08 / p95 max 8.7, but the criterion times the **whole sim-worker pass** (`PassSample.wholeUs` in `games/reference/src/bench-stats.ts`: seal, the sim tick, frame build, resync and whatever else is in the pass). The pass median is 8.4 ms, about 1.3 ms above `sim_tick`. On the phone, `frame_build_p95_ms_max` is 1.68, seal 0.02, resync 0.14, and catch-up 0. When this is done the whole pass is at least **10 % cheaper** than at M39ae's `done` (`a2087c62`) on the desktop proxy, with state unchanged, so the phone has margin. The iPhone run is the orchestrator's.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39ae-large-save-tick-under-10ms.md` (Deviations: the per-phase table after step 2; `put` is now the largest sim phase)
3. `docs/plan/39y-wasm-tick-cost.md` (Deviations: the phase counters, the cold-wake mechanism, the candidates)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
1. **Account for the whole pass first.** On the desktop proxy (headless Chromium, `dist-bench`, `?bench=large-save&scale=1`, 60 s; the path `pnpm test:slow browser -t "large-save|bench"` drives), and natively where a twin exists, paste p50/p95 of `whole`, `seal`, `tick`, `frame`, `resync` and **the remainder** (`whole` minus the parts). Three runs, load stated. If the remainder is above 0.3 ms, find what it is (sim-worker code between the timed parts) before step 2.
2. **Take the biggest measured part first:**
   - **frame build** (the server side of the pass: what it encodes per pass, and whether a pass with no subscriber-visible change still builds or copies a full frame);
   - M39ae's untaken candidates: **`chunk_versions.insert`** dedupe in `Host::tick`, and the **`put_entity` write path** (`entity_scopes`, the change log), per M39ae's Deviations;
   - the remainder, if step 1 found one.
   Each its own commit with a before/after row (interleaved, three runs each).
3. Stop rule: stop when the desktop proxy's whole-pass p50 is ≤ 90 % of the `a2087c62` baseline (measured in step 1 by checking out that commit's build, or by step 1's own baseline on the current tree, which is the same code). If nothing left reaches it without a storage change, stop and report the table. The entity store's `BTreeMap` (`store/mod.rs:94`) is a storage redesign, Q18 (c): Tyler's call, not this milestone.

## Non-scope
State, snapshot format, the wire encoding, goldens and hashes; the criterion, limits and `budgets.json`; busy-waits, thread priority or keeping the worker awake (masks: ADR 0056, M39s); the furnace count; the Pixel.

## Files touched
The engine crate (`host/`, `authority.rs`, and the frame build path the measurement names), the sim worker (`packages/engine/src/worker/sim.ts`) only if step 1 finds the remainder there, and their tests.

## Seams
**Provides:** none new. **Consumes:** M39y's `bench-phases`, M39s's ring, M39ae's dense `by_entity`.

## Tests added
Every golden, hash and determinism test passes unchanged (paste that `git status` shows no golden). If a frame-build change skips work when nothing changed, add a test that a pass with a subscriber-visible change still sends it (fails if the skip is too eager: inject and paste the red). No timing assertions.

## Exit criteria
- [x] Step 1's whole-pass breakdown pasted (three runs, load).
- [x] A per-change before/after table; whole-pass p50 ≤ 90 % of baseline, or the stop report.
- [x] Goldens and hashes unchanged (`pnpm test rust`, `pnpm test wasm`, `pnpm test netcode` pass lines).
- [x] The eager-skip test (if any) exists and was seen red.
- [x] `pnpm test:slow browser -t "large-save|bench"` passes (pasted).
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
As above, foreground and bounded. `uptime` before each timing run; interleave before/after.

## Budgets
`PRE-PLAN.md` §7 tick row (10 ms), held by the iPhone (ADR 0056 §3); measured by M39-large-save on the phone (the orchestrator, `--open ios`).

## Manual device checks
M39-large-save on the iPhone, by the orchestrator, after this lands.

## Deviations
**M39ag, steps 1-2 (commits `51fa9586`, `926f3f50`, `a9ff8e03`, `2310e3e6`); the stop rule was met (whole-pass p50 about 87 % of baseline).** No seam changed; no state, encoding, golden, hash, limit or budget touched (`git status` shows no golden; `pnpm test rust` 806, `wasm` 172, `netcode` 147 pass).

**Step 1: where the whole pass goes** (desktop proxy: headless Chromium `chromium` channel, `dist-bench`, `?bench=large-save&scale=1`, uncapped rAF flags as `frame-bench`, median of the 10 s windows over 60 s; load 2-6 at the three runs). p50/p95 ms:

| run | whole | seal | tick (`sim_tick`) | frame | resync | remainder |
|---|---|---|---|---|---|---|
| base 1 | 2.68/3.04 | 0.01/0.01 | 1.91/2.16 | 0.78/0.99 | 0.01/0.02 | 0.01/0.01 |
| base 2 | 2.67/3.00 | 0.01/0.01 | 1.89/2.15 | 0.76/0.94 | 0.01/0.03 | 0.01/0.01 |
| base 3 | 2.65/2.97 | 0.01/0.01 | 1.89/2.10 | 0.76/0.94 | 0.01/0.02 | 0.01/0.01 |

The remainder (whole minus the timed parts) is 0.01 ms: nothing hides in the sim worker between the timed parts, so `sim.ts` is untouched. The phone's ~1.3 ms gap between pass p50 and `sim_tick` p50 is **frame build**: 29 % of the pass here (0.76 of 2.67), the only part besides `sim_tick` above 0.05 ms. The frame is about 35.5 KB per tick on the desktop page (one connection, maximum zoom-out view over the dense block): mostly chunk snapshots, because the soft-cap collapse (`pending > snapshot_len`) re-snapshots the dense chunks. Marks inside `build_frame` (wasm, temporary, not committed) put the 0.63 ms of `simBuildFrame` (the `ring.send` is 0.055) at: chunk drain with the snapshot price 0.12, delta loop 0.09, collapse 0.045, **`ChunkSnapshots` section 0.335**, other sections 0.055. A native `xctrace` profile of `slow_tick_large_save` (release, 8 connections) put 26 % of all samples in `ChunkCoord` slice `contains` (the `held` scans) and 12 % each in BTree `get` and in the entity-op list scan.

Diagnostic kept (step 1 commit): `BenchHud.parts` (`games/reference/src/bench.ts`, `bench-stats.ts`): `{whole, seal, tick, frame, resync, rest: [p50, p95]}`, so the table above is reproducible from `window.__bench.hud().parts`.

**Step 2: three changes, each its own commit** (`host/mod.rs`, `wire/snapshot.rs`, `store/mod.rs`; interleaved, 3 runs each, load 5-10, whole p50 ms, `base` = `a2087c62`'s code):

| change | runs (whole p50) | frame p50 | vs base (paired) |
|---|---|---|---|
| base | 2.69, 2.78, 2.81 | 0.78, 0.83, 0.82 | 100 % |
| 2a held/entering/collapsed in one sorted table (`scratch_held`, `held_flags`) | 2.59, 2.64, 2.67 | 0.69, 0.72, 0.73 | 96, 95, 95 % |
| 2b a snapshot encoded once (priced in the drain into `scratch_snap_bytes`/`scratch_snap_spans`; the section copies via `SnapshotWriter::write_chunk_encoded`) | 2.41, 2.44, 2.46 | 0.48, 0.48, 0.49 | 90, 88, 88 % |
| 2c `Store::for_each_entity_in` (one leaf walk when the ids are within 4x their count, else lookups) used by `encode_chunk_snapshot` | 2.39, 2.35, 2.43 | 0.44, 0.43, 0.45 | 89, 85, 86 % |

Final build without the temporary debugging, `base-dist` vs the tree (two interleaved pairs): whole p50 2.65 -> 2.36 (89 %) and 2.71 -> 2.33 (86 %); frame 0.78 -> 0.43 and 0.77 -> 0.42; `tick` unchanged (1.89-1.93). Expect the phone to gain about the frame share of the pass (the frame is cold-wake sensitive like the tick), roughly 0.3 ms desktop, perhaps 0.8-1.0 ms there; that is margin, not proof.

**Tried and dropped:** an id-indexed table for `upsert_entity_op` (O(1) instead of the list scan): no measurable gain in the browser (build p50 0.625 vs 0.625) and the table grows with the largest entity id, which put `host_and_client_panning_allocates_per_new_chunk_not_per_tick` over its ceiling (89.49 B vs 88). Reverted before the first commit.

**Tests:** `store::tests::for_each_entity_in_matches_entity_lookups` (both paths, gaps, absent ids, empty); seen red with `<` changed to `<=` in the walk: `FAIL rust engine store::tests::for_each_entity_in_matches_entity_lookups ... assertion left == right failed: ids [7]`. 2a and 2b are covered by the existing frame/delta/snapshot, desync-hash and pacing tests and goldens, which pass unchanged (no frame skip was added, so no eager-skip test). No timing assertion.

**Verification:** `pnpm test rust` -> `rust pass 806 tests`; `pnpm test wasm` -> `wasm pass 172 tests`; `pnpm test netcode` -> `netcode pass 147 tests`; `pnpm test:slow browser -t "large-save|bench"` -> `browser pass 3 tests    78s`; `pnpm test unit -t bench` -> `unit pass 12 tests`. Not run: full `pnpm test`/`pnpm lint` (the orchestrator's gate).

**Not done, for margin if the phone is still short:** `chunk_versions.insert` dedupe and the `put_entity`/`entity_scopes` path (the tick side, 1.9 ms of the 2.4: `store.entity()` BTree `get` is about a quarter of the native tick samples; the per-furnace lookups in `furnace::advance`, `entity_scopes` and `Store::apply` are the same map, Q18 (c)); `write_chunk_deltas_flat` and the collapse estimate each still do a BTree `get` plus an encode per put; the collapse's `scratch_snapshot_len` count and next tick's drain encode the same chunk twice across ticks.
- **Gate (orchestrator):** accepted. Full `pnpm test` and `pnpm lint` green (rust 806, netcode 147, wasm 172; browser 256 on a rerun: the first full run at load 12 had `paced_session_lands_periodic_snapshots` at 2 persistence snapshots against 3, a timing check this change does not touch, then 3/3 alone and green in the full suite). No golden changed. Removed a stray `host/mod.rs.orig` (4000 lines) the implementer had committed. Wire order checked: `scratch_snap_spans` is pushed one-to-one with `scratch_snapshot` and sorted by the same key. Inject-fail by the orchestrator: delivering entity puts to collapsed/entering chunks turns `netcode rates/degrade-on-soft-cap` red; cutting one byte off each cached snapshot turns 3 rust tests red; reverted. A tile delta sent to an entering/collapsed chunk is caught by no test (redundant bytes, not wrong state; the same gap existed before 2a). Desktop whole-pass p50 86-89 % of base; the phone decides.
