# wire (docs/decisions/0011, docs/plan/14-wire-framing.md)

Frame header, sections, chunk-coordinate lists, overlay runs, chunk snapshots, action results,
uplink batch. Every writer is generic over `ByteSink` and allocates nothing; every reader borrows
`&[u8]` and never panics. Single home of the numbers below; link here, don't copy them elsewhere.

**Message type byte** (first byte, either direction): `0x01 Frame · 0x02 UplinkBatch · 0x03
Welcome · 0x04 ResyncChunk · 0x05 Bye`; `0x06..=0x7F` free; `Hello`/`Reject` start with the magic
`u32` (first byte `>= 0x80`, 0024 §8).
**Section ids** (ascending, each once, empty omitted, unknown malformed): `1 ActionResults ·
2 Global · 3 OwnPlayer · 4 ChunkEnterPristine · 5 ChunkSnapshots · 6 ChunkLeaves · 7 ChunkDeltas ·
8 Presence · 9 Hashes · 10 ChunkTiles (reserved, unbuilt) · 11 ChunkKeeps`.
**Frame**: `[type u8][flags u8][tick u32][ack_seq u32]` (10 B, flags always 0); no sections =
heartbeat. **Coord list**: sorted `(cy,cx)`, first entry absolute zigzag pair, rest zigzag deltas.
**Overlay runs**: `n_runs varint`, per run `gap varint`, `head=len<<1|repeat`, then `repeat?1:len`
tiles (`u32` LE); `>=2` equal consecutive tiles -> one repeat run. **Chunk snapshot entry**: coord
(written by `SnapshotWriter`, not `encode_chunk_snapshot`) · `version u32` · overlay runs ·
`n varint` x `(EntityId varint, Codec entity)`. **ChunkDeltas**: tile groups (`n_chunks`, per
chunk coord + `n varint` x `(index-gap varint, tile u32)`), then a flat entity-op list to the
section's end (`op u8`: `0 Put id value`, `1 Gone id`). **ActionResults**: `n varint` x
`(seq varint, tag u8)`: `0 Applied`, `1 Rejected::Game+Codec`, `2 Rejected::Engine+u8`
(`EngineReject`: `RateLimited=0, StateBudgetFull=1, EngineFault=2`); `Ack.tick` = frame tick.
**Global**: `mask u8` (bit0 roster, bit1 value) · roster `n varint` x `(PlayerId varint, online
u8)` · `Codec G::Global`. **OwnPlayer**: `PlayerId varint · Codec G::Player`. **Uplink**: `type ·
flags u8 (bit0 camera, bit1 presence) · last_received_tick u32 · n varint x (seq varint, len
varint, Codec action) · CameraReport (16 B) · presence (len varint + bytes)`. `CameraReport`:
`{center_x/y: i32, half_w/h: u16, vel_x/y: i16}`.

A `FrameWriter::section` body runs twice (measure, then write): build any stateful writer (a
coordinate cursor) *inside* the closure, never capture one by `&mut` from outside it.
