//! Fixture game `fx-busy-field` (docs/plan/31-rates-and-integrity.md step 2): the load 0010's
//! bandwidth rows are measured against.
//!
//! **Steady field** ([`BusyField`], the exported game): genesis lays out [`FIELD_MACHINES`] = 200
//! timer-driven `Machine`s on a 20 x 10 grid (3-tile pitch, so chunks (0,0) and (1,0)). Each wakes
//! once, then puts a whole new value of itself every [`PERIOD`] ticks (`count += 1`, `lit` flips):
//! twice per 5 s at 20 Hz, phases staggered by entity id, which is 0010's worked number "200 active
//! machines changing state twice per 5 s are 80 whole-value puts/s" (4 puts every tick).
//!
//! **Dense chunks**: [`fill_chunk`] adds [`CHUNK_ENTITIES`] = 200 dormant machines (`period == 0`:
//! they never wake into a rule) and [`OVERLAY_TILES`] modified tiles to one chunk, sized to 0010's
//! "dense chunk (200 entities x ~16 B plus 0.5-1 KB of overlay runs) is ~4 KB". Two ways in:
//! `Action::Fill { cx, cy }` (any host, the `.wasm` included, under the world's state budget) and
//! the bench-only genesis of `BusyField<true>`, which fills the whole maximum view of 0010's
//! "121 chunks" ([`DENSE_RADIUS`]). `BusyField<true>` is not exported to the `.wasm`
//! (`export_game!` names `BusyField<false>`): a native benchmark or test picks it by type.
//!
//! The worldgen is a flat grass field, so every modified tile is a real overlay entry.

