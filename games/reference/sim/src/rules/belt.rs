//! Belt placement (M51, README "Belts", Placement): `PlaceBelt`, `RotateBelt`, `PickUpBelt`.
//!
//! Belts are free: no inventory read, no unlock. Every action addresses its belt by tile (0022
//! section 6), validates before its one write (`.claude/rules/prediction.md`) and never moves an
//! anchor (0079 §20 (b): a rotate is a put with the same id and anchor; a pick-up despawns). The
//! spawn and the put wake the entity into `rules::furnace::tick`, which ignores a belt in M51; M52
//! maps lines from those wakes (0076 §6). `apply` never touches transport.

use engine::game::{EntityId, WorldRead, WorldWrite};
use engine::world::TilePos;

use crate::rules::place::can_place_belt;
use crate::{Belt, BeltKind, Dir, RefEntity, RefGame, RefReject, TileXY};

/// The belt at `at`, with its id: `NoBeltHere` when the tile is empty or holds a furnace.
pub fn belt_at(w: &dyn WorldRead<RefGame>, at: TilePos) -> Result<(EntityId, Belt), RefReject> {
    let id = w.entity_at(at)?.ok_or(RefReject::NoBeltHere)?;
    match w.entity(id)? {
        Some(RefEntity::Belt(b)) => Ok((id, *b)),
        _ => Err(RefReject::NoBeltHere),
    }
}

/// `apply(PlaceBelt)`: [`can_place_belt`] (not on an unbuildable tile, an entity or a resource), then
/// one `spawn` of a straight belt with no spawner configuration.
pub fn place(
    w: &mut dyn WorldWrite<RefGame>,
    at: TilePos,
    dir: Dir,
    kind: BeltKind,
) -> Result<(), RefReject> {
    if !can_place_belt(w, at)? {
        return Err(RefReject::NotBuildable);
    }
    w.spawn(RefEntity::Belt(Belt::new(TileXY::from_tile(at), dir, kind)));
    Ok(())
}

/// `apply(RotateBelt)`: one put of the same belt turned clockwise.
pub fn rotate(w: &mut dyn WorldWrite<RefGame>, at: TilePos) -> Result<(), RefReject> {
    let (id, belt) = belt_at(w, at)?;
    w.put_entity(
        id,
        RefEntity::Belt(Belt {
            dir: belt.dir.cw(),
            ..belt
        }),
    );
    Ok(())
}

/// `apply(PickUpBelt)`: despawns the belt; nothing returns to the inventory.
pub fn pick_up(w: &mut dyn WorldWrite<RefGame>, at: TilePos) -> Result<(), RefReject> {
    let (id, _) = belt_at(w, at)?;
    w.despawn(id);
    Ok(())
}
