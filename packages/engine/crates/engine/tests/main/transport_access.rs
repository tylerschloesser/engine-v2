//! M42 (docs/decisions/0076-transport-lines-engine-game-split.md §6): the host-tick-only access
//! rule for `WorldWrite::transport_mut`, pinned with a local test game (the `no_alloc_tick_state.rs`
//! pattern, not `fx-belts`): `Ok` from `genesis` and `TickCx` (also through `TickCx::as_write`),
//! `Unknown` inside `apply` on the host (a debug assertion naming the rule) and under prediction
//! (`NotPredictable`). Also: `advance` runs inside `Sim::step` after `G::tick`, and the state hash
//! covers the transport store.

use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::predict::Prediction;
use engine::sim::{Record, Sim, WorldParams};
use engine::testing::testkit::{self, Loopback};
use engine::transport::{
    Item, LineId, Output, Transport, TransportError, TransportRead, TransportWrite,
};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
};
use engine::worldgen::Worldgen;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct AEntity;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct APlayer;
/// What the last `tick` saw, so a test can read it back through `Global`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct AGlobal {
    /// The genesis line's front position as `tick` read it (before that tick's `advance`).
    seen_front: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum AAction {
    /// `apply` asks for `transport_mut()`.
    TouchTransport,
    /// `apply` reads `transport().lines_at(0, 0)` (M43 review, finding 1).
    ReadTile,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum AReject {
    Unknown,
}
impl From<Unknown> for AReject {
    fn from(_: Unknown) -> Self {
        AReject::Unknown
    }
}

struct AGen;
impl Worldgen for AGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

struct VoidSource;
impl PristineSource for VoidSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

/// The genesis line: 1,024 positions at 24 per tick, dead-ended.
const GENESIS_LINE: LineId = LineId(1);
const LEN: u32 = 1024;
const SPEED: u16 = 24;

struct AGame;
impl Game for AGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = AGen;
    type Action = AAction;
    type Reject = AReject;
    type Entity = AEntity;
    type Player = APlayer;
    type Global = AGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(_r: &mut Registry) {}
    fn prototype(_e: &AEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &AEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    /// `genesis` may write transport (0076 §6).
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        let t = w.transport_mut().expect("genesis: transport_mut is Ok");
        match t.create(LEN, SPEED) {
            Ok(l) => assert_eq!(l, GENESIS_LINE),
            Err(e) => assert_eq!(e, TransportError::Full, "only caps (0, 0) refuse"),
        }
    }
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, APlayer);
        }
    }
    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &AAction) -> Result<(), AReject> {
        match a {
            AAction::TouchTransport => {
                w.transport_mut()?;
                Ok(())
            }
            AAction::ReadTile => {
                w.transport().lines_at(TilePos::new(0, 0), &mut |_, _| {})?;
                Ok(())
            }
        }
    }
    /// Every tick: one item at the back of the genesis line (`TickCx` directly), and on tick 3 a
    /// second line through `as_write` (the helper path shared with `apply`).
    fn tick(cx: &mut TickCx<'_, Self>) {
        let front = cx
            .transport()
            .front(GENESIS_LINE)
            .expect("the host's read side is total")
            .map_or(0, |(_, p)| p);
        cx.put_global(AGlobal { seen_front: front });
        let t = cx.transport_mut().expect("tick: transport_mut is Ok");
        let _ = t.insert_back(GENESIS_LINE, Item(1));
        if cx.tick().0 == 3 {
            let w = cx.as_write();
            let t = w
                .transport_mut()
                .expect("tick via as_write: transport_mut is Ok");
            let l = t.create(512, 8).unwrap();
            t.set_out(l, Output::Next(GENESIS_LINE)).unwrap();
        }
    }
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &AAction,
    ) -> Result<(), AReject> {
        Ok(())
    }
}

fn params() -> WorldParams<AGame> {
    WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 1024,
        max_modified_tiles: 1024,
        max_action_growth: 4096,
        max_lines: 16,
        max_items: 256,
    }
}

