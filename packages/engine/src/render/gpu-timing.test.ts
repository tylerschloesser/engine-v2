// docs/plan/39k-gpu-exec-metric.md, Tests added: the option off changes nothing (no feature requested, no
// `timestampWrites` on a pass), on with the feature both appear, and the timing ring reads back late.
import { afterEach, expect, test, vi } from 'vitest'
import { DEVICE_REQUEST, deviceRequestFor, initDevice } from './device.js'
import { createGpuTimer } from './gpu-timing.js'
import { createTerrainRenderer } from './terrain.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A value that answers every property with another such value and every call with one too. */
function deep(): any {
  const fn = () => deep()
  return new Proxy(fn, {
    get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : deep()),
    apply: () => deep(),
  })
}

type Fake = {
  device: GPUDevice
  passes: GPURenderPassDescriptor[]
  mapped: Array<() => void>
  resolves: number
  copies: number
  timestamps: bigint[]
}

/** A fake device that records every pass descriptor and holds `mapAsync` until the test lets it land. */
function fakeDevice(features: string[]): Fake {
  const f: Fake = {
    device: undefined as never,
    passes: [],
    mapped: [],
    resolves: 0,
    copies: 0,
    timestamps: [100n, 1_100_100n],
  }
  const stub = (name: string, size: number) => {
    const buf = {
      size,
      mapAsync: () =>
        new Promise<void>((res) => {
          f.mapped.push(res)
        }),
      getMappedRange: () => new BigUint64Array(f.timestamps).buffer,
      unmap: () => {},
      destroy: () => {},
    }
    void name
    return buf
  }
  const encoder = {
    beginRenderPass: (d: GPURenderPassDescriptor) => {
      f.passes.push({ ...d })
      return deep()
    },
    resolveQuerySet: () => {
      f.resolves += 1
    },
    copyBufferToBuffer: () => {
      f.copies += 1
    },
    finish: () => ({}),
  }
  const base = deep()
  f.device = new Proxy(base, {
    get: (t, k) => {
      if (k === 'features') return new Set(features)
      if (k === 'createCommandEncoder') return () => encoder
      if (k === 'createQuerySet') return () => ({})
      if (k === 'createBuffer') return (d: GPUBufferDescriptor) => stub('b', d.size)
      if (k === 'queue') return { submit: () => {}, writeBuffer: () => {}, writeTexture: () => {} }
      return t[k as never]
    },
  }) as GPUDevice
  return f
}

test('gpu timing: the device request has no feature unless asked and the adapter has it', () => {
  const has = { features: new Set(['timestamp-query']) }
  const none = { features: new Set<string>() }
  expect(deviceRequestFor(has, undefined)).toBe(DEVICE_REQUEST)
  expect(deviceRequestFor(has, false)).toBe(DEVICE_REQUEST)
  expect(deviceRequestFor(none, true)).toBe(DEVICE_REQUEST)
  expect(DEVICE_REQUEST.requiredFeatures).toBeUndefined()
  expect(deviceRequestFor(has, true).requiredFeatures).toEqual(['timestamp-query'])
})

test('gpu timing: initDevice requests timestamp-query only when the option is on', async () => {
  vi.stubGlobal('GPUTextureUsage', new Proxy({}, { get: () => 1 }))
  const requests: GPUDeviceDescriptor[] = []
  const makeAdapter = () => ({
    features: new Set(['timestamp-query']),
    info: { vendor: '', architecture: '', device: '', description: '' },
    requestDevice: async (d: GPUDeviceDescriptor) => {
      requests.push(d)
      const dev = {
        features: new Set(d.requiredFeatures ?? []),
        lost: new Promise(() => {}),
        addEventListener: () => {},
        pushErrorScope: () => {},
        popErrorScope: async () => null,
        createTexture: () => ({ destroy: () => {} }),
        createCommandEncoder: () => ({
          beginRenderPass: () => ({ end: () => {} }),
          finish: () => ({}),
        }),
        queue: { submit: () => {}, writeTexture: () => {} },
      }
      return dev
    },
  })
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => makeAdapter() } })
  const off = await initDevice({ test: { forceViewProbe: true } })
  const on = await initDevice({ test: { forceViewProbe: true }, gpuTiming: true })
  expect(requests[0]?.requiredFeatures).toBeUndefined()
  expect(requests[1]?.requiredFeatures).toEqual(['timestamp-query'])
  expect(off.gpuTimingFeature).toBe(false)
  expect(on.gpuTimingFeature).toBe(true)
})

