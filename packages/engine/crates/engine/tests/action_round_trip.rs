//! M16 (docs/plan/16-action-round-trip.md "Tests added", step 1): the host admit pipeline --
//! `Host::on_uplink`'s decode/dedup/`G::admit`/queue-for-T+1 path, and `Host::tick`'s routing of
//! `Sim::step`'s outcomes back to the sending connection's per-tick `pending_results`, drained by
//! `Host::build_frame` as an `ActionResults` section -- proven end to end through
//! `testing::testkit::Loopback`'s real wire path (`Loopback::action` -> `UplinkWriter` ->
//! `Host::on_uplink`), which this milestone's own Deviations point out replaced the M15
//! `Host::queue_action_for_test` backdoor `Loopback::action` used to call directly.

use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldRead, WorldWrite};
use engine::sim::{Rejected, Sim, WorldParams};
use engine::testing::testkit::Loopback;
use engine::wire::{ActionResultsReader, CameraReport, FrameReader, SectionId, UplinkWriter};
use engine::world::{ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos};
use engine::worldgen::Worldgen;

// -- A small, real game exercising both admission-time and apply-time rejection, plus a
// non-commutative write (`SetTotal`) that makes host *arrival order* directly observable. --------

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
pub enum RAction {
    /// Sets the global counter to `n` (not additive): the value left standing after a tick with
    /// several of these proves *arrival order*, not just "all of them ran".
    SetTotal { n: u32 },
    /// `n > 1000` is rejected by `admit`, before it ever reaches `apply`; otherwise always
    /// accepted, adding `n` to the global counter.
    Bump { n: u32 },
    /// Always accepted by `admit`, always rejected by `apply`, writing nothing (0004
    /// Consequences: "a rejecting `apply` recorded no writes", enforced by `Sim::step`'s own
    /// assert).
    AlwaysRejectApply,
}

#[derive(
    Clone,
    Copy,
    PartialEq,
    Eq,
    Debug,
    PartialOrd,
    Ord,
    serde::Serialize,
    serde::Deserialize,
    ts_rs::TS,
)]
pub enum RReject {
    TooBig,
    Bad,
    Unknown,
}
impl From<Unknown> for RReject {
    fn from(_: Unknown) -> Self {
        RReject::Unknown
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct REntity;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RPlayer;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RGlobal {
    pub total: u32,
}

pub struct RWorldgen;
impl Worldgen for RWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

pub struct RGame;
impl Game for RGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = RWorldgen;
    type Action = RAction;
    type Reject = RReject;
    type Entity = REntity;
    type Player = RPlayer;
    type Global = RGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(_r: &mut Registry) {}
    fn prototype(_e: &REntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &REntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(RGlobal::default());
    }
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, RPlayer);
        }
    }
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &engine::game::PresenceTable<Self>,
        _who: PlayerId,
        a: &RAction,
    ) -> Result<(), RReject> {
        match a {
            RAction::Bump { n } if *n > 1000 => Err(RReject::TooBig),
            _ => Ok(()),
        }
    }
    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &RAction) -> Result<(), RReject> {
        match a {
            RAction::SetTotal { n } => {
                w.put_global(RGlobal { total: *n });
                Ok(())
            }
            RAction::Bump { n } => {
                let total = w.global().total;
                w.put_global(RGlobal { total: total + n });
                Ok(())
            }
            RAction::AlwaysRejectApply => Err(RReject::Bad),
        }
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

fn dims() -> ChunkDims {
    ChunkDims::new(RGame::CHUNK_BITS)
}

struct FlatSource;
impl PristineSource for FlatSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

fn params(seed: u64) -> WorldParams<RGame> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 64,
    }
}

fn loopback(seed: u64) -> Loopback<RGame> {
    Loopback::new(params(seed))
}

fn add_client(lb: &mut Loopback<RGame>, delay: u32) -> (usize, PlayerId) {
    lb.add_client(
        delay,
        dims(),
        Box::new(FlatSource),
        engine::world::CacheCapacity::Chunks(1024),
    )
}

fn small_camera(cx: i32, cy: i32) -> CameraReport {
    CameraReport {
        center_x: cx,
        center_y: cy,
        half_w: 16,
        half_h: 16,
        vel_x: 0,
        vel_y: 0,
    }
}

