//! `OverlayDiff` (M26 Scope, Provides; Planning
//! decisions "Change list = tiles only"): the per-frame overlay change list that feeds the dirty
//! set `ClientCore::drain_dirty` drains. Terrain texels are the only retained renderer state
//! (entities/players/globals are re-derived from a fresh `extract`/`ui` every frame, so they need
//! no diff); this keeps the *previous* replay's deduplicated overlay tile list and compares it
//! against the current one after every replay (`Overlay::effective_tiles`), so a reset-and-replay
//! with unchanged content produces an empty [`OverlayDiff::tiles`] -- no chunk is marked, nothing
//! uploads.

use crate::game::Game;
use crate::predict::Overlay;
use crate::world::{Tile, TilePos};

/// One replay's worth of "what changed" (Planning decisions: "single digits"): `prev`/`cur` are
/// kept, not rebuilt from scratch every call, so repeated calls with unchanged overlay content
/// allocate nothing once warm (`.claude/rules/hot-paths.md`).
pub struct OverlayDiff {
    prev: Vec<(TilePos, Tile)>,
    cur: Vec<(TilePos, Tile)>,
    changed: Vec<TilePos>,
}

impl OverlayDiff {
    pub fn new() -> Self {
        OverlayDiff {
            prev: Vec::new(),
            cur: Vec::new(),
            changed: Vec::new(),
        }
    }

    /// Recomputes the overlay's current effective tile list and diffs it against the list from
    /// the previous call: a position whose value differs (added, removed, or changed) lands in
    /// [`Self::tiles`]. Called once per replay (`ClientCore::on_action`'s own initial predict, and
    /// once more at the end of `ClientCore::on_frame`'s reconcile tail) -- "after each replay"
    /// (Planning decisions, verbatim).
    pub fn update<G: Game>(&mut self, overlay: &Overlay<G>) {
        self.cur.clear();
        overlay.effective_tiles(&mut |pos, tile| self.cur.push((pos, tile)));
        self.changed.clear();
        for &(pos, tile) in &self.cur {
            let unchanged = self.prev.iter().any(|&(p, t)| p == pos && t == tile);
            if !unchanged {
                self.changed.push(pos);
            }
        }
        for &(pos, _) in &self.prev {
            let still_present = self.cur.iter().any(|&(p, _)| p == pos);
            if !still_present {
                self.changed.push(pos);
            }
        }
        std::mem::swap(&mut self.prev, &mut self.cur);
    }

    /// Every tile position whose effective overlay value changed since the previous
    /// [`Self::update`] call (added, removed, or overwritten with a different value).
    pub fn tiles(&self) -> &[TilePos] {
        &self.changed
    }
}

impl Default for OverlayDiff {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::world::{PrototypeId, Registry};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct DEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct DPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct DGlobal;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct DReject;
    impl From<Unknown> for DReject {
        fn from(_: Unknown) -> Self {
            DReject
        }
    }
    struct DGen;
    impl Worldgen for DGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct DGame;
    impl Game for DGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = DGen;
        type Action = ();
        type Reject = DReject;
        type Entity = DEntity;
        type Player = DPlayer;
        type Global = DGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &DEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &DEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), DReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }
    #[test]
    fn overlay_diff_empty_when_unchanged() {
        let mut overlay = Overlay::<DGame>::new();
        overlay.push_tile(TilePos::new(1, 1), Tile::new(5, 0, 0));
        let mut diff = OverlayDiff::new();
        diff.update(&overlay);
        assert_eq!(
            diff.tiles(),
            &[TilePos::new(1, 1)],
            "first update: everything is new"
        );

        // Same overlay content again (a replay with nothing new): no change.
        diff.update(&overlay);
        assert_eq!(
            diff.tiles(),
            &[] as &[TilePos],
            "unchanged replay: nothing changed"
        );
    }

    #[test]
    fn overlay_diff_detects_added_changed_and_removed() {
        let mut overlay = Overlay::<DGame>::new();
        overlay.push_tile(TilePos::new(1, 1), Tile::new(5, 0, 0));
        overlay.push_tile(TilePos::new(2, 2), Tile::new(6, 0, 0));
        let mut diff = OverlayDiff::new();
        diff.update(&overlay);
        let mut first = diff.tiles().to_vec();
        first.sort();
        assert_eq!(first, vec![TilePos::new(1, 1), TilePos::new(2, 2)]);

        // (1,1) changes value; (2,2) is gone (rolled back, e.g. a reject); (3,3) is new.
        overlay.clear();
        overlay.push_tile(TilePos::new(1, 1), Tile::new(9, 0, 0));
        overlay.push_tile(TilePos::new(3, 3), Tile::new(7, 0, 0));
        diff.update(&overlay);
        let mut second = diff.tiles().to_vec();
        second.sort();
        assert_eq!(
            second,
            vec![TilePos::new(1, 1), TilePos::new(2, 2), TilePos::new(3, 3)]
        );
    }
}
