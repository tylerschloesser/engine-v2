// The reference game's full-game golden (docs/plan/34b-reference-scripted-single-player.md):
// `games/reference/tests/golden/full-game.log` (segment 0's frames of one scripted play, without the
// segment header: what native `engine::testing::replay::replay` takes) and `full-game.json` (the
// world, the tick of the log's last frame and a state hash every few ticks, taken from the `.wasm`
// run under Node, 0002 section 1). `pnpm --filter reference golden:record` is the only writer; this
// file only reads. Runtime-light (`node:fs` only): Node, Bun and Vitest load it as it is.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const GOLDEN_DIR = fileURLToPath(
  new URL('../../../../games/reference/tests/golden/', import.meta.url),
)
const WORLD_JSON = fileURLToPath(new URL('../../../../games/reference/world.json', import.meta.url))

/** `20 Hz` (`RefGame::TICK_RATE`): ticks in an hour. */
export const TICKS_PER_HOUR = 20 * 3600

export type Checkpoint = { tick: number; hash: string }

export type FullGameGolden = {
  /** `world.json` (`seed` is a u64 as decimal text): the world the log was recorded in. */
  seed: string
  worldgen: unknown
  /** Players scripted (the log has one). */
  players: number
  /** The tick of the log's last frame (a log has no idle ticks after it); `checkpoints` ends here. */
  ticks: number
  checkpoints: Checkpoint[]
}

export function readFullGame(): { meta: FullGameGolden; frames: Uint8Array } {
  const meta = JSON.parse(readFileSync(`${GOLDEN_DIR}full-game.json`, 'utf8')) as FullGameGolden
  const frames = new Uint8Array(readFileSync(`${GOLDEN_DIR}full-game.log`))
  return { meta, frames }
}

export function readWorldJson(): { seed: string; worldgen: unknown } {
  return JSON.parse(readFileSync(WORLD_JSON, 'utf8')) as { seed: string; worldgen: unknown }
}

/** The first checkpoint where `got` differs from `want`, or `null`: what a failing replay reports. */
export function firstDivergence(
  got: Checkpoint[],
  want: Checkpoint[],
): { tick: number; got: string; want: string } | null {
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as Checkpoint
    const g = got[i]
    if (g === undefined) return { tick: w.tick, got: '(missing)', want: w.hash }
    if (g.tick !== w.tick || g.hash !== w.hash) {
      return { tick: w.tick, got: `${g.hash}@${g.tick}`, want: w.hash }
    }
  }
  return got.length > want.length
    ? { tick: (got[want.length] as Checkpoint).tick, got: 'extra checkpoint', want: '(none)' }
    : null
}

/** The message of a divergence for `expect(..).toBeNull()`-style assertions; `null` when none. */
export function divergenceMessage(d: ReturnType<typeof firstDivergence>): string | null {
  return d === null
    ? null
    : `golden replay: first divergent tick ${d.tick} (got ${d.got}, want ${d.want})`
}

/** The log's bytes per active player-hour at the scripted play's rate: `logBytes` over `players *
 * ticks` player-ticks, scaled to one hour (`PRE-PLAN.md` section 7, "Action rate / log"). */
export function logBytesPerPlayerHour(logBytes: number, players: number, ticks: number): number {
  return (logBytes / (players * ticks)) * TICKS_PER_HOUR
}

/** `games/reference/tests/fixtures/landmarks.json`: where each resource is under `world.json`'s seed. */
export function readLandmarks(): {
  land: { x: number; y: number }
  resources: Record<'stone' | 'iron' | 'wood' | 'coal', { x: number; y: number }>
} {
  const file = fileURLToPath(
    new URL('../../../../games/reference/tests/fixtures/landmarks.json', import.meta.url),
  )
  return JSON.parse(readFileSync(file, 'utf8'))
}
