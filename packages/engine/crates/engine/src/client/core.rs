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
use crate::sim::{Applied, Rejected};
use crate::time::Tick;
use crate::wire::{
    ActionResultsReader, ChunkCoordListReader, SectionId, SnapshotReader, UplinkWriter, WireError,
    read_chunk_deltas, read_global, read_own_player,
};
use crate::wire::{CameraReport, FrameReader};
use crate::world::Tile;
use crate::{bytes::ByteReader, bytes::SliceSink, wire::EntityDeltaOp};

use super::replica::Replica;

/// The 0012 pending-queue figure ("The pending queue has fixed capacity (initially 32)"), reused
/// here as the action outbox's own capacity (docs/plan/16-action-round-trip.md Scope: "fixed
/// outbox (capacity = the 0012 pending-queue figure; M25 turns it into the pending queue)"): M25
/// is what actually turns this into the prediction pending queue, so the number is shared now
/// rather than picked twice.
pub const OUTBOX_CAPACITY: usize = 32;

/// One action's own `Codec` (postcard) encoding must fit this many bytes (generous headroom for
/// this milestone's own actions; a game that needs more is a later milestone's budget decision,
/// not this one's).
const MAX_ACTION_ENCODED_BYTES: usize = 512;

/// [`ClientCore::on_action`]'s failure modes (docs/plan/16-action-round-trip.md Scope).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActionError {
    /// The ring record itself is malformed: too short for its own `[seq][len]` header, `len`
    /// reaches past the record's own end, the JSON is not valid UTF-8, or it does not parse as
    /// `G::Action`.
    Malformed,
    /// The outbox already holds [`OUTBOX_CAPACITY`] actions (0012: "when full, dispatch fails
    /// locally"). Main-thread `dispatch` is expected to prevent this by construction (counting
    /// `seq - ack_seq` against the same capacity before ever calling this), so reaching it here
    /// is a defence-in-depth backstop, not the primary enforcement point.
    Full,
}

