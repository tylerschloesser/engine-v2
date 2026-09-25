//! `extract_hash_player_circle` (docs/plan/20b-reference-player-and-collect-ui.md Tests added):
//! a DrawList hash golden (0020 §6a) proving `RefClient::extract` keeps producing the same
//! `circle` + `ring` bytes for a fixed spring position -- a native byte-format golden distinct
//! from `pnpm golden`'s cross-runtime scenario kind (this crate has no ABI-facing driver for it
//! yet, same note as `worldgen_golden`).
//!
//! Built directly against `FrameView::new` (a public constructor, 0003) with a stub `WorldRead`,
//! never against `FrameCx` (`FrameCx::new` is `pub(crate)` to the engine crate, so no game crate
//! can build one -- `RefClient::with_spring_state` sidesteps needing one at all by seeding the
//! spring's settled state directly).

use engine::client::drawlist::{REGION_BYTES, hash_region};
use engine::client::{ClientSide, DrawList, FrameView, RemotePresences};
use engine::game::{PlayerId, Unknown, WorldRead};
use engine::testing::assert_golden_hash;
use engine::world::{Registry, Tile, TilePos, TileRect, TraitSet};
use reference_sim::{RefClient, RefGame};

struct StubWorld;

impl WorldRead<RefGame> for StubWorld {
    fn tick(&self) -> engine::time::Tick {
        engine::time::Tick(0)
    }
    fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
        Err(Unknown)
    }
    fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
        Err(Unknown)
    }
    fn entity_at(&self, _p: TilePos) -> Result<Option<engine::game::EntityId>, Unknown> {
        Ok(None)
    }
    fn entity(
        &self,
        _id: engine::game::EntityId,
    ) -> Result<Option<&reference_sim::RefEntity>, Unknown> {
        Ok(None)
    }
    fn player(&self, _who: PlayerId) -> Result<&reference_sim::RefPlayer, Unknown> {
        Err(Unknown)
    }
    fn global(&self) -> &reference_sim::RefGlobal {
        &reference_sim::RefGlobal
    }
    fn entities_in(
        &self,
        _rect: TileRect,
        _f: &mut dyn FnMut(engine::game::EntityId, &reference_sim::RefEntity),
    ) -> Result<(), Unknown> {
        Ok(())
    }
}

#[test]
fn extract_hash_player_circle() {
    // A client settled at a fixed tile position, plus a `px_per_tile` well above the "smaller than
    // 2 px" cull threshold, so both the circle and the ring are drawn.
    let client = RefClient::with_spring_state([12.5, -3.25], [0.0, 0.0]);
    let world = StubWorld;
    let entities = std::collections::BTreeMap::new();
    let registry = Registry::new();
    let remote = RemotePresences::<RefGame>::new();
    let view = FrameView::new(
        &world as &dyn WorldRead<RefGame>,
        Default::default(),
        PlayerId(1),
        &entities,
        &registry,
        TileRect::new(TilePos::new(-10, -10), TilePos::new(10, 10)),
        20.0,
        40.0, // px_per_tile: well above 2px / PLAYER_DIAMETER_TILES.
        None,
        TilePos::new(0, 0),
        0.0,
        reference_sim::PlayerPresence::default(),
        &remote,
    );
    let mut out = DrawList::new();
    out.begin_frame(TilePos::new(0, 0));
    client.extract(&view, &mut out);
    let mut region = vec![0u8; REGION_BYTES];
    let record_count = out.sort_into(&mut region, 0.0, None);
    assert_eq!(record_count, 2, "circle + ring");

    let hash = hash_region(&region, record_count);
    assert_golden_hash!("extract_hash_player_circle", hash);
}
