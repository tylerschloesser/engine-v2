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

use std::collections::{BTreeMap, BTreeSet};

use crate::abi::config::HexU64;
use crate::abi::{Instance, RegionId, RegionLayout, Role, Status};
use crate::authority::Scope;
use crate::bytes::{ByteSink, SliceSink};
use crate::codec::decode_canonical;
use crate::delta::Delta;
use crate::game::{Game, PlayerEvent, PlayerId, Presence as _, PresenceTable, WorldRead};
use crate::persist::{
    Comparison, MismatchReason, PROGRESS_BYTES, Phase, ProgressCursor, UpgradeProgress,
    UpgradeReader,
};
use crate::sim::{EngineReject, Outcome, Record, Rejected, Sim, WorldParams};
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
/// A generous sentinel meaning "no enforced ceiling" for a config that never sets
/// `worldBudgetBytes` (every pre-M21 fixture and test config, docs/plan/
/// 21-entities-and-timers.md Deviations): the init check below is then a no-op, exactly as it
/// was before this milestone. **Distinct from the engine's own pre-existing, outer
/// `InstanceConfig.arenaBytes`** (`src/sim-config.ts`, `src/client.ts`'s `DEFAULT_ARENA_BYTES`):
/// that field is the real WASM memory size `instantiate()` allocates, one level up in the JSON
/// this game-specific `SimConfig` never sees; `worldBudgetBytes` here is 0007 §8's own
/// "configured budget" (the ADR's "raised state budgets on a desktop" line), a ceiling this
/// milestone's init check compares its computed memory-split sum against.
fn default_world_budget_bytes() -> u32 {
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

/// `RegionId::Persist`'s size on the sim role (docs/plan/22-persistence-log-and-snapshots.md
/// Seams: "sized here at 256 KiB"): log frames (`sim_seal_frame`, `sim_segment_header`) and
/// streaming snapshot blocks (`sim_snapshot_begin`/`sim_snapshot_next`) all copy through it.
const PERSIST_BYTES: u32 = 256 * 1024;

/// `sim_segment_header`'s own sentinel (docs/plan/22-persistence-log-and-snapshots.md Seams):
/// `base_tick` equal to this means `SegmentBase::Genesis`; any other value is
/// `SegmentBase::Snapshot(Tick(base_tick))`.
const GENESIS_BASE_TICK: u32 = 0xFFFF_FFFF;

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
    /// against the arena with real `size_of`"): the game's configured world-budget ceiling, in
    /// bytes (0007 §8's own default is 64 MiB). Optional, defaulting to [`default_world_budget_
    /// bytes`] (effectively "unchecked") so every existing config keeps working unmodified.
    #[serde(default = "default_world_budget_bytes")]
    world_budget_bytes: u32,
    /// docs/plan/22-persistence-log-and-snapshots.md steps 4-6 (0005 "Sim identity"): the build's
    /// own content hash (0017), plain lowercase hex (no `0x` prefix -- `build-game.ts`'s own
    /// `createHash('sha256').update(bytes).digest('hex')`), first 32 hex digits (128 bits) kept.
    /// `#[serde(default)]` (empty string, parsed to all-zero) so every existing config -- native
    /// tests, `testkit::Loopback`'s own JSON-free construction, anything built before `WorldConfig.
    /// buildHash` reached this config -- keeps working unmodified; identity mismatch handling is
    /// M24b's, so nothing validates this value yet.
    #[serde(default)]
    build_hash: String,
}

/// [`SimConfig::build_hash`]'s hex decode: the first 32 hex digits (128 bits), or all-zero on
/// anything shorter or non-hex (never a parse error -- a config with no/garbled build hash still
/// boots, since nothing validates identity yet, M24b's job).
fn parse_build_hash(hex: &str) -> [u8; 16] {
    let bytes = hex.as_bytes();
    let mut out = [0u8; 16];
    for (i, slot) in out.iter_mut().enumerate() {
        let (Some(hi), Some(lo)) = (
            bytes.get(i * 2).and_then(|b| (*b as char).to_digit(16)),
            bytes.get(i * 2 + 1).and_then(|b| (*b as char).to_digit(16)),
        ) else {
            return [0u8; 16];
        };
        *slot = ((hi << 4) | lo) as u8;
    }
    out
}

/// [`Host::init`]/[`Host::genesis_for_test`]'s shared worldgen-fingerprint computation
/// (docs/plan/22-persistence-log-and-snapshots.md steps 4-6): borrows `params` rather than cloning
/// it (`worldgen::Worldgen::Params` carries no `Clone` bound), building a throwaway
/// `PristineSource` the same way `worldgen::Pristine` does but over a reference instead of an owned
/// value.
fn compute_worldgen_fingerprint<G: Game>(
    seed: u64,
    params: &<G::Worldgen as Worldgen>::Params,
) -> u64 {
    struct Borrowed<'a, W: Worldgen> {
        seed: u64,
        params: &'a W::Params,
    }
    impl<W: Worldgen> crate::world::PristineSource for Borrowed<'_, W> {
        fn generate(&self, chunk: crate::world::ChunkCoord, out: &mut [crate::world::Tile]) {
            W::generate(self.seed, self.params, chunk, out);
        }
    }
    let dims = crate::world::ChunkDims::new(G::CHUNK_BITS);
    let source = Borrowed::<G::Worldgen> { seed, params };
    crate::worldgen::worldgen_fingerprint(&source, dims)
}

/// docs/plan/22b-persistence-load-and-fs.md: builds the same terrain shell [`Sim::genesis`] would
/// (the cache is excluded from a snapshot, `snapshot_excludes_dense_cache`, so its capacity is
/// inert here exactly as it is at genesis -- `crate::sim::DEFAULT_CACHE_CHUNKS`, not `self.
/// cache_chunks`, matching `Sim::genesis`'s own hardcoded choice) -- the empty `Store<G>` shell
/// [`crate::persist::SnapshotReader::new`] needs (its own doc comment: "correct terrain pristine
/// source/dims/cache capacity, exactly `Store::decode`'s own precondition").
fn restore_shell<G: Game>(
    seed: u64,
    worldgen: <G::Worldgen as Worldgen>::Params,
) -> crate::store::Store<G>
where
    G::Global: Default,
{
    crate::store::Store::new(fresh_terrain::<G>(seed, worldgen), G::Global::default())
}

/// docs/plan/24b-upgrade-and-migration.md: the terrain half of [`restore_shell`], factored out so
/// `Host::sim_upgrade_end`'s migrate path (which needs a bare `TerrainStore` for `migrate::migrate`,
/// not a whole `Store<G>` shell) can build the identical shape without duplicating the three-line
/// construction.
fn fresh_terrain<G: Game>(
    seed: u64,
    worldgen: <G::Worldgen as Worldgen>::Params,
) -> crate::world::TerrainStore {
    let dims = crate::world::ChunkDims::new(G::CHUNK_BITS);
    let source: Box<dyn crate::world::PristineSource> = Box::new(crate::worldgen::Pristine::<
        G::Worldgen,
    >::new(seed, worldgen));
    crate::world::TerrainStore::new(
        dims,
        source,
        crate::world::CacheCapacity::Chunks(crate::sim::DEFAULT_CACHE_CHUNKS),
    )
}

