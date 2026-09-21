# M14: Wire framing: frame, sections, uplink batch

Status: not started · After: 12b · Tyler-dependent: no

## Goal
The engine crate encodes and decodes every post-handshake message of 0011 into and out of caller-supplied byte slices with no allocation: the frame header and sections, chunk-coordinate lists, overlay runs, chunk snapshots, action results, and the uplink batch. Golden-bytes tests fix the numbers below; after this milestone they change only by a reviewed golden update.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0011-wire-format-and-deltas.md` (all)
3. `docs/decisions/0010-rates-and-subscriptions.md` ("Rates" row Client → host; "Camera report")
4. `docs/decisions/0009-transport-and-hosting.md` ("Message classes")

Mine from spikes: none (the spike had no byte encoding). Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
Module `wire` in the engine crate. Writers are generic over M05's `ByteSink` (a full `SliceSink` surfaces as `WireError::Full`); readers borrow `&[u8]` through `ByteReader` and never panic on any input.
- Varints are M05's (`ByteSink::put_varint`, `ByteReader::varint`); this milestone adds only `zigzag32`/`unzigzag32` and range checks (`u32` overflow is malformed).
- `MsgType`, `SectionId`, `FrameWriter`/`FrameReader`, `UplinkWriter`/`UplinkReader`, `CameraReport` (16-byte layout of 0010), typed section bodies listed below, `encode_chunk_snapshot(&Store<G>, ChunkCoord, version, &mut impl ByteSink)` (also the canonical form hashed by M31, 0013 "Per-chunk desync hashes").
- Game-typed values go through M05 `codec::encode_to` / `codec::decode` (which already returns the rest of the slice). Writers are generic over `ByteSink`; the usual sink is `SliceSink` over the `Tx` region.

## Non-scope
`Hello`/`Welcome`/`Reject`/`Bye`/`ResyncChunk` bodies (M28, M31b): ids reserved only. Presence and Hashes section **bodies** (M19, M31b), and the `ChunkKeeps` body (M28b): written and read as opaque bytes here. Building frames from a `ChangeLog` (M15). Any TypeScript: no TS code parses frames, ever (0015 net worker row, 0011 Decode path). The log frame format (M22).

## Files, packages and crates touched
`packages/engine/crates/engine` (`wire/`), golden files, `packages/engine/fixtures/puts` (values for goldens).

## Seams
**Provides:** `wire::{MsgType, SectionId, FrameHeader, FrameWriter, FrameReader, SectionWriter, UplinkWriter, UplinkReader, UplinkBatch, CameraReport, ChunkCoordListWriter/Reader, OverlayRunsWriter/Reader, SnapshotWriter/Reader, ActionResultsWriter/Reader, encode_chunk_snapshot, WireError, zigzag32, unzigzag32}`; goldens `wire_*` (M05 `assert_golden_bytes!`).
**Consumes:** M05 `codec::{encode_to, decode}`, `ByteSink`, `SliceSink`, `ByteReader`, `CodecError`, `assert_golden_bytes!`, `pnpm golden:bytes`; M12 `Delta`, `Store`, ids; M12b `Outcome`, `EngineReject`; M07 `Tile`, `ChunkCoord`, overlay iteration. M12b's 7th `Delta` variant, `Ack { who, seq }`, never reaches this module: `Authority::record_ack` applies it straight to `Store`, bypassing the `ChangeLog` a wire frame is built from, so it is never rebroadcast (M12b Deviations) — an exhaustive match over `Delta` in wire code should account for that arm deliberately rather than be surprised by it.

## Planning decisions
Closes PRE-PLAN §10 "Exact section ids, varint coordinate coding, overlay run format".
- **Message type byte** (first byte of every post-handshake message, both directions): `0x01 Frame`, `0x02 UplinkBatch`, `0x03 Welcome`, `0x04 ResyncChunk`, `0x05 Bye`; `0x06..=0x7F` free. Constraint handed to M28: `Hello`/`Reject` start with the frozen `magic u32` (0013), so the magic's first byte on the wire must be ≥ `0x80` (0024 §8).
- **Frame header** as 0011. `flags`: all bits reserved, written 0; a non-zero flag is `WireError::Malformed` (strict build equality makes forward compatibility pointless). A frame with no sections is the heartbeat.
- **Section ids** = order of appearance; ids strictly ascending, each at most once, empty sections omitted, unknown id malformed: `1 ActionResults · 2 Global · 3 OwnPlayer · 4 ChunkEnterPristine · 5 ChunkSnapshots · 6 ChunkLeaves · 7 ChunkDeltas · 8 Presence · 9 Hashes · 10 ChunkTiles` (reserved by 0008 §3, unbuilt) `· 11 ChunkKeeps` (resume "keep" entries, M28).
- **Chunk-coordinate list** (sections 4, 6, 11 and the chunk keys inside 5 and 7): entries sorted by `(cy, cx)`; first entry absolute as two zigzag varints, each later entry as zigzag deltas from the previous one. Sorting makes bytes canonical and deltas small (the ~3 B of 0011 for a first entry near the origin, ~2 B after). Priority decides *which* chunks a frame holds (M31), never their order inside a section.
- **Overlay runs** (inside a snapshot): `n_runs varint`, then per run `gap varint` (indices skipped since the previous run's end), `head varint = len << 1 | repeat`, then `repeat ? one : len` tiles as `u32` LE. Index order is M07's row-major local index. A writer emits `repeat` for ≥ 2 equal consecutive tiles.
- **Chunk snapshot entry:** coord (list coding) · `version u32` LE · overlay runs · `n varint` × (`EntityId varint`, `Codec` entity). Entities = every entity whose scope includes the chunk; duplicates across entries are legal (0011).
- **ChunkDeltas:** tile groups (`n_chunks`, per chunk: coord, `n varint` × (`index-gap varint`, tile `u32`)), then one flat entity-op list in write order (`op u8`: `0 Put id value`, `1 Gone id`). Entities are not grouped by chunk: the value carries its anchor, and one op must not repeat per overlapped chunk. Per-chunk versions are implicit: every chunk named, or overlapped by a named entity, takes the header `tick`.
- **ActionResults:** `n varint` × (`seq varint`, `tag u8`: `0 Applied`, `1 Rejected::Game` + `Codec` reject, `2 Rejected::Engine` + `u8` code in `EngineReject` declaration order). `Ack.tick` is the header tick and is not repeated. `Applied` has no payload (`0022-entity-ids-and-provisional-ids.md` §6).
- **Global:** `mask u8` (bit 0 roster, bit 1 game value) · roster `n varint` × (`PlayerId varint`, `online u8`) · `Codec` `G::Global`. **OwnPlayer:** `PlayerId varint` · `Codec` `G::Player` (the id costs one byte and lets a client learn who it is before M28's `Welcome`).
- **Uplink batch:** `type` · `flags u8` (bit 0 camera, bit 1 presence) · `last_received_tick u32` · `n varint` × (`seq varint`, `len varint`, `Codec` action bytes) · camera report (16 B fixed) · presence (`len varint` + opaque). The action `len` is redundant with `Codec` but lets the host copy the bytes into the log record (M22) without re-encoding.
- **Typed fast path for continuous action streams (PRE-PLAN §10, 0001/0004): decided: not built and not scheduled.** No planned game has such a stream. The seam is kept: uplink flag bits 2–7 are free for a future stream record, and 0004 already states the log format is unaffected. Trigger to revisit: the first game that sends an action every tick; it gets its own ADR.

## Order of work
1. zigzag + errors. 2. header, section framing, ordering rules. 3. coord list, overlay runs. 4. snapshot + `encode_chunk_snapshot`. 5. deltas, results, global, own player. 6. uplink. 7. goldens, then the malformed-input corpus.

## Tests added
Rust native, all in `wire::tests`: `golden_frame_header`, `golden_heartbeat_is_10_bytes`, `golden_section_ids`, `golden_coord_list_negative_and_far` (coords near ±2^18), `golden_overlay_runs_literal_and_repeat`, `golden_chunk_snapshot`, `golden_chunk_deltas`, `golden_action_results_all_tags`, `golden_global_and_own_player`, `golden_uplink_batch`; `roundtrip_random_frames` (seeded, 1,000 frames); `decoder_never_panics` (seeded corpus: truncations, bit flips, oversized varints, descending section ids); `sections_out_of_order_rejected`; `writer_full_is_error_not_panic`; `encode_decode_no_alloc` (counting allocator).

## Exit criteria
- [ ] All goldens are checked in and were produced by `pnpm golden:bytes -- wire`.
- [ ] `golden_coord_list_*` asserts a pristine enter of one chunk adjacent to the previous costs 2 bytes and a lone entry within ±63 chunks of the origin costs 2 bytes plus section overhead.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t wire` · `pnpm lint`.

