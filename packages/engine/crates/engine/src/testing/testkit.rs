//! [`run_script`] (M12b Provides): drives a [`Sim<G>`]
//! through a script of `(Tick, Record<G>)` entries and returns the final `state_hash()`.
//!
//! Contract: a script entry's `Tick` names the *ordinal* of the `Sim::step` call that delivers it
//! (the 1st call lands on `Tick(1)`, the 2nd on `Tick(2)`, ...) -- exactly `sim.tick()` after that
//! call returns, since each `step` advances the tick by exactly one (`Sim::step`'s own doc
//! comment: "then advances the tick"). Entries must be sorted ascending by `Tick`; several entries
//! sharing one `Tick` are delivered together, in one `step` call, in script order (0004: "within a
//! tick, actions apply in host arrival order"). Any gap between one entry's `Tick` and the next is
//! filled with idle `step(&[], ..)` calls, so a script can leave ticks empty on purpose (the same
//! shape `puts_idle_100` exercises directly, without this helper, by calling `step` in a bare
//! loop).

use std::collections::VecDeque;

use crate::client::{ClientCore, ClientSide, Clocks, FrameView, Replica, Uploader};
use crate::delta::Delta;
use crate::game::{EntityId, Game, PlayerId};
use crate::host::{ConnId, Host};
use crate::predict::{Pending, Prediction};
use crate::sim::{Outcome, Record, Sim, WorldParams};
use crate::time::Tick;
use crate::wire::{CameraReport, UplinkWriter};
use crate::world::{CacheCapacity, ChunkDims, PristineSource, Tile, TilePos, TileRect};
use crate::world_access::{View, WorldRead};

/// Fills `sim`'s world directly, bypassing `Sim::step`'s per-action overhead, to exactly
/// `entities` entities (ids `1..=entities`, each `G::Entity::default()`) and `tiles` modified
/// tiles (`TilePos::new(0..tiles, 0)`, each set to `Tile::new(1, 0, 0)`) -- M21 Provides: "bench-style genesis M36's standard large save reuses".
/// Budget tests use this with small configured `max_entities`/`max_modified_tiles` (the Exit
/// criteria's own "not the defaults"), not the full 0007 §8 defaults, to stay inside the fast
/// tier: 262,144 real entities would still be several hundred thousand `BTreeMap` inserts.
///
/// The fill value (`Tile::new(1, 0, 0)`) must differ from whatever the store's `PristineSource`
/// produces at `(0..tiles, 0)`, or that write is a no-op `TileChange::Unchanged` and the modified-
/// tile count falls short of `tiles` -- every caller here uses a source that never produces it.
pub fn fill_world<G: Game>(sim: &mut Sim<G>, entities: u32, tiles: u32)
where
    G::Entity: Default,
{
    let store = sim.authority_mut().store_mut();
    for i in 0..entities {
        store.apply(&Delta::EntityPut {
            id: EntityId(i + 1),
            entity: G::Entity::default(),
        });
    }
    for i in 0..tiles {
        store.apply(&Delta::Tile {
            pos: TilePos::new(i as i32, 0),
            tile: Tile::new(1, 0, 0),
        });
    }
}

/// Jumps `next_entity_id` directly (M21, M21 Provides), for
/// `id_exhaustion_rejects_state_budget_full`: proving the 0022 §2 exhaustion clause without
/// actually spawning billions of entities to reach it.
pub fn set_next_entity_id<G: Game>(sim: &mut Sim<G>, id: u32) {
    sim.authority_mut().store_mut().set_next_entity_id(id);
}

pub fn run_script<G: Game>(sim: &mut Sim<G>, script: &[(Tick, Record<G>)]) -> u64
where
    G::Action: Clone,
{
    let mut out: Vec<Outcome<G>> = Vec::new();
    let mut i = 0;
    while i < script.len() {
        let want = script[i].0;
        debug_assert!(
            want.0 >= 1,
            "run_script: a Tick(0) entry is genesis's, not step's"
        );
        while sim.tick().0 + 1 < want.0 {
            sim.step(&[], &mut out);
        }
        let mut batch: Vec<Record<G>> = Vec::new();
        while i < script.len() && script[i].0 == want {
            batch.push(script[i].1.clone());
            i += 1;
        }
        sim.step(&batch, &mut out);
    }
    sim.state_hash()
}

