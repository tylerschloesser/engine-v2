//! `ClientCore<G>` (docs/plan/15-connection-and-subscriptions.md Scope): applies a host frame into
//! a [`Replica`] atomically, serves read access, and paces the uplink (0010 "Rates"). ABI exports,
//! rings and the TS `Connection` are 15b's (Non-scope here): this is the native core `15b` will
//! drive from a ring buffer.
//!
//! **`on_frame` validates before it mutates** (0011: "applies every section" atomically) by
//! decoding the frame *twice*: once with no-op callbacks purely to prove every section well-formed
//! (any [`WireError`] there leaves `self` untouched), once for real once that has succeeded. The
//! second pass re-decodes bytes already proven well-formed, so it cannot itself fail -- this is the
//! same "measure, then write" shape `wire::SectionWriter` already uses on the encode side, turned
//! around for decoding, and it means neither pass needs a staging buffer.

use crate::game::Game;
use crate::time::Tick;
use crate::wire::{CameraReport, FrameReader};
use crate::wire::{
    ChunkCoordListReader, SectionId, SnapshotReader, UplinkWriter, WireError, read_chunk_deltas,
    read_global, read_own_player,
};
use crate::world::Tile;
use crate::{bytes::ByteReader, bytes::SliceSink, wire::EntityDeltaOp};

use super::replica::Replica;

/// One applied frame's header plus counts (Provides: "`FrameSummary` (`tick`, `ack_seq`,
/// counts)"). Not every wire section has a counter: `ActionResults`/`Presence`/`Hashes` are
/// Non-scope this milestone (Non-scope: "Actions and acks (M16) ... Presence relay (M19) ...
/// desync `Hashes` ... M31b").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameSummary {
    pub tick: Tick,
    pub ack_seq: u32,
    pub chunk_enters_pristine: u32,
    pub chunk_snapshots: u32,
    pub chunk_leaves: u32,
    pub tile_deltas: u32,
    pub entity_ops: u32,
}

const MIN_UPLINK_INTERVAL_MS: u32 = 50; // 0010: at most one batch per 50ms
const KEEPALIVE_INTERVAL_MS: u32 = 1000; // 0010: at least one batch per 1s

pub struct ClientCore<G: Game> {
    replica: Replica<G>,
    camera: Option<CameraReport>,
    camera_pending: bool,
    last_batch_ms: Option<u32>,
    last_received_tick: u32,
    /// Reused scratch for a `ChunkSnapshots` entry's overlay tiles (cleared per chunk, never
    /// reallocated once its capacity settles -- `.claude/rules/hot-paths.md`'s steady-state
    /// convention, though `ChunkSnapshots` itself is rare outside a join burst).
    scratch_tiles: Vec<(u16, Tile)>,
    /// Reused scratch for one `ChunkDeltas` section's entity ops (cleared per section): see the
    /// comment where it is used.
    scratch_entity_ops: Vec<EntityDeltaOp<G>>,
    last_summary: FrameSummary,
}

impl<G: Game> ClientCore<G> {
    pub fn new(replica: Replica<G>) -> Self {
        ClientCore {
            replica,
            camera: None,
            camera_pending: false,
            last_batch_ms: None,
            last_received_tick: 0,
            scratch_tiles: Vec::new(),
            scratch_entity_ops: Vec::new(),
            last_summary: FrameSummary::default(),
        }
    }

    /// The last frame's summary applied by [`Self::on_frame`] (test/diagnostic convenience).
    pub fn last_summary(&self) -> &FrameSummary {
        &self.last_summary
    }

    pub fn replica(&self) -> &Replica<G> {
        &self.replica
    }

    /// Mutable counterpart of [`Self::replica`] (docs/plan/15b-ring-connection-and-replica-
    /// rendering.md): `game_instance.rs`'s `ClientInstance` reaches `Replica::terrain`/`terrain_mut`
    /// through this for `TerrainFeed`/`Uploader`, which take `&TerrainStore`/`&mut TerrainStore`
    /// directly rather than a `ClientCore`.
    pub(crate) fn replica_mut(&mut self) -> &mut Replica<G> {
        &mut self.replica
    }