/// docs/plan/22b-persistence-load-and-fs.md: `FrameRecord<G>` -> `Record<G>` (by value: the
/// production replay path always holds an owned, freshly-decoded `Vec<FrameRecord<G>>` from
/// `FrameReader::push`, so moving `action` out directly needs no `G::Action: Clone` bound on
/// `Host<G>`'s own `Instance` impl -- unlike `testing::replay`'s own private copy of this function,
/// which borrows because its caller keeps `frame` around). A `Skip` decodes as a no-op (0005 "Panic
/// recovery" / this milestone's own Non-scope: nothing here ever produces one). That module is
/// `#[cfg(feature = "testing")]` (dev-only), so production replay (`Host::sim_replay_push`) cannot
/// reach its copy.
/// Builds a `(Phase, u32) -> ()` hook that writes into `*progress` and, when `progress_ptr` is
/// non-null, into the `Progress` region itself (docs/plan/24-recovery-and-migration.md). A free
/// function, not a `Host` method: `Host::tick`/`Host::sim_replay_end` both need to call this while
/// a *different* field of `self` (`self.sim`) is already mutably borrowed via destructuring, so the
/// hook itself must not need `&mut self` (`Host::mark_progress` does, for every other export).
fn progress_writer<'a>(
    progress: &'a mut ProgressCursor,
    log: &'a mut Option<Vec<ProgressCursor>>,
    progress_ptr: *mut u8,
    tick: u32,
) -> impl FnMut(Phase, u32) + 'a {
    move |phase, record| {
        *progress = ProgressCursor {
            phase,
            tick,
            record,
        };
        if let Some(log) = log.as_mut() {
            log.push(*progress);
        }
        if !progress_ptr.is_null() {
            // SAFETY: see `Host::mark_progress` -- same region, same single-threaded,
            // non-re-entrant instance.
            let out =
                unsafe { core::slice::from_raw_parts_mut(progress_ptr, PROGRESS_BYTES as usize) };
            progress.write(out);
        }
    }
}

