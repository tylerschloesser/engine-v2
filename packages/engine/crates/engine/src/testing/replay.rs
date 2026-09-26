//! Native replay and heavy mode (docs/decisions/0002-determinism-same-wasm-everywhere.md
//! "Enforcement": "Replay equality... Heavy mode"; docs/plan/22-persistence-log-and-snapshots.md
//! Order of work step 3). Both are driven entirely off [`crate::persist::FrameReader`] and
//! [`crate::sim::Sim`] -- no `Storage`, manifest or ABI involved (that is M22b's half).

use std::collections::BTreeSet;

use crate::authority::Authority;
use crate::game::{Game, PlayerId};
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
    /// Fix round 2 (docs/plan/22-persistence-log-and-snapshots.md): `persist::SnapshotInfo::
    /// log_ref_tick`, verbatim -- [`replay`] seeds its own `tick_delta` reference from this instead
    /// of assuming the log's first tail frame is relative to `tick` (true only when the snapshot
    /// coincided with the last logged frame, false after any idle gap before it).
    pub log_ref_tick: u32,
}

/// docs/plan/24-recovery-and-migration.md fix round 1: scans the *whole* log once, collecting
/// every `Skip { offset, .. }` record's own `offset` field (the payload, not a byte position --
/// mirrors `Host::sim_replay_scan_push`'s exact reasoning). Native `replay`/`heavy` take one flat
/// `log: &[u8]` with no segment concept at all, so `segment` is not checked here (there is only
/// ever "this log" to a native caller); a real multi-segment ambiguity cannot arise since these
/// functions are never handed more than one segment's own bytes.
fn scan_skip_targets<G: Game>(log: &[u8]) -> BTreeSet<u32> {
    let mut targets = BTreeSet::new();
    let mut reader: FrameReader<G> = FrameReader::new();
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
        for record in &frame.records {
            if let FrameRecord::Skip { offset, .. } = record {
                targets.insert(*offset);
            }
        }
    }
    targets
}

