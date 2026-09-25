//! Integration coverage of the timer wheel, wake queue and active lists end to end through
//! `Authority`/`TickCx`/`Sim` (docs/plan/21b-timers-wakeups-and-tickcx.md Tests added). A small,
//! self-contained `Game` ("WGame") whose one entity type can act as a timer-driven sleeper, an
//! always-active spinner, a plain entity, or a "stop" sentinel that lets a test control exactly how
//! much of the wake queue a tick rule drains -- the isolated unit tests in `sim::wake`/`sim::timers`/
//! `sim::active` cover the standalone data structures; this file proves the wiring into `Authority`
//! and `TickCx` itself.

use engine::bytes::{ByteReader, ByteSink};
use engine::game::{
    EntityId, Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::sim::{Record, Sim, WorldParams};
use engine::store::Store;
use engine::testing::testkit::run_script;
use engine::time::Tick;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, Footprint, PristineSource, PrototypeId, Registry,
    SystemId, Tile, TilePos, TraitSet,
};
use engine::worldgen::Worldgen;

// -- The test game -------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
enum Mode {
    #[default]
    Plain,
    Timer,
    Active,
    /// Popped from `next_woken` like any other id, but the tick rule stops draining the wake queue
    /// right after processing it -- `undrained_wakes_are_dropped`'s own control knob.
    Stop,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct WEntity {
    mode: Mode,
    delay: u32,
    /// `0` = idle (not currently scheduled).
    done_at: u32,
    /// `u32::MAX` = never fired.
    fired_tick: u32,
    woken_hits: u32,
    spins: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct WPlayer;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct WGlobal {
    /// The order `next_due` fired ids in, filled by the tick rule (`timer_fires_at_exact_tick_in_
    /// key_order`'s own witness: plain data, no `Vec`, 0011).
    fire_log: [u32; 8],
    fire_n: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum WAction {
    /// `mode_tag`: 0 Plain, 1 Timer, 2 Active, 3 Stop.
    Spawn {
        mode_tag: u8,
        delay: u32,
    },
    Despawn {
        id: u32,
    },
    /// Re-arms a `Timer` entity with a new delay, forcing it idle first so the tick rule's own
    /// "woken + idle" gate schedules again (`wake_at`'s replace semantics, at the engine level, are
    /// `sim::timers`'s own `wake_at_replaces` unit test).
    Retimer {
        id: u32,
        delay: u32,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum WReject {
    Unknown,
    NotFound,
}
impl From<Unknown> for WReject {
    fn from(_: Unknown) -> Self {
        WReject::Unknown
    }
}

struct WGen;
impl Worldgen for WGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

static ACTIVE_SYS: std::sync::OnceLock<SystemId> = std::sync::OnceLock::new();
fn active_sys() -> SystemId {
    *ACTIVE_SYS.get().expect("WGame::register must run first")
}

struct WGame;
impl Game for WGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = WGen;
    type Action = WAction;
    type Reject = WReject;
    type Entity = WEntity;
    type Player = WPlayer;
    type Global = WGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        let _ = ACTIVE_SYS.set(r.system("active"));
    }
    fn prototype(_e: &WEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &WEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(WGlobal {
            fire_log: [0; 8],
            fire_n: 0,
        });
    }
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, WPlayer);
        }
    }
    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &WAction) -> Result<(), WReject> {
        match a {
            WAction::Spawn { mode_tag, delay } => {
                let mode = match mode_tag {
                    1 => Mode::Timer,
                    2 => Mode::Active,
                    3 => Mode::Stop,
                    _ => Mode::Plain,
                };
                w.spawn(WEntity {
                    mode,
                    delay: *delay,
                    done_at: 0,
                    fired_tick: u32::MAX,
                    woken_hits: 0,
                    spins: 0,
                });
                Ok(())
            }
            WAction::Despawn { id } => {
                w.despawn(EntityId(*id));
                Ok(())
            }
            WAction::Retimer { id, delay } => {
                let id = EntityId(*id);
                let mut e = w.entity(id)?.copied().ok_or(WReject::NotFound)?;
                e.delay = *delay;
                e.done_at = 0;
                w.put_entity(id, e);
                Ok(())
            }
        }
    }
    fn tick(cx: &mut TickCx<'_, Self>) {
        while let Some(id) = cx.next_woken() {
            let Some(mut e) = cx.entity(id).ok().flatten().copied() else {
                continue; // despawned before this tick got to it.
            };
            e.woken_hits += 1;
            match e.mode {
                Mode::Stop => {
                    cx.put_entity(id, e);
                    break; // whatever else is still in `now` is left undrained this tick.
                }
                Mode::Timer => {
                    if e.delay > 0 && e.done_at == 0 {
                        e.done_at = cx.tick().0 + e.delay;
                        let at = Tick(e.done_at);
                        cx.put_entity(id, e);
                        cx.wake_at(id, at);
                    } else {
                        cx.put_entity(id, e);
                    }
                }
                Mode::Active => {
                    cx.activate(active_sys(), id);
                    cx.put_entity(id, e);
                }
                Mode::Plain => {
                    cx.put_entity(id, e);
                }
            }
        }

        while let Some(id) = cx.next_due() {
            let Some(mut e) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            e.fired_tick = cx.tick().0;
            e.done_at = 0;
            cx.put_entity(id, e);
            let mut g = *cx.global();
            if (g.fire_n as usize) < g.fire_log.len() {
                g.fire_log[g.fire_n as usize] = id.0;
                g.fire_n += 1;
            }
            cx.put_global(g);
        }

        let sys = active_sys();
        for i in 0..cx.active_len(sys) {
            let Some(id) = cx.active_at(sys, i) else {
                continue; // a tombstoned slot, not yet compacted.
            };
            let Some(mut e) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            e.spins += 1;
            if e.spins == 2 {
                cx.deactivate(sys, id);
            }
            cx.put_entity(id, e);
        }
    }

    /// HOST ONLY, never replayed: unused (no fixture rule needs it).
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &WAction,
    ) -> Result<(), WReject> {
        Ok(())
    }
}

