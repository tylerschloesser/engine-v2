// usage: node driver/run-browsers.mjs <path.wasm> <suffix> [browser ...]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright";
import { runPlan } from "./plan.mjs";
const [wasmPath, suffix, ...only] = process.argv.slice(2);
const b64 = readFileSync(wasmPath).toString("base64");
const targets = {
  chromium: () => chromium.launch(),
  chrome: () => chromium.launch({ channel: "chrome" }),
  firefox: () => firefox.launch(),
  webkit: () => webkit.launch(),
};
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
for (const [name, launch] of Object.entries(targets)) {
  if (only.length && !only.includes(name)) continue;
  const env = `${name}-${suffix}`;
  try {
    const browser = await launch();
    const page = await browser.newPage();
    const r = await page.evaluate(async ({ b64, src }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const runPlan = new Function("return (" + src + ")")();
      return { ua: navigator.userAgent, ...runPlan(instance.exports, () => performance.now()) };
    }, { b64, src: runPlan.toString().replace(/^export\s+/, "") });
    const out = { env, runtime: `${name} ${browser.version()}`, ...r };
    await browser.close();
    writeFileSync(new URL(`../results/${env}.json`, import.meta.url), JSON.stringify(out, null, 2));
    console.log(env, out.runtime, out.results.safe_chunks, out.results.safe_sim_f32, out.timing);
  } catch (e) {
    console.error(env, "FAILED:", String(e).split("\n")[0]);
  }
}