fn front(sim: &Sim<AGame>) -> Option<(Item, u32)> {
    sim.authority()
        .store()
        .transport()
        .front(GENESIS_LINE)
        .unwrap()
}

/// `genesis` and `TickCx` (directly and through `as_write`) get `Ok`; `advance` runs once per
/// `Sim::step`, after `G::tick`: the item `tick` inserted lands at `len - speed` and has moved
/// `speed` by the time `step` returns, and the next `tick` reads that moved position.
#[test]
fn transport_tick_and_genesis_are_ok() {
    let mut sim = Sim::<AGame>::genesis(params());
    let store = sim.authority().store();
    assert_eq!(store.transport().lines_len(), 1, "genesis created a line");
    assert_eq!(
        store.transport().max_lines(),
        16,
        "WorldParams caps applied"
    );
    assert_eq!(store.transport().max_items(), 256);
    let mut out = Vec::new();
    sim.step(&[], &mut out);
    let land = LEN - u32::from(SPEED);
    assert_eq!(
        front(&sim),
        Some((Item(1), land - u32::from(SPEED))),
        "inserted at len - speed during tick 0, then advanced once"
    );
    sim.step(&[], &mut out);
    assert_eq!(
        sim.authority().store().global().seen_front,
        land - u32::from(SPEED),
        "tick 1 saw the position after tick 0's advance"
    );
    for _ in 0..3 {
        sim.step(&[], &mut out);
    }
    assert_eq!(
        sim.authority().store().transport().lines_len(),
        2,
        "tick 3 created a line through as_write"
    );
}

/// 0076 §6: inside `apply` on the host `transport_mut()` is `Err(Unknown)`, and debug/test builds
/// panic with the rule's name (an action that touches transport lines is a host bug).
#[test]
fn transport_in_apply_is_unknown() {
    let mut sim = Sim::<AGame>::genesis(params());
    let mut out = Vec::new();
    let p = PlayerId(1);
    sim.step(
        &[Record::Player {
            who: p,
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    let action = [Record::Action {
        who: p,
        seq: 1,
        action: AAction::TouchTransport,
    }];
    if cfg!(debug_assertions) {
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sim.step(&action, &mut out);
        }));
        std::panic::set_hook(hook);
        let err = r.expect_err("apply touching transport must trip the debug assertion");
        let msg = err
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| err.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(
            msg.contains("0076 §6"),
            "the assertion names the rule: {msg}"
        );
    } else {
        sim.step(&action, &mut out);
        assert!(
            matches!(
                out[0].result,
                Err(engine::sim::Rejected::Game(AReject::Unknown))
            ),
            "release: apply sees Err(Unknown)"
        );
    }
}

/// 0076 §6: under prediction `transport_mut()` is `Err(Unknown)` and marks the overlay, so the
/// action is `NotPredictable` (not a predicted rejection, not applied).
#[test]
fn transport_predicting_is_unknown() {
    let mut lb = Loopback::<AGame>::new(params());
    lb.add_client(
        0,
        ChunkDims::new(AGame::CHUNK_BITS),
        Box::new(VoidSource),
        CacheCapacity::Chunks(1024),
    );
    lb.run(5);
    let (_seq, status) = lb.dispatch(0, AAction::TouchTransport);
    assert_eq!(status, Prediction::NotPredictable);
}

