//! Furnace operation (docs/plan/33b-reference-furnace-operation.md): deposit, take, pick-up and
//! smelting.
//!
//! **Machines sleep.** A furnace's state changes only in [`advance`], one `put_entity` per change,
//! scheduled with `wake_at`; a furnace with nothing to do has no timer and no active-list slot and
//! costs nothing. Fuel is lit at smelt start and ore is consumed at smelt end, so an interrupted
//! world never loses ore. Coal burns before wood.
//!
//! The three actions address a furnace by any tile under its footprint (0022 section 6) and follow
//! `.claude/rules/prediction.md`: every read is `?`-propagated and every check precedes the first put.

use engine::game::{EntityId, PlayerId, TickCx, WorldRead, WorldWrite};
use engine::world::TilePos;

use crate::{Furnace, RefGame, RefReject, content};
use content::ItemId;

/// The furnace at `at`, with its id: `NoFurnaceHere` when the tile has no occupant.
fn furnace_at(w: &dyn WorldRead<RefGame>, at: TilePos) -> Result<(EntityId, Furnace), RefReject> {
    let id = w.entity_at(at)?.ok_or(RefReject::NoFurnaceHere)?;
    let f = *w.entity(id)?.ok_or(RefReject::NoFurnaceHere)?;
    Ok((id, f))
}

/// `apply(FurnaceDeposit)`: a furnace at `at`, `item` iron/coal/wood, `1 <= count <= held`, the slot
/// does not overflow; then one `put_entity` and one `put_player`. The entity put wakes the furnace.
pub fn deposit(
    w: &mut dyn WorldWrite<RefGame>,
    who: PlayerId,
    at: TilePos,
    item: u8,
    count: u32,
) -> Result<(), RefReject> {
    let player = *w.player(who)?;
    let (id, furnace) = furnace_at(w, at)?;
    let item = match ItemId::from_wire(item) {
        Some(i @ (ItemId::Iron | ItemId::Coal | ItemId::Wood)) => i,
        _ => return Err(RefReject::BadItem),
    };
    if count == 0 {
        return Err(RefReject::BadCount);
    }
    if player.inventory.get(item) < count {
        return Err(RefReject::NotEnoughItems);
    }
    let held = match item {
        ItemId::Iron => furnace.iron_in,
        ItemId::Coal => furnace.coal,
        _ => furnace.wood,
    };
    if u32::from(held) + count > content::SLOT_CAP {
        return Err(RefReject::SlotFull);
    }
    let mut next = furnace;
    let slot = match item {
        ItemId::Iron => &mut next.iron_in,
        ItemId::Coal => &mut next.coal,
        _ => &mut next.wood,
    };
    *slot += count as u16; // <= SLOT_CAP by the check above.
    let mut next_player = player;
    next_player.inventory.0[item.idx()] -= count;
    w.put_entity(id, next);
    w.put_player(who, next_player);
    Ok(())
}

/// `apply(FurnaceTake)`: moves every ingot to the player. Rejects a furnace with none.
pub fn take(w: &mut dyn WorldWrite<RefGame>, who: PlayerId, at: TilePos) -> Result<(), RefReject> {
    let player = *w.player(who)?;
    let (id, furnace) = furnace_at(w, at)?;
    if furnace.ingots_out == 0 {
        return Err(RefReject::NothingToTake);
    }
    let mut next = furnace;
    next.ingots_out = 0;
    let mut next_player = player;
    next_player
        .inventory
        .add(ItemId::Ingot, u32::from(furnace.ingots_out));
    w.put_entity(id, next);
    w.put_player(who, next_player);
    Ok(())
}

/// Whether nothing is inside: no ore, fuel (lit included) or ingots.
pub fn is_empty(f: &Furnace) -> bool {
    f.iron_in == 0 && f.coal == 0 && f.wood == 0 && f.burn_left == 0 && f.ingots_out == 0
}

/// `apply(FurnacePickUp)`: despawns an empty furnace and returns the item. An empty furnace never
/// has a timer to lose (a smelting furnace holds ore), and `despawn` releases occupancy anyway.
pub fn pick_up(
    w: &mut dyn WorldWrite<RefGame>,
    who: PlayerId,
    at: TilePos,
) -> Result<(), RefReject> {
    let player = *w.player(who)?;
    let (id, furnace) = furnace_at(w, at)?;
    if !is_empty(&furnace) {
        return Err(RefReject::FurnaceNotEmpty);
    }
    let mut next_player = player;
    next_player.inventory.add(ItemId::Furnace, 1);
    w.despawn(id);
    w.put_player(who, next_player);
    Ok(())
}

/// The tick rule: one [`advance`] per woken furnace, then one per due timer.
pub fn tick(cx: &mut TickCx<'_, RefGame>) {
    while let Some(id) = cx.next_woken() {
        advance(cx, id);
    }
    while let Some(id) = cx.next_due() {
        advance(cx, id);
    }
}

/// The only furnace rule; idempotent for a furnace with nothing to do, so a deposit's wake and the
/// wheel's due timer share it. If a smelt is due, finish it (iron -1, ingot +1, burn -1); then, if
/// idle with iron and either burn left or fuel to light (coal first), light it and schedule the next
/// finish; otherwise sleep with no timer. At most one `put_entity`, and none when nothing changed.
pub fn advance(cx: &mut TickCx<'_, RefGame>, id: EntityId) {
    let Some(mut f) = cx.entity(id).ok().flatten().copied() else {
        return; // despawned before this tick got to it.
    };
    let now = cx.tick();
    let before = f;
    let mut finished = false;
    if let Some(done) = f.smelt_done_at {
        if done > now {
            return; // a spurious wake mid-smelt: the timer stays.
        }
        f.iron_in = f.iron_in.saturating_sub(1);
        f.ingots_out = f.ingots_out.saturating_add(1);
        f.burn_left = f.burn_left.saturating_sub(1);
        f.smelt_done_at = None;
        finished = true;
    }
    if f.iron_in > 0 {
        if f.burn_left == 0 {
            if f.coal > 0 {
                f.coal -= 1;
                f.burn_left = content::COAL_INGOTS;
            } else if f.wood > 0 {
                f.wood -= 1;
                f.burn_left = content::WOOD_INGOTS;
            }
        }
        if f.burn_left > 0 {
            let done = now + content::SMELT;
            f.smelt_done_at = Some(done);
            cx.wake_at(id, done);
        }
    }
    if finished && f.smelt_done_at.is_none() {
        cx.cancel_wake(id); // sleeping: no timer left behind.
    }
    if f != before {
        cx.put_entity(id, f);
    }
}
