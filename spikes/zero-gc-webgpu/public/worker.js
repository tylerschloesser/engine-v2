// Module worker: fake sim. Ticks a WASM module that writes instance data into shared memory.
// Manually stepped: either lockstep over the SAB (Atomics.wait loop, zero allocation per tick)
// or, for the negative control, one postMessage per tick.
const REQ = 0, ACK = 1, STOP = 2;
const INSTANCE_BASE = 65536;
let i32 = null;
let tick = null;
let count = 0;
let alloc = 'none';
let sink = null; // keeps dirty allocations observable (defeats escape analysis)
const reply = { type: 'ticked', n: 0 };

function doTick(n) {
  tick(n, INSTANCE_BASE, count);
  if (alloc === 'worker-obj') {
    sink = { n };
  } else if (alloc === 'worker-2000') {
    for (let k = 0; k < 2000; k++) sink = { n, k, a: 1, b: 2 };
  }
}

function armedLoop() {
  let last = Atomics.load(i32, REQ);
  Atomics.store(i32, STOP, 3); // armed
  for (;;) {
    Atomics.wait(i32, REQ, last);
    if (Atomics.load(i32, STOP) === 1) break;
    last = Atomics.load(i32, REQ);
    doTick(last);
    Atomics.store(i32, ACK, last);
  }
  Atomics.store(i32, STOP, 2); // disarmed; back in the event loop so CDP can talk to us
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    i32 = new Int32Array(m.memory.buffer);
    count = m.count;
    alloc = m.alloc;
    const { instance } = await WebAssembly.instantiateStreaming(fetch('./sim.wasm'), { env: { memory: m.memory } });
    tick = instance.exports.tick;
    postMessage({ type: 'ready', gcExposed: typeof gc === 'function' });
  } else if (m.type === 'arm') {
    armedLoop();
  } else if (m.type === 'tick') {
    doTick(m.n);
    reply.n = m.n;
    postMessage(reply);
  }
};
