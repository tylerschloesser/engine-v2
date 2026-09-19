// usage: node|bun driver/run-js.mjs <path.wasm> <env-name>   -> writes results/<env-name>.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { runPlan } from "./plan.mjs";
const [wasmPath, env] = process.argv.slice(2);
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const out = { env, runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version} v8 ${process.versions.v8}`, arch: process.arch, ...runPlan(instance.exports, () => performance.now()) };
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
writeFileSync(new URL(`../results/${env}.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(env, out.results.safe_chunks, out.results.safe_sim_f32, out.timing);
