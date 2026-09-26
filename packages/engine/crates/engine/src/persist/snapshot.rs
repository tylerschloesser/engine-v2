//! The streaming snapshot container (0005 Formats: "magic | container_version u16 | identity |
//! tick u32 | log position (segment, byte offset) | engine section (tick, SimRng, player table, id
//! counters, overlays, entities, active lists and timers in canonical order) | state_hash u64 |
//! crc32"). 0005's grammar lists `tick` twice (once at the top level, once again inside its own
//! recap of the engine section); this module writes it exactly once, right after `identity` and
//! before the log position -- `Store<G>` itself holds neither `tick` nor `SimRng` (M12/M12b: they
//! are `Authority`'s own driver state), so "the engine section" here is `SimRng` followed
//! immediately by `Store::encode`'s own bytes (player table onward, already in the order 0005
//! lists), with no second `tick` field to write (docs/plan/22-persistence-log-and-snapshots.md
//! Deviations has the reasoning).
//!
//! **Fix round 2 adds a `log_ref_tick` u32 right after `log_offset`**: the tick of the most
//! recently logged frame in this segment as of that log position (`0` = none yet, equivalent to
//! genesis -- [`SnapshotWriter::begin`]'s own doc comment). Needed because a periodic snapshot can
//! be taken well after the last real frame (an idle world, `sim_dirty()` still set from an old
//! event); without it, `testing::replay`'s own `Base::Snapshot` path has no way to correctly
//! interpret the *next* frame's `tick_delta`, which is always relative to that reference tick, not
//! to the snapshot's own tick. `container_version` stays `1` (an ADR amendment covers this and the
//! other two additions here together, docs/plan/22-persistence-log-and-snapshots.md Deviations).
//!
//! **A `total_len` varint, not named by 0005, is added right after `container_version`**: it is
//! the byte length of everything from `identity` through the trailing `crc32`, inclusive. Without
//! it, [`SnapshotReader`] (which -- like [`crate::persist::FrameReader`] -- must accept bytes in
//! arbitrary block splits) has no way to tell "not enough bytes buffered yet" apart from "this is
//! corrupt" while decoding a compound, variable-length body; with it, the reader simply buffers
//! until it has `total_len` bytes, then decodes and CRC-checks the whole thing in one pass. This is
//! the one deliberate addition beyond 0005's literal grammar (recorded in this milestone's
//! Deviations, not a silent one).
//!
//! **The writer builds its full byte buffer up front, in `begin`, rather than genuinely walking
//! `Store`'s sections incrementally (a "section index + last key" cursor).** Planning decisions 1
//! motivates the incremental design as a way to avoid holding one snapshot's bytes anywhere in
//! memory at once, but the very next sentence of that same decision has the host doing exactly
//! that on the JS side (`SnapshotBuffer`, "the memory cost ... is recorded in Budgets") -- so a
//! full in-memory copy is already the accepted cost, not a new one. Building it in one call keeps
//! this half of the milestone within scope: an incremental cursor able to pause and resume mid-
//! `BTreeMap` (players, entities, the timer wheel, ...) at an arbitrary block boundary is
//! substantially more code for the same external contract (`begin`/`next(&mut [u8]) -> len`,
//! draining in blocks, is exactly what this still does). Flagged here for the orchestrator.

use crate::bytes::{ByteReader, ByteSink, CountSink};
use crate::game::Game;
use crate::persist::{
    Identity, PersistError, VarintPeek, crc32, peek_varint, read_sized, write_sized,
};
use crate::rng::SimRng;
use crate::store::Store;
use crate::time::Tick;

const MAGIC: [u8; 4] = *b"PSN1";
const CONTAINER_VERSION: u16 = 1;

/// Sanity bound on a snapshot's total declared length (a corrupt `total_len` must not make
/// [`SnapshotReader::push`] buffer without limit before ever reaching the CRC that would reject
/// it). Generous: 0020 §9's own "large save" is roughly 15 MiB.
pub const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

