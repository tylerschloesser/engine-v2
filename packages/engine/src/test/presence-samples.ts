// `samplePresences` / `interpCounters` decoding (docs/plan/30-interpolation.md Seams): the 36-byte
// `Result` shape of `client_presence_sample_at` (`Instance::client_presence_sample_at`'s doc in
// `crates/engine/src/abi/registry.rs`), shared by the browser `Client` hook (`test/client.ts`) and
// `HeadlessClient` (`test/headless-client.ts`). Test-only: allocation is fine here.

export type InterpModeName = 'interp' | 'extrap' | 'hold'

export interface PresenceSampleRow {
  who: number
  /** `WorldPos` raw Q24.8 (256 = one tile). */
  x: number
  y: number
  alpha: number
  mode: InterpModeName
}

export interface InterpCounters {
  /** Remote samples rendered, summed over every client frame so far. */
  interpRenderedFrames: number
  /** Of those, how many were extrapolating. */
  interpExtrapolatedFrames: number
  interpDelayMs: number
}

const MODES: InterpModeName[] = ['interp', 'extrap', 'hold']
export const PRESENCE_SAMPLE_BYTES = 36

export function decodeCounters(result: Uint8Array): InterpCounters {
  const v = new DataView(result.buffer, result.byteOffset, result.byteLength)
  return {
    interpRenderedFrames: v.getUint32(4, true),
    interpExtrapolatedFrames: v.getUint32(8, true),
    interpDelayMs: v.getFloat32(12, true),
  }
}

export function visibleCount(result: Uint8Array): number {
  return new DataView(result.buffer, result.byteOffset, result.byteLength).getUint32(0, true)
}

export function rowFrom(result: Uint8Array): PresenceSampleRow {
  const v = new DataView(result.buffer, result.byteOffset, result.byteLength)
  return {
    who: v.getUint32(16, true),
    x: v.getInt32(20, true),
    y: v.getInt32(24, true),
    alpha: v.getFloat32(28, true),
    mode: MODES[v.getUint32(32, true)] ?? 'interp',
  }
}

/** `call(i)` invokes `client_presence_sample_at(i)` and returns the `Result` bytes (a copy). */
export async function readPresenceRows(
  call: (index: number) => Promise<Uint8Array> | Uint8Array,
): Promise<PresenceSampleRow[]> {
  const rows: PresenceSampleRow[] = []
  for (let i = 0; ; i++) {
    const r = await call(i)
    if (i >= visibleCount(r)) return rows
    rows.push(rowFrom(r))
  }
}
