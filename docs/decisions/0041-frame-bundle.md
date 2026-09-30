# 0041: FrameBundle, several whole frames in one message

Status: Accepted (2026-09-29). Amends the "Frame" paragraph of [0011](0011-wire-format-and-deltas.md) (one frame per transport packet) and adds one message type to the numbering of `wire/CLAUDE.md`. Implements the "frames concatenate" clause of [0010](0010-rates-and-subscriptions.md) Rates ("Degrade"). Implemented in milestone M31.

## Context

0010 degrades a client's frame rate by concatenating its frames: every 2nd, then 4th tick, several frames go out together. 0011 says a frame is one transport packet and is applied atomically, so a concatenated message must still be several *whole* frames, applied one by one (an action's ack and the deltas it caused stay together, [0012](0012-prediction-and-reconciliation.md)). A frame is not self-delimiting: its last section runs to the end of the message, and the section list has no terminator. Every existing frame's bytes are pinned by goldens, the 10-byte heartbeat among them.

## Decision

**1. The message.** `MsgType::FrameBundle = 0x06`: `[0x06][n varint]` then `n` times `[len varint][one whole Frame message]`. `n >= 1`; bytes after the last frame are malformed. Each inner frame is an ordinary `Frame` (type `0x01`, its own header and sections) and is applied exactly as if it had arrived alone, in order. `ClientCore::on_frame` accepts either message type and validates the whole bundle before applying any of it.

**2. Length prefixes, not an end-of-frame marker.** A marker would have to end every frame, changing the bytes of all of them and the heartbeat golden. The bundle carries the delimiting instead.

**3. A lone frame is unchanged.** The host sends a bundle only when it holds two or more frames for one message (degrade levels 2 and 4, [0010](0010-rates-and-subscriptions.md)); a single frame goes out as `0x01 ...` exactly as before. No existing golden changes; the bundle has its own (`tests/golden/wire_frame_bundle.hex`).

## Alternatives rejected

- **End-of-frame marker (a `0x00` section id).** Changes every frame's bytes; see §2.
- **A flags bit on the frame header ("continued").** Still needs a length to find the next frame, and turns a reserved byte into state.
- **Several transport messages sent back to back.** Defeats the point: degrade exists to cut per-message cost (~85 B of WS, TLS and TCP/IP overhead each, 0010).

## Consequences

- The `Frame` paragraph of 0011 still describes one frame; a message may now carry several. `0x07..=0x7F` remain free.
- A bundle can be as large as the sim's Tx region; the host flushes a hold before it exceeds half of it.
- Revisit if a transport with its own message batching makes bundles redundant.

## Sources

- `docs/plan/31-rates-and-integrity.md` (Scope, Planning decisions "Frames must be self-delimiting"), `packages/engine/crates/engine/src/wire/bundle.rs` (checked 2026-09-29).
