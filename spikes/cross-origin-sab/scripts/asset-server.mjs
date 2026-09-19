// A second origin (http://127.0.0.1:5999) serving a 1x1 PNG with different header sets.
import http from 'node:http'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
export function startAssetServer(port = 5999) {
  const srv = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    const h = { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }
    if (path === '/corp.png') h['Cross-Origin-Resource-Policy'] = 'cross-origin'
    if (path === '/cors.png') h['Access-Control-Allow-Origin'] = '*'
    res.writeHead(200, h)
    res.end(PNG)
  })
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)))
}
if (import.meta.url === `file://${process.argv[1]}`) startAssetServer().then(() => console.log('assets on http://127.0.0.1:5999'))
