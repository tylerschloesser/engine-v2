//! The native leg of the determinism golden (docs/decisions/0020 §5): the same `Instance` calls
//! with the same input bytes as `tests/support/scenario.ts` makes against the `.wasm`.

use engine::abi::{Instance, RegionLayout, Role, Status};
use fx_hash::HashFixture;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    config: EngineConfig,
    ticks: u32,
    checkpoint_every: u32,
    input: Input,
}

#[derive(serde::Deserialize)]
struct EngineConfig {
    game: serde_json::Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    every_ticks: u32,
    bytes: usize,
}

#[test]
fn scenario_matches_golden() {
    let fixture_dir = env!("CARGO_MANIFEST_DIR");
    let text = std::fs::read_to_string(format!("{fixture_dir}/golden/scenario.json")).unwrap();
    let scenario: Scenario = serde_json::from_str(&text).unwrap();
    let game = serde_json::to_string(&scenario.config.game).unwrap();

    let mut layout = RegionLayout::new();
    let mut inst = HashFixture::init(Role::Sim, &game, &mut layout).unwrap();
    let mut input = vec![0u8; scenario.input.bytes];
    let mut checkpoints = Vec::new();
    for t in 1..=scenario.ticks {
        if t % scenario.input.every_ticks == 0 {
            for (i, byte) in input.iter_mut().enumerate() {
                *byte = ((t * 31 + i as u32 * 17 + (t >> 3)) & 0xff) as u8;
            }
            assert_eq!(inst.sim_admit(0, &input), Status::Ok);
        }
        assert_eq!(inst.sim_tick(), Status::Ok);
        if t % scenario.checkpoint_every == 0 {
            checkpoints.push(inst.sim_hash());
        }
    }
    engine::testing::assert_golden(fixture_dir, &checkpoints);
}