struct VecSink<'a>(&'a mut Vec<u8>);
impl ByteSink for VecSink<'_> {
    fn put(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

/// A resumable cursor over one fully-encoded snapshot (Planning decisions 1; the module doc
/// comment records the one way this deviates from a genuinely incremental per-section walk).
/// [`SnapshotWriter::begin`] builds the bytes once; [`SnapshotWriter::next`] drains them in
/// caller-sized blocks, `0` meaning done -- the shape `sim_snapshot_begin`/`sim_snapshot_next`
/// (docs/plan/22-persistence-log-and-snapshots.md Seams) will call.
pub struct SnapshotWriter {
    buf: Vec<u8>,
    pos: usize,
}

impl SnapshotWriter {
    /// `log_ref_tick` (fix round 2, docs/plan/22-persistence-log-and-snapshots.md): the tick of the
    /// most recently *logged* frame in this segment as of `log_segment`/`log_offset` (`Host::
    /// last_logged_tick`'s own value, unchanged by taking a snapshot -- see `Host::
    /// sim_snapshot_begin`'s doc comment for why resetting it there was tried and reverted).
    /// Sentinel `0` means "no frame has been logged in this segment yet", equivalent to a genesis
    /// reference: a real frame's tick is never `0` (`Host::sim_seal_frame` always seals for
    /// `sim.tick() + 1`, and `sim.tick()` starts at `0`), so `0` is unambiguous. Read back by
    /// [`SnapshotReader`] into [`SnapshotInfo::log_ref_tick`] and consumed by `testing::replay`'s
    /// own `Base::Snapshot` path to seed its `tick_delta` reference correctly.
    pub fn begin<G: Game>(
        store: &Store<G>,
        tick: Tick,
        rng: &SimRng,
        log_segment: u32,
        log_offset: u32,
        log_ref_tick: u32,
        identity: &Identity,
    ) -> Self {
        // Orchestrator ruling (docs/plan/22-persistence-log-and-snapshots.md, second-half
        // delegation prompt): "make its buffer sized exactly once (no doubling growth)". A first,
        // count-only pass over the identical writes (`CountSink`, the same sink `codec::
        // encoded_len` uses) gives the exact payload length up front, so the real pass below
        // allocates `payload` with `Vec::with_capacity(payload_len)` and never reallocates -- unlike
        // the original `Vec::new()` + push-as-you-go shape, which grew by doubling.
        let mut count = CountSink::default();
        identity.write(&mut count);
        count.put_u32(tick.0);
        count.put_u32(log_segment);
        count.put_u32(log_offset);
        count.put_u32(log_ref_tick);
        write_sized(rng, &mut count);
        store.encode(&mut count);
        count.put_u64(0); // state_hash: always exactly 8 bytes, whatever the real value is.
        let payload_len = count.0;

        let mut payload = Vec::with_capacity(payload_len);
        {
            let mut sink = VecSink(&mut payload);
            identity.write(&mut sink);
            sink.put_u32(tick.0);
            sink.put_u32(log_segment);
            sink.put_u32(log_offset);
            sink.put_u32(log_ref_tick);
            write_sized(rng, &mut sink);
            store.encode(&mut sink);
            sink.put_u64(store.state_hash());
        }
        debug_assert_eq!(
            payload.len(),
            payload_len,
            "the counting pass above must match the real pass exactly"
        );
        let crc = crc32(&payload);

        // Same treatment for the outer container: an exact varint-length count instead of the
        // fixed 10-byte over-reservation the outer `buf` used to carry (harmless there since it
        // never triggered a second allocation either way, but this makes both buffers' sizing
        // reasoning identical, and `total_len()` below is exactly this milestone's own "Rust-side
        // snapshot buffer's peak size", the Budgets "Memory per instance" row).
        let mut varint_len_count = CountSink::default();
        varint_len_count.put_varint((payload.len() + 4) as u64);
        let varint_bytes = varint_len_count.0;

        let mut buf = Vec::with_capacity(4 + 2 + varint_bytes + payload.len() + 4);
        {
            let mut sink = VecSink(&mut buf);
            sink.put(&MAGIC);
            sink.put_u16(CONTAINER_VERSION);
            sink.put_varint((payload.len() + 4) as u64);
            sink.put(&payload);
            sink.put_u32(crc);
        }
        debug_assert_eq!(
            buf.len(),
            buf.capacity(),
            "buf must be sized exactly once, with no reallocation"
        );
        SnapshotWriter { buf, pos: 0 }
    }

    /// Copies up to `out.len()` of the remaining bytes into `out`, returning the count copied (`0`
    /// once every byte has been drained).
    pub fn next(&mut self, out: &mut [u8]) -> usize {
        let remaining = self.buf.len() - self.pos;
        let n = remaining.min(out.len());
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        n
    }

    /// The whole snapshot's byte length (for a caller that wants to size its own buffer up front,
    /// e.g. a native test). Also this milestone's own "Rust-side snapshot buffer's peak size"
    /// (Budgets "Memory per instance"): `buf` is allocated at exactly this size in [`Self::begin`]
    /// and never grows afterward, so this is the peak, not a snapshot of a still-growing value.
    pub fn total_len(&self) -> usize {
        self.buf.len()
    }
}

/// Everything a decoded snapshot carries besides the `Store<G>` itself (handed separately,
/// [`SnapshotReader::into_store`], since it is not `Clone` in general).
#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotInfo {
    pub identity: Identity,
    pub tick: Tick,
    pub log_segment: u32,
    pub log_offset: u32,
    /// Fix round 2 (docs/plan/22-persistence-log-and-snapshots.md): see [`SnapshotWriter::begin`]'s
    /// own doc comment for the sentinel (`0` = no frame logged yet in this segment).
    pub log_ref_tick: u32,
    pub rng: SimRng,
    pub state_hash: u64,
}

