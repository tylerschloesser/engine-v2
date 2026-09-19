// How badly does f32 noise degrade far from the origin? (f64 generator as reference)
import { readFileSync } from "node:fs";
const { instance } = await WebAssembly.instantiate(readFileSync(process.argv[2] ?? "wasm/o3.wasm"), {});
const SEED = 0x5EED1234ABCD0042n;
console.log("| chunk coord | tile coord | terrain tiles differing from f64 (of 1024, mean of 16 chunks) | max abs height error |\n|---|---|---|---|");
for (const c of [0, 100, 1000, 10000, 31250, 100000, 250000, -250000]) {
  let mism = 0, err = 0;
  for (let k = 0; k < 16; k++) {
    mism += instance.exports.probe_precision(SEED, c + k, c - k, 0);
    err = Math.max(err, instance.exports.probe_precision(SEED, c + k, c - k, 1));
  }
  console.log(`| ${c} | ${c * 32} | ${(mism / 16).toFixed(1)} | ${(err / 1e6).toFixed(6)} |`);
}
