// Small HTTP / validation helpers shared by every route.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class ConflictError extends Error {
  constructor(message = 'conflict') {
    super(message);
    this.code = 'conflict';
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export async function readBody(request, limit) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limit) throw new HttpError(413, '요청 크기가 너무 큽니다.');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch {}
      throw new HttpError(413, '요청 크기가 너무 큽니다.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export async function readJSON(request, limit = 1024 * 1024) {
  const raw = await readBody(request, limit);
  if (!raw.byteLength) return {};
  try {
    const v = JSON.parse(new TextDecoder().decode(raw));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
  }
}

export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function isHttps(request) {
  const proto = request.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  try { return new URL(request.url).protocol === 'https:'; } catch { return false; }
}

export function cookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  return s;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function str(v, max, { required = false, field = '값' } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${field} 형식이 올바르지 않습니다.`);
  const s = String(v).trim();
  if (required && !s) throw new HttpError(400, `${field}을(를) 입력해 주세요.`);
  if (s.length > max) throw new HttpError(400, `${field}이(가) 너무 깁니다.`);
  return s;
}

export function clientIp(request) {
  return (request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// Per-instance sliding-window limiter. Vercel Fluid compute reuses instances, so this
// stops naive floods; use the Vercel Firewall for stronger, global limits.
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', { retryAfterMs: windowMs - (now - arr[0]) });
  }
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
}
export function _resetRateLimits() { buckets.clear(); }

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export function kstDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function randomId() { return crypto.randomUUID(); }

export function randomCode(len = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