/// One applied frame's header plus counts (Provides: "`FrameSummary` (`tick`, `ack_seq`,
/// counts)"). Not every wire section has a counter here: `ActionResults` is decoded for real now
/// (docs/plan/16-action-round-trip.md), but the results themselves travel through
/// [`ClientCore::drain_results`], not a count on `FrameSummary` -- `Presence`/`Hashes` stay
/// Non-scope (Presence relay: M19; desync `Hashes`: M31b).
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
    /// Actions dispatched locally, `Codec`-encoded (postcard) and awaiting the next
    /// [`Self::poll_uplink`] (docs/plan/16-action-round-trip.md Scope): `(seq, encoded_bytes)`,
    /// oldest first. Bounded at [`OUTBOX_CAPACITY`]; [`Self::on_action`] is human-rate/UI-driven
    /// (0003, 0016 §2's own exemption), so allocating one `Vec<u8>` per queued action here is not
    /// a zero-allocation-rule violation the way it would be on a per-frame path.
    outbox: Vec<(u32, Vec<u8>)>,
    /// `ActionResults` entries decoded from the most recently applied frame, drained by the
    /// caller (`game_instance::ClientInstance`, which turns each into a UI-ring record) via
    /// [`Self::drain_results`]. Cleared at the top of every [`Self::apply`] (Scope: "`on_frame`
    /// reads `ActionResults`").
    results: Vec<(u32, Result<Applied, Rejected<G>>)>,
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
            outbox: Vec::new(),
            results: Vec::new(),
        }
    }

    /// Decodes one action-ring record (`[seq u32 LE][len u32 LE][UTF-8 JSON]`, Scope) into
    /// `G::Action` (`serde_json`, 0003: "the client-role WASM parses it ... and emits the postcard
    /// bytes used on the wire"), re-encodes it with `Codec` and queues it in the outbox for the
    /// next [`Self::poll_uplink`]. Human-rate, UI-driven: allocation here is exempt from the
    /// zero-allocation rule that governs every method below it.
    pub fn on_action(&mut self, bytes: &[u8]) -> Result<(), ActionError> {
        if self.outbox.len() >= OUTBOX_CAPACITY {
            return Err(ActionError::Full);
        }
        if bytes.len() < 8 {
            return Err(ActionError::Malformed);
        }
        let seq = u32::from_le_bytes(bytes[0..4].try_into().expect("checked length"));
        let json_len = u32::from_le_bytes(bytes[4..8].try_into().expect("checked length")) as usize;
        let json_bytes = bytes.get(8..8 + json_len).ok_or(ActionError::Malformed)?;
        let json_str = core::str::from_utf8(json_bytes).map_err(|_| ActionError::Malformed)?;
        let action: G::Action =
            serde_json::from_str(json_str).map_err(|_| ActionError::Malformed)?;
        let mut buf = [0u8; MAX_ACTION_ENCODED_BYTES];
        let n = crate::codec::encode(&action, &mut buf).map_err(|_| ActionError::Malformed)?;
        self.outbox.push((seq, buf[..n].to_vec()));
        Ok(())
    }

    /// Every `ActionResults` entry the most recently applied frame carried, oldest first, handed
    /// to `f` and cleared (docs/plan/16-action-round-trip.md Scope: "on_frame reads ActionResults
    /// and writes one result record per entry to `RegionId::Ui`" -- this is the native half of
    /// that; the caller turns each entry into JSON and a UI-ring record).
    pub fn drain_results(&mut self, mut f: impl FnMut(u32, &Result<Applied, Rejected<G>>)) {
        for (seq, result) in self.results.drain(..) {
            f(seq, &result);
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
    /// is included only on change, so a keepalive-only batch omits it). docs/plan/
    /// 16-action-round-trip.md Scope: "`poll_uplink` flushes actions at once" -- a non-empty
    /// outbox bypasses both rate checks above (an action's own latency budget, 0004: "at most one
    /// tick plus the network", does not have a 50 ms pacing floor to spend), and every queued
    /// action goes out in the very next batch, whichever tick it is polled on.
    pub fn poll_uplink(&mut self, t_ms: u32, out: &mut [u8]) -> usize {
        let has_actions = !self.outbox.is_empty();
        if !has_actions && let Some(last) = self.last_batch_ms {
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
            self.outbox
                .iter()
                .map(|(seq, bytes)| (*seq, bytes.as_slice())),
            camera,
            None,
        );
        let Ok(n) = sink.finish() else { return 0 };
        self.last_batch_ms = Some(t_ms);
        self.camera_pending = false;
        if has_actions {
            self.outbox.clear();
        }
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
                SectionId::ActionResults => {
                    ActionResultsReader::read::<G>(&mut br, |_, _| {})?;
                }
                SectionId::Presence | SectionId::Hashes | SectionId::ChunkTiles => {} // Non-scope bodies (opaque here)
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
        // Each applied frame's own results replace the last: the caller (`game_instance.rs`)
        // drains them right after this call returns, so nothing here needs to persist across
        // frames (docs/plan/16-action-round-trip.md Scope).
        self.results.clear();

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
                SectionId::ActionResults => {
                    let results = &mut self.results;
                    ActionResultsReader::read::<G>(&mut br, |seq, result| {
                        results.push((seq, result));
                    })
                    .expect("validated");
                }
                SectionId::Presence
                | SectionId::Hashes
                | SectionId::ChunkTiles
                | SectionId::ChunkKeeps => {} // Non-scope bodies
            }
        }
        summary
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::sim::{EngineReject, Outcome};
    use crate::wire::{ActionResultsWriter, FrameHeader, FrameWriter, SectionId};
    use crate::world::{
        CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
    };
    use crate::worldgen::Worldgen;

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct CAction {
        n: u32,
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    enum CReject {
        Bad,
    }
    impl From<Unknown> for CReject {
        fn from(_: Unknown) -> Self {
            CReject::Bad
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct CEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct CPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct CGlobal;

    struct CWorldgen;
    impl Worldgen for CWorldgen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    struct CGame;
    impl Game for CGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = CWorldgen;
        type Action = CAction;
        type Reject = CReject;
        type Entity = CEntity;
        type Player = CPlayer;
        type Global = CGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &CEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &CEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: PlayerId,
            _a: &CAction,
        ) -> Result<(), CReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    struct FlatSource;
    impl PristineSource for FlatSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    fn client() -> ClientCore<CGame> {
        let dims = ChunkDims::new(CGame::CHUNK_BITS);
        let replica = Replica::<CGame>::new(
            dims,
            Box::new(FlatSource),
            CacheCapacity::Chunks(128),
            PlayerId(1),
        );
        ClientCore::new(replica)
    }

    /// One action-ring record: `[seq u32 LE][len u32 LE][UTF-8 JSON]` (Scope).
    fn action_record(seq: u32, json: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&seq.to_le_bytes());
        buf.extend_from_slice(&(json.len() as u32).to_le_bytes());
        buf.extend_from_slice(json.as_bytes());
        buf
    }

    #[test]
    fn on_action_queues_and_poll_uplink_flushes_it_immediately() {
        let mut c = client();
        c.on_action(&action_record(1, r#"{"n":7}"#)).unwrap();
        let mut out = [0u8; 256];
        let n = c.poll_uplink(0, &mut out);
        assert!(n > 0, "the very first batch must carry the queued action");

        // A second action, polled well inside the 50 ms floor a bare camera-only poll would be
        // throttled by (Scope: "poll_uplink flushes actions at once"): must still go out now.
        c.on_action(&action_record(2, r#"{"n":9}"#)).unwrap();
        let n2 = c.poll_uplink(10, &mut out);
        assert!(
            n2 > 0,
            "a queued action must not wait out the 50ms uplink floor"
        );

        // Flushed and cleared: a third poll with nothing new due returns 0.
        let n3 = c.poll_uplink(15, &mut out);
        assert_eq!(n3, 0);
    }

    #[test]
    fn on_action_rejects_malformed_record() {
        let mut c = client();
        assert_eq!(c.on_action(&[1, 2, 3]), Err(ActionError::Malformed));
        assert_eq!(
            c.on_action(&action_record(1, "not json")),
            Err(ActionError::Malformed)
        );
    }

    #[test]
    fn on_action_rejects_once_outbox_is_full() {
        let mut c = client();
        for seq in 0..OUTBOX_CAPACITY as u32 {
            c.on_action(&action_record(seq, r#"{"n":1}"#)).unwrap();
        }
        assert_eq!(
            c.on_action(&action_record(999, r#"{"n":1}"#)),
            Err(ActionError::Full)
        );
    }

    #[test]
    fn action_results_decode_in_order_confirmed_and_rejected() {
        let mut c = client();
        let outcomes = [
            Outcome {
                seq: 1,
                result: Ok(Applied),
            },
            Outcome {
                seq: 2,
                result: Err(Rejected::Game(CReject::Bad)),
            },
            Outcome {
                seq: 3,
                result: Err(Rejected::Engine(EngineReject::RateLimited)),
            },
        ];
        let mut buf = [0u8; 512];
        let mut sink = SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 1,
                ack_seq: 3,
            },
        );
        fw.section(SectionId::ActionResults, |s| {
            ActionResultsWriter::write::<CGame>(s, outcomes.iter());
        });
        let n = sink.finish().unwrap();

        c.on_frame(&buf[..n]).unwrap();
        let mut got = Vec::new();
        c.drain_results(|seq, result| {
            got.push((
                seq,
                match result {
                    Ok(Applied) => 0,
                    Err(Rejected::Game(_)) => 1,
                    Err(Rejected::Engine(_)) => 2,
                },
            ));
        });
        assert_eq!(
            got,
            vec![(1, 0), (2, 1), (3, 2)],
            "results must decode in seq order"
        );

        // Drained: a second drain with nothing new applied sees nothing.
        let mut got2 = Vec::new();
        c.drain_results(|seq, _| got2.push(seq));
        assert!(got2.is_empty());
    }
}