/// M43 review (finding 1, the prediction rule): `lines_at` takes no line id, so a store that holds
/// no transport state (an unreserved one) must answer `Err(Unknown)`, not "no line here"; under
/// prediction every transport read is `Unknown` (M46: the replica holds structures now, and
/// `Predicting` still answers none of them), so the read marks the overlay and the action is
/// `NotPredictable`. The host's reserved store answers `Ok` and the same action applies.
#[test]
fn transport_lines_at_is_unknown_on_a_replica() {
    let mut lb = Loopback::<AGame>::new(params());
    lb.add_client(
        0,
        ChunkDims::new(AGame::CHUNK_BITS),
        Box::new(VoidSource),
        CacheCapacity::Chunks(1024),
    );
    lb.run(5);
    let (_seq, status) = lb.dispatch(0, AAction::ReadTile);
    assert_eq!(status, Prediction::NotPredictable);

    let mut sim = Sim::<AGame>::genesis(params());
    assert_eq!(
        testkit::transport_mut(&mut sim).lines_at(TilePos::new(0, 0), &mut |_, _| {}),
        Ok(())
    );
    let mut out = Vec::new();
    let p = PlayerId(1);
    sim.step(
        &[Record::Player {
            who: p,
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    out.clear();
    sim.step(
        &[Record::Action {
            who: p,
            seq: 1,
            action: AAction::ReadTile,
        }],
        &mut out,
    );
    assert!(out[0].result.is_ok(), "the host applies it");
    assert_eq!(
        Transport::empty().lines_at(TilePos::new(0, 0), &mut |_, _| {}),
        Err(Unknown),
        "an unreserved store holds no transport state"
    );
}

/// Two stores differing only in one transport item hash differently; a store that never created
/// a line hashes as before M42 (the pristine section is left out of the hash).
#[test]
fn store_hash_includes_transport() {
    let a = Sim::<AGame>::genesis(params());
    let b = Sim::<AGame>::genesis(params());
    assert_eq!(a.state_hash(), b.state_hash());
    let (mut a, mut b) = (a, b);
    let ta = testkit::transport_mut(&mut a);
    ta.insert_at(GENESIS_LINE, 100, Item(1)).unwrap();
    let tb = testkit::transport_mut(&mut b);
    tb.insert_at(GENESIS_LINE, 100, Item(2)).unwrap();
    assert_ne!(
        a.state_hash(),
        b.state_hash(),
        "one item kind differs: the hashes must too"
    );
    let tb = testkit::transport_mut(&mut b);
    tb.remove_at(GENESIS_LINE, 100).unwrap();
    tb.insert_at(GENESIS_LINE, 100, Item(1)).unwrap();
    assert_eq!(a.state_hash(), b.state_hash(), "same content, same hash");
}

/// A game whose only state change is transport: genesis builds one line (sinking when `SINK`,
/// else dead-ended), and `tick` inserts at its back when `INSERT`. No puts, no records.
struct BeltOnly<const INSERT: bool, const SINK: bool = true>;
impl<const INSERT: bool, const SINK: bool> Game for BeltOnly<INSERT, SINK> {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = AGen;
    type Action = AAction;
    type Reject = AReject;
    type Entity = AEntity;
    type Player = APlayer;
    type Global = AGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(_r: &mut Registry) {}
    fn prototype(_e: &AEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &AEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        let t = w.transport_mut().unwrap();
        let l = t.create(LEN, SPEED).unwrap();
        if SINK {
            t.set_out(l, Output::Sink).unwrap();
        }
    }
    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &AAction) -> Result<(), AReject> {
        Ok(())
    }
    fn tick(cx: &mut TickCx<'_, Self>) {
        if INSERT {
            let t = cx.transport_mut().unwrap();
            let _ = t.insert_back(GENESIS_LINE, Item(1));
        }
    }
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &AAction,
    ) -> Result<(), AReject> {
        Ok(())
    }
}

fn belt_params<G: Game<Worldgen = AGen>>() -> WorldParams<G> {
    WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 1024,
        max_modified_tiles: 1024,
        max_action_growth: 4096,
        max_lines: 16,
        max_items: 256,
    }
}

