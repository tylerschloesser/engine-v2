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

use crate::clock::{HostClock, LeadEstimator};
use crate::game::Game;
use crate::integrity::{DesyncLog, DesyncReport, DesyncScope, RESERVED_SCOPE_COORD};
use crate::interp::InterpDelay;
use crate::predict::{Overlay, OverlayDiff, Pending, PendingQueue, Prediction};
use crate::sim::{Applied, Rejected};
use crate::time::{Tick, Ticks};
use crate::wire::{
    ActionResultsReader, ChunkCoordListReader, SectionId, SnapshotReader, UplinkWriter, WireError,
    read_chunk_deltas, read_global, read_own_player,
};
use crate::wire::{CameraReport, FrameReader, HashEntry};
use crate::world::{ChunkCoord, ChunkRect, Tile, TileRect};
use crate::world_access::{WorldRead, chunk_of};
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
    /// The pending queue already holds [`OUTBOX_CAPACITY`] unacked actions (0012: "when full,
    /// dispatch fails locally"). Main-thread `dispatch` is expected to prevent this by
    /// construction (counting `seq - ack_seq` against the same capacity before ever calling
    /// this), so reaching it here is a defence-in-depth backstop, not the primary enforcement
    /// point -- the one `engine/test.dispatchRaw` bypasses (docs/plan/
    /// 26-prediction-rendering-and-clocks.md Post-`done` fix: "PendingQueue never drains under
    /// bench.frame_worstcase"), which is exactly why this backstop being checked against the
    /// right queue (`pending`, not the transient `outbox`) matters.
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

/// Capacity of the per-frame arrival list (`ClientCore::arrivals`).
const ARRIVALS_CAP: usize = 16;
const MIN_UPLINK_INTERVAL_MS: u32 = 50; // 0010: at most one batch per 50ms
const KEEPALIVE_INTERVAL_MS: u32 = 1000; // 0010: at least one batch per 1s
/// 0010 "Rates": "the latest camera report and presence sample at <= 10 Hz, on change" -- unlike
/// the camera half (which relies on the 50 ms batch floor above plus the host's own drop rule,
/// 0010 "Host drop rule"), presence has no host-side drop rule, so the sampler enforces its own 10
/// Hz ceiling here (docs/plan/19-presence-channel.md step 2).
const PRESENCE_MIN_INTERVAL_MS: u32 = 100;
/// 0010 "Rates" / "Camera report": the camera report goes out at <= 10 Hz, on change, inside the
/// unchanged 50 ms batch cadence, with a leading-edge send when motion starts and a trailing send
/// at rest. A credit bucket (in ms) does both: each report costs [`CAMERA_MIN_INTERVAL_MS`], credit
/// refills at 1 ms per ms up to [`CAMERA_CREDIT_CAP_MS`] (two reports, so a report after rest and
/// the trailing one are never delayed by the limiter), and the sustained rate is 10 Hz. A pending
/// change that is not yet affordable stays pending and rides the first batch that can afford it.
const CAMERA_MIN_INTERVAL_MS: u32 = 100;
const CAMERA_CREDIT_CAP_MS: u32 = 2 * CAMERA_MIN_INTERVAL_MS;

