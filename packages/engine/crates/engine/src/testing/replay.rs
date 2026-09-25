//! Native replay and heavy mode (docs/decisions/0002-determinism-same-wasm-everywhere.md
//! "Enforcement": "Replay equality... Heavy mode"; docs/plan/22-persistence-log-and-snapshots.md
//! Order of work step 3). Both are driven entirely off [`crate::persist::FrameReader`] and
//! [`crate::sim::Sim`] -- no `Storage`, manifest or ABI involved (that is M22b's half).

use crate::authority::Authority;
use crate::game::Game;
use crate::persist::{
    DecodedFrame, FrameProgress, FrameReader, FrameRecord, Identity, SnapshotProgress,
    SnapshotReader, SnapshotWriter,
};
use crate::rng::SimRng;
use crate::sim::{Outcome, Record, Sim, WorldParams};
use crate::store::Store;
use crate::time::Tick;
use crate::world::{CacheCapacity, ChunkDims, PristineSource, TerrainStore};
use crate::worldgen::{Pristine, Worldgen, WorldgenStamp};

/// What [`replay`] starts from.
pub enum Base<G: Game> {
    /// `Game::genesis` from these params (0003), exactly `Sim::genesis`'s own path.
    Genesis(WorldParams<G>),
    /// An already-decoded snapshot's pieces (e.g. from [`crate::persist::SnapshotReader`]):
    /// replay resumes from here instead of genesis. Budgets are not carried by a snapshot's own
    /// container (0005 Formats), so this falls back to `Authority::new`'s defaults -- see
    /// `Authority::from_snapshot`'s own doc comment. Boxed: `Store<G>` is large (clippy::
    /// large_enum_variant), and this variant is already the "cold", off-the-hot-path one.
    Snapshot(Box<SnapshotBase<G>>),
}

/// [`Base::Snapshot`]'s payload, boxed there to keep `Base<G>` itself small.
pub struct SnapshotBase<G: Game> {
    pub store: Store<G>,
    pub tick: Tick,
    pub rng: SimRng,
}

fn to_record<G: Game>(r: &FrameRecord<G>) -> Option<Record<G>>
where
    G::Action: Clone,
{
    match r {
        FrameRecord::Action { who, seq, action } => Some(Record::Action {
            who: *who,
            seq: *seq,
            action: action.clone(),
        }),
        FrameRecord::Connection { who, ev } => Some(Record::Player { who: *who, ev: *ev }),
        // 0005 "Panic recovery" / this milestone's Non-scope: decodes as a no-op.
        FrameRecord::Skip { .. } => None,
    }
}

fn record_checkpoints<G: Game>(
    sim: &Sim<G>,
    checkpoints: &[Tick],
    ci: &mut usize,
    result: &mut Vec<(Tick, u64)>,
) {
    while *ci < checkpoints.len() && sim.tick() >= checkpoints[*ci] {
        result.push((checkpoints[*ci], sim.state_hash()));
        *ci += 1;
    }
}

