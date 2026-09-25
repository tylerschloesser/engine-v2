//! `Host<G>` (docs/plan/13-sim-host-tick-loop.md Scope): the sim-role `Instance` -- a `Sim<G>`
//! driver plus the between-tick warmer ([`warm`]). M15 adds connections, at which point
//! `sim_admit`/`sim_build_frame` become real; this milestone's own instance leaves them at
//! `Instance`'s defaults (`Status::Unsupported`), since no connection exists yet (Non-scope).
//!
//! Genesis is a separate export from `init` (`sim_genesis`, not built eagerly): M22b's load path
//! needs to choose between "fresh world" and "world restored from storage" after `engine_init`
//! has already reserved the arena and parsed config, so `Host::init` only parses and holds the
//! parameters; `sim_genesis` is what actually builds the `Sim<G>`.

pub mod subs;
pub mod warm;

use std::collections::BTreeMap;

use crate::abi::config::HexU64;
use crate::abi::{Instance, RegionId, RegionLayout, Role, Status};
use crate::authority::Scope;
use crate::codec::decode_canonical;
use crate::delta::Delta;
use crate::game::{Game, PlayerEvent, PlayerId, Presence as _, PresenceTable, WorldRead};
use crate::sim::{Outcome, Record, Rejected, Sim, WorldParams};
use crate::time::Tick;
use crate::wire::{
    ActionResultsWriter, CameraReport, ChunkCoordListWriter, FrameHeader, FrameWriter, SectionId,
    SnapshotWriter, UplinkReader, encode_chunk_snapshot, write_global, write_own_player,
};
use crate::world::ChunkCoord;
use crate::world_access::chunk_of;
use crate::worldgen::Worldgen;
use subs::SubscriptionSet;
use warm::Warm;

/// A connection slot index (Scope: "`ConnId = u32 < maxPlayers`"). 0009's `WorldConfig.maxPlayers`
/// default is 8, matching `warm::MAX_VIEWS`, which this milestone's connection table reuses
/// directly (`host::mod` Deviations: one cap, not two).
pub type ConnId = u32;
pub const MAX_CONNS: usize = warm::MAX_VIEWS;

/// [`Host::on_uplink`]'s one failure mode (docs/plan/16-action-round-trip.md Scope, 0004 step 1):
/// a malformed `UplinkBatch` or a malformed/non-canonical action payload. A protocol error, not a
/// game-level `Rejected` -- the caller closes the connection over it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct UplinkError;

/// Per-connection-per-tick counters (Seams "Provides"). Cumulative across the connection's life,
/// like `host_frame_bytes` in `packages/engine/src/server.ts`'s own convention for a similar
/// per-connection tally.
#[derive(Clone, Copy, Debug, Default)]
pub struct ConnCounters {
    pub bytes_down: u64,
    pub frames: u64,
    pub chunk_enters_pristine: u64,
    pub chunk_snapshots: u64,
    pub chunk_leaves: u64,
    pub bytes_up: u64,
    /// docs/plan/19-presence-channel.md step 3, Planning decisions ("The 32-byte limit is enforced
    /// per encoded sample ... An oversize sample is dropped and counted (`presence_oversize`, must
    /// read 0 in tests"): bumped by `Host::on_uplink` whenever a connection's presence bytes exceed
    /// [`crate::presence::MAX_ENCODED_BYTES`] or fail to decode/canonicalise -- the sample is
    /// dropped (the table keeps whatever it already held for that player), never a protocol error
    /// (unlike a malformed action, which closes the connection): a stale or missing presence sample
    /// only ever makes `admit` more conservative, never less. Live in production: every real `Host`
    /// reaches this from `on_uplink`, not only tests.
    pub presence_oversize: u64,
    /// docs/plan/19-presence-channel.md steps 4-6, `engine/test`'s own `uplinkPresenceBytes`
    /// (`sim_conn_counters`): cumulative presence-field wire bytes (`len varint + payload`, the
    /// same scope `counters.presence.uplinkBytesPerSec` measures) this connection's uplink has had
    /// *recorded* into `PresenceTable` -- bumped only on `on_uplink`'s accepted-sample arm (never
    /// on an oversize/malformed/out-of-range drop), so a nonzero reading is also proof the sample
    /// reached the table (the `presence-worker-path` browser test's own claim), not merely that
    /// bytes arrived on the wire. Always `1 + raw.len()`: `raw.len() <= MAX_ENCODED_BYTES` (32) by
    /// the time this runs (checked above), and a LEB128 varint for any value `0..=32` is always
    /// exactly one byte (the same fact `budgets.json`'s own `counters.presence.uplinkBytesPerSec`
    /// formula already relies on).
    pub presence_bytes_up: u64,
}

struct ConnSlot<G: Game> {
    player: PlayerId,
    camera: Option<CameraReport>,
    subs: SubscriptionSet,
    /// Set at `connect`, cleared after the first `build_frame` call for this connection (Scope:
    /// "'needs Global/OwnPlayer snapshot' flag"): forces a full `Global` + `OwnPlayer` baseline
    /// regardless of whether anything changed this tick (0011: "sent in full on every connect").
    first_frame_pending: bool,
    counters: ConnCounters,
    /// Outcomes owed to this connection's next `build_frame` (docs/plan/16-action-round-trip.md
    /// Scope: "outcomes go to the sender's next `build_frame` as `ActionResults` in `seq` order").
    /// Two producers: `Host::on_uplink` pushes an admission-time `Rejected` immediately (0004
    /// step 2: "not logged"), and `Host::tick` pushes every `Sim::step` outcome for an admitted
    /// action once it has actually been applied (or rejected) at T+1. Drained and cleared by
    /// `build_frame` every time it runs for this connection, so it never grows unbounded.
    pending_results: Vec<Outcome<G>>,
    /// The highest `seq` this connection has ever had *admitted* (queued into `pending_records`,
    /// not merely decoded), across every `on_uplink` call so far -- gate fix, docs/plan/
    /// 16-action-round-trip.md: `Store::last_seq` only advances inside `Sim::step`, at the next
    /// `tick()`, so a snapshot of it alone cannot dedup a resend that arrives in the same
    /// tick-to-tick window as the original (`worker/sim.ts` drains the uplink ring on every wake,
    /// and `poll_uplink` flushes a non-empty outbox immediately, so more than one `on_uplink` call
    /// per tick window is ordinary, not a corner case). Never reset: a fresh `connect()` starts
    /// this at 0, which is always safe because `Store::last_seq` (keyed by `PlayerId`, surviving
    /// reconnect) is folded in via `.max()` on every read, so a genuine reconnect still dedups
    /// correctly against the player's real history. Updated only when an action is actually
    /// admitted (`G::admit` returns `Ok`); an admission-time *reject* does not advance it, since
    /// 0004 never logs that seq and a resend of it is safe to re-admit (it touches no sim state).
    highest_admitted_seq: u32,
    /// docs/plan/19-presence-channel.md steps 4-6, Planning decisions ("Relay is built per client
    /// per tick from the table, never queued: a sample is relayed when `received_at` is newer than
    /// that client's last relayed tick for that player, or that was >= 1 s ago"): the tick this
    /// connection was last sent each player's presence, whichever of a fresh `Sample` or a >= 1 Hz
    /// re-relay caused it. `Host::build_frame`'s own two-loop merge (relay candidates from
    /// `PresenceTable::iter`, `Gone` candidates from the keys here with no matching table entry)
    /// reads this map; also a bounded per-connection set (at most `MAX_CONNS` players ever relayed
    /// to one connection), never per-tick growth.
    presence_relayed: BTreeMap<PlayerId, Tick>,
}