pub struct ClientCore<G: Game> {
    replica: Replica<G>,
    camera: Option<CameraReport>,
    camera_pending: bool,
    /// Camera credit left right after the last camera send, and when that was (`None`: never sent,
    /// full credit). See [`CAMERA_MIN_INTERVAL_MS`].
    camera_credit_ms: u32,
    last_camera_sent_ms: Option<u32>,
    last_batch_ms: Option<u32>,
    last_received_tick: u32,
    /// Reused scratch for a `ChunkSnapshots` entry's overlay tiles (cleared per chunk, never
    /// reallocated once its capacity settles -- `.claude/rules/hot-paths.md`'s steady-state
    /// convention, though `ChunkSnapshots` itself is rare outside a join burst).
    scratch_tiles: Vec<(u16, Tile)>,
    /// Entity ids the chunk snapshot being applied named (`apply`'s `ChunkSnapshots` arm).
    scratch_snapshot_ids: Vec<crate::game::EntityId>,
    /// Reused scratch for one `ChunkDeltas` section's entity ops (cleared per section): see the
    /// comment where it is used.
    scratch_entity_ops: Vec<EntityDeltaOp<G>>,
    last_summary: FrameSummary,
    /// Bumped every time [`Self::on_frame`] successfully applies a frame (docs/plan/
    /// 16b-ui-observation-and-clock.md Scope: "iff a frame mutated the replica since the last
    /// call"). `Self::apply` always calls `Replica::set_tick`, so "on_frame ran" and "the replica
    /// mutated" coincide for every real frame; a caller (`UiObserver::maybe_run`) compares two
    /// reads of this against its own last-seen value rather than re-deriving "did anything change"
    /// from `FrameSummary`.
    mutations: u64,
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
    /// docs/plan/19-presence-channel.md step 2: this frame's presence sample, `Codec`-encoded
    /// eagerly on every [`Self::set_presence`] call so the sampler (`poll_uplink`) only ever
    /// compares bytes (Planning decisions: "'on change' means the encoded bytes differ from the
    /// last sent sample") -- avoids requiring `G::Presence: PartialEq`, which the trait does not
    /// have. Fixed-size, never reallocated (`.claude/rules/hot-paths.md`): a 32-byte array, the
    /// same [`crate::presence::MAX_ENCODED_BYTES`] cap every encoded sample is held to.
    presence_encoded: [u8; crate::presence::MAX_ENCODED_BYTES],
    presence_len: usize,
    /// The bytes of the presence sample most recently *sent* in an `UplinkBatch`, or `None` before
    /// the first send. Compared against `presence_encoded`/`presence_len` in [`Self::presence_due`]
    /// to decide "on change".
    last_sent_presence: Option<([u8; crate::presence::MAX_ENCODED_BYTES], usize)>,
    last_presence_sent_ms: Option<u32>,
    /// M25 (docs/decisions/0012-prediction-and-reconciliation.md): the reset-and-replay overlay,
    /// cleared and re-filled once per [`Self::on_frame`]; the pending queue mirroring it, and the
    /// estimated round trip (ticks) [`Self::predicted_tick`] adds to the replica's own tick.
    overlay: Overlay<G>,
    pending: PendingQueue<G>,
    lead: Ticks,
    /// Diagnostic counter (docs/plan/25-prediction-core.md Budgets: "a new deterministic counter
    /// `predict_replays_per_frame`"): how many pending actions the most recent [`Self::on_frame`]
    /// re-predicted.
    predict_replays_last_frame: u32,
    /// M26 (docs/plan/26-prediction-rendering-and-clocks.md Provides): the per-replay overlay
    /// change list, updated by [`Self::sync_overlay_dirty`] after every replay (dispatch's own
    /// initial predict, and `on_frame`'s reconcile tail).
    overlay_diff: OverlayDiff,
    /// Diagnostic counter (Budgets: "a new deterministic counter `overlay_diff_entries` with a
    /// `budgets.json` ceiling"): how many tiles the most recent [`Self::sync_overlay_dirty`] call
    /// found changed.
    overlay_diff_entries_last: u32,
    /// docs/plan/26-prediction-rendering-and-clocks.md steps 4-6: this client's own wall-clock
    /// estimate (Planning decisions "`HostClock` lives here, not in M30"), fed once per
    /// `game_instance.rs` wake (`frame(t_ms)`, real local wall time via `CameraBlock::
    /// frame_time_ms`) through [`Self::tick_fraction`], not only when a new host frame lands.
    host_clock: HostClock,
    /// docs/plan/30-interpolation.md: the adaptive interpolation delay (0010 Rates), fed the tick of
    /// every applied frame ([`Self::arrivals`]) stamped with the client clock at the next
    /// [`Self::tick_fraction`] call, and slewed by that call's elapsed time.
    interp_delay: InterpDelay,
    /// Host ticks of frames applied by [`Self::on_frame`] since the last [`Self::tick_fraction`]
    /// (fixed capacity; on overflow the oldest is dropped: only a stall's backlog can overflow it,
    /// and its arrival times would all be the same clock reading anyway).
    arrivals: [u32; ARRIVALS_CAP],
    arrivals_len: usize,
    /// [`Self::rebase_interp`] ran: the host clock snaps at the next [`Self::tick_fraction`].
    rebase_pending: bool,
    /// The client clock of the previous [`Self::tick_fraction`] call (`None` before the first).
    last_interp_ms: Option<f64>,
    /// The interpolation render time, host ticks, as of the last [`Self::tick_fraction`].
    render_t: f64,
    /// `HostClock`'s estimate of the host tick (`f64`) at that same call, before the delay.
    host_now: f64,
    /// Remote-player samples rendered / of those extrapolating, summed over frames.
    interp_rendered: u32,
    interp_extrapolated: u32,
    /// M26's lead estimator (Planning decisions "Lead estimation"), driving [`Self::set_lead`]
    /// from [`Self::on_ack_sample`].
    lead_estimator: LeadEstimator,
    /// The eased "Correction without snapping" scalar (0012 Decision), read by
    /// [`Self::own_correction`]: set at each own ack ([`Self::on_ack_sample`]) and decayed to zero
    /// over [`EASE_TICKS`] ticks of elapsed authoritative time -- ticks, not wall-clock ms, since
    /// every other piece of this client's own prediction state (the pending queue, the overlay) is
    /// already tick-native and this avoids threading a wall-clock argument into `on_frame` (module
    /// doc comment: `on_frame`'s own signature is unchanged by this milestone).
    correction: f32,
    correction_set_at: Tick,
    /// The last value [`Self::tick_fraction`] computed, cached so `client_clock_stats`
    /// (`game_instance.rs`, `abi::client_clock_stats`'s own "only what Rust alone has" crossing)
    /// can hand it to the clock block with no `t_ms` argument of its own -- one wake stale on a
    /// wake where `frame(t_ms)` did not itself run, the same "harmless" one-wake staleness
    /// `CachedCameraView`'s own doc comment (`game_instance.rs`) already accepts for
    /// `on_frame`'s own reuse of the last real `frame()` call's camera-derived fields.
    last_tick_fraction: f32,
    /// Open gate failures item 3, gate round 1: how many dispatch-time predictions ([`Self::
    /// on_action`]'s own one-shot `predict` call, 0012 "at dispatch the action is applied once")
    /// have ever come back [`Prediction::Applied`], over this instance's whole lifetime -- proves
    /// "a dispatched action was actually predicted" as a real assertion (`client_predict_stats`,
    /// test-only) rather than a claim resting on the shape of the fixture alone. Never decremented.
    predict_applied_ever: u32,
    /// docs/plan/28b-reconnect-and-lifecycle.md step 5: the last `Welcome.epoch` this client has
    /// seen, `0` before the first one (matching a brand-new world's own manifest default, `host/
    /// mod.rs` Deviations) -- `client_hello`'s own source for the resume hint's `epoch` field, and
    /// `client_on_welcome`'s own signal for "is this Welcome a real resync" (Scope: "A client that
    /// receives Welcome while Online drops replica ... state" -- true only when the epoch actually
    /// changed; a same-epoch Welcome on a *fresh* connection, this milestone's own resume-hint
    /// round trip, must not wipe what the resume hint just told the host it could keep).
    epoch: u32,
    /// docs/plan/31b-desync-hashes.md: this replica's desync reports (`Hashes` mismatches), a ring
    /// of the last 16 plus a counter.
    desyncs: DesyncLog,
    /// `ResyncChunk` requests owed to (or awaiting an answer from) the host, one per chunk or the
    /// reserved scope coordinate: see [`ResyncRequest`]. Bounded by [`MAX_RESYNC_REQUESTS`].
    resyncs: Vec<ResyncRequest>,
    /// `Welcome`'s `HASH_ALL` flag: the host hashes every subscribed chunk every frame, so a
    /// mismatch keeps this client's own encoding of the chunk until the resync snapshot arrives
    /// and then keeps both ([`DesyncDump`]).
    hash_all: bool,
    /// Mismatched chunks whose own encoding is held until their resync snapshot lands.
    dump_pending: Vec<PendingDump>,
    /// Completed dumps, oldest first, at most [`MAX_DUMPS`].
    dumps: Vec<DesyncDump>,
}

/// How many completed dumps a client keeps for the harness to take.
pub const MAX_DUMPS: usize = 16;

struct PendingDump {
    tick: u32,
    coord: ChunkCoord,
    client: Vec<u8>,
}

/// Both encodings of one chunk that differed (hash-all mode only): the client's own at the tick
/// the `Hashes` entry mismatched, and the replica's after the host's resync snapshot replaced it,
/// which is exactly the host's encoding at the time it answered.
pub struct DesyncDump {
    pub tick: u32,
    pub coord: ChunkCoord,
    pub client: Vec<u8>,
    pub host: Vec<u8>,
}

/// One outstanding `ResyncChunk` (docs/plan/31b-desync-hashes.md). `coord` is
/// [`RESERVED_SCOPE_COORD`] for the `Global` + `OwnPlayer` scopes. Removed when the answer lands (a
/// snapshot of that chunk, a leave, or an `OwnPlayer` section for the reserved coordinate) and
/// re-armed by a later mismatch once `5 s` of ticks have passed without one.
#[derive(Clone, Copy, Debug)]
struct ResyncRequest {
    coord: ChunkCoord,
    /// The frame tick of the mismatch that raised (or last re-armed) it.
    tick: u32,
    sent: bool,
}

/// Most requests in flight at once (`view.maxChunks` is 128 by default, plus the reserved one).
const MAX_RESYNC_REQUESTS: usize = 256;

