//! Footprint-straddling delivery, end to end (docs/plan/21-entities-and-timers.md Tests added,
//! "loopback"): a real `Host<Machines>` <-> `ClientCore<Machines>` round trip over real wire bytes
//! (`Loopback`), driving `fx-machines`'s own `Place`/`Move`/`Feed` through the real admit path.

use engine::game::{EntityId, Game, PlayerId, WorldRead};
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile};
use engine::worldgen::Worldgen;
use fx_machines::{Action, Machines, MachinesWorldgen, Pos};

struct GenSource;
impl PristineSource for GenSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        MachinesWorldgen::generate(0, &(), chunk, out);
    }
}

fn dims() -> ChunkDims {
    ChunkDims::new(Machines::CHUNK_BITS)
}

fn params(seed: u64) -> WorldParams<Machines> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    }
}

fn loopback(seed: u64) -> Loopback<Machines> {
    Loopback::new(params(seed))
}

fn add_client(lb: &mut Loopback<Machines>) -> (usize, PlayerId) {
    lb.add_client(0, dims(), Box::new(GenSource), CacheCapacity::Chunks(1024))
}

/// Visible = exactly chunk (0,0) (camera well inside it, minimal half-extent): ring1 (`host::subs`)
/// then covers chunks -1..=1 on both axes, so (1,0) is subscribed and (2,0) is not.
fn camera_visible_only_chunk_0_0() -> CameraReport {
    CameraReport {
        center_x: 10,
        center_y: 10,
        half_w: 1,
        half_h: 1,
        vel_x: 0,
        vel_y: 0,
    }
}

/// Visible = exactly chunk (3,0): ring1 then covers chunks 2..=4 on x, -1..=1 on y, so (2,0) is
/// subscribed and (1,0) -- [`BORDER_ORIGIN`]'s own *anchor* chunk -- is not. Used by the tests that
/// must prove delivery through the non-anchor half of a footprint (the thing anchor-only scope
/// derivation could never do): a camera that instead subscribed the anchor chunk would pass even
/// with the pre-M21 anchor-only behaviour, proving nothing about the widening.
fn camera_visible_only_chunk_3_0() -> CameraReport {
    CameraReport {
        center_x: 100,
        center_y: 10,
        half_w: 1,
        half_h: 1,
        vel_x: 0,
        vel_y: 0,
    }
}

/// A 2x2 footprint anchored at world tile (63, 5): covers (63,5)/(64,5)/(63,6)/(64,6), i.e. chunks
/// (1,0) and (2,0) only (neither y=5 nor y=6 crosses a chunk row boundary) -- and, by construction
/// of the worldgen's water grid (every 8th tile on both axes), none of those four tiles is water.
/// The *anchor* (`Game::anchor` = the min-corner tile) is (63,5), in chunk (1,0).
const BORDER_ORIGIN: Pos = Pos { x: 63, y: 5 };

#[test]
fn border_machine_delivered_once_to_partial_subscriber() {
    // Placed *before* the client ever subscribes to anything, so its arrival is a fresh chunk
    // join (`ChunkSnapshots`, `encode_chunk_snapshot`'s own widened filter) rather than a
    // `ChunkDeltas` update to an already-held chunk -- the two other places this milestone widens
    // together with `Authority`'s scope derivation (module doc comment).
    let mut lb = loopback(1);
    let (idx, who) = add_client(&mut lb);
    lb.step(); // no camera set yet: connects, but subscribes to nothing
    lb.action(
        who,
        Action::Place {
            origin: BORDER_ORIGIN,
        },
    );
    lb.step();

    lb.set_camera(idx, camera_visible_only_chunk_3_0());
    lb.step();
    assert!(!lb.client(idx).view().is_held(ChunkCoord::new(1, 0)));
    assert!(lb.client(idx).view().is_held(ChunkCoord::new(2, 0)));

    let id = EntityId(1);
    let entity = lb
        .client(idx)
        .view()
        .entity(id)
        .expect("a footprint overlapping a subscribed chunk is not Unknown");
    assert_eq!(
        entity.map(|m| m.origin),
        Some(BORDER_ORIGIN),
        "delivered once, through the subscribed half of its footprint"
    );
}

