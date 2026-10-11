//! Fixture game `fx-belts` (M40 onward, `PLAN.md`): the home of every engine belt test. Belts are
//! the engine's `engine::transport` module (docs/decisions/0076) exercised without the reference
//! game's rules (0076 §9: "engine tests never use the reference game").
//!
//! **The request pattern (M42b).** 0076 §6 forbids `apply` from touching lines, so every topology
//! change is a request: `Action::Request(op)` validates the op's shape and spawns one
//! [`Thing::Request`] entity, and nothing else. That apply-time spawn auto-wakes into the same
//! tick's `next_woken` (0046; `fx-machines`'s `Feed` pattern), where [`Belts::tick`] executes the
//! op through `transport_mut()` and despawns the request. Requests of one tick execute in spawn
//! order (`next_woken` is insertion order), so a scenario's ops run in the order it lists them.
//!
//! **Line ids.** `create` hands out the ids; scenarios name lines by the order of their `Chain`
//! requests instead. [`Global::lines`] is that table (index `i` is the `i`-th `Chain` ever
//! executed; `0` is none): `Chain` appends its new id (or `0` when `create` refused, so later
//! indices stay aligned), and every other op indexes it. Once the table is full (32 chains) a
//! `Chain` request creates nothing.
//!
//! **Spawners.** `Op::Spawner` turns its request entity, in place, into a [`Thing::Spawner`] on
//! the `"spawner"` active list. Every tick each spawner adds 256 to its accumulator; when the
//! accumulator reaches `period` (ticks per item in 1/256 tick, at least 256) it makes exactly one
//! `insert_back` attempt: accepted, `acc -= period` and `spawned += 1`; refused (`NoRoom`, `Full`),
//! `acc -= 256`, so the credit is held and the next tick is due again, never a burst. `period = 256`
//! tries every tick (a saturating feed).
//!
//! Goldens (`golden/scenario-*.json`, `tests/golden_scenarios.rs`): `straight-chain` (also the
//! canonical `scenario.json`), `deadend-backup`, `spawn-to-sink`, `big-step`; the item-
//! representation and forecast spikes are `tests/spike_*.rs` (native only). `CLAUDE.md` has the
//! detail.

use engine::game::{
    EntityId, Game, Growth, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead,
    WorldWrite,
};
use engine::transport::{Item, LineId, Output};
use engine::world::{
    ChunkCoord, Footprint, PrototypeId, Registry, SystemId, Tile, TilePos, TraitSet,
};
use engine::worldgen::Worldgen;
use ts_rs::TS;

/// Capacity of [`Global::lines`]: chains a world can name.
pub const MAX_CHAINS: u32 = 32;
/// Items `Op::Chain` can place at rest.
pub const REST_SLOTS: u32 = 8;
/// Positions per tile (0076 §1: 1/256 tile).
pub const TILE: u32 = 256;

/// The spawner active list (`Belts::register`); the `fx-machines` `SPINNER_SYS` pattern:
/// `Registry::system` hands out the same id for every `Registry`, so one process-wide value holds.
static SPAWNER_SYS: std::sync::OnceLock<SystemId> = std::sync::OnceLock::new();

fn spawner_sys() -> SystemId {
    *SPAWNER_SYS
        .get()
        .expect("Belts::register must run before Belts::tick")
}

/// A tile position, plain data (`Action` must stay `Codec + TS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

impl Pos {
    fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

/// A chain's direction. Recorded, not used: the fixture computes no geometry (M43 registers it).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Dir {
    #[default]
    East,
    South,
    West,
    North,
}

