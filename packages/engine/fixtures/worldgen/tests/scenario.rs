//! The native leg of the worldgen determinism golden (docs/decisions/0020 §5): the same
//! `gen_chunk` calls, over the same chunk list, as `tests/support/scenario.ts`'s worldgen branch
//! makes against the `.wasm`.

use engine::abi::{Instance, RegionId, RegionLayout, Role, Status};
use engine::hash::Fnv64;
use fx_worldgen::FixtureGen;

const CHECKPOINT_CHUNKS: usize = 64;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    config: EngineConfig,
    chunks: Vec<(i32, i32)>,
}

#[derive(serde::Deserialize)]
struct EngineConfig {
    game: serde_json::Value,
}

#[test]
fn scenario_matches_golden() {
    let fixture_dir = env!("CARGO_MANIFEST_DIR");
    let text = std::fs::read_to_string(format!("{fixture_dir}/golden/scenario.json")).unwrap();
    let scenario: Scenario = serde_json::from_str(&text).unwrap();
    let game = serde_json::to_string(&scenario.config.game).unwrap();

    let mut layout = RegionLayout::new();
    let mut inst = FixtureGen::init(Role::Gen, &game, &mut layout).unwrap();
    let region_len = layout.len(RegionId::GenOut) as usize;
    let mut out = vec![0u8; region_len];

    let mut checkpoints = Vec::new();
    let mut h = Fnv64::new();
    for (i, &(cx, cy)) in scenario.chunks.iter().enumerate() {
        assert_eq!(inst.gen_chunk(cx, cy, &mut out), Status::Ok);
        h.write(&out);
        if (i + 1) % CHECKPOINT_CHUNKS == 0 {
            checkpoints.push(h.finish());
            h = Fnv64::new();
        }
    }
    engine::testing::assert_golden(fixture_dir, &checkpoints);
}