fn default_max_entities() -> u32 {
    262_144
}
fn default_max_modified_tiles() -> u32 {
    1_048_576
}
fn default_max_action_growth() -> u32 {
    4_096
}
/// 0007 §8's host cache budget default (1,024 chunks = 4 MiB at the default 32x32 chunk size);
/// mirrors `Sim::genesis`'s own private `DEFAULT_CACHE_CHUNKS` (`crate::sim`), which is what
/// actually governs `TerrainStore` capacity today -- see the module doc comment on `cache_chunks`
/// below.
fn default_cache_chunks() -> u32 {
    1024
}
/// 0015 "256 MB per WASM instance" (`docs/spec/overview.md`): a generous sentinel meaning "no
/// enforced arena ceiling" for a config that never sets `arenaBytes` (every pre-M21 fixture and
/// test config, docs/plan/21-entities-and-timers.md Deviations): the init check below is then a
/// no-op, exactly as it was before this milestone.
fn default_arena_bytes() -> u32 {
    u32::MAX
}
/// 0007 §8's own fixed estimate ("chunk indexes about 8 MiB"): not scaled by any config value,
/// since the ADR gives no formula for it.
const CHUNK_INDEX_ESTIMATE_BYTES: u64 = 8 * 1024 * 1024;
/// 0007 §8's own fixed estimate ("8 MiB for lists, timers, players, and slack").
const SLACK_ESTIMATE_BYTES: u64 = 8 * 1024 * 1024;
/// 0007 §8's own nominal per-modified-tile cost for the memory-split sum (distinct from
/// `TerrainStore::memory_bytes`'s own real `size_of::<(u16, Tile)>()` of 6 B: the ADR's own
/// worked sum uses 12 B here, matching the state-budget check's nominal cost, `crate::budget::
/// TILE_COST_BYTES`).
const OVERLAY_ENTRY_ESTIMATE_BYTES: u64 = crate::budget::TILE_COST_BYTES as u64;

/// `RegionId::Rx`'s size on the sim role (docs/plan/15b-ring-connection-and-replica-rendering.md
/// Scope: "one whole uplink batch"): matches [`default_max_action_growth`], the same 4,096-byte
/// budget 0007 §8 already gives one action's worth of nominal headroom -- an uplink batch this
/// milestone ever carries is a `CameraReport` (16 B) alone (actions are M16's), so this is
/// generous headroom, not a tight fit. Provisional: 0010's own bandwidth/backpressure budget for
/// this region is Non-scope here (deferred, like the ring capacities in Planning decisions).
const SIM_RX_BYTES: u32 = 4096;
/// `RegionId::Tx`'s size on the sim role: one connection's own built frame
/// (`Host::build_frame`'s `out`). Provisional, generous for this milestone's own tests (a handful
/// of chunks, one or two connections): a real join-burst budget is 0010's pacing/backpressure
/// (Non-scope, M31), and `Host::build_frame`'s own `SliceSink` silently truncates rather than
/// panicking if a real deployment ever needs more (Deviations records this as provisional).
const SIM_TX_BYTES: u32 = 65536;

/// The `game` value of `InstanceConfig` (0009 `WorldConfig.params` plus the host-only
/// `cacheChunks` knob), read once by `Host::init` and held until `sim_genesis` consumes the
/// world-params half of it. `seed`/`params` are 0008's (shared with the `gen`/`client` roles of
/// `GameInstance<G>`); `maxEntities`/`maxModifiedTiles`/`maxActionGrowth` and `cacheChunks` are
/// 0009's `WorldConfig.params`/host fields (docs/plan/13-sim-host-tick-loop.md Scope "Sim-role
/// config"). `view` (0009's untrusted-view clamp) is not parsed here: Non-scope (Connections,
/// subscriptions: M15) means nothing reads it yet.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimConfig<P> {
    seed: HexU64,
    params: P,
    #[serde(default = "default_max_entities")]
    max_entities: u32,
    #[serde(default = "default_max_modified_tiles")]
    max_modified_tiles: u32,
    #[serde(default = "default_max_action_growth")]
    max_action_growth: u32,
    /// Parsed and held on [`Host`] for M15's connection/warmer wiring, but **not yet wired to
    /// `TerrainStore` capacity**: `Sim::genesis`'s own signature is fixed by M12b's Provides and
    /// takes no cache-size parameter, so this field is inert today (docs/plan/
    /// 13-sim-host-tick-loop.md Deviations records this as a known gap, not a silent drop).
    #[serde(default = "default_cache_chunks")]
    cache_chunks: u32,
    /// M21 (docs/plan/21-entities-and-timers.md Scope: "init check of the 0007 §8 memory split
    /// against the arena with real `size_of`"): the instance's configured arena ceiling, in bytes.
    /// Optional, defaulting to [`default_arena_bytes`] (effectively "unchecked") so every existing
    /// config keeps working unmodified.
    #[serde(default = "default_arena_bytes")]
    arena_bytes: u32,
}

/// The sim-role `Instance` (Scope: "`Host<G>` (here: `Sim<G>` + warm list; M15 adds
/// connections)"). Built by `GameInstance::<G>::init` for `Role::Sim`; also usable standalone
/// (this crate's own tests, and any future low-level caller that wants a bare sim-role instance
/// without the `Gen`/`Client` arms of `GameInstance`).
pub struct Host<G: Game> {
    /// Held until [`Host::sim_genesis`] consumes it (or, in a future milestone, a load path
    /// consumes it instead). `None` once genesis has run.
    pending: Option<WorldParams<G>>,
    /// The host-only knobs `WorldParams<G>` has no room for (see [`SimConfig::cache_chunks`]'s own
    /// doc comment on why it stays unused today).
    cache_chunks: u32,
    sim: Option<Sim<G>>,
    /// Reused across every `sim_tick` call (`Sim::step` itself clears it first): avoids a fresh
    /// allocation on the hot tick path.
    outcomes: Vec<Outcome<G>>,
    warm: Warm,

    // -- M15: connections and subscriptions (docs/plan/15-connection-and-subscriptions.md) -----
    conns: Vec<Option<ConnSlot<G>>>,
    /// Whether `connect` has ever seen this slot before (survives `disconnect`, unlike `conns`
    /// itself): `Record::Player { Joined }` is queued only on first sight (Scope).
    ever_joined: Vec<bool>,
    /// Engine connection events queued by `connect`/`disconnect`, delivered to the next `tick()`
    /// call and cleared there (Scope: "queued ... into the frame for T+1").
    pending_records: Vec<Record<G>>,
    /// Tick of each chunk's last replicated change (Scope: "Per-chunk version ... stored with the
    /// chunk on both sides"), global (not per connection): a chunk's version is a property of
    /// world state. Absent = never modified = version 0 (the same default a client replica uses
    /// for a chunk it has only ever seen as pristine, `client::Replica` Deviations).
    chunk_versions: BTreeMap<ChunkCoord, u32>,
    /// The tick `tick()` most recently completed; `build_frame`'s `FrameHeader.tick` and the tick
    /// `chunk_versions` entries are stamped with (host/mod Deviations: `Sim::step` advances the
    /// clock at the very end, so the *completed* tick is `sim.tick()` as read just before `step`).
    last_tick: Tick,
    // Reused scratch, cleared and refilled every `build_frame` call (`.claude/rules/hot-paths.md`
    // steady-state convention): never reallocated once each capacity settles.
    scratch_roster: Vec<(PlayerId, bool)>,
    scratch_entered: Vec<ChunkCoord>,
    scratch_left: Vec<ChunkCoord>,
    scratch_pristine: Vec<ChunkCoord>,
    scratch_snapshot: Vec<ChunkCoord>,
    /// This tick's tile deltas for the connection being built, flat and deduplicated by
    /// `(chunk, index)` (last write wins) as they're gathered, sorted by `(cy, cx, index)` right
    /// before writing (host/mod Deviations: a flat, insertion-sorted `Vec` instead of a `Vec<(_,
    /// Vec<_>)>` of per-chunk groups, which would reallocate its inner `Vec`s every call, or a
    /// `Vec<(ChunkCoord, &[(u16, Tile)])>` slice-of-slices, which cannot be a struct field at all
    /// without a self-referential lifetime -- the `ChunkDeltas` section body is therefore
    /// hand-written directly from this flat, sorted form (`write_chunk_deltas_flat`) rather than
    /// through `wire::write_chunk_deltas`, which only takes the slice-of-slices shape).
    scratch_tile_flat: Vec<(ChunkCoord, u16, crate::world::Tile)>,
    /// Entity ops this tick, deduplicated by id (last write wins), for this connection: `Put` is
    /// re-read live from the store at write time (host/mod Deviations), so this only needs the id
    /// and which kind of op it resolved to.
    scratch_entity_ops: Vec<(crate::game::EntityId, EntityOpKind)>,
    /// The `who` of every `Record::Action` in `pending_records`, gathered in `tick()` just before
    /// `Sim::step` drains it (docs/plan/16-action-round-trip.md Deviations): `Sim::step` pushes
    /// one `Outcome` per `Record::Action` it sees, in the same relative order, but an `Outcome`
    /// itself carries no `who` (0004's `Ack<G>` shape, unchanged) -- zipping this against
    /// `Host::outcomes` after the call is how each result finds its way back to the right
    /// connection. A reused scratch `Vec` like every other buffer here: empty (no allocation) on
    /// every tick with no actions, which is the common case this milestone's own no-alloc tests
    /// (`no_alloc_connection.rs`, not this milestone's) still rely on for ticks with actions too,
    /// since it settles at a steady capacity the same way `scratch_entity_ops` already does.
    scratch_action_players: Vec<PlayerId>,
    /// docs/plan/19-presence-channel.md step 3: the presence samples `G::admit` reads (0001:
    /// "keeps the latest sample per player"). One table per world, not per connection -- keyed by
    /// `PlayerId`, which survives a reconnect the way `Store::last_seq` does, so a fresh `ConnSlot`
    /// for a returning player does not itself clear a held sample (only `Host::disconnect`, steps
    /// 4-6, does that, per 0001: "on disconnect the host tells clients at once and drops the sample
    /// from relay").
    presence: PresenceTable<G>,
    /// This connection's own presence relay + `Gone` set for the frame being built, merged and
    /// sorted ascending by `PlayerId` (host/mod Deviations, steps 4-6: `Host::build_frame`'s own
    /// two-loop merge over `PresenceTable::iter` and `ConnSlot::presence_relayed`). Reused scratch
    /// (`.claude/rules/hot-paths.md`): cleared, refilled, then drained (never left non-empty)
    /// every `build_frame` call.
    scratch_presence: Vec<(PlayerId, PresenceRelayOp<G>)>,
}

