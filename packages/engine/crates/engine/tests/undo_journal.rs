//! `journal_rolls_back_store_indexes_wakes_counts` (docs/plan/21b-timers-wakeups-and-tickcx.md
//! Tests added): the undo-journal experiment's own rollback, driven directly against `Authority`
//! (bypassing `Sim::step`'s panic-vs-adopt branch through `Authority::{begin_apply_journal_for_
//! test, rollback_apply_journal_for_test}`, feature `testing`) so this test is independent of
//! `UNDO_JOURNAL_ADOPTED`'s own value (Deviations records the measured decision).

use engine::authority::Authority;
use engine::game::{Game, PlayerEvent, PlayerId, Unknown};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, Footprint, PristineSource, PrototypeId, Registry, Tile,
    TilePos, TraitSet,
};
use engine::world_access::{WorldRead, WorldWrite};
use engine::worldgen::Worldgen;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct JEntity {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct JPlayer {
    score: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct JGlobal {
    n: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct JReject;
impl From<Unknown> for JReject {
    fn from(_: Unknown) -> Self {
        JReject
    }
}

struct JGen;
impl Worldgen for JGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

struct JGame;
impl Game for JGame {
    const SCHEMA_VERSION: u32 = 1;
    const CHUNK_BITS: u32 = 4; // edge 16: a 2x2 footprint near a multiple of 16 straddles chunks.
    type Worldgen = JGen;
    type Action = ();
    type Reject = JReject;
    type Entity = JEntity;
    type Player = JPlayer;
    type Global = JGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 2, h: 2 });
    }
    fn prototype(_e: &JEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(e: &JEntity) -> TilePos {
        TilePos::new(e.x, e.y)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), JReject> {
        Ok(())
    }
    fn tick(_cx: &mut engine::game::TickCx<'_, Self>) {}
}

struct ZeroSource;
impl PristineSource for ZeroSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

fn authority() -> Authority<JGame> {
    let terrain = engine::world::TerrainStore::new(
        ChunkDims::new(JGame::CHUNK_BITS),
        Box::new(ZeroSource),
        CacheCapacity::Chunks(8),
    );
    Authority::new(terrain, JGlobal::default(), 1)
}

#[test]
fn journal_rolls_back_store_indexes_wakes_counts() {
    let mut a = authority();

    // A baseline the "misbehaving apply" below will disturb.
    a.set_tile(TilePos::new(5, 5), Tile::new(2, 0, 0));
    let existing_id = a.spawn(JEntity { x: 14, y: 14 }); // straddles 4 chunks at CHUNK_BITS=4
    a.put_player(PlayerId(1), JPlayer { score: 1 });
    a.put_global(JGlobal { n: 1 });
    a.clear_changes(); // the baseline is now "before" for every purpose below.

    let before_tile = a.tile(TilePos::new(5, 5)).unwrap();
    let before_entity = a.entity(existing_id).map(|o| o.copied());
    let before_player = *a.player(PlayerId(1)).unwrap();
    let before_global = *a.global();
    let before_entity_count = a.store().entity_count();
    let before_tile_count = a.store().modified_tile_count();
    let before_changes = a.changes().len();
    let before_wake_next = a.store().wake_next_len();

    // A deliberately misbehaving "apply" (0003's own rule is "validate first, write after"; this
    // is exactly the violation the journal exists to undo instead of merely asserting against):
    // overwrites the tile, moves the existing entity (old chunk cleared, new chunk added --
    // `ChunkIndex`, plus an auto-wake push since this is an `Authority`-side put outside `G::tick`),
    // then despawns that same, just-moved entity, spawns a brand new one, and overwrites the
    // player and the global.
    a.begin_apply_journal_for_test();
    a.set_tile(TilePos::new(5, 5), Tile::new(9, 0, 0));
    a.put_entity(existing_id, JEntity { x: 100, y: 100 });
    a.despawn(existing_id);
    let new_id = a.spawn(JEntity { x: 99, y: 99 });
    a.put_player(PlayerId(1), JPlayer { score: 99 });
    a.put_global(JGlobal { n: 99 });

    a.rollback_apply_journal_for_test(before_changes);

    // Store.
    assert_eq!(a.tile(TilePos::new(5, 5)).unwrap(), before_tile);
    assert_eq!(
        a.entity(existing_id).map(|o| o.copied()),
        before_entity,
        "the moved-then-despawned entity is restored"
    );
    assert_eq!(
        a.entity(new_id),
        Ok(None),
        "the freshly spawned entity is gone"
    );
    assert_eq!(*a.player(PlayerId(1)).unwrap(), before_player);
    assert_eq!(*a.global(), before_global);

    // Indexes (`ChunkIndex`, derived from the entity table): the restored entity is found at its
    // original position again, and nowhere it was only ever moved to during the rolled-back apply.
    assert_eq!(a.entity_at(TilePos::new(14, 14)), Ok(Some(existing_id)));
    assert_eq!(a.entity_at(TilePos::new(100, 100)), Ok(None));
    assert_eq!(a.entity_at(TilePos::new(99, 99)), Ok(None));

    // Wakes: the move's own auto-wake push must not survive the rollback.
    assert_eq!(a.store().wake_next_len(), before_wake_next);

    // Counts.
    assert_eq!(a.store().entity_count(), before_entity_count);
    assert_eq!(a.store().modified_tile_count(), before_tile_count);

    // The `ChangeLog` itself: no trace of the rolled-back writes reaches a client as deltas.
    assert_eq!(a.changes().len(), before_changes);

    assert_eq!(a.apply_rollbacks(), 1);
}
