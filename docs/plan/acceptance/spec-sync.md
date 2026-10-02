# Acceptance: `docs/spec/sync.md` Requirements

One row per Requirement bullet; bullets 3, 10 and 11 are split into lettered sub-rows. Suites: `rust` covers `crates/engine/{src,tests}` and `fixtures/*/tests`; `netcode` covers `packages/engine/tests/netcode` and `games/reference/tests/netcode`; `wasm` covers `packages/engine/tests/wasm`; `unit` covers `packages/engine/src/**/*.test.ts`.

| # | Item | Evidence | Status |
|---|---|---|---|
| R1 | The sim sends deltas to each client, scoped to that client's viewport | test: rust "subs_ring1_plus_lookahead"; test: rust "view_unknown_outside_subscription"; test: netcode "reference_presence_only_to_subscribers"; test: browser "pan_changes_subscription" | covered |
| R2 | A client-side layer holds displayed state and latest received state, interpolating and predicting so lag is not noticeable | test: rust "predict_placement_is_immediate_and_converges"; test: netcode "interpolation/constant_latency_tracks_path"; test: browser "prediction-no-flicker"; device: M16-round-trip; device: M34-remote-motion | covered |
| R3a | Engine derives deltas from the rules' writes | test: rust "every_put_is_one_delta_with_scope"; test: browser "replica_hash_equals_host_in_browser"; test: netcode "join-converges" | covered |
| R3b | Engine predicts by re-running the same `apply` on the client | test: rust "predict_placement_is_immediate_and_converges"; test: rust "predict_dependent_actions_replay_across_ack"; test: rust "predict_provisional_id_stable_across_replays" | covered |
| R3c | Engine interpolates remote motion | test: rust "interp_hermite_hits_samples_and_is_c1"; test: netcode "interpolation/constant_latency_tracks_path"; test: netcode "interpolation/resting_player_stays_solid" | covered |
| R3d | The game writes no delta types and no separate prediction or interpolation logic | | gap |
| R3e | The game may opt individual actions out of prediction | test: rust "predict_opt_out_declines"; test: wasm "predict_not_predictable_event" | covered |
| R4 | Tick rate accommodates mobile network patterns (decent modern speeds, not 5G) | test: netcode "rates/idle-sends-only-heartbeats"; test: netcode "rates/steady-busy-field"; test: netcode "rates/degrade-on-stall"; test: netcode "rates/baseline-counters-exact"; test: netcode "interpolation/jitter_profile_adapts"; device: M29-socket-resume | covered |
| R5 | Transport is WebSockets | test: netcode "ws/join-converges"; test: netcode "ws/deflate-refused"; test: netcode "ws/reconnect-resume @slow" | covered |
| R6a | Server entrypoint is a host-agnostic library: one long-lived context, a timer, injected connections, injected storage | test: unit "server adapters export parity"; test: unit "runtime globals are named only in their own adapter; zero dependencies"; test: unit "no node: import outside src/server-node.ts and the fs Storage adapter"; test: wasm "server/accept-before-ready-waits"; test: wasm "server/stop-closes-connections" | covered |
| R6b | Node/Bun process (VM, container, Fly) is the first target | test: wasm "nodeHostServices: a real server ticks over real fs storage and reopens to the same hash"; test: netcode "reference-server/smoke @slow"; test: netcode "reference-server/sigterm-snapshots @slow"; test: netcode "reference-server/static-headers"; test: netcode "reference-server/docker-args"; test: wasm "deno-adapter @slow"; device: M38-hosted-boot | covered |
| R6c | Cloudflare Durable Objects is the second target | adr: 0051 | not applicable (measured in M38 and rejected as a no-go; the target was withdrawn) |
| R6d | Vercel is not a target for the sim (it may serve the static client) | adr: 0009 | not applicable (negative requirement: nothing to build or test) |
| R6e | Cost target about $5/month per always-available world, about $0 idle | test: netcode "reference-server/docker-args"; guard: fails if `fly.toml` loses `auto_stop_machines = 'stop'` or `min_machines_running = 0`; test: netcode "lifecycle/idle-stops-ticks-then-onidle"; guard: fails if an empty world keeps ticking or never calls `onIdle` | covered |
| R7a | Access control is a join key in the invite link | test: netcode "bad-key"; test: unit "readInvite: parses #k= and ignores unknown parameters"; test: netcode "reference_full_and_bad_key_rejected" | covered |
| R7b | Device-local identity secret; same secret returns as the same player | test: browser "secret: persists across reload"; test: netcode "join-then-return-same-player"; test: netcode "reference_returning_player_supersedes_and_keeps_presence" | covered |
| R7c | No cross-device recovery | adr: 0013 | not applicable (absence of a feature; the secret never leaves the device) |
| R7d | A server process hosts exactly one world, created or loaded at startup | test: wasm "server/load-or-create"; test: wasm "server/ready-rejects-on-corrupt-world" | covered |
| R7e | Mapping URLs to worlds is the deployer's problem | adr: 0013 | not applicable (explicit non-goal: the engine ships no URL-to-world mapping) |

## Notes

- Titles under `netcode` "bad-key" and "join-then-return-same-player" are nested in `describe('handshake')`; the runner prints them as `handshake > bad-key` and `handshake > join-then-return-same-player`. Titles are cited as the literal `test(...)` string.
- Every cited `device:` id is currently unticked in `docs/plan/device-checks.md` (M39-rerun is pending), so `acceptance:check` will fail on them until Tyler ticks them.
- Rust test names are the `#[test]` function names: `subs_ring1_plus_lookahead` in `src/host/subs.rs`, `every_put_is_one_delta_with_scope` in `src/authority.rs`, `interp_hermite_hits_samples_and_is_c1` in `src/interp/buffer.rs`, `view_unknown_outside_subscription` in `tests/main/connection_and_subscriptions.rs`, and the `predict_*` tests in `fixtures/predict/tests/loopback.rs`.
- R3d gap: a small test would assert that the game-facing trait or ABI registry exposes no delta, prediction or interpolation hook (for example, extend `abi registry: every extern in export_instance! has a row` to list the game-side entry points and fail if one with those names appears).
