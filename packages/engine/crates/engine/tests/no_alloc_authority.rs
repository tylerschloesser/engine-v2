//! Own test binary (mirrors `no_alloc_store.rs`: a `#[global_allocator]` only counts allocations
//! made inside the binary that installs it). Budget (docs/plan/12b-world-access-and-sim-driver.md
//! Budgets): `Authority`'s put path (`Store::apply` plus scope derivation and the `ChangeLog`
//! push) must not allocate for an existing key once the `Vec`s involved have reached steady state.

use engine::abi::Arena;
use engine::authority::Authority;
use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, TerrainStore,
    Tile, TilePos,
};
use engine::worldgen::Worldgen;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

struct ZeroSource;
impl PristineSource for ZeroSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NoAllocEntity {
    x: i32,
    y: i32,
    hp: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NoAllocPlayer {
    score: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NoAllocGlobal {
    day: u32,
}

struct NoAllocGen;
impl Worldgen for NoAllocGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct NoAllocReject;
impl From<Unknown> for NoAllocReject {
    fn from(_: Unknown) -> Self {
        NoAllocReject
    }
}

struct NoAllocGame;
impl Game for NoAllocGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = NoAllocGen;
    type Action = ();
    type Reject = NoAllocReject;
    type Entity = NoAllocEntity;
    type Player = NoAllocPlayer;
    type Global = NoAllocGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(_r: &mut Registry) {}
    fn prototype(_e: &NoAllocEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(e: &NoAllocEntity) -> TilePos {
        TilePos::new(e.x, e.y)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), NoAllocReject> {
        Ok(())
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

#[test]
fn authority_put_existing_key_no_alloc() {
    let terrain = TerrainStore::new(
        ChunkDims::new(4),
        Box::new(ZeroSource),
        CacheCapacity::Chunks(8),
    );
    let mut a: Authority<NoAllocGame> = Authority::new(terrain, NoAllocGlobal { day: 0 }, 7);

    let id = a.spawn(NoAllocEntity { x: 1, y: 1, hp: 1 });
    let who = PlayerId(1);
    a.put_player(who, NoAllocPlayer { score: 0 });
    // Warm-up: establish every Vec's (entities, players, changes) steady-state capacity.
    for i in 0..8u32 {
        a.put_entity(id, NoAllocEntity { x: 1, y: 1, hp: i });
        a.put_player(who, NoAllocPlayer { score: i });
        a.clear_changes();
    }

    let before = live();
    for i in 0..200u32 {
        a.put_entity(id, NoAllocEntity { x: 1, y: 1, hp: i });
        a.put_player(who, NoAllocPlayer { score: i });
        a.clear_changes();
    }
    let after = live();

    assert_eq!(
        after, before,
        "Authority's put path must not allocate for an existing key in steady state"
    );
    assert_eq!(a.store().entity_count(), 1);
}