impl<G: Game> ClientCore<G> {
    pub fn new(replica: Replica<G>) -> Self {
        // `G::Presence::default()`, encoded once up front so `presence_encoded`/`presence_len`
        // always describe a real sample (`set_presence` overwrites it before the first real
        // `frame()` call in practice, `game_instance.rs`): matches the value `ClientInstance::init`
        // seeds its own persistent `presence` field with. `Presence: Codec` guarantees an
        // in-bounds default always encodes (no oversize-drop path needed for a fixed, at-most-12-
        // byte-in-practice initial value; a game whose own `Default` somehow overflowed 32 bytes
        // would need a bigger bug fixed elsewhere first).
        let mut presence_encoded = [0u8; crate::presence::MAX_ENCODED_BYTES];
        let presence_len =
            crate::codec::encode(&G::Presence::default(), &mut presence_encoded).unwrap_or(0);
        ClientCore {
            replica,
            camera: None,
            camera_pending: false,
            camera_credit_ms: CAMERA_CREDIT_CAP_MS,
            last_camera_sent_ms: None,
            last_batch_ms: None,
            last_received_tick: 0,
            scratch_tiles: Vec::new(),
            scratch_snapshot_ids: Vec::new(),
            scratch_entity_ops: Vec::new(),
            last_summary: FrameSummary::default(),
            mutations: 0,
            outbox: Vec::new(),
            results: Vec::new(),
            presence_encoded,
            presence_len,
            last_sent_presence: None,
            last_presence_sent_ms: None,
            overlay: Overlay::new(),
            pending: PendingQueue::new(),
            lead: Ticks(1),
            predict_replays_last_frame: 0,
            overlay_diff: OverlayDiff::new(),
            overlay_diff_entries_last: 0,
            host_clock: HostClock::new(G::TICK_RATE),
            interp_delay: InterpDelay::new(G::TICK_RATE),
            arrivals: [0; ARRIVALS_CAP],
            arrivals_len: 0,
            rebase_pending: false,
            last_interp_ms: None,
            render_t: 0.0,
            host_now: 0.0,
            interp_rendered: 0,
            interp_extrapolated: 0,
            lead_estimator: LeadEstimator::new(G::TICK_RATE),
            correction: 0.0,
            correction_set_at: Tick(0),
            last_tick_fraction: 0.0,
            predict_applied_ever: 0,
            epoch: 0,
            desyncs: DesyncLog::default(),
            resyncs: Vec::with_capacity(16),
            hash_all: false,
            dump_pending: Vec::new(),
            dumps: Vec::new(),
        }
    }