## Budgets
Bandwidth rows (PRE-PLAN §7) are not measured here, but the fixed costs they assume are asserted: header 10 B, pristine enter ≈ 3 B, camera report 16 B (0010 worked numbers). Zero allocation in encode/decode.

## Context artifacts
`crates/engine/src/wire/CLAUDE.md` (≤ 30 lines): the id tables above move there verbatim as the single home of these numbers; this brief then links to it. Rule reminder: changing a golden is a wire change and therefore a build-hash change, never a compatibility problem.

## Manual device checks
none

## Deviations

**Module layout.** `wire/mod.rs` (`WireError`, `zigzag32`/`unzigzag32`, `varint_u32` (private,
range-checked varint read), `MsgType`, `SectionId`, `FrameHeader`, `SectionWriter`, `FrameWriter`,
`FrameReader`) plus one file per concern: `coordlist.rs`, `overlay_runs.rs`, `snapshot.rs`,
`deltas.rs`, `results.rs`, `global.rs`, `uplink.rs`, each re-exported at `wire::*`. Id tables and
byte layouts live in `crates/engine/src/wire/CLAUDE.md` (30 lines), the single home the brief asks
for; this file does not repeat them.

**Seam shapes as landed** (all `pub` at `engine::wire::`, all in `packages/engine/crates/engine/src/wire/`):
- `WireError { Full, Malformed }`, `impl From<CodecError> for WireError` (`Overflow -> Full`,
  everything else `-> Malformed`).
