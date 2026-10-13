//! Belt placement (M51, README "Belts", Placement): `PlaceBelt`, `RotateBelt`, `PickUpBelt`.
//!
//! Belts are free: no inventory read, no unlock. Every action addresses its belt by tile (0022
//! section 6), validates before its one write (`.claude/rules/prediction.md`) and never moves an
//! anchor (0079 §20 (b): a rotate is a put with the same id and anchor). `apply` never touches
//! transport (0076 §6): the spawn or put wakes the belt into `rules::tick`, whose
//! `belts::topology::on_wake` maps its lines (M52). `PlaceBelt` and `RotateBelt` write the edited
//! tile's own shape, derived from its neighbours by reads only, so a predicted belt shows its curve at
//! once; the neighbours' shapes are the tick's. `PickUpBelt` marks the belt `removing` (a despawn wakes
//! nothing): the tick unmaps it and despawns it.

use engine::game::{EntityId, WorldRead, WorldWrite};
use engine::world::TilePos;

use crate::rules::belts::topology::shape_of;
use crate::rules::place::can_place_belt;
use crate::{Belt, BeltKind, Dir, RefEntity, RefGame, RefReject, TileXY};

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
    let shape = shape_of(w, at, dir)?;
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
    let shape = shape_of(w, at, dir)?;
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