/// Replays `log` from `base`, returning the state hash at each tick named in `checkpoints`
/// (ascending). `tick_delta` gaps are filled with idle `Sim::step(&[], ..)` calls, one per idle
/// tick, exactly `testkit::run_script`'s own "any gap ... filled with idle step calls" contract.
///
/// Stops cleanly at the first frame `FrameReader` cannot decode (malformed or a bad CRC) -- 0005
/// Recovery's "re-apply frames until the first truncated or CRC-failing frame ... truncate there".
/// A `checkpoint` past that point is simply missing from the result; callers that need to know
/// where replay stopped compare `result.len()` against `checkpoints.len()`, or the last returned
/// tick against the log's expected length.
pub fn replay<G: Game>(base: Base<G>, log: &[u8], checkpoints: &[Tick]) -> Vec<(Tick, u64)>
where
    G::Global: Default,
    G::Action: Clone,
{
    let mut sim = match base {
        Base::Genesis(params) => Sim::genesis(params),
        Base::Snapshot(b) => Sim::from_parts(Authority::from_snapshot(b.store, b.rng, b.tick)),
    };
    let mut out: Vec<Outcome<G>> = Vec::new();
    let mut reader: FrameReader<G> = FrameReader::new();
    let mut result = Vec::new();
    let mut ci = 0usize;
    let mut remaining = log;
    loop {
        let progress = match reader.push(remaining) {
            Ok(p) => p,
            Err(_) => break,
        };
        remaining = &[];
        let frame: DecodedFrame<G> = match progress {
            FrameProgress::NeedMore => break,
            FrameProgress::Frame(f) => f,
        };
        for _ in 0..frame.tick_delta.saturating_sub(1) {
            sim.step(&[], &mut out);
            record_checkpoints(&sim, checkpoints, &mut ci, &mut result);
        }
        let records: Vec<Record<G>> = frame.records.iter().filter_map(to_record).collect();
        sim.step(&records, &mut out);
        record_checkpoints(&sim, checkpoints, &mut ci, &mut result);
    }
    result
}

/// A placeholder `Identity` for a snapshot [`heavy`] takes purely to compare hashes: identity
/// validation is Non-scope here (M22b/M24b), so its fields are never checked against anything.
fn placeholder_identity<G: Game>() -> Identity {
    Identity {
        build_hash: [0; 16],
        engine_version: "0.0.0".to_string(),
        game_version: "0.0.0".to_string(),
        schema_version: G::SCHEMA_VERSION,
        tick_rate_hz: G::TICK_RATE.hz_value(),
        worldgen: WorldgenStamp {
            version: <G::Worldgen as Worldgen>::WORLDGEN_VERSION,
            fingerprint: 0,
        },
    }
}

fn fresh_shell<G: Game>(params: &WorldParams<G>) -> Store<G>
where
    G::Global: Default,
    <G::Worldgen as Worldgen>::Params: Clone,
{
    let dims = ChunkDims::new(G::CHUNK_BITS);
    let source: Box<dyn PristineSource> = Box::new(Pristine::<G::Worldgen>::new(
        params.seed,
        params.worldgen.clone(),
    ));
    let terrain = TerrainStore::new(dims, source, CacheCapacity::Chunks(1024));
    Store::new(terrain, G::Global::default())
}

/// The tick at which [`heavy`]'s two runs first disagree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FirstDivergence {
    pub tick: Tick,
}

fn step_pair<G: Game>(
    a: &mut Sim<G>,
    b: &mut Sim<G>,
    records: &[Record<G>],
    out: &mut Vec<Outcome<G>>,
) -> Result<(), FirstDivergence> {
    a.step(records, out);
    b.step(records, out);
    if a.state_hash() != b.state_hash() {
        return Err(FirstDivergence { tick: a.tick() });
    }
    Ok(())
}

fn maybe_snapshot<G: Game>(sim: &mut Sim<G>, params: &WorldParams<G>, since: &mut u32, every_n: u32)
where
    G::Global: Default,
    <G::Worldgen as Worldgen>::Params: Clone,
{
    *since += 1;
    if *since < every_n {
        return;
    }
    *since = 0;
    let identity = placeholder_identity::<G>();
    let rng = sim.authority().rng();
    let mut w = SnapshotWriter::begin(sim.authority().store(), sim.tick(), &rng, 0, 0, &identity);
    let mut bytes = vec![0u8; w.total_len()];
    let n = w.next(&mut bytes);
    debug_assert_eq!(n, bytes.len(), "one block drains a freshly-begun writer");
    let shell = fresh_shell(params);
    let mut reader: SnapshotReader<G> = SnapshotReader::new(shell);
    let info = match reader.push(&bytes) {
        Ok(SnapshotProgress::Done(info)) => info,
        Ok(SnapshotProgress::NeedMore) => {
            panic!("heavy mode: a freshly-drained snapshot must decode in one push")
        }
        Err(_) => panic!("heavy mode: a snapshot this process just wrote must round-trip"),
    };
    let restored = reader.into_store();
    let authority = Authority::from_snapshot(restored, info.rng, info.tick);
    *sim = Sim::from_parts(authority);
}