/// One topology request (M42b), executed by `Belts::tick`. Lines are named by index into
/// [`Global::lines`] (module doc).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Op {
    /// One line (one lane) of `tiles x 256` positions at `speed`, `DeadEnd` output, appended to
    /// the table; then each `(item, pos)` of `items_at_rest` with `item != 0` lands by `insert_at`
    /// (a refused one is skipped). A belt is two chains.
    Chain {
        from: Pos,
        dir: Dir,
        tiles: u16,
        speed: u16,
        #[serde(default)]
        items_at_rest: [(u16, u32); 8], // REST_SLOTS
    },
    /// `set_out(from_line, Next(to_line))`: a plain hand-off.
    Link { from_line: u8, to_line: u8 },
    /// A spawner of `item` on `line`, one item per `period / 256` ticks at most (module doc).
    Spawner { line: u8, item: u16, period: u32 },
    /// `set_out(line, Sink)`.
    Sink { line: u8 },
    /// `set_out(line, DeadEnd)`.
    DeadEnd { line: u8 },
}

impl Op {
    /// The shape check `apply` makes (validate first, write after); the engine checks the rest
    /// when the op executes.
    fn valid(&self) -> bool {
        let idx = |i: u8| u32::from(i) < MAX_CHAINS;
        match *self {
            Op::Chain {
                from, tiles, speed, ..
            } => from.tile().in_range() && tiles >= 1 && speed >= 1,
            Op::Link { from_line, to_line } => idx(from_line) && idx(to_line),
            Op::Spawner { line, item, period } => idx(line) && item != 0 && period >= 256,
            Op::Sink { line } | Op::DeadEnd { line } => idx(line),
        }
    }

    /// The request entity's anchor: a chain's own start tile, else the origin.
    fn anchor(&self) -> Pos {
        match *self {
            Op::Chain { from, .. } => from,
            _ => Pos::default(),
        }
    }
}

