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
**Consumes:** M05 `codec::{encode_to, decode}`, `ByteSink`, `SliceSink`, `ByteReader`, `CodecError`, `assert_golden_bytes!`, `pnpm golden:bytes`; M12 `Delta`, `Store`, ids; M12b `Outcome`, `EngineReject`; M07 `Tile`, `ChunkCoord`, overlay iteration.

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
(filled in during Phase 3)
