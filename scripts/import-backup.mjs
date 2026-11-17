// Uploads an `affinity-studio-backup.json` (Studio settings → "전체 데이터 JSON 내려받기")
// to a deployed instance through the admin-only POST /api/admin/import endpoint.
//
//   ADMIN_PASSWORD=... node scripts/import-backup.mjs affinity-studio-backup.json --url https://your-app.vercel.app [--replace-config]
//
// The import is idempotent: records whose id already exists are skipped, so it is safe to re-run.
// Leads are sent in small batches to stay under the 4.5 MB Vercel Function body limit.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--url' && args[args.indexOf(a) - 1] !== '--password');
const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const base = (opt('url') || process.env.STUDIO_URL || '').replace(/\/+$/, '');
const password = opt('password') || process.env.ADMIN_PASSWORD;
const replaceConfig = args.includes('--replace-config');
if (!file || !base || !password) {
  console.error('usage: ADMIN_PASSWORD=... node scripts/import-backup.mjs <backup.json> --url https://host [--replace-config]');
  process.exit(1);
}

const backup = JSON.parse(readFileSync(file, 'utf8'));
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, name: 'import' }) });
if (!login.ok) { console.error('login failed:', login.status, await login.text()); process.exit(1); }
const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');

async function send(body, label) {
  const res = await fetch(base + '/api/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${label}: ${res.status} ${r.error || ''}`);
  console.log(label, JSON.stringify({ created: r.created, skipped: r.skipped, errors: r.errors?.length ? r.errors : undefined }));
}

const { leads = [], trash = [], ...rest } = backup;
await send({ ...rest, replaceConfig }, 'config/links/marketers/history');
const batches = (list, key) => {
  const out = [];
  let cur = [], size = 0;
  for (const l of list) {
    const n = JSON.stringify(l).length;
    if (cur.length && (cur.length >= 100 || size + n > 3_000_000)) { out.push(cur); cur = []; size = 0; }
    cur.push(l); size += n;
  }
  if (cur.length) out.push(cur);
  return out.map((b) => ({ [key]: b }));
};
let i = 0;
for (const b of batches(leads, 'leads')) await send(b, `leads batch ${++i}`);
for (const b of batches(trash, 'trash')) await send(b, `trash batch ${++i}`);
console.log('done');
