// A bare frame log (a checked-in golden: segment 0's frames, no header) wrapped in a synthetic
// one-segment `MemoryStorage` that `runHeavy`/`replayWorld` can open: the real segment-0 header of
// the build is prepended, as `replayLog` and `replay-world.test.ts` do (`runHeavy` takes a stored
// world, `replayLog` does not expose its storage).
import { RegionId, Role } from '../../src/abi.js'
import type { ManifestV1 } from '../../src/host/persistence.js'
import { instantiate } from '../../src/loader.js'
import { buildSimInstanceConfig } from '../../src/server.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { worldKeys } from '../../src/storage/types.js'

export const LOG_WORLD_ID = 'golden-log'
const BUILD_HASH = 'ab'.repeat(32)

export async function frameLogStorage(
  wasm: WebAssembly.Module,
  params: { seed: string; worldgen: unknown },
  frames: Uint8Array,
): Promise<ReturnType<typeof memoryStorage>> {
  const inst = instantiate(
    wasm,
    Role.Sim,
    buildSimInstanceConfig({ worldId: LOG_WORLD_ID, buildHash: BUILD_HASH, params }),
  )
  const headerLen = inst.call2(inst.x.sim_segment_header, 0, 0xffff_ffff)
  if (headerLen <= 0) throw new Error(`sim_segment_header failed: status ${-headerLen}`)
  const region = inst.region(RegionId.Persist)
  if (!region) throw new Error('the Persist region is absent')
  const log = new Uint8Array(headerLen + frames.length)
  log.set(region.u8.slice(0, headerLen), 0)
  log.set(frames, headerLen)
  const identity = {
    buildHash: BUILD_HASH,
    engineVersion: '0.0.0',
    gameVersion: '0.0.0',
    schemaVersion: 0,
    tickRateHz: 20,
    worldgen: { version: 0, fingerprint: '0' },
  }
  const manifest: ManifestV1 = {
    v: 1,
    worldId: LOG_WORLD_ID,
    epoch: 0,
    params,
    created: identity,
    segments: [{ index: 0, identity, base: 'genesis', sealed: false, tailReexecuted: false }],
  }
  const storage = memoryStorage()
  const keys = worldKeys(LOG_WORLD_ID)
  await storage.write(keys.manifest, new TextEncoder().encode(JSON.stringify(manifest)))
  await storage.write(keys.log(0), log)
  return storage
}
