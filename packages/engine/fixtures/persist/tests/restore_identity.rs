//! docs/plan/22b-persistence-load-and-fs.md: `sim_restore_end` reports `Status::IdentityMismatch`
//! when a decoded snapshot's own `Identity::build_hash` differs from the running build's own,
//! rather than silently loading it (0005 Upgrades: "if the running identity hash differs ...").
//! Non-scope here (M24b): no migrate path exists, so this is reported, not handled -- proven
//! directly against `Host<Persist>`, native, no ABI/wasm boundary needed for a plain `Instance`
//! trait method call.

use engine::abi::{Instance, RegionLayout, Role, Status};
use engine::host::Host;
use fx_persist::Persist;

fn cfg(build_hash: &str) -> String {
    format!(
        r#"{{"seed":"0x1","params":null,"maxEntities":64,"maxModifiedTiles":64,
        "maxActionGrowth":64,"cacheChunks":4,"buildHash":"{build_hash}"}}"#
    )
}

/// A real `Host<Persist>`, genesis'd under `build_hash`, snapshotted once at tick 0. Returns the
/// whole encoded container.
fn snapshot_bytes(build_hash: &str) -> Vec<u8> {
    let mut layout = RegionLayout::new();
    let mut host = Host::<Persist>::init(Role::Sim, &cfg(build_hash), &mut layout).unwrap();
    assert_eq!(host.sim_genesis(), Status::Ok);
    assert_eq!(host.sim_snapshot_begin(0, 0), Status::Ok);
    let mut out = Vec::new();
    let mut buf = vec![0u8; 4096];
    loop {
        let n = host.sim_snapshot_next(&mut buf).expect("drain");
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n as usize]);
    }
    out
}

#[test]
fn restore_rejects_a_mismatched_identity() {
    let bytes = snapshot_bytes(&"11".repeat(16));

    let mut layout = RegionLayout::new();
    let mut loader = Host::<Persist>::init(Role::Sim, &cfg(&"22".repeat(16)), &mut layout).unwrap();
    assert_eq!(loader.sim_restore_begin(bytes.len() as u32), Status::Ok);
    assert_eq!(loader.sim_restore_push(&bytes), Status::Ok);
    let mut result = [0u8; 8];
    assert_eq!(
        loader.sim_restore_end(&mut result),
        Status::IdentityMismatch
    );
}

#[test]
fn restore_accepts_a_matching_identity() {
    let build_hash = "33".repeat(16);
    let bytes = snapshot_bytes(&build_hash);

    let mut layout = RegionLayout::new();
    let mut loader = Host::<Persist>::init(Role::Sim, &cfg(&build_hash), &mut layout).unwrap();
    assert_eq!(loader.sim_restore_begin(bytes.len() as u32), Status::Ok);
    assert_eq!(loader.sim_restore_push(&bytes), Status::Ok);
    let mut result = [0u8; 8];
    assert_eq!(loader.sim_restore_end(&mut result), Status::Ok);
}
