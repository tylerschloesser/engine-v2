# M34d: A straddling entity bumps every held chunk's version on the replica

Status: not started · After: 34b · Tyler-dependent: no

Written by the orchestrator at M34b's first gate (2026-09-30). M34b's implementer found that a reference furnace whose 2×2 footprint straddles a chunk boundary (origin (-4, -1)) leaves the netcode harness's `assertConverged` failing after `settle()`, and moved the script's furnaces to single-chunk origins. A read-only diagnosis (below) located it. M34c runs scripted multiplayer races, where real placements straddle chunks, so this lands first.

## Goal
Host and replica agree on every held chunk's version after any entity put, move or removal, whatever chunks its footprint covers. A test that is red today proves it, and a reference furnace placed across a chunk boundary converges.

## The evidence (read in code at the gate; not yet run)
- **Host:** the tick loop in `packages/engine/crates/engine/src/host/mod.rs` (about lines 1736-1742) stamps `chunk_versions.insert(c, completed.0)` for **every** chunk in each change's scopes, and `Authority::entity_scopes` (`authority.rs`, about line 551) builds those scopes from the old and the new footprint's chunks.
- **Replica:** `client/replica.rs` `apply_entity_put` (about line 420) and `apply_entity_gone` (about line 428) call `bump_version(chunk_of(G::anchor(..)))`: the **anchor chunk only**. A furnace at (-4, -1) covers chunks (-1, -1) and (-1, 0); the host bumps both, the replica one. A client holding only the non-anchor chunk bumps nothing.
- `Replica::region_hash` (about line 487) and `Host::region_hash` (about line 2557) both hash the real version through `encode_chunk_snapshot`, so they disagree. Frame scoping, `ChunkIndex` and `encode_chunk_snapshot` are overlap-based and consistent.
- **Production effect:** not a content desync. `integrity::chunk_hash` (M31b) writes version 0 on both sides, so no `ResyncChunk` fires and rendering (from entity content) is right. But replica versions feed the reconnect resume diff (`session/resume.rs`): a stale non-anchor version forces a needless re-snapshot of that chunk on every resume. Whether it can ever wrongly *keep* a stale chunk was not checked: check it.
- **Why nothing caught it:** `replica_hash_equals_host_region_hash` (`crates/engine/tests/main/connection_and_subscriptions.rs`, about line 544) apparently never crosses a boundary with a multi-tile entity; the `SpawnWide` (2×1) straddle tests near line 345 assert delivery, not hash parity; `chunks_converged` (`tests/main/integrity.rs`) is version-agnostic by design.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0011-wire-format-and-deltas.md` (Scopes)
3. `docs/plan/31b-desync-hashes.md` (Deviations: why the per-chunk hash writes version 0)
4. `docs/plan/28b-reconnect-and-lifecycle.md` (the resume diff's use of chunk versions)

Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`. Skill: `run-tests`.

## Scope
- **Red first:** `straddling_footprint_region_hash_matches_host` in `connection_and_subscriptions.rs`: loopback fixture game, camera holding both chunks `SpawnWide` spans, spawn on the boundary, step, assert `host.region_hash(conn) == client.region_hash()`; a second case holding only the non-anchor chunk; a third that moves or removes the straddling entity. All red on base.
- **Fix the replica, not the hash:** `apply_entity_put` and `apply_entity_gone` bump every *held* chunk under the old footprint (read before applying) and under the new one, with `footprint_rect(..).chunks(&dims)` as `apply_leave` and `entity_scopes` already do. Do not write version 0 into `region_hash`: that would blind the only version-parity check.
- **Resume:** a test that a client holding a straddling entity reconnects and keeps (does not re-snapshot) both chunks when nothing changed, red on base if the stale version causes a re-snapshot. Answer in Deviations whether a stale version could ever keep a chunk that did change.
- **Reference:** a netcode scenario placing a furnace at (-4, -1) with `settle()` and `assertConverged()`; M34b's script origins stay as they are.

## Non-scope
Predicted-entity overlay versions (the `Predicting` overlay does not bump versions). Any change to `integrity::chunk_hash`. M34c's scenarios.

## Files, packages and crates touched
`packages/engine/crates/engine/` (`client/replica.rs`, tests), `packages/engine/tests/netcode/` (one reference scenario).

## Seams
**Provides:** nothing new by name. **Consumes:** `Replica::region_hash`, `Host::region_hash` (M15), `footprint_rect` (M21), the resume diff (M28b), `createNetHarness` with the reference game and `worldSeed` (M34b Deviations).
**From M34b (orchestrator):** the repro is finding 1 of M34b Deviations: `createNetHarness({ game: reference, worldSeed: '6840143426475589698' })`, a furnace at origin (-4, -1) (rows -1 and 0 are chunks cy -1 and 0), then `assertConverged` fails after `settle()`; origin (-4, 1) converges. `script.ts`'s `FURNACE_A`/`FURNACE_B` stay single-chunk so `full-game.{log,json}` is unaffected; `pnpm --filter reference golden:record` must give no diff afterwards (a golden change means the fix altered state, not just replication).