- `zigzag32(i32) -> u32`, `unzigzag32(u32) -> i32` (both total, no `Result`).
- `MsgType` (`#[repr(u8)]`: `Frame=1, UplinkBatch=2, Welcome=3, ResyncChunk=4, Bye=5`), `SectionId`
  (`#[repr(u8)]`, table in `wire/CLAUDE.md`) with a private `from_u8`.
- `FrameHeader { tick: u32, ack_seq: u32 }` (no `type`/`flags` fields: `FrameWriter::new` writes
  those itself, always `MsgType::Frame`/`0`).
- `SectionWriter::write(sink: &mut impl ByteSink, id: SectionId, body: impl Fn(&mut dyn ByteSink))`
  -- the "measure, then write" trick (`CountSink` then the real sink), matching M05's `write_sized`.
- `FrameWriter<'a, S: ByteSink>::{new(sink: &'a mut S, header: FrameHeader) -> Self, section(&mut
  self, id: SectionId, body: impl Fn(&mut dyn ByteSink))}`; `FrameReader<'a>::{new(buf: &'a [u8]) ->
  Result<Self, WireError>, header() -> FrameHeader, next_section(&mut self) -> Result<Option<
  (SectionId, &'a [u8])>, WireError>}`.
- `ChunkCoordListWriter::{new, write(&mut self, sink: &mut (impl ByteSink + ?Sized), coord:
  ChunkCoord)}`, `ChunkCoordListReader::{new, read(&mut self, r: &mut ByteReader) ->
  Result<ChunkCoord, WireError>}`.