use engine::game::{
    Game, Growth, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::time::{Tick, TickRate, Ticks};
use engine::world::{ChunkCoord, Footprint, PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;
use ts_rs::TS;

/// A machine's state change interval: two whole-value puts per 5 s at the default 20 Hz.
pub const PERIOD: Ticks = TickRate::HZ_20.millis(2500);
/// Machines the steady field's genesis places (0010's worked number).
pub const FIELD_MACHINES: u32 = 200;
/// Entities [`fill_chunk`] adds to a chunk (0010's "dense chunk").
pub const CHUNK_ENTITIES: u32 = 200;
/// Modified tiles [`fill_chunk`] adds to a chunk: consecutive tiles differ, so the overlay is one
/// long non-repeat run (4 B a tile, about 0.9 KB).
pub const OVERLAY_TILES: u32 = 224;
/// The bench genesis fills chunks `-DENSE_RADIUS..=DENSE_RADIUS` on both axes: 11 x 11 = 121, 0010's
/// maximum zoom-out view.
pub const DENSE_RADIUS: i32 = 5;

const EDGE: i32 = 32; // `Game::CHUNK_BITS`'s default (5)
const STOCK0: u32 = 20_000; // 3-byte varint
const HEAT0: u16 = 300; // 2-byte varint
const GRASS: u8 = 0;
const PAINT: u8 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    /// Fills chunk `(cx, cy)` to the dense-chunk figure ([`fill_chunk`]). Growth: 200 entities and
    /// 224 modified tiles, so the world's `max_entities`/`max_action_growth` must allow it.
    Fill { cx: i32, cy: i32 },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    Unknown,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// Whole-value replicated entity: about 16 B encoded and as a `ChunkDeltas` put with its id
/// (0010 worked number).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Machine {
    pub origin: Pos,
    pub count: u32,
    pub lit: bool,
    /// Payload that changes with every put, sized so a whole-value put is about 0010's 16 B net of
    /// frame framing (two 3-byte and one 2-byte varint at the values the rule reaches).
    pub stock: u32,
    pub fuel: u32,
    pub heat: u16,
    /// Ticks between state changes; `0` is dormant (a dense-chunk filler that never acts).
    pub period: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global;

/// `DENSE = true` is the bench-only genesis (module doc comment).
pub struct BusyField<const DENSE: bool = false>;

/// Adds [`CHUNK_ENTITIES`] dormant machines and [`OVERLAY_TILES`] modified tiles to chunk
/// `(cx, cy)`. Entities sit on a 20-wide grid whose corner is 6 tiles in; the overlay is the first
/// [`OVERLAY_TILES`] tiles in row-major order.
pub fn fill_chunk<G: Game<Entity = Machine>>(w: &mut dyn WorldWrite<G>, cx: i32, cy: i32) {
    let bx = cx.wrapping_mul(EDGE);
    let by = cy.wrapping_mul(EDGE);
    for i in 0..OVERLAY_TILES as i32 {
        let p = TilePos::new(bx.wrapping_add(i % EDGE), by.wrapping_add(i / EDGE));
        w.set_tile(p, Tile::new(PAINT + (i % 3) as u8, 0, 0));
    }
    for i in 0..CHUNK_ENTITIES as i32 {
        w.spawn(Machine {
            origin: Pos {
                x: bx.wrapping_add(6 + i % 20),
                y: by.wrapping_add(6 + i / 20),
            },
            stock: STOCK0,
            fuel: STOCK0,
            heat: HEAT0,
            period: 0,
            ..Machine::default()
        });
    }
}

fn steady_field<G: Game<Entity = Machine>>(w: &mut dyn WorldWrite<G>) {
    for i in 0..FIELD_MACHINES as i32 {
        w.spawn(Machine {
            origin: Pos {
                x: (i % 20) * 3,
                y: (i / 20) * 3,
            },
            stock: STOCK0,
            fuel: STOCK0,
            heat: HEAT0,
            period: PERIOD.0,
            ..Machine::default()
        });
    }
}

impl<const DENSE: bool> Game for BusyField<DENSE> {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = BusyWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Machine;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        let id = r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        debug_assert_eq!(id, PrototypeId(0));
    }

    fn prototype(_e: &Machine) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Machine) -> TilePos {
        TilePos::new(e.origin.x, e.origin.y)
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global);
        if DENSE {
            for cy in -DENSE_RADIUS..=DENSE_RADIUS {
                for cx in -DENSE_RADIUS..=DENSE_RADIUS {
                    fill_chunk(w, cx, cy);
                }
            }
        } else {
            steady_field(w);
        }
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player);
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::Fill { cx, cy } => {
                fill_chunk(w, *cx, *cy);
                Ok(())
            }
        }
    }

    /// A woken machine with a period schedules its first change (phase = id mod period, so the
    /// field's puts spread evenly); a due one changes state and reschedules. Dormant machines and
    /// idle ticks cost nothing.
    fn tick(cx: &mut TickCx<'_, Self>) {
        while let Some(id) = cx.next_woken() {
            let Some(m) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            if m.period != 0 {
                let phase = 1 + id.0 % m.period;
                cx.wake_at(id, Tick((cx.tick() + Ticks(phase)).0));
            }
        }
        while let Some(id) = cx.next_due() {
            let Some(mut m) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            m.count += 1;
            m.lit = !m.lit;
            m.stock = STOCK0.wrapping_add(m.count.wrapping_mul(1_009));
            m.fuel = STOCK0.wrapping_add(m.count.wrapping_mul(3));
            m.heat = HEAT0.wrapping_add((m.count as u16).wrapping_mul(7));
            cx.put_entity(id, m);
            cx.wake_at(id, cx.tick() + Ticks(m.period));
        }
    }

    fn growth(a: &Action) -> Option<Growth> {
        match a {
            Action::Fill { .. } => Some(Growth {
                entities: CHUNK_ENTITIES as u16,
                modified_tiles: OVERLAY_TILES as u16,
            }),
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

/// Flat grass: every modified tile is a genuine overlay entry.
pub struct BusyWorldgen;

impl Worldgen for BusyWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), (EDGE * EDGE) as usize);
        out.fill(Tile::new(GRASS, 0, 0));
    }
}

engine::export_game!(BusyField<false>);
