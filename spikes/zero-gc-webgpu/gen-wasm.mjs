// Hand-assembles the tiny "sim" WASM module (no wat2wasm on this machine).
// tick(t, base, count): writes `count` instances of (x: f32, y: f32) at byte offset `base`
// of an IMPORTED SHARED memory.
import { writeFileSync } from 'node:fs';
const str = (s) => [s.length, ...Buffer.from(s)];
const section = (id, bytes) => [id, bytes.length, ...bytes];
const f32 = (v) => [...new Uint8Array(new Float32Array([v]).buffer)];
const LG = 0x20, LS = 0x21, I32C = 0x41, F32C = 0x43;
const ADD = 0x6a, DIVU = 0x6e, REMU = 0x70, GEU = 0x4f, CONVU = 0xb3, FDIV = 0x95, FSUB = 0x93, FSTORE = 0x38;
const C64 = [I32C, 0xc0, 0x00];
const T = 0, BASE = 1, COUNT = 2, I = 3, P = 4;
const body = [
  0x01, 0x02, 0x7f, // locals: 2 x i32
  LG, BASE, LS, P,
  0x02, 0x40, // block
  0x03, 0x40, // loop
  LG, I, LG, COUNT, GEU, 0x0d, 0x01, // br_if 1
  // x = ((i + t) % 64) / 32 - 1
  LG, P,
  LG, I, LG, T, ADD, ...C64, REMU, CONVU, F32C, ...f32(32), FDIV, F32C, ...f32(1), FSUB,
  FSTORE, 0x02, 0x00,
  // y = ((i / 64) % 64) / 32 - 1
  LG, P, I32C, 4, ADD,
  LG, I, ...C64, DIVU, ...C64, REMU, CONVU, F32C, ...f32(32), FDIV, F32C, ...f32(1), FSUB,
  FSTORE, 0x02, 0x00,
  LG, P, I32C, 8, ADD, LS, P,
  LG, I, I32C, 1, ADD, LS, I,
  0x0c, 0x00, // br 0
  0x0b, 0x0b, // end loop, end block
  0x0b, // end func
];
const bytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, [0x01, 0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00]),
  ...section(2, [0x01, ...str('env'), ...str('memory'), 0x02, 0x03, 17, 17]), // shared, min=max=17 pages
  ...section(3, [0x01, 0x00]),
  ...section(7, [0x01, ...str('tick'), 0x00, 0x00]),
  ...section(10, [0x01, body.length, ...body]),
]);
// validate + smoke test
const memory = new WebAssembly.Memory({ initial: 17, maximum: 17, shared: true });
const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
inst.exports.tick(3, 65536, 4096);
const f = new Float32Array(memory.buffer, 65536, 8);
console.log('smoke', Array.from(f));
writeFileSync(new URL('./public/sim.wasm', import.meta.url), bytes);
console.log('wrote public/sim.wasm', bytes.length, 'bytes');
