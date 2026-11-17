// File-system implementation of the storage interface in lib/store.js.
// Used by the local dev server and the test harness only (never on Vercel).
import { promises as fs, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import { ConflictError } from './util.js';

export function createFsStore(root) {
  const abs = (p) => {
    const full = nodePath.resolve(root, 'blobs', p);
    if (!full.startsWith(nodePath.resolve(root, 'blobs'))) throw new Error('bad path');
    return full;
  };
  const metaPath = (p) => abs(p) + '.__meta';
  const etagOf = (buf) => '"' + createHash('sha1').update(buf).digest('hex') + '"';
  // Serialise writes per path inside this process so the ifMatch check is atomic.
  const locks = new Map();
  const withLock = async (p, fn) => {
    const prev = locks.get(p) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    locks.set(p, prev.then(() => next));
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(p) === next) locks.delete(p); }
  };
  async function readMeta(p) {
    try { return JSON.parse(await fs.readFile(metaPath(p), 'utf8')); } catch { return null; }
  }
  async function walk(dir, base, out) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = nodePath.join(dir, e.name);
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(full, rel, out);
      else if (!e.name.endsWith('.__meta')) {
        const st = await fs.stat(full);
        out.push({ pathname: rel, size: st.size, uploadedAt: st.mtime });
      }
    }
  }
  return {
    kind: 'fs',
    access: 'private',
    async getJSON(p) {
      try {
        const buf = await fs.readFile(abs(p));
        return { data: JSON.parse(buf.toString('utf8')), etag: etagOf(buf) };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async putJSON(p, data, { ifMatch, create } = {}) {
      return withLock(p, async () => {
        let existing = null;
        try { existing = await fs.readFile(abs(p)); } catch {}
        if (create && existing) throw new ConflictError();
        if (ifMatch && (!existing || etagOf(existing) !== ifMatch)) throw new ConflictError();
        const buf = Buffer.from(JSON.stringify(data));
        await fs.mkdir(nodePath.dirname(abs(p)), { recursive: true });
        await fs.writeFile(abs(p), buf);
        await fs.writeFile(metaPath(p), JSON.stringify({ contentType: 'application/json' }));
        return { etag: etagOf(buf) };
      });
    },
    async list(prefix) {
      const out = [];
      await walk(nodePath.resolve(root, 'blobs'), '', out);
      return out.filter((b) => b.pathname.startsWith(prefix)).sort((a, b) => a.pathname.localeCompare(b.pathname));
    },
    async putFile(p, body, { contentType }) {
      return withLock(p, async () => {
        try { await fs.access(abs(p)); throw new ConflictError(); } catch (e) { if (e instanceof ConflictError) throw e; }
        await fs.mkdir(nodePath.dirname(abs(p)), { recursive: true });
        const buf = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer());
        await fs.writeFile(abs(p), buf);
        await fs.writeFile(metaPath(p), JSON.stringify({ contentType }));
        return { pathname: p, url: 'file://' + p };
      });
    },
    async head(p) {
      try {
        const st = await fs.stat(abs(p));
        const meta = (await readMeta(p)) || {};
        return { pathname: p, size: st.size, contentType: meta.contentType || 'application/octet-stream', url: 'file://' + p };
      } catch { return null; }
    },
    async getFile(p, { range } = {}) {
      let st;
      try { st = await fs.stat(abs(p)); } catch { return null; }
      const meta = (await readMeta(p)) || {};
      const headers = { 'content-type': meta.contentType || 'application/octet-stream', 'accept-ranges': 'bytes' };
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
        let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) return { status: 416, headers: { 'content-range': `bytes */${st.size}` }, body: null };
        headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
        headers['content-length'] = String(end - start + 1);
        return { status: 206, headers, body: Readable.toWeb(createReadStream(abs(p), { start, end })) };
      }
      headers['content-length'] = String(st.size);
      return { status: 200, headers, body: Readable.toWeb(createReadStream(abs(p))) };
    },
    async del(p) {
      await fs.rm(abs(p), { force: true });
      await fs.rm(metaPath(p), { force: true });
    },
  };
}
