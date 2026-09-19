// Minimal WebGPU render loop written to allocate as little as possible.
// Everything is driven by window.spike.run(n): no free-running rAF.
const q = new URLSearchParams(location.search);
const opt = {
  alloc: q.get('alloc') ?? 'none', // none | main-obj | main-700 | main-2000 | worker-obj | worker-2000
  comm: q.get('comm') ?? 'sab', // sab | postmessage
  src: q.get('src') ?? 'plain', // plain | shared  (writeBuffer source view)
  target: q.get('target') ?? 'offscreen', // offscreen | offscreen-cached | canvas | canvas-direct
  step: q.get('step') ?? 'sync', // sync | task | raf
  gpu: q.get('gpu') ?? 'on', // on | off (off = no WebGPU calls at all: measures the harness floor)
};
const REQ = 0, ACK = 1, STOP = 2;
const COUNT = 4096;
const INSTANCE_BASE = 65536;
const INSTANCE_BYTES = COUNT * 8;

const spike = (window.spike = { opt, errors: [], distinctTextures: 0, framesRun: 0 });

// --- shared memory + worker -------------------------------------------------------------
const memory = new WebAssembly.Memory({ initial: 17, maximum: 17, shared: true });
const i32 = new Int32Array(memory.buffer);
const sharedU8 = new Uint8Array(memory.buffer); // long-lived view over shared WASM memory
const sharedF32 = new Float32Array(memory.buffer, INSTANCE_BASE, COUNT * 2);
const plainF32 = new Float32Array(COUNT * 2); // long-lived view over ordinary memory
const worker = new Worker('./worker.js', { type: 'module' });
const workerReady = new Promise((resolve) => {
  worker.onmessage = (e) => {
    if (e.data.type === 'ready') resolve(e.data);
  };
});
worker.postMessage({ type: 'init', memory, count: COUNT, alloc: opt.alloc });

