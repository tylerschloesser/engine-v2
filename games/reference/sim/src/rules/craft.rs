//! `StartCraft`, crafting completion and the recipe unlock (M32.
//!
//! Cost is paid at `StartCraft`, the output is granted at completion (Planning decisions), so a
//! craft in flight cannot be starved by a later action. `crafting` and `collecting` are independent
//! slots of `RefPlayer`. The unlock is sim state, set by [`update_unlocks`] from `collect`'s
//! completion, never derived in `ui()`.

use engine::game::{PlayerId, WorldWrite};
use engine::time::Tick;

use crate::{Crafting, RefGame, RefPlayer, RefReject, content};

/// `apply(StartCraft)`, exact validation order (0004 "Pipeline per action"): recipe id known,
/// unlocked, not already crafting, cost affordable; then one `put_player` deducting the cost and
/// setting `crafting`. Every read precedes the one write (0003: validate first, write after).
pub fn start(w: &mut dyn WorldWrite<RefGame>, who: PlayerId, recipe: u8) -> Result<(), RefReject> {
    #[cfg(feature = "test-hooks")]
    if recipe == 255 {
        panic!("test-hooks: poison StartCraft");
    }
    let Some(def) = content::RECIPES.get(recipe as usize) else {
        return Err(RefReject::UnknownRecipe);
    };
    let player = *w.player(who)?;
    if player.unlocks & (1 << recipe) == 0 {
        return Err(RefReject::Locked);
    }
    if player.crafting.is_some() {
        return Err(RefReject::Busy);
    }
    if !affordable(&player, def) {
        return Err(RefReject::Unaffordable);
    }
    let mut next = player;
    for &(item, n) in def.cost {
        next.inventory.0[item.idx()] -= n;
    }
    next.crafting = Some(Crafting {
        recipe,
        done_at: w.tick() + def.ticks(<RefGame as engine::game::Game>::TICK_RATE),
    });
    w.put_player(who, next);
    Ok(())
}

/// Whether `player`'s inventory covers `def.cost` (also `Ui.recipes[..].affordable`).
pub fn affordable(player: &RefPlayer, def: &content::Recipe) -> bool {
    def.cost
        .iter()
        .all(|&(item, n)| player.inventory.get(item) >= n)
}

/// Sets the unlock bit of every recipe whose threshold `stone_mined` has reached. Called from
/// `collect`'s completion, the one place `stone_mined` changes.
pub fn update_unlocks(player: &mut RefPlayer) {
    for (i, def) in content::RECIPES.iter().enumerate() {
        if player.stone_mined >= def.unlock_stone_mined {
            player.unlocks |= 1 << i;
        }
    }
}

/// Completes `player`'s craft if it is due at `now`: grants the output and clears the slot.
/// Returns whether anything changed (the caller's scan then puts the player once).
pub fn complete_due(player: &mut RefPlayer, now: Tick) -> bool {
    let Some(c) = player.crafting else {
        return false;
    };
    if c.done_at > now {
        return false;
    }
    if let Some(def) = content::RECIPES.get(c.recipe as usize) {
        player.inventory.add(def.output, 1);
    }
    player.crafting = None;
    true
}
