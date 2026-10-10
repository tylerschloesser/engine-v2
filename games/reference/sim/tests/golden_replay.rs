//! `golden_replay` (M34b Tests added): the full-game
//! golden log (`games/reference/tests/golden/full-game.log`, recorded by `pnpm --filter reference
//! golden:record` from the `.wasm` run, 0002 section 1) replayed natively with `engine::testing::
//! replay`; every checkpoint hash in `full-game.json` must match, and a mismatch names the first
//! divergent tick. The same bytes and hashes are replayed under Node, Bun and in the browsers.

use engine::sim::WorldParams;
use engine::testing::replay::{Base, replay};
use engine::time::Tick;
use reference_sim::{RefGame, RefParams};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/golden/");

/// `world.json` as the golden recorded it: the same defaults the host builds a world with
/// (`host/mod.rs`: 262,144 entities, 1,048,576 modified tiles, 4,096 growth).
fn params(seed: u64) -> WorldParams<RefGame> {
    WorldParams {
        seed,
        worldgen: RefParams::default(),
        max_entities: 262_144,
        max_modified_tiles: 1_048_576,
        max_action_growth: 4_096,
    }
}

struct Golden {
    seed: u64,
    checkpoints: Vec<(Tick, String)>,
}

fn read_golden() -> (Golden, Vec<u8>) {
    let json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{GOLDEN}full-game.json")).expect("full-game.json"),
    )
    .expect("full-game.json parses");
    let seed = json["seed"]
        .as_str()
        .expect("seed is text")
        .parse()
        .expect("u64");
    let checkpoints = json["checkpoints"]
        .as_array()
        .expect("checkpoints")
        .iter()
        .map(|c| {
            (
                Tick(c["tick"].as_u64().expect("tick") as u32),
                c["hash"].as_str().expect("hash").to_string(),
            )
        })
        .collect();
    let log = std::fs::read(format!("{GOLDEN}full-game.log")).expect("full-game.log");
    (Golden { seed, checkpoints }, log)
}

/// The first checkpoint where a replay of `log` differs from `want`, as a message.
fn first_divergence(seed: u64, log: &[u8], want: &[(Tick, String)]) -> Option<String> {
    let ticks: Vec<Tick> = want.iter().map(|(t, _)| *t).collect();
    let got = replay(Base::Genesis(params(seed)), log, &ticks);
    for (i, (tick, hash)) in want.iter().enumerate() {
        match got.get(i) {
            None => return Some(format!("first divergent tick {}: never reached", tick.0)),
            Some((t, h)) if *t != *tick || format!("{h:016x}") != *hash => {
                return Some(format!(
                    "first divergent tick {}: got {h:016x}, want {hash}",
                    tick.0
                ));
            }
            Some(_) => {}
        }
    }
    None
}

#[test]
fn golden_replay() {
    let (golden, log) = read_golden();
    assert!(
        golden.checkpoints.len() > 10,
        "the golden holds a checkpoint every 10 ticks"
    );
    if let Some(message) = first_divergence(golden.seed, &log, &golden.checkpoints) {
        panic!("golden_replay: {message}");
    }
}

/// The report itself can fail: one byte of the log flipped moves a hash, and the message names a tick.
#[test]
fn golden_replay_reports_the_first_divergent_tick() {
    let (golden, mut log) = read_golden();
    // The last byte of the first action's frame is its CRC; a bad CRC ends the replay there, so every
    // checkpoint from that frame on is missing and the first one is named.
    let n = log.len();
    log[n / 2] ^= 0x01;
    let message = first_divergence(golden.seed, &log, &golden.checkpoints)
        .expect("a changed log must not replay to the golden");
    assert!(message.contains("first divergent tick"), "{message}");
}

/// Heavy mode at N = 1 (0002 "Heavy mode", 0020 section 5; M36:
/// every tick of the full-game golden log, snapshot and restore into a fresh `Sim`, same hashes as
/// the uninterrupted run. The `.wasm` twin is `heavy-n1 all logs @slow`.
#[test]
fn slow_heavy_full_game_n1() {
    let (golden, log) = read_golden();
    let result = engine::testing::replay::heavy::<RefGame>(params(golden.seed), &log, 1);
    assert!(
        result.is_ok(),
        "heavy mode (N=1) over full-game.log: {result:?}"
    );
}
