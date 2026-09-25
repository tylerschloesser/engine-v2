//! `journal_rolls_back_store_indexes_wakes_counts` (docs/plan/21b-timers-wakeups-and-tickcx.md
//! Tests added): the undo-journal experiment's own rollback, driven directly against `Authority`
//! (bypassing `Sim::step`'s panic-vs-adopt branch through `Authority::{begin_apply_journal_for_
//! test, rollback_apply_journal_for_test}`, feature `testing`) so this test is independent of
//! `UNDO_JOURNAL_ADOPTED`'s own value (Deviations records the measured decision).

use engine::authority::Authority;
use engine::bytes::ByteSink;
use engine::game::{EntityId, Game, PlayerEvent, PlayerId, Unknown};
use engine::time::Tick;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, Footprint, PristineSource, PrototypeId, Registry,
    SystemId, Tile, TilePos, TraitSet,
};
use engine::world_access::{WorldRead, WorldWrite};
use engine::worldgen::Worldgen;

static JSYS: std::sync::OnceLock<SystemId> = std::sync::OnceLock::new();
fn jsys() -> SystemId {
    *JSYS.get().expect("JGame::register must run first")
}

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
        let _ = JSYS.set(r.system("spin"));
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

/// The shared baseline: a tile, one entity (straddling 4 chunks at `CHUNK_BITS = 4`) carrying both
/// a live timer and active-list membership, a player and a global -- everything a `Store::apply`
/// side effect can reach. `wake_at_for_test`/`activate_for_test` are the test-only, `TickCx`-free
/// way to set this up directly against `Authority` (fix round 1's own extended coverage: the
/// original test never gave `existing_id` a timer or active membership, so its despawn never
/// exercised the two side effects `Store::apply`'s `EntityGone` arm cancels).
fn setup() -> (Authority<JGame>, EntityId) {
    let mut a = authority();
    a.set_tile(TilePos::new(5, 5), Tile::new(2, 0, 0));
    let id = a.spawn(JEntity { x: 14, y: 14 });
    a.put_player(PlayerId(1), JPlayer { score: 1 });
    a.put_global(JGlobal { n: 1 });
    a.wake_at_for_test(id, Tick(50));
    a.activate_for_test(jsys(), id);
    a.clear_changes(); // the baseline is now "before" for every purpose below.
    (a, id)
}

struct VecSink<'a>(&'a mut Vec<u8>);
impl ByteSink for VecSink<'_> {
    fn put(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }
}

fn encoded(a: &Authority<JGame>) -> Vec<u8> {
    let mut buf = Vec::new();
    a.store().encode(&mut VecSink(&mut buf));
    buf
}

#[test]
fn journal_rolls_back_store_indexes_wakes_counts() {
    let (mut a, existing_id) = setup();
    // Never touched by the misbehaving apply at all: the reference every assertion below (and, at
    // the end, the full `state_hash`/`encode` comparison) is checked against.
    let (reference, _) = setup();

    assert_eq!(
        a.store().timers_pending(),
        1,
        "setup's own timer must be live"
    );
    assert_eq!(a.store().active_len(jsys()), 1);
    assert_eq!(a.store().active_at(jsys(), 0), Some(existing_id));

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
    // then despawns that same, just-moved entity (which for real cancels its timer and active-list
    // membership -- `Store::apply`'s own `EntityGone` arm, checked below before any rollback runs),
    // and overwrites the player and the global. Deliberately **no** fresh spawn here (unlike the
    // pre-fix-round-1 version of this test): `next_entity_id` is monotonic and never rolls back
    // (0022 §1 "never reused"), so a rolled-back spawn permanently burns an id and would make the
    // final hash/bytes comparison below fail for a reason that is not a defect --
    // `journal_rollback_of_a_fresh_spawn_burns_the_id`, below, covers that case on its own.
    a.begin_apply_journal_for_test();
    a.set_tile(TilePos::new(5, 5), Tile::new(9, 0, 0));
    a.put_entity(existing_id, JEntity { x: 100, y: 100 });
    a.despawn(existing_id);

    // The despawn's own forward cancellation is real, not something only the journal knows about.
    assert_eq!(a.store().timers_pending(), 0, "despawn cancels the timer");
    assert_eq!(
        a.store().active_at(jsys(), 0),
        None,
        "despawn deactivates every system"
    );

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
    assert_eq!(*a.player(PlayerId(1)).unwrap(), before_player);
    assert_eq!(*a.global(), before_global);

    // Indexes (`ChunkIndex`, derived from the entity table): the restored entity is found at its
    // original position again, and nowhere it was only ever moved to during the rolled-back apply.
    assert_eq!(a.entity_at(TilePos::new(14, 14)), Ok(Some(existing_id)));
    assert_eq!(a.entity_at(TilePos::new(100, 100)), Ok(None));

    // The timer and active-list membership the despawn cancelled for real, above, must be restored
    // -- `active_len` alone would pass even with a still-tombstoned slot (fix round 1's own
    // finding), so this checks `active_at` directly, not only the count.
    assert_eq!(
        a.store().timers_pending(),
        1,
        "the timer must be restored, not merely absent from a count that happens to match"
    );
    assert_eq!(a.store().active_len(jsys()), 1);
    assert_eq!(
        a.store().active_at(jsys(), 0),
        Some(existing_id),
        "restored in its original slot, not tombstoned and not appended as a new entry"
    );

    // Wakes: the move's own auto-wake push must not survive the rollback.
    assert_eq!(a.store().wake_next_len(), before_wake_next);

    // Counts.
    assert_eq!(a.store().entity_count(), before_entity_count);
    assert_eq!(a.store().modified_tile_count(), before_tile_count);

    // The `ChangeLog` itself: no trace of the rolled-back writes reaches a client as deltas.
    assert_eq!(a.changes().len(), before_changes);

    assert_eq!(a.apply_rollbacks(), 1);

    // The one assertion that covers every section at once, present and future (fix round 1): a
    // rolled-back `Authority` must be byte-for-byte and hash-for-hash indistinguishable from one
    // the misbehaving apply never touched.
    assert_eq!(a.store().state_hash(), reference.store().state_hash());
    assert_eq!(encoded(&a), encoded(&reference));
}

/// The one case deliberately excluded from the hash-equality test above: a rolled-back fresh spawn
/// leaves no trace in the entity table, `ChunkIndex` or the counts, but -- correctly, by 0022 §1's
/// own "monotonic and never reused" -- permanently burns the id it allocated, so `next_entity_id`
/// does not revert and a later spawn gets a *new* id, never the rolled-back one.
#[test]
fn journal_rollback_of_a_fresh_spawn_burns_the_id() {
    let (mut a, _existing_id) = setup();
    let before_changes = a.changes().len();
    let before_entity_count = a.store().entity_count();

    a.begin_apply_journal_for_test();
    let new_id = a.spawn(JEntity { x: 99, y: 99 });
    a.rollback_apply_journal_for_test(before_changes);

    assert_eq!(a.entity(new_id), Ok(None), "the entity itself is gone");
    assert_eq!(a.entity_at(TilePos::new(99, 99)), Ok(None));
    assert_eq!(a.store().entity_count(), before_entity_count);

    let next_id = a.spawn(JEntity { x: 1, y: 1 });
    assert_ne!(
        next_id, new_id,
        "the burned id is never handed out again (0022 §1)"
    );
}
