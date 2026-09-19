## Context

Help me design a multi-player web game engine for a specific genre of game I like to prototype.

I want an infinite, grid world. chunked, obviously. How exactly the world is generated (e.g. noise & octaves) and tile art is the responsibility of the engine user.

Engine is responsible for most user input. E.g. wasd to move the camera on desktop. Pointer drag on mobile. Scroll zoom on desktop. Pinch zoom on mobile. Engine is responsible for managing the viewport, knowing what chunks are visible, requesting chunk generation. Chunk generation needs to be async.

In general, everything should be async. Do only what is necessary in Javascript. Do as much as possible in WebAssembly web-workers (Rust). Optimize for minimal/no garbage collection to prevent dropped frames.

Everything should be optimized for automated testing. Avoid mocking, unless it's necessary. Unit test pure functions. Research latest LLM-optimized automated browser testing. I want to be able to test low-level browser behavior (e.g. deterministically run the game and ensure no garbage collection). Claude should have an automated test suite for as much as possible. But automated tests need to be fast (can be parallelized). Automated test budget should be <1 minute for all tests. If we start to exceed that, I'll want to refactor to have separate fast and slow (more comprehensive) suites.

The game is a tick-based simulation. Simulation will run in either the cloud, or web-worker, depending on multi or single player. All actions are serialized and sent as messages. The world is deterministic. If you have the original simulation code, the original seeds and parameters, and all of the actions and timings, you can re-construct the world deterministically.

The simulation should be capable of sending deltas to the user/renderer, based on the viewport. We need a layer for managing the current state, the latest received state, and interpolating and predicting so there's not noticeable lag. This should be abstracted by the engine such that the consumer can define the data model, deltas, interpolation & prediction logic, and the engine just pieces everything together.

Specific parameters, like chunk size & max world size (e.g. chunk count or bytes) should be configurable per-game.

The simulation should manage state of what players are connected and what they're seeing (e.g. camera position + viewport - so they know what chunks the player is essentially subscribed to). Note that to this end, we will likely need some actions to be engine-defined/managed, and some actions to be consumer defined (see the reference implementation).

Engine should manage data storage. Localstorage or whatever on browser, whatever on server. World can be assume to fit into memory and only need to be persisted e.g. occasionally in case of crash. Actions should be temporarily stored in case they need to be replayed. Actually, actions should be stored indefinitely, so they can possibly be replayed.

Tick rate is TBD. Need something that accommodates e.g. mobile network patterns. Don't assume the worst, assume somewhat decent/modern speeds and bandwidth, but don't assume great 5G.

## Reference implementation

Simplex noise, multiple octaves. Simple tiles & biomes (grass, dirt, water, sand, etc.). Slight randomness in tiles. Some noise applied, dithering. Simple pixel-art feel. Pre-generate tile assets via script. Special resource tiles are scattered randomly (but deterministically). Iron, wood, stone, coal. This is adjacent to tile type (e.g. grass + wood, grass + coal). No resources on water.

Players are just circles. They following the camera with a springy effect based on the camera accel & velocity. If a player is within a certain distance of a resource, they can collect it. Button appears (multiple buttons allowed) to collect. Collecting takes 2 seconds. Button files to show progress.

Once a player mines 5 stone, they unlock a furnace and can craft a furnace for 5 stone. Crafting menu appears. Furnace takes 5 seconds to craft. Once it's in their inventory, they can open a construction UI. Furnace takes up 2x2 tiles, and cannot be placed on water or other buildings. (note that the logic is not "can't build on water", but rather, water should express that you cannot build on it).

Clicking on a furnace opens a UI where you can deposit items from your inventory (iron + coal/wood). Furnace will craft and ingot in 5 seconds. Coal lasts 10 ticks. Wood lasts 2.

That's as far as the reference implementation should go.
## Decisions

Pnpm mono-repo.
Engine itself has no dependencies, and is the single export of the overall package.
Actually need to figure out how to model the exports such that e.g. Vite can import things in the right spot. The exact web-worker bundle splitting is probably the responsibility of the consumer. But the engine does have to know about web-workers, so It's not a super clean separation. Figure out how to export things to accommodate this. Also note that we need to export a server entrypoint, though that should be agnostic to where exactly it's running (e.g. AWS vs. vercel - should work in both).
Separate package for a reference implementation. Just vite, plus a simple game.
Typescript.

Custom WebGPU rendering engine.
Likely web-sockets (unless there's a better option).

## Meta instructions

We are going to build this engine in phases. Each stage needs clear exit criteria. Claude should commit early and often.

Phase 1 
This PROMPT.md describes what I want to build, roughly. I'm going to have Claude iterate on this and point out gaps & inconsistencies. Then I'm going to use it to generate a PRE-PLAN.md.

This phase should research and finalize most big decisions, and setting up all of the local context that will be necessary to construct the final PLAN.md. We should pick and choose all of the technologies and major design decisions here.

The pre-plan should evaluate existing implementations (prior art), latest best practices and patterns.

Finally, the pre-plan should update PROMPT.md so that the next phase can simply point a new claude session at PROMPT.md and go, with no more needed.

Phase 2

The PRE-PLAN.md document should have all of the decisions made. And the repo should contain all of the context necessary to generate a final PLAN.md. The plan should describe to the next claude session how exactly to write the code and test and verify.

Phase 3

The PLAN.md doc is executed.

Phase 4

Cleanup all of the initialization context, and re-architect the context based on the final state for future iteration. Retain important decision details & decisions that can't be inferred, but in general delete most of the original prompting.

---
Every phase begins with a PROMPT.md.
Every phase should delegate what it can to sub-agents. Every phase should fit within a single Opus session without overloading context. If context ever starts to grow beyond, say 50%, abort, summarize the current state and next steps to PROMPT.md and end.
Every phase ends with a PROMPT.md, except for the last, obviously.