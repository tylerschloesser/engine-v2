//! `fx-busy-field`'s two loads, measured (docs/plan/31-rates-and-integrity.md step 2): the steady
//! field puts at 0010's "200 active machines, twice per 5 s = 80 puts/s", and one filled chunk costs
//! about 0010's "dense chunk ~4 KB" on the wire.

use engine::game::Game;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile, TilePos, TileRect,
};
use engine::worldgen::Worldgen;
use fx_busy_field::{Action, BusyField, BusyWorldgen, CHUNK_ENTITIES, FIELD_MACHINES, Machine};

struct GenSource;
impl PristineSource for GenSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        BusyWorldgen::generate(0, &(), chunk, out);
    }
}

fn params<G: Game>(max_entities: u32) -> WorldParams<G>
where
    G::Worldgen: Worldgen<Params = ()>,
{
    WorldParams {
        seed: 1,
        worldgen: (),
        max_entities,
        max_modified_tiles: 1_000_000,
        max_action_growth: 65_536,
    }
}

fn client<G: Game>(lb: &mut Loopback<G>) -> usize
where
    G::Global: Default,
{
    lb.add_client(
        0,
        ChunkDims::new(BusyField::<false>::CHUNK_BITS),
        Box::new(GenSource),
        CacheCapacity::Chunks(1024),
    )
    .0
}

fn camera(x: i32, y: i32, half: u16) -> CameraReport {
    CameraReport {
        center_x: x,
        center_y: y,
        half_w: half,
        half_h: half,
        vel_x: 0,
        vel_y: 0,
    }
}

/// Sum of every visible machine's `count`: each whole-value put adds exactly 1.
fn total_puts(lb: &Loopback<BusyField<false>>, i: usize) -> u32 {
    let rect = TileRect::new(TilePos::new(-64, -64), TilePos::new(64, 32));
    lb.entities_in(i, rect)
        .iter()
        .map(|(_, m): &(_, Machine)| m.count)
        .sum()
}

#[test]
fn steady_field_puts_80_per_second_at_about_16_bytes() {
    let mut lb = Loopback::<BusyField<false>>::new(params(4096));
    let i = client(&mut lb);
    lb.set_camera(i, camera(30, 14, 40));
    lb.run(60); // every machine has put once and the view is settled
    let (p0, b0) = (total_puts(&lb, i), lb.host.counters(lb.conn(i)).unwrap());
    lb.run(100); // 5 s
    let (p1, b1) = (total_puts(&lb, i), lb.host.counters(lb.conn(i)).unwrap());
    let puts = p1 - p0;
    let bytes = b1.bytes_down - b0.bytes_down;
    assert_eq!(FIELD_MACHINES, 200);
    assert_eq!(puts, 400, "200 machines x 2 puts per 5 s = 80 puts/s");
    // 100 frames of 10 B header plus a 3 B section id and length, then the puts themselves: about
    // 15.4 B each, 0010's "~16 B".
    let per_put = (bytes - 100 * 13) as f64 / puts as f64;
    assert!((14.0..=17.0).contains(&per_put), "{per_put} B per put");
    assert_eq!(bytes, 7_446, "pinned: 5 s of the steady field, one client");
}

#[test]
fn dense_chunk_is_about_4_kb() {
    let mut lb = Loopback::<BusyField<true>>::new(params(40_000));
    let i = client(&mut lb);
    // Visible = chunk (0,0) only; ring 1 makes 9 chunks, every one dense.
    lb.set_camera(i, camera(10, 10, 1));
    lb.step();
    lb.step();
    let c = lb.host.counters(lb.conn(i)).unwrap();
    assert_eq!(c.chunk_snapshots, 9);
    let per_chunk = c.bytes_down as f64 / 9.0;
    assert!(
        (3_500.0..=4_500.0).contains(&per_chunk),
        "a dense chunk is ~4 KB (0010): {per_chunk} B"
    );
    assert_eq!(c.bytes_down, 35_195, "pinned: nine dense chunks, one join");
    assert_eq!(CHUNK_ENTITIES, 200);
}

#[test]
fn fill_action_makes_a_chunk_dense() {
    let mut lb = Loopback::<BusyField<false>>::new(params(4096));
    let i = client(&mut lb);
    let who = engine::game::PlayerId(1);
    lb.set_camera(i, camera(200, 200, 1)); // far from the steady field
    lb.step();
    lb.action(who, Action::Fill { cx: 6, cy: 6 });
    lb.run(3);
    let rect = TileRect::new(TilePos::new(192, 192), TilePos::new(223, 223));
    assert_eq!(lb.entities_in(i, rect).len() as u32, CHUNK_ENTITIES);
}