// --- WebGPU -----------------------------------------------------------------------------
let device, queue, ctx, pipeline, instanceBuf, offscreenTex, offscreenView, readBuf;
let format;
const colorAttachment = { view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' };
const passDesc = { colorAttachments: [colorAttachment] };
const submitList = [null];
let lastTex = null;
let sink = null;

async function initGpu() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const info = adapter.info;
  spike.adapter = {
    vendor: info.vendor, architecture: info.architecture, device: info.device,
    description: info.description, isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
  };
  device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => spike.errors.push(String(e.error?.message ?? e)));
  device.lost.then((l) => spike.errors.push('device lost: ' + l.message));
  queue = device.queue;
  format = navigator.gpu.getPreferredCanvasFormat();
  ctx = document.getElementById('c').getContext('webgpu');
  ctx.configure({ device, format });
  offscreenTex = device.createTexture({
    size: [256, 256], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  offscreenView = offscreenTex.createView();
  readBuf = device.createBuffer({ size: 256 * 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  instanceBuf = device.createBuffer({ size: INSTANCE_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({
    code: `
      struct VOut { @builtin(position) pos: vec4f };
      @vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec2f) -> VOut {
        var quad = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(0,1), vec2f(1,0), vec2f(1,1));
        var o: VOut;
        o.pos = vec4f(p + quad[vi] * 0.02, 0, 1);
        return o;
      }
      @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0.5, 0.25, 1); }`,
  });
  pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: {
      module, entryPoint: 'vs',
      buffers: [{ arrayStride: 8, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
}

// --- one frame ----------------------------------------------------------------------------
function dirty(n) {
  if (opt.alloc === 'main-obj') {
    sink = { n }; // one small object per frame
  } else if (opt.alloc === 'main-700') {
    // ~0.7 KB/frame: the slow leak that GC events alone never see in a 600-frame window
    for (let k = 0; k < 10; k++) sink = { n, k, a: 1, b: 2, c: 3, d: 4, e: 5 };
  } else if (opt.alloc === 'main-2000') {
    for (let k = 0; k < 2000; k++) sink = { n, k, a: 1, b: 2 };
  }
}

function renderFrame(n) {
  if (opt.alloc !== 'none') dirty(n);
  if (opt.gpu === 'off') return;
  if (opt.src === 'shared') {
    // straight from the view over WebAssembly.Memory({shared:true}); no subarray, no copy in JS
    queue.writeBuffer(instanceBuf, 0, sharedU8, INSTANCE_BASE, INSTANCE_BYTES);
  } else {
    plainF32.set(sharedF32);
    queue.writeBuffer(instanceBuf, 0, plainF32, 0, COUNT * 2);
  }
  let view;
  if (opt.target === 'offscreen') {
    view = offscreenTex.createView();
  } else if (opt.target === 'offscreen-cached') {
    view = offscreenView;
  } else {
    const tex = ctx.getCurrentTexture();
    if (tex !== lastTex) { spike.distinctTextures++; lastTex = tex; }
    view = opt.target === 'canvas-direct' ? tex : tex.createView();
  }
  colorAttachment.view = view;
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass(passDesc);
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, instanceBuf);
  pass.draw(6, COUNT);
  pass.end();
  submitList[0] = enc.finish();
  queue.submit(submitList);
}

// --- sim stepping over the SAB (allocation-free lockstep) ---------------------------------
function stepSimSab(n) {
  Atomics.store(i32, REQ, n);
  Atomics.notify(i32, REQ);
  let spins = 0;
  while (Atomics.load(i32, ACK) !== n) {
    if (++spins > 2e9) throw new Error('sim tick ack timeout');
  }
}

let frameNo = 0;
let remaining = 0;
let resolveRun = null;
const mc = new MessageChannel();
function asyncFrame() {
  // one task per frame
  frameNo++;
  if (opt.comm === 'sab') stepSimSab(frameNo);
  renderFrame(frameNo);
  if (--remaining === 0) { const r = resolveRun; resolveRun = null; r(); return; }
  scheduleNext();
}
const tickMsg = { type: 'tick', n: 0 };
function scheduleNext() {
  if (opt.comm === 'postmessage') {
    tickMsg.n = frameNo + 1;
    worker.postMessage(tickMsg); // NEGATIVE CONTROL: a message per frame; reply drives the next frame
  } else if (opt.step === 'raf') {
    requestAnimationFrame(asyncFrame);
  } else {
    mc.port2.postMessage(0);
  }
}
mc.port1.onmessage = asyncFrame;

async function run(n, markName) {
  const sab = opt.comm === 'sab';
  if (sab) {
    Atomics.store(i32, STOP, 0);
    worker.postMessage({ type: 'arm' });
    // the arm message is only delivered once this task yields; wait until the worker is in its loop
    while (Atomics.load(i32, STOP) !== 3) await new Promise((r) => setTimeout(r, 0));
  } else {
    worker.onmessage = asyncFrame;
  }
  if (markName) performance.mark(markName + '-start');
  if (sab && opt.step === 'sync') {
    for (let k = 0; k < n; k++) {
      frameNo++;
      stepSimSab(frameNo);
      renderFrame(frameNo);
    }
  } else {
    remaining = n;
    const done = new Promise((r) => (resolveRun = r));
    if (opt.comm === 'postmessage') { frameNo++; renderFrame(frameNo); remaining--; } // first frame primes the ping-pong
    scheduleNext();
    await done;
  }
  if (markName) performance.mark(markName + '-end');
  if (sab) {
    Atomics.store(i32, STOP, 1);
    Atomics.store(i32, REQ, -1);
    Atomics.notify(i32, REQ);
    while (Atomics.load(i32, STOP) !== 2) await new Promise((r) => setTimeout(r, 0));
  }
  if (opt.gpu !== 'off') await queue.onSubmittedWorkDone();
  spike.framesRun += n;
  return { frameNo, simAck: Atomics.load(i32, ACK), distinctTextures: spike.distinctTextures, errors: spike.errors };
}
spike.run = run;

// proves the offscreen target really got drawn: counts non-black pixels
spike.readback = async () => {
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: offscreenTex }, { buffer: readBuf, bytesPerRow: 256 * 4 }, [256, 256]);
  queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const px = new Uint32Array(readBuf.getMappedRange());
  let lit = 0;
  for (let k = 0; k < px.length; k++) if ((px[k] & 0xffffff) !== 0) lit++;
  readBuf.unmap();
  return lit;
};

spike.ready = (async () => {
  const w = await workerReady;
  if (opt.gpu !== 'off') await initGpu();
  return {
    adapter: spike.adapter ?? null,
    crossOriginIsolated,
    mainGcExposed: typeof gc === 'function',
    workerGcExposed: w.gcExposed,
    userAgent: navigator.userAgent,
    sharedIsSab: memory.buffer instanceof SharedArrayBuffer,
  };
})();
