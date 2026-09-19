// Static server with COOP/COEP so SharedArrayBuffer / shared WebAssembly.Memory are available.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const port = Number(process.env.PORT ?? 4517);
createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, {
      'content-type': types[extname(path)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`listening http://127.0.0.1:${port}`));
