// Local stand-in for `vercel dev`: serves dist/ (built by scripts/build-static.mjs), applies
// the rewrites from vercel.json and runs lib/app.js for /api/* with a file-system store.
//
//   ADMIN_PASSWORD=... SESSION_SECRET=... node scripts/dev-server.mjs [port]
//
// Fake geo headers can be injected with DEV_GEO="KR,11,Seoul,Asia/Seoul".
import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.LOCAL_STORE_DIR ||= path.join(root, '.local-data');
delete process.env.BLOB_READ_WRITE_TOKEN;
execFileSync(process.execPath, ['scripts/build-static.mjs'], { stdio: 'inherit' });
const { handle } = await import('../lib/app.js');

const port = Number(process.argv[2] || process.env.PORT || 3000);
const dist = path.join(root, 'dist');
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const toRe = (src) => new RegExp('^' + src.replace(/:(\w+)\*/g, '(?<$1>.*)').replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
const rewrites = vercel.rewrites.map((r) => ({ re: toRe(r.source), dest: r.destination }));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };

function staticFile(p) {
  const f = path.join(dist, decodeURIComponent(p));
  if (!f.startsWith(dist)) return null;
  if (existsSync(f) && statSync(f).isFile()) return f;
  if (existsSync(path.join(f, 'index.html'))) return path.join(f, 'index.html');
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    let url = new URL(req.url, `http://${req.headers.host}`);
    let file = staticFile(url.pathname);
    if (!file) {
      for (const r of rewrites) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const dest = r.dest.replace(/:(\w+)\*?/g, (_, k) => m.groups?.[k] ?? '');
        const d = new URL(dest, url);
        for (const [k, v] of url.searchParams) if (!d.searchParams.has(k)) d.searchParams.set(k, v);
        url = d;
        break;
      }
      file = url.pathname.startsWith('/api/') ? null : staticFile(url.pathname);
    }
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      headers.set('x-real-ip', req.socket.remoteAddress || '127.0.0.1');
      if (process.env.DEV_GEO) {
        const [c, r, city, tz] = process.env.DEV_GEO.split(',');
        headers.set('x-vercel-ip-country', c); headers.set('x-vercel-ip-country-region', r);
        headers.set('x-vercel-ip-city', encodeURIComponent(city)); headers.set('x-vercel-ip-timezone', tz);
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
      const response = await handle(request);
      const out = {};
      response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      const cookies = response.headers.getSetCookie?.() || [];
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(response.status, out);
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
      return;
    }
    if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('dev server error');
  }
});
server.listen(port, () => console.log(`dev server on http://localhost:${port} (store: ${process.env.LOCAL_STORE_DIR})`));