/// `Noop` stays first so pre-existing encoded values keep their variant index.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Noop,
    /// Spawns a [`Thing::Request`] for `Belts::tick` to execute (module doc).
    Request(Op),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`): only reachable on a predicting client.
    Unknown,
    /// `Request`: the op's shape is invalid (`Op::valid`).
    BadOp,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// A pending request: plain data, lives from `apply` to the same tick's `Belts::tick`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Request {
    pub at: Pos,
    pub op: Op,
}

/// A spawner on the `"spawner"` active list (module doc for the rule).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Spawner {
    pub at: Pos,
    pub line: u32,
    pub item: u16,
    pub period: u32,
    pub acc: u32,
    /// Items this spawner has put on its line (accepted `insert_back`s).
    pub spawned: u32,
}

/// The one entity type (0022 §3: a single `G::Entity`), one variant per kind.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub enum Thing {
    Request(Request),
    Spawner(Spawner),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player;

/// The chain table (module doc): `lines[i]` is the `i`-th chain's `LineId`, `0` none.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub chains: u32,
    pub lines: [u32; 32], // `MAX_CHAINS`, a literal for the serialized-types scan
}

impl Global {
    /// The `LineId` of chain `i`, `NONE` when absent.
    pub fn line(&self, i: u32) -> LineId {
        LineId(if i < self.chains.min(MAX_CHAINS) {
            self.lines[i as usize]
        } else {
            0
        })
    }
}

pub struct Belts;

impl Belts {
    /// Executes one request's op (host tick only). Refusals are dropped: a request that cannot
    /// apply changes nothing but the table (`Chain` appends `0`).
    fn execute(cx: &mut TickCx<'_, Self>, id: EntityId, req: Request) {
        let mut g = *cx.global();
        let Ok(t) = cx.transport_mut() else {
            return; // unreachable from `tick` (TickCx answers `Ok`).
        };
        match req.op {
            Op::Chain {
                tiles,
                speed,
                items_at_rest,
                ..
            } => {
                if g.chains >= MAX_CHAINS {
                    // A full table: no op could name the line, so none is created.
                    cx.despawn(id);
                    return;
                }
                let line = t
                    .create(u32::from(tiles) * TILE, speed)
                    .unwrap_or(LineId::NONE);
                if line != LineId::NONE {
                    for (item, pos) in items_at_rest {
                        if item != 0 {
                            let _ = t.insert_at(line, pos, Item(item));
                        }
                    }
                }
                g.lines[g.chains as usize] = line.0;
                g.chains += 1;
                cx.put_global(g);
            }
            Op::Link { from_line, to_line } => {
                let to = g.line(u32::from(to_line));
                let _ = t.set_out(g.line(u32::from(from_line)), Output::Next(to));
            }
            Op::Sink { line } => {
                let _ = t.set_out(g.line(u32::from(line)), Output::Sink);
            }
            Op::DeadEnd { line } => {
                let _ = t.set_out(g.line(u32::from(line)), Output::DeadEnd);
            }
            Op::Spawner { line, item, period } => {
                let line = g.line(u32::from(line));
                if line != LineId::NONE {
                    let s = Spawner {
                        at: req.at,
                        line: line.0,
                        item,
                        period,
                        acc: 0,
                        spawned: 0,
                    };
                    cx.put_entity(id, Thing::Spawner(s));
                    cx.activate(spawner_sys(), id);
                    return; // the entity lives on as the spawner.
                }
            }
        }
        cx.despawn(id);
    }
}

impl Game for Belts {
    const SCHEMA_VERSION: u32 = 2;
    type Worldgen = FlatWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Thing;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        let id = r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        debug_assert_eq!(id, PrototypeId(0));
        let _ = SPAWNER_SYS.set(r.system("spawner"));
    }

    fn prototype(_e: &Thing) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Thing) -> TilePos {
        match e {
            Thing::Request(r) => r.at.tile(),
            Thing::Spawner(s) => s.at.tile(),
        }
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global::default());
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player);
        }
    }

    /// Validates the op's shape, then spawns the request: never `transport_mut()` (0076 §6).
    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::Noop => Ok(()),
            Action::Request(op) => {
                if !op.valid() {
                    return Err(Reject::BadOp);
                }
                w.spawn(Thing::Request(Request {
                    at: op.anchor(),
                    op: *op,
                }));
                Ok(())
            }
        }
    }

    /// Requests woken this tick execute in spawn order; then every spawner makes at most one
    /// `insert_back` attempt (module doc).
    fn tick(cx: &mut TickCx<'_, Self>) {
        while let Some(id) = cx.next_woken() {
            match cx.entity(id).ok().flatten().copied() {
                Some(Thing::Request(req)) => Self::execute(cx, id, req),
                // Not woken in practice (`TickCx` puts never auto-wake); already on the list.
                Some(Thing::Spawner(_)) | None => {}
            }
        }

        let sys = spawner_sys();
        for i in 0..cx.active_len(sys) {
            let Some(id) = cx.active_at(sys, i) else {
                continue; // a tombstoned slot (0007 §7).
            };
            let Some(Thing::Spawner(was)) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            let mut s = was;
            s.acc += 256;
            if s.acc >= s.period {
                let ok = match cx.transport_mut() {
                    Ok(t) => t.insert_back(LineId(s.line), Item(s.item)).is_ok(),
                    Err(Unknown) => false,
                };
                if ok {
                    s.acc -= s.period;
                    s.spawned += 1;
                } else {
                    s.acc -= 256;
                }
            }
            // A held refusal leaves the state as it was: no write, so a backed-up spawner costs
            // no delta (the idle-cost rule of `fx-machines`' `idle-world-costs-zero`).
            if s != was {
                cx.put_entity(id, Thing::Spawner(s));
            }
        }
    }

    fn growth(a: &Action) -> Option<Growth> {
        match a {
            Action::Noop => Some(Growth::NONE),
            Action::Request(_) => Some(Growth::entities(1)),
        }
    }

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }
}

/// Flat grass everywhere: belt tests want a world with nothing in the way.
pub struct FlatWorldgen;

const EDGE: usize = 32; // matches `Game::CHUNK_BITS`'s default (5)

impl Worldgen for FlatWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), EDGE * EDGE);
        out.fill(Tile::new(0, 0, 0));
    }
}

engine::export_game!(Belts);
