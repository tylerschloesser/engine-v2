//! Own test binary (mirrors `no_alloc_terrain.rs`/`no_alloc_gen_queue.rs`: a `#[global_allocator]`
//! only counts allocations made inside the binary that installs it, and inline unit tests share
//! the crate's own lib test binary, which installs none). Budget (docs/plan/12-store-and-game-
//! trait.md Budgets): `Store::apply` must not allocate for an existing key with plain-data values.

use engine::abi::Arena;
use engine::delta::Delta;
use engine::game::{EntityId, Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::store::Store;
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
    hp: u32,
    variant: u16,
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
    fn anchor(_e: &NoAllocEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), NoAllocReject> {
        Ok(())
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

#[test]
fn store_apply_existing_key_no_alloc() {
    let terrain = TerrainStore::new(
        ChunkDims::new(4),
        Box::new(ZeroSource),
        CacheCapacity::Chunks(8),
    );
    let mut store: Store<NoAllocGame> = Store::new(terrain, NoAllocGlobal { day: 0 });

    let id = EntityId(1);
    let who = PlayerId(1);
    store.apply(&Delta::EntityPut {
        id,
        entity: NoAllocEntity { hp: 1, variant: 0 },
    });
    store.apply(&Delta::Player {
        who,
        state: NoAllocPlayer { score: 0 },
    });
    // Warm-up: the first put into each map establishes its steady-state node count.
    for i in 0..4u32 {
        store.apply(&Delta::EntityPut {
            id,
            entity: NoAllocEntity { hp: i, variant: 0 },
        });
        store.apply(&Delta::Player {
            who,
            state: NoAllocPlayer { score: i },
        });
    }

    let before = live();
    for i in 0..200u32 {
        store.apply(&Delta::EntityPut {
            id,
            entity: NoAllocEntity {
                hp: i,
                variant: (i % 7) as u16,
            },
        });
        store.apply(&Delta::Player {
            who,
            state: NoAllocPlayer { score: i },
        });
        store.apply(&Delta::Roster {
            who,
            online: i % 2 == 0,
        });
    }
    let after = live();

    assert_eq!(
        after, before,
        "Store::apply must not allocate for an existing key"
    );
    assert_eq!(store.entity_count(), 1);
}