/// Everything a renderer could show for a region (ported from the spike's own `Visible`, M25 Seams: "a `visible(client, rect)` equality helper"): tiles, occupants BY
/// VALUE, and one player's own state. `PartialEq`/`Clone` need no extra bound (`Game::Entity`/
/// `Game::Player` are already `Clone + PartialEq`, 0003); `Debug` is manual because neither is
/// guaranteed `Debug` by the trait, so `#[derive(Debug)]`'s own blanket `G: Debug` bound (which no
/// `Game` impl satisfies) would never apply.
pub struct Visible<G: Game> {
    pub cells: Vec<(TilePos, Option<Tile>, Option<G::Entity>)>,
    pub me: Option<G::Player>,
}

impl<G: Game> Clone for Visible<G> {
    fn clone(&self) -> Self {
        Visible {
            cells: self.cells.clone(),
            me: self.me.clone(),
        }
    }
}

impl<G: Game> PartialEq for Visible<G> {
    fn eq(&self, other: &Self) -> bool {
        self.cells == other.cells && self.me == other.me
    }
}

impl<G: Game> std::fmt::Debug for Visible<G>
where
    G::Entity: std::fmt::Debug,
    G::Player: std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Visible")
            .field("cells", &self.cells)
            .field("me", &self.me)
            .finish()
    }
}

/// One [`Loopback`] client: a [`ClientCore`], its constant per-tick network delay, and the frames
/// still in flight (M15 Scope: "byte buffers, per-client
/// delay in ticks"). `queue` holds one entry per `Loopback::step` so far this client hasn't drained
/// yet -- an empty `Vec` stands for "no frame that tick" (`build_frame` returned 0), so delay is
/// counted uniformly in ticks regardless of how often the host actually has something to say.
struct LoopbackClient<G: Game> {
    conn: ConnId,
    core: ClientCore<G>,
    delay: u32,
    queue: VecDeque<Vec<u8>>,
    /// The bytes `build_frame` produced for this client on the most recent `Loopback::step`
    /// (empty if it returned 0): test/diagnostic convenience, independent of delivery delay.
    last_built: Vec<u8>,
}

/// A native, byte-level loopback (Goal: "proven natively by a byte-level loopback"): one
/// [`Host`], `K` [`ClientCore`]s, real wire bytes end to end (`Host::build_frame` ->
/// `ClientCore::on_frame`, `UplinkWriter` -> `Host::on_uplink`), each client behind its own
/// constant tick delay. Feature `testing`, dev-dependency use only, like every other type here.
pub struct Loopback<G: Game> {
    pub host: Host<G>,
    clients: Vec<LoopbackClient<G>>,
    /// Reused send buffer (`build_frame`'s own `out`); 64 KiB comfortably covers every frame this
    /// milestone's own scenarios build (a `ChunkSnapshots`-heavy join burst included).
    frame_buf: Vec<u8>,
    uplink_buf: Vec<u8>,
    /// Scratch for one action's `Codec` (postcard) encoding, ahead of wrapping it in an
    /// `UplinkBatch` (M16: [`Loopback::action`]'s own real-wire
    /// path, not the direct `Host::queue_action_for_test` backdoor it used to call.
    action_buf: Vec<u8>,
    /// Per-player action sequence counter, for [`Loopback::action`]/[`Loopback::dispatch`].
    seqs: std::collections::BTreeMap<PlayerId, u32>,
    /// M25: a monotonic clock fed to every client's `ClientCore::poll_uplink` each [`Self::step`],
    /// so a [`Self::dispatch`]ed action's own encoded bytes (queued in `ClientCore`'s outbox, not
    /// sent by [`Self::dispatch`] itself) actually reach the host. Advanced by 50 ms/step (0010's
    /// own uplink floor), matching a 20 Hz tick's real-world duration.
    uplink_ms: u32,
}

