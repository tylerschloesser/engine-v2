//! Belt placement (M51, README "Belts", Placement): `PlaceBelt`, `RotateBelt`, `PickUpBelt`.
//!
//! Belts are free: no inventory read, no unlock. Every action addresses its belt by tile (0022
//! section 6), validates before its one write (`.claude/rules/prediction.md`) and never moves an
//! anchor (0079 §20 (b): a rotate is a put with the same id and anchor). `apply` never touches
//! transport (0076 §6): the spawn or put wakes the belt into `rules::tick`, whose
//! `belts::topology::on_wake` maps its lines (M52). `PlaceBelt` and `RotateBelt` write the edited
//! tile's own shape, derived from its neighbours by reads only, so a predicted belt shows its curve at
//! once; the neighbours' shapes are the tick's. `PickUpBelt` marks the belt `removing` (a despawn wakes
//! nothing): the tick unmaps it and despawns it. `SetSpawner` (M53b) writes a spawner lane's
//! configuration in one put; the tick that put wakes sets the lane line's engine schedule.

use engine::game::{EntityId, WorldRead, WorldWrite};
use engine::world::TilePos;

use crate::rules::belts::topology::shape_of_kind;
use crate::rules::place::can_place_belt;
use crate::{Belt, BeltKind, Dir, RefEntity, RefGame, RefReject, SpawnCfg, TileXY, content};

/// The belt at `at`, with its id: `NoBeltHere` when the tile is empty, holds a furnace or a belt
/// being picked up (M52: `removing`).
pub fn belt_at(w: &dyn WorldRead<RefGame>, at: TilePos) -> Result<(EntityId, Belt), RefReject> {
    let id = w.entity_at(at)?.ok_or(RefReject::NoBeltHere)?;
    match w.entity(id)? {
        Some(RefEntity::Belt(b)) if !b.removing => Ok((id, *b)),
        _ => Err(RefReject::NoBeltHere),
    }
}

/// `apply(PlaceBelt)`: [`can_place_belt`] (not on an unbuildable tile, an entity or a resource), the
/// tile's shape from its neighbours, then one `spawn` with no spawner configuration.
pub fn place(
    w: &mut dyn WorldWrite<RefGame>,
    at: TilePos,
    dir: Dir,
    kind: BeltKind,
) -> Result<(), RefReject> {
    if !can_place_belt(w, at)? {
        return Err(RefReject::NotBuildable);
    }
    let shape = shape_of_kind(w, at, dir, kind)?;
    w.spawn(RefEntity::Belt(Belt {
        shape,
        ..Belt::new(TileXY::from_tile(at), dir, kind)
    }));
    Ok(())
}

/// `apply(RotateBelt)`: one put of the same belt turned clockwise, with its shape for the new facing.
pub fn rotate(w: &mut dyn WorldWrite<RefGame>, at: TilePos) -> Result<(), RefReject> {
    let (id, belt) = belt_at(w, at)?;
    let dir = belt.dir.cw();
    let shape = shape_of_kind(w, at, dir, belt.kind)?;
    w.put_entity(id, RefEntity::Belt(Belt { dir, shape, ..belt }));
    Ok(())
}

/// `apply(PickUpBelt)`: one put marking the belt `removing`; the tick that follows unmaps its lines
/// (destroying the items on the tile) and despawns it. Nothing returns to the inventory.
pub fn pick_up(w: &mut dyn WorldWrite<RefGame>, at: TilePos) -> Result<(), RefReject> {
    let (id, belt) = belt_at(w, at)?;
    w.put_entity(
        id,
        RefEntity::Belt(Belt {
            removing: true,
            ..belt
        }),
    );
    Ok(())
}

/// `apply(SetSpawner)` (M53b): `NoBeltHere`, `NotASpawner`, `BadLane` (not 0 or 1), `BadItem` (not a
/// `content::ItemId` wire id nor [`content::SPAWN_OFF`]), `BadRate` (not an index into
/// [`content::SPAWN_RATES`]; ignored when clearing), then one put of the lane's configuration (the
/// tick re-sets both lanes' schedules: `topology::schedule`). A configuration equal to the lane's is `Ok` with no write (the lane's
/// credit is kept). Validated before the one write (`.claude/rules/prediction.md`).
pub fn set_spawner(
    w: &mut dyn WorldWrite<RefGame>,
    at: TilePos,
    lane: u8,
    item: u8,
    rate: u8,
) -> Result<(), RefReject> {
    let (id, belt) = belt_at(w, at)?;
    if belt.kind != BeltKind::Spawner {
        return Err(RefReject::NotASpawner);
    }
    if lane > 1 {
        return Err(RefReject::BadLane);
    }
    let cfg = if item == content::SPAWN_OFF {
        None
    } else {
        if content::ItemId::from_wire(item).is_none() {
            return Err(RefReject::BadItem);
        }
        if usize::from(rate) >= content::SPAWN_RATES.len() {
            return Err(RefReject::BadRate);
        }
        Some(SpawnCfg { item, rate })
    };
    let k = usize::from(lane);
    if belt.spawn[k] == cfg {
        return Ok(());
    }
    let mut spawn = belt.spawn;
    spawn[k] = cfg;
    w.put_entity(id, RefEntity::Belt(Belt { spawn, ..belt }));
    Ok(())
}