/// The last-wins kind of an entity op this tick (host/mod Deviations: `scratch_entity_ops`'s own
/// doc comment).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum EntityOpKind {
    Put,
    Gone,
}

/// One entry of [`Host::scratch_presence`] (host/mod Deviations, steps 4-6): either this tick's
/// relay of a held sample (fresh or re-relayed) or a `Gone` for a player whose table entry has
/// disappeared since this connection last saw it.
enum PresenceRelayOp<G: Game> {
    Sample { sample: G::Presence, age_ticks: u32 },
    Gone,
}

impl<G: Game> Host<G> {
    /// The live `Sim<G>`, once `sim_genesis` has run. `None` beforehand.
    pub fn sim(&self) -> Option<&Sim<G>> {
        self.sim.as_ref()
    }

    /// The `cacheChunks` config value, read but not yet wired anywhere (see
    /// [`SimConfig::cache_chunks`]'s own doc comment): exposed so a future milestone that does
    /// wire it does not also have to re-plumb it through `Host::init`.
    pub fn cache_chunks(&self) -> u32 {
        self.cache_chunks
    }

    /// Builds a `Host<G>` with a fresh, genesis'd `Sim<G>` directly from `WorldParams<G>`, no
    /// `Instance`/JSON config parsing (that is `Host::init`'s job, and ABI wiring is 15b's,
    /// Non-scope here): `testkit::Loopback`'s own constructor, and any other native test that
    /// wants a ready-to-tick `Host` without a fixture crate.
    #[cfg(any(test, feature = "testing"))]
    pub fn genesis_for_test(params: WorldParams<G>) -> Self
    where
        G::Global: Default,
    {
        Host {
            pending: None,
            cache_chunks: default_cache_chunks(),
            sim: Some(Sim::genesis(params)),
            outcomes: Vec::new(),
            warm: Warm::new(),
            conns: (0..MAX_CONNS).map(|_| None).collect(),
            ever_joined: vec![false; MAX_CONNS],
            pending_records: Vec::new(),
            chunk_versions: BTreeMap::new(),
            last_tick: Tick(0),
            scratch_roster: Vec::new(),
            scratch_entered: Vec::new(),
            scratch_left: Vec::new(),
            scratch_pristine: Vec::new(),
            scratch_snapshot: Vec::new(),
            scratch_tile_flat: Vec::new(),
            scratch_entity_ops: Vec::new(),
            scratch_action_players: Vec::new(),
            presence: PresenceTable::empty(),
            scratch_presence: Vec::new(),
        }
    }