#[test]
fn border_machine_gone_when_last_overlapped_chunk_leaves() {
    let mut lb = loopback(2);
    let (idx, who) = add_client(&mut lb);
    lb.set_camera(idx, camera_visible_only_chunk_3_0());
    lb.step();
    lb.action(
        who,
        Action::Place {
            origin: BORDER_ORIGIN,
        },
    );
    lb.step();
    let id = EntityId(1);
    assert!(lb.client(idx).view().entity(id).unwrap().is_some());

    // Pan far enough that chunk (2,0) -- the only chunk of the footprint this client ever held --
    // falls outside ring3 too, and wait past the unsubscribe hold time (0010: 5 s).
    lb.set_camera(
        idx,
        CameraReport {
            center_x: 100_000,
            center_y: 0,
            half_w: 1,
            half_h: 1,
            vel_x: 0,
            vel_y: 0,
        },
    );
    let hold = Machines::TICK_RATE.secs(5).0;
    for _ in 0..(hold + 2) {
        lb.step();
    }
    assert!(!lb.client(idx).view().is_held(ChunkCoord::new(2, 0)));
    assert_eq!(
        lb.client(idx).view().entity(id),
        Ok(None),
        "the entity must be gone once the last chunk it overlapped for this client is unsubscribed"
    );
}

#[test]
fn replica_traits_at_matches_host() {
    let mut lb = loopback(3);
    let (idx, who) = add_client(&mut lb);
    lb.set_camera(idx, camera_visible_only_chunk_3_0());
    lb.step();
    lb.action(
        who,
        Action::Place {
            origin: BORDER_ORIGIN,
        },
    );
    lb.step();

    // Tile (64, 5): in chunk (2,0), which this client holds -- the non-anchor half of the
    // footprint, the same tile `border_machine_delivered_once_to_partial_subscriber` proves is
    // delivered at all.
    let occupied = engine::world::TilePos::new(64, 5);
    let host_traits = lb
        .host
        .sim()
        .unwrap()
        .authority()
        .traits_at(occupied)
        .expect("the host is always total");
    let replica_traits = lb
        .client(idx)
        .view()
        .traits_at(occupied)
        .expect("this tile's chunk (1,0) is held");
    assert_eq!(host_traits, replica_traits);
    assert!(
        host_traits.contains(fx_machines::NOT_BUILDABLE),
        "the occupant's own prototype traits must carry the bit"
    );
}

#[test]
fn moved_entity_enters_and_leaves_subscription() {
    let mut lb = loopback(4);
    let (idx, who) = add_client(&mut lb);
    lb.set_camera(idx, camera_visible_only_chunk_0_0());
    lb.step();

    // Placed well outside any subscribed chunk (chunk (5,5), far from ring1 of chunk (0,0)).
    lb.action(
        who,
        Action::Place {
            origin: Pos { x: 165, y: 165 },
        },
    );
    lb.step();
    let id = EntityId(1);
    // `entity(id)`'s `Unknown`-vs-`None` distinction for a real id the client has never been told
    // about (0022 §7 decision 7) is explicitly M25's (0022 Consequences: "decision 7 land[s] with
    // prediction"); this milestone's `Store::entity` stays a plain lookup, so an id the replica
    // has never seen is `Ok(None)`, not `Err(Unknown)`.
    assert_eq!(lb.client(idx).view().entity(id), Ok(None));

    // Move it into the subscribed chunk (1,0): one full delivery.
    lb.action(
        who,
        Action::Move {
            at: Pos { x: 165, y: 165 },
            to: BORDER_ORIGIN,
        },
    );
    lb.step();
    assert_eq!(
        lb.client(idx).view().entity(id).unwrap().map(|m| m.origin),
        Some(BORDER_ORIGIN)
    );
    assert_eq!(
        lb.host.region_hash(lb.conn(idx)),
        lb.client(idx).region_hash(),
        "host and replica must agree once the move has been delivered"
    );

    // Move it back out: the client must see it go.
    lb.action(
        who,
        Action::Move {
            at: BORDER_ORIGIN,
            to: Pos { x: 165, y: 165 },
        },
    );
    lb.step();
    assert_eq!(lb.client(idx).view().entity(id), Ok(None));
    assert_eq!(
        lb.host.region_hash(lb.conn(idx)),
        lb.client(idx).region_hash(),
        "host and replica must agree once the move-out has been delivered"
    );
}
