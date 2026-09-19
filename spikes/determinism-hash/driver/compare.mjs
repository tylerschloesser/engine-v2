// Reads results/*.json, prints markdown: full hash table for safe rows, grouped divergence
// report for every row, and timings.
import { readdirSync, readFileSync } from "node:fs";
const dir = new URL("../results/", import.meta.url);
const runs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
const order = (e) => (e.startsWith("native") ? "0" : "1") + e;
runs.sort((a, b) => order(a.env).localeCompare(order(b.env)));
const keys = Object.keys(runs[0].results);
console.log("### Environments\n\n| env | runtime |\n|---|---|");
for (const r of runs) console.log(`| ${r.env} | ${r.runtime ?? "rustc native"}${r.ua ? " / " + r.ua.replace(/\|/g, "/") : ""} |`);

const safe = keys.filter((k) => k.startsWith("safe_") || k.startsWith("bench_"));
console.log("\n### Safe variant: every hash, every environment\n");
console.log(`| env | ${safe.join(" | ")} |\n|---|${safe.map(() => "---").join("|")}|`);
for (const r of runs) console.log(`| ${r.env} | ${safe.map((k) => "`" + r.results[k] + "`").join(" | ")} |`);

console.log("\n### All rows: agreement summary\n\n| row | distinct values | value -> environments |\n|---|---|---|");
for (const k of keys) {
  const groups = new Map();
  for (const r of runs) {
    const v = r.results[k];
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(r.env);
  }
  const short = (v) => (k.startsWith("nan:") || k.endsWith("ndiffer") ? "0x" + v.replace(/^0+(?=.{8}$)/, "") : v);
  const desc = groups.size === 1 ? "`" + short([...groups.keys()][0]) + "` (all " + runs.length + ")"
    : [...groups].map(([v, envs]) => "`" + short(v) + "`: " + envs.join(", ")).join("<br>");
  console.log(`| ${k} | ${groups.size === 1 ? "1 (MATCH)" : "**" + groups.size + " (DIVERGE)**"} | ${desc} |`);
}
console.log("\n### Timing\n\n| env | ms / 32x32 chunk (f32, 8 simplex evals per tile) | ms / chunk (f64) | sim: us / tick (256 springs) |\n|---|---|---|---|");
for (const r of runs) console.log(`| ${r.env} | ${r.timing.ms_per_chunk_f32} | ${r.timing.ms_per_chunk_f64} | ${r.timing.sim_us_per_tick_256ent} |`);
