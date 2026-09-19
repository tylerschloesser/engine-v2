// node summarize.mjs results/<file>.jsonl  -> per-variant stats
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) { const k = r.query || '(clean)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return `${s[0].toFixed(2)}..${s[s.length - 1].toFixed(2)} (med ${s[s.length >> 1].toFixed(2)})`; };
for (const [k, rs] of groups) {
  const gc = (who) => stat(rs.map((r) => r.gc[who].MinorGC + r.gc[who].MajorGC));
  console.log(`${k}  n=${rs.length}\n   main B/frame ${stat(rs.map((r) => r.bytesPerFrame.main))} | worker B/frame ${stat(rs.map((r) => r.bytesPerFrame.worker))}\n   GC-in-window main ${gc('main')} worker ${gc('worker')} | window ms ${stat(rs.map((r) => r.windowMs))} | test ms ${stat(rs.map((r) => r.ms.total))} | trace events ${stat(rs.map((r) => r.traceEvents))} | distinctTex ${stat(rs.map((r) => r.run.distinctTextures))}`);
  if (process.argv[3] === '-v') console.log('   byFn main', JSON.stringify(rs[0].byFn.main), '\n   byFn worker', JSON.stringify(rs[0].byFn.worker));
}
