# Deferred-items ledger

Every row of `PRE-PLAN.md` §10 (same order), with where Phase 2 settled it. **Decided** = the rationale is in the named brief's *Planning decisions* section or the named ADR. **Owned** = needs code or a device; the named milestone carries the question as an exit criterion. Nothing is unowned.

| Item (`PRE-PLAN.md` §10) | Outcome | Where |
|---|---|---|
| Typed fast path + quantized deltas for continuous action streams | Decided: not built, not scheduled; uplink flag bits kept free | M14 |
| Presence as an optional replay track | Decided: not built | M19 |
| Determinism on real x86-64, physical iPhone, Android | Owned: x86-64 in CI; phones via the determinism page | M10; M03 device check |
| `+simd128` and `wasm-opt` for the sim module | Owned: both stay off until measured against the goldens | M36b |
| Provisional ids for predicted entities | Decided | ADR 0022 (implemented in M25) |
| Taint rule after a `NotPredictable` pending action | Owned: three candidate rules run against fixed scenarios; the selection rule is fixed in the brief | M25 |
| Per-action growth declaration | Decided | ADR 0023 (implemented in M21) |
| Per-frame overlay change list + `predicted` flag | Decided: tile-only `OverlayDiff` into the dirty-chunk set; `FrameView::is_predicted` / `predicted_tiles` | M26 |
| Host-side atomicity of `apply` via an undo journal | Owned: built and benchmarked; adopt at ≤ 10 % `apply` overhead and zero steady-state allocation; ADR either way | M21b |
| Own-timer completion gap of one RTT | Owned: measured; default UX rule is to stretch the bar over `duration + lead` (question Q10) | M26; feel check at M34 |
| Lead estimation; iterating reads; `entity(id)` gone vs unsubscribed | Decided: median of the last 8 per-ack samples; `WorldRead::entities_in` in ascending id order; ADR 0022 §7 | M26; M21 + M25; ADR 0022 |
| Exact `TickCx`, `FrameCx`, `FrameView`, `OldStore` shapes | Decided | `TickCx`: M12b (completed in M21b); `FrameView`: M17; `FrameCx`: M18; `OldStore`: M24b |
| Final check of reference-game coverage against the engine feature list | Decided: table written; uncovered features get fixture tests; one addition proposed (R3) | `docs/plan/reference-coverage.md` |
| OPFS append/flush latency on iOS Safari | Owned: thresholds that retune the sync interval are fixed in the brief | M23 device check |
| Helper that rescales `Tick`/`Ticks` fields during `migrate` | Decided: `Rescale` + hand-implemented `RescaleTicks`; engine timers rescale automatically | M24b |
| Entity store layout and `EntityId` reuse policy | Decided | ADR 0022 (implemented in M12) |
| Overlay promotion to dense at 512 entries; bucketed per-chunk area effects | Decided: neither is built in Phase 3; promotion is a representation-only change with M36's memory high-water mark as its trigger; area effects need an ADR from the game that wants them | M07 |
| On-device validation of the 64 MiB world-budget split | Owned: `memory_bytes()` in M07, init-time sum in M21, high-water assertion in M36, device run in M39 | M07 → M39 |
| ms per chunk on a real iPhone and mid-range Android | Owned: `worldgen-bench.html`; thresholds that rescale the warn level or reopen the gen-worker count are in the brief | M08 device check |
| Sampled pristine-hash check between client and server | Decided: none; a dev-build assertion compares gen-worker output with local generation; the `Hashes` section stays extensible | M08, M31b |
| Whether noise helpers move into the engine crate | Decided: yes, `engine::noise`, f64 only | M08 |
| Durable Object adapter and feasibility check | Owned: recipe package + go/no-go rule fixed in advance; ADR from the result | M38 |
| WebTransport adapter | Decided: not built; revisit when Node LTS or workerd ships a stable server and the iOS floor has it, or when stalls exceed the interpolation cap | M27 |
| Real frame sizes against the bandwidth budget | Owned: counters in M15, asserted against `budgets.json` in M31, reference-game measurement in M36b | M15 → M31 → M36b |
| Engine-side byte diffing of old vs new values | Owned: measured on the busy furnace field; build only at ≥ 40 % saving (would be a new milestone `36c`) | M36b |
| Exact section ids, varint coordinate coding, overlay run format | Owned: fixed by the encoder and its golden bytes | M14 |
| "Copy my player link" identity escape hatch | Decided: not built; the invite-fragment parser ignores unknown parameters so it can be added | M28 |
| How iOS Safari reports a worker-owned socket after resume | Owned: on-page link log; tunes only 0013's dead timeout and probe deadline | M29 device check |
| Final export list per role, region ids and sizes, status codes | Decided: initial list in M02; single owner is `crates/engine/src/abi/registry.rs` mirrored by `src/abi.ts`, with an `ABI_VERSION` bump and the `abi-registry` test; each milestone adds its own exports there | M02 |
| Where `engine.log` text is decoded | Decided: in the instance's own isolate, by the loader (`LoaderHooks.onLog`) | M02 |
| On-device memory ceilings | Owned: memory page with arena-size URL parameters as the fallback | M11 device check |
| Ring capacities, uplink poll period, control-block layout, `yield` protocol | Decided | M06 (capacities, control block), M06b (`yield`), M29 implements the 10 ms uplink poll |
| Verifying COOP/COEP listings on one real static host | Owned: Cloudflare Pages | M38 |
| Whether the periodic snapshot `write` is inside the strict zero-GC window | Owned: inside if the sim worker meets its 0016 §1 budget with one forced snapshot in the window; otherwise a budgeted event with a superseding ADR | M23 |
| Final main-thread B/frame number and overlay-anchoring string constant | Owned | M17 (`gc.pages.drawables`), M18 (`gc.pages.anchors`) |
| Software-adapter form of assertion B | Owned: mechanism (`GC_MODE=software`) in M04, numbers in M10 | M04, M10 |
| Packaging-spike untested items (`server.fs.allow`, recursive `fs.watch`, posted `Module` in real Safari, `ts-rs` zero bytes) | Owned | M02b (config-level + touch test), M10 (Linux watch), M11 device check (Safari), M35 (`link:` tarball cell, `ts_rs` symbol check). Windows `fs.watch`: unclaimed by design, no Windows target in Phase 3 |
| Whether `crates/` holds one crate or several | Decided: one crate `engine`; three named triggers for a split, any split needs an ADR | M01 |
| Real release build time and size; intermediate profile; `debug = "line-tables-only"`; snapshot → reload → restore on Rust edit | Owned / decided: build numbers and profile choices in M35 (ADR "Build profiles, measured"); restore-on-edit is not built, one slow test shows the 0005 upgrade path covers it | M35, M37 |
| Zero-GC harness shape run by hand in Safari and Firefox | Owned | M17b device check (desktop) |
| Terrain shader fill-rate on real phones | Owned: fallback order fixed in the brief | M09b device check |
| Exact WGSL, manifest JSON schema, upload-ring record layout, worker frame clock | Decided | M09 (bind groups, `tiles.json` v1, upload record), M17b (`sprites.json` v1), M06b (frame clock) |
| Overlay anchoring on iOS Safari | Owned: fallback `anchorMode=translate` | M18 device check |
| "Follow with user offset" | Decided: not in v1 | M11 |
| Input-ring record layout, easing curves, wheel constants, `FrameCx` shape | Decided | M11, M18 |
| Spike B: SwiftShader WebGPU on `ubuntu-latest` | Owned: four ordered fallbacks | M10 |
| Spike C: byte-identical traces over loopback `ws` | Owned | M29 |
| Measuring the 30 s rebuild and per-suite numbers; sccache vs shared `CARGO_TARGET_DIR` | Owned: numbers recorded by each harness milestone, final table and decision in M36b; neither cache tool until one of M02's triggers fires | M02 → M36b |

## Gaps listed under the table in `PRE-PLAN.md` §10

| Gap | Outcome | Where |
|---|---|---|
| `createClient` option selecting single-player vs a server URL | Decided: `host: { kind: 'local', world } \| { kind: 'remote', url, joinKey? }` | M06b (M29 adds `remote`) |
| How `client.input` events and the input ring surface inside `FrameCx` | Decided: the slice `cx.input()`; TS → `ClientSide` via `client.input.emit` | M18, ADR 0024 §7 |
| How the main thread learns `Welcome.last_processed_action_seq` | Decided: `seq_seed` in the `SabSet.clockBlock` layout | M16 (M28 switches the source to `Welcome`) |
| Whether `dispatch` before `Welcome` queues or fails | Decided: throws; `client.ready` waits for a live session | M16 |
| The `TileTexel::from_tables` registration call | Decided: `Registry::set_base_visual` / `set_resource_visual` | M09 |
| Where test files live | Decided: per package; goldens with their fixture | M01 |
