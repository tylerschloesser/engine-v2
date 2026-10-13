//! Belt placement (M51, README "Belts", Placement): `PlaceBelt`, `RotateBelt`, `PickUpBelt`.
//!
//! Belts are free: no inventory read, no unlock. Every action addresses its belt by tile (0022
//! section 6), validates before it writes (one put, two for an underground pair:
//! `.claude/rules/prediction.md`) and never moves an anchor (0079 §20 (b): a rotate is a put with
//! the same id and anchor). `apply` never touches
//! transport (0076 §6): the spawn or put wakes the belt into `rules::tick`, whose
//! `belts::topology::on_wake` maps its lines (M52). `PlaceBelt` and `RotateBelt` write the edited
//! tile's own shape, derived from its neighbours by reads only, so a predicted belt shows its curve at
//! once; the neighbours' shapes are the tick's. `PickUpBelt` marks the belt `removing` (a despawn wakes
//! nothing): the tick unmaps it and despawns it. `SetSpawner` (M53b) writes a spawner lane's
//! configuration in one put; the tick that put wakes sets the lane line's engine schedule.
//!
//! **Splitters** (M54) are placed with `PlaceBelt { kind: Splitter }` anchored at the footprint's
//! min corner (`content::belt_footprint`), found by either tile (`entity_at`), turned 180 degrees in
//! place by `RotateBelt` (the footprint and anchor never move; changing the axis is a pick-up and a
//! new placement: README "Belts" question 12's default) and picked up like a belt.
//!
//! **Underground ends** (M55, M60) are rotated as a pair: `RotateBelt` on either end flips it and its
//! paired end in one action (two puts after every read), so the pair stays paired with its flow
//! reversed; an unpaired end flips alone (README "Belts", Rotating an underground).

use engine::game::{EntityId, WorldRead, WorldWrite};
use engine::world::TilePos;

use crate::rules::belts::topology::{shape_of_kind, underground_other_end};
use crate::rules::place::can_place_belt_kind;
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

/// `apply(PlaceBelt)`: [`can_place_belt_kind`] over the kind's footprint anchored at `at` (not on an
/// unbuildable tile, an entity or a resource), the tile's shape from its neighbours (a splitter's is
/// always straight), then one `spawn` with no spawner configuration.
pub fn place(
    w: &mut dyn WorldWrite<RefGame>,
    at: TilePos,
    dir: Dir,
    kind: BeltKind,
) -> Result<(), RefReject> {
    if !can_place_belt_kind(w, at, dir, kind)? {
        return Err(RefReject::NotBuildable);
    }
    let shape = shape_of_kind(w, at, dir, kind)?;
    w.spawn(RefEntity::Belt(Belt {
        shape,
        ..Belt::new(TileXY::from_tile(at), dir, kind)
    }));
    Ok(())
}

/// `apply(RotateBelt)`: one put of the same belt turned clockwise, with its shape for the new facing;
/// a splitter (M54) turned 180 degrees, its anchor and footprint unchanged (0079 §20 (b) by
/// construction: nothing to re-validate). An underground end (M60, Tyler's 2026-10-13 answer:
/// README "Belts", Rotating an underground) is flipped: turned 180 degrees with its kind swapped
/// (an entrance facing `d` becomes an exit facing the opposite way, and the reverse), and so is its
/// paired end if it has one ([`underground_other_end`]: up to five tiles read, every read `?`, so an
/// unknown tile refuses the action before either put); the pair stays paired with its flow reversed.
pub fn rotate(w: &mut dyn WorldWrite<RefGame>, at: TilePos) -> Result<(), RefReject> {
    let (id, belt) = belt_at(w, at)?;
    if belt.kind.is_underground() {
        let other = match underground_other_end(w, at, belt)? {
            Some(t) => Some(belt_at(w, t)?),
            None => None,
        };
        w.put_entity(id, RefEntity::Belt(flipped(belt)));
        if let Some((oid, ob)) = other {
            w.put_entity(oid, RefEntity::Belt(flipped(ob)));
        }
        return Ok(());
    }
    let dir = if belt.kind == BeltKind::Splitter {
        belt.dir.cw().cw()
    } else {
        belt.dir.cw()
    };
    let shape = shape_of_kind(w, belt.origin.tile(), dir, belt.kind)?;
    w.put_entity(id, RefEntity::Belt(Belt { dir, shape, ..belt }));
    Ok(())
}

/// An underground end flipped (M60): 180 degrees, entrance and exit swapped; always straight.
fn flipped(b: Belt) -> Belt {
    let kind = if b.kind == BeltKind::UndergroundIn {
        BeltKind::UndergroundOut
    } else {
        BeltKind::UndergroundIn
    };
    Belt {
        dir: b.dir.cw().cw(),
        kind,
        ..b
    }
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
