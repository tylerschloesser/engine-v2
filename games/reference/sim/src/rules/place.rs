//! Furnace placement (M33: the shared [`can_place`] rule (what both
//! `apply(PlaceFurnace)` and the client's ghost tint ask) and the action itself.
//!
//! **`can_place` names no terrain and no entity type** (0007 section 6): it asks `traits_at`, which the
//! engine computes as the tile's traits OR its occupant's, so water, a resource and another furnace
//! refuse through the same bit. Adding a terrain or a building that is not buildable changes
//! `content::register`, never this file.

use engine::game::{PlayerId, Unknown, WorldRead, WorldWrite};
use engine::world::TilePos;

use crate::{Furnace, RefGame, RefReject, TileXY, content};

/// Whether every tile of the furnace footprint anchored at `origin` lacks `NOT_BUILDABLE`.
/// `Err(Unknown)` when a footprint tile the verdict depends on is outside the reader's held chunks
/// (a replica at the subscription edge): a caller shows a neutral hint and, for an action, still
/// sends it. A footprint whose first unreadable tile comes after an already-known blocked tile is
/// `Ok(false)`: that verdict does not depend on the unreadable tile.
pub fn can_place(w: &dyn WorldRead<RefGame>, origin: TilePos) -> Result<bool, Unknown> {
    let fp = content::FURNACE_FOOTPRINT;
    for dy in 0..fp.h as i32 {
        for dx in 0..fp.w as i32 {
            let traits = w.traits_at(TilePos::new(origin.x + dx, origin.y + dy))?;
            if traits.contains(content::NOT_BUILDABLE) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// `apply(PlaceFurnace)`: validate (a furnace item, then [`can_place`]), then `spawn` and one
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
    if !can_place(w, origin)? {
        return Err(RefReject::NotBuildable);
    }
    let mut next = player;
    next.inventory.0[content::ItemId::Furnace.idx()] -= 1;
    w.spawn(Furnace::new(TileXY::from_tile(origin)));
    w.put_player(who, next);
    Ok(())
}
