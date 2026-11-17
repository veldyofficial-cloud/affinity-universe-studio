// Storage adapter. Production uses Vercel Blob; tests and the local dev server use
// lib/store-fs.js, which implements the same interface on the local file system.
//
// Interface:
//   getJSON(path)                         -> { data, etag } | null
//   putJSON(path, data, { ifMatch, create }) -> { etag }   (throws ConflictError)
//   list(prefix)                          -> [{ pathname, size, uploadedAt }]
//   putFile(path, body, { contentType })  -> { pathname, size }
//   head(path)                            -> { pathname, size, contentType, url } | null
//   getFile(path, { range })              -> { status, headers, body } | null
//   del(path)
import { ConflictError } from './util.js';

let cached;

export async function getStore() {
  if (cached) return cached;
  if (process.env.LOCAL_STORE_DIR && !process.env.BLOB_READ_WRITE_TOKEN) {
    const { createFsStore } = await import('./store-fs.js');
    cached = createFsStore(process.env.LOCAL_STORE_DIR);
  } else {
    cached = await createBlobStore();
  }
  return cached;
}

export function setStore(store) { cached = store; }

async function createBlobStore() {
  const blob = await import('@vercel/blob');
  // Leads contain personal data, so the store must be a *private* Blob store.
  const access = 'private';
  const ensureToken = () => {
    if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
      const e = new Error('저장소가 연결되지 않았습니다. Vercel Blob 스토어를 프로젝트에 연결해 주세요 (BLOB_READ_WRITE_TOKEN).');
      e.status = 503;
      throw e;
    }
  };
  const conflict = (e) => e instanceof blob.BlobPreconditionFailedError || /already exists|precondition/i.test(String(e?.message));
  return {
    kind: 'blob',
    access,
    async getJSON(path) {
      ensureToken();
      const r = await blob.get(path, { access, useCache: false });
      if (!r || r.statusCode !== 200) return null;
      const text = await new Response(r.stream).text();
      return { data: JSON.parse(text), etag: r.blob.etag };
    },
    async putJSON(path, data, { ifMatch, create } = {}) {
      ensureToken();
      try {
        const r = await blob.put(path, JSON.stringify(data), {
          access,
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: !create,
          cacheControlMaxAge: 60,
          ...(ifMatch ? { ifMatch } : {}),
        });
        return { etag: r.etag };
      } catch (e) {
        if (conflict(e)) throw new ConflictError();
        throw e;
      }
    },
    async list(prefix) {
      ensureToken();
      const out = [];
      let cursor;
      do {
        const r = await blob.list({ prefix, cursor, limit: 1000 });
        for (const b of r.blobs) out.push({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt, url: b.url });
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return out;
    },
    async putFile(path, body, { contentType }) {
      ensureToken();
      const r = await blob.put(path, body, { access, contentType, addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 31536000 });
      return { pathname: r.pathname, url: r.url };
    },
    async head(path) {
      ensureToken();
      try {
        const h = await blob.head(path);
        return { pathname: h.pathname, size: h.size, contentType: h.contentType, url: h.url };
      } catch (e) {
        if (e instanceof blob.BlobNotFoundError) return null;
        throw e;
      }
    },
    async getFile(path, { range } = {}) {
      ensureToken();
      const r = await blob.get(path, { access, headers: range ? { range } : undefined });
      if (!r || r.statusCode !== 200) return null;
      const h = r.headers;
      const headers = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (h.get(k)) headers[k] = h.get(k);
      return { status: h.get('content-range') ? 206 : 200, headers, body: r.stream };
    },
    async del(path) {
      ensureToken();
      await blob.del(path);
    },
  };
}