impl<G: Game> Loopback<G>
where
    G::Global: Default,
{
    /// Builds a fresh `Host<G>` and runs `sim_genesis` (via the same `Sim::genesis` every other
    /// native caller uses): no `Instance`/ABI plumbing, since that is 15b's (Non-scope here).
    pub fn new(params: WorldParams<G>) -> Self {
        Loopback {
            host: Host::genesis_for_test(params),
            clients: Vec::new(),
            frame_buf: vec![0u8; 64 * 1024],
            uplink_buf: vec![0u8; 512],
            action_buf: vec![0u8; 512],
            seqs: std::collections::BTreeMap::new(),
            uplink_ms: 0,
        }
    }

    /// Sends `action` as `who`'s next `seq`, through the real admit path (M16: an `UplinkBatch` of one action -> `Host::on_uplink` -> decode,
    /// dedup, `G::admit`), delivered at the next `Loopback::step`/`Host::tick`. Auto-increments a
    /// per-player `seq`. `who.0 - 1` recovers the connection id: `Host::connect` always assigns
    /// `PlayerId(conn + 1)` (M15 Deviations), and this
    /// milestone's own admit pipeline has no other way to learn a connection from a `PlayerId`
    /// (host state keeps no reverse map, by design -- one isn't needed anywhere else).
    ///
    /// Was `Host::queue_action_for_test` (a direct `pending_records` push, bypassing decode and
    /// `G::admit` entirely): replaced per this milestone's own instruction to route this
    /// milestone's *new* admit pipeline through its real path rather than build on the M15
    /// backdoor. `Host::queue_action_for_test` itself is not deleted -- `tests/
    /// no_alloc_connection.rs` (M15b's own no-alloc suite, not this milestone's) still calls it
    /// directly, and must: going through the real wire path there would attribute
    /// `codec::decode_canonical`'s own allocation (a scratch buffer sized to the input, every
    /// call) to a measured no-alloc window that currently, correctly, asserts zero.
    pub fn action(&mut self, who: PlayerId, action: G::Action) {
        let seq = {
            let s = self.seqs.entry(who).or_insert(0);
            *s += 1;
            *s
        };
        let conn = who.0 - 1;
        let n = crate::codec::encode(&action, &mut self.action_buf)
            .expect("action_buf is generously sized for this testkit's own scenarios");
        let action_bytes = self.action_buf[..n].to_vec();
        let ack = self
            .clients
            .iter()
            .find(|c| c.conn == conn)
            .map_or(0, |c| c.core.last_summary().tick.0);
        let mut sink = crate::bytes::SliceSink::new(&mut self.uplink_buf);
        UplinkWriter::write(
            &mut sink,
            ack,
            core::iter::once((seq, action_bytes.as_slice())),
            None,
            None,
        );
        let n2 = sink
            .finish()
            .expect("uplink_buf is generously sized for this testkit's own scenarios");
        let bytes = self.uplink_buf[..n2].to_vec();
        let _ = self.host.on_uplink(conn, &bytes);
    }

    /// M25 (docs/decisions/0012-prediction-and-reconciliation.md; M25 Seams): dispatches through the real `ClientCore::on_action` path
    /// (a Codec-encoded action re-wrapped as one action-ring record, `[seq u32 LE][len u32
    /// LE][UTF-8 JSON]`, M16 Scope) instead of [`Self::action`]'s own
    /// direct-to-host uplink shortcut, so prediction actually runs. Still delivered to the host at
    /// the next [`Self::step`] (`ClientCore::poll_uplink`/`Host::on_uplink`, unchanged).
    pub fn dispatch(&mut self, i: usize, action: G::Action) -> (u32, Prediction<G::Reject>)
    where
        G::Reject: Clone,
    {
        let who = self.clients[i].core.view().own_player();
        let seq = {
            let s = self.seqs.entry(who).or_insert(0);
            *s += 1;
            *s
        };
        let json = serde_json::to_string(&action)
            .expect("testkit::Loopback::dispatch: G::Action must JSON-encode");
        let mut record = Vec::with_capacity(8 + json.len());
        record.extend_from_slice(&seq.to_le_bytes());
        record.extend_from_slice(&(json.len() as u32).to_le_bytes());
        record.extend_from_slice(json.as_bytes());
        self.clients[i]
            .core
            .on_action(&record)
            .expect("testkit::Loopback::dispatch: on_action must accept a well-formed record");
        let status = self.clients[i]
            .core
            .pending()
            .find(|p| p.seq == seq)
            .map(|p| p.status.clone())
            .expect("just pushed by on_action above");
        (seq, status)
    }

    /// Every action client `i` still has pending, oldest first (M25
    /// Seams).
    pub fn pending(&self, i: usize) -> impl Iterator<Item = &Pending<G>> {
        self.clients[i].core.pending()
    }

    /// Client `i`'s current overlay size (M25 Seams).
    pub fn overlay_len(&self, i: usize) -> usize {
        self.clients[i].core.overlay().len()
    }

    /// The occupant at `pos` through client `i`'s prediction-merged view, preserving the id
    /// itself (unlike [`Self::visible`], which compares occupants by value only) -- for a test
    /// that needs to assert `EntityId::is_provisional()`.
    pub fn entity_at(&self, i: usize, pos: TilePos) -> Option<EntityId> {
        let core = &self.clients[i].core;
        let replica = core.view();
        let held = |c: crate::world::ChunkCoord| replica.is_held(c);
        let view = View::<G>::new(replica.store(), replica.registry(), replica.tick(), &held)
            .with_overlay(core.overlay());
        view.entity_at(pos).ok().flatten()
    }

    /// Everything visible to client `i` over `rect`, reading through its prediction-merged view
    /// (the spike's own `visible()`, M25 Seams): tiles, occupants BY
    /// VALUE (entity ids are not part of the comparison), and the client's own player state. "No
    /// visible change" means this value is equal.
    pub fn visible(&self, i: usize, rect: TileRect) -> Visible<G> {
        let core = &self.clients[i].core;
        let replica = core.view();
        let who = replica.own_player();
        let held = |c: crate::world::ChunkCoord| replica.is_held(c);
        let view = View::<G>::new(replica.store(), replica.registry(), replica.tick(), &held)
            .with_overlay(core.overlay());
        let mut cells = Vec::new();
        for y in rect.min.y..=rect.max.y {
            for x in rect.min.x..=rect.max.x {
                let p = TilePos::new(x, y);
                let tile = view.tile(p).ok();
                let occ = view
                    .entity_at(p)
                    .ok()
                    .flatten()
                    .and_then(|id| view.entity(id).ok().flatten().cloned());
                cells.push((p, tile, occ));
            }
        }
        let me = view.player(who).ok().cloned();
        Visible { cells, me }
    }

    /// M25 step 8 (M25 Tests added: `entities_in_merges_overlay`/
    /// `entities_in_order_matches_authority`): every entity client `i`'s prediction-merged view
    /// visits over `rect`, in the order `WorldRead::entities_in` itself promises (ascending
    /// `EntityId`, ids not values -- `G::Entity: Clone` is what lets this collect owned copies
    /// instead of borrowing into `self`).
    pub fn entities_in(&self, i: usize, rect: TileRect) -> Vec<(EntityId, G::Entity)>
    where
        G::Entity: Clone,
    {
        let core = &self.clients[i].core;
        let replica = core.view();
        let held = |c: crate::world::ChunkCoord| replica.is_held(c);
        let view = View::<G>::new(replica.store(), replica.registry(), replica.tick(), &held)
            .with_overlay(core.overlay());
        let mut out = Vec::new();
        let _ = view.entities_in(rect, &mut |id, e| out.push((id, e.clone())));
        out
    }

    /// This client's own prediction-merged `Global` (M25 Tests added:
    /// `global_put_predicted` needs to see a predicted `put_global` before any ack, which
    /// `Predicting::global`/`View::global`'s own overlay-first merge already provides -- `visible`
    /// covers tiles/entities/the local player, not this scope.
    pub fn global(&self, i: usize) -> G::Global
    where
        G::Global: Clone,
    {
        let core = &self.clients[i].core;
        let replica = core.view();
        let held = |c: crate::world::ChunkCoord| replica.is_held(c);
        let view = View::<G>::new(replica.store(), replica.registry(), replica.tick(), &held)
            .with_overlay(core.overlay());
        view.global().clone()
    }

    /// M26 ( a real `FrameView` over client `i`'s
    /// own prediction-merged state -- `entities()`/`predicted_player`/`is_predicted`/... all real,
    /// not reimplemented -- so a test can drive the game's own `ClientSide::extract`/`ui` exactly
    /// as `game_instance.rs`'s `frame()`/`on_frame()` do. `visible`/`window_origin` are the
    /// caller's own choice (a test's own camera).
    ///
    /// Steps 4-6 Deviations: `predicted`/`lead`/`correction` are real (`ClientCore::predicted_tick`/
    /// `lead`/`own_correction`, all `&self` -- no borrow-ordering issue the way `game_instance.rs`'s
    /// two production call sites have). `tick_fraction` stays `0.0` deliberately: it is
    /// `ClientCore::tick_fraction`'s own `HostClock` fed from a *wall-clock* `local_ms`
    /// (`game_instance.rs`'s `frame(t_ms)`, real `camera.frame_time_ms`), and `Loopback` drives
    /// clients by tick alone (`Self::step`) with no wall clock of its own to feed it -- widening
    /// this method to `&mut self` and a `local_ms` parameter is a real API change with no caller
    /// needing it yet (every `frame_view`-based test in this milestone's own `render.rs`/`texel.rs`
    /// only reads tile/entity/player state, never `tick_fraction`).
    pub fn frame_view(
        &self,
        i: usize,
        visible: TileRect,
        window_origin: TilePos,
    ) -> FrameView<'_, G> {
        let core = &self.clients[i].core;
        let replica = core.view();
        let clocks = Clocks {
            authoritative: replica.tick(),
            predicted: core.predicted_tick(),
            tick_fraction: 0.0,
            ticks_per_second: G::TICK_RATE.hz_value(),
            lead: core.lead(),
            correction: core.own_correction(),
        };
        FrameView::new(
            replica as &dyn WorldRead<G>,
            clocks,
            replica.own_player(),
            replica.entities_map(),
            replica.registry(),
            visible,
            0.0,
            0.0,
            None,
            window_origin,
            0.0,
            G::Presence::default(),
            replica.remote_presences(),
        )
        .with_prediction(core.overlay(), core.pending_queue())
    }

    /// M26 step 3 (M26: drains client `i`'s own
    /// dirty queue into `uploader` (`ClientCore::drain_dirty`, coalesced to `ChunkCoord` -- a test
    /// driving `Uploader` directly, not through `game_instance.rs`'s own `on_frame`, has no
    /// `patch_tile` call site to route a finer `DirtyEvent::Tile` to anyway) then stages up to
    /// `max_records` through the real, overlay-aware `Uploader::stage_predicted` -- the same
    /// production call `game_instance.rs`'s `upload_stage` makes, not a reimplementation.
    pub fn drain_and_stage<C: ClientSide<G>>(
        &mut self,
        i: usize,
        uploader: &mut Uploader<C, G>,
        max_records: u32,
        region: &mut [u8],
    ) -> u32 {
        let core = &mut self.clients[i].core;
        core.drain_dirty(|chunk| uploader.enqueue_chunk(chunk));
        uploader.stage_predicted(
            max_records,
            core.replica().terrain(),
            core.overlay(),
            region,
        )
    }

    pub fn last_built_frame(&self, i: usize) -> &[u8] {
        &self.clients[i].last_built
    }

    pub fn last_build_frame_len(&self, i: usize) -> usize {
        self.clients[i].last_built.len()
    }

    /// Connects a new client (`Host::connect`) and builds its `Replica` over its own pristine
    /// terrain (client-side generation, M08b: "clients regenerate pristine terrain themselves").
    /// Returns the client's index (`0..K`, in add order) and its assigned [`PlayerId`].
    pub fn add_client(
        &mut self,
        delay_ticks: u32,
        dims: ChunkDims,
        source: Box<dyn PristineSource>,
        cache: CacheCapacity,
    ) -> (usize, PlayerId) {
        let conn = self.clients.len() as ConnId;
        let player = self.host.connect(conn);
        let replica = Replica::<G>::new(dims, source, cache, player);
        self.clients.push(LoopbackClient {
            conn,
            core: ClientCore::new(replica),
            delay: delay_ticks,
            queue: VecDeque::new(),
            last_built: Vec::new(),
        });
        (self.clients.len() - 1, player)
    }

    pub fn client(&self, i: usize) -> &ClientCore<G> {
        &self.clients[i].core
    }

    pub fn client_mut(&mut self, i: usize) -> &mut ClientCore<G> {
        &mut self.clients[i].core
    }

    pub fn conn(&self, i: usize) -> ConnId {
        self.clients[i].conn
    }

    /// Encodes a real `UplinkBatch` (0011) carrying only a fresh camera report and delivers it to
    /// the host immediately (uplink has no modelled delay here: 0010's own budget is host-bound
    /// download, and this milestone's `Tests added` name only downlink delay).
    pub fn set_camera(&mut self, i: usize, report: CameraReport) {
        use crate::bytes::SliceSink;
        let conn = self.clients[i].conn;
        let mut sink = SliceSink::new(&mut self.uplink_buf);
        let ack = self.clients[i].core.last_summary().tick.0;
        UplinkWriter::write(&mut sink, ack, core::iter::empty(), Some(report), None);
        let n = sink.finish().expect("uplink buffer is generously sized");
        let bytes = self.uplink_buf[..n].to_vec();
        let _ = self.host.on_uplink(conn, &bytes);
    }

    /// Encodes a real `UplinkBatch` carrying only a fresh presence sample and delivers it to the
    /// host immediately (M19 Provides: `testkit::Loopback::
    /// set_presence(client, value)` "for scripted producers"), the presence-only sibling of
    /// [`Self::set_camera`] -- same no-modelled-uplink-delay rationale.
    pub fn set_presence(&mut self, i: usize, value: G::Presence) {
        use crate::bytes::SliceSink;
        let conn = self.clients[i].conn;
        let mut sample_buf = [0u8; crate::presence::MAX_ENCODED_BYTES];
        let n_sample = crate::codec::encode(&value, &mut sample_buf)
            .expect("testkit::Loopback::set_presence: value must encode within MAX_ENCODED_BYTES");
        let mut sink = SliceSink::new(&mut self.uplink_buf);
        let ack = self.clients[i].core.last_summary().tick.0;
        UplinkWriter::write(
            &mut sink,
            ack,
            core::iter::empty(),
            None,
            Some(&sample_buf[..n_sample]),
        );
        let n = sink.finish().expect("uplink buffer is generously sized");
        let bytes = self.uplink_buf[..n].to_vec();
        let _ = self.host.on_uplink(conn, &bytes);
    }

    /// Runs one tick end to end: drains every client's own uplink (`ClientCore::poll_uplink`,
    /// M25 -- a no-op for a client that never `dispatch`ed/never set a camera/presence sample),
    /// `Host::tick`, a `build_frame` per client (queued behind that client's delay), delivers every
    /// client's now-due frame, then `Host::seal`.
    pub fn step(&mut self) {
        self.uplink_ms = self.uplink_ms.wrapping_add(50);
        let t_ms = self.uplink_ms;
        let Loopback {
            clients,
            uplink_buf,
            host,
            ..
        } = self;
        for client in clients.iter_mut() {
            let n = client.core.poll_uplink(t_ms, uplink_buf);
            if n > 0 {
                let _ = host.on_uplink(client.conn, &uplink_buf[..n]);
            }
        }

        self.host.tick();
        for idx in 0..self.clients.len() {
            let conn = self.clients[idx].conn;
            let n = self.host.build_frame(conn, &mut self.frame_buf);
            let bytes = if n > 0 {
                self.frame_buf[..n].to_vec()
            } else {
                Vec::new()
            };
            self.clients[idx].last_built = bytes.clone();
            self.clients[idx].queue.push_back(bytes);
        }
        self.host.seal();
        for client in &mut self.clients {
            while client.queue.len() > client.delay as usize {
                let bytes = client.queue.pop_front().expect("just checked len");
                if !bytes.is_empty() {
                    client
                        .core
                        .on_frame(&bytes)
                        .expect("Loopback bytes are host-produced and well-formed");
                }
            }
        }
    }

    /// Replaces the send buffer `build_frame` writes into (the default is 64 KiB): a small one makes
    /// a frame overflow (M31 Deviations, "Gate round 2").
    pub fn set_frame_buf_len(&mut self, len: usize) {
        self.frame_buf = vec![0u8; len];
    }

    /// Runs `n` ticks with no camera changes (`Loopback::step` alone).
    pub fn run(&mut self, n: u32) {
        for _ in 0..n {
            self.step();
        }
    }
}