/// Heavy mode (docs/decisions/0002 "Heavy mode"; Planning decisions 6 of docs/plan/
/// 22-persistence-log-and-snapshots.md): replays `log` twice from the same `base`, run A
/// uninterrupted, run B snapshotting and restoring into a fresh `Sim` every `every_n` ticks.
/// Reports the first tick at which the two disagree.
pub fn heavy<G: Game>(base: WorldParams<G>, log: &[u8], every_n: u32) -> Result<(), FirstDivergence>
where
    G::Global: Default,
    G::Action: Clone,
    <G::Worldgen as Worldgen>::Params: Clone,
{
    let mut sim_a = Sim::genesis(base.clone());
    let mut sim_b = Sim::genesis(base.clone());
    let shell_params = base;
    let mut out: Vec<Outcome<G>> = Vec::new();
    let mut reader: FrameReader<G> = FrameReader::new();
    let mut since_snapshot = 0u32;
    let mut remaining = log;
    loop {
        let progress = match reader.push(remaining) {
            Ok(p) => p,
            Err(_) => break,
        };
        remaining = &[];
        let frame: DecodedFrame<G> = match progress {
            FrameProgress::NeedMore => break,
            FrameProgress::Frame(f) => f,
        };
        for _ in 0..frame.tick_delta.saturating_sub(1) {
            step_pair(&mut sim_a, &mut sim_b, &[], &mut out)?;
            maybe_snapshot(&mut sim_b, &shell_params, &mut since_snapshot, every_n);
        }
        let records: Vec<Record<G>> = frame.records.iter().filter_map(to_record).collect();
        step_pair(&mut sim_a, &mut sim_b, &records, &mut out)?;
        maybe_snapshot(&mut sim_b, &shell_params, &mut since_snapshot, every_n);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::ByteSink;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::persist::FrameWriter;
    use crate::world::{PrototypeId, Registry, Tile, TilePos};

    struct TGen;
    impl Worldgen for TGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    enum TAction {
        Bump,
        Reject,
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    enum TReject {
        Nope,
    }
    impl From<Unknown> for TReject {
        fn from(_: Unknown) -> Self {
            TReject::Nope
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TGlobal {
        counter: u32,
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
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &TEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &TEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(w: &mut dyn WorldWrite<Self>) {
            w.put_global(TGlobal::default());
        }
        fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
            if let PlayerEvent::Joined = ev {
                w.put_player(who, TPlayer);
            }
        }
        fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &TAction) -> Result<(), TReject> {
            match a {
                TAction::Bump => {
                    let mut g = *w.global();
                    g.counter = g.counter.wrapping_add(1);
                    w.put_global(g);
                    Ok(())
                }
                TAction::Reject => Err(TReject::Nope),
            }
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn params() -> WorldParams<TGame> {
        WorldParams {
            seed: 1,
            worldgen: (),
            max_entities: 64,
            max_modified_tiles: 64,
            max_action_growth: 64,
        }
    }

    struct V<'a>(&'a mut Vec<u8>);
    impl ByteSink for V<'_> {
        fn put(&mut self, b: &[u8]) {
            self.0.extend_from_slice(b);
        }
    }

    /// Builds a small log matching a live script run through `Sim::step` directly, so `log` and
    /// the live hashes stay in lockstep by construction (mirrors how the checked-in `persist`
    /// fixture log is produced, docs/plan/22-persistence-log-and-snapshots.md Order of work step
    /// 3). Script: tick 1 a Joined event; tick 2 a Bump; tick 4 (one idle tick 3 in between) a
    /// rejected action; tick 5 another Bump.
    fn build_log_and_live_hash() -> (Vec<u8>, u64, Vec<(Tick, u64)>) {
        let mut sim = Sim::<TGame>::genesis(params());
        let mut out = Vec::new();
        let mut log = Vec::new();
        let mut live_checkpoints = Vec::new();

        let mut w = FrameWriter::<TGame>::new();
        w.push_connection(PlayerId(1), PlayerEvent::Joined);
        w.finish(1, &mut V(&mut log));
        sim.step(
            &[Record::Player {
                who: PlayerId(1),
                ev: PlayerEvent::Joined,
            }],
            &mut out,
        );
        live_checkpoints.push((sim.tick(), sim.state_hash()));

        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 1, TAction::Bump);
        w.finish(1, &mut V(&mut log));
        sim.step(
            &[Record::Action {
                who: PlayerId(1),
                seq: 1,
                action: TAction::Bump,
            }],
            &mut out,
        );
        live_checkpoints.push((sim.tick(), sim.state_hash()));

        // Tick 3 is idle: no frame at all (0005 "ticks without actions are not logged").
        sim.step(&[], &mut out);
        live_checkpoints.push((sim.tick(), sim.state_hash()));

        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 2, TAction::Reject);
        w.finish(2, &mut V(&mut log)); // tick_delta 2: covers idle tick 3 plus this tick 4.
        sim.step(
            &[Record::Action {
                who: PlayerId(1),
                seq: 2,
                action: TAction::Reject,
            }],
            &mut out,
        );
        live_checkpoints.push((sim.tick(), sim.state_hash()));

        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 3, TAction::Bump);
        w.finish(1, &mut V(&mut log));
        sim.step(
            &[Record::Action {
                who: PlayerId(1),
                seq: 3,
                action: TAction::Bump,
            }],
            &mut out,
        );
        live_checkpoints.push((sim.tick(), sim.state_hash()));

        (log, sim.state_hash(), live_checkpoints)
    }

    #[test]
    fn replay_from_genesis_checkpoints() {
        let (log, final_hash, live_checkpoints) = build_log_and_live_hash();
        let checkpoints: Vec<Tick> = live_checkpoints.iter().map(|(t, _)| *t).collect();
        let result = replay(Base::Genesis(params()), &log, &checkpoints);
        assert_eq!(result, live_checkpoints);
        assert_eq!(result.last().unwrap().1, final_hash);
    }

    #[test]
    fn replay_includes_rejected_actions() {
        // The rejected action (tick 4) is still in the log; replay must still reject it the same
        // way and land on the same final hash as the live run -- proving the reject was logged at
        // all (0004: rejected actions are logged, just not applied).
        let (log, final_hash, _) = build_log_and_live_hash();
        let result = replay(Base::Genesis(params()), &log, &[Tick(5)]);
        assert_eq!(result, vec![(Tick(5), final_hash)]);
    }

    #[test]
    fn replay_rebuilds_last_seq() {
        let (log, _, _) = build_log_and_live_hash();
        let _ = replay::<TGame>(Base::Genesis(params()), &log, &[]);
        // Replay the same log again, this time inspecting `last_seq` through a fresh Sim built
        // the same way `replay` builds its own -- last_seq is part of the encoded/hashed state
        // (`Store::last_seq`), so reconstructing it correctly is already implied by the checkpoint
        // hash matching; this test names the mechanism directly (0004: "the seq is what lets
        // replay rebuild each player's last processed seq").
        let mut sim = Sim::<TGame>::genesis(params());
        let mut out = Vec::new();
        let mut reader: FrameReader<TGame> = FrameReader::new();
        let mut remaining: &[u8] = &log;
        loop {
            let progress = reader.push(remaining).unwrap();
            remaining = &[];
            let frame = match progress {
                FrameProgress::NeedMore => break,
                FrameProgress::Frame(f) => f,
            };
            for _ in 0..frame.tick_delta.saturating_sub(1) {
                sim.step(&[], &mut out);
            }
            let records: Vec<Record<TGame>> = frame.records.iter().filter_map(to_record).collect();
            sim.step(&records, &mut out);
        }
        assert_eq!(sim.authority().store().last_seq(PlayerId(1)), Ok(3));
    }

    #[test]
    fn truncated_log_changes_hash() {
        let (log, final_hash, _) = build_log_and_live_hash();
        // Corrupt the very last byte (part of the last frame's crc32): the reader must reject
        // that frame and stop, so replay never reaches the live run's final hash.
        let mut truncated = log.clone();
        *truncated.last_mut().unwrap() ^= 0xFF;
        let result = replay(Base::Genesis(params()), &truncated, &[Tick(5)]);
        assert!(
            result.is_empty() || result[0].1 != final_hash,
            "a corrupted trailing frame must not silently reproduce the untouched hash"
        );
    }

    #[test]
    fn replay_from_snapshot_matches_genesis_replay() {
        use crate::persist::SnapshotProgress;

        // Full genesis replay to the end.
        let (log, final_hash, _) = build_log_and_live_hash();
        let genesis_result = replay(Base::Genesis(params()), &log, &[Tick(5)]);
        assert_eq!(genesis_result, vec![(Tick(5), final_hash)]);

        // Take a snapshot mid-log (after tick 2) from a live run, then replay only the tail
        // (frames after tick 2) from that snapshot, and confirm the same final hash.
        let mut sim = Sim::<TGame>::genesis(params());
        let mut out = Vec::new();
        sim.step(
            &[Record::Player {
                who: PlayerId(1),
                ev: PlayerEvent::Joined,
            }],
            &mut out,
        );
        sim.step(
            &[Record::Action {
                who: PlayerId(1),
                seq: 1,
                action: TAction::Bump,
            }],
            &mut out,
        );
        assert_eq!(sim.tick(), Tick(2));

        let rng = sim.authority().rng();
        let identity = placeholder_identity::<TGame>();
        let mut w =
            SnapshotWriter::begin(sim.authority().store(), sim.tick(), &rng, 0, 0, &identity);
        let mut bytes = vec![0u8; w.total_len()];
        let n = w.next(&mut bytes);
        assert_eq!(n, bytes.len());

        let shell = fresh_shell(&params());
        let mut reader: SnapshotReader<TGame> = SnapshotReader::new(shell);
        let info = match reader.push(&bytes).unwrap() {
            SnapshotProgress::Done(info) => info,
            SnapshotProgress::NeedMore => panic!("must decode in one push"),
        };
        let store = reader.into_store();
        assert_eq!(info.tick, Tick(2));

        // The tail: everything `build_log_and_live_hash` logs from tick 2 on (its own third and
        // fourth frames, unchanged) -- the snapshot already carries ticks 1-2, so replaying the
        // tail against `Base::Snapshot` must reach the same final hash as replaying the whole log
        // against `Base::Genesis` above.
        let mut tail = Vec::new();
        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 2, TAction::Reject);
        w.finish(2, &mut V(&mut tail)); // idle tick 3, lands on tick 4.
        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 3, TAction::Bump);
        w.finish(1, &mut V(&mut tail)); // lands on tick 5.

        let restored = replay(
            Base::Snapshot(Box::new(SnapshotBase {
                store,
                tick: info.tick,
                rng: info.rng,
            })),
            &tail,
            &[Tick(5)],
        );
        assert_eq!(restored, vec![(Tick(5), final_hash)]);
    }

    #[test]
    fn heavy_mode_agrees_when_uninterrupted_and_snapshotting() {
        let (log, _, _) = build_log_and_live_hash();
        assert_eq!(heavy(params(), &log, 1), Ok(()));
        assert_eq!(heavy(params(), &log, 2), Ok(()));
    }
}
