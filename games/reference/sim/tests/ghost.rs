//! The placement ghost and construction mode in `RefClient` (docs/plan/33-reference-furnace.md
//! steps 4-5): tint from the shared `can_place`, the local-intent channel, `Ui.placing`/`can_build`,
//! and `extract_hash_ghost_and_furnace` (a DrawList golden, 0020 section 6a).

use std::collections::BTreeMap;

use engine::client::drawlist::{HEADER_BYTES, KIND_GHOST, REGION_BYTES, hash_region};
use engine::client::input::kind;
use engine::client::{
    ANCHOR_CURSOR_TILE, ClientSide, DrawList, FrameView, InputEvent, RemotePresences,
};
use engine::game::{EntityId, Game as _, PlayerId, Unknown, WorldRead};
use engine::testing::assert_golden_hash;
use engine::world::{Registry, Tile, TilePos, TileRect, TraitSet};
use reference_sim::content::{self, ItemId};
use reference_sim::{Furnace, RefClient, RefEntity, RefGame, RefPlayer, RefUi, TileXY};

/// Terrain from a closure; traits from the game's own registry (so the real `NOT_BUILDABLE` bits).
struct World<'a> {
    registry: &'a Registry,
    tile: fn(TilePos) -> Result<Tile, Unknown>,
    player: RefPlayer,
}

impl WorldRead<RefGame> for World<'_> {
    fn tick(&self) -> engine::time::Tick {
        engine::time::Tick(0)
    }
    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        (self.tile)(p)
    }
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        Ok(self.registry.tile_traits(self.tile(p)?))
    }
    fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
        Ok(None)
    }
    fn entity(&self, _id: EntityId) -> Result<Option<&RefEntity>, Unknown> {
        Ok(None)
    }
    fn player(&self, _who: PlayerId) -> Result<&RefPlayer, Unknown> {
        Ok(&self.player)
    }
    fn global(&self) -> &reference_sim::RefGlobal {
        &reference_sim::RefGlobal
    }
    fn entities_in(
        &self,
        _rect: TileRect,
        _f: &mut dyn FnMut(EntityId, &RefEntity),
    ) -> Result<(), Unknown> {
        Ok(())
    }
}

fn grass(_: TilePos) -> Result<Tile, Unknown> {
    Ok(Tile::new(content::GRASS, 0, 0))
}
/// Water at x >= 7, grass elsewhere.
fn shore(p: TilePos) -> Result<Tile, Unknown> {
    Ok(Tile::new(
        if p.x >= 7 {
            content::WATER
        } else {
            content::GRASS
        },
        0,
        0,
    ))
}
/// Unreadable at x >= 7 (the subscription edge).
fn edge(p: TilePos) -> Result<Tile, Unknown> {
    if p.x >= 7 { Err(Unknown) } else { grass(p) }
}

fn registry() -> Registry {
    let mut r = Registry::new();
    RefGame::register(&mut r);
    r
}

/// `(flags, pos, size, color)` of a ghost record.
type GhostRec = (u8, [f32; 2], [f32; 2], u32);

/// Every ghost record after one `extract`, with the record count and region hash.
fn ghosts(
    client: &RefClient,
    world: &World<'_>,
    registry: &Registry,
    entities: &BTreeMap<EntityId, Furnace>,
    cursor: Option<TilePos>,
) -> (u32, Vec<GhostRec>, u64) {
    let remote = RemotePresences::<RefGame>::new();
    let view = FrameView::new(
        world as &dyn WorldRead<RefGame>,
        Default::default(),
        PlayerId(1),
        entities,
        registry,
        TileRect::new(TilePos::new(-10, -10), TilePos::new(10, 10)),
        20.0,
        40.0,
        cursor,
        TilePos::new(0, 0),
        0.0,
        reference_sim::PlayerPresence::default(),
        &remote,
    );
    let mut out = DrawList::new();
    out.begin_frame(TilePos::new(0, 0));
    client.extract(&view, &mut out);
    let mut region = vec![0u8; REGION_BYTES];
    let n = out.sort_into(&mut region, 0.0, None);
    let f = |b: &[u8], o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let mut found = Vec::new();
    for i in 0..n as usize {
        let r = &region[HEADER_BYTES + i * 32..HEADER_BYTES + (i + 1) * 32];
        if u16::from_le_bytes([r[16], r[17]]) >> 12 == KIND_GHOST {
            let color = u32::from_le_bytes(r[20..24].try_into().unwrap());
            found.push((r[19], [f(r, 0), f(r, 4)], [f(r, 8), f(r, 12)], color));
        }
    }
    (n, found, hash_region(&region, n))
}