    /// Testkit-only backdoor (host/mod Deviations): pushes a `Record::Action` directly onto the
    /// same queue `connect`/`disconnect` use, delivered at the next `tick()` through the existing
    /// `Sim::step` `Record::Action` path (M12b, unchanged). Exists because M16's own uplink
    /// admission pipeline (decode -> admit -> apply -> `ActionResults`) is Non-scope here, but
    /// this milestone's own frame-building tests need *some* way to change world state through a
    /// real `Sim::step` call rather than poking `Store` directly. Never reachable from the wire.
    #[cfg(any(test, feature = "testing"))]
    pub fn queue_action_for_test(&mut self, who: PlayerId, seq: u32, action: G::Action) {
        self.pending_records
            .push(Record::Action { who, seq, action });
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn debug_version(&self, chunk: ChunkCoord) -> u32 {
        self.chunk_versions.get(&chunk).copied().unwrap_or(0)
    }

    /// How many chunks [`Host::chunk_versions`] holds a version for -- the count of distinct
    /// chunks this host has ever seen a replicated change in. It is also the denominator the
    /// panning allocation test divides by: that test's ceiling is per *newly reached chunk*, since
    /// the host's remaining growth (overlays, versions) is proportional to territory reached and
    /// not to elapsed ticks (docs/plan/15-connection-and-subscriptions.md, fix round 3).
    #[cfg(any(test, feature = "testing"))]
    pub fn debug_chunk_version_count(&self) -> usize {
        self.chunk_versions.len()
    }

    /// `who`'s held presence sample, if any (test/diagnostic convenience, docs/plan/
    /// 19-presence-channel.md step 3): `Self::presence` has no public accessor of its own since
    /// nothing outside `Host` reads it yet (relay is steps 4-6's job).
    #[cfg(any(test, feature = "testing"))]
    pub fn debug_presence(&self, who: PlayerId) -> Option<G::Presence> {
        self.presence.get(who).map(|e| e.sample)
    }

    /// Every chunk `conn` is currently subscribed to (test/diagnostic convenience).
    #[cfg(any(test, feature = "testing"))]
    pub fn debug_subscribed(&self, conn: ConnId) -> Vec<ChunkCoord> {
        match self.conns.get(conn as usize) {
            Some(Some(slot)) => slot.subs.chunks().collect(),
            _ => Vec::new(),
        }
    }

    /// A connection slot's assigned player, if it is currently connected.
    pub fn player_of(&self, conn: ConnId) -> Option<PlayerId> {
        self.conns.get(conn as usize)?.as_ref().map(|s| s.player)
    }

    pub fn counters(&self, conn: ConnId) -> Option<ConnCounters> {
        self.conns.get(conn as usize)?.as_ref().map(|s| s.counters)
    }

    /// Implicit accept (Scope, "until M28"): assigns `PlayerId = conn + 1` (`0` is reserved,
    /// `game::PlayerId`'s own doc comment: "'none'", so the literal `PlayerId = conn` the brief
    /// names cannot mean the raw value when `conn == 0` -- host/mod Deviations), queues
    /// `Record::Player { Joined }` on first sight then `Connected`, delivered at the next `tick()`.
    pub fn connect(&mut self, conn: ConnId) -> PlayerId {
        assert!(
            (conn as usize) < MAX_CONNS,
            "connect: conn {conn} out of range (max {MAX_CONNS})"
        );
        let idx = conn as usize;
        let player = PlayerId(conn + 1);
        if !self.ever_joined[idx] {
            self.pending_records.push(Record::Player {
                who: player,
                ev: PlayerEvent::Joined,
            });
            self.ever_joined[idx] = true;
        }
        self.pending_records.push(Record::Player {
            who: player,
            ev: PlayerEvent::Connected,
        });
        self.conns[idx] = Some(ConnSlot {
            player,
            camera: None,
            subs: SubscriptionSet::new(crate::world::ChunkDims::new(G::CHUNK_BITS), G::TICK_RATE),
            first_frame_pending: true,
            counters: ConnCounters::default(),
            pending_results: Vec::new(),
            highest_admitted_seq: 0,
            presence_relayed: BTreeMap::new(),
        });
        player
    }

    /// Queues `Record::Player { Disconnected }` (grace: M28) and frees the slot immediately: no
    /// more `build_frame`/`on_uplink` traffic for `conn` until a fresh `connect`. docs/plan/
    /// 19-presence-channel.md steps 4-6 (0001: "on disconnect the host tells clients at once and
    /// drops the sample from relay"): the player's held sample is dropped from [`Self::presence`]
    /// right here, immediately -- not deferred to the next `tick()`. `Host::build_frame`'s own
    /// `Gone` detection (a connection's `ConnSlot::presence_relayed` entry with no matching
    /// `PresenceTable` entry) is what turns this into a wire `Gone` for every *other* connection's
    /// very next `build_frame`, satisfying "at once" without a separate queued-event mechanism.
    pub fn disconnect(&mut self, conn: ConnId) {
        let idx = conn as usize;
        let player = match self.conns.get(idx) {
            Some(Some(slot)) => Some(slot.player),
            _ => None,
        };
        if let Some(player) = player {
            self.pending_records.push(Record::Player {
                who: player,
                ev: PlayerEvent::Disconnected,
            });
            self.presence.remove(player);
        }
        if let Some(slot) = self.conns.get_mut(idx) {
            *slot = None;
        }
    }

    /// Decodes an `UplinkBatch` (0011): records the latest camera report and `bytes_up`, and runs
    /// every carried action through the admit pipeline (docs/plan/16-action-round-trip.md Scope):
    /// decode (`WireError`/a failed canonical decode -> `Err`, a protocol error that closes the
    /// connection, 0004 step 1 -- **not logged**, matching an admission `Rejected` below), drop a
    /// resend (`seq <=` the highest `seq` this connection has ever had *admitted*, silently --
    /// 0004: "a resent action is never applied twice"), then `G::admit`: failure queues an
    /// immediate `Outcome::Rejected` on this connection's `pending_results` (0004: "not logged");
    /// success appends `Record::Action` to `pending_records`, collected for the next `tick()`
    /// (0004 step 3). docs/plan/19-presence-channel.md step 3: a carried presence sample is decoded
    /// and recorded into `Self::presence` (32-byte-oversize or malformed bytes counted and dropped,
    /// world-cap violations dropped) before the action path runs, so `G::admit` sees the update from
    /// the *same* batch a witness-carrying action arrived in. An unknown connection is silently
    /// ignored -- untrusted input never panics.
    ///
    /// **Dedup floor: `ConnSlot::highest_admitted_seq`, not a single `Store::last_seq` snapshot**
    /// (gate fix, docs/plan/16-action-round-trip.md: `Store::last_seq` only advances inside
    /// `Sim::step`, at the next `tick()` -- a single snapshot taken at the top of this call cannot
    /// see an action this *same* connection had admitted into `pending_records` moments earlier by
    /// an *earlier* `on_uplink` call in the same tick-to-tick window, and `worker/sim.ts` drains
    /// the uplink ring, and `poll_uplink` flushes a non-empty outbox immediately, so more than one
    /// `on_uplink` call per tick window is ordinary. Verified: resending the same `seq` before the
    /// next `step()` used to apply it twice). Tracked as a running value across every action in
    /// this call (so an in-batch duplicate is caught too, not only a duplicate across two calls),
    /// seeded from `ConnSlot::highest_admitted_seq` and folded against `Store::last_seq` so a
    /// resend after a real reconnect (a fresh `ConnSlot`, `highest_admitted_seq` back at 0) still
    /// dedups correctly against the player's persisted history.
    ///
    /// `Err(UplinkError)` on a malformed batch or a malformed action payload: the caller
    /// (`sim_admit`) maps that to `Status::Decode`, which is what tells `SimHost` (TS, 15b/16
    /// step 3) to close the connection. Every action already admitted earlier in the same batch,
    /// before the malformed one was reached, keeps its effect -- only the batch's own further
    /// decoding stops.
    pub fn on_uplink(&mut self, conn: ConnId, bytes: &[u8]) -> Result<(), UplinkError> {
        let idx = conn as usize;
        let Some(Some(slot)) = self.conns.get_mut(idx) else {
            return Ok(());
        };
        slot.counters.bytes_up += bytes.len() as u64;
        let player = slot.player;
        let mut highest_seen = slot.highest_admitted_seq;

        let mut raw_actions: Vec<(u32, &[u8])> = Vec::new();
        let batch = match UplinkReader::read(bytes, |seq, action_bytes| {
            raw_actions.push((seq, action_bytes));
        }) {
            Ok(batch) => batch,
            Err(_) => return Err(UplinkError),
        };
        if let Some(camera) = batch.camera
            && let Some(Some(slot)) = self.conns.get_mut(idx)
        {
            slot.camera = Some(camera);
        }
        // docs/plan/19-presence-channel.md step 3: before the `raw_actions.is_empty()` early
        // return below -- a steady-state uplink batch typically carries a presence sample with no
        // actions at all (0010 "Rates": "the latest camera report and presence sample ... plus
        // pending actions"), so handling presence only on the action path would silently discard
        // it most of the time.
        if let Some(raw) = batch.presence {
            // Planning decisions: "The 32-byte limit is enforced per encoded sample ... not at
            // init". Checked before attempting to decode (cheap, and avoids ever handing
            // `decode_canonical` more bytes than a well-formed sample could legitimately be).
            let sample = if raw.len() > crate::presence::MAX_ENCODED_BYTES {
                None
            } else {
                decode_canonical::<G::Presence>(raw).ok()
            };
            match sample {
                // World-cap check (0007 §2's own valid coordinate range, `crate::world_access`'s
                // convention elsewhere): an untrusted client can report any `pos()` at all, so the
                // host clamps at the door -- dropped, not clamped-and-kept, since a game's `admit`
                // tolerance check (this fixture's own `TooFar`) already treats "no sample" and "an
                // implausible one" the same way, and synthesising a clamped-but-fake position would
                // only make an implausible claim look more plausible.
                Some(sample) if sample.pos().tile().in_range() => {
                    self.presence.on_sample(player, sample, self.last_tick);
                    // docs/plan/19-presence-channel.md steps 4-6: bumped only here, the accepted
                    // path (`ConnCounters::presence_bytes_up`'s own doc comment).
                    if let Some(Some(slot)) = self.conns.get_mut(idx) {
                        slot.counters.presence_bytes_up += 1 + raw.len() as u64;
                    }
                }
                Some(_) => {}
                None => {
                    if let Some(Some(slot)) = self.conns.get_mut(idx) {
                        slot.counters.presence_oversize += 1;
                    }
                }
            }
        }
        if raw_actions.is_empty() {
            return Ok(());
        }
        let Some(sim) = self.sim.as_ref() else {
            // No world yet: an action arriving before `sim_genesis` has run has nothing to admit
            // against. Untrusted-input tolerance, not expected in production (`connect` itself
            // requires a live `Sim`, host/mod Deviations).
            return Ok(());
        };
        let store_last_seq = sim.authority().store().last_seq(player).unwrap_or(0);
        if store_last_seq > highest_seen {
            highest_seen = store_last_seq;
        }
        for (seq, raw) in &raw_actions {
            let seq = *seq;
            if seq <= highest_seen {
                continue; // resend dedup: already admitted (queued or applied), silently dropped.
            }
            let action = match decode_canonical::<G::Action>(raw) {
                Ok(action) => action,
                Err(_) => {
                    // Persist whatever was genuinely admitted earlier in this same call before
                    // reporting the protocol error -- those actions keep their effect.
                    if let Some(Some(slot)) = self.conns.get_mut(idx) {
                        slot.highest_admitted_seq = highest_seen;
                    }
                    return Err(UplinkError);
                }
            };
            let result = {
                let sim = self.sim.as_ref().expect("checked above");
                G::admit(
                    sim.authority() as &dyn WorldRead<G>,
                    &self.presence,
                    player,
                    &action,
                )
            };
            match result {
                Ok(()) => {
                    highest_seen = seq;
                    self.pending_records.push(Record::Action {
                        who: player,
                        seq,
                        action,
                    });
                }
                Err(reject) => {
                    // Not folded into `highest_seen`: 0004 never logs an admission reject, so a
                    // resend of this exact `seq` is safe to re-admit (it touches no sim state).
                    if let Some(Some(slot)) = self.conns.get_mut(idx) {
                        slot.pending_results.push(Outcome {
                            seq,
                            result: Err(Rejected::Game(reject)),
                        });
                    }
                }
            }
        }
        if let Some(Some(slot)) = self.conns.get_mut(idx) {
            slot.highest_admitted_seq = highest_seen;
        }
        Ok(())
    }

    /// Runs one tick: delivers every `connect`/`disconnect` queued since the last `tick()`, steps
    /// `Sim<G>`, stamps [`Host::chunk_versions`] for every chunk this tick touched, and refreshes
    /// every connection's [`SubscriptionSet`] from its latest camera report (host/mod Deviations:
    /// re-evaluated every tick, not only on a fresh uplink, so hysteresis advances in ticks exactly
    /// as Planning decisions requires even when uplinks arrive less than once a tick).
    pub fn tick(&mut self) {
        let Host {
            sim,
            pending_records,
            outcomes,
            chunk_versions,
            last_tick,
            conns,
            scratch_action_players,
            ..
        } = self;
        let Some(sim) = sim.as_mut() else { return };
        // docs/plan/16-action-round-trip.md Deviations: gathered *before* `sim.step` drains
        // `pending_records`, since `Sim::step` pushes one `Outcome` per `Record::Action` it sees,
        // in the same relative order, but never the `who` (0004's `Ack<G>` shape, unchanged) --
        // this is how each outcome below finds its way back to the connection that sent it.
        scratch_action_players.clear();
        for record in pending_records.iter() {
            if let Record::Action { who, .. } = record {
                scratch_action_players.push(*who);
            }
        }
        let completed = sim.tick();
        sim.step(pending_records, outcomes);
        pending_records.clear();
        *last_tick = completed;
        for (scopes, _delta) in sim.authority().changes() {
            for scope in scopes.iter() {
                if let Scope::Chunk(c) = scope {
                    chunk_versions.insert(c, completed.0);
                }
            }
        }
        for (who, outcome) in scratch_action_players.drain(..).zip(outcomes.drain(..)) {
            if let Some(slot) = conns.iter_mut().flatten().find(|s| s.player == who) {
                slot.pending_results.push(outcome);
            }
        }
        for slot in conns.iter_mut().flatten() {
            if let Some(camera) = slot.camera {
                slot.subs.update(camera, completed);
            }
        }
    }

    /// Closes out the tick every connection's `build_frame` has now read from: clears the
    /// `ChangeLog` for the next `tick()`. Call once per `tick()`, after every connection's
    /// `build_frame` (host/mod Deviations: this milestone's own per-tick call order).
    pub fn seal(&mut self) {
        if let Some(sim) = self.sim.as_mut() {
            sim.authority_mut().clear_changes();
        }
    }

    /// Builds one connection's frame for the tick `tick()` last completed into `out`, returning
    /// the byte count, or `0` when there is nothing to say (Scope: heartbeat timing is M31's).
    pub fn build_frame(&mut self, conn: ConnId, out: &mut [u8]) -> usize {
        let idx = conn as usize;
        let Some(sim) = self.sim.as_ref() else {
            return 0;
        };
        let Some(slot) = self.conns.get_mut(idx).and_then(|s| s.as_mut()) else {
            return 0;
        };

        // Deviations #1: chunksWarmed becomes reachable once a real subscribed view feeds this.
        self.warm.set_view(conn, slot.subs.warm_rect());

        let store = sim.authority().store();
        let changes = sim.authority().changes();
        let first = slot.first_frame_pending;
        let ack_seq = store.last_seq(slot.player).unwrap_or(0);

        // -- Global: roster (incremental unless `first`) + value (on change or `first`) --------
        self.scratch_roster.clear();
        if first {
            for i in 0..store.player_count() {
                if let Some(p) = store.player_id_at(i) {
                    let online = store.player_slot(p).map(|s| s.online).unwrap_or(false);
                    self.scratch_roster.push((p, online));
                }
            }
        } else {
            for (_, d) in changes {
                if let Delta::Roster { who, online } = d {
                    match self.scratch_roster.iter_mut().find(|(w, _)| w == who) {
                        Some(entry) => entry.1 = *online,
                        None => self.scratch_roster.push((*who, *online)),
                    }
                }
            }
        }
        let global_value_changed = first
            || changes
                .iter()
                .any(|(_, d)| matches!(d, Delta::Global { .. }));
        let want_roster = !self.scratch_roster.is_empty();
        let want_global_value = global_value_changed;

        let player_changed = first
            || changes
                .iter()
                .any(|(_, d)| matches!(d, Delta::Player { who, .. } if *who == slot.player));

        // -- Enter / leave, sorted by (cy, cx) --------------------------------------------------
        self.scratch_entered.clear();
        self.scratch_entered.extend_from_slice(slot.subs.entered());
        insertion_sort_by_key(&mut self.scratch_entered, |c| (c.y, c.x));
        self.scratch_left.clear();
        self.scratch_left.extend_from_slice(slot.subs.left());
        insertion_sort_by_key(&mut self.scratch_left, |c| (c.y, c.x));

        self.scratch_pristine.clear();
        self.scratch_snapshot.clear();
        for &c in &self.scratch_entered {
            let has_overlay = store.terrain().overlay(c).is_some_and(|o| !o.is_empty());
            // M21: a `ChunkIndex` lookup (docs/plan/21-entities-and-timers.md, `encode_chunk_
            // snapshot`'s own doc comment) -- the O(all entities) scan this replaced is gone, not
            // merely deferred.
            let has_entity = !store.chunk_overlapping(c).is_empty();
            if has_overlay || has_entity {
                self.scratch_snapshot.push(c);
            } else {
                self.scratch_pristine.push(c);
            }
        }

        // -- ChunkDeltas: tiles + entity ops for subscribed, non-entering chunks ---------------
        self.scratch_tile_flat.clear();
        self.scratch_entity_ops.clear();
        let dims = crate::world::ChunkDims::new(G::CHUNK_BITS);
        for (scopes, delta) in changes {
            match delta {
                Delta::Tile { pos, tile } => {
                    let chunk = chunk_of::<G>(*pos);
                    if slot.subs.is_subscribed(chunk) && !self.scratch_entered.contains(&chunk) {
                        let index = dims.local_index(*pos);
                        match self
                            .scratch_tile_flat
                            .iter_mut()
                            .find(|(c, i, _)| *c == chunk && *i == index)
                        {
                            Some(entry) => entry.2 = *tile,
                            None => self.scratch_tile_flat.push((chunk, index, *tile)),
                        }
                    }
                }
                Delta::EntityPut { id, entity } => {
                    // M21 (docs/plan/21-entities-and-timers.md Scope, "Anchor-only entity
                    // delivery" widened together with `Authority`'s scope derivation and
                    // `encode_chunk_snapshot`): `scopes` is now every chunk under the old *and*
                    // new footprint (up to 8, `Scopes::from_chunks`), not a single anchor chunk.
                    // Per scoped chunk, ask the `ChunkIndex` whether the entity's *current*
                    // (post-write) footprint still overlaps it:
                    //   - `deliver_put`: some scoped chunk is subscribed, not entering this tick,
                    //     and currently overlapped -> this connection needs an explicit `Put`
                    //     (an entering chunk gets the same value for free via `ChunkSnapshots`).
                    //   - `visible_anywhere`: some scoped chunk (entering or not) is subscribed
                    //     and currently overlapped -> the entity is visible to this connection by
                    //     *some* means, so a stale `Gone` must never be sent (an entity that just
                    //     entered scope through a snapshot must not be immediately un-put by a
                    //     `ChunkDeltas` `Gone` for a chunk it simultaneously left, since a frame's
                    //     sections apply `ChunkSnapshots` before `ChunkDeltas`).
                    //   - `left_a_delta_chunk`: some scoped chunk is subscribed, not entering, and
                    //     no longer overlapped -- a chunk this connection was previously told
                    //     about the entity through, that it has now left.
                    // A footprint of 1x1 reproduces the pre-M21 anchor-only decision exactly (its
                    // one scope chunk is trivially "current").
                    let _ = entity;
                    let mut deliver_put = false;
                    let mut visible_anywhere = false;
                    let mut left_a_delta_chunk = false;
                    for scope in scopes.iter() {
                        let Scope::Chunk(c) = scope else { continue };
                        if !slot.subs.is_subscribed(c) {
                            continue;
                        }
                        let entering = self.scratch_entered.contains(&c);
                        let currently_overlaps =
                            store.chunk_overlapping(c).binary_search(id).is_ok();
                        if currently_overlaps {
                            visible_anywhere = true;
                            if !entering {
                                deliver_put = true;
                            }
                        } else if !entering {
                            left_a_delta_chunk = true;
                        }
                    }
                    if deliver_put {
                        upsert_entity_op(&mut self.scratch_entity_ops, *id, EntityOpKind::Put);
                    } else if !visible_anywhere && left_a_delta_chunk {
                        upsert_entity_op(&mut self.scratch_entity_ops, *id, EntityOpKind::Gone);
                    }
                }
                Delta::EntityGone { id } => {
                    let in_scope = scopes.iter().any(|s| match s {
                        Scope::Chunk(c) => {
                            slot.subs.is_subscribed(c) && !self.scratch_entered.contains(&c)
                        }
                        _ => false,
                    });
                    if in_scope {
                        upsert_entity_op(&mut self.scratch_entity_ops, *id, EntityOpKind::Gone);
                    }
                }
                // Handled above (Global section): not chunk-scoped.
                Delta::Player { .. } | Delta::Global { .. } | Delta::Roster { .. } => {}
                // Deviations item 3: `Ack` never reaches the `ChangeLog` at all
                // (`Authority::record_ack` applies it straight to `Store`, M12b Deviations), so
                // this arm is unreachable in practice -- named explicitly rather than folded into
                // a catch-all, per this milestone's own instruction to account for it.
                Delta::Ack { .. } => {}
            }
        }
        insertion_sort_by_key(&mut self.scratch_tile_flat, |(c, i, _)| (c.y, c.x, *i));

        // -- Presence: relay, >= 1 Hz re-relay, Gone (docs/plan/19-presence-channel.md steps 4-6,
        // Planning decisions) --------------------------------------------------------------------
        self.scratch_presence.clear();
        // 0010 "Rates" ties the re-relay floor to the sim's own tick rate ("at least once per
        // second"), not a hardcoded 20: `G::TICK_RATE.hz_value()` ticks is exactly one second for
        // this game.
        let rerelay_ticks = G::TICK_RATE.hz_value();
        for (who, entry) in self.presence.iter() {
            // 0001 / 0010 host drop rule: "a player's own sample is never relayed back to that
            // player".
            if who == slot.player {
                continue;
            }
            let chunk = chunk_of::<G>(entry.sample.pos().tile());
            if !slot.subs.is_subscribed(chunk) {
                continue;
            }
            let due = match slot.presence_relayed.get(&who) {
                None => true,
                Some(&last) => {
                    entry.received_at.0 > last.0
                        || self.last_tick.0.wrapping_sub(last.0) >= rerelay_ticks
                }
            };
            if due {
                let age_ticks = self.last_tick.0.saturating_sub(entry.received_at.0);
                self.scratch_presence.push((
                    who,
                    PresenceRelayOp::Sample {
                        sample: entry.sample,
                        age_ticks,
                    },
                ));
            }
        }
        // `Gone`: every player this connection has previously been relayed a sample for, whose
        // table entry has since disappeared (`Host::disconnect`'s own `presence.remove` call) --
        // fires exactly once per connection, the very next `build_frame` after the disconnect.
        for (&who, _) in slot.presence_relayed.iter() {
            if self.presence.get(who).is_none() {
                self.scratch_presence.push((who, PresenceRelayOp::Gone));
            }
        }
        insertion_sort_by_key(&mut self.scratch_presence, |(who, _)| who.0);

        // docs/plan/16-action-round-trip.md Scope: "in seq order". Robust against admission-time
        // rejections (pushed by `on_uplink`, arrival order) and apply-time outcomes (pushed by
        // `tick()`, `pending_records` order) interleaving out of seq order across ticks; cheap,
        // like every other per-connection scratch sort here (a handful of entries at most).
        insertion_sort_by_key(&mut slot.pending_results, |o| o.seq);
        let want_action_results = !slot.pending_results.is_empty();

        // -- Nothing to say? ---------------------------------------------------------------------
        if !first
            && !want_roster
            && !want_global_value
            && !player_changed
            && !want_action_results
            && self.scratch_pristine.is_empty()
            && self.scratch_snapshot.is_empty()
            && self.scratch_left.is_empty()
            && self.scratch_tile_flat.is_empty()
            && self.scratch_entity_ops.is_empty()
            && self.scratch_presence.is_empty()
        {
            return 0;
        }

        let header = FrameHeader {
            tick: self.last_tick.0,
            ack_seq,
        };
        let mut sink = crate::bytes::SliceSink::new(out);
        let mut fw = FrameWriter::new(&mut sink, header);

        // `ActionResults` is section id 1, the lowest: `FrameWriter::section` requires strictly
        // ascending ids, so this must be written before `Global` (id 2).
        if want_action_results {
            let results = &slot.pending_results;
            fw.section(SectionId::ActionResults, |s| {
                ActionResultsWriter::write::<G>(s, results.iter());
            });
        }

        if want_roster || want_global_value {
            let roster = &self.scratch_roster;
            let global_val = store.global();
            fw.section(SectionId::Global, |s| {
                write_global::<G>(
                    s,
                    want_roster.then(|| roster.iter().copied()),
                    want_global_value.then_some(global_val),
                );
            });
        }
        if player_changed && let Ok(state) = store.player(slot.player) {
            fw.section(SectionId::OwnPlayer, |s| {
                write_own_player::<G>(s, slot.player, state);
            });
        }
        if !self.scratch_pristine.is_empty() {
            let pristine = &self.scratch_pristine;
            fw.section(SectionId::ChunkEnterPristine, |s| {
                let mut w = ChunkCoordListWriter::new();
                for &c in pristine {
                    w.write(s, c);
                }
            });
        }
        if !self.scratch_snapshot.is_empty() {
            let snapshot = &self.scratch_snapshot;
            let version_of = |c: ChunkCoord| self.chunk_versions.get(&c).copied().unwrap_or(0);
            fw.section(SectionId::ChunkSnapshots, |s| {
                let mut w = SnapshotWriter::new();
                for &c in snapshot {
                    w.write_chunk(s, store, c, version_of(c));
                }
            });
        }
        if !self.scratch_left.is_empty() {
            let left = &self.scratch_left;
            fw.section(SectionId::ChunkLeaves, |s| {
                let mut w = ChunkCoordListWriter::new();
                for &c in left {
                    w.write(s, c);
                }
            });
        }
        if !self.scratch_tile_flat.is_empty() || !self.scratch_entity_ops.is_empty() {
            let tiles = &self.scratch_tile_flat;
            let ops = &self.scratch_entity_ops;
            fw.section(SectionId::ChunkDeltas, |s| {
                write_chunk_deltas_flat::<G>(s, tiles, ops, store);
            });
        }
        if !self.scratch_presence.is_empty() {
            let presence_ops = &self.scratch_presence;
            fw.section(SectionId::Presence, |s| {
                write_presence_flat::<G>(s, presence_ops);
            });
        }

        let _ = fw;
        // `SliceSink`'s own overflow convention: a too-small `out` never panics, it just drops the
        // overflow bytes silently and `finish()` reports it. `build_frame`'s `out` is caller-sized
        // (a real connection's send buffer, `testkit::Loopback`'s own fixed frame buffer in
        // tests); running out of room here is Non-scope (0010's pacing/backpressure, M31), so a
        // `Full` result is treated as "wrote nothing" rather than plumbed through `build_frame`'s
        // `usize`-only return.
        let n = sink.finish().unwrap_or(0);
        slot.counters.frames += 1;
        slot.counters.bytes_down += n as u64;
        slot.counters.chunk_enters_pristine += self.scratch_pristine.len() as u64;
        slot.counters.chunk_snapshots += self.scratch_snapshot.len() as u64;
        slot.counters.chunk_leaves += self.scratch_left.len() as u64;
        slot.first_frame_pending = false;
        // This connection's own results have now had their one chance to ride a frame (Scope:
        // "outcomes go to the sender's next build_frame"); clear so `pending_results` never grows
        // past what a single tick's worth of admissions/applies can add (host/mod Deviations).
        slot.pending_results.clear();
        // Commits what this build decided to send (docs/plan/19-presence-channel.md steps 4-6),
        // independent of `SliceSink`'s own overflow outcome -- the same "committed regardless of a
        // truncated write" convention every other per-tick bookkeeping field above already follows
        // (`first_frame_pending`, `pending_results.clear()`).
        for (who, op) in self.scratch_presence.drain(..) {
            match op {
                PresenceRelayOp::Sample { .. } => {
                    slot.presence_relayed.insert(who, self.last_tick);
                }
                PresenceRelayOp::Gone => {
                    slot.presence_relayed.remove(&who);
                }
            }
        }
        n
    }

    /// M05 state hash over `encode_chunk_snapshot` of every chunk `conn` is subscribed to (ordered
    /// by coord, the ordering key only), plus `Global` and `OwnPlayer` for that connection's
    /// player (Scope "region_hash"). Matches `client::Replica::region_hash` byte for byte once the
    /// two sides agree; `0` if `conn` is not connected or the sim has not been genesis'd.
    pub fn region_hash(&self, conn: ConnId) -> u64 {
        let Some(sim) = self.sim.as_ref() else {
            return 0;
        };
        let Some(Some(slot)) = self.conns.get(conn as usize) else {
            return 0;
        };
        let store = sim.authority().store();
        let mut chunks: Vec<ChunkCoord> = slot.subs.chunks().collect();
        insertion_sort_by_key(&mut chunks, |c| (c.y, c.x));
        let mut h = crate::hash::Fnv64::new();
        for c in chunks {
            let version = self.chunk_versions.get(&c).copied().unwrap_or(0);
            encode_chunk_snapshot(store, c, version, &mut h);
        }
        crate::codec::encode_to(store.global(), &mut h).expect("hashing G::Global cannot fail");
        if let Ok(player) = store.player(slot.player) {
            crate::codec::encode_to(player, &mut h).expect("hashing G::Player cannot fail");
        }
        h.finish()
    }
}

/// Stable, allocation-free insertion sort by `key` (host/mod Deviations: every per-tick scratch
/// buffer here is small -- a connection's own per-tick chunk/tile/entity touch count -- so O(n^2)
/// is cheap and, unlike `[T]::sort_by_key`, guaranteed not to allocate a merge buffer).
fn insertion_sort_by_key<T, K: PartialOrd>(v: &mut [T], key: impl Fn(&T) -> K) {
    for i in 1..v.len() {
        let mut j = i;
        while j > 0 && key(&v[j - 1]) > key(&v[j]) {
            v.swap(j - 1, j);
            j -= 1;
        }
    }
}

/// Last-write-wins upsert into a connection's per-tick entity-op list.
fn upsert_entity_op(
    ops: &mut Vec<(crate::game::EntityId, EntityOpKind)>,
    id: crate::game::EntityId,
    kind: EntityOpKind,
) {
    match ops.iter_mut().find(|(existing, _)| *existing == id) {
        Some(entry) => entry.1 = kind,
        None => ops.push((id, kind)),
    }
}

/// Hand-written `ChunkDeltas` (section 7) body, from a flat, `(cy, cx, index)`-sorted tile-delta
/// list and a per-tick entity-op list (host/mod Deviations, `Host::scratch_tile_flat`'s own doc
/// comment): the same wire shape `wire::write_chunk_deltas` produces, but built directly from this
/// module's own flat scratch buffers instead of a slice-of-slices (which cannot be a struct field).
fn write_chunk_deltas_flat<G: Game>(
    sink: &mut (impl crate::bytes::ByteSink + ?Sized),
    tiles: &[(ChunkCoord, u16, crate::world::Tile)],
    ops: &[(crate::game::EntityId, EntityOpKind)],
    store: &crate::store::Store<G>,
) {
    let mut n_groups: u64 = 0;
    let mut i = 0;
    while i < tiles.len() {
        n_groups += 1;
        let chunk = tiles[i].0;
        while i < tiles.len() && tiles[i].0 == chunk {
            i += 1;
        }
    }
    sink.put_varint(n_groups);
    let mut coords = ChunkCoordListWriter::new();
    let mut i = 0;
    while i < tiles.len() {
        let chunk = tiles[i].0;
        coords.write(sink, chunk);
        let start = i;
        while i < tiles.len() && tiles[i].0 == chunk {
            i += 1;
        }
        let group = &tiles[start..i];
        sink.put_varint(group.len() as u64);
        let mut prev_index: i64 = -1;
        for &(_, index, tile) in group {
            let gap = index as i64 - (prev_index + 1);
            sink.put_varint(gap as u64);
            sink.put(&tile.to_le_bytes());
            prev_index = index as i64;
        }
    }
    for &(id, kind) in ops {
        match kind {
            EntityOpKind::Put => {
                sink.put_u8(0);
                sink.put_varint(id.0 as u64);
                if let Some(entity) = store.entity(id) {
                    crate::codec::encode_to(entity, sink)
                        .expect("encoding an entity into a ByteSink cannot fail");
                }
            }
            EntityOpKind::Gone => {
                sink.put_u8(1);
                sink.put_varint(id.0 as u64);
            }
        }
    }
}

/// Hand-written `Presence` (section 8) body, from [`Host::scratch_presence`] (already merged and
/// sorted ascending by `PlayerId`, `build_frame`'s own two-loop pass): the same wire shape
/// `wire::write_presence` produces (`wire/CLAUDE.md`, `wire/presence.rs`'s own module doc
/// comment), but built directly from this module's own owned scratch entries rather than a
/// temporary `Vec<wire::PresenceOp>` -- the same reason [`write_chunk_deltas_flat`] exists instead
/// of calling `wire::write_chunk_deltas` (`.claude/rules/hot-paths.md`'s steady-state convention:
/// `Host::build_frame` runs every tick per connection).
fn write_presence_flat<G: Game>(
    sink: &mut (impl crate::bytes::ByteSink + ?Sized),
    ops: &[(PlayerId, PresenceRelayOp<G>)],
) {
    for (who, op) in ops {
        sink.put_varint(who.0 as u64);
        match op {
            PresenceRelayOp::Sample { sample, age_ticks } => {
                sink.put_u8(0);
                sink.put_varint(*age_ticks as u64);
                crate::codec::encode_to(sample, sink)
                    .expect("encoding a presence sample into a ByteSink cannot fail");
            }
            PresenceRelayOp::Gone => {
                sink.put_u8(1);
            }
        }
    }
}

impl<G: Game> Instance for Host<G>
where
    G::Global: Default,
{
    fn init(role: Role, game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status> {
        if role != Role::Sim {
            return Err(Status::BadConfig);
        }
        let cfg: SimConfig<<G::Worldgen as Worldgen>::Params> =
            serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)?;

        // M21: the 0007 §8 memory-split init check, against the real `size_of::<G::Entity>()`
        // (not the nominal 128 B the state-budget check uses -- a game whose entity type happens
        // to be larger is exactly what this catches). A clean startup error, not an allocator
        // failure partway through the first tick.
        let dims = crate::world::ChunkDims::new(G::CHUNK_BITS);
        let cache_bytes = cfg.cache_chunks as u64 * dims.slab_bytes() as u64;
        let entity_bytes = cfg.max_entities as u64 * size_of::<G::Entity>() as u64;
        let overlay_bytes = cfg.max_modified_tiles as u64 * OVERLAY_ENTRY_ESTIMATE_BYTES;
        let computed = cache_bytes
            + entity_bytes
            + overlay_bytes
            + CHUNK_INDEX_ESTIMATE_BYTES
            + SLACK_ESTIMATE_BYTES;
        if computed > cfg.arena_bytes as u64 {
            return Err(Status::BudgetExceedsArena);
        }

        layout.region(RegionId::Rx, SIM_RX_BYTES);
        layout.region(RegionId::Tx, SIM_TX_BYTES);
        Ok(Host {
            pending: Some(WorldParams {
                seed: cfg.seed.0,
                worldgen: cfg.params,
                max_entities: cfg.max_entities,
                max_modified_tiles: cfg.max_modified_tiles,
                max_action_growth: cfg.max_action_growth,
            }),
            cache_chunks: cfg.cache_chunks,
            sim: None,
            outcomes: Vec::new(),
            warm: Warm::new(),
            conns: (0..MAX_CONNS).map(|_| None).collect(),
            ever_joined: vec![false; MAX_CONNS],
            pending_records: Vec::new(),
            chunk_versions: BTreeMap::new(),
            last_tick: Tick(0),
            scratch_roster: Vec::new(),
            scratch_entered: Vec::new(),
            scratch_left: Vec::new(),
            scratch_pristine: Vec::new(),
            scratch_snapshot: Vec::new(),
            scratch_tile_flat: Vec::new(),
            scratch_entity_ops: Vec::new(),
            scratch_action_players: Vec::new(),
            presence: PresenceTable::empty(),
            scratch_presence: Vec::new(),
        })
    }

    fn sim_genesis(&mut self) -> Status {
        if self.sim.is_some() {
            return Status::AlreadyInitialised;
        }
        let Some(params) = self.pending.take() else {
            return Status::AlreadyInitialised;
        };
        self.sim = Some(Sim::genesis(params));
        Status::Ok
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: `host::Host::connect` (native,
    /// unchanged since M15). Out-of-range `conn` is `Host::connect`'s own `assert!` (a TS-side
    /// contract violation -- `SimHost.accept` is what allocates `ConnId`s within `MAX_CONNS` -- not
    /// untrusted wire input), so it is not pre-checked here.
    fn sim_connect(&mut self, conn: u32) -> Status {
        self.connect(conn);
        Status::Ok
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: `host::Host::disconnect` (native,
    /// unchanged since M15) already tolerates an unknown/out-of-range `conn` as a no-op.
    fn sim_disconnect(&mut self, conn: u32) -> Status {
        self.disconnect(conn);
        Status::Ok
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: `sim_admit(conn, len)` -- `rx` (the
    /// first `len` bytes of `Rx`) is one whole uplink batch, routed to `host::Host::on_uplink`.
    /// docs/plan/16-action-round-trip.md: `on_uplink` now also runs every carried action through
    /// the admit pipeline; `Status::Decode` on `Err` (a malformed batch or a malformed action
    /// payload, 0004 step 1's protocol error) is what tells the caller (`SimHost`, TS) to close
    /// the connection. An unknown connection is still tolerated silently (`Ok`).
    fn sim_admit(&mut self, conn: u32, rx: &[u8]) -> Status {
        match self.on_uplink(conn, rx) {
            Ok(()) => Status::Ok,
            Err(UplinkError) => Status::Decode,
        }
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: `sim_tick()` becomes real, routing
    /// through `host::Host::tick` (native, connection- and subscription-aware) instead of M13's
    /// bare `sim.step(&[], ..)`. **Seals the *previous* tick's `ChangeLog` first, not the one this
    /// call is about to build** (Deviations, "seal timing"): `Loopback::step`'s reference order is
    /// `tick()` -- per-connection `build_frame` -- `seal()` inside one Rust call, but the ABI splits
    /// those across separate exports (`sim_build_frame` is called once per connection, from TS,
    /// between two `sim_tick()` calls) with no export of its own for `seal()`. Nothing observes
    /// `ChangeLog` between the last `sim_build_frame` of a tick and the next `sim_tick()` call
    /// (`region_hash`/`debug_*` never read it), so sealing at the top of the *next* `sim_tick()`
    /// is behaviourally identical to sealing right after that tick's last `build_frame` -- it is
    /// simply where the call lands. A no-op on the very first `sim_tick()` after genesis (`seal`
    /// clears an already-empty log); the final tick's own `ChangeLog` is never cleared before the
    /// instance is dropped, which is memory, not correctness (nothing reads it again).
    fn sim_tick(&mut self) -> Status {
        if self.sim.is_none() {
            return Status::NotInitialised;
        }
        self.seal();
        self.tick();
        Status::Ok
    }

    fn sim_hash(&mut self) -> u64 {
        self.sim.as_ref().map_or(0, Sim::state_hash)
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: `sim_build_frame(conn)` becomes
    /// real, routing through `host::Host::build_frame` (native, unchanged since M15) into `tx`
    /// (the whole `Tx` region for this role, `SIM_TX_BYTES`).
    fn sim_build_frame(&mut self, conn: u32, tx: &mut [u8]) -> Result<u32, Status> {
        if self.sim.is_none() {
            return Err(Status::NotInitialised);
        }
        Ok(self.build_frame(conn, tx) as u32)
    }

    fn sim_seal_frame(&mut self, _persist: &mut [u8]) -> Result<u32, Status> {
        if self.sim.is_none() {
            return Err(Status::NotInitialised);
        }
        // Non-scope (Storage, snapshots, real log bytes: M22): always 0 until then.
        Ok(0)
    }

    fn sim_warm_one(&mut self) -> u32 {
        let Some(sim) = self.sim.as_ref() else {
            return 0;
        };
        let terrain = sim.authority().store().terrain();
        u32::from(self.warm.warm_one(terrain).is_some())
    }

    /// "20 Hz is hardcoded" gap (docs/plan/13-sim-host-tick-loop.md): `G`'s own real rate, not
    /// the trait default.
    fn tick_hz(&mut self) -> u32 {
        G::TICK_RATE.hz_value()
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: `Host::region_hash(conn)`, two LE
    /// `u32` into `result` (`sim_hash`'s own crossing shape). `engine/test`-only.
    fn sim_region_hash(&mut self, conn: u32, result: &mut [u8]) -> Status {
        let Some(out) = result.get_mut(..8) else {
            return Status::BadLength;
        };
        let hash = self.region_hash(conn);
        out[0..4].copy_from_slice(&(hash as u32).to_le_bytes());
        out[4..8].copy_from_slice(&((hash >> 32) as u32).to_le_bytes());
        Status::Ok
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: `host::ConnCounters` for `conn`,
    /// little-endian into `result` (`Instance::sim_conn_counters`'s own doc comment names the
    /// field order). An unknown/never-connected `conn` writes every field as 0 (same doc comment).
    /// docs/plan/19-presence-channel.md steps 4-6: widened from 48 to 56 bytes, appending
    /// `presence_bytes_up` (`ConnCounters`'s own doc comment) as a 7th `u64` -- `engine/test`'s
    /// `netCounters`' own `uplinkPresenceBytes`. `presence_oversize` (added step 3) still has no
    /// ABI reader: nothing in this milestone's own exit criteria needs it from a browser test.
    fn sim_conn_counters(&mut self, conn: u32, result: &mut [u8]) -> Status {
        let Some(out) = result.get_mut(..56) else {
            return Status::BadLength;
        };
        let c = self.counters(conn).unwrap_or_default();
        out[0..8].copy_from_slice(&c.bytes_down.to_le_bytes());
        out[8..16].copy_from_slice(&c.frames.to_le_bytes());
        out[16..24].copy_from_slice(&c.chunk_enters_pristine.to_le_bytes());
        out[24..32].copy_from_slice(&c.chunk_snapshots.to_le_bytes());
        out[32..40].copy_from_slice(&c.chunk_leaves.to_le_bytes());
        out[40..48].copy_from_slice(&c.bytes_up.to_le_bytes());
        out[48..56].copy_from_slice(&c.presence_bytes_up.to_le_bytes());
        Status::Ok
    }
}