- `OverlayRunsWriter::write(sink: &mut (impl ByteSink + ?Sized), entries: impl Iterator<Item =
  (u16, Tile)> + Clone)`; `OverlayRunsReader::read(r: &mut ByteReader, on_tile: impl FnMut(u16,
  Tile)) -> Result<(), WireError>`.
- `encode_chunk_snapshot<G: Game>(store: &Store<G>, chunk: ChunkCoord, version: u32, sink: &mut
  (impl ByteSink + ?Sized))` -- **writes only `version`/overlay-runs/entities, not `chunk` itself**
  (see "Chunk snapshot coordinate" below). `SnapshotWriter::{new, write_chunk<G: Game>(&mut self,
  sink, store: &Store<G>, chunk: ChunkCoord, version: u32)}` (writes the coord via its own
  `ChunkCoordListWriter`, then calls `encode_chunk_snapshot`). `SnapshotReader::{new,
  read_chunk<G: Game>(&mut self, r, on_tile: impl FnMut(u16, Tile), on_entity: impl FnMut(EntityId,
  G::Entity)) -> Result<(ChunkCoord, u32), WireError>}`.
- `write_chunk_deltas<G: Game>(sink, tile_groups: &[(ChunkCoord, &[(u16, Tile)])], entity_ops:
  &[EntityOp<'_, G>])`; `read_chunk_deltas<G: Game>(r, on_tile: impl FnMut(ChunkCoord, u16, Tile),
  on_entity_op: impl FnMut(EntityDeltaOp<G>)) -> Result<(), WireError>`; `EntityOp<'a, G>{ Put{id,
  entity: &'a G::Entity}, Gone{id} }`, `EntityDeltaOp<G>{ Put(EntityId, G::Entity), Gone(EntityId) }`
  (borrowed on write, owned on read -- `codec::decode` produces an owned value). No dedicated
  `ChunkDeltasWriter`/`Reader` type: the brief's Provides list names none, and M15's `ChangeLog` is
  a plain ordered list, so a free function over slices is the natural shape.
- `ActionResultsWriter::write<'a, G: Game>(sink, results: impl Iterator<Item = &'a
  sim::Outcome<G>> + Clone)`; `ActionResultsReader::read<G: Game>(r, on_result: impl FnMut(u32,
  Result<sim::Applied, sim::Rejected<G>>)) -> Result<(), WireError>`. `EngineReject` wire codes are
  its declaration order: `RateLimited=0, StateBudgetFull=1, EngineFault=2`.
- `write_global<G: Game>(sink, roster: Option<impl Iterator<Item = (PlayerId, bool)> + Clone>,
  global: Option<&G::Global>)`; `read_global<G: Game>(r, on_roster: impl FnMut(PlayerId, bool)) ->
  Result<Option<G::Global>, WireError>`; `write_own_player<G: Game>(sink, who: PlayerId, state:
  &G::Player)`; `read_own_player<G: Game>(r) -> Result<(PlayerId, G::Player), WireError>`. No
  dedicated writer/reader struct for either (Provides names none; each is one shot, no per-entry
  cursor).
- `CameraReport { center_x/center_y: i32, half_w/half_h: u16, vel_x/vel_y: i16 }` (`LEN = 16`,
  `write`/`read`); `UplinkBatch<'a> { last_received_tick: u32, camera: Option<CameraReport>,
  presence: Option<&'a [u8]> }`; `UplinkWriter::write<'a>(sink, last_received_tick: u32, actions:
  impl Iterator<Item = (u32, &'a [u8])> + Clone, camera: Option<CameraReport>, presence:
  Option<&[u8]>)`; `UplinkReader::read<'a>(buf: &'a [u8], on_action: impl FnMut(u32, &'a [u8])) ->
  Result<UplinkBatch<'a>, WireError>` -- actions are handed back as raw `(seq, bytes)`, never
  decoded into `G::Action`, so `UplinkReader` needs no `G` type parameter at all.