    /// The read-only view a renderer/UI would use (0003 "Contexts"): `Replica<G>` implements
    /// `WorldRead<G>` directly.
    pub fn view(&self) -> &Replica<G> {
        &self.replica
    }

    pub fn drain_dirty(&mut self, f: impl FnMut(crate::world::ChunkCoord)) {
        self.replica.drain_dirty(f);
    }

    pub fn region_hash(&self) -> u64 {
        self.replica.region_hash()
    }

    /// Records the latest camera state (0010 "Camera report"). Queues an uplink send only when it
    /// differs from the last one queued/sent -- "sent when the tile-quantized rectangle or
    /// velocity changes, with a leading-edge send when motion starts and a trailing send at rest".
    pub fn set_camera(&mut self, report: CameraReport, _t_ms: u32) {
        if self.camera != Some(report) {
            self.camera = Some(report);
            self.camera_pending = true;
        }
    }

    /// Writes at most one `UplinkBatch` into `out`, returning its length, or `0` if nothing is due
    /// yet (0010 "Rates": at most one batch per 50 ms; at least one batch per 1 s; the camera half
    /// is included only on change, so a keepalive-only batch omits it). Actions are Non-scope here
    /// (M16): always empty.
    pub fn poll_uplink(&mut self, t_ms: u32, out: &mut [u8]) -> usize {
        if let Some(last) = self.last_batch_ms {
            let elapsed = t_ms.wrapping_sub(last);
            if elapsed < MIN_UPLINK_INTERVAL_MS {
                return 0;
            }
            if !self.camera_pending && elapsed < KEEPALIVE_INTERVAL_MS {
                return 0;
            }
        }
        let camera = self.camera_pending.then_some(self.camera).flatten();
        let mut sink = SliceSink::new(out);
        UplinkWriter::write(
            &mut sink,
            self.last_received_tick,
            core::iter::empty(),
            camera,
            None,
        );
        let Ok(n) = sink.finish() else { return 0 };
        self.last_batch_ms = Some(t_ms);
        self.camera_pending = false;
        n
    }

    /// Validates then applies one frame (0011 "atomically"). `Err` leaves the replica untouched.
    pub fn on_frame(&mut self, bytes: &[u8]) -> Result<FrameSummary, WireError> {
        Self::validate(bytes)?;
        let summary = self.apply(bytes);
        self.last_summary = summary;
        Ok(summary)
    }

    fn validate(bytes: &[u8]) -> Result<(), WireError> {
        let mut r = FrameReader::new(bytes)?;
        while let Some((id, body)) = r.next_section()? {
            let mut br = ByteReader::new(body);
            match id {
                SectionId::Global => {
                    read_global::<G>(&mut br, |_, _| {})?;
                }
                SectionId::OwnPlayer => {
                    read_own_player::<G>(&mut br)?;
                }
                SectionId::ChunkEnterPristine | SectionId::ChunkLeaves | SectionId::ChunkKeeps => {
                    let mut cr = ChunkCoordListReader::new();
                    while !br.rest().is_empty() {
                        cr.read(&mut br)?;
                    }
                }
                SectionId::ChunkSnapshots => {
                    let mut sr = SnapshotReader::new();
                    while !br.rest().is_empty() {
                        sr.read_chunk::<G>(&mut br, |_, _| {}, |_, _| {})?;
                    }
                }
                SectionId::ChunkDeltas => {
                    read_chunk_deltas::<G>(&mut br, |_, _, _| {}, |_| {})?;
                }
                SectionId::ActionResults
                | SectionId::Presence
                | SectionId::Hashes
                | SectionId::ChunkTiles => {} // Non-scope bodies (opaque here)
            }
        }
        Ok(())
    }

