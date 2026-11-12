// Local dev server for AI Nation. Run: node dev-server.js [port]
// index.html has no doctype/html/head/body on purpose (the hosting page adds them), so this wraps it.
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = __dirname, PORT = +process.argv[2] || 8765;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') {
    const body = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    return res.end('<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + body + '</body></html>');
  }
  const f = path.join(ROOT, path.normalize(u));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'text/plain' });
  res.end(fs.readFileSync(f));
}).listen(PORT, () => console.log('AI Nation running at http://localhost:' + PORT));
