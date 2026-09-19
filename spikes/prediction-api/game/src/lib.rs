//! Cut-down reference game. Everything a game author writes for prediction to work is in this
//! file; note there is no delta type, no `predict()`, no client-side code at all.

use spike_engine::*;

pub struct RefGame;

#[derive(Clone)]
pub struct Config {
    pub seed: u64,
}

// ---- data model -----------------------------------------------------------------------------

pub const BASE_GRASS: u32 = 0;
pub const BASE_WATER: u32 = 1;
pub const RES_NONE: u32 = 0;
pub const RES_IRON: u32 = 1;

pub fn pack(base: u32, res: u32, units: u32) -> Tile {
    Tile(base | (res << 8) | (units << 16))
}
pub fn base(t: Tile) -> u32 {
    t.0 & 0xFF
}
pub fn res(t: Tile) -> u32 {
    (t.0 >> 8) & 0xFF
}
pub fn units(t: Tile) -> u32 {
    (t.0 >> 16) & 0xFF
}

pub const NOT_BUILDABLE: TraitSet = TraitSet(1 << 0);
pub const COLLECTABLE: TraitSet = TraitSet(1 << 1);
const BASE_TRAITS: [TraitSet; 2] = [TraitSet(0), NOT_BUILDABLE]; // grass, water
const RES_TRAITS: [TraitSet; 2] = [TraitSet(0), COLLECTABLE]; // none, iron

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Item {
    Furnace = 0,
    IronOre = 1,
    Coal = 2,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Furnace {
    pub origin: TilePos,
    pub iron_in: u16,
    pub coal: u16,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Collect {
    pub tile: TilePos,
    pub started_at: Tick,
    pub done_at: Tick,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Player {
    pub inv: [u16; 3],
    pub collecting: Option<Collect>,
}

#[derive(Clone, Debug)]
pub enum Action {
    PlaceFurnace { origin: TilePos },
    /// Player position is presence, not sim state: the action carries a claimed position.
    StartCollect { tile: TilePos, claimed_pos: TilePos },
    CancelCollect,
    Deposit { at: TilePos, item: Item, count: u16 },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reject {
    NotPredictable,
    NotBuildable,
    NoItem,
    NoResource,
    OutOfRange,
    Busy,
    NoFurnace,
    BadItem,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::NotPredictable
    }
}

pub const COLLECT_TICKS: Tick = 20;
pub const COLLECT_RANGE: i32 = 4;
pub const FURNACE_SIZE: u8 = 2;

// ---- rules ----------------------------------------------------------------------------------

/// Shared by `apply` and by the UI's placement ghost (takes the read half only).
pub fn can_place_furnace(w: &dyn WorldRead<RefGame>, origin: TilePos) -> Result<(), Reject> {
    let fp = Footprint { origin, w: FURNACE_SIZE, h: FURNACE_SIZE };
    for t in fp.tiles() {
        if w.traits_at(t)?.contains(NOT_BUILDABLE) {
            return Err(Reject::NotBuildable);
        }
    }
    Ok(())
}

fn place_furnace(w: &mut dyn WorldWrite<RefGame>, who: PlayerId, origin: TilePos) -> Result<(), Reject> {
    let mut p = *w.player(who)?;
    if p.inv[Item::Furnace as usize] == 0 {
        return Err(Reject::NoItem);
    }
    can_place_furnace(&*w, origin)?;
    p.inv[Item::Furnace as usize] -= 1;
    w.put_player(who, p);
    w.spawn(Furnace { origin, iron_in: 0, coal: 0 });
    Ok(())
}

fn start_collect(w: &mut dyn WorldWrite<RefGame>, who: PlayerId, tile: TilePos, claimed: TilePos) -> Result<(), Reject> {
    let mut p = *w.player(who)?;
    if p.collecting.is_some() {
        return Err(Reject::Busy);
    }
    if (claimed.x - tile.x).abs().max((claimed.y - tile.y).abs()) > COLLECT_RANGE {
        return Err(Reject::OutOfRange);
    }
    let t = w.tile(tile)?;
    if !RefGame::tile_traits(t).contains(COLLECTABLE) {
        return Err(Reject::NoResource);
    }
    let now = w.tick();
    p.collecting = Some(Collect { tile, started_at: now, done_at: now + COLLECT_TICKS });
    w.put_player(who, p);
    Ok(())
}

fn cancel_collect(w: &mut dyn WorldWrite<RefGame>, who: PlayerId) -> Result<(), Reject> {
    let mut p = *w.player(who)?;
    if p.collecting.take().is_some() {
        w.put_player(who, p);
    }
    Ok(())
}

/// Addresses the furnace by tile, not by EntityId: a furnace the client has only predicted has
/// no real id yet, and a follow-up action must still mean the same thing on the host.
fn deposit(w: &mut dyn WorldWrite<RefGame>, who: PlayerId, at: TilePos, item: Item, count: u16) -> Result<(), Reject> {
    let mut p = *w.player(who)?;
    let id = w.entity_at(at)?.ok_or(Reject::NoFurnace)?;
    let mut f = *w.entity(id)?.ok_or(Reject::NoFurnace)?;
    if p.inv[item as usize] < count {
        return Err(Reject::NoItem);
    }
    match item {
        Item::IronOre => f.iron_in += count,
        Item::Coal => f.coal += count,
        Item::Furnace => return Err(Reject::BadItem),
    }
    p.inv[item as usize] -= count;
    w.put_player(who, p);
    w.put_entity(id, f);
    Ok(())
}

// ---- engine glue ----------------------------------------------------------------------------

fn hash2(seed: u64, p: TilePos) -> u64 {
    let mut h = seed ^ 0x9E3779B97F4A7C15;
    for v in [p.x as u32 as u64, p.y as u32 as u64] {
        h = (h ^ v).wrapping_mul(0xBF58476D1CE4E5B9);
        h ^= h >> 29;
    }
    h
}

impl Game for RefGame {
    type Config = Config;
    type Action = Action;
    type Reject = Reject;
    type Entity = Furnace;
    type Player = Player;

    /// Water for x <= -3; an iron patch at 8..12 x 8..12 holding 2-4 units per tile.
    fn pristine(cfg: &Config, pos: TilePos) -> Tile {
        if pos.x <= -3 {
            pack(BASE_WATER, RES_NONE, 0)
        } else if (8..12).contains(&pos.x) && (8..12).contains(&pos.y) {
            pack(BASE_GRASS, RES_IRON, 2 + (hash2(cfg.seed, pos) % 3) as u32)
        } else {
            pack(BASE_GRASS, RES_NONE, 0)
        }
    }

    fn tile_traits(tile: Tile) -> TraitSet {
        BASE_TRAITS[base(tile) as usize] | RES_TRAITS[res(tile) as usize]
    }
    fn entity_traits(_: &Furnace) -> TraitSet {
        NOT_BUILDABLE
    }
    fn footprint(e: &Furnace) -> Footprint {
        Footprint { origin: e.origin, w: FURNACE_SIZE, h: FURNACE_SIZE }
    }

    fn join(w: &mut dyn WorldWrite<Self>, who: PlayerId) {
        w.put_player(who, Player { inv: [2, 0, 5], collecting: None });
    }

    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, action: &Action) -> Result<(), Reject> {
        match *action {
            Action::PlaceFurnace { origin } => place_furnace(w, who, origin),
            Action::StartCollect { tile, claimed_pos } => start_collect(w, who, tile, claimed_pos),
            Action::CancelCollect => cancel_collect(w, who),
            Action::Deposit { at, item, count } => deposit(w, who, at, item, count),
        }
    }

    /// Host only. The client never runs this; it sees the outcome as ordinary deltas.
    fn tick(w: &mut Authority<Self>) {
        let now = WorldRead::tick(w);
        for who in w.player_ids() {
            let mut p = *w.player(who).unwrap();
            let Some(c) = p.collecting else { continue };
            if c.done_at > now {
                continue;
            }
            let t = w.tile(c.tile).unwrap();
            if res(t) == RES_IRON && units(t) > 0 {
                let left = units(t) - 1;
                w.set_tile(c.tile, if left == 0 { pack(base(t), RES_NONE, 0) } else { pack(base(t), RES_IRON, left) });
                p.inv[Item::IronOre as usize] += 1;
            }
            p.collecting = None;
            w.put_player(who, p);
        }
    }
}