struct ZeroSource;
impl PristineSource for ZeroSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

fn terrain() -> engine::world::TerrainStore {
    engine::world::TerrainStore::new(
        ChunkDims::new(WGame::CHUNK_BITS),
        Box::new(ZeroSource),
        CacheCapacity::Chunks(8),
    )
}

fn genesis(seed: u64) -> Sim<WGame> {
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities: 1_000_000,
        max_modified_tiles: 1_000_000,
        max_action_growth: 1_000_000,
    })
}

fn join(who: PlayerId) -> Record<WGame> {
    Record::Player {
        who,
        ev: PlayerEvent::Joined,
    }
}

fn spawn(who: PlayerId, seq: u32, mode_tag: u8, delay: u32) -> Record<WGame> {
    Record::Action {
        who,
        seq,
        action: WAction::Spawn { mode_tag, delay },
    }
}

struct VecSink<'a>(&'a mut Vec<u8>);
impl ByteSink for VecSink<'_> {
    fn put(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }
}

// -- Tests ------------------------------------------------------------------------------------

#[test]
fn put_from_apply_wakes_same_tick() {
    let mut sim = genesis(1);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    // Tick 1: joins and spawns a plain entity through `apply` -- an `Authority`-side put outside
    // `G::tick`, so it must be woken in this very tick's `G::tick` call.
    sim.step(&[join(p1), spawn(p1, 1, 0, 0)], &mut out);
    let e = sim
        .authority()
        .store()
        .entity(EntityId(1))
        .copied()
        .unwrap();
    assert_eq!(e.woken_hits, 1, "the spawn's own tick must see it woken");
}