    /// Decodes one action-ring record (`[seq u32 LE][len u32 LE][UTF-8 JSON]`, Scope) into
    /// `G::Action` (`serde_json`, 0003: "the client-role WASM parses it ... and emits the postcard
    /// bytes used on the wire"), re-encodes it with `Codec` and queues it in the outbox for the
    /// next [`Self::poll_uplink`]. Human-rate, UI-driven: allocation here is exempt from the
    /// zero-allocation rule that governs every method below it.
    pub fn on_action(&mut self, bytes: &[u8]) -> Result<(), ActionError> {
        // **Post-`done` fix (M26 fix: "PendingQueue never drains under bench.frame_worstcase"):**
        // checked against `pending`, not `outbox`. `outbox` only ever holds actions not yet
        // *sent* -- `poll_uplink` clears it on every flush, unconditionally, whether or not the
        // host has acked anything yet (`Self::poll_uplink`'s own body) -- so under any sustained
        // dispatch rate `outbox.len()` stays near zero almost every call, and this guard almost
        // never fires, regardless of how many actions are genuinely still unacked. `pending` is
        // the queue 0012 actually means by "the outbox" here (`OUTBOX_CAPACITY`'s own doc comment:
        // "M25 turns it into the pending queue") -- every action dispatched but not yet popped by
        // [`Self::on_frame`]'s `pop_acked_through`, which is exactly what must never exceed
        // `OUTBOX_CAPACITY` (`predict::PendingQueue`'s own doc comment used to claim this was
        // already true by construction; it was not -- nothing checked `pending.len()` at all).
        if self.pending.len() >= OUTBOX_CAPACITY {
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

        // 0012 Decision: "At dispatch the action is applied once, queued as pending with its
        // `seq`, and sent" -- the sending half is the outbox above (unchanged, M16); this predicts
        // it once against the current overlay and remembers the frozen predicted tick.
        let predicted_tick = self.predicted_tick();
        let auth_tick_at_dispatch = self.replica.tick();
        let who = self.replica.own_player();
        let ClientCore {
            replica, overlay, ..
        } = self;
        let registry = replica.registry();
        let base = &*replica as &dyn WorldRead<G>;
        let status =
            crate::predict::predict(base, registry, overlay, who, predicted_tick, seq, &action);
        if matches!(status, Prediction::Applied) {
            self.predict_applied_ever = self.predict_applied_ever.saturating_add(1);
        }
        self.pending.push(Pending {
            seq,
            action,
            predicted_tick,
            status,
            auth_tick_at_dispatch,
        });
        self.sync_overlay_dirty();
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

    /// How many frames [`Self::on_frame`] has successfully applied, ever (docs/plan/
    /// 16b-ui-observation-and-clock.md Scope): the `ui` call policy's "since the last call" signal.
    pub fn mutations(&self) -> u64 {
        self.mutations
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

    /// M25: the current prediction overlay (`testkit::Loopback::overlay_len`; a read-only
    /// `world_access::View::with_overlay` for `Loopback::visible`).
    pub fn overlay(&self) -> &Overlay<G> {
        &self.overlay
    }

    /// docs/plan/28b-reconnect-and-lifecycle.md step 5: the last real camera [`Self::set_camera`]
    /// recorded, or `None` before the first one this client instance's whole lifetime has ever had
    /// (survives a reconnect: unlike [`Self::reset_for_resync`], nothing here ever clears it) --
    /// `client_hello`'s own source for both `Hello.camera` (when `Some`) and the resume hint's own
    /// coordinate basis (0013: "relative to the Hello camera report's centre").
    pub fn camera(&self) -> Option<CameraReport> {
        self.camera
    }

    /// The last `Welcome.epoch` this client has seen (`0` before the first one) -- `client_hello`'s
    /// own source for the resume hint's `epoch` field.
    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    /// docs/plan/28b-reconnect-and-lifecycle.md step 5: records `Welcome.epoch`, called once per
    /// `client_on_welcome` alongside (never instead of) [`Self::reset_for_resync`]'s own,
    /// epoch-gated call -- see that method's doc comment for the ordering this depends on.
    pub(crate) fn set_epoch(&mut self, epoch: u32) {
        self.epoch = epoch;
    }

    /// docs/plan/28b-reconnect-and-lifecycle.md step 2: called on every `Welcome` (`game_instance
    /// .rs`'s `client_on_welcome`, both a plain join's first one and a resync's second one --
    /// idempotent on an already-empty replica, so the caller need not distinguish the two). Drops
    /// every currently held chunk exactly as an ordinary `ChunkLeaves` entry would (`Replica::
    /// apply_leave`'s own per-chunk teardown: frees the overlay, drops entities no longer
    /// overlapping any held chunk) and clears the prediction overlay (`Overlay::clear`) -- 0005
    /// "clients ... take a full resync": nothing stale renders before the resync's own
    /// `ChunkEnterPristine`/`ChunkSnapshots` entries repopulate them. The pending queue itself is
    /// untouched (Non-scope: resending it is step 3's own "Pending-action resend"; the overlay it
    /// would otherwise still reference is already gone, so the next reconcile pass rebuilds it from
    /// scratch against the fresh replica).
    pub fn reset_for_resync(&mut self) {
        let chunks: Vec<ChunkCoord> = self.replica.held_chunks().collect();
        for chunk in chunks {
            self.replica.apply_leave(chunk);
        }
        self.overlay.clear();
        self.resyncs.clear();
        self.dump_pending.clear();
        self.rebase_interp();
    }

    /// docs/plan/30-interpolation.md (0018 section 8): tab return or resync. The host clock and
    /// the interpolation delay snap back to their initial state and every remote's samples are
    /// dropped: the only place either snaps.
    pub fn rebase_interp(&mut self) {
        // The clock snaps in `tick_fraction`, after it has taken this frame's own sample.
        self.rebase_pending = true;
        self.interp_delay.rebase();
        self.replica.remote_presences_mut().clear();
        self.arrivals_len = 0;
        self.last_interp_ms = None;
    }

    /// docs/plan/28b-reconnect-and-lifecycle.md step 3 ("Pending-action resend"): called once from
    /// `client_on_welcome`, on every `Welcome` (a plain join's own included -- `pending` is empty
    /// then, so both loops below are no-ops). `ack_seq` is `Welcome.last_processed_action_seq`
    /// (0013 Reconnect: "the client then resends pending actions with `seq >
    /// last_processed_action_seq`"). Every pending action with `seq > ack_seq` (M25's
    /// `PendingQueue::unacked_after`) is re-encoded into the outbox for the very next
    /// `poll_uplink` flush -- its own `Pending` entry (status/predicted_tick) is untouched, so the
    /// normal `on_frame` reconcile pass re-predicts it exactly like any other still-pending action.
    /// Every pending action with `seq <= ack_seq` is popped (`pop_acked_through`, the same helper
    /// `on_frame`'s own ack handling uses) and handed to `on_lost`: the host already processed it
    /// (applied or rejected) on the *old* connection, but that connection died before its own ack
    /// ever arrived, and 0013's host keeps no per-session state to replay one from -- neither
    /// `Confirmed` nor `Rejected` is knowable here, so the caller reports `Lost` (0004, 0013;
    /// `game_instance::push_lost_record`).
    pub fn resend_after_welcome(&mut self, ack_seq: u32, mut on_lost: impl FnMut(u32)) {
        self.outbox.clear();
        let mut buf = [0u8; MAX_ACTION_ENCODED_BYTES];
        let ClientCore {
            pending, outbox, ..
        } = self;
        for (seq, action) in pending.unacked_after(ack_seq) {
            if let Ok(n) = crate::codec::encode(action, &mut buf) {
                outbox.push((seq, buf[..n].to_vec()));
            }
        }
        while let Some(p) = self.pending.pop_acked_through(ack_seq) {
            on_lost(p.seq);
        }
    }

    /// M25: every action still pending, oldest first (`testkit::Loopback::pending`).
    pub fn pending(&self) -> impl Iterator<Item = &Pending<G>> {
        self.pending.iter()
    }

    /// M26 (docs/plan/26-prediction-rendering-and-clocks.md): the pending queue itself, for
    /// `FrameView::with_prediction` (`game_instance.rs`'s own `FrameView::new(..)
    /// .with_prediction(core.overlay(), core.pending_queue())` call sites) -- [`Self::pending`]
    /// above only ever hands back an iterator, not something a `FrameView` can borrow for a whole
    /// frame's lifetime.
    pub(crate) fn pending_queue(&self) -> &PendingQueue<G> {
        &self.pending
    }

    /// M25 (docs/decisions/0012-prediction-and-reconciliation.md "Two clocks"): the estimated round
    /// trip, in ticks, `Self::predicted_tick` adds to the replica's own authoritative tick. Default
    /// 1 until the first real ack sample (`Self::on_ack_sample`, driven by `LeadEstimator`) --
    /// every existing test that called this directly (M25) still can, since a test-set lead is
    /// simply overwritten by the next real ack sample, exactly like production.
    pub fn set_lead(&mut self, lead: Ticks) {
        self.lead = lead;
    }

    /// The current lead estimate (docs/plan/26-prediction-rendering-and-clocks.md: `Clocks::lead`'s
    /// own source, and `client.clock()`'s `predicted - authoritative`).
    pub fn lead(&self) -> Ticks {
        self.lead
    }

    /// M26's own lead-estimator seam (Provides: "`seed_rtt_ms(f64)` (M28/M29 call it)"), forwarded
    /// here rather than exposing `LeadEstimator` itself (the same "one integration surface" shape
    /// `Self::set_lead` already gives every other lead-affecting call): a no-op on the lead
    /// actually in effect once a real ack sample exists (`LeadEstimator::seed_rtt_ms`'s own doc
    /// comment), so calling this after prediction is already running is harmless.
    pub fn seed_lead_rtt_ms(&mut self, rtt_ms: f64) {
        self.lead_estimator.seed_rtt_ms(rtt_ms);
        self.lead = self.lead_estimator.lead();
    }

    /// The clock a player's own predicted timers are written and rendered in (0012 "Two clocks":
    /// "Predicted = authoritative + lead").
    pub fn predicted_tick(&self) -> Tick {
        self.replica.tick() + self.lead
    }

    /// M26: this client's own wall-clock estimate of progress into the *current* tick (`Clocks::
    /// tick_fraction`'s own source), fed from `HostClock` with the replica's own current tick and
    /// `local_ms` (`game_instance.rs`'s `frame(t_ms)`'s real `camera.frame_time_ms`, called once per
    /// client-worker wake -- module doc comment: "not only when a new host frame lands", which is
    /// exactly what keeps this from freezing between heartbeats, 0010).
    pub fn tick_fraction(&mut self, local_ms: f64) -> f32 {
        self.host_clock.on_frame(self.replica.tick(), local_ms);
        if self.rebase_pending {
            self.rebase_pending = false;
            self.host_clock.rebase();
        }
        let f = self.host_clock.now(local_ms).1;
        self.last_tick_fraction = f;
        self.step_interp(local_ms);
        f
    }

    /// docs/plan/30-interpolation.md: once per client frame, at the client clock `local_ms`: stamps
    /// the frames and presence samples decoded since the last call with `local_ms` (the real
    /// arrival time `on_frame`'s signature cannot carry), slews the delay, and computes the render
    /// time and the per-frame interpolation counters.
    fn step_interp(&mut self, local_ms: f64) {
        for i in 0..self.arrivals_len {
            self.interp_delay
                .on_arrival(Tick(self.arrivals[i]), local_ms);
        }
        self.arrivals_len = 0;
        self.replica.remote_presences_mut().stamp_arrivals(local_ms);
        if let Some(prev) = self.last_interp_ms {
            self.interp_delay.advance(local_ms - prev);
        }
        self.last_interp_ms = Some(local_ms);
        let now = self.host_clock.now_f64(local_ms);
        self.host_now = now;
        self.render_t = self.interp_delay.render_time(now);
        let (rendered, extrap) = self.replica.remote_presences().count_modes(self.render_t);
        self.interp_rendered = self.interp_rendered.wrapping_add(rendered);
        self.interp_extrapolated = self.interp_extrapolated.wrapping_add(extrap);
    }

    /// The interpolation render time (host ticks) as of the last [`Self::tick_fraction`].
    pub fn render_time(&self) -> f64 {
        self.render_t
    }

    /// The `HostClock` estimate of the host tick as of the last [`Self::tick_fraction`].
    pub fn host_now(&self) -> f64 {
        self.host_now
    }

    /// The current interpolation delay, ms.
    pub fn interp_delay_ms(&self) -> f32 {
        self.interp_delay.delay_ms()
    }

    /// `(rendered, extrapolated)` remote-sample counts summed over every frame so far.
    pub fn interp_counters(&self) -> (u32, u32) {
        (self.interp_rendered, self.interp_extrapolated)
    }

    /// The last value [`Self::tick_fraction`] computed (this struct's own doc comment on
    /// `last_tick_fraction`): `client_clock_stats`'s own source, with no `t_ms` of its own to pass.
    pub fn last_tick_fraction(&self) -> f32 {
        self.last_tick_fraction
    }

    /// The "Correction without snapping" scalar (0012 Decision), eased to zero over ~200 ms of
    /// elapsed authoritative time (`G::TICK_RATE.millis(200)`, 0006) since it was last set
    /// (`Self::on_ack_sample`): `Clocks::correction`'s own source.
    pub fn own_correction(&self) -> f32 {
        let ease_ticks = G::TICK_RATE.millis(200).0 as f32; // 0012: "eases to zero over ~200 ms"
        if ease_ticks <= 0.0 {
            return 0.0;
        }
        let elapsed = self
            .replica
            .tick()
            .0
            .saturating_sub(self.correction_set_at.0) as f32;
        let frac = (1.0 - elapsed / ease_ticks).max(0.0);
        self.correction * frac
    }

    /// How many pending actions the most recent [`Self::on_frame`] re-predicted (docs/plan/
    /// 25-prediction-core.md Budgets).
    pub fn predict_replays_last_frame(&self) -> u32 {
        self.predict_replays_last_frame
    }

    /// M26's lead-estimator hook (docs/plan/25-prediction-core.md Provides): called once per
    /// pending action the host has just acked, with the authoritative tick this client held at
    /// dispatch time, that same action's own frozen `predicted_tick`, and the tick the ack itself
    /// landed on. Feeds `LeadEstimator` (driving `Self::set_lead`, per its own Provides: "It drives
    /// M25's `ClientCore::set_lead`") and sets the eased correction (0012 "Correction without
    /// snapping": "the ack causes exactly one k-tick correction ... eases to zero over ~200 ms",
    /// Planning decisions "Eased correction" -- `k = ack_tick - predicted_tick`, one scalar,
    /// overwritten by each new ack rather than accumulated, since a player has at most one or two
    /// own timers in flight and this is not per-timer state).
    fn on_ack_sample(&mut self, auth_tick_at_dispatch: Tick, predicted_tick: Tick, ack_tick: Tick) {
        self.lead_estimator
            .on_ack_sample(auth_tick_at_dispatch, ack_tick);
        self.lead = self.lead_estimator.lead();
        let k = ack_tick.0 as i64 - predicted_tick.0 as i64;
        self.correction = k as f32;
        self.correction_set_at = ack_tick;
    }

    /// M26 (docs/plan/26-prediction-rendering-and-clocks.md Provides): marks `chunk` dirty for the
    /// upload path directly, sharing the one dirty queue replica deltas already push into. Skips
    /// the push if a delta already dirtied this exact chunk earlier in the same call (`Replica::
    /// dirty_contains_chunk`'s own doc comment): the delta's own re-stage already reads the
    /// reconciled overlay content fresh at stage time, so a second whole-chunk mark here would
    /// only be a redundant upload -- "never two uploads of a chunk in one frame" (Tests added,
    /// `texel_upload_only_on_change`).
    pub fn mark_dirty(&mut self, chunk: ChunkCoord) {
        if !self.replica.dirty_contains_chunk(chunk) {
            self.replica.mark_dirty(chunk);
        }
    }

    /// Recomputes [`Self::overlay_diff`] against the overlay's current effective tile content and
    /// marks every changed tile's own chunk dirty (Planning decisions: "`OverlayDiff` keeps the
    /// previous deduplicated overlay tile list ... and compares after each replay"). Called once
    /// at the tail of [`Self::on_action`] (the dispatch-time predict is itself a replay, 0012: "At
    /// dispatch the action is applied once") and once at the tail of [`Self::on_frame`]'s
    /// reconcile loop.
    fn sync_overlay_dirty(&mut self) {
        self.overlay_diff.update(&self.overlay);
        self.overlay_diff_entries_last = self.overlay_diff.tiles().len() as u32;
        // Split borrow, not `self.mark_dirty(..)` in a loop over `self.overlay_diff.tiles()`
        // (`.claude/rules/hot-paths.md`: no allocation per replay, so no intermediate `Vec` to
        // let the two borrows not overlap either).
        let ClientCore {
            replica,
            overlay_diff,
            ..
        } = self;
        for &pos in overlay_diff.tiles() {
            let chunk = chunk_of::<G>(pos);
            if !replica.dirty_contains_chunk(chunk) {
                replica.mark_dirty(chunk);
            }
        }
    }

    /// How many tiles the most recent replay's [`OverlayDiff`] found changed (docs/plan/
    /// 26-prediction-rendering-and-clocks.md Budgets: `overlay_diff_entries`).
    pub fn overlay_diff_entries(&self) -> u32 {
        self.overlay_diff_entries_last
    }

    /// Cumulative count of dispatch-time predictions that came back [`Prediction::Applied`], ever
    /// (`client_predict_stats`, test-only; Open gate failures item 3, gate round 1).
    pub fn predict_applied_ever(&self) -> u32 {
        self.predict_applied_ever
    }

    pub fn drain_dirty(&mut self, f: impl FnMut(crate::world::ChunkCoord)) {
        self.replica.drain_dirty(f);
    }

    pub fn region_hash(&self) -> u64 {
        self.replica.region_hash()
    }

    /// This client's desync reports (docs/plan/31b-desync-hashes.md).
    pub fn desyncs(&self) -> &DesyncLog {
        &self.desyncs
    }

    /// `Welcome` announced (or withdrew) hash-all mode.
    pub fn set_hash_all(&mut self, on: bool) {
        self.hash_all = on;
    }

    /// The oldest completed dump, if any (hash-all mode; `client_desync_dump`).
    pub fn first_dump(&self) -> Option<&DesyncDump> {
        self.dumps.first()
    }

    /// Drops the oldest completed dump.
    pub fn pop_dump(&mut self) {
        if !self.dumps.is_empty() {
            self.dumps.remove(0);
        }
    }

    /// Test fault injection (`client_corrupt_chunk`): flips one replica byte of a held chunk.
    pub fn debug_corrupt_chunk(&mut self, chunk: ChunkCoord) -> bool {
        self.replica.debug_corrupt_chunk(chunk)
    }

    /// Records one `Hashes` mismatch (a report every time) and, unless a request for `coord` is
    /// already in flight, queues a `ResyncChunk` for the next [`Self::poll_uplink`].
    fn note_desync(
        desyncs: &mut DesyncLog,
        resyncs: &mut Vec<ResyncRequest>,
        tick: u32,
        scope: DesyncScope,
        coord: ChunkCoord,
        host_hash: u64,
        client_hash: u64,
    ) {
        desyncs.record(
            "client",
            DesyncReport {
                tick,
                scope,
                coord,
                host_hash,
                client_hash,
            },
        );
        let retry_after = G::TICK_RATE.hz_value().saturating_mul(5);
        match resyncs.iter_mut().find(|r| r.coord == coord) {
            Some(r) => {
                if r.sent && tick.wrapping_sub(r.tick) >= retry_after {
                    r.sent = false;
                    r.tick = tick;
                }
            }
            None => {
                if resyncs.len() < MAX_RESYNC_REQUESTS {
                    resyncs.push(ResyncRequest {
                        coord,
                        tick,
                        sent: false,
                    });
                }
            }
        }
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

    /// Records this frame's presence sample (docs/plan/19-presence-channel.md step 2, 0001: "the
    /// game's client-side Rust writes `G::Presence` once per client frame"). Encodes eagerly so
    /// [`Self::presence_due`] only ever compares bytes: an oversize encode (over
    /// [`crate::presence::MAX_ENCODED_BYTES`]) is dropped silently here, leaving
    /// `presence_encoded`/`presence_len` at their previous value -- a game whose sample briefly (or
    /// by bug) exceeds the cap simply keeps sending its last valid one rather than corrupting the
    /// uplink. The host's own `presence_oversize` counter (step 3, `host::mod`) is what covers an
    /// untrusted decode of *received* bytes; a client failing to encode its own game's `Default`-
    /// sized sample is not expected in practice (0001: "at most 32 bytes encoded").
    pub fn set_presence(&mut self, sample: &G::Presence) {
        let mut buf = [0u8; crate::presence::MAX_ENCODED_BYTES];
        if let Ok(n) = crate::codec::encode(sample, &mut buf) {
            self.presence_encoded = buf;
            self.presence_len = n;
        }
    }

    /// docs/plan/28-sessions-and-reconnect.md: M19's own Provides named this method ("M28 calls it
    /// from `Welcome`"), left unbuilt by M19 itself (no caller existed in that cut) -- this is that
    /// caller. Primes the uplink sampler with the session table's own last-known sample (`Welcome`'s
    /// `presence` field, echoed back from `PresenceTable::restore` host-side) exactly like
    /// [`Self::set_presence`] does for a fresh one: since the "last actually sent" bookkeeping is
    /// still unset at this point (a brand-new `ClientCore`, this milestone's own "Welcome, then
    /// attach the byte pump" ordering), [`Self::presence_due`] reads the restored sample as "changed",
    /// which is correct -- the host's own copy is this same value already (it is where the sample
    /// came from), but re-sending it once on the first real uplink is harmless and keeps this
    /// sampler's own invariant ("current == last sent, once caught up") simple rather than adding a
    /// third state. The game's own per-frame `G::Presence` value (`game_instance::ClientInstance
    /// ::presence`, outside `ClientCore`) is seeded separately, by the same caller.
    pub fn seed_presence(&mut self, sample: &G::Presence) {
        self.set_presence(sample);
    }

    /// docs/plan/28-sessions-and-reconnect.md (0013 "Join is late join", last sentence): true once
    /// every chunk of `visible` is both held by the replica (entered via `ChunkEnterPristine` or
    /// `ChunkSnapshots`) and locally generated (`TerrainStore::is_cached`, the same "resident in
    /// the client's cache" predicate `client_chunk_hash`'s own `Status::NotCached` reads) -- a
    /// pristine-entered chunk is held immediately but not necessarily generated yet (`TerrainFeed`
    /// materializes it asynchronously), so both checks are needed. `visible` is the caller's own
    /// tile-space rectangle (`game_instance.rs`'s `CachedCameraView::visible`, `FrameView::
    /// visible()`'s own "visible rectangle plus a 2-tile margin"): this method takes no camera
    /// state of its own. Steps 3-5 are the first consumer (M29 gates the first terrain draw on
    /// it); this milestone only lands the method and its clock-block word.
    pub fn revealed(&self, visible: TileRect) -> bool {
        let min_chunk = chunk_of::<G>(visible.min);
        let max_chunk = chunk_of::<G>(visible.max);
        let rect = ChunkRect::new(min_chunk, max_chunk);
        for chunk in rect.iter() {
            if !self.replica.is_held(chunk) || !self.replica.terrain().is_cached(chunk) {
                return false;
            }
        }
        true
    }

    /// Whether [`Self::poll_uplink`] should attach the current presence sample to the next batch
    /// (0010 "Rates": "presence sample at <= 10 Hz, on change"; Planning decisions: "'on change'
    /// means the encoded bytes differ from the last sent sample" and "the final at-rest sample ...
    /// goes out in the next slot"). `false` once the current sample equals the last one actually
    /// sent, however long ago that was -- a resting player therefore sends nothing until the next
    /// real change, and [`Self::poll_uplink`]'s own re-relay-at-rest concern belongs to the host
    /// (0001: "the host therefore re-relays each connected player's held sample"), not this sampler.
    fn presence_due(&self, t_ms: u32) -> bool {
        let changed = match &self.last_sent_presence {
            None => true,
            Some((bytes, len)) => self.presence_encoded[..self.presence_len] != bytes[..*len],
        };
        if !changed {
            return false;
        }
        match self.last_presence_sent_ms {
            None => true,
            Some(last) => t_ms.wrapping_sub(last) >= PRESENCE_MIN_INTERVAL_MS,
        }
    }

    /// Whether a pending camera change may ride the next batch (10 Hz limiter, see
    /// [`CAMERA_MIN_INTERVAL_MS`]).
    fn camera_due(&self, t_ms: u32) -> bool {
        if !self.camera_pending {
            return false;
        }
        match self.last_camera_sent_ms {
            None => true,
            Some(last) => {
                let credit = self
                    .camera_credit_ms
                    .saturating_add(t_ms.wrapping_sub(last))
                    .min(CAMERA_CREDIT_CAP_MS);
                credit >= CAMERA_MIN_INTERVAL_MS
            }
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
        // docs/plan/31b-desync-hashes.md: a owed `ResyncChunk` goes out alone, ahead of and outside
        // the batch pacing below (one per call; the next call sends the next or the batch).
        if let Some(i) = self.resyncs.iter().position(|r| !r.sent) {
            let mut sink = SliceSink::new(out);
            crate::wire::write_resync_chunk(&mut sink, self.resyncs[i].coord);
            if let Ok(n) = sink.finish() {
                self.resyncs[i].sent = true;
                return n;
            }
        }
        let has_actions = !self.outbox.is_empty();
        let presence_due = self.presence_due(t_ms);
        let camera_due = self.camera_due(t_ms);
        if !has_actions && let Some(last) = self.last_batch_ms {
            let elapsed = t_ms.wrapping_sub(last);
            if elapsed < MIN_UPLINK_INTERVAL_MS {
                return 0;
            }
            if !camera_due && !presence_due && elapsed < KEEPALIVE_INTERVAL_MS {
                return 0;
            }
        }
        let camera = camera_due.then_some(self.camera).flatten();
        let presence = presence_due.then_some(&self.presence_encoded[..self.presence_len]);
        let mut sink = SliceSink::new(out);
        UplinkWriter::write(
            &mut sink,
            self.last_received_tick,
            self.outbox
                .iter()
                .map(|(seq, bytes)| (*seq, bytes.as_slice())),
            camera,
            presence,
        );
        let Ok(n) = sink.finish() else { return 0 };
        self.last_batch_ms = Some(t_ms);
        if camera_due {
            let credit = match self.last_camera_sent_ms {
                None => CAMERA_CREDIT_CAP_MS,
                Some(last) => self
                    .camera_credit_ms
                    .saturating_add(t_ms.wrapping_sub(last))
                    .min(CAMERA_CREDIT_CAP_MS),
            };
            self.camera_credit_ms = credit - CAMERA_MIN_INTERVAL_MS;
            self.last_camera_sent_ms = Some(t_ms);
            self.camera_pending = false;
        }
        if presence_due {
            self.last_sent_presence = Some((self.presence_encoded, self.presence_len));
            self.last_presence_sent_ms = Some(t_ms);
        }
        if has_actions {
            self.outbox.clear();
        }
        n
    }

    /// Validates then applies one frame (0011 "atomically"). `Err` leaves the replica untouched.
    ///
    /// M25 (0012 Decision, steps 2-4): once the frame's own deltas have landed on the replica,
    /// drop every pending action the host has now acked (the game already saw `Confirmed`/
    /// `Rejected` through `results`/`drain_results` above -- this only retires the pending queue's
    /// own bookkeeping copy and samples the ack for M26's lead estimator), clear the overlay, then
    /// re-predict every action still pending. `predict_alloc` proves this whole tail allocates
    /// nothing in steady state.
    pub fn on_frame(&mut self, bytes: &[u8]) -> Result<FrameSummary, WireError> {
        // M31 step 4 (`wire/bundle.rs`): a `FrameBundle` is several whole frames, applied one by one
        // in order, each exactly as if it had arrived alone; the whole bundle is validated first so
        // a malformed tail never leaves it half applied. The summary is the last frame's.
        if bytes.first() == Some(&(crate::wire::MsgType::FrameBundle as u8)) {
            let mut check = crate::wire::BundleReader::new(bytes)?;
            while let Some(frame) = check.next_frame()? {
                Self::validate(frame)?;
            }
            let mut reader = crate::wire::BundleReader::new(bytes)?;
            let mut last = None;
            while let Some(frame) = reader.next_frame()? {
                last = Some(self.on_frame_single(frame)?);
            }
            return last.ok_or(WireError::Malformed);
        }
        self.on_frame_single(bytes)
    }

    fn on_frame_single(&mut self, bytes: &[u8]) -> Result<FrameSummary, WireError> {
        Self::validate(bytes)?;
        let summary = self.apply(bytes);
        if self.arrivals_len == ARRIVALS_CAP {
            self.arrivals.copy_within(1.., 0);
            self.arrivals_len -= 1;
        }
        self.arrivals[self.arrivals_len] = summary.tick.0;
        self.arrivals_len += 1;
        self.last_summary = summary;
        self.mutations = self.mutations.wrapping_add(1);

        while let Some(p) = self.pending.pop_acked_through(summary.ack_seq) {
            self.on_ack_sample(p.auth_tick_at_dispatch, p.predicted_tick, summary.tick);
        }

        self.overlay.clear();
        let ClientCore {
            replica,
            overlay,
            pending,
            ..
        } = self;
        let registry = replica.registry();
        let who = replica.own_player();
        let base = &*replica as &dyn WorldRead<G>;
        // Taint rule R1 (docs/plan/25-prediction-core.md Planning decisions "Taint rule":
        // "taint-all-later: while any pending action is `NotPredictable`, every later pending
        // action is `NotPredictable`; the taint ends when the tainting action is popped"). Chosen
        // over R0 (never taint) and R2 (taint only on write-set overlap): both left contradicted
        // verdicts in `predict_taint_dependency`/`predict_taint_rollback_visibility` (a declined
        // action's own write set is unknowable once it stops at the first `Unknown`, so R2 cannot
        // even see the overlap it would need), so R1 is the only admissible rule (measured counts,
        // Deviations). `tainted` starts `false` every frame and is driven by each action's own
        // *freshly recomputed* status in queue order (oldest first, matching `VecDeque::iter_mut`):
        // once one comes back `NotPredictable` in this pass, every later one in this same pass is
        // forced `NotPredictable` without even calling `predict` -- and a popped (acked) action
        // simply is not in this loop at all next frame, which is how the taint "ends when the
        // tainting action is popped".
        let mut replays = 0u32;
        let mut tainted = false;
        for p in pending.iter_mut() {
            p.status = if tainted {
                Prediction::NotPredictable
            } else {
                crate::predict::predict(
                    base,
                    registry,
                    overlay,
                    who,
                    p.predicted_tick,
                    p.seq,
                    &p.action,
                )
            };
            if matches!(p.status, Prediction::NotPredictable) {
                tainted = true;
            }
            replays += 1;
        }
        self.predict_replays_last_frame = replays;
        self.sync_overlay_dirty();

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
                SectionId::Presence => {
                    crate::wire::read_presence::<G>(&mut br, |_| {})?;
                }
                SectionId::Hashes => {
                    crate::wire::read_hashes(&mut br, |_| {})?;
                }
                SectionId::ChunkTiles => {} // Non-scope body (opaque here)
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
                    // The host's answer to a `Global`/`OwnPlayer` resync carries both scopes.
                    self.resyncs.retain(|r| r.coord != RESERVED_SCOPE_COORD);
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
                        let scratch_ids = &mut self.scratch_snapshot_ids;
                        scratch_ids.clear();
                        let (chunk, version) = sr
                            .read_chunk::<G>(
                                &mut br,
                                |i, t| scratch_tiles.push((i, t)),
                                |id, e| {
                                    scratch_ids.push(id);
                                    replica.apply_snapshot_entity(id, e);
                                },
                            )
                            .expect("validated");
                        // A snapshot of a chunk this replica already holds (M31: a chunk whose
                        // queued deltas outgrew its snapshot is re-sent whole) replaces its
                        // entities too: any entity overlapping the chunk that the snapshot does not
                        // name is gone on the host.
                        self.replica
                            .drop_unnamed_entities(chunk, &self.scratch_snapshot_ids);
                        self.replica
                            .apply_snapshot_overlay(chunk, version, &self.scratch_tiles);
                        self.resyncs.retain(|r| r.coord != chunk);
                        if let Some(i) = self.dump_pending.iter().position(|d| d.coord == chunk) {
                            let pending = self.dump_pending.remove(i);
                            let mut host = Vec::new();
                            self.replica.encode_chunk(chunk, &mut host);
                            if self.dumps.len() == MAX_DUMPS {
                                self.dumps.remove(0);
                            }
                            self.dumps.push(DesyncDump {
                                tick: pending.tick,
                                coord: chunk,
                                client: pending.client,
                                host,
                            });
                        }
                        summary.chunk_snapshots += 1;
                    }
                }
                SectionId::ChunkLeaves => {
                    let mut cr = ChunkCoordListReader::new();
                    while !br.rest().is_empty() {
                        let c = cr.read(&mut br).expect("validated");
                        self.replica.apply_leave(c);
                        self.resyncs.retain(|r| r.coord != c);
                        self.dump_pending.retain(|d| d.coord != c);
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
                SectionId::Presence => {
                    // docs/plan/19-presence-channel.md steps 4-6: `age_ticks = frame.tick -
                    // received_at` (`wire/CLAUDE.md`), so the sample's own capture tick is this
                    // frame's tick minus `age_ticks` -- `RemotePresences`'s own `sample_tick`.
                    let replica = &mut self.replica;
                    crate::wire::read_presence::<G>(&mut br, |op| match op {
                        crate::wire::PresenceDeltaOp::Sample {
                            who,
                            age_ticks,
                            sample,
                        } => {
                            replica.apply_presence_sample(
                                who,
                                sample,
                                Tick(header.tick.wrapping_sub(age_ticks)),
                            );
                            replica.refresh_presence(who, Tick(header.tick));
                        }
                        crate::wire::PresenceDeltaOp::Gone { who } => {
                            replica.apply_presence_gone(who);
                        }
                    })
                    .expect("validated");
                }
                SectionId::Hashes => {
                    // Right after this frame's own sections up to here, against the replica alone
                    // (the prediction overlay is rebuilt after `apply` and never hashed).
                    let ClientCore {
                        replica,
                        desyncs,
                        resyncs,
                        hash_all,
                        dump_pending,
                        ..
                    } = self;
                    let tick = header.tick;
                    crate::wire::read_hashes(&mut br, |entry| match entry {
                        HashEntry::Chunk { coord, hash } => {
                            if let Some(mine) = replica.chunk_hash(coord)
                                && mine != hash
                            {
                                Self::note_desync(
                                    desyncs,
                                    resyncs,
                                    tick,
                                    DesyncScope::Chunk,
                                    coord,
                                    hash,
                                    mine,
                                );
                                if *hash_all
                                    && dump_pending.len() < MAX_DUMPS
                                    && !dump_pending.iter().any(|d| d.coord == coord)
                                {
                                    let mut client = Vec::new();
                                    replica.encode_chunk(coord, &mut client);
                                    dump_pending.push(PendingDump {
                                        tick,
                                        coord,
                                        client,
                                    });
                                }
                            }
                        }
                        HashEntry::Global { hash } => {
                            let mine = replica.global_hash();
                            if mine != hash {
                                Self::note_desync(
                                    desyncs,
                                    resyncs,
                                    tick,
                                    DesyncScope::Global,
                                    RESERVED_SCOPE_COORD,
                                    hash,
                                    mine,
                                );
                            }
                        }
                        HashEntry::OwnPlayer { hash } => {
                            let mine = replica.own_player_hash();
                            if mine != hash {
                                Self::note_desync(
                                    desyncs,
                                    resyncs,
                                    tick,
                                    DesyncScope::OwnPlayer,
                                    RESERVED_SCOPE_COORD,
                                    hash,
                                    mine,
                                );
                            }
                        }
                    })
                    .expect("validated");
                }
                SectionId::ChunkTiles | SectionId::ChunkKeeps => {} // Non-scope bodies
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
        TileRect,
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
    fn on_action_rejects_once_pending_is_full() {
        let mut c = client();
        for seq in 0..OUTBOX_CAPACITY as u32 {
            c.on_action(&action_record(seq, r#"{"n":1}"#)).unwrap();
        }
        assert_eq!(
            c.on_action(&action_record(999, r#"{"n":1}"#)),
            Err(ActionError::Full)
        );
    }

    /// **Post-`done` fix (docs/plan/26-prediction-rendering-and-clocks.md, "PendingQueue never
    /// drains under bench.frame_worstcase"):** the property the test above cannot distinguish
    /// from the base (broken) behaviour, since it never calls `poll_uplink` -- there, `outbox`
    /// and `pending` grow in lockstep, so checking either happens to reject at the same point.
    /// Here, `poll_uplink` drains `outbox` after every dispatch (a real client's own cadence,
    /// `on_action_queues_and_poll_uplink_flushes_it_immediately`'s own precedent) and nothing ever
    /// acks -- `outbox.len()` is back to `0` before every `on_action` call, so a guard checking
    /// `outbox` (the base behaviour this test is written to fail against) never rejects at all,
    /// and `pending` grows past `OUTBOX_CAPACITY` with no limit. Inject-fail-revert: swapping the
    /// guard back to `self.outbox.len() >= OUTBOX_CAPACITY` makes this fail at `pending().count()
    /// == OUTBOX_CAPACITY` (`left: 40, right: 32`, for 40 unacked dispatches with nothing ever
    /// popping any of them) and the final dispatch that should have been refused instead succeeds
    /// (`left: Ok(()), right: Err(Full)`); reverted.
    #[test]
    fn on_action_rejects_once_pending_is_full_even_though_outbox_drains_every_time() {
        let mut c = client();
        let mut out = [0u8; 512];
        // One more than `OUTBOX_CAPACITY`: the base (broken) behaviour accepts every one of these
        // (outbox is empty again by the time the next dispatch arrives, nothing ever acks), so a
        // guard that used to check `outbox` would let this loop finish with no `Err` at all.
        for seq in 0..OUTBOX_CAPACITY as u32 + 8 {
            if c.pending().count() < OUTBOX_CAPACITY {
                c.on_action(&action_record(seq, r#"{"n":1}"#)).unwrap();
            } else {
                assert_eq!(
                    c.on_action(&action_record(seq, r#"{"n":1}"#)),
                    Err(ActionError::Full),
                    "seq={seq}: pending is already at capacity with nothing ever acked"
                );
            }
            // A real client's own cadence: flush whatever the outbox holds right after dispatch,
            // every time -- never given a chance to reach `OUTBOX_CAPACITY` itself.
            c.poll_uplink(seq * 100, &mut out);
        }
        assert_eq!(
            c.pending().count(),
            OUTBOX_CAPACITY,
            "pending must never exceed OUTBOX_CAPACITY, acked or not"
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

    /// `revealed()`: `false` on a fresh instance (nothing held), `false` once the chunk is held
    /// but not yet generated (`apply_enter_pristine` alone), `true` only once it is also cached
    /// (a `tile()` read materializes it). Inject-fail-revert: swapping the final assertion's own
    /// `assert!` for `assert!(!...)` makes this fail with `left: true` (the chunk really is both
    /// held and cached by then); reverted.
    #[test]
    fn revealed_requires_held_and_cached() {
        let mut c = client();
        let one_tile = TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0));
        assert!(!c.revealed(one_tile), "nothing held yet");

        c.replica_mut().apply_enter_pristine(ChunkCoord::new(0, 0));
        assert!(
            !c.revealed(one_tile),
            "held but not yet generated (cache empty)"
        );

        let _ = c.replica().terrain().tile(TilePos::new(0, 0));
        assert!(c.revealed(one_tile), "held and now cached");

        // A rectangle spanning a second, never-entered chunk is not revealed even though the
        // first one now is.
        let two_chunks = TileRect::new(TilePos::new(0, 0), TilePos::new(1000, 0));
        assert!(!c.revealed(two_chunks));
    }
}