/// docs/plan/24-recovery-and-migration.md fix round 1: the real apply pass, run *after*
/// `scan_skip_targets` over the same log. `frame.record_offsets[i]` is already absolute from the
/// `FrameReader`'s own first-ever byte (`persist::frame::DecodedFrame`'s own doc comment) -- byte 0
/// of `log`, for every caller here (unlike `Host::sim_replay_push`, which resumes mid-segment and
/// needs its own `replay_base_offset` added). A matched `Action` record is never applied but must
/// still advance `last_seq` (Planning decisions 4) -- returned as `acked` so the caller can apply it
/// to whichever `Sim`(s) it is driving (one for `replay`, two for `heavy`, which must call
/// `record_ack` on *both* or their own A-vs-B hashes would diverge for a reason having nothing to do
/// with the divergence check itself).
fn filter_records<G: Game>(
    frame: &DecodedFrame<G>,
    targets: &BTreeSet<u32>,
) -> (Vec<Record<G>>, Vec<(PlayerId, u32)>)
where
    G::Action: Clone,
{
    let mut records = Vec::new();
    let mut acked = Vec::new();
    for (record, &offset) in frame.records.iter().zip(frame.record_offsets.iter()) {
        match record {
            FrameRecord::Action { who, seq, action } => {
                if targets.contains(&(offset as u32)) {
                    acked.push((*who, *seq));
                } else {
                    records.push(Record::Action {
                        who: *who,
                        seq: *seq,
                        action: action.clone(),
                    });
                }
            }
            FrameRecord::Connection { who, ev } => {
                records.push(Record::Player { who: *who, ev: *ev })
            }
            // Its own target was already collected by `scan_skip_targets`; the `Skip` record
            // itself is always a no-op (0005 "Panic recovery").
            FrameRecord::Skip { .. } => {}
            // docs/plan/24b-upgrade-and-migration.md decision 6: an action whose own bytes failed
            // `decode_canonical` under this build -- dropped like a skip target, `last_seq` still
            // advances (`Host::sim_replay_push`'s own treatment, mirrored here for this native
            // testkit path).
            FrameRecord::Undecodable { who, seq } => {
                acked.push((*who, *seq));
            }
        }
    }
    (records, acked)
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
    // Fix round 2 (docs/plan/22-persistence-log-and-snapshots.md): `reference_tick` is the tick
    // `frame.tick_delta` is relative to for the *next* frame decoded -- `0` from genesis (no frame
    // logged before tick 0, matching `Host::sim_seal_frame`'s own convention), or the snapshot's
    // own `log_ref_tick` when resuming mid-log. `sim.tick()` alone is *not* a safe stand-in for it:
    // a snapshot taken after an idle gap (nothing logged since well before it) starts `sim.tick()`
    // ahead of the true reference, and naively treating them as equal (this function's own
    // behavior before this fix) misplaces every frame after the gap by exactly its length.
    let (mut sim, mut reference_tick) = match base {
        Base::Genesis(params) => (Sim::genesis(params), 0u32),
        Base::Snapshot(b) => (
            Sim::from_parts(Authority::from_snapshot(b.store, b.rng, b.tick)),
            b.log_ref_tick,
        ),
    };
    // Fix round 1 (docs/plan/24-recovery-and-migration.md): a whole-log scan pass before any frame
    // is applied -- a `Skip`'s own target typically lives in an *earlier* frame than the `Skip`
    // record itself (`Host::sim_replay_scan_*`'s own reasoning, mirrored here).
    let skip_targets = scan_skip_targets::<G>(log);
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
        let frame_tick = reference_tick.wrapping_add(frame.tick_delta);
        let idle_ticks = frame_tick.saturating_sub(1).saturating_sub(sim.tick().0);
        for _ in 0..idle_ticks {
            sim.step(&[], &mut out);
            record_checkpoints(&sim, checkpoints, &mut ci, &mut result);
        }
        let (records, acked) = filter_records(&frame, &skip_targets);
        for (who, seq) in acked {
            sim.authority_mut().record_ack(who, seq);
        }
        sim.step(&records, &mut out);
        record_checkpoints(&sim, checkpoints, &mut ci, &mut result);
        reference_tick = frame_tick;
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
    let mut w = SnapshotWriter::begin(
        sim.authority().store(),
        sim.tick(),
        &rng,
        0,
        0,
        0,
        &identity,
    );
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
    // Fix round 1 (docs/plan/24-recovery-and-migration.md): see `replay`'s own doc comment.
    let skip_targets = scan_skip_targets::<G>(log);
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
        let (records, acked) = filter_records(&frame, &skip_targets);
        // Both runs must record the same ack, or their own hashes diverge for a reason unrelated
        // to what this function exists to detect.
        for (who, seq) in acked {
            sim_a.authority_mut().record_ack(who, seq);
            sim_b.authority_mut().record_ack(who, seq);
        }
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

    /// Fix round 3 (docs/plan/22-persistence-log-and-snapshots.md): the previous claim that this
    /// was "covered transitively" by the other replay tests was false -- none of them ever put a
    /// `RecordKind::Skip` into a log `replay` actually decodes, so `to_record`'s own `FrameRecord::
    /// Skip { .. } => None` arm was untested (a review agent replaced it with `panic!()` and the
    /// whole workspace still passed). Builds two logs with *identical* tick alignment (same number
    /// of frames, same `tick_delta` each) differing only in whether `Skip` records are present:
    /// `with_skip` has one `Skip` sharing a frame with a real action (tick 2) and one `Skip` alone
    /// in its own otherwise-empty frame (tick 3); `without_skip` is the same four frames with every
    /// `Skip` simply omitted (tick 3's frame logs zero records instead of one `Skip`). Both must
    /// replay to the exact same checkpoint hashes as a live run of the three real `Bump`s, proving
    /// `Skip` really does decode as a no-op inside `replay`, not just inside `FrameReader` alone.
    #[test]
    fn replay_skip_records_decode_as_noop() {
        let mut sim = Sim::<TGame>::genesis(params());
        let mut out = Vec::new();
        let mut live_checkpoints = Vec::new();
        for seq in [1u32, 2] {
            sim.step(
                &[Record::Action {
                    who: PlayerId(1),
                    seq,
                    action: TAction::Bump,
                }],
                &mut out,
            );
            live_checkpoints.push((sim.tick(), sim.state_hash()));
        }
        // Tick 3: idle in the live run -- both logs' own tick-3 frame carries no real record
        // either (`with_skip`'s is `Skip`-only, `without_skip`'s is empty), so all three agree here.
        sim.step(&[], &mut out);
        live_checkpoints.push((sim.tick(), sim.state_hash()));
        sim.step(
            &[Record::Action {
                who: PlayerId(1),
                seq: 3,
                action: TAction::Bump,
            }],
            &mut out,
        );
        live_checkpoints.push((sim.tick(), sim.state_hash()));
        let checkpoints: Vec<Tick> = live_checkpoints.iter().map(|(t, _)| *t).collect();

        let mut with_skip = Vec::new();
        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 1, TAction::Bump);
        w.finish(1, &mut V(&mut with_skip));
        let mut w = FrameWriter::<TGame>::new();
        w.push_skip(9, 999);
        w.push_action(PlayerId(1), 2, TAction::Bump);
        w.finish(1, &mut V(&mut with_skip));
        let mut w = FrameWriter::<TGame>::new();
        w.push_skip(3, 42);
        w.finish(1, &mut V(&mut with_skip));
        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 3, TAction::Bump);
        w.finish(1, &mut V(&mut with_skip));

        // The identical log with the `Skip` records removed: same four frames, same `tick_delta`
        // each, tick 3's frame just logs zero records instead of a lone `Skip`.
        let mut without_skip = Vec::new();
        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 1, TAction::Bump);
        w.finish(1, &mut V(&mut without_skip));
        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 2, TAction::Bump);
        w.finish(1, &mut V(&mut without_skip));
        let w = FrameWriter::<TGame>::new();
        w.finish(1, &mut V(&mut without_skip));
        let mut w = FrameWriter::<TGame>::new();
        w.push_action(PlayerId(1), 3, TAction::Bump);
        w.finish(1, &mut V(&mut without_skip));

        let result_with_skip = replay(Base::Genesis(params()), &with_skip, &checkpoints);
        let result_without_skip = replay(Base::Genesis(params()), &without_skip, &checkpoints);
        assert_eq!(
            result_with_skip, live_checkpoints,
            "a log containing Skip records must replay identically to the skip-free live run"
        );
        assert_eq!(
            result_without_skip, live_checkpoints,
            "sanity: the skip-free log must itself match the live run"
        );
        assert_eq!(
            result_with_skip, result_without_skip,
            "Skip records must be true no-ops: identical checkpoints with or without them"
        );
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
        let skip_targets = scan_skip_targets::<TGame>(&log);
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
            let (records, acked) = filter_records(&frame, &skip_targets);
            for (who, seq) in acked {
                sim.authority_mut().record_ack(who, seq);
            }
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
        let mut w = SnapshotWriter::begin(
            sim.authority().store(),
            sim.tick(),
            &rng,
            0,
            0,
            sim.tick().0,
            &identity,
        );
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
        assert_eq!(info.log_ref_tick, 2, "no idle gap before this snapshot");

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
                log_ref_tick: info.log_ref_tick,
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