**`?Sized` widened through the write path.** Every writer function's sink parameter is `&mut (impl
ByteSink + ?Sized)`, not the brief's implied `&mut impl ByteSink`: a `FrameWriter::section` body
closure receives `&mut dyn ByteSink` (so it can be invoked twice with the same trait object), and
every section body (`ActionResultsWriter::write`, `write_global`, `write_own_player`,
`ChunkCoordListWriter::write`, `SnapshotWriter::write_chunk`, `write_chunk_deltas`,
`OverlayRunsWriter::write`) is called from inside one. M05's own `codec::encode_to`/
`encode_to_with` needed the same widening (additive, non-breaking -- every existing caller still
compiles unchanged since `S: ByteSink` still satisfies `S: ByteSink + ?Sized`).

**Chunk snapshot coordinate is not written by `encode_chunk_snapshot`.** The brief's Planning
decisions describes one "chunk snapshot entry" of `coord (list coding) · version · overlay runs ·
entities`, and gives `encode_chunk_snapshot(&Store<G>, ChunkCoord, version, &mut impl ByteSink)` as
the function that builds it -- but that same function is also named as "the canonical form hashed
by M31" (0013 "Per-chunk desync hashes"), which must be self-contained bytes for *one* chunk,
independent of any other chunk's position (a delta-coded coordinate chained from a neighbour would
make the hash depend on unrelated data). Resolution: `encode_chunk_snapshot` writes only the
content (version, overlay runs, entities); `SnapshotWriter`, the section-level type, writes the
coordinate itself via its own `ChunkCoordListWriter` (chained across the section's several chunks,
matching Planning decisions faithfully at the section level) and then calls
`encode_chunk_snapshot` for the rest. M31 hashes `encode_chunk_snapshot`'s bytes directly, keyed by
a chunk coordinate it already knows from elsewhere (the `Hashes` section, Non-scope here).

**Entities in a chunk snapshot = entities anchored to that chunk (anchor-chunk equality, not full
footprint overlap).** 0011 says "every entity whose scope includes the chunk", but `Authority`'s
own scope derivation (M12b) is anchor-chunk-only until M21 widens it to the full footprint
(`authority::Scopes` doc comment) -- so as of this milestone, "scope includes chunk C" and "anchor
chunk is C" are the same set. This keeps a snapshot's entity list consistent with exactly what live
deltas deliver for that chunk today; M21 will need to revisit both together. Implemented via an
additive accessor, `Store::entities(&self) -> impl Iterator<Item = (EntityId, &G::Entity)> + '_`
(ascending id order), filtered by `chunk_of::<G>(G::anchor(e)) == chunk` -- nothing needed to
enumerate every entity before this milestone. Also additive: `ChunkOverlay::entries()`'s returned
`impl Iterator` now also bears `+ Clone` (already true of the concrete type, a non-capturing `.map`
over a `slice::Iter`; just not previously exposed) so `OverlayRunsWriter::write`'s two-pass
count-then-write can walk it twice without buffering.

**Overlay-run grouping.** The writer (`overlay_runs::RunCursor`) uses a 2-item-lookahead cursor
(`peek`/`bump`/cheap `fork` -- a slice iterator under a non-capturing `.map` clones for free) to
group a maximal run of `>= 2` equal consecutive tiles into one `repeat` run and everything else
into the longest `literal` run that does not swallow the start of a following repeat, without
buffering an unbounded chunk's worth of tiles on the stack. The reader supports any literal length
the format allows; nothing requires the writer to prefer larger literal runs over more of them, only
that repeats are used where possible (`golden_overlay_runs_literal_and_repeat` proves this by byte-
count comparison: a 4-long repeat run costs strictly less than 4 spaced-out length-1 literal runs
would).