/// M42 review (finding 2): a world where only belts move is dirty, so the host snapshots it; a
/// world with lines but nothing on them stays clean.
#[test]
fn transport_motion_marks_the_world_dirty() {
    let mut out = Vec::new();
    let mut sim = Sim::<BeltOnly<true>>::genesis(belt_params());
    sim.authority_mut().clear_dirty();
    for _ in 0..10 {
        sim.step(&[], &mut out);
    }
    assert!(
        sim.authority().dirty(),
        "items moved, yet the world is clean"
    );

    let mut out = Vec::new();
    let mut idle = Sim::<BeltOnly<false>>::genesis(belt_params());
    idle.step(&[], &mut out); // the genesis writes' own change flag
    idle.authority_mut().clear_dirty();
    for _ in 0..10 {
        idle.step(&[], &mut out);
    }
    assert!(
        !idle.authority().dirty(),
        "nothing moved, yet the world is dirty"
    );
}

/// 0079 §5 (M42 review, finding 3): the arena is reserved once, at the world's caps. Caps `(0, 0)`
/// reserve nothing and `create` is `Full`; the defaults reserve once, a second `set_caps` with the
/// same values is a no-op and other values are `CapsFixed`.
#[test]
fn transport_caps_reserve_once() {
    let mut zero = belt_params::<AGame>();
    zero.max_lines = 0;
    zero.max_items = 0;
    let mut sim = Sim::<AGame>::genesis(zero);
    let t = testkit::transport_mut(&mut sim);
    assert_eq!(t.arena_bytes(), 0, "caps (0, 0) reserve nothing");
    assert_eq!(t.lines_len(), 0, "genesis's create was refused");
    assert_eq!(t.create(LEN, SPEED), Err(TransportError::Full));

    let mut defaults = belt_params::<AGame>();
    defaults.max_lines = engine::transport::DEFAULT_MAX_LINES;
    defaults.max_items = engine::transport::DEFAULT_MAX_ITEMS;
    let mut sim = Sim::<AGame>::genesis(defaults);
    let t = testkit::transport_mut(&mut sim);
    let reserved = Transport::reserved_bytes(
        engine::transport::DEFAULT_MAX_LINES,
        engine::transport::DEFAULT_MAX_ITEMS,
    );
    assert_eq!(
        t.arena_bytes(),
        reserved,
        "reserved once, at the world's caps"
    );
    assert_eq!(
        t.set_caps(
            engine::transport::DEFAULT_MAX_LINES,
            engine::transport::DEFAULT_MAX_ITEMS
        ),
        Ok(())
    );
    assert_eq!(
        t.arena_bytes(),
        reserved,
        "the same caps again reserve nothing more"
    );
    assert_eq!(t.set_caps(16, 256), Err(TransportError::CapsFixed));
}

/// M42 review (finding 4): heavy mode's restores run with the world's own caps. A dead-ended line
/// filled every tick reaches `max_items = 8` (the line holds 16) and is then refused `Full`; a restore that fell back
/// to the default caps would keep accepting items and diverge from the uninterrupted run.
#[test]
fn transport_heavy_restore_keeps_the_world_caps() {
    struct V<'a>(&'a mut Vec<u8>);
    impl engine::bytes::ByteSink for V<'_> {
        fn put(&mut self, b: &[u8]) {
            self.0.extend_from_slice(b);
        }
    }
    let mut params = belt_params::<BeltOnly<true, false>>();
    params.max_items = 8;
    let mut log = Vec::new();
    engine::persist::FrameWriter::<BeltOnly<true, false>>::new().finish(60, &mut V(&mut log));
    assert_eq!(
        engine::testing::replay::heavy(params, &log, 5),
        Ok(()),
        "restores every 5 ticks over 60 ticks, the cap reached on the way"
    );
    // The world really reaches the cap.
    let mut p = belt_params::<BeltOnly<true, false>>();
    p.max_items = 8;
    let mut sim = Sim::<BeltOnly<true, false>>::genesis(p);
    for _ in 0..60 {
        sim.step(&[], &mut Vec::new());
    }
    assert_eq!(
        sim.authority().store().transport().items_len(),
        8,
        "the cap binds (the line itself holds 16)"
    );
}
