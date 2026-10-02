# Acceptance: docs/spec/overview.md, Fixed decisions and Non-goals

| # | Item | Evidence | Status |
|---|---|---|---|
| FD1 | pnpm monorepo; TypeScript JS side; Rust→WASM for everything reasonable; renderer WebGPU calls, camera and input in TS on the main thread | test: unit "reference_package_depends_only_on_engine"; test: wasm "import allowlist"; guard: the wasm module may import only `engine.panic` and `engine.log`, so any JS-side logic callback fails the allowlist | covered |
| FD2 | Game authors write simulation logic in Rust; game crate and engine crate compile into one WASM module | test: unit "reference_package_depends_only_on_engine"; test: wasm "import allowlist"; guard: `describe.each(gameCrateNames())` runs the allowlist on each game's `sim` module, which must export the full ABI and import nothing but panic/log; the Cargo `path =` engine dependency is asserted | covered |
| FD3 | Engine is the single published package with zero runtime npm dependencies and multiple entrypoints (main, worker, server) | test: unit "exports-map: dependencies is empty and files is exactly dist + crates"; test: unit "exports-map: the subpath list is exactly 0017 §2 plus ./render"; test: unit "exports-map: dist/worker.js (and everything it imports) has no bare specifier and no import()"; test: unit "runtime globals are named only in their own adapter; zero dependencies" | covered |
| FD4 | Reference game is a separate private package: Vite plus a simple game | test: unit "reference_package_depends_only_on_engine"; guard: asserts `private: true`, `dependencies` keys exactly `['engine']`, `workspace:*` | covered |
| FD5 | Custom WebGPU renderer; no rendering library | test: unit "exports-map: dependencies is empty and files is exactly dist + crates"; test: unit "reference_package_depends_only_on_engine"; guard: neither package can add a rendering library as a dependency | covered |
| FD6 | WebSockets for multiplayer | test: netcode "ws/join-converges"; test: netcode "ws/reconnect-resume @slow"; test: netcode "reference-server/smoke @slow" | covered |
| FD7 | Game UI is a game-owned DOM overlay; the engine renders no UI widgets | test: browser "overlay.anchor_tracks_world_point"; test: browser "overlay.widget_click_not_a_tap" | gap |
| FD8 | The camera never mutates the world and is not an action; host uses camera+viewport only for chunk subscriptions | test: rust "camera_walk_changes_no_state"; test: rust "camera_report_is_16_bytes"; test: unit "reference_subscription_edge_not_predictable" | covered |
| FD9 | Server entrypoint is agnostic to where it is hosted (Hosting in `sync.md`) | test: unit "server adapters export parity"; test: unit "runtime globals are named only in their own adapter; zero dependencies"; test: netcode "reference-server/smoke @slow" | covered |
| NG1 | Accounts/auth, matchmaking, lobbies | adr: 0013 Sessions (player is an opaque token) | not applicable (non-goal) |
| NG2 | Audio | - | not applicable (non-goal) |
| NG3 | A non-WebGPU rendering fallback | test: unit "checkSupport: no-webgpu"; test: browser "reference: capability screen on failure"; adr: 0018 §7 | covered |
| NG4 | Modding or loading game code at runtime | - | not applicable (non-goal) |
| NG5 | More than one world per server process | test: rust "welcome_for_a_different_world_is_fatal"; test: unit "client.world_mismatch_fatal_becomes_link_rejected"; adr: 0013 | covered |