**`ChunkTiles` (10) is a valid, round-tripping id with no interpreted body**, per Non-scope
("reserved by 0008 §3, unbuilt"); `decoder_never_panics`'s corpus never emits it, and any code path
that reaches it is a no-op.

**Test placement: `encode_decode_no_alloc` is its own binary, `tests/no_alloc_wire.rs`,** not
inline in `wire::tests` as the brief's Tests-added list literally says. Same reasoning as
`no_alloc_terrain.rs`/`no_alloc_store.rs`/`no_alloc_authority.rs`/`no_alloc_gen_queue.rs`
(`packages/engine/crates/engine/CLAUDE.md`): a `#[global_allocator]` only counts allocations made
in the binary that installs it, and every other no-alloc test in this crate already follows this
convention. Verified it can fail: temporarily inserted `let _leak: Vec<u8> =
Vec::with_capacity(64); std::mem::forget(_leak);` at the top of `FrameWriter::new`, which failed
the test (`assertion left == right failed: wire encode allocated`, `left: 47867  right: 47803` --
the leaked 64-byte `Vec`'s allocator overhead), then reverted it and reran to green (`test
encode_decode_no_alloc ... ok`).

**Anti-vacuity, per the three named tests:**
- `encode_decode_no_alloc`: fails if `abi::arena::live_bytes()` changes across the measured encode
  or decode call. Shown above to fail when an allocation is injected, and to pass once reverted.
- `decoder_never_panics`: fails if `reached_sections <= CASES / 4` (a healthy fraction of the 2,000
  mutated cases must get at least one section body back from `FrameReader`, not be rejected at byte
  0 every time) or if `malformed_count == 0` (the mutators must actually produce malformed input at
  least once). Both assertions are exercised by the real corpus and pass; deleting either mutator
  branch or replacing the corpus with all-zero bytes would fail the first, and feeding it only
  well-formed frames would fail the second.
- `roundtrip_random_frames`: fails if any of the 9 built `SectionId`s (1-9) never appears across
  1,000 generated frames, or if any of five two-sided coverage flags (`overlay_empty`/`nonempty`,
  `snapshot_entities_zero`/`nonzero`, `global_roster_only`/`value_only`/`both`,
  `deltas_with_groups`/`ops_only`, `action_results_applied`/`game_reject`/`engine_reject`) never
  sees both its sides. Caught a real generator bug during development: `ChunkSnapshots` originally
  always picked a fixed chunk prefix that happened to always contain entities, so
  `snapshot_entities_zero_seen` never fired; fixed by picking distinct random chunk indices from
  the full set instead of a prefix.
- Every other new test's failure mode is stated in its own doc comment or is a direct round-trip/
  golden-byte equality check (fails on any byte or field mismatch).

**Measured.** `pnpm test`: `rust` 191 -> 235 (+44: 43 inline `wire::` tests, 1 `no_alloc_wire`
binary test); `unit` 154, `wasm` 40, `browser` 95 (all unchanged -- Rust-only milestone). `pnpm
test rust -t wire` -> `43 tests`. `pnpm lint` green (biome, rustfmt, clippy, tsc) after two fixes:
two `collapsible_if` lets-chains in `overlay_runs.rs`, one `useless_vec` (a fixed test literal
changed from `vec![..]` to an array) in `global.rs`. Ten new goldens, byte counts (`pnpm
golden:bytes -- wire`, verified via `git status` that no pre-existing golden changed):
`wire_frame_header.hex` 10 B, `wire_section_ids.hex` 17 B, `wire_coord_list_negative_and_far.hex`
12 B, `wire_overlay_runs_literal_and_repeat.hex` 23 B, `wire_chunk_snapshot.hex` 20 B,
`wire_chunk_deltas.hex` 27 B, `wire_action_results_all_tags.hex` 9 B, `wire_global.hex` 7 B,
`wire_own_player.hex` 2 B, `wire_uplink_batch.hex` 28 B. Commits `09dc7ed`..`4df8c45` (eight: seven
`M14 step N` plus one `M14:` clippy-fix commit).
