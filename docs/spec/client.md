# Client: rendering, camera, input, UI

## Requirements

- Custom WebGPU rendering engine. The WebGPU calls are issued from TypeScript on the main thread; Rust in a worker produces all frame data into shared memory; no WASM runs on the main thread.
- The camera is user-driven and engine-owned. A game can set constraints, move it programmatically, and attach an optional follow target. No "WASD moves a sim player" mode in v1.
- Zoom range: 12 to 256 tiles across the long axis by default (about 128 subscribed chunks per client), configurable per game.
- Supported browsers: Tier 1 is the current and previous major version of Chrome (desktop, Android) and Safari (macOS, iOS 26+). Tier 2 is Firefox desktop. Anything else gets a capability screen. Design inside the WebGPU compatibility-mode subset, with no testing commitment for those devices.
- The engine is responsible for most user input:
  - Desktop: WASD moves the camera; scroll zooms.
  - Mobile: pointer drag moves the camera; pinch zooms.
- The engine manages the viewport, knows which chunks are visible, and requests their generation (see `world.md`).
- Tile art is the game's responsibility.
- Game UI is a game-owned DOM overlay. The engine supplies what the overlay needs: world↔screen transforms, tile/entity picking, and a low-GC way to observe state.

## Open questions

- **Where the renderer runs and in what language; renderer placement vs. overlay anchoring.** Decided in [0018](../decisions/0018-renderer.md) and [0019](../decisions/0019-camera-input-and-overlay.md).
- **WebGPU support.** Decided in [0018](../decisions/0018-renderer.md).
- **The art contract.** Decided in [0018](../decisions/0018-renderer.md).
- **The camera is local; the sim's host only hears about it.** Decided in [0019](../decisions/0019-camera-input-and-overlay.md), [0001](../decisions/0001-camera-and-presence.md) and [0010](../decisions/0010-rates-and-subscriptions.md).
- **Gesture details.** Decided in [0019](../decisions/0019-camera-input-and-overlay.md).
- **Game-level input and keyboard focus.** Decided in [0019](../decisions/0019-camera-input-and-overlay.md).
- **Overlay anchoring.** Decided in [0019](../decisions/0019-camera-input-and-overlay.md).
- **Resize, device-pixel-ratio changes, tab backgrounding, and WebGPU device loss.** Decided in [0018](../decisions/0018-renderer.md).
- **Render-data extraction.** Decided in [0018](../decisions/0018-renderer.md) and [0003](../decisions/0003-game-facing-api.md).
- **Zoom range as a budget.** Decided in [0018](../decisions/0018-renderer.md) and [0010](../decisions/0010-rates-and-subscriptions.md).
- **Low-GC state observation.** Decided in [0003](../decisions/0003-game-facing-api.md).
- **Terrain fill-rate on real phones and anchoring on iOS Safari.** Deferred to Phase 2: real phones cannot be automated in this phase, so both are manual device checks with stated fallbacks. See [0018](../decisions/0018-renderer.md) and [0019](../decisions/0019-camera-input-and-overlay.md).