#[test]
fn put_from_tick_does_not_self_wake() {
    let mut sim = genesis(2);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    sim.step(&[join(p1), spawn(p1, 1, 0, 0)], &mut out); // tick 1: woken once, put_entity by the tick rule
    assert_eq!(
        sim.authority()
            .store()
            .entity(EntityId(1))
            .unwrap()
            .woken_hits,
        1
    );
    sim.step(&[], &mut out); // tick 2: the tick rule's own `put_entity` from tick 1 must not have re-woken it
    assert_eq!(
        sim.authority()
            .store()
            .entity(EntityId(1))
            .unwrap()
            .woken_hits,
        1,
        "a put made through TickCx must not auto-wake (Planning decisions)"
    );
}

#[test]
fn undrained_wakes_are_dropped() {
    let mut sim = genesis(3);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    // A (plain), STOP (mode 3), C (plain) spawned in the same tick, in that order: the tick rule
    // processes A, then STOP (and breaks), leaving C's wake-up in `now` -- undrained, and dropped
    // at the end of this tick (0007 §7).
    sim.step(
        &[
            join(p1),
            spawn(p1, 1, 0, 0), // A -> EntityId(1)
            spawn(p1, 2, 3, 0), // STOP -> EntityId(2)
            spawn(p1, 3, 0, 0), // C -> EntityId(3)
        ],
        &mut out,
    );
    let store = sim.authority().store();
    assert_eq!(
        store.entity(EntityId(1)).unwrap().woken_hits,
        1,
        "A was processed"
    );
    assert_eq!(
        store.entity(EntityId(2)).unwrap().woken_hits,
        1,
        "STOP was popped"
    );
    assert_eq!(
        store.entity(EntityId(3)).unwrap().woken_hits,
        0,
        "C was left in `now`, undrained"
    );

    sim.step(&[], &mut out); // a following tick must not carry C's dropped wake-up forward.
    assert_eq!(
        sim.authority()
            .store()
            .entity(EntityId(3))
            .unwrap()
            .woken_hits,
        0,
        "a dropped wake-up is not carried to a later tick"
    );
}

#[test]
fn timer_fires_at_exact_tick_in_key_order() {
    let mut sim = genesis(4);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    // Two timers scheduled for the same tick, spawned in this order: EntityId(1) then
    // EntityId(2), both delay 3 -- `next_due` must pop the lower id first (key order).
    sim.step(
        &[join(p1), spawn(p1, 1, 1, 3), spawn(p1, 2, 1, 3)],
        &mut out,
    );
    for _ in 0..10 {
        sim.step(&[], &mut out);
    }
    let g = *sim.authority().store().global();
    assert_eq!(g.fire_n, 2);
    assert_eq!(g.fire_log[0], 1, "lower id fires first at a tied tick");
    assert_eq!(g.fire_log[1], 2);
    let e1 = sim.authority().store().entity(EntityId(1)).unwrap();
    let e2 = sim.authority().store().entity(EntityId(2)).unwrap();
    assert_eq!(
        e1.fired_tick, e2.fired_tick,
        "both were due on the same tick"
    );
    assert_ne!(e1.fired_tick, u32::MAX);
}

#[test]
fn wake_at_replaces() {
    let mut sim = genesis(5);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    sim.step(&[join(p1), spawn(p1, 1, 1, 100)], &mut out); // scheduled far in the future
    assert_eq!(sim.authority().store().timers_pending(), 1);

    // Re-arm with a much shorter delay: at most one timer must ever exist for this entity.
    sim.step(
        &[Record::Action {
            who: p1,
            seq: 2,
            action: WAction::Retimer { id: 1, delay: 2 },
        }],
        &mut out,
    );
    assert_eq!(
        sim.authority().store().timers_pending(),
        1,
        "wake_at replaces, never adds a second entry"
    );

    for _ in 0..4 {
        sim.step(&[], &mut out);
    }
    assert_ne!(
        sim.authority()
            .store()
            .entity(EntityId(1))
            .unwrap()
            .fired_tick,
        u32::MAX,
        "the entity must fire on the *new*, shorter schedule, not the original one"
    );
}