fn total(lb: &Loopback<RGame>) -> u32 {
    lb.host.sim().unwrap().authority().store().global().total
}

/// A `Result<Applied, Rejected<RGame>>` flattened into something `PartialEq + Debug` for a test
/// assertion (`sim::Rejected<G>` itself derives neither, and adding them crate-wide is outside
/// this milestone's own seam changes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TestOutcome {
    Confirmed,
    RejectedGame(RReject),
    RejectedEngine(engine::sim::EngineReject),
}

/// Scans `bytes` (one built frame) for an `ActionResults` section and decodes it, `[]` if absent.
fn read_results(bytes: &[u8]) -> Vec<(u32, TestOutcome)> {
    let mut r = FrameReader::new(bytes).expect("well-formed host frame");
    let mut out = Vec::new();
    while let Some((id, body)) = r.next_section().expect("well-formed host frame") {
        if id == SectionId::ActionResults {
            let mut br = engine::bytes::ByteReader::new(body);
            ActionResultsReader::read::<RGame>(&mut br, |seq, result| {
                let outcome = match result {
                    Ok(_applied) => TestOutcome::Confirmed,
                    Err(Rejected::Game(reject)) => TestOutcome::RejectedGame(reject),
                    Err(Rejected::Engine(code)) => TestOutcome::RejectedEngine(code),
                };
                out.push((seq, outcome));
            })
            .expect("well-formed ActionResults section");
        }
    }
    out
}

// -- Tests -----------------------------------------------------------------------------------

#[test]
fn action_lands_on_next_tick() {
    let mut lb = loopback(100);
    let (_idx, who) = add_client(&mut lb, 0);
    assert_eq!(total(&lb), 0);
    lb.action(who, RAction::SetTotal { n: 7 });
    // Admitted, but not yet applied: still queued for the next `tick()`.
    assert_eq!(total(&lb), 0);
    lb.step();
    assert_eq!(
        total(&lb),
        7,
        "an admitted action must land on the very next tick"
    );
}

#[test]
fn arrival_order_within_tick() {
    let mut lb = loopback(101);
    let (_idx0, who0) = add_client(&mut lb, 0);
    let (_idx1, who1) = add_client(&mut lb, 0);
    // `SetTotal` is not additive: only host arrival order (the order `on_uplink` was called in,
    // i.e. `Record::Action`'s order in `pending_records`) decides which value survives the tick.
    lb.action(who0, RAction::SetTotal { n: 1 });
    lb.action(who1, RAction::SetTotal { n: 2 });
    lb.step();
    assert_eq!(
        total(&lb),
        2,
        "the later-arriving action must apply last, in host arrival order"
    );
}