## Planning decisions
- **The host is the reference.** Its versions follow the scopes a change was sent under, which is what a subscriber receives; the replica must match what it was sent, not the reverse.
- **What it does if wrong:** over-bumping shows immediately as the reverse `region_hash` mismatch and as extra resume re-snapshots; it cannot change content.

## Order of work
1. The three red tests. 2. The replica fix. 3. Resume test and answer. 4. Reference netcode scenario.

## Tests added
`straddling_footprint_region_hash_matches_host` (three cases), a resume test named for what it asserts, `reference_straddling_furnace_converges` (netcode).

## Exit criteria
- [ ] Each new Rust test is red on base and green after (paste both lines).
- [ ] `reference_straddling_furnace_converges` passes and fails with the fix reverted.
- [ ] No existing test or golden changes; if one must, stop and report.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t straddling` · `pnpm test netcode -t reference_straddling`

## Deviations
(Commits `M34d step 1` to `step 4`, base `55b4d6b`.)

**Diagnosis confirmed in code and by running.** Host stamps every scope chunk; the replica bumped the anchor chunk only. Line numbers were close. No claim differed.

**Red on base (step 1, `0efd97e`), then green after the fix (`04ddc70`).** All in `tests/main/connection_and_subscriptions.rs`, camera holds chunks (1,0)+(2,0) (`center (64,10)`) or only the non-anchor (2,0) (`center (100,10)`); `SpawnWide` at x=63 covers both:
- `straddling_footprint_region_hash_matches_host` (both held, put): `version of held chunk 2` left 0, right 1. Green after.
- `straddling_footprint_region_hash_matches_host_non_anchor_only`: same line, left 0, right 1. Green after.
- `straddling_footprint_region_hash_matches_host_after_move_and_removal` (move a wide one to a 1x1 elsewhere, then respawn and despawn; both camera cases): `after move away: version of held chunk 1` left 1, right 3. Green after.
Each test asserts versions per held chunk, the version-agnostic `chunk_hash` parity and `region_hash` parity.

**Fix.** `client/replica.rs`: `apply_entity_put` and `apply_entity_gone` bump every held chunk under the old footprint (read before applying) and the new one, through two private helpers `footprint_of` and `bump_rect` (`footprint_rect(..).chunks(&dims)`). `region_hash` and `integrity::chunk_hash` are untouched.

**Resume (step 3, `94717be`).** `straddling_footprint_resume_keeps_both_chunks` builds a hint with `build_resume_hint` from the client's `held_chunks_with_versions` and diffs it with `diff_resume_hint` against `Host::debug_version`: on base `keep` is `[(1,0)]` and `snapshot` `[(2,0)]` (the needless re-snapshot), after the fix both are kept. It is a pure-function test of the diff, not a full reconnect (`Host` wiring of the hint is M28b's and unchanged).
**Could a stale version keep a chunk that changed? No.** Read: `diff_resume_hint` keeps only when `hinted == host_version`. The host stamps every scope chunk of every write with the completing tick (`host/mod.rs` tick loop), so a chunk that changed after the hint has a host version greater than any version the replica could have held for it. The replica's version only ever comes from a snapshot's wire version or from `bump_version` (the frame's tick), so a stale version is always lower than the host's: stale means over-snapshot, never a wrong keep. Test `resume_hint_never_keeps_a_chunk_a_straddler_changed` (green on base and after): a hint taken before a straddler is despawned keeps neither chunk.

**Netcode (step 4, `e06922f`).** `tests/netcode/reference-straddling.test.ts` `reference_straddling_furnace_converges` (`worldSeed` from `world.json`, five stone, craft, stand at (-9,-1), `PlaceFurnace` at (-4,-1), `settle`, `assertConverged`). With `replica.rs` reverted to base: `assertConverged: seed=3406 tick=431 mismatches: client 0 (conn 0): host=1e6b997cf29ea140 replica=357e016982f8956a`. After: pass (0.9 s).

**No existing test or golden moved.** `pnpm --filter reference golden:record`: no diff (`705 logged ticks, 245 log bytes, final hash 8fb31c5e69eeb99d`). Final: rust 765 (760 + 5), unit 301, wasm 168, netcode 97, browser 240 (49 s of 48 s WARN, machine load; 47 s at M34b's end), lint green.
