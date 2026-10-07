// A second player for a browser page over the same `startTestServer` server (docs/plan/
// 30-interpolation.md, exit criterion "zero-GC in the multiplayer topology with one moving
// remote"): a Node-side `HeadlessClient` on a real loopback socket whose camera walks a small
// curve around the origin. `fx-presence`'s client copies a non-default camera's centre and
// velocity into its presence sample, so each `step()` gives the host a new sample to relay to the
// page under test, whose own camera subscribes the chunks the walker stands in.
import { systemClock, systemScheduler } from '../../../src/clock.js'
import { parseBuildHash32 } from '../../../src/host/handshake.js'
import { wsConnection } from '../../../src/net/ws-connection.js'
import { createHeadlessClient } from '../../../src/test/headless-client.js'
import { loadFixture } from '../../support/fixtures.js'

export interface MovingRemote {
  /** One client frame with the camera advanced along the curve; call between server ticks. */
  step(): void
  /** One client frame with the camera at `x` tiles (y fixed) and velocity `velX` tiles/s. */
  stepAt(x: number, velX: number): void
  leave(): void
}

/** `tick` steps the (manual-timer) server: its handshake only completes across host ticks. */
export async function startMovingRemote(
  url: string,
  fixture: string,
  tick: () => void,
): Promise<MovingRemote> {
  const { wasm, buildHash } = await loadFixture(fixture)
  const client = createHeadlessClient({
    wasm,
    game: { seed: '1', worldgen: null },
    dial: () => wsConnection(url),
    secret: new Uint8Array(16).fill(0x22),
    buildHash: parseBuildHash32(buildHash),
    clock: systemClock,
    scheduler: systemScheduler,
  })
  const deadline = Date.now() + 5_000
  while (!client.status().live) {
    client.pump()
    tick()
    if (Date.now() > deadline) throw new Error('startMovingRemote: never went live')
    await new Promise((r) => setTimeout(r, 20))
  }
  const t0 = Date.now()
  return {
    step() {
      const s = (Date.now() - t0) / 1000
      client.setView({
        x: 3 * Math.sin(0.5 * s),
        y: 2 * Math.sin(0.9 * s + 1),
        halfW: 4,
        halfH: 4,
        velX: 1.5 * Math.cos(0.5 * s),
        velY: 1.8 * Math.cos(0.9 * s + 1),
      })
      client.stepFrame(50)
    },
    stepAt(x, velX) {
      client.setView({ x, y: 0.5, halfW: 4, halfH: 4, velX, velY: 0 })
      client.stepFrame(50)
    },
    leave() {
      client.leave()
    },
  }
}
