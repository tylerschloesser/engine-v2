# Client: rendering, camera, input, UI

## Requirements

- Custom WebGPU rendering engine.
- The engine is responsible for most user input:
  - Desktop: WASD moves the camera; scroll zooms.
  - Mobile: pointer drag moves the camera; pinch zooms.
- The engine manages the viewport, knows which chunks are visible, and requests their generation (see `world.md`).
- Tile art is the game's responsibility.
- Game UI is a game-owned DOM overlay. The engine supplies what the overlay needs: world↔screen transforms, tile/entity picking, and a low-GC way to observe state.

## Open questions

- **Where the renderer runs and in what language.** Main thread vs. a worker with OffscreenCanvas; TypeScript against the WebGPU API vs. Rust (wgpu or raw web-sys bindings). Weigh GC behavior, input-to-photon latency, binary size, and dependency weight.
- **WebGPU support.** Current support matrix for the target browsers, especially iOS Safari and Android Chrome. Default policy is no fallback (see non-goals in `overview.md`); confirm that's viable for mobile today.
- **The art contract.** How a game supplies art: atlas format, tile→sprite mapping, per-tile variants and edge dithering, and how game-defined entities are drawn (sprites, simple shapes such as the reference game's circles, progress indicators). Pixel-art crispness at fractional zoom and device pixel ratios.
- **The camera is both local and a sim input.** It must respond instantly on the client, yet the sim needs it for chunk subscriptions, and a game may use it as gameplay input (the reference game's player follows it). How often camera updates are sent as actions, and how that interacts with prediction.
- **Gesture details.** Pointer Events for unified mouse/touch, zoom about the cursor or pinch midpoint, zoom limits, inertia, and preventing browser gestures (page zoom, pull-to-refresh) from interfering.
- **Game-level input.** Taps/clicks on tiles and entities, hover, and placement previews (the reference game's 2x2 furnace ghost) are game concerns but need engine picking and rendering hooks. Define the split, including how input over DOM UI is kept from reaching the world.
- **Overlay anchoring.** DOM elements pinned to world positions (collect buttons next to a resource) that track the camera every frame without layout thrash or per-frame garbage.
- Resize, device-pixel-ratio changes, tab backgrounding, and WebGPU device loss.