fn to_record<G: Game>(r: crate::persist::FrameRecord<G>) -> Option<Record<G>> {
    match r {
        crate::persist::FrameRecord::Action { who, seq, action } => {
            Some(Record::Action { who, seq, action })
        }
        crate::persist::FrameRecord::Connection { who, ev } => Some(Record::Player { who, ev }),
        crate::persist::FrameRecord::Skip { .. } => None,
        // docs/plan/24b-upgrade-and-migration.md decision 6: never applied -- `Host::sim_replay_push`
        // counts and warns on this variant itself, before `to_record` is ever called on it, but the
        // match here still needs to be exhaustive.
        crate::persist::FrameRecord::Undecodable { .. } => None,
    }
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

    // -- M22 steps 4-6: persistence identity, write-ahead sealing, snapshots -------------------
    /// The first 128 bits of the build hash (0005 "Sim identity"), parsed once from `SimConfig::
    /// build_hash` at `Host::init` (all-zero when the config carries none, e.g. a hand-built native
    /// test config: identity mismatch handling is M24b's, so nothing validates this yet). `[0; 16]`
    /// for [`Host::genesis_for_test`] too, for the same reason.
    build_hash: [u8; 16],
    /// `worldgen::worldgen_fingerprint` over this world's own pristine generator (0007 §9),
    /// computed once (`Host::init`/`Host::genesis_for_test`) rather than on every `identity()` call
    /// (it walks 16 chunks' worth of tiles).
    worldgen_fingerprint: u64,
    /// The tick of the most recently *logged* frame (0005: "ticks without actions are not logged;
    /// they are implied by `tick_delta`") -- `Tick(0)` (genesis) before the first one.
    /// `Host::sim_seal_frame` reads and advances this; nothing else touches it.
    last_logged_tick: Tick,
    /// The in-progress streaming snapshot [`Host::sim_snapshot_begin`] started, drained by
    /// [`Host::sim_snapshot_next`]; `None` when no snapshot is in flight (including right after one
    /// finishes draining).
    snapshot_writer: Option<crate::persist::SnapshotWriter>,

    // -- M22b: restore (load a snapshot) and replay (apply a log tail) drivers ------------------
    /// The in-progress snapshot decode [`Host::sim_restore_begin`] started, fed by
    /// [`Host::sim_restore_push`]; `None` when no restore is in flight.
    restore_reader: Option<crate::persist::SnapshotReader<G>>,
    /// Set by [`Host::sim_restore_push`] once [`crate::persist::SnapshotReader::push`] reports
    /// `Done`; consumed (and cleared) by [`Host::sim_restore_end`]. Kept separate from
    /// `restore_reader` (rather than matching on its return value again) since `SnapshotReader::
    /// push` cannot be called a second time to re-observe the same `Done`.
    restore_done: Option<crate::persist::SnapshotInfo>,
    /// The state-budget fields [`Host::sim_restore_begin`] took out of `pending` (`WorldParams`
    /// carries no `Clone` bound on `worldgen`, so building the restore shell moves the whole value
    /// out of `pending`; these three plain `u32`s are kept aside for [`Host::sim_restore_end`] to
    /// apply via `Authority::set_budget`, the same way `Sim::genesis` does).
    restore_budget: Option<(u32, u32, u32)>,
    /// docs/plan/24b-upgrade-and-migration.md step 4: the in-progress envelope decode
    /// [`Host::sim_upgrade_begin`] started, fed by [`Host::sim_upgrade_push`]; `None` when no
    /// upgrade is in flight.
    upgrade_reader: Option<crate::persist::UpgradeReader>,
    /// Set by [`Host::sim_upgrade_push`] once [`crate::persist::UpgradeReader::push`] reports
    /// `Done`; consumed (and cleared) by [`Host::sim_upgrade_end`] (mirrors `restore_done`).
    upgrade_done: Option<crate::persist::UpgradeEnvelope>,
    /// The whole [`WorldParams`] [`Host::sim_upgrade_begin`] took out of `pending` -- kept whole
    /// (unlike `restore_budget`'s three loose fields) because *which* shell to build
    /// (`restore_shell` for `Same`/`Direct`, a bare `TerrainStore` for `NeedsMigrate`) is not known
    /// until [`Host::sim_upgrade_end`] has [`crate::persist::Identity::compare`]'s verdict.
    upgrade_pending: Option<WorldParams<G>>,
    /// The in-progress log replay [`Host::sim_replay_begin`] started, fed by
    /// [`Host::sim_replay_push`]; `None` when no replay is in flight.
    replay_reader: Option<crate::persist::FrameReader<G>>,
    /// [`Host::sim_replay_begin`]'s own `offset` argument: the absolute byte offset, within the
    /// segment being replayed, that the first pushed byte represents. [`Host::sim_replay_valid_end`]
    /// adds bytes consumed by valid frames to this.
    replay_base_offset: u32,
    /// Total bytes ever handed to [`Host::sim_replay_push`] since the matching
    /// [`Host::sim_replay_begin`] (cumulative across calls): `replay_base_offset + this -
    /// replay_reader`'s own unconsumed buffer length is the valid-end offset
    /// ([`Host::sim_replay_valid_end`]).
    replay_fed: u64,
    /// Set once a pushed replay block fails to decode (docs/plan/22b-persistence-load-and-fs.md:
    /// "not an error for the last segment") -- further pushes are then ignored, and
    /// [`Host::sim_replay_end`] reports `Status::TornTail` rather than treating it as fatal.
    replay_torn: bool,
    /// docs/plan/24b-upgrade-and-migration.md decision 6: count of `Action` records
    /// [`Host::sim_replay_push`]'s apply pass dropped this replay because they failed to decode
    /// under this build (`persist::FrameRecord::Undecodable`). Reset by [`Host::sim_replay_begin`];
    /// read back by [`Host::sim_replay_end`]'s own `result` write.
    replay_dropped_undecodable: u32,
    /// [`Host::sim_replay_begin`]'s own `segment` argument -- unused for wire purposes (a
    /// segment's own index lives in its storage key, docs/plan/22b's Deviations), but needed here
    /// to filter [`crate::persist::FrameRecord::Skip`] targets to this replay's own segment
    /// (docs/plan/24-recovery-and-migration.md Planning decisions 1: "always the record's own
    /// segment").
    replay_segment: u32,
    /// The in-progress scan-pass decode [`Host::sim_replay_scan_begin`] started, fed by
    /// [`Host::sim_replay_scan_push`]; `None` when no scan is in flight. A separate reader from
    /// `replay_reader`: the scan pass runs once, over the whole segment tail, *before*
    /// `sim_replay_begin`/`push`/`end`'s own real apply pass (docs/plan/
    /// 24-recovery-and-migration.md, amending M22b's single-pass placeholder) -- a `Skip` record's
    /// own target can (and typically does) live in an *earlier* frame than the `Skip` record
    /// itself, so every frame must be seen once before any of them can be safely applied.
    scan_reader: Option<crate::persist::FrameReader<G>>,
    /// Set once a pushed scan block fails to decode -- mirrors `replay_torn`, but for the scan
    /// pass's own reader.
    scan_torn: bool,
    /// docs/plan/24b-upgrade-and-migration.md decision 6: total record count (any kind, `Skip`
    /// included) seen across every frame [`Host::sim_replay_scan_push`] decoded this scan -- the
    /// `migrate` path's own "how many records this abandoned tail held" report, since that path
    /// never runs the real apply pass at all. Reset by [`Host::sim_replay_scan_begin`]; read back by
    /// [`Host::sim_replay_scan_end`]'s own `result` write.
    scan_record_count: u32,
    /// Byte offsets (absolute within the segment: `replay_base_offset` already added) named by
    /// every `Skip { segment, offset }` record the scan pass decoded whose `segment` matches
    /// `replay_segment`. `BTreeSet`, not a `HashSet` (`.claude/rules/determinism.md`), though
    /// iteration order is not itself observable here -- consistency with the rest of this crate.
    replay_skip_targets: BTreeSet<u32>,
    /// `(who, seq)` of every record [`Host::sim_replay_end`]'s apply pass skipped (docs/plan/
    /// 24-recovery-and-migration.md Planning decisions 4): drained into that player's
    /// `ConnSlot::pending_results` the next time [`Host::connect`] sees them (their first frame
    /// after recovery reconnects), each becoming `Ack { seq, Rejected(Engine(EngineFault)) }`.
    pending_fault_acks: Vec<(PlayerId, u32)>,
    /// The last-written [`ProgressCursor`] (docs/plan/24-recovery-and-migration.md): mirrored into
    /// `progress_ptr` (the `Progress` region, when this instance has one) but also kept here in
    /// plain Rust so native tests can read it with no ABI/region involved at all.
    progress: ProgressCursor,
    /// Address of the `Progress` region (12 B), captured once at [`Host::init`] from the
    /// `RegionLayout` (mirrors `client::CameraBlock::ptr`'s own stored-raw-pointer pattern,
    /// `client/camera.rs`); null when this instance was built without one (`Host::genesis_for_test`
    /// and other native-only constructors, which have no `RegionLayout` at all).
    progress_ptr: *mut u8,
    /// Diagnostic-only, always `None` unless a test calls [`Host::start_progress_log`] (docs/plan/
    /// 24-recovery-and-migration.md: "prove failable per phase" -- `progress` alone only shows the
    /// *last* write, always back to `Idle` by the time a successful call returns, so a test needs
    /// the whole sequence to prove a write really happened for a phase that never panics on its
    /// own). Kept as a plain field (not `#[cfg(test)]`) so the tick-path hook closures below can
    /// destructure it alongside `sim`/`progress` with no extra conditional-compilation seam; a
    /// real game never calls the enabling method, so this never allocates in production
    /// (`.claude/rules/hot-paths.md`).
    progress_log: Option<Vec<ProgressCursor>>,
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

    /// docs/plan/22-persistence-log-and-snapshots.md steps 4-6 (0005 "Sim identity"): assembles
    /// this instance's own `Identity` for `sim_segment_header`/`sim_snapshot_begin`.
    /// `engine_version` is `engine::ENGINE_VERSION` (`env!("CARGO_PKG_VERSION")`, defined in the
    /// engine crate itself); `game_version` is `G::GAME_VERSION` (defaulted to `"0.0.0"` unless the
    /// game overrides it with its own `env!` call, `Game::GAME_VERSION`'s own doc comment).
    fn identity(&self) -> crate::persist::Identity {
        crate::persist::Identity {
            build_hash: self.build_hash,
            engine_version: crate::ENGINE_VERSION.to_string(),
            game_version: G::GAME_VERSION.to_string(),
            schema_version: G::SCHEMA_VERSION,
            tick_rate_hz: G::TICK_RATE.hz_value(),
            worldgen: crate::worldgen::WorldgenStamp {
                version: <G::Worldgen as Worldgen>::WORLDGEN_VERSION,
                fingerprint: self.worldgen_fingerprint,
            },
        }
    }

    /// The `cacheChunks` config value, read but not yet wired anywhere (see
    /// [`SimConfig::cache_chunks`]'s own doc comment): exposed so a future milestone that does
    /// wire it does not also have to re-plumb it through `Host::init`.
    pub fn cache_chunks(&self) -> u32 {
        self.cache_chunks
    }

    /// Writes a [`ProgressCursor`] both into `self.progress` (native-testable with no ABI at all)
    /// and, when this instance has a `Progress` region, into it directly (docs/plan/
    /// 24-recovery-and-migration.md). Called *before* starting the work `phase` names, so a trap
    /// partway through leaves exactly this value behind for a dead instance's own memory to be read
    /// back from (0014 §6) -- never after, and never batched: `.claude/rules/hot-paths.md`'s "plain
    /// stores into a fixed region, no allocation" is met by three `u32` LE stores, nothing else.
    fn mark_progress(&mut self, phase: Phase, tick: u32, record: u32) {
        self.progress = ProgressCursor {
            phase,
            tick,
            record,
        };
        if let Some(log) = self.progress_log.as_mut() {
            log.push(self.progress);
        }
        if !self.progress_ptr.is_null() {
            // SAFETY: `progress_ptr` addresses the `Progress` region, a separate heap allocation
            // from every other region (`RegionLayout::region`) that never moves or resizes after
            // init; the instance is single-threaded and not re-entered, so nothing else touches it
            // during this call (mirrors `client::CameraBlock::ptr`'s own justification).
            let out = unsafe {
                core::slice::from_raw_parts_mut(self.progress_ptr, PROGRESS_BYTES as usize)
            };
            self.progress.write(out);
        }
    }

    /// The resting value every export leaves behind once it finishes without trapping -- what
    /// makes `sim_test_trap` (which writes nothing of its own) show up as "trapped in `Phase::Idle`"
    /// whenever it's called right after any ordinary, successful call.
    fn mark_idle(&mut self, tick: u32) {
        self.mark_progress(Phase::Idle, tick, 0);
    }

    /// The current [`ProgressCursor`] (test/diagnostic convenience: native tests read this
    /// directly, with no `Progress` region or ABI call involved at all).
    #[cfg(any(test, feature = "testing"))]
    pub fn progress(&self) -> ProgressCursor {
        self.progress
    }

    /// Starts recording every [`ProgressCursor`] this instance writes from now on (docs/plan/
    /// 24-recovery-and-migration.md: `progress_cursor_written_before_each_phase`'s own mechanism).
    /// Never called by production code.
    #[cfg(any(test, feature = "testing"))]
    pub fn start_progress_log(&mut self) {
        self.progress_log = Some(Vec::new());
    }

    /// Every `ProgressCursor` written since [`Host::start_progress_log`] (or the last call to this
    /// method), in order; empty if logging was never started.
    #[cfg(any(test, feature = "testing"))]
    pub fn take_progress_log(&mut self) -> Vec<ProgressCursor> {
        self.progress_log
            .as_mut()
            .map(core::mem::take)
            .unwrap_or_default()
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
        let worldgen_fingerprint = compute_worldgen_fingerprint::<G>(params.seed, &params.worldgen);
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
            build_hash: [0; 16],
            worldgen_fingerprint,
            last_logged_tick: Tick(0),
            snapshot_writer: None,
            restore_reader: None,
            restore_done: None,
            restore_budget: None,
            upgrade_reader: None,
            upgrade_done: None,
            upgrade_pending: None,
            replay_reader: None,
            replay_base_offset: 0,
            replay_fed: 0,
            replay_torn: false,
            replay_dropped_undecodable: 0,
            replay_segment: 0,
            scan_reader: None,
            scan_torn: false,
            scan_record_count: 0,
            replay_skip_targets: BTreeSet::new(),
            pending_fault_acks: Vec::new(),
            progress: ProgressCursor::default(),
            progress_ptr: core::ptr::null_mut(),
            progress_log: None,
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
        // docs/plan/24-recovery-and-migration.md Planning decisions 4: a record `sim_replay_end`'s
        // apply pass skipped still queues `Ack { seq, Rejected(Engine(EngineFault)) }` for "the
        // player's first frame after recovery" -- delivered here, at (re)connect, since replay
        // itself never has a live `ConnSlot` to queue into (a recovered/loaded `Sim` starts with an
        // empty connection table, M22b Deviations). `Vec::retain` partitions in place, preserving
        // relative order, so an unrelated player's own pending faults are left untouched.
        let mut fault_acks = Vec::new();
        self.pending_fault_acks.retain(|&(who, seq)| {
            if who == player {
                fault_acks.push(seq);
                false
            } else {
                true
            }
        });
        let pending_results = fault_acks
            .into_iter()
            .map(|seq| Outcome {
                seq,
                result: Err(Rejected::Engine(EngineReject::EngineFault)),
            })
            .collect();
        self.conns[idx] = Some(ConnSlot {
            player,
            camera: None,
            subs: SubscriptionSet::new(crate::world::ChunkDims::new(G::CHUNK_BITS), G::TICK_RATE),
            first_frame_pending: true,
            counters: ConnCounters::default(),
            pending_results,
            highest_admitted_seq: 0,
            presence_relayed: BTreeMap::new(),
        });
        player
    }

    /// docs/plan/24-recovery-and-migration.md, Traps ("Connections stay open across recovery"): a
    /// panic-recovery re-instantiation replaces the whole `Sim`/`Host`, but every in-host TS
    /// `Connection` object survives untouched (the JS host process itself never died) -- this
    /// installs a fresh `ConnSlot` for `conn` with the same deterministic `PlayerId` a live
    /// `connect` would assign (`PlayerId(conn + 1)`), delivering this player's own
    /// `pending_fault_acks` exactly like `connect` does, but queues **no** `Record::Player` event
    /// and marks `ever_joined[idx]` true: the join and (re)connect already happened and are
    /// durably part of the log the replay that built this instance just re-applied, so queuing a
    /// fresh one here would both duplicate that history in the log's own next frame and re-run
    /// `G::on_player` a second time, perturbing game state the replay already settled. Not
    /// `connect` with a flag: a distinct, minimal export so the two call sites can never be
    /// confused (0014 §2's "numbers only" also rules out a boolean parameter to misuse).
    pub fn reattach(&mut self, conn: ConnId) -> PlayerId {
        assert!(
            (conn as usize) < MAX_CONNS,
            "reattach: conn {conn} out of range (max {MAX_CONNS})"
        );
        let idx = conn as usize;
        let player = PlayerId(conn + 1);
        self.ever_joined[idx] = true;
        let mut fault_acks = Vec::new();
        self.pending_fault_acks.retain(|&(who, seq)| {
            if who == player {
                fault_acks.push(seq);
                false
            } else {
                true
            }
        });
        let pending_results = fault_acks
            .into_iter()
            .map(|seq| Outcome {
                seq,
                result: Err(Rejected::Engine(EngineReject::EngineFault)),
            })
            .collect();
        self.conns[idx] = Some(ConnSlot {
            player,
            camera: None,
            subs: SubscriptionSet::new(crate::world::ChunkDims::new(G::CHUNK_BITS), G::TICK_RATE),
            first_frame_pending: true,
            counters: ConnCounters::default(),
            pending_results,
            highest_admitted_seq: 0,
            presence_relayed: BTreeMap::new(),
        });
        player
    }

    /// M24 fix round 1 (Planning decisions 2: "A trap in `Admit` recovers and answers that action
    /// `Rejected(Engine(EngineFault))` (unlogged, like every admission failure, 0004)"): queues that
    /// ack directly onto `conn`'s own (already-reattached) `ConnSlot` -- unlike the `ApplyRecord`
    /// case (`pending_fault_acks`, drained by `connect`/`reattach` because replay has no live
    /// `ConnSlot` yet to push into), an `Admit`-phase trap is discovered by the *live* caller
    /// (`SimHost`, TS) after `reattach` has already run, so the slot already exists and this can
    /// write straight into it. Also raises `highest_admitted_seq` to at least `seq`, so a resend of
    /// this exact `seq` is dropped at the `on_uplink` dedup floor rather than re-admitted (and,
    /// since `PanicInAdmit`-style actions panic deterministically, re-trapped). A `conn` with no
    /// slot (never reattached, or already disconnected again) is a tolerated no-op -- the ack simply
    /// has nowhere left to ride.
    pub fn fault_ack(&mut self, conn: ConnId, seq: u32) {
        let idx = conn as usize;
        let Some(Some(slot)) = self.conns.get_mut(idx) else {
            return;
        };
        slot.pending_results.push(Outcome {
            seq,
            result: Err(Rejected::Engine(EngineReject::EngineFault)),
        });
        if seq > slot.highest_admitted_seq {
            slot.highest_admitted_seq = seq;
        }
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
                self.mark_progress(Phase::Admit, sim.tick().0, seq);
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
        let progress_ptr = self.progress_ptr;
        let Host {
            sim,
            pending_records,
            outcomes,
            chunk_versions,
            last_tick,
            conns,
            scratch_action_players,
            progress,
            progress_log,
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
        // docs/plan/24-recovery-and-migration.md: `record` is the *index* of the record inside
        // `pending_records` while ticking live (the byte-offset meaning only applies to the
        // replay apply pass, `Host::sim_replay_end`) -- written before each per-record call so a
        // dead instance's own `Progress` region names exactly which one trapped. `completed` is
        // already the tick these records are *for* (`Host::last_tick`'s own doc comment: `Sim::
        // step` advances the clock at the very end, so `sim.tick()` read just before it is the
        // tick about to complete).
        let mut hook = progress_writer(progress, progress_log, progress_ptr, completed.0);
        sim.step_with_progress(pending_records, outcomes, &mut hook);
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

/// docs/plan/24b-upgrade-and-migration.md: writes an `IncompatReason` byte to `result[0]` and
/// returns `Status::SaveIncompatible` (Planning decisions 7: no write of any kind happens on this
/// path -- this function itself never touches storage, only the scratch `Result` region). A free
/// function, not a `Host` method, since `sim_upgrade_end`'s own `impl Instance for Host<G>` block
/// may only define trait methods.
fn write_incompatible(result: &mut [u8], reason: crate::abi::registry::IncompatReason) -> Status {
    if let Some(byte) = result.first_mut() {
        *byte = reason as u8;
    }
    Status::SaveIncompatible
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
        if computed > cfg.world_budget_bytes as u64 {
            return Err(Status::BudgetExceedsArena);
        }

        let worldgen_fingerprint = compute_worldgen_fingerprint::<G>(cfg.seed.0, &cfg.params);
        let build_hash = parse_build_hash(&cfg.build_hash);

        layout.region(RegionId::Rx, SIM_RX_BYTES);
        layout.region(RegionId::Tx, SIM_TX_BYTES);
        layout.region(RegionId::Persist, PERSIST_BYTES);
        layout.region(RegionId::Progress, PROGRESS_BYTES);
        let progress_ptr = layout.ptr(RegionId::Progress);
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
            build_hash,
            worldgen_fingerprint,
            last_logged_tick: Tick(0),
            snapshot_writer: None,
            restore_reader: None,
            restore_done: None,
            restore_budget: None,
            upgrade_reader: None,
            upgrade_done: None,
            upgrade_pending: None,
            replay_reader: None,
            replay_base_offset: 0,
            replay_fed: 0,
            replay_torn: false,
            replay_dropped_undecodable: 0,
            replay_segment: 0,
            scan_reader: None,
            scan_torn: false,
            scan_record_count: 0,
            replay_skip_targets: BTreeSet::new(),
            pending_fault_acks: Vec::new(),
            progress: ProgressCursor::default(),
            progress_ptr,
            progress_log: None,
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

    /// docs/plan/24-recovery-and-migration.md: `host::Host::reattach` -- same out-of-range
    /// contract as `sim_connect` above (a TS-side bug, not untrusted wire input).
    fn sim_reattach(&mut self, conn: u32) -> Status {
        self.reattach(conn);
        Status::Ok
    }

    /// M24 fix round 1: `host::Host::fault_ack` -- tolerates an unknown `conn` (see its own doc
    /// comment).
    fn sim_fault_ack(&mut self, conn: u32, seq: u32) -> Status {
        self.fault_ack(conn, seq);
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
        let result = self.on_uplink(conn, rx);
        let tick = self.sim.as_ref().map_or(0, |s| s.tick().0);
        self.mark_idle(tick);
        match result {
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
        let tick = self.sim.as_ref().map_or(0, |s| s.tick().0);
        self.mark_idle(tick);
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
        let tick = self.last_tick.0;
        self.mark_progress(Phase::BuildFrame, tick, conn);
        let n = self.build_frame(conn, tx) as u32;
        self.mark_idle(tick);
        Ok(n)
    }

    /// docs/plan/22-persistence-log-and-snapshots.md steps 4-6: real write-ahead frame bytes,
    /// replacing M13's "always 0" stub. Reads (never clears) `self.pending_records` -- the same
    /// queue `Host::tick`'s own `Sim::step` call drains and clears right after this returns, so the
    /// ABI order (`sim_seal_frame()` -> `logSink(view)` -> `sim_tick()`) sees the *same* records
    /// this tick's `sim_tick()` is about to apply, per 0005's write-ahead rule. Encodes the same
    /// `len | tick_delta | count | records | crc32` container `persist::FrameWriter::finish` does
    /// (byte for byte -- `log_bytes_native_equals_wasm` is what proves it), but by hand over
    /// *borrowed* records rather than through `FrameWriter::push_action` (which takes `G::Action`
    /// by value): only reading `pending_records` here, never draining it, means the very next line
    /// of `Host::tick` still needs every record intact for its own `Sim::step` call, and adding a
    /// `G::Action: Clone` bound to this whole `impl Instance for Host<G>` block would force it onto
    /// every generic caller (`GameInstance<G>`, `export_game!`), not just this one method.
    fn sim_seal_frame(&mut self, persist: &mut [u8]) -> Result<u32, Status> {
        let Some(sim) = self.sim.as_ref() else {
            return Err(Status::NotInitialised);
        };
        if self.pending_records.is_empty() {
            // 0005: "ticks without actions are not logged; they are implied by `tick_delta`."
            return Ok(0);
        }
        // `sim.tick()` here is the tick about to complete once `sim_tick()` runs right after this
        // call (host/mod Deviations, "seal timing": the ABI splits `Sim::step`'s own internal
        // tick-then-step into two exports, but `sim_seal_frame` runs *before* `Sim::step`, so the
        // tick this frame is *for* is one past what `sim.tick()` currently reads).
        let next_tick = sim.tick().add(crate::time::Ticks(1));
        let tick_delta = next_tick.0.wrapping_sub(self.last_logged_tick.0);

        let mut body = Vec::new();
        struct VecSink<'a>(&'a mut Vec<u8>);
        impl ByteSink for VecSink<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        {
            let mut v = VecSink(&mut body);
            v.put_varint(tick_delta as u64);
            v.put_varint(self.pending_records.len() as u64);
            for record in &self.pending_records {
                match record {
                    Record::Action { who, seq, action } => {
                        debug_assert!(who.0 <= u8::MAX as u32, "player_slot must fit a u8 (0005)");
                        v.put_u8(crate::persist::RecordKind::Action as u8);
                        v.put_u8(who.0 as u8);
                        v.put_varint(*seq as u64);
                        crate::persist::write_sized(action, &mut v);
                    }
                    Record::Player { who, ev } => {
                        debug_assert!(who.0 <= u8::MAX as u32, "player_slot must fit a u8 (0005)");
                        v.put_u8(crate::persist::RecordKind::Connection as u8);
                        v.put_u8(who.0 as u8);
                        v.put_u8(match ev {
                            PlayerEvent::Joined => 0,
                            PlayerEvent::Connected => 1,
                            PlayerEvent::Disconnected => 2,
                        });
                    }
                }
            }
        }
        let crc = crate::persist::crc32(&body);
        let mut sink = SliceSink::new(persist);
        sink.put_varint((body.len() + 4) as u64);
        sink.put(&body);
        sink.put_u32(crc);
        let n = sink.finish().map_err(|_| Status::BadLength)?;
        self.last_logged_tick = next_tick;
        // Fix round 1, gap 2 (docs/plan/22-persistence-log-and-snapshots.md): Planning decisions 7
        // says dirty means "a put happened *or a record was logged*". `Authority::write`/
        // `record_ack` already cover the first half and most of the second (every admitted action,
        // applied or rejected), but a *reconnect* (`Host::connect` on an already-`ever_joined`
        // player pushes only `Record::Player{Connected}`, no `on_player` write and no `record_ack`
        // call) reached neither -- a real, non-empty logged frame with `sim_dirty()` still reading
        // 0. Marking it here, on any non-empty frame this export actually produces, covers every
        // record kind uniformly rather than chasing each one's own write path individually.
        if n > 0
            && let Some(sim) = self.sim.as_mut()
        {
            sim.authority_mut().mark_dirty();
        }
        Ok(n as u32)
    }

    fn sim_segment_header(
        &mut self,
        _segment: u32,
        base_tick: u32,
        persist: &mut [u8],
    ) -> Result<u32, Status> {
        // No `self.sim.is_none()` gate, unlike every other real export here: `self.identity()`
        // reads only `build_hash`/`worldgen_fingerprint` (parsed/computed at `Host::init`, before
        // `sim_genesis` ever runs) and `G`'s own consts, never `self.sim`. This is deliberate --
        // `Persistence.create` (TS, docs/plan/22-persistence-log-and-snapshots.md steps 4-6) builds
        // segment 0's header as part of *creating* a world, before the host has run genesis or
        // ticked at all.
        let base = if base_tick == GENESIS_BASE_TICK {
            crate::persist::SegmentBase::Genesis
        } else {
            crate::persist::SegmentBase::Snapshot(Tick(base_tick))
        };
        let header = crate::persist::SegmentHeader {
            identity: self.identity(),
            base,
        };
        let mut sink = crate::bytes::SliceSink::new(persist);
        header.write(&mut sink);
        let result = sink
            .finish()
            .map(|n| n as u32)
            .map_err(|_| Status::BadLength);
        if result.is_ok() {
            // Fix round 2 (docs/plan/22-persistence-log-and-snapshots.md): unlike a periodic
            // snapshot mid-segment (`sim_snapshot_begin`, which deliberately leaves this alone --
            // see its own doc comment), opening a segment *is* the tick_delta reference reset for
            // that segment's own first frame: nothing preceded it in this segment, by definition, so
            // there is no genesis-replay-of-this-same-log invariant to break the way there was for a
            // mid-segment snapshot (0002 "replay equality" only ever replays one segment's own log
            // against its own base -- 0005 "old segments stay replayable only by rebuilding the
            // binary their header names", i.e. cross-segment replay was never a single continuous
            // stream to begin with). M22b's own segment rolling (Non-scope here) will call this
            // export to open every segment after the first, so this reset has to live here now to
            // avoid reintroducing fix round 1's own bug for segment 1 onward.
            self.last_logged_tick = if base_tick == GENESIS_BASE_TICK {
                Tick(0)
            } else {
                Tick(base_tick)
            };
        }
        result
    }

    /// docs/plan/22-persistence-log-and-snapshots.md steps 4-6: starts a streaming snapshot of the
    /// current state at `(log_segment, log_offset)` (Planning decisions 4: "the host owns the log
    /// position"). Resets [`Authority::dirty`] once the writer holds a self-consistent copy of the
    /// state it describes -- everything after this call, until the *next* put or logged record,
    /// happened after the snapshot this method just began.
    ///
    /// Fix round 2: passes `self.last_logged_tick` (unchanged by this call, deliberately -- see the
    /// fix-round-1 attempt this replaces) as the snapshot's own `log_ref_tick`, so `testing::
    /// replay`'s `Base::Snapshot` path can correctly interpret the *next* frame's `tick_delta` even
    /// when this snapshot was taken well after the last real frame (an idle world, `sim_dirty()`
    /// still set from an old event -- a real, common case since fix round 1's own gap 2 fix).
    fn sim_snapshot_begin(&mut self, log_segment: u32, log_offset: u32) -> Status {
        let Some(sim) = self.sim.as_ref() else {
            return Status::NotInitialised;
        };
        let tick = sim.tick();
        self.mark_progress(Phase::Snapshot, tick.0, 0);
        let sim = self.sim.as_ref().expect("checked above");
        let identity = self.identity();
        let rng = sim.authority().rng();
        self.snapshot_writer = Some(crate::persist::SnapshotWriter::begin(
            sim.authority().store(),
            tick,
            &rng,
            log_segment,
            log_offset,
            self.last_logged_tick.0,
            &identity,
        ));
        if let Some(sim) = self.sim.as_mut() {
            sim.authority_mut().clear_dirty();
        }
        self.mark_idle(tick.0);
        Status::Ok
    }

    fn sim_snapshot_next(&mut self, persist: &mut [u8]) -> Result<u32, Status> {
        if self.snapshot_writer.is_none() {
            return Err(Status::NotInitialised);
        }
        let tick = self.sim.as_ref().map_or(0, |s| s.tick().0);
        self.mark_progress(Phase::Snapshot, tick, 0);
        let writer = self.snapshot_writer.as_mut().expect("checked above");
        let n = writer.next(persist);
        if n == 0 {
            self.snapshot_writer = None;
        }
        self.mark_idle(tick);
        Ok(n as u32)
    }

    fn sim_dirty(&mut self) -> u32 {
        self.sim
            .as_ref()
            .map_or(0, |sim| u32::from(sim.authority().dirty()))
    }

    /// docs/plan/22b-persistence-load-and-fs.md: begins decoding a snapshot. Deliberately does not
    /// require `self.sim.is_none()` to have run genesis -- the whole point is to replace it -- but
    /// does require no `Sim` exists yet (a fresh instance, or one whose `pending` a prior failed
    /// attempt has not already consumed; `Persistence.open`'s own design tries each candidate
    /// snapshot on a fresh `newInstance()`, so this is never asked to retry on the same `Host`).
    fn sim_restore_begin(&mut self, _total_len: u32) -> Status {
        if self.sim.is_some() {
            return Status::AlreadyInitialised;
        }
        let Some(WorldParams {
            seed,
            worldgen,
            max_entities,
            max_modified_tiles,
            max_action_growth,
        }) = self.pending.take()
        else {
            return Status::AlreadyInitialised;
        };
        let shell = restore_shell::<G>(seed, worldgen);
        self.restore_reader = Some(crate::persist::SnapshotReader::new(shell));
        self.restore_done = None;
        self.restore_budget = Some((max_entities, max_modified_tiles, max_action_growth));
        Status::Ok
    }

    fn sim_restore_push(&mut self, bytes: &[u8]) -> Status {
        let Some(reader) = self.restore_reader.as_mut() else {
            return Status::NotInitialised;
        };
        match reader.push(bytes) {
            Ok(crate::persist::SnapshotProgress::NeedMore) => Status::Ok,
            Ok(crate::persist::SnapshotProgress::Done(info)) => {
                self.restore_done = Some(info);
                Status::Ok
            }
            Err(crate::persist::PersistError::Crc)
            | Err(crate::persist::PersistError::Malformed) => Status::Corrupt,
            Err(crate::persist::PersistError::ContainerVersion) => Status::ContainerVersion,
        }
    }

    /// docs/plan/22b-persistence-load-and-fs.md: `Status::Corrupt` when the snapshot never reached
    /// `Done` (still `NeedMore` -- a torn snapshot) or when `sim_restore_push` was never called at
    /// all after `sim_restore_begin`; `Status::IdentityMismatch` when the decoded `Identity` differs
    /// from this build's own. On `Status::Ok`, writes `log_segment`/`log_offset` (two LE `u32`) into
    /// `result` -- the position `sim_replay_begin` resumes replay from.
    fn sim_restore_end(&mut self, result: &mut [u8]) -> Status {
        let Some(reader) = self.restore_reader.take() else {
            return Status::NotInitialised;
        };
        let Some(info) = self.restore_done.take() else {
            return Status::Corrupt;
        };
        let running = self.identity();
        if info.identity.build_hash != running.build_hash {
            return Status::IdentityMismatch;
        }
        let store = reader.into_store();
        let mut authority = crate::authority::Authority::from_snapshot(store, info.rng, info.tick);
        if let Some((max_entities, max_modified_tiles, max_action_growth)) =
            self.restore_budget.take()
        {
            authority.set_budget(max_entities, max_modified_tiles, max_action_growth);
        }
        self.sim = Some(Sim::from_parts(authority));
        self.last_logged_tick = Tick(info.log_ref_tick);
        let Some(out) = result.get_mut(..8) else {
            return Status::BadLength;
        };
        out[0..4].copy_from_slice(&info.log_segment.to_le_bytes());
        out[4..8].copy_from_slice(&info.log_offset.to_le_bytes());
        Status::Ok
    }

    /// docs/plan/24b-upgrade-and-migration.md step 4: begins the 0005 Upgrades sequence. Same
    /// preconditions as `sim_restore_begin` (no live `Sim` yet, `pending` still holding the world's
    /// own params) -- but the whole `WorldParams` is kept (`upgrade_pending`), not just the budget
    /// fields, since which shell to build is not known until `sim_upgrade_end`.
    fn sim_upgrade_begin(&mut self, _total_len: u32) -> Status {
        if self.sim.is_some() {
            return Status::AlreadyInitialised;
        }
        let Some(pending) = self.pending.take() else {
            return Status::AlreadyInitialised;
        };
        self.upgrade_reader = Some(UpgradeReader::new());
        self.upgrade_done = None;
        self.upgrade_pending = Some(pending);
        Status::Ok
    }

    fn sim_upgrade_push(&mut self, bytes: &[u8]) -> Status {
        let Some(reader) = self.upgrade_reader.as_mut() else {
            return Status::NotInitialised;
        };
        match reader.push(bytes) {
            Ok(UpgradeProgress::NeedMore) => Status::Ok,
            Ok(UpgradeProgress::Done(env)) => {
                self.upgrade_done = Some(env);
                Status::Ok
            }
            Err(crate::persist::PersistError::Crc)
            | Err(crate::persist::PersistError::Malformed) => Status::Corrupt,
            Err(crate::persist::PersistError::ContainerVersion) => Status::ContainerVersion,
        }
    }

    /// docs/plan/24b-upgrade-and-migration.md step 4: finishes the upgrade sequence -- runs
    /// [`crate::persist::Identity::compare`] between the decoded envelope's own identity and this
    /// running build's, then either a direct `Store<G>` decode (`Same`/`Direct`) or `crate::migrate::
    /// migrate` (`NeedsMigrate`, over a fresh `OldStore`/`TerrainStore`). Every branch that does not
    /// end in `Status::Ok` leaves `self.sim` untouched (`None`), so a caller sees `SaveIncompatible`
    /// (or `Corrupt`) with no live world at all -- exactly the "no write of any kind" contract
    /// (Planning decisions 7), since a caller only ever writes storage after `Status::Ok`.
    fn sim_upgrade_end(&mut self, result: &mut [u8]) -> Status {
        let Some(_reader) = self.upgrade_reader.take() else {
            return Status::NotInitialised;
        };
        let Some(pending) = self.upgrade_pending.take() else {
            return Status::NotInitialised;
        };
        let Some(env) = self.upgrade_done.take() else {
            return Status::Corrupt;
        };
        let WorldParams {
            seed,
            worldgen,
            max_entities,
            max_modified_tiles,
            max_action_growth,
        } = pending;
        let running = self.identity();
        match env.identity.compare(&running) {
            Comparison::Same | Comparison::Direct => {
                let mut store = restore_shell::<G>(seed, worldgen);
                let mut reader = crate::bytes::ByteReader::new(&env.store_bytes);
                if store.decode(&mut reader).is_err() {
                    return Status::Corrupt;
                }
                let mut authority =
                    crate::authority::Authority::from_snapshot(store, env.rng, env.tick);
                authority.set_budget(max_entities, max_modified_tiles, max_action_growth);
                self.sim = Some(Sim::from_parts(authority));
                self.last_logged_tick = Tick(env.log_ref_tick);
                let Some(out) = result.get_mut(..9) else {
                    return Status::BadLength;
                };
                out[0] = 0; // direct/same: tail replay follows.
                out[1..5].copy_from_slice(&env.log_segment.to_le_bytes());
                out[5..9].copy_from_slice(&env.log_offset.to_le_bytes());
                Status::Ok
            }
            Comparison::NeedsMigrate(mismatch) => {
                crate::abi::panic::log(
                    crate::abi::registry::LogLevel::Warn,
                    match mismatch {
                        MismatchReason::Schema => "upgrade: schema mismatch, attempting migrate",
                        MismatchReason::TickRate => {
                            "upgrade: tick rate mismatch, attempting migrate"
                        }
                        MismatchReason::Worldgen => {
                            "upgrade: worldgen mismatch, attempting migrate"
                        }
                    },
                );
                let terrain = fresh_terrain::<G>(seed, worldgen);
                let mut reader = crate::bytes::ByteReader::new(&env.store_bytes);
                let old = match crate::migrate::OldStore::decode(
                    &mut reader,
                    env.identity.schema_version,
                    env.identity.tick_rate_hz,
                    running.tick_rate_hz,
                    env.tick,
                    G::CHUNK_BITS,
                ) {
                    Ok(old) => old,
                    Err(_) => {
                        return write_incompatible(
                            result,
                            crate::abi::registry::IncompatReason::Decode,
                        );
                    }
                };
                match crate::migrate::migrate::<G>(old, terrain, env.tick, env.rng) {
                    Ok((mut authority, _outcome)) => {
                        authority.set_budget(max_entities, max_modified_tiles, max_action_growth);
                        self.sim = Some(Sim::from_parts(authority));
                        // decision 6: the tail is dropped whole, never replayed -- the new segment
                        // (opened by the TS host) starts with no frame logged yet.
                        self.last_logged_tick = Tick(0);
                        let Some(out) = result.get_mut(..9) else {
                            return Status::BadLength;
                        };
                        out[0] = 1; // migrated: no tail replay.
                        out[1..5].copy_from_slice(&env.log_segment.to_le_bytes());
                        out[5..9].copy_from_slice(&env.log_offset.to_le_bytes());
                        Status::Ok
                    }
                    Err(_) => write_incompatible(
                        result,
                        crate::abi::registry::IncompatReason::MigrateDeclined,
                    ),
                }
            }
        }
    }

    /// docs/plan/24-recovery-and-migration.md: **scan pass** -- decodes `bytes` (fed the same way
    /// `sim_replay_push` is) purely to collect every `Skip { segment, offset }` target whose
    /// `segment` matches `segment`, into `self.replay_skip_targets`. Applies nothing and touches
    /// `self.sim` not at all: a `Skip` record's own target typically lives in an *earlier* frame
    /// than the `Skip` record itself, so the caller must scan the **whole** segment tail once,
    /// before replaying any of it, or an earlier frame could be applied before its own `Skip` is
    /// even known (amending M22b's single-pass placeholder, which had no targets to honour yet). A
    /// separate reader/pass from `sim_replay_begin`/`push`/`end` on purpose: those keep their own
    /// pre-existing "apply each frame as soon as it's decoded" contract (`engine/test`'s
    /// `replayWorld`/`runHeavy` drive it tick-by-tick, interjecting between calls), which a
    /// buffer-everything-then-apply design would have broken.
    fn sim_replay_scan_begin(&mut self, segment: u32) -> Status {
        if self.sim.is_none() {
            return Status::NotInitialised;
        }
        self.scan_reader = Some(crate::persist::FrameReader::new());
        self.replay_segment = segment;
        self.replay_skip_targets = BTreeSet::new();
        self.scan_torn = false;
        self.scan_record_count = 0;
        Status::Ok
    }

    /// Feeds the next block to the scan pass (same in-region-as-receive-buffer shape as
    /// `sim_replay_push`).
    fn sim_replay_scan_push(&mut self, bytes: &[u8]) -> Status {
        if self.scan_reader.is_none() {
            return Status::NotInitialised;
        }
        if self.scan_torn {
            return Status::TornTail;
        }
        let mut remaining = bytes;
        loop {
            let progress = match self.scan_reader.as_mut().unwrap().push(remaining) {
                Ok(p) => p,
                Err(_) => {
                    self.scan_torn = true;
                    break;
                }
            };
            remaining = &[];
            let frame = match progress {
                crate::persist::FrameProgress::NeedMore => break,
                crate::persist::FrameProgress::Frame(f) => f,
            };
            // docs/plan/24b-upgrade-and-migration.md decision 6: the migrate path's own "how many
            // records this abandoned tail held" report -- every record, any kind (`Skip` included),
            // since that path never runs the real apply pass at all to tell them apart.
            self.scan_record_count += frame.records.len() as u32;
            for record in &frame.records {
                if let crate::persist::FrameRecord::Skip { segment, offset } = record
                    && *segment == self.replay_segment
                {
                    self.replay_skip_targets.insert(*offset);
                }
            }
        }
        if self.scan_torn {
            Status::TornTail
        } else {
            Status::Ok
        }
    }

    /// Finishes the scan pass. `self.replay_skip_targets` is left populated for the `sim_replay_*`
    /// calls that follow -- unlike `sim_replay_begin`, this never resets it. Writes
    /// `scan_record_count` (LE `u32`) to `result[0..4]` (decision 6).
    fn sim_replay_scan_end(&mut self, result: &mut [u8]) -> Status {
        if self.scan_reader.take().is_none() {
            return Status::NotInitialised;
        }
        if let Some(out) = result.get_mut(..4) {
            out.copy_from_slice(&self.scan_record_count.to_le_bytes());
        }
        if self.scan_torn {
            Status::TornTail
        } else {
            Status::Ok
        }
    }

    /// docs/plan/22b-persistence-load-and-fs.md: `self.sim` must already exist (from
    /// `sim_restore_end` or `sim_genesis`) -- `segment` unused for wire purposes, same shape as
    /// `sim_segment_header`'s own (a segment's index lives in its storage key, never the wire), but
    /// kept (docs/plan/24-recovery-and-migration.md) to name the same segment the scan pass already
    /// ran over. Deliberately does **not** reset `self.replay_skip_targets`:
    /// `sim_replay_scan_begin`/`push`/`end` (above) populates it first, over the same bytes, before
    /// this real apply pass ever runs.
    fn sim_replay_begin(&mut self, segment: u32, offset: u32) -> Status {
        if self.sim.is_none() {
            return Status::NotInitialised;
        }
        let tick = self.sim.as_ref().unwrap().tick().0;
        self.mark_progress(Phase::Replay, tick, offset);
        self.replay_reader = Some(crate::persist::FrameReader::new());
        self.replay_base_offset = offset;
        self.replay_fed = 0;
        self.replay_torn = false;
        self.replay_dropped_undecodable = 0;
        self.replay_segment = segment;
        self.mark_idle(tick);
        Status::Ok
    }

    /// Applies every whole, CRC-valid frame `bytes` completes (idle ticks implied by `tick_delta`
    /// stepped first, exactly `testing::replay`'s own algorithm) through the live tick procedure
    /// (`Sim::step_with_progress`), honouring every `Skip` target `sim_replay_scan_begin`/`push`/
    /// `end` already collected into `self.replay_skip_targets`: a record whose own absolute byte
    /// offset (`replay_base_offset` + its `DecodedFrame::record_offsets` entry) is a skip target is
    /// never applied, but still advances that player's `last_seq` (`Authority::record_ack`, without
    /// `apply`/`on_player`) and queues an `EngineFault` ack for their next `Host::connect`
    /// (Planning decisions 4). **A frame with `tick_delta == 0` is a `Skip`-only administrative
    /// frame, never a real elapsed tick** (0005: appending one must never disturb
    /// `self.last_logged_tick` or any later frame's own idle-tick count): it is decoded (its own
    /// `Skip` record was already seen by the scan pass) but never stepped at all. Advances
    /// `self.last_logged_tick` to each applied frame's own tick, so live logging continues
    /// correctly (`sim_seal_frame`'s own `tick_delta` reference) once replay hands off to real
    /// ticking.
    fn sim_replay_push(&mut self, bytes: &[u8]) -> Status {
        if self.sim.is_none() {
            return Status::NotInitialised;
        }
        if self.replay_reader.is_none() {
            return Status::NotInitialised;
        }
        if self.replay_torn {
            return Status::TornTail;
        }
        let tick = self.sim.as_ref().unwrap().tick().0;
        self.mark_progress(
            Phase::Replay,
            tick,
            self.replay_base_offset.wrapping_add(self.replay_fed as u32),
        );
        self.replay_fed += bytes.len() as u64;
        let base_offset = self.replay_base_offset;
        let mut remaining = bytes;
        let mut out: Vec<Outcome<G>> = Vec::new();
        let mut filtered: Vec<Record<G>> = Vec::new();
        let mut filtered_offsets: Vec<u32> = Vec::new();
        loop {
            let progress = match self.replay_reader.as_mut().unwrap().push(remaining) {
                Ok(p) => p,
                Err(_) => {
                    self.replay_torn = true;
                    break;
                }
            };
            remaining = &[];
            let frame = match progress {
                crate::persist::FrameProgress::NeedMore => break,
                crate::persist::FrameProgress::Frame(f) => f,
            };
            if frame.tick_delta == 0 {
                // Administrative `Skip`-only frame (0005 "Panic recovery"): never a real elapsed
                // tick; its own record was already scanned into `replay_skip_targets`.
                continue;
            }
            let frame_tick = self.last_logged_tick.0.wrapping_add(frame.tick_delta);
            let sim_tick_now = self.sim.as_ref().unwrap().tick().0;
            let idle = frame_tick.saturating_sub(1).saturating_sub(sim_tick_now);
            for _ in 0..idle {
                let progress_ptr = self.progress_ptr;
                let Host {
                    sim,
                    progress,
                    progress_log,
                    ..
                } = self;
                let sim = sim.as_mut().unwrap();
                let mut hook =
                    progress_writer(progress, progress_log, progress_ptr, sim.tick().0 + 1);
                sim.step_with_progress(&[], &mut out, &mut hook);
            }
            filtered.clear();
            filtered_offsets.clear();
            for (i, record) in frame.records.into_iter().enumerate() {
                let abs_offset = base_offset.wrapping_add(frame.record_offsets[i] as u32);
                if self.replay_skip_targets.contains(&abs_offset) {
                    if let crate::persist::FrameRecord::Action { who, seq, .. } = &record {
                        self.sim
                            .as_mut()
                            .unwrap()
                            .authority_mut()
                            .record_ack(*who, *seq);
                        self.pending_fault_acks.push((*who, *seq));
                    }
                    continue;
                }
                // docs/plan/24b-upgrade-and-migration.md decision 6 (amending 0024 §3b): an action
                // whose own bytes failed `decode_canonical` under this build is dropped, not fatal --
                // the frame's own crc32 already verified everything around it, so this is a content
                // mismatch (an unbumped `SCHEMA_VERSION` change to `G::Action`'s layout, or defensive
                // corruption tolerance), never a framing error. Counted and warned; the player's own
                // `last_seq` still advances (an `EngineFault` ack, the same treatment a `Skip` target
                // already gets) so a resend of this exact `seq` is not misapplied as new.
                if let crate::persist::FrameRecord::Undecodable { who, seq } = &record {
                    self.replay_dropped_undecodable += 1;
                    crate::abi::panic::log(
                        crate::abi::registry::LogLevel::Warn,
                        "replay: a tail action failed to decode under this build; dropped (0024 §3b)",
                    );
                    self.sim
                        .as_mut()
                        .unwrap()
                        .authority_mut()
                        .record_ack(*who, *seq);
                    self.pending_fault_acks.push((*who, *seq));
                    continue;
                }
                if let Some(r) = to_record(record) {
                    filtered.push(r);
                    filtered_offsets.push(abs_offset);
                }
            }
            let progress_ptr = self.progress_ptr;
            let Host {
                sim,
                progress,
                progress_log,
                ..
            } = self;
            let sim = sim.as_mut().unwrap();
            let mut base_hook = progress_writer(progress, progress_log, progress_ptr, frame_tick);
            let mut hook = |phase: Phase, i: u32| {
                let record = match phase {
                    Phase::ApplyRecord | Phase::OnPlayer => {
                        filtered_offsets.get(i as usize).copied().unwrap_or(0)
                    }
                    _ => 0,
                };
                base_hook(phase, record);
            };
            sim.step_with_progress(&filtered, &mut out, &mut hook);
            self.last_logged_tick = Tick(frame_tick);
        }
        if self.replay_torn {
            Status::TornTail
        } else {
            Status::Ok
        }
    }

    /// docs/plan/22b-persistence-load-and-fs.md: does **not** clear `self.replay_reader` (unlike
    /// `sim_restore_end`'s own `.take()`) -- `sim_replay_valid_end` needs to keep reading its
    /// `buffered_len()` afterward; the next `sim_replay_begin` replaces it anyway.
    fn sim_replay_end(&mut self, result: &mut [u8]) -> Status {
        if self.replay_reader.is_none() {
            return Status::NotInitialised;
        }
        if let Some(out) = result.get_mut(..4) {
            out.copy_from_slice(&self.replay_dropped_undecodable.to_le_bytes());
        }
        if self.replay_torn {
            Status::TornTail
        } else {
            Status::Ok
        }
    }

    fn sim_replay_valid_end(&mut self) -> u32 {
        let Some(reader) = self.replay_reader.as_ref() else {
            return 0;
        };
        let buffered = reader.buffered_len() as u64;
        (self.replay_base_offset as u64 + self.replay_fed.saturating_sub(buffered)) as u32
    }

    fn sim_tick_now(&mut self) -> u32 {
        self.sim.as_ref().map_or(0, |s| s.tick().0)
    }

    /// docs/plan/24-recovery-and-migration.md: encodes one frame holding a single `Skip { segment,
    /// offset }` record, `tick_delta = 0` (never a real elapsed tick, so appending it never
    /// disturbs `self.last_logged_tick` or any later frame's idle-tick count -- `sim_replay_end`'s
    /// own apply pass never steps a `tick_delta == 0` frame at all). Needs no live `Sim`: purely an
    /// encoding function, reusing `persist::FrameWriter` directly rather than `Host::sim_seal_frame`'s
    /// own hand-rolled encoding (that one exists only because it must not require `G::Action:
    /// Clone`; a `Skip` record carries no game-typed payload at all).
    fn sim_log_skip(
        &mut self,
        segment: u32,
        offset: u32,
        persist: &mut [u8],
    ) -> Result<u32, Status> {
        let mut w: crate::persist::FrameWriter<G> = crate::persist::FrameWriter::new();
        w.push_skip(segment, offset);
        let mut sink = SliceSink::new(persist);
        w.finish(0, &mut sink);
        sink.finish()
            .map(|n| n as u32)
            .map_err(|_| Status::BadLength)
    }

    /// docs/plan/24-recovery-and-migration.md: panics in whatever `Phase` the previous,
    /// successfully-completed export left the `Progress` region in -- writes nothing of its own, so
    /// a call right after any ordinary export reports `Phase::Idle`. Uses `panic::fatal` (never
    /// `panic!`, `.claude/rules/hot-paths.md`-adjacent reasoning even though this itself is never a
    /// hot path: consistent with every other panic site in this crate) so the message reaches the
    /// host through the same `engine.panic` import as a real bug, indistinguishable to a caller.
    fn sim_test_trap(&mut self) -> Status {
        crate::abi::panic::fatal(format_args!("sim_test_trap: deliberate test trap"))
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