pub enum SnapshotProgress {
    NeedMore,
    Done(SnapshotInfo),
}

/// Container-envelope framing shared by [`SnapshotReader::push`] and [`UpgradeReader::push`]
/// (docs/plan/24b-upgrade-and-migration.md step 4): magic, `container_version`, the `total_len`
/// varint, and the trailing crc32 -- returns the crc-verified payload slice (identity through
/// `state_hash`, inclusive) once a whole container has been buffered, `None` while more bytes are
/// still needed. Factored out so the two readers' framing cannot drift apart (both call this, rather
/// than each re-implementing the same magic/version/varint/crc checks).
fn take_verified_payload(buf: &[u8]) -> Result<Option<&[u8]>, PersistError> {
    if buf.len() < 4 + 2 {
        return Ok(None);
    }
    if buf[0..4] != MAGIC {
        return Err(PersistError::Malformed);
    }
    let version = u16::from_le_bytes(buf[4..6].try_into().expect("2 bytes"));
    if version != CONTAINER_VERSION {
        return Err(PersistError::ContainerVersion);
    }
    let (total_len, len_bytes) = match peek_varint(&buf[6..]) {
        VarintPeek::Incomplete => return Ok(None),
        VarintPeek::Malformed => return Err(PersistError::Malformed),
        VarintPeek::Value(v, n) => (v as usize, n),
    };
    if total_len > MAX_SNAPSHOT_BYTES {
        return Err(PersistError::Malformed);
    }
    if total_len < 8 {
        // At minimum a state_hash (8 bytes) plus its crc32 (4 bytes) must fit.
        return Err(PersistError::Malformed);
    }
    let prefix = 6 + len_bytes;
    if buf.len() < prefix + total_len {
        return Ok(None);
    }
    let whole = &buf[prefix..prefix + total_len];
    let (payload, crc_bytes) = whole.split_at(total_len - 4);
    let want_crc = u32::from_le_bytes(crc_bytes.try_into().expect("4 bytes"));
    if crc32(payload) != want_crc {
        return Err(PersistError::Crc);
    }
    Ok(Some(payload))
}