#[test]
fn despawn_cancels_timer_and_lists() {
    let mut sim = genesis(6);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    sim.step(
        &[join(p1), spawn(p1, 1, 1, 50), spawn(p1, 2, 2, 0)],
        &mut out,
    ); // id 1: timer; id 2: active
    assert_eq!(sim.authority().store().timers_pending(), 1);
    assert_eq!(sim.authority().store().active_len(active_sys()), 1);

    sim.step(
        &[
            Record::Action {
                who: p1,
                seq: 3,
                action: WAction::Despawn { id: 1 },
            },
            Record::Action {
                who: p1,
                seq: 4,
                action: WAction::Despawn { id: 2 },
            },
        ],
        &mut out,
    );
    assert_eq!(
        sim.authority().store().timers_pending(),
        0,
        "despawn removes the timer"
    );
    sim.step(&[], &mut out); // let the active list's own tombstone compact
    assert_eq!(
        sim.authority().store().active_len(active_sys()),
        0,
        "despawn deactivates everywhere"
    );
}

#[test]
fn active_iteration_stable_under_deactivate() {
    let mut sim = genesis(7);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    sim.step(
        &[
            join(p1),
            spawn(p1, 1, 2, 0), // id 1
            spawn(p1, 2, 2, 0), // id 2
            spawn(p1, 3, 2, 0), // id 3
        ],
        &mut out,
    );
    // The same tick that activates an entity also runs the active-list scan (`Machines::tick`'s
    // own doc comment shape): all three are already visited once, `spins == 1`.
    let sys = active_sys();
    assert_eq!(sim.authority().store().active_len(sys), 3);

    // This tick's scan brings every `spins` to 2, which the tick rule reads as "deactivate me" --
    // for every one of them, in the same scan. The removal is a tombstone, not yet compacted: the
    // list's own length is unchanged immediately after this `step` call returns.
    sim.step(&[], &mut out);
    assert_eq!(
        sim.authority().store().active_len(sys),
        3,
        "removed entries are tombstoned, not yet compacted, until the next fixed point"
    );

    // The *next* tick's own fixed point (`Authority::begin_tick`) compacts them before that tick's
    // `G::tick` even runs.
    sim.step(&[], &mut out);
    assert_eq!(sim.authority().store().active_len(sys), 0);
}

#[test]
fn timers_survive_encode_decode() {
    let mut sim = genesis(8);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    // Mid-cycle: one timer pending, one active spinner mid-count, one plain entity -- not a
    // freshly-genesis'd, all-empty store.
    sim.step(
        &[
            join(p1),
            spawn(p1, 1, 1, 20), // timer, not yet due
            spawn(p1, 2, 2, 0),  // active
            spawn(p1, 3, 0, 0),  // plain
        ],
        &mut out,
    );
    sim.step(&[], &mut out);
    assert_eq!(sim.authority().store().timers_pending(), 1, "not due yet");
    assert_eq!(sim.authority().store().active_len(active_sys()), 1);

    let mut bytes = Vec::new();
    sim.authority().store().encode(&mut VecSink(&mut bytes));

    let mut decoded = Store::<WGame>::new(terrain(), WGlobal::default());
    decoded
        .decode(&mut ByteReader::new(&bytes))
        .expect("round trip");
    assert_eq!(sim.authority().store().state_hash(), decoded.state_hash());
    assert_eq!(decoded.timers_pending(), 1);
    assert_eq!(decoded.active_len(active_sys()), 1);
}

#[test]
fn replay_equals_live_with_timers() {
    let p1 = PlayerId(1);
    let script: Vec<(Tick, Record<WGame>)> = vec![
        (Tick(1), join(p1)),
        (Tick(1), spawn(p1, 1, 1, 5)),
        (Tick(1), spawn(p1, 2, 2, 0)),
        (
            Tick(20),
            Record::Action {
                who: p1,
                seq: 3,
                action: WAction::Retimer { id: 1, delay: 3 },
            },
        ),
    ];

    let mut live = genesis(9);
    let live_hash = run_script(&mut live, &script);

    let mut replay = genesis(9);
    let replay_hash = run_script(&mut replay, &script);

    assert_eq!(live_hash, replay_hash);
}
