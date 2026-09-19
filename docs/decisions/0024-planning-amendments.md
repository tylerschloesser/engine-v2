# 0024: Planning amendments to ADRs 0001–0020

Status: Accepted (2026-09-19). Amends [0001](0001-camera-and-presence.md), [0003](0003-game-facing-api.md), [0004](0004-action-timing-and-rejection.md), [0005](0005-persistence-and-recovery.md), [0007](0007-world-model.md), [0008](0008-chunk-generation.md), [0009](0009-transport-and-hosting.md), [0011](0011-wire-format-and-deltas.md)–[0020](0020-testing-strategy.md) in the points listed below; records a conditional change to [0010](0010-rates-and-subscriptions.md). Everything else in those ADRs stands.

## Context

Phase 2 wrote one brief per milestone (`docs/plan/`). Turning each ADR into signatures, byte layouts and call orders exposed gaps (a thing the ADR needs but never names) and contradictions (two ADRs, or an ADR and the platform, that cannot both hold). Accepted ADRs are not rewritten, so the fixes are collected here, one numbered section per topic. Briefs and later ADRs cite them as "0024 §n"; the numbers are stable. Each section states what the ADR says, why it cannot stand, the amendment, and the milestone (`Mnn` = `docs/plan/nn-*.md`) that implements it. Items that only fill a "deferred to Phase 2" slot (ring sizes, section ids, region ids) are not here; they live in the briefs.

## Decision

**1. 0014 ABI: streamed snapshots and a sealed frame.**
- Says: 0014 §4 lists `sim_snapshot() -> len` and a single `sim_tick() -> status` for the sim role.
- Why not: a world at its state budget serialises to about 15 MiB (0020 §9 large save), which cannot pass through one fixed region inside the arena. And 0004 step 3 requires the frame for T+1 to reach `Storage.append` *before* it is applied, so the host needs the log bytes between fixing the frame and applying it; one export cannot give them.
- Amendment: `sim_snapshot` is replaced by `sim_snapshot_begin(segment: u32, offset: u32) -> status` and `sim_snapshot_next() -> len` (one block in the `Persist` region per call; `0` = done; the last block ends with `state_hash | crc32`). The host drains all blocks inside one inter-tick gap and makes the single `Storage.write` of 0005; it owns the log position and passes it in. New export `sim_seal_frame() -> len` fixes the pending frame and writes its 0005 log frame to `Persist` (`0` = no records). The tick procedure is `sim_seal_frame()` → `logSink(view)` if `len > 0` → `sim_tick()`; an action admitted after the seal lands in T+2.
- Implemented in: M13 (`sim_seal_frame`, returning 0), M16 (seal semantics), M22 (real bytes, snapshot stream).

**2. 0005 `Storage`: no truncate; segments roll by size.**
- Says: recovery "truncates" at the first torn frame, but `interface Storage` has no truncate, and only an upgrade rolls a segment.
- Why not: the torn tail cannot be removed through the interface, and since `read(key)` returns a whole key an unbounded segment makes load and truncation unbounded.
- Amendment: no new method. Truncation is `write(logKey, validPrefix)` at load, off the tick path; every adapter must accept `append` after `write` on the same key, continuing after the written bytes (asserted by the storage conformance helper). The open segment is sealed and a new one opened when it exceeds `SEGMENT_ROLL_BYTES = 4 MiB` at the moment a periodic snapshot is written; that snapshot is the new segment's base, so the pruning rule of 0005 keeps it.
- Implemented in: M22 (conformance helper), M22b (truncate, roll).