/// The envelope-only counterpart to [`SnapshotReader`] (docs/plan/24b-upgrade-and-migration.md step
/// 4): buffers exactly the same container bytes (0005 Formats) and performs the exact same
/// magic/version/total_len/crc checks ([`take_verified_payload`]), but stops short of decoding the
/// store section into any particular `Store<G>` shell. The upgrade path needs [`crate::persist::
/// Identity::compare`]'s verdict first, to know whether the store section is the running build's own
/// `Store<G>` (`Same`/`Direct`) or an older schema's `OldStore` (`NeedsMigrate`;
/// `crate::migrate::OldStore::decode`) -- a decision only `sim_upgrade_end` (host/mod.rs), which
/// knows the concrete `G`, can make.
pub struct UpgradeReader {
    buf: Vec<u8>,
}

/// Everything [`UpgradeReader::push`] parses at the container-envelope level: identity and the
/// fields 0005 Snapshot lists before "engine section" (tick, log position), the engine section's own
/// `SimRng`, and the store section's own raw bytes (right after `rng`, up to but excluding the
/// trailing `state_hash`) -- exactly what [`crate::store::Store::decode`] or [`crate::migrate::
/// OldStore::decode`] each expect a fresh [`crate::bytes::ByteReader`] positioned at.
pub struct UpgradeEnvelope {
    pub identity: Identity,
    pub tick: Tick,
    pub log_segment: u32,
    pub log_offset: u32,
    pub log_ref_tick: u32,
    pub rng: SimRng,
    pub store_bytes: Vec<u8>,
    pub state_hash: u64,
}

pub enum UpgradeProgress {
    NeedMore,
    Done(UpgradeEnvelope),
}

impl Default for UpgradeReader {
    fn default() -> Self {
        Self::new()
    }
}

impl UpgradeReader {
    pub fn new() -> Self {
        UpgradeReader { buf: Vec::new() }
    }

    pub fn push(&mut self, block: &[u8]) -> Result<UpgradeProgress, PersistError> {
        self.buf.extend_from_slice(block);
        let payload = match take_verified_payload(&self.buf)? {
            Some(p) => p,
            None => return Ok(UpgradeProgress::NeedMore),
        };
        let mut reader = ByteReader::new(payload);
        let identity = Identity::read(&mut reader)?;
        let tick = Tick(reader.u32().map_err(|_| PersistError::Malformed)?);
        let log_segment = reader.u32().map_err(|_| PersistError::Malformed)?;
        let log_offset = reader.u32().map_err(|_| PersistError::Malformed)?;
        let log_ref_tick = reader.u32().map_err(|_| PersistError::Malformed)?;
        let rng: SimRng = read_sized(&mut reader)?;
        let remaining = reader.rest();
        let store_len = remaining
            .len()
            .checked_sub(8)
            .ok_or(PersistError::Malformed)?;
        let store_bytes = remaining[..store_len].to_vec();
        let state_hash = u64::from_le_bytes(
            remaining[store_len..]
                .try_into()
                .expect("checked_sub(8) above guarantees exactly 8 bytes remain"),
        );
        Ok(UpgradeProgress::Done(UpgradeEnvelope {
            identity,
            tick,
            log_segment,
            log_offset,
            log_ref_tick,
            rng,
            store_bytes,
            state_hash,
        }))
    }
}

/// The other half of [`SnapshotWriter`]: a resumable, block-split-tolerant reader that decodes
/// into a caller-supplied, already-constructed empty `Store<G>` shell (correct terrain pristine
/// source/dims/cache capacity, exactly what `Store::decode` already requires -- see its own doc
/// comment). Reconstructing a whole stored world from this is Non-scope (docs/plan/
/// 22-persistence-log-and-snapshots.md Non-scope: "loading a stored world ... M22b"); this is the
/// container-level round trip only, used natively by `testing::replay`/`testing::heavy` and by
/// this module's own tests.
pub struct SnapshotReader<G: Game> {
    store: Store<G>,
    buf: Vec<u8>,
}

impl<G: Game> SnapshotReader<G> {
    pub fn new(shell: Store<G>) -> Self {
        SnapshotReader {
            store: shell,
            buf: Vec::new(),
        }
    }