async function terrain(f: Fake, gpuTiming: boolean) {
  vi.stubGlobal('GPUTextureUsage', new Proxy({}, { get: () => 1 }))
  vi.stubGlobal('GPUBufferUsage', new Proxy({}, { get: () => 1 }))
  vi.stubGlobal('GPUShaderStage', new Proxy({}, { get: () => 1 }))
  const r = await createTerrainRenderer(f.device, {
    colorFormat: 'rgba8unorm',
    viewProbePasses: true,
    checkCompilation: async () => {},
    ...(gpuTiming ? { gpuTiming: true } : {}),
  })
  return r
}

test('gpu timing: no timestampWrites on a pass with the option off, one with it on', async () => {
  const off = fakeDevice(['timestamp-query'])
  const rOff = await terrain(off, false)
  expect(rOff.gpuTimer).toBeNull()
  for (let i = 0; i < 8; i++) rOff.draw(deep() as GPUTextureView)
  expect(off.passes.length).toBe(8)
  expect(off.passes.some((p) => 'timestampWrites' in p)).toBe(false)
  expect(off.resolves + off.copies + off.mapped.length).toBe(0)

  const on = fakeDevice(['timestamp-query'])
  const rOn = await terrain(on, true)
  for (let i = 0; i < 8; i++) rOn.draw(deep() as GPUTextureView)
  const timed = on.passes.filter((p) => p.timestampWrites !== undefined)
  expect(timed.length).toBe(2) // one frame in 4
  expect(timed[0]?.timestampWrites?.beginningOfPassWriteIndex).toBe(0)
  expect(on.resolves).toBe(2)
})

test('gpu timing: a timer without the feature changes no descriptor and says why', async () => {
  const f = fakeDevice([])
  const r = await terrain(f, true)
  for (let i = 0; i < 8; i++) r.draw(deep() as GPUTextureView)
  expect(f.passes.some((p) => 'timestampWrites' in p)).toBe(false)
  expect(r.gpuTimer?.unavailable).toContain('timestamp-query')
})

test('gpu timing: a sample reads back after the writing frame, never on it', async () => {
  const f = fakeDevice(['timestamp-query'])
  const timer = createGpuTimer(f.device, { sampleEvery: 1 })
  const seen: number[] = []
  timer.onSample = (ms) => seen.push(ms)
  const desc: GPURenderPassDescriptor = { colorAttachments: [] }
  const enc = f.device.createCommandEncoder()
  timer.begin(desc)
  expect(desc.timestampWrites).toBeDefined()
  timer.resolve(enc)
  timer.afterSubmit()
  expect(timer.count).toBe(0) // the writing frame has no sample yet
  expect(f.mapped.length).toBe(1)
  await Promise.resolve()
  expect(seen).toEqual([]) // mapAsync has not landed
  f.mapped[0]?.()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  expect(seen).toEqual([1.1])
  expect(timer.lastMs).toBe(1.1)
  expect(timer.count).toBe(1)
  expect(timer.ring[0]).toBe(1.1)
})

test('gpu timing: a busy ring skips the frame instead of timing it', () => {
  const f = fakeDevice(['timestamp-query'])
  const timer = createGpuTimer(f.device, { sampleEvery: 1, slots: 2 })
  const desc: GPURenderPassDescriptor = { colorAttachments: [] }
  const enc = f.device.createCommandEncoder()
  const armed: boolean[] = []
  for (let i = 0; i < 3; i++) {
    timer.begin(desc)
    armed.push(desc.timestampWrites !== undefined)
    timer.resolve(enc)
    timer.afterSubmit()
  }
  expect(armed).toEqual([true, true, false]) // two slots awaiting a map, the third frame is not timed
})