#[test]
fn ack_and_deltas_share_a_frame() {
    let mut lb = loopback(102);
    let (idx, who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step(); // join burst settles: this connection now has a baseline Global/OwnPlayer.
    lb.action(who, RAction::Bump { n: 5 });
    lb.step();
    let bytes = lb.last_built_frame(idx);
    let mut r = FrameReader::new(bytes).unwrap();
    let mut saw_results = false;
    let mut saw_global = false;
    while let Some((id, _body)) = r.next_section().unwrap() {
        match id {
            SectionId::ActionResults => saw_results = true,
            SectionId::Global => saw_global = true,
            _ => {}
        }
    }
    assert!(saw_results, "the ack must ride a frame");
    assert!(
        saw_global,
        "the Bump action's own write must appear as a delta in that same frame"
    );
    assert_eq!(read_results(bytes), vec![(1, TestOutcome::Confirmed)]);
}

#[test]
fn admit_reject_is_not_recorded() {
    let mut lb = loopback(103);
    let (idx, who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    lb.action(who, RAction::Bump { n: 5000 }); // admit rejects: n > 1000
    lb.step();
    assert_eq!(total(&lb), 0, "an admission reject must never reach apply");
    assert_eq!(
        lb.host.sim().unwrap().authority().store().last_seq(who),
        Ok(0),
        "an admission reject is never logged: last_seq does not advance"
    );
    let bytes = lb.last_built_frame(idx);
    assert_eq!(
        read_results(bytes),
        vec![(1, TestOutcome::RejectedGame(RReject::TooBig))],
        "the reject must still reach the client, immediately, as an ActionResults entry"
    );
}

#[test]
fn apply_reject_is_recorded_and_replays() {
    let mut lb = loopback(104);
    let (_idx, who) = add_client(&mut lb, 0);
    lb.action(who, RAction::AlwaysRejectApply);
    lb.step();
    assert_eq!(total(&lb), 0, "a rejecting apply must write nothing");
    assert_eq!(
        lb.host.sim().unwrap().authority().store().last_seq(who),
        Ok(1),
        "unlike an admission reject, an apply reject still advances last_seq: it was processed"
    );

    // Replay (0004 Consequences: "the action stays in the log and replay rejects it again,
    // identically"): two independent `Sim`s given the identical record produce identical state.
    let record = engine::sim::Record::Action {
        who,
        seq: 1,
        action: RAction::AlwaysRejectApply,
    };
    let mut sim_a = Sim::<RGame>::genesis(params(999));
    let mut sim_b = Sim::<RGame>::genesis(params(999));
    let mut out_a = Vec::new();
    let mut out_b = Vec::new();
    sim_a.step(std::slice::from_ref(&record), &mut out_a);
    sim_b.step(&[record], &mut out_b);
    assert_eq!(sim_a.state_hash(), sim_b.state_hash());
    assert!(matches!(out_a[0].result, Err(Rejected::Game(RReject::Bad))));
    assert!(matches!(out_b[0].result, Err(Rejected::Game(RReject::Bad))));
}

#[test]
fn resent_seq_is_dropped() {
    let mut lb = loopback(105);
    let (_idx, who) = add_client(&mut lb, 0);
    lb.action(who, RAction::SetTotal { n: 9 }); // seq 1
    lb.step();
    assert_eq!(total(&lb), 9);

    // Resend the identical seq (as a reconnect would): the host must drop it silently, not apply
    // it a second time.
    let conn = who.0 - 1;
    let action = RAction::SetTotal { n: 999 };
    let mut abuf = [0u8; 64];
    let n = engine::codec::encode(&action, &mut abuf).unwrap();
    let mut ubuf = [0u8; 128];
    let mut sink = engine::bytes::SliceSink::new(&mut ubuf);
    UplinkWriter::write(
        &mut sink,
        0,
        core::iter::once((1u32, &abuf[..n])),
        None,
        None,
    );
    let un = sink.finish().unwrap();
    assert!(lb.host.on_uplink(conn, &ubuf[..un]).is_ok());
    lb.step();
    assert_eq!(total(&lb), 9, "a resent seq must be dropped, not reapplied");
}

#[test]
fn host_applies_only_sealed_records() {
    let mut lb = loopback(106);
    let (_idx, who) = add_client(&mut lb, 0);
    lb.action(who, RAction::SetTotal { n: 1 }); // queued for T+1
    lb.step(); // T+1: applied
    assert_eq!(total(&lb), 1);
    lb.action(who, RAction::SetTotal { n: 2 }); // admitted after T+1's own tick()/seal already ran
    assert_eq!(
        total(&lb),
        1,
        "an action admitted after a tick must not retroactively land in it"
    );
    lb.step(); // T+2: now applied
    assert_eq!(
        total(&lb),
        2,
        "it lands on the very next tick after it was admitted, not before"
    );
}

#[test]
fn malformed_action_is_protocol_error() {
    let mut lb = loopback(107);
    let (_idx, who) = add_client(&mut lb, 0);
    let conn = who.0 - 1;
    // A single byte `99`: postcard's own enum-variant varint, naming a variant `RAction` (3
    // variants) does not have -- guaranteed malformed, not merely unlucky bytes.
    let garbage = [99u8];
    let mut ubuf = [0u8; 128];
    let mut sink = engine::bytes::SliceSink::new(&mut ubuf);
    UplinkWriter::write(
        &mut sink,
        0,
        core::iter::once((1u32, garbage.as_slice())),
        None,
        None,
    );
    let n = sink.finish().unwrap();
    let result = lb.host.on_uplink(conn, &ubuf[..n]);
    assert!(
        result.is_err(),
        "a malformed action payload must be reported as a protocol error, not swallowed"
    );
    lb.step();
    assert_eq!(total(&lb), 0, "a malformed action must never be admitted");
}