fn placing_client() -> RefClient {
    let mut c = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    c.apply_local(&game_event(content::local::PLACE_MODE, 1));
    c
}

fn game_event(code: u32, a: i32) -> InputEvent {
    InputEvent {
        kind: kind::GAME,
        pick_id: code,
        tile: [a, 0],
        ..InputEvent::default()
    }
}

fn world<'a>(r: &'a Registry, tile: fn(TilePos) -> Result<Tile, Unknown>) -> World<'a> {
    World {
        registry: r,
        tile,
        player: RefPlayer::default(),
    }
}

/// Valid over grass, invalid when any footprint tile is water, neutral at the subscription edge:
/// three distinct colours from the one shared rule. Fails if the tint ignores `can_place`, or
/// collapses `Unknown` into either verdict.
#[test]
fn ghost_tint_follows_can_place() {
    let r = registry();
    let none = BTreeMap::new();
    let c = placing_client();

    let (_, ok, _) = ghosts(&c, &world(&r, grass), &r, &none, Some(TilePos::new(2, 2)));
    let (_, bad, _) = ghosts(&c, &world(&r, shore), &r, &none, Some(TilePos::new(6, 2)));
    let (_, unk, _) = ghosts(&c, &world(&r, edge), &r, &none, Some(TilePos::new(6, 2)));
    assert_eq!((ok.len(), bad.len(), unk.len()), (1, 1, 1));
    let colors = [ok[0].3, bad[0].3, unk[0].3];
    assert_eq!(colors, [0x40ff_4090, 0xff40_4090, 0xc0c0_c090]);

    // Anchored to the cursor tile, 2x2, centred at (1, 1) relative to its min corner.
    assert_eq!(ok[0].0 & ANCHOR_CURSOR_TILE, ANCHOR_CURSOR_TILE);
    assert_eq!(ok[0].1, [1.0, 1.0]);
    assert_eq!(ok[0].2, [2.0, 2.0]);
    // Only the far column of the footprint is water: still invalid (origin (6, 2) covers x = 6, 7).
    let (_, edge_water, _) = ghosts(&c, &world(&r, shore), &r, &none, Some(TilePos::new(5, 2)));
    assert_eq!(
        edge_water[0].3, 0x40ff_4090,
        "origin (5,2) covers x = 5, 6: all grass"
    );
}

/// No ghost outside construction mode or without a cursor tile; `PLACE_MODE` with `a = 0` turns it
/// off again; an unrelated game code is ignored. Fails if `apply_local` ignores the code or `a`.
#[test]
fn place_mode_event_toggles_the_ghost() {
    let r = registry();
    let none = BTreeMap::new();
    let w = world(&r, grass);
    let cursor = Some(TilePos::new(2, 2));

    let mut c = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    assert!(
        ghosts(&c, &w, &r, &none, cursor).1.is_empty(),
        "off by default"
    );
    c.apply_local(&game_event(content::local::CLOSE_PANEL, 1));
    assert!(
        !c.placing(),
        "another code does not switch construction mode"
    );
    c.apply_local(&game_event(content::local::PLACE_MODE, 1));
    assert!(c.placing());
    assert_eq!(ghosts(&c, &w, &r, &none, cursor).1.len(), 1);
    assert!(
        ghosts(&c, &w, &r, &none, None).1.is_empty(),
        "no cursor tile, no ghost"
    );
    c.apply_local(&game_event(content::local::PLACE_MODE, 0));
    assert!(ghosts(&c, &w, &r, &none, cursor).1.is_empty(), "off again");
    // A tap-kind record with the same numbers is not a game event.
    c.apply_local(&InputEvent {
        kind: kind::TAP,
        pick_id: content::local::PLACE_MODE,
        tile: [1, 0],
        ..InputEvent::default()
    });
    assert!(!c.placing());
}

