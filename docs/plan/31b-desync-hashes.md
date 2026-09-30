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
- **`Hashes` section** filled by the host on the schedule of 0013 (chunk cadence and order: recently modified first, then round-robin; Global and OwnPlayer cadence). Hash = M05's state hash over M14's `encode_chunk_snapshot` for that one chunk (the per-chunk form of M15's `region_hash`); no second canonical form. This is exactly why M14's `encode_chunk_snapshot` does not write the chunk coordinate: the per-chunk hash must be self-contained bytes for one chunk, independent of any other chunk's position, and a delta-coded coordinate chained from a neighbour (as the chunk-coordinate list does at the section level) would make the hash depend on unrelated data (M14 Deviations, "Chunk snapshot coordinate"). Chunk identity for a hash comes from the `Hashes` entry itself, not from the hashed bytes. Each entry starts with a kind byte (`Chunk | Global | OwnPlayer`), kept extensible because M08 reserves a pristine-terrain kind.
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
**Consumes:** harness, `assertConverged` (M27); `Welcome` codec (M28); `Host::enqueue_chunk_snapshot(conn, coord, EnterPriority)` (named `enqueueChunkSnapshot` in M31's brief), `assertBudget`, `NetCounters` per-section bytes (M31); `SectionId::Hashes`, `MsgType::ResyncChunk` (ids reserved), `encode_chunk_snapshot` (M14); state hash (M05); `Host<G>`, `Replica<G>`, `region_hash`, per-chunk version as "last modified tick" (M15).

## Planning decisions
- **Where the per-chunk version actually lives today, and why this is the milestone to revisit it.** M15's Scope wording says the per-chunk version is stored "with the chunk" on both sides; the replica honours that, but the host side does not — `Host::chunk_versions` is a `BTreeMap<ChunkCoord, u32>` (`host/mod.rs`), never pruned, gaining one permanent entry per distinct chunk ever touched by a replicated write (`docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Fix round 3b" item 2; recorded as a candidate for this milestone in `docs/plan/deferred-ledger.md`). This milestone is the one that puts per-chunk state (desync hashes) beside each chunk, so it is the natural place to move the version alongside it, prune it, or accept it as-is with a recorded reason — not a decision M15 or M31 made for it.
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

Steps 1-3 (steps 4-5 are a later delegation). Commits `1f8905e` (step 1, which carries the source of steps 2-3 too: ABI, resync, report ring and hooks were written in one pass and could not be split by file), `1957a6b` (step 2: the resync tests and goldens), then `M31b step 3` (netcode harness, tests, context artifacts).

**Seams step 4 consumes (exact shapes)**
- `Hashes` section body (`wire/hashes.rs`): flat entries to the section's end, no count. `kind u8`: `0 Chunk` = `cx zigzag varint, cy zigzag varint, hash u64 LE`; `1 Global` = `hash u64 LE`; `2 OwnPlayer` = `hash u64 LE` (receiver's own player, no id). Unknown kind = `Malformed`. Rust: `wire::HashEntry { Chunk { coord, hash } | Global { hash } | OwnPlayer { hash } }`, `write_hash_entry`, `read_hashes(&mut ByteReader, FnMut(HashEntry))`. A production frame carries at most one `Chunk` entry (11 B for small coords); `Global` + `OwnPlayer` (9 B each) ride the same frame every 5 s. Measured: `Hashes` bytes 644 over 192 ticks with two-byte section overhead per frame, about 67 B/s per client on a quiet `fx-puts` world (0013's figure is ~60 B/s).
- `ResyncChunk` (`wire::write_resync_chunk(sink, coord)`, `read_resync_chunk(bytes)`): `0x04, cx zigzag varint, cy zigzag varint`, nothing after. Reserved coord `wire::RESERVED_SCOPE_COORD = (i32::MIN, i32::MIN)` asks for `Global` + `OwnPlayer`. Goldens: `tests/golden/wire_resync_chunk.hex` (`040603` for `(3, -2)`), `wire_hashes_section.hex`.
- `Host::chunk_hash(conn, coord) -> Option<u64>` (`None` when `conn` does not hold it), `Replica::chunk_hash(coord) -> Option<u64>`; also `Replica::global_hash()`, `Replica::own_player_hash()`, and `integrity::{chunk_hash, global_hash, player_hash}` over a `Store`. **The hash writes the snapshot `version` as 0 on both sides**: a host stamps every chunk an entity footprint touches while a replica bumps only the anchor chunk, and a pristine enter leaves the replica at version 0 while the host's may be higher, so hashing the version would report a desync that is not one. All replicated state (overlay runs, overlapping entities) is hashed. `Global` is the game value only (the roster is incremental and a replica's slot table is not comparable).
- Report: `integrity::DesyncReport { tick: u32, scope: DesyncScope { Chunk | Global | OwnPlayer }, coord: ChunkCoord, host_hash: u64, client_hash: u64 }`, ring `integrity::DesyncLog` (16 entries, `count()`, `len()`, `get(i)` oldest first). Client: `ClientCore::desyncs()`. Host: `Host::desyncs()`. One `desync (client|host): ...` warn line to `engine.log` per report. A client reports every mismatch (a repeat on the same chunk is reported again) but requests a resync once per chunk until the answer lands (snapshot of that chunk, a leave, or an `OwnPlayer` section for the reserved coord), re-arming after 5 s of ticks. The host records a report per `ResyncChunk` it acts on (a held chunk, or the reserved coord, whose report has scope `Global` and covers both scopes); `client_hash` is 0 there because the request carries only the coordinate, and `host_hash` is the host's hash when the request arrived.
- ABI (`ABI_VERSION` 34 -> 35), all `engine/test`: `sim_desync(index)` and `client_desync(index)` write 40 bytes into `Result` (`count u32, retained u32, tick u32, scope u32, cx i32, cy i32, host_hash u64, client_hash u64`; one report per call because `Result` is 64 B); `sim_skip_delta(conn, packed)` with `packed = (cx as i16 as u16) | (cy as i16 as u16) << 16` (the loader has no 3-argument call; `0x8000_8000` = drop `Global` value updates until a frame carries the `Global` hash); `client_corrupt_chunk(cx, cy)` (`NotCached` when not held). TS: `src/test/desync.ts` (`DesyncReport`, `DesyncLog`, `readDesyncLog`), `HeadlessClient.desyncs()` / `.corruptChunk(cx, cy)`, `harness.desyncs()` (all clients, tagged `client`), `harness.hostDesyncs()`, `harness.skipDelta(i, cx, cy)`, `harness.skipGlobalDelta(i)`. `serverInternals(server).desyncCount` and `assertNoDesync()` are step 4's.
- Cadence hook: `host::hashes::HashMode { Off | Production | All }`, `Host::set_hash_mode(mode)`, config key `hashMode` (`"off" | "production" | "all"`) reaching Rust through `WorldConfig.debugHashMode` (`sim-config.ts`) and `NetHarnessOptions.world.debugHashMode`. `All` sends every eligible held chunk plus `Global`/`OwnPlayer` on every frame; nothing sends the `Welcome` flag yet. **The default is `Off`** (Rust, ABI and harness alike): production cadence changes the pinned bytes of 14 existing tests (list below), and step 4 owns the default and the harness opt-outs.
- Eligibility: only held chunks that are not collapsed, not queued for a snapshot and not leaving are hashed (their state on the client is exactly the host's once the frame applies). Schedule (`host/hashes.rs`): one chunk per 4 ticks, a chunk modified since it was last hashed first (most recent), otherwise round-robin in `(cy, cx)` order; **added: every 4th pick is round-robin regardless**, so a world that modifies chunks faster than the sweep cannot starve a quiet, corrupt chunk. A due hash forces a frame to be built (a hash-only frame is 10 B header + 13 B), so an idle world sends 5 frames/s rather than 2 (heartbeats); that is what 0013's ~60 B/s models.
- Hash-all and prediction: `Replica::chunk_hash` reads the replica store only; the overlay lives in `ClientCore` (`integrity_hash_ignores_overlay` asserts a pending predicted paint leaves it unchanged while the merged view changes).

**Production cadence on by default breaks (observed by running `pnpm test netcode` with it on, then reverted to `Off`)**: `counters-exact`, `liveness/heartbeat-idle-world`, `rates/baseline-counters-exact`, `rates/baseline-join-converges` (666 B vs ceiling 369), `rates/baseline-late-join`, `rates/idle-sends-only-heartbeats`, `rates/steady-busy-field`, `rates/join-wilderness`, `rates/join-dense-visible-first`, `rates/degrade-heartbeat-held` (max emit gap 6 vs 10), `rates/seven-remote-presences`, `rates/hard-ceiling`, and in Rust `no_alloc_connection` (3 tests) and `fx-busy-field` `load` (2 tests). One is not a byte pin: **`rates/degrade-on-soft-cap` failed `assertConverged` (host vs replica hash at tick 220) with production hashing on**; not investigated (step 5: it may be a real desync the hashes now provoke, e.g. via the M31 ledger row "A frame overflow still loses the deltas of other held chunks").

**Planning decision `Host::chunk_versions`: kept as a never-pruned `BTreeMap` on the host.** The version is host-global, feeds the resume diff and the snapshot's `version` field, and is no longer part of any hash, so moving it beside the chunk buys nothing here; one 8-byte entry per chunk ever touched by a replicated write is dwarfed by the overlay/entity state those same writes leave (a chunk that only ever had a write reverted is the one exception), and pruning an entry would read back as version 0 and force a needless re-snapshot on resume. Revisit only if a world's touched-chunk count outgrows its state budget.

**Other deviations**
- Tests named in the brief and where they landed: Rust `integrity_golden_resync_chunk`, `integrity_schedule_recent_first_then_round_robin`, `integrity_hash_ignores_overlay` (runs, not skipped), plus `integrity_golden_hashes_section`, `integrity_host_hashes_one_chunk_per_period_and_sweeps`, `integrity_clean_session_no_reports`, `integrity_clean_session_no_reports_hash_all` (hash-all on native `LGame`, wide entities and cross-chunk moves included: no false positive), `integrity_corrupt_chunk_heals`, `integrity_skipped_delta_heals`, `integrity_reserved_coord_resends_both_scopes`, `integrity_resync_respects_bucket`; netcode `integrity/{clean-session-no-reports, clean-session-busy-field-no-reports, corrupt-chunk-heals, skipped-delta-heals, global-mismatch-heals, resync-respects-bucket}`. Not built (step 4): `hash-all-dumps-encodings`, `hash-bytes-per-second`, the `net.hashesBytesPerS` row, dump files, `Welcome` flag.
- `fx-puts` changes `Global` every simulated second, so a single dropped `Global` update self-heals before the 5 s hash; `skipGlobalDelta` therefore drops every update until the `Global` hash frame goes out.
- The recently-modified-first schedule makes `skipped-delta-heals` fast: the modified chunk is hashed at the next slot (within 4 ticks), not after a sweep.
- Inject-fail-revert (each test fails when its mechanism is removed, passes when restored): `corrupt-chunk-heals` (client never queues a `ResyncChunk`): `expected +0 to be 1` / revert `netcode pass 6 tests`; `skipped-delta-heals` (same injection): `expected 0 to be greater than or equal to 1`; `global-mismatch-heals` (host ignores the reserved coord): `expected undefined to match object { scope: 'global' }`; `resync-respects-bucket` netcode (host credits 1,000,000 tokens on a resync): `expected 4 to be greater than 100`, and Rust `integrity_resync_respects_bucket`: `the resync snapshots are paid from the chunk bucket: [446, 450]`; each restored run: `netcode pass 6 tests` / `rust pass 1 tests`.
- Residue not touched: the ledger row "A frame overflow still loses the deltas of other held chunks in that frame". No clean-session scenario tripped it here.

