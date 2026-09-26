// `opfs-latency.html`'s own worker (docs/plan/23-persistence-opfs-and-lifecycle.md step 7, Planning
// decision 7): a device-check probe, not a test -- Tyler runs this by hand on his iPhone through
// `pnpm device:serve --tunnel`, since OPFS append/flush latency is deferred to a real device (0005
// Consequences). Runs entirely inside a dedicated Worker: every browser this milestone supports only
// has working OPFS from one (step 1, Deviations), matching where `opfsStorage()` actually runs
// (0015 "sim worker").
//
// Sequence (Planning decision 7, verbatim): 1,200 appends of 64 B to one sync access handle, with a
// `flush()` after every 20th; then repeated scratch writes of 1 MiB and 8 MiB, each followed by
// `flush()`; then `move()` (the 2-arg form, decision 3 of this milestone's own step 1) and
// `navigator.locks` availability. Reports p50/p95/max per timed series, in milliseconds
// (`performance.now()`, real inside a worker).
//
// A dedicated, wiped probe directory (`opfs-latency-probe/`) keeps this from colliding with any real
// world's own OPFS tree; everything it creates is removed again at the end, success or failure.

type Percentiles = { p50: number; p95: number; max: number }
type Result = {
  append: Percentiles
  flush: Percentiles
  scratchWrite1MiB: Percentiles
  scratchWrite8MiB: Percentiles
  moveAvailable: boolean
  locksAvailable: boolean
  error?: string
}

const PROBE_DIR = 'opfs-latency-probe'
const APPEND_COUNT = 1200
const APPEND_BYTES = 64
const FLUSH_EVERY = 20
const SCRATCH_1MIB_SAMPLES = 20
const SCRATCH_8MIB_SAMPLES = 10
const MIB = 1024 * 1024

function percentiles(samplesMs: number[]): Percentiles {
  if (samplesMs.length === 0) return { p50: 0, p95: 0, max: 0 }
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const at = (p: number): number => {
    const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
    return sorted[i] as number
  }
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] as number }
}

async function removeIfExists(
  dir: FileSystemDirectoryHandle,
  name: string,
  recursive = false,
): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive })
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e
  }
}

async function measureScratchWrites(
  dir: FileSystemDirectoryHandle,
  bytes: Uint8Array,
  namePrefix: string,
  samples: number,
): Promise<number[]> {
  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    const name = `${namePrefix}${i}`
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const handle = await fileHandle.createSyncAccessHandle()
    const t0 = performance.now()
    handle.write(bytes, { at: 0 })
    handle.flush()
    times.push(performance.now() - t0)
    handle.close()
    await removeIfExists(dir, name)
  }
  return times
}

async function run(): Promise<Result> {
  const root = await navigator.storage.getDirectory()
  await removeIfExists(root, PROBE_DIR, true)
  const dir = await root.getDirectoryHandle(PROBE_DIR, { create: true })

  // 1,200 appends of 64 B, flush() every 20th (Planning decision 7).
  const logFileHandle = await dir.getFileHandle('log', { create: true })
  const logHandle = await logFileHandle.createSyncAccessHandle()
  logHandle.truncate(0)
  const appendBytes = new Uint8Array(APPEND_BYTES)
  const appendTimes: number[] = []
  const flushTimes: number[] = []
  const seek = { at: 0 }
  for (let i = 0; i < APPEND_COUNT; i++) {
    seek.at = i * APPEND_BYTES
    const t0 = performance.now()
    logHandle.write(appendBytes, seek)
    appendTimes.push(performance.now() - t0)
    if ((i + 1) % FLUSH_EVERY === 0) {
      const f0 = performance.now()
      logHandle.flush()
      flushTimes.push(performance.now() - f0)
    }
  }
  logHandle.close()

  // Scratch writes of 1 MiB and 8 MiB, each with its own flush() (Planning decision 7).
  const scratchWrite1MiB = await measureScratchWrites(
    dir,
    new Uint8Array(MIB),
    'scratch1-',
    SCRATCH_1MIB_SAMPLES,
  )
  const scratchWrite8MiB = await measureScratchWrites(
    dir,
    new Uint8Array(8 * MIB),
    'scratch8-',
    SCRATCH_8MIB_SAMPLES,
  )

  // `move()` (2-arg form: decision 3, this milestone's own step 1) and `navigator.locks`.
  let moveAvailable = false
  try {
    const srcHandle = await dir.getFileHandle('move-src', { create: true })
    const srcWritable = await srcHandle.createSyncAccessHandle()
    srcWritable.write(new Uint8Array(1), { at: 0 })
    srcWritable.close()
    await srcHandle.move(dir, 'move-dst')
    await removeIfExists(dir, 'move-dst')
    moveAvailable = true
  } catch {
    moveAvailable = false
  }
  const locksAvailable =
    typeof navigator.locks !== 'undefined' && typeof navigator.locks.request === 'function'

  await removeIfExists(root, PROBE_DIR, true)

  return {
    append: percentiles(appendTimes),
    flush: percentiles(flushTimes),
    scratchWrite1MiB: percentiles(scratchWrite1MiB),
    scratchWrite8MiB: percentiles(scratchWrite8MiB),
    moveAvailable,
    locksAvailable,
  }
}

function post(m: Result): void {
  ;(self as unknown as { postMessage(m: Result): void }).postMessage(m)
}

run().then(post, (e: unknown) =>
  post({
    append: { p50: 0, p95: 0, max: 0 },
    flush: { p50: 0, p95: 0, max: 0 },
    scratchWrite1MiB: { p50: 0, p95: 0, max: 0 },
    scratchWrite8MiB: { p50: 0, p95: 0, max: 0 },
    moveAvailable: false,
    locksAvailable: false,
    error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  }),
)