    pub fn push(&mut self, block: &[u8]) -> Result<SnapshotProgress, PersistError> {
        self.buf.extend_from_slice(block);
        let payload = match take_verified_payload(&self.buf)? {
            Some(p) => p,
            None => return Ok(SnapshotProgress::NeedMore),
        };
        let mut reader = ByteReader::new(payload);
        let identity = Identity::read(&mut reader)?;
        let tick = Tick(reader.u32().map_err(|_| PersistError::Malformed)?);
        let log_segment = reader.u32().map_err(|_| PersistError::Malformed)?;
        let log_offset = reader.u32().map_err(|_| PersistError::Malformed)?;
        let log_ref_tick = reader.u32().map_err(|_| PersistError::Malformed)?;
        let rng: SimRng = read_sized(&mut reader)?;
        self.store
            .decode(&mut reader)
            .map_err(|_| PersistError::Malformed)?;
        let state_hash = reader.u64().map_err(|_| PersistError::Malformed)?;
        Ok(SnapshotProgress::Done(SnapshotInfo {
            identity,
            tick,
            log_segment,
            log_offset,
            log_ref_tick,
            rng,
            state_hash,
        }))
    }

    /// The decoded store, after [`SnapshotProgress::Done`]. Meaningless before then (still the
    /// empty shell passed to [`SnapshotReader::new`]).
    pub fn into_store(self) -> Store<G> {
        self.store
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::world::{
        CacheCapacity, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos, TraitSet,
    };
    use crate::worldgen::{Pristine, Worldgen, WorldgenStamp};

    struct ZeroSource;
    impl PristineSource for ZeroSource {
        fn generate(&self, _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    enum TAction {
        Noop,
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct TReject;
    impl From<Unknown> for TReject {
        fn from(_: Unknown) -> Self {
            TReject
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TEntity {
        n: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TPlayer {
        n: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TGlobal {
        n: u32,
    }
    struct TGen;
    impl Worldgen for TGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct TGame;
    impl Game for TGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = TGen;
        type Action = TAction;
        type Reject = TReject;
        type Entity = TEntity;
        type Player = TPlayer;
        type Global = TGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {
            let _ = TraitSet::EMPTY;
        }
        fn prototype(_e: &TEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &TEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: PlayerId,
            _a: &TAction,
        ) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn identity_for<G: Game>() -> Identity {
        Identity {
            build_hash: [1; 16],
            engine_version: "0.0.0".to_string(),
            game_version: "0.0.0".to_string(),
            schema_version: G::SCHEMA_VERSION,
            tick_rate_hz: 20,
            worldgen: WorldgenStamp {
                version: 0,
                fingerprint: 0,
            },
        }
    }

    fn store_with(entities: u32, players: u32, cache: CacheCapacity) -> Store<TGame> {
        let terrain =
            crate::world::TerrainStore::new(ChunkDims::new(4), Box::new(ZeroSource), cache);
        let mut store = Store::<TGame>::new(terrain, TGlobal { n: 9 });
        for i in 0..entities {
            store.apply(&crate::delta::Delta::EntityPut {
                id: crate::game::EntityId(i + 1),
                entity: TEntity { n: i },
            });
        }
        for i in 0..players {
            store.apply(&crate::delta::Delta::Player {
                who: PlayerId(i + 1),
                state: TPlayer { n: i },
            });
        }
        store
    }

    fn shell(cache: CacheCapacity) -> Store<TGame> {
        let source: Box<dyn PristineSource> = Box::new(Pristine::<TGen>::new(1, ()));
        let terrain = crate::world::TerrainStore::new(ChunkDims::new(4), source, cache);
        Store::<TGame>::new(terrain, TGlobal::default())
    }

    fn drain(w: &mut SnapshotWriter) -> Vec<u8> {
        let mut out = vec![0u8; w.total_len()];
        let n = w.next(&mut out);
        assert_eq!(n, out.len(), "one block covers the whole thing here");
        out
    }

    #[cfg(feature = "testing")]
    #[test]
    fn persist_snapshot_golden_bytes() {
        let store = store_with(2, 1, CacheCapacity::Chunks(4));
        let rng = SimRng::new(7);
        let mut w = SnapshotWriter::begin(
            &store,
            Tick(100),
            &rng,
            3,
            456,
            77,
            &identity_for::<TGame>(),
        );
        let bytes = drain(&mut w);
        crate::assert_golden_bytes!("persist_snapshot_golden_bytes", &bytes);
    }

    #[test]
    fn snapshot_roundtrip_random_blocks() {
        let store = store_with(5, 2, CacheCapacity::Chunks(4));
        let rng = SimRng::new(123);
        let want_hash = store.state_hash();
        let mut w =
            SnapshotWriter::begin(&store, Tick(42), &rng, 1, 99, 17, &identity_for::<TGame>());
        let bytes = drain(&mut w);

        // Arbitrary, deterministic block splits (a fixed pattern, not a real RNG dependency): 1,
        // 2, 3, 5, 8, 13, 21 bytes at a time, wrapping -- proves the reader tolerates any split.
        let sizes = [1usize, 2, 3, 5, 8, 13, 21];
        let mut reader: SnapshotReader<TGame> =
            SnapshotReader::new(shell(CacheCapacity::Chunks(4)));
        let mut offset = 0;
        let mut si = 0;
        let info = loop {
            let want = sizes[si % sizes.len()];
            si += 1;
            let n = want.min(bytes.len() - offset);
            let end = offset + n;
            match reader.push(&bytes[offset..end]).unwrap() {
                SnapshotProgress::NeedMore => offset = end,
                SnapshotProgress::Done(info) => break info,
            }
        };
        assert_eq!(info.tick, Tick(42));
        assert_eq!(info.log_segment, 1);
        assert_eq!(info.log_offset, 99);
        assert_eq!(info.log_ref_tick, 17);
        assert_eq!(info.rng, rng);
        assert_eq!(info.state_hash, want_hash);
        let decoded = reader.into_store();
        assert_eq!(decoded.state_hash(), want_hash);
    }

    #[test]
    fn snapshot_roundtrip_covers_timers_active_and_wake_together() {
        // Reproduces the M21b gap this milestone's own brief calls out: a roundtrip test that
        // never leaves the wake queue non-empty at the snapshot point passes vacuously. Timers and
        // active-list membership are populated through the ordinary `Sim::step` tick path; the
        // wake queue's own `next` list is populated the same way M21b's own fix round did -- an
        // `Authority`-level put made *outside* any `step()` call, so its auto-wake push is never
        // swapped away by that call's own `begin_tick`.
        use crate::authority::Authority;
        use crate::sim::{Sim, WorldParams};
        use crate::world::SystemId;
        use crate::world_access::{WorldRead as _, WorldWrite as _};

        const TIMER_SYS: SystemId = SystemId(0);

        struct TimerGame;
        impl Game for TimerGame {
            const SCHEMA_VERSION: u32 = 1;
            type Worldgen = TGen;
            type Action = TAction;
            type Reject = TReject;
            type Entity = TEntity;
            type Player = TPlayer;
            type Global = TGlobal;
            type Presence = ();
            type Ui = ();
            type Client = ();
            fn register(r: &mut Registry) {
                r.system("timers");
            }
            fn prototype(_e: &TEntity) -> PrototypeId {
                PrototypeId(0)
            }
            fn anchor(_e: &TEntity) -> TilePos {
                TilePos::new(0, 0)
            }
            fn genesis(w: &mut dyn WorldWrite<Self>) {
                let id = w.spawn(TEntity { n: 0 });
                debug_assert_eq!(id, crate::game::EntityId(1));
            }
            fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
            fn apply(
                _w: &mut dyn WorldWrite<Self>,
                _who: PlayerId,
                _a: &TAction,
            ) -> Result<(), TReject> {
                Ok(())
            }
            fn tick(cx: &mut TickCx<'_, Self>) {
                cx.wake_at(
                    crate::game::EntityId(1),
                    cx.tick().add(crate::time::Ticks(5)),
                );
                cx.activate(TIMER_SYS, crate::game::EntityId(1));
            }
        }

        let params = WorldParams::<TimerGame> {
            seed: 1,
            worldgen: (),
            max_entities: 64,
            max_modified_tiles: 64,
            max_action_growth: 64,
        };
        let mut sim = Sim::<TimerGame>::genesis(params);
        let mut out = Vec::new();
        for _ in 0..3 {
            sim.step(&[], &mut out);
        }
        assert!(
            sim.authority().store().timers_pending() > 0,
            "timer wheel must be non-empty at the snapshot point"
        );
        assert!(
            sim.authority().store().active_len(TIMER_SYS) > 0,
            "active list must be non-empty at the snapshot point"
        );
        // Put an entity directly through `Authority`, outside `Sim::step`, so its auto-wake push
        // survives into the snapshot untouched (see the test's own doc comment).
        let authority: &mut Authority<TimerGame> = sim.authority_mut();
        let second = authority.spawn(TEntity { n: 1 });
        assert!(second.0 > 0);
        assert!(
            authority.store().wake_next_len() > 0,
            "wake queue's own next list must be non-empty at the snapshot point"
        );

        let store = sim.authority().store();
        let rng = sim.authority().rng();
        let want_hash = store.state_hash();
        let mut w = SnapshotWriter::begin(
            store,
            sim.tick(),
            &rng,
            0,
            0,
            0,
            &identity_for::<TimerGame>(),
        );
        let bytes = drain(&mut w);

        let shell_terrain = crate::world::TerrainStore::new(
            ChunkDims::new(4),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(4),
        );
        let shell = Store::<TimerGame>::new(shell_terrain, TGlobal::default());
        let mut reader: SnapshotReader<TimerGame> = SnapshotReader::new(shell);
        let info = match reader.push(&bytes).unwrap() {
            SnapshotProgress::Done(info) => info,
            SnapshotProgress::NeedMore => panic!("must decode in one push"),
        };
        assert_eq!(info.state_hash, want_hash);
        let decoded = reader.into_store();
        assert_eq!(decoded.state_hash(), want_hash);
        assert!(decoded.timers_pending() > 0);
        assert!(decoded.active_len(TIMER_SYS) > 0);
    }

    #[test]
    fn snapshot_excludes_dense_cache() {
        let a = store_with(3, 1, CacheCapacity::Chunks(1));
        let b = store_with(3, 1, CacheCapacity::Unlimited);
        // Warm both caches by reading tiles spread across 8 distinct chunks (`ChunkDims::new(4)`:
        // edge 16, so `20` tiles apart always lands in a new chunk) -- capacity 1 keeps evicting
        // down to a single resident chunk, `Unlimited` accumulates all 8, so the two caches'
        // *occupancy* (not just which chunks were ever touched) genuinely differs. A narrower
        // warm-up that never leaves a chunk's own boundary (this test's own first draft: 8 tiles
        // inside one chunk) made this test pass vacuously -- both capacities end up with exactly
        // one resident chunk either way, so an injected leak of the cache's pool size never showed
        // up (confirmed by injection, reverted; see this milestone's Deviations).
        for i in 0..8 {
            let _ = a.terrain().tile(TilePos::new(i * 20, 0));
            let _ = b.terrain().tile(TilePos::new(i * 20, 0));
        }
        let rng = SimRng::new(5);
        let mut wa = SnapshotWriter::begin(&a, Tick(1), &rng, 0, 0, 0, &identity_for::<TGame>());
        let mut wb = SnapshotWriter::begin(&b, Tick(1), &rng, 0, 0, 0, &identity_for::<TGame>());
        let bytes_a = drain(&mut wa);
        let bytes_b = drain(&mut wb);
        assert_eq!(
            bytes_a, bytes_b,
            "cache capacity must not leak into snapshot bytes"
        );
        assert_eq!(a.state_hash(), b.state_hash());
    }
}