**3. 0005 Upgrades: tail re-execution is not safe across an action-layout change.**
- Says: "Re-executing the tail is safe because `apply` always validates; at worst an action is now rejected."
- Why not: postcard is not self-describing. If `G::Action`'s layout changed, old bytes can decode as a *different valid* action, which validation then accepts.
- Amendment: (a) `SCHEMA_VERSION` (0003) also covers `G::Action`: changing the encoded layout of an action is a bump. (b) The tail is re-executed only when stored and running `SCHEMA_VERSION` are equal. When they differ the tail is dropped: the world resumes from the migrated snapshot, the old segment is sealed with `tailReexecuted: false`, and the dropped-record count is in the upgrade result and logged at `warn`. (c) On the re-executed path a record that fails `decode_canonical` under the new build is dropped, counted and warned, never an error. Cost: an upgrade after an unclean stop can lose the actions since the last snapshot; a clean stop leaves an empty tail. A layout change without a bump is an author error of the same class as a state-layout change without one.
- Implemented in: M24b. (M22b is unaffected: same-identity replay never decodes across builds.)

**4. 0005 OPFS row: rename is assumed.**
- Says: the snapshot is written to a scratch file and renamed to `snap/<tick>` with promise-only OPFS calls.
- Why not: that is `FileSystemFileHandle.move()`, whose WebKit support nobody verified in Phase 1.
- Amendment: M23's first step probes `move()` in Playwright WebKit, Firefox and Chromium, and the device page probes iOS. If it is missing on any supported browser the OPFS adapter uses *slot files* and no rename: snapshots go to pre-opened `snap.slot<k>` files starting with an adapter header `key_len u16 | key`; `list`/`read` resolve keys from headers, `delete` frees a slot. Safe for 0005's own reason: recovery trusts only the CRC. The outcome is recorded in M23's Deviations.
- Implemented in: M23.

**5. 0009 server entrypoint: `ready`, `onFatal`, seed text.**
- Says: `createWorldServer(cfg, host): { accept, stop }`; `HostServices` has `wasm, storage, clock, timer, onIdle?`; `WorldConfig.params.seed` is u64 decimal text.
- Why not: loading is asynchronous (0005) and a synchronous return has nowhere to report `WorldLoadError`; a server host has no way to learn of 0005's `onFatal`; the instance config carries u64 as `"0x…"` strings (`HexU64`, M02).
- Amendment: `createWorldServer(cfg, host): { ready: Promise<void>; accept(c: Connection): void; stop(): Promise<void> }`. `ready` rejects with `WorldLoadError`; connections accepted before `ready` wait. `HostServices` gains `onFatal?: (f: { tick: number; message: string }) => void`, fed from `SimHost.onFatal`; after it fires the server stops ticking, closes sockets, touches no file, and adds no protocol. `WorldConfig.params.seed` stays decimal text; `createSimHost` converts it once to `HexU64` where `WorldConfig` becomes the instance config, and Rust never sees decimal.
- Implemented in: M13 (seed conversion), M24 (`SimHost.onFatal`), M27 (`ready`, `HostServices.onFatal`), M37 (server path test). M27 and M37 cite this section instead of writing an ADR.

**6. 0001 `Presence`: `Default`, and the size limit per sample.**
- Says: `trait Presence: Codec + Copy + 'static`, "fixed size, at most 32 bytes encoded".
- Why not: the engine must construct the value it hands to `ClientSide::frame` before the game has written one, and there is no constructor. Postcard varints make the encoded size depend on the value, so it is neither fixed nor checkable at init.
- Amendment: `trait Presence: Codec + Copy + Default + 'static` (`()` qualifies). The 32-byte limit applies to each encoded sample: an oversize sample is dropped and counted in `presence_oversize`, which must read 0 in tests.
- Implemented in: M19.

