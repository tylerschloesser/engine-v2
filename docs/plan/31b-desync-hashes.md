# M31b: Desync hashes and chunk resync

Status: not started · After: 31 · Tyler-dependent: no

Second half of the PLAN.md row "rates and integrity" (split explained in M31). M34 lists it in `After`.

## Goal
The host piggybacks per-chunk, Global and OwnPlayer hashes on frames; each client compares them with its replica right after applying that frame, asks for a resync of whatever differs, and both sides count a desync report. In hash-all mode every subscribed chunk is checked every frame and a mismatch dumps both encodings, which turns every other netcode scenario into a replication-correctness test.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0013-sessions-and-integrity.md` (Per-chunk desync hashes; Alternatives: whole-world or overlay-inclusive hashes)
3. `docs/decisions/0011-wire-format-and-deltas.md` (sections: `Hashes`; chunk snapshot encoding; atomic frame apply)
4. `docs/decisions/0020-testing-strategy.md` (§5 last sentence, §7 assertions)

Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md` (client-side hashing runs inside `on_frame`).

## Scope
- **`Hashes` section** filled by the host on the schedule of 0013 (chunk cadence and order: recently modified first, then round-robin; Global and OwnPlayer cadence). Hash = M05's state hash over M14's `encode_chunk_snapshot` for that one chunk (the per-chunk form of M15's `region_hash`); no second canonical form. Each entry starts with a kind byte (`Chunk | Global | OwnPlayer`), kept extensible because M08 reserves a pristine-terrain kind.
- **Client check** inside the atomic frame apply, against the replica and never the prediction overlay.
- **`ResyncChunk { coord }`** uplink message, `reliable-ordered`, golden bytes. Host answer: that chunk's snapshot through M31's bucket at visible priority; the client replaces the chunk wholesale.
- **Global / OwnPlayer mismatch:** `ResyncChunk` with the reserved coord `(i32::MIN, i32::MIN)`; the host resends both scopes in the next frame.
- **Desync report** on both sides: `{ tick, scope, coord, host_hash, client_hash }` into a fixed-size ring of the last 16, a counter, and one `engine.log` line. The TS event for games is M37's.
- **Hash-all mode** (0013 "dev builds"): a runtime flag `debugHashAll`, carried in `WorldConfig`-adjacent test/dev config and announced to the client in `Welcome` flags. Host sends a hash for every subscribed chunk of that client in every frame; on mismatch the client keeps its own encoding until the resync snapshot arrives, then writes both (`<tick>-<cx>_<cy>.{client,host}.bin` under `test-results/desync/` in the harness; first differing offset via `engine.log` in the browser).
- **Fault injection** behind `engine/test`: `client_corrupt_chunk(cx, cy)` flips one replica byte; `sim_skip_delta(conn, cx, cy)` drops one delta on the host side.

## Non-scope
Pacing (M31). Pristine-terrain hash sampling between client and server (0008 deferred item; not this brief). Reporting desyncs to a game's UI (M37).

## Files, packages and crates touched
- `packages/engine/crates/engine`: `integrity` module (schedule, section, check, resync, report ring)
- `packages/engine/src/host/` (flag plumbing), `src/test/net-harness.ts`, `tests/netcode/`
- fixtures: M16's action fixture and M31's `busy-field`

## Seams
**Provides:** `ResyncChunk` body; `Hashes` section body; `Host::chunk_hash(conn, coord)` / `Replica::chunk_hash(coord)`; `Welcome` flag bit `HASH_ALL`; `createNetHarness({ hashAll?: boolean })`, **default `true`** except where a scenario asserts bytes; `harness.desyncs(): DesyncReport[]`; `assertNoDesync()` folded into `assertConverged()`; `serverInternals(server).desyncCount`; test exports `client_corrupt_chunk`, `sim_skip_delta`.
**Consumes:** harness, `assertConverged` (M27); `Welcome` codec (M28); `enqueueChunkSnapshot`, `assertBudget`, `NetCounters` per-section bytes (M31); `SectionId::Hashes`, `MsgType::ResyncChunk` (ids reserved), `encode_chunk_snapshot` (M14); state hash (M05); `Host<G>`, `Replica<G>`, `region_hash`, per-chunk version as "last modified tick" (M15).

## Planning decisions
- **Hash-all is a runtime flag, not `cfg(debug_assertions)`.** The fast tier builds on the dev profile (0020 §3), so a compile-time switch would put hash traffic into every byte-counter assertion of M31. The harness turns it on everywhere except `rates/*`, `zoomout/*`, `reconnect/cost`; the Vite plugin's dev server turns it on; release builds and `games/reference-server` leave it off.
- **Global/OwnPlayer resync reuses `ResyncChunk`** with a reserved coordinate (0024 §8); 0013 names the hashes but no recovery message for them, and a new message type for a should-never-happen path is not worth a type id.
- **The host's resync snapshot is the host-side dump.** The client already holds its own encoding, so no debug-only upload path exists.
- **A desync never closes the connection and never pauses the world;** a second mismatch on the same chunk within the sweep period is reported again, with no escalation in v1.

## Order of work
1. Schedule + `Hashes` section + client check, native tests.
2. `ResyncChunk` + bucket answer; reserved coord for scopes.
3. Report ring, counters, fault-injection hooks.
4. Hash-all flag through `Welcome`; harness default; dump files.
5. Run the whole netcode suite with hash-all on; fix or file whatever it finds.

## Tests added
Rust: `integrity/schedule-recent-first-then-round-robin`, `integrity/golden-resync-chunk`, `integrity/hash-ignores-overlay` (pending predicted action present; needs M25, else skipped with a named reason). Netcode: `integrity/clean-session-no-reports`, `integrity/corrupt-chunk-heals` (corrupt → report on both sides → resync → converged within one sweep period), `integrity/skipped-delta-heals`, `integrity/global-mismatch-heals`, `integrity/resync-respects-bucket`, `integrity/hash-all-dumps-encodings` (files exist, differ at the flipped byte), `integrity/hash-bytes-per-second` (`assertBudget('net.hashesBytesPerS')`, hash-all off).

## Exit criteria
- [ ] Named tests pass; every pre-existing netcode scenario passes with `hashAll: true`.
- [ ] `net.hashesBytesPerS` row exists, sourced from 0013's figure.
- [ ] Netcode suite within its 0020 §3 budget with hash-all on (if not, hash-all drops to every 4th frame in tests and Deviations says so).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode -t integrity/` · `pnpm test netcode` · `pnpm test rust -t integrity` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Bandwidth per client, steady": the hash share, by `integrity/hash-bytes-per-second`. "Frame time" (client-worker `frame`): production hashing is one chunk per 4 ticks, O(one chunk); hash-all is exempt from frame budgets and must be off in `gc/*` and M36 benchmarks.

## Context artifacts
Netcode `CLAUDE.md`: hash-all default, where dumps land, how to read a desync report. `run-tests` skill: `test-results/desync/` as a failure artefact.

## Manual device checks
none

## Deviations
