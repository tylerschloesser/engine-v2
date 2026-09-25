//! `StartCollect`/`CancelCollect` and the tick rule that completes them (docs/plan/
//! 20-reference-game-v0.md Scope). [`in_range`] is a Provides seam shared with M20b's own button
//! logic (`docs/spec/reference-game.md`: "a collect button appears ... when a player is within 3
//! tiles").
//!
//! **Collects are not reservations** (Planning decisions): `apply` never claims a resource, only
//! records intent (`RefPlayer::collecting`); `tick` re-reads the tile at completion time, so two
//! players racing the same tile's last unit is possible by construction, not a bug (`0003`
//! Consequences wants this scripted, M34c) -- [`complete_one`] is the one place that race resolves.

use engine::game::{PlayerId, TickCx, WorldRead, WorldWrite};
use engine::world::{TilePos, WorldPos};

use crate::{Collecting, RefGame, RefPlayer, RefReject, TileXY, content};

/// `dist(from, tile centre) <= RANGE` in Q24.8 integers (Scope), compared as squared distance so
/// no `sqrt` is needed at all (`.claude/rules/determinism.md`: `sqrt` is allowed, but avoiding it
/// avoids the question). `i128`: `from` is a witness carried in the action's own bytes, so an
/// adversarial claim can be any `i32`; the difference of two `i32`-derived Q24.8 values squared can
/// exceed `i64::MAX` (`(2^32)^2` order of magnitude), but never `i128::MAX`.
pub fn in_range(from: WorldPos, tile: TilePos) -> bool {
    let centre = WorldPos::from_tile(tile);
    // Tile centre: the tile's own origin (`WorldPos::from_tile`) plus half a tile (128 of 256 Q24.8
    // raw units, 0007 §2) on each axis.
    let cx = centre.x as i64 + 128;
    let cy = centre.y as i64 + 128;
    let dx = (from.x as i64 - cx) as i128;
    let dy = (from.y as i64 - cy) as i128;
    let dist_sq = dx * dx + dy * dy;
    let range = content::RANGE_Q8 as i128;
    dist_sq <= range * range
}

/// `apply(StartCollect)` (Scope, exact validation order): tile readable, resource present and
/// `COLLECTABLE`, in range, not already collecting; then `put_player` with `collecting = Some { tile,
/// done_at }`. Every read up to and including `w.player(who)?` happens before the one write
/// (0003: "validate first, write after"), so a rejecting call here can never trip `Sim::step`'s own
/// "a rejecting apply recorded a write" assert.
pub fn start(
    w: &mut dyn WorldWrite<RefGame>,
    who: PlayerId,
    tile: TilePos,
    from: WorldPos,
) -> Result<(), RefReject> {
    let t = w.tile(tile)?;
    if t.resource() == 0 {
        return Err(RefReject::NoResource);
    }
    if !w.traits_at(tile)?.contains(content::COLLECTABLE) {
        return Err(RefReject::NoResource);
    }
    if !in_range(from, tile) {
        return Err(RefReject::OutOfRange);
    }
    let player = *w.player(who)?;
    if player.collecting.is_some() {
        return Err(RefReject::Busy);
    }
    let done_at = w.tick() + content::COLLECT;
    let mut next = player;
    next.collecting = Some(Collecting {
        tile: TileXY::from_tile(tile),
        done_at,
    });
    w.put_player(who, next);
    Ok(())
}

/// `apply(CancelCollect)` (Scope: "clears it"). Never rejects: cancelling with nothing to cancel
/// is a no-op, exactly like the client's own "panning out of range" trigger racing an already-
/// completed collect (`0001` "Panning out of range cancels a collect").
pub fn cancel(w: &mut dyn WorldWrite<RefGame>, who: PlayerId) -> Result<(), RefReject> {
    let player = *w.player(who)?;
    if player.collecting.is_some() {
        let mut next = player;
        next.collecting = None;
        w.put_player(who, next);
    }
    Ok(())
}

/// `tick`'s own completion pass (Scope: "decrement `aux` with `set_tile` (resource id cleared at
/// zero), add one item, bump `stone_mined`"). Walks the player table once (`TickCx::player_count`/
/// `player_id_at`, "Player timers are scanned, not scheduled" -- Planning decisions), comparing
/// `done_at` against the tick just simulated.
pub fn tick(cx: &mut TickCx<'_, RefGame>) {
    let now = cx.tick();
    for i in 0..cx.player_count() {
        let Some(who) = cx.player_id_at(i) else {
            continue;
        };
        let Ok(&player) = cx.player(who) else {
            continue;
        };
        let Some(collecting) = player.collecting else {
            continue;
        };
        if collecting.done_at > now {
            continue;
        }
        complete_one(cx, who, player, collecting);
    }
}

/// One player's completion (split out of [`tick`] so the borrow of `cx.player(who)` ends before
/// this mutates it -- `TickCx`'s `WorldWrite` methods take `&mut self`). Re-reads the tile: if its
/// resource is already gone (another player finished it first this same tick, Planning decisions
/// "Collects are not reservations"), this player's collect ends with no item, matching `0003`
/// Consequences' wanted "last unit" rejection race.
fn complete_one(
    cx: &mut TickCx<'_, RefGame>,
    who: PlayerId,
    player: RefPlayer,
    collecting: Collecting,
) {
    let mut next = player;
    next.collecting = None;
    let tile = collecting.tile.tile();
    if let Ok(t) = WorldRead::<RefGame>::tile(cx, tile) {
        let resource = t.resource();
        if resource != 0 {
            let remaining = t.aux().saturating_sub(1);
            let depleted = t.with_aux(remaining);
            cx.set_tile(
                tile,
                if remaining == 0 {
                    // Overlay is canonical (Tests added): a fully depleted tile carries no
                    // leftover resource id once `aux` reaches 0, indistinguishable from a plain
                    // generated tile that never had one.
                    depleted.with_resource(0)
                } else {
                    depleted
                },
            );
            next.inventory.add(resource, 1);
            if resource == content::STONE {
                next.stone_mined = next.stone_mined.saturating_add(1);
            }
        }
    }
    cx.put_player(who, next);
}
