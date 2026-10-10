//! `extract_hash_remote_players` (M34 Tests added): one own
//! circle (plus its range ring) and two remote circles, one of them faded, drawn from a real
//! `Loopback` round trip (`Global` colours, presences and the roster all arrive over the wire).
//! Checks the records themselves (colour from `Global`, `alpha`, no ring for remotes) and pins the
//! DrawList bytes with a hash golden (0020 section 6a).

use engine::client::drawlist::{HEADER_BYTES, KIND_CIRCLE, KIND_RING, REGION_BYTES, hash_region};
use engine::client::{ClientSide, DrawList};
use engine::game::{Game as _, PlayerId};
use engine::sim::WorldParams;
use engine::testing::assert_golden_hash;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile, TilePos, TileRect,
};
use engine::worldgen::Worldgen;
use reference_sim::client::PlayerPresence;
use reference_sim::{RefClient, RefGame, RefParams, RefWorldgen, content};

struct GenSource;
impl PristineSource for GenSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        RefWorldgen::generate(content::SEED, &RefParams::default(), chunk, out);
    }
}

/// The interpolation render time (host ticks) at which the third player's one old sample is
/// mid-fade (alpha 0.6, found by printing the buffer) while the second's newer one is still full.
const RENDER_T: f64 = 128.0;

fn at(x: i32, y: i32) -> PlayerPresence {
    PlayerPresence {
        pos: [x * 256, y * 256],
        vel: [0, 0],
    }
}

#[test]
fn extract_hash_remote_players() {
    let mut lb = Loopback::new(WorldParams::<RefGame> {
        seed: content::SEED,
        worldgen: RefParams::default(),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    });
    for _ in 0..3 {
        let (i, _) = lb.add_client(
            0,
            ChunkDims::new(RefGame::CHUNK_BITS),
            Box::new(GenSource),
            CacheCapacity::Chunks(1024),
        );
        lb.set_camera(
            i,
            CameraReport {
                center_x: 10,
                center_y: 10,
                half_w: 1,
                half_h: 1,
                vel_x: 0,
                vel_y: 0,
            },
        );
    }
    lb.run(4);
    // Player 3 speaks once; player 2 keeps speaking, so only player 3 has gone quiet by RENDER_T.
    lb.set_presence(1, at(5, 5));
    lb.set_presence(2, at(8, 6));
    lb.run(5);
    for k in 0..4 {
        lb.run(20);
        lb.set_presence(1, at(5 + k, 5));
    }
    lb.run(3);

    let global = lb.global(0);
    let colour = |id: u32| content::colour_of(global.colour(PlayerId(id)));
    assert!(
        (1..=3).all(|id| global.colour(PlayerId(id)) != 0),
        "every joined player has a colour in the client's replica"
    );

    let client = RefClient::with_spring_state([12.5, -3.25], [0.0, 0.0]);
    let view = lb
        .frame_view(
            0,
            TileRect::new(TilePos::new(-20, -20), TilePos::new(40, 40)),
            TilePos::new(0, 0),
        )
        .with_render_time(RENDER_T);
    let mut out = DrawList::new();
    out.begin_frame(TilePos::new(0, 0));
    client.extract(&view, &mut out);
    let mut region = vec![0u8; REGION_BYTES];
    let n = out.sort_into(&mut region, 0.0, None) as usize;

    let mut circles = Vec::new();
    let mut rings = 0;
    for i in 0..n {
        let r = &region[HEADER_BYTES + i * 32..HEADER_BYTES + (i + 1) * 32];
        let kind = u16::from_le_bytes([r[16], r[17]]) >> 12;
        let colour = u32::from_le_bytes(r[20..24].try_into().unwrap());
        if kind == KIND_CIRCLE {
            circles.push(colour);
        } else if kind == KIND_RING {
            rings += 1;
        }
    }
    assert_eq!(rings, 1, "only the own player has a range ring");
    assert_eq!(circles.len(), 3, "own circle plus two remotes");
    let opaque = |c: u32| c | 0xff00_0000;
    let rgb = |c: u32| c & 0x00ff_ffff;
    for id in 1..=3 {
        assert!(
            circles.iter().any(|&c| rgb(c) == rgb(colour(id))),
            "a circle in player {id}'s colour"
        );
    }
    assert!(circles.contains(&opaque(colour(1))), "own circle is opaque");
    assert!(
        circles.contains(&opaque(colour(2))),
        "fresh remote is opaque"
    );
    let faded = circles.iter().find(|&&c| rgb(c) == rgb(colour(3))).unwrap();
    assert_eq!(faded >> 24, 153, "faded remote draws at alpha 0.6");
    let mut distinct = circles.iter().map(|&c| rgb(c)).collect::<Vec<_>>();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(distinct.len(), 3, "three players, three colours");

    assert_golden_hash!(
        "extract_hash_remote_players",
        hash_region(&region, n as u32)
    );
}
