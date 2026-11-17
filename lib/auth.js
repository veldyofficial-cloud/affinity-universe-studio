// Admin session: HttpOnly cookie "au_admin" = base64url(payload).base64url(HMAC-SHA256(payload, SESSION_SECRET)).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, parseCookies, cookie, isHttps } from './util.js';

export const ADMIN_COOKIE = 'au_admin';
const SESSION_HOURS = 12;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function secret() {
  const s = process.env.SESSION_SECRET || '';
  return s.length >= 16 ? s : null;
}

function sign(payload) {
  return createHmac('sha256', secret()).update(payload).digest();
}

export function authConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD && secret());
}

export function createSessionCookie(request, name = '') {
  const payload = b64u(JSON.stringify({ v: 1, exp: Date.now() + SESSION_HOURS * 3600e3, name: String(name).slice(0, 40) }));
  const value = payload + '.' + b64u(sign(payload));
  return cookie(ADMIN_COOKIE, value, { maxAge: SESSION_HOURS * 3600, secure: isHttps(request), sameSite: 'Lax' });
}

export function clearSessionCookie(request) {
  return cookie(ADMIN_COOKIE, '', { maxAge: 0, secure: isHttps(request) });
}

export function readSession(request) {
  if (!secret()) return null;
  const raw = parseCookies(request)[ADMIN_COOKIE];
  if (!raw) return null;
  const [payload, mac] = raw.split('.');
  if (!payload || !mac) return null;
  let given;
  try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
  const expected = sign(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.v !== 1 || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

export function checkPassword(given) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) return false;
  // Compare HMACs so the comparison is constant-time regardless of length.
  const k = 'au-password-compare';
  const a = createHmac('sha256', k).update(String(given ?? '')).digest();
  const b = createHmac('sha256', k).update(expected).digest();
  return timingSafeEqual(a, b);
}

// Cross-site request guard for state-changing admin calls (in addition to SameSite=Lax).
export function checkOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin) return; // same-origin fetches from older browsers / CLI scripts
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  let oh;
  try { oh = new URL(origin).host; } catch { throw new HttpError(403, '허용되지 않은 요청입니다.'); }
  if (oh !== host) throw new HttpError(403, '허용되지 않은 요청입니다.');
}

export function requireAdmin(request) {
  const s = readSession(request);
  if (!s) throw new HttpError(403, '관리자 권한이 필요합니다. /admin/login 에서 로그인해 주세요.');
  checkOrigin(request);
  return s;
}

export function actorName(session) {
  return session?.name ? `관리자 · ${session.name}` : '관리자';
}