/// `Ui.placing` mirrors the local flag and `Ui.can_build` the inventory; both are `false` otherwise.
#[test]
fn ui_reports_placing_and_can_build() {
    let r = registry();
    let none = BTreeMap::new();
    let remote = RemotePresences::<RefGame>::new();
    let ui_of = |c: &RefClient, items: u32| {
        let mut player = RefPlayer::default();
        player.inventory.add(ItemId::Furnace, items);
        let w = World {
            registry: &r,
            tile: grass,
            player,
        };
        let view = FrameView::new(
            &w as &dyn WorldRead<RefGame>,
            Default::default(),
            PlayerId(1),
            &none,
            &r,
            TileRect::new(TilePos::new(-10, -10), TilePos::new(10, 10)),
            20.0,
            40.0,
            None,
            TilePos::new(0, 0),
            0.0,
            reference_sim::PlayerPresence::default(),
            &remote,
        );
        let mut ui = RefUi::default();
        c.ui(&view, &mut ui);
        (ui.placing, ui.can_build)
    };
    let mut c = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    assert_eq!(ui_of(&c, 0), (false, false));
    assert_eq!(ui_of(&c, 2), (false, true));
    c.apply_local(&game_event(content::local::PLACE_MODE, 1));
    assert_eq!(ui_of(&c, 1), (true, true));
}

/// One furnace sprite plus the ghost, hashed (a native byte-format golden, like
/// `extract_hash_player_circle`).
#[test]
fn extract_hash_ghost_and_furnace() {
    let r = registry();
    let mut entities = BTreeMap::new();
    entities.insert(EntityId(1), Furnace::new(TileXY { x: -3, y: 4 }));
    let c = placing_client();
    let (n, found, hash) = ghosts(
        &c,
        &world(&r, grass),
        &r,
        &entities,
        Some(TilePos::new(2, 2)),
    );
    assert_eq!(n, 4, "furnace sprite + ghost + player circle + ring");
    assert_eq!(found.len(), 1);
    assert_golden_hash!("extract_hash_ghost_and_furnace", hash);
}

fn cursor_view<'a>(
    w: &'a World<'a>,
    entities: &'a BTreeMap<EntityId, Furnace>,
    registry: &'a Registry,
    remote: &'a RemotePresences<RefGame>,
) -> FrameView<'a, RefGame> {
    FrameView::new(
        w as &dyn WorldRead<RefGame>,
        Default::default(),
        PlayerId(1),
        entities,
        registry,
        TileRect::new(TilePos::new(-10, -10), TilePos::new(10, 10)),
        20.0,
        40.0,
        Some(TilePos::new(2, 2)),
        TilePos::new(0, 0),
        0.0,
        reference_sim::PlayerPresence::default(),
        remote,
    )
}

/// Construction mode ends by itself once the inventory holds no furnace (no DOM "off" needed), and
/// stays off for the next frame's ghost. Fails if `ui` leaves `placing` on with nothing to place.
#[test]
fn placing_ends_when_the_last_furnace_is_gone() {
    let r = registry();
    let none = BTreeMap::new();
    let remote = RemotePresences::<RefGame>::new();
    let c = placing_client();
    let mut player = RefPlayer::default();
    player.inventory.add(ItemId::Furnace, 1);
    let mut w = World {
        registry: &r,
        tile: grass,
        player,
    };
    let mut ui = RefUi::default();
    c.ui(&cursor_view(&w, &none, &r, &remote), &mut ui);
    assert!(ui.placing && c.placing(), "still has the item");
    w.player = RefPlayer::default(); // the host took the item
    c.ui(&cursor_view(&w, &none, &r, &remote), &mut ui);
    assert!(!ui.placing && !c.placing(), "nothing left to place");
    let mut out = DrawList::new();
    out.begin_frame(TilePos::new(0, 0));
    c.extract(&cursor_view(&w, &none, &r, &remote), &mut out);
    let mut region = vec![0u8; REGION_BYTES];
    let n = out.sort_into(&mut region, 0.0, None);
    assert_eq!(n, 2, "circle + ring only, no ghost");
}