    /// Bytes already proven well-formed by [`Self::validate`]: every `.expect("validated")` below
    /// re-decodes the identical bytes and cannot fail.
    fn apply(&mut self, bytes: &[u8]) -> FrameSummary {
        let mut r = FrameReader::new(bytes).expect("validated");
        let header = r.header();
        self.replica.set_tick(Tick(header.tick));
        self.last_received_tick = header.tick;
        let mut summary = FrameSummary {
            tick: Tick(header.tick),
            ack_seq: header.ack_seq,
            ..Default::default()
        };

        while let Some((id, body)) = r.next_section().expect("validated") {
            let mut br = ByteReader::new(body);
            match id {
                SectionId::Global => {
                    let replica = &mut self.replica;
                    let value = read_global::<G>(&mut br, |who, online| {
                        replica.apply_roster(who, online);
                    })
                    .expect("validated");
                    if let Some(g) = value {
                        self.replica.apply_global(g);
                    }
                }
                SectionId::OwnPlayer => {
                    let (who, state) = read_own_player::<G>(&mut br).expect("validated");
                    self.replica.apply_own_player(who, state);
                }
                SectionId::ChunkEnterPristine => {
                    let mut cr = ChunkCoordListReader::new();
                    while !br.rest().is_empty() {
                        let c = cr.read(&mut br).expect("validated");
                        self.replica.apply_enter_pristine(c);
                        summary.chunk_enters_pristine += 1;
                    }
                }
                SectionId::ChunkSnapshots => {
                    let mut sr = SnapshotReader::new();
                    while !br.rest().is_empty() {
                        self.scratch_tiles.clear();
                        let ClientCore {
                            replica,
                            scratch_tiles,
                            ..
                        } = self;
                        let (chunk, version) = sr
                            .read_chunk::<G>(
                                &mut br,
                                |i, t| scratch_tiles.push((i, t)),
                                |id, e| replica.apply_snapshot_entity(id, e),
                            )
                            .expect("validated");
                        self.replica
                            .apply_snapshot_overlay(chunk, version, &self.scratch_tiles);
                        summary.chunk_snapshots += 1;
                    }
                }
                SectionId::ChunkLeaves => {
                    let mut cr = ChunkCoordListReader::new();
                    while !br.rest().is_empty() {
                        let c = cr.read(&mut br).expect("validated");
                        self.replica.apply_leave(c);
                        summary.chunk_leaves += 1;
                    }
                }
                SectionId::ChunkDeltas => {
                    // Two `FnMut` closures cannot both borrow `self.replica` at once, so entity
                    // ops are staged into a reused scratch buffer during the single decode pass
                    // and applied in a second, tiny pass right after (module doc comment: this is
                    // still one decode of the bytes, only the *application* of the entity half is
                    // deferred by one step).
                    self.scratch_entity_ops.clear();
                    let ClientCore {
                        replica,
                        scratch_entity_ops,
                        ..
                    } = self;
                    let mut n_tiles = 0u32;
                    read_chunk_deltas::<G>(
                        &mut br,
                        |chunk, index, tile| {
                            replica.apply_tile_delta(chunk, index, tile);
                            n_tiles += 1;
                        },
                        |op| scratch_entity_ops.push(op),
                    )
                    .expect("validated");
                    summary.tile_deltas += n_tiles;
                    summary.entity_ops += self.scratch_entity_ops.len() as u32;
                    for op in self.scratch_entity_ops.drain(..) {
                        match op {
                            EntityDeltaOp::Put(id, e) => self.replica.apply_entity_put(id, e),
                            EntityDeltaOp::Gone(id) => self.replica.apply_entity_gone(id),
                        }
                    }
                }
                SectionId::ActionResults
                | SectionId::Presence
                | SectionId::Hashes
                | SectionId::ChunkTiles
                | SectionId::ChunkKeeps => {} // Non-scope bodies
            }
        }
        summary
    }
}