**7. 0003 game trait and client side: anchor, wake on put, UI intent, `ui` re-run.**
- (a) Says: `prototype(e) -> PrototypeId` lets the engine derive "occupancy and delta scope". Why not: a prototype has a footprint but no position. Amendment: required hook `fn anchor(e: &Self::Entity) -> TilePos` on `Game`, the min-corner tile of the footprint. M12 declares it, M12b routes scope by it, M21 adds occupancy.
- (b) Says: `apply` sees only `WorldWrite`; timers belong to `TickCx` (0007 §7). Why not: an action could never start a timer. Amendment: every `spawn`/`put_entity` made through `Authority` outside `G::tick` (`apply`, `on_player`, `genesis`, `migrate`) queues the id, deduplicated in insertion order, for `TickCx::next_woken()` of the same tick's `G::tick`; puts through `TickCx` do not. The queue is sim state (snapshot, hash). No new `WorldWrite` method; `Predicting` ignores it. M21b.
- (c) Says: nothing; there is no TypeScript → `ClientSide` channel, so Rust cannot learn "construction mode on" or "panel closed". Amendment: `client.input.emit(code: number, a = 0, b = 0): boolean` writes one input-ring record (0019 §4, M11's 32-byte layout) of kind `7 game`: `code u32` in the `pick_id` field, `a`, `b` as `i32` in the `tile` field, `seq` and `time_ms` as usual, all else zero. It surfaces in `FrameCx::input()` in ring order, is not delivered to `client.input.on`, is never dropped by `InputQueue` overflow, and `emit` returns `false` if the ring is full. Codes are the game's. `FrameCx` still has no `dispatch`. M18 (record kind, `input()`), first used by M33.
- (d) Says: `ui` is called "when the replica or overlay changes". Why not: `Ui` may depend on client-side state (the presence spring, selection, modes). Amendment: `FrameCx::ui_dirty()`; the engine calls `ClientSide::ui` in a frame iff the replica changed, the overlay changed, or `frame` called `ui_dirty()`. The `PartialEq` gate is unchanged, so an idle UI still costs nothing. M16b owns the policy, M18 lands `ui_dirty`, M20b is the first user.

**8. Wire and session gaps.**
- 0011 `Delta` has no variant for the engine roster it places in `Global` scope. Amendment: sixth, engine-only variant `Delta::Roster { who: PlayerId, online: bool }`, so `Store::apply` stays the only mutator; the roster changes only through logged connection events. M12 (wire: `Global` section, M14).
- 0004/0012 define `Confirmed | Rejected` only. After a reconnect the host keeps no per-session state (0013) and cannot replay a lost ack. Amendment: third result `Lost`, raised client-side only (never on the wire) for a pending action with `seq <= Welcome.last_processed_action_seq` whose ack never arrived: processed by the host, outcome unknown, state already correct through the resync. M28b.
- 0005/0013 say clients "see `Resyncing`" on an open connection but name no message. Amendment: a second `Welcome` on an established connection is the resync signal (new epoch; client drops predicted and interpolated state, resends pending actions above `last_processed_action_seq`). No new message type. M28b.
- 0013 has `Global` and `Player` hashes but no recovery for a mismatch. Amendment: `ResyncChunk` with the reserved coordinate `(i32::MIN, i32::MIN)`; the host resends both scopes in the next frame. M31b.
- 0013's `Hello`/`Reject` start with a frozen `magic u32`; every other message starts with a type byte (`0x01..=0x7F`, M14). Amendment: the magic's first byte on the wire is `>= 0x80`. M14 (constraint), M28 (value).

**9. `CHUNK_BITS`: runtime dims; the browser topology supports 5 only.**
- Says: 0003 makes `CHUNK_BITS` (4, 5 or 6) an associated const of `Game`; 0007 writes `[Tile; N*N]`; 0007 §4, 0008, 0014 §4, 0015 §1 and 0018 §3 state 32 × 32 chunks, 4,096-byte slabs and 32 × 32 page slots.
- Why not: stable Rust cannot use `G::CHUNK_BITS` as a const-generic argument or array length in code generic over `G`, and the fixed SAB and GPU sizes are created before any instance exists.
- Amendment: the world model takes a runtime `ChunkDims::new(G::CHUNK_BITS)` (edge, area, `slab_bytes`); slabs are `&[Tile]` of `dims.area()`; every Rust copy and region uses `slab_bytes`. The browser topology (gen-result slots, upload records, page texture) supports `CHUNK_BITS = 5` only and asserts it at init with a readable fatal. Sizes 4 and 6 are fixture-tested natively only. Generalising the browser side is a separate ADR, owed by the first game that changes the const.
- Implemented in: M07 (`ChunkDims`, tests at all three sizes), M08b and M09 (the assertion).

**10. 0015 wake word: one per consumer thread.**
- Says: 0015 §2 puts a wake word in each ring's control block, and also says workers block "on their wake word".
- Why not: `Atomics.wait` waits on one address, and the client worker consumes several rings.
- Amendment: one `W_WAKE` per worker in the shared control block. A producer built with a wake target does `Atomics.add` + `Atomics.notify` on it after commit. The consumer loop is `last = load(W_WAKE)`; drain every ring; `wait(W_WAKE, last, timeout)`, which cannot lose a wake-up. Rings keep head, tail and drops only.
- Implemented in: M06.

**11. 0018 DrawList header and sprite table.**
- Says: triple-buffer slots have a 256 B header that also holds "the fields 0019 defines"; 0018 §4 allows 4,096 sprites and binds the visual table as a 16 KiB uniform (the compatibility-mode limit), without saying how the sprite table is bound.
- Why not: 0019 §5's 64-slot anchor table is 64 × 2 × f32 = 512 B alone. A sprite table of 4,096 × 32 B = 128 KiB cannot be a uniform.
- Amendment: the slot header is **1,024 B** (layout in M17; anchors at `128..640`). The sprite table is a pair of 64 × 64 `rgba32float` data textures read with `textureLoad` (rect; pivot + size): one bind group, no storage buffers, loadable in compatibility mode.
- Implemented in: M06 (slot size), M17 (header), M17b (sprite textures).

**12. 0016: both CDP transports; budgets are per page.**
- Says: §3 step 2 drives workers through the deprecated `Target.sendMessageToTarget`, with the harness's own flattened CDP WebSocket as the fallback if Chrome removes it; §1 gives the main thread 110 B/frame.
- Why not: a fallback written under a red suite is late; and 110 B is the WebGPU wrapper floor, so on a page without WebGPU it would let the one-object negative control pass.
- Amendment: M04 builds both transports behind `IsolateSession { name, send(method, params) }`; `tunnel` is the default, and `gc: flat transport parity` requires identical worker byte totals through `flat`. Byte budgets are per page: `budgets.json` `gc.pages.<page>.isolates.<name>.bytesPerFrame` with a `formula` string. 0016 §1's numbers are the formula for a one-pass WebGPU page; a page without WebGPU uses measured harness overhead + the 8 B margin.
- Implemented in: M04 (transports, `gc-loop`), M09 (first WebGPU row), M17 (final main-thread number).

**13. 0017 §6 profiles: what `"*"` covers, and `panic = "abort"`.**
- Says: `[profile.dev.package."*"] opt-level = 3  # the engine and other deps stay fast in dev`; `panic = "abort"` appears only under `[profile.release]`, while 0014 §6 says "builds use `panic = "abort"`".
- Why not: `"*"` matches non-member dependencies only. That is true for an external game (the engine is a path dependency) but not in this repo, where the `engine` crate is a workspace member and builds at dev `opt-level = 1`. And the fast tier runs dev-profile modules.
- Amendment: the repo keeps the profiles verbatim; the engine at `opt-level = 1` in this workspace is intended (engine edits are the hot loop), and a `[profile.dev.package.engine]` override is added only if a fast-tier test is demoted for CPU time. 0014 §6 holds for every `.wasm` because `wasm32-unknown-unknown` aborts on panic by target default; `[profile.dev]` must **not** set `panic = "abort"`, since native tests unwind.
- Implemented in: M01 (profiles), M02 (test that a dev-profile `.wasm` panic traps).

**14. 0020 §9: the tick benchmark needs a WASM twin.**
- Says: slow-tier wall clock is "native tick-time benchmarks on the standard large save".
- Why not: subscriptions and fan-out live in the TS sim host (0015 §1), and codegen differs, so a native bench cannot see a regression in either.
- Amendment: the native bench (`slow_tick_large_save`) stays the gate against 0010's desktop proxy and the 25 % rule. A record-only twin, `tick-large-save node @slow`, drives the same save as `.wasm` through `createWorldServer` under Node: it has a baseline entry, a regression over 25 % prints a `warn`, it never fails and has no absolute budget.
- Implemented in: M36.

**15. 0010 interpolation delay vs the presence rate (conditional).**
- Says: delay = `max(2 × frame interval, frame interval + p95 jitter)`, floor 100 ms; presence samples travel at ≤ 10 Hz.
- Why it may not stand: presence arrives every 100 ms, twice the 50 ms frame interval the formula is written in, so at the floor the newest bracketing sample is often missing and the buffer extrapolates.
- Amendment: none yet. M30's scenario `extrapolation_ratio` measures `interpExtrapolatedFrames / interpRenderedFrames` at the median network profile. Above **0.2**, M30 records a Deviation and a new ADR supersedes the 0010 row with the presence sample interval as the formula's interval term. At or below 0.2 the row stands. No silent tuning.
- Implemented in: M30.

**16. 0014 wrong-role calls do not trap in debug.**
- Says: 0014 §5, an export called on an instance of the wrong role returns a status "(traps in debug)".
- Why it cannot stand: the fast tier builds every fixture on the dev profile only ([0020](0020-testing-strategy.md)), a trap marks the instance dead, and the loader test for this path must run there and go on using the instance.
- Amendment: a wrong-role call returns `Status::WrongRole` on every profile; there is no debug trap. Callers see it like any other non-zero status from `call0/1/2`; the engine's own hosts never call across roles, which the ABI registry's per-export `role` field lets a test check.
- Implemented in: M02 (`loader: wrong-role export returns WrongRole`).

## Alternatives rejected

- **Rewrite the ADRs in place.** Against the repo rule; and parallel planning sessions were already citing the old text.
- **One ADR per item.** Fifteen files for changes that are mostly one signature each; the index would stop being readable. Items that carried a real design choice got their own ADR ([0022](0022-entity-ids-and-provisional-ids.md), [0023](0023-action-growth-declaration.md)).
- **Leave them in the briefs.** `docs/plan/` is deleted in Phase 4, and a brief may not contradict an accepted ADR.
- §3: **an action-layout fingerprint in the segment header.** Exact, but the engine sees `G::Action` only as opaque `Codec` data and has no derive macro to compute one (0017 §7); a hand-maintained fingerprint is `SCHEMA_VERSION` under another name.
- §7c: **`client.input.setMode`** for UI modes (it turns one-finger drags into tool drags, 0019 §4); **a logged action per menu click** (pollutes the log); **a second ring** (same producer, consumer and rate as input).
- §7d: **calling `ui` every frame** behind the `PartialEq` gate. Simpler, but it puts a `Ui` build (which may allocate in the arena) on every frame of the client worker for the rare game that needs it.
- §9: **a const-generic world model** (needs unstable Rust or a macro per size); **sizing SABs from `game.json`** now (no game needs it).

## Consequences

- Each amended ADR's `Status:` line points here; its body is unchanged, so read 0024 §n next to the cited section.
- Briefs that planned their own ADR for an item above (M27 for §5; M37's `onFatal` link) cite this ADR instead.
- §3 narrows what an upgrade preserves after an unclean stop; the `add-action-type` skill gains "layout change = `SCHEMA_VERSION` bump".
- §9 means a game with `CHUNK_BITS != 5` builds and passes native tests but fails at browser init with a readable message.
- Open after this ADR: §4's probe result (M23), §15's measurement (M30).

## Sources

- The cited ADR sections, and the "Planning decisions" sections of briefs 01, 02, 04, 06, 07, 08, 08b, 09, 12, 12b, 13, 14, 16, 16b, 17, 17b, 18, 19, 20b, 21, 21b, 22, 22b, 23, 24, 24b, 27, 28, 28b, 30, 31b, 33, 36, 37 in `docs/plan/`.
- No external sources were consulted; platform facts used (`Atomics.wait` takes one address, const-generic limits on stable Rust, cargo's `"*"` profile spec, the wasm32 panic default, the 16 KiB compatibility-mode uniform limit) are as stated in the briefs and in 0014–0018.
