//! Placement (M33: the shared [`can_place`] rule (what `apply(PlaceFurnace)`, `apply(PlaceBelt)` and
//! the client's ghost tint ask) and the furnace action; M51 generalised the rule to any footprint and
//! forbidden trait set).
//!
//! **`can_place` names no terrain and no entity type** (0007 section 6): it asks `traits_at`, which the
//! engine computes as the tile's traits OR its occupant's, so water, a resource and another entity
//! refuse through the same bits. Adding a terrain or a building that is not buildable changes
//! `content::register`, never this file.

use engine::game::{PlayerId, Unknown, WorldRead, WorldWrite};
use engine::world::{Footprint, TilePos, TraitSet};

use crate::{Furnace, RefEntity, RefGame, RefReject, TileXY, content};

/// Whether no tile of the `footprint` anchored at `origin` carries any bit of `forbidden`.
/// `Err(Unknown)` when a footprint tile the verdict depends on is outside the reader's held chunks
/// (a replica at the subscription edge): a caller shows a neutral hint and, for an action, still
/// sends it. A footprint whose first unreadable tile comes after an already-known blocked tile is
/// `Ok(false)`: that verdict does not depend on the unreadable tile.
pub fn can_place(
    w: &dyn WorldRead<RefGame>,
    origin: TilePos,
    footprint: Footprint,
    forbidden: TraitSet,
) -> Result<bool, Unknown> {
    for dy in 0..footprint.h as i32 {
        for dx in 0..footprint.w as i32 {
            let traits = w.traits_at(TilePos::new(origin.x + dx, origin.y + dy))?;
            if traits.0 & forbidden.0 != 0 {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// [`can_place`] for a furnace: its 2x2 footprint, [`content::FURNACE_FORBIDS`].
pub fn can_place_furnace(w: &dyn WorldRead<RefGame>, origin: TilePos) -> Result<bool, Unknown> {
    can_place(
        w,
        origin,
        content::FURNACE_FOOTPRINT,
        content::FURNACE_FORBIDS,
    )
}

/// [`can_place`] for a belt of any kind: one tile, [`content::BELT_FORBIDS`] (no resource).
pub fn can_place_belt(w: &dyn WorldRead<RefGame>, at: TilePos) -> Result<bool, Unknown> {
    can_place(w, at, content::BELT_FOOTPRINT, content::BELT_FORBIDS)
}

/// `apply(PlaceFurnace)`: validate (a furnace item, then [`can_place_furnace`]), then `spawn` and one
/// `put_player` (0003: every read and check precedes the first write).
pub fn place_furnace(
    w: &mut dyn WorldWrite<RefGame>,
    who: PlayerId,
    origin: TilePos,
) -> Result<(), RefReject> {
    let player = *w.player(who)?;
    if player.inventory.get(content::ItemId::Furnace) == 0 {
        return Err(RefReject::NoFurnace);
    }
    if !can_place_furnace(w, origin)? {
        return Err(RefReject::NotBuildable);
    }
    let mut next = player;
    next.inventory.0[content::ItemId::Furnace.idx()] -= 1;
    w.spawn(RefEntity::Furnace(Furnace::new(TileXY::from_tile(origin))));
    w.put_player(who, next);
    Ok(())
}
