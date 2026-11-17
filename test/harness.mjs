// Endpoint test harness: runs lib/app.js handlers against the file-system store adapter
// (same interface as the Vercel Blob adapter) and a fake Monday GraphQL API.
//   node test/harness.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'correct horse battery';
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef';
delete process.env.BLOB_READ_WRITE_TOKEN;
for (const k of Object.keys(process.env)) if (k.startsWith('MONDAY_')) delete process.env[k];

const { handle } = await import('../lib/app.js');
const { createFsStore } = await import('../lib/store-fs.js');
const { _resetRateLimits } = await import('../lib/util.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'au-test-'));
const store = createFsStore(dir);
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const BASE = 'https://studio.example.com';
const GEO = { 'x-vercel-ip-country': 'US', 'x-vercel-ip-country-region': 'CA', 'x-vercel-ip-city': 'San%20Jose', 'x-vercel-ip-timezone': 'America/Los_Angeles' };
let ipCounter = 1;

async function call(method, p, { body, cookie, headers = {}, raw } = {}) {
  const h = new Headers({ host: 'studio.example.com', 'x-forwarded-proto': 'https', 'x-real-ip': headers.ip || '10.0.0.' + ipCounter, ...headers });
  h.delete('ip');
  if (cookie) h.set('cookie', cookie);
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined && !['GET', 'HEAD'].includes(method)) { payload = JSON.stringify(body); h.set('content-type', 'application/json'); }
  const req = new Request(BASE + '/api/' + p, { method, headers: h, body: payload });
  const res = await handle(req, { store });
  const text = res.body ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  let data = null;
  try { data = JSON.parse(text.toString('utf8')); } catch {}
  return { status: res.status, data, text, headers: res.headers, cookies: res.headers.getSetCookie() };
}
const cookieOf = (r, name) => r.cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));

let admin;
const residence = { countryCode: 'US', regionCode: 'CA', region: '', timezone: 'America/Los_Angeles', confirmed: true };
const inquiry = (over = {}) => ({
  id: crypto.randomUUID(), name: '홍길동', contactType: 'phone', contact: '+1 4155550100', country: 'US', callingCode: '+1', phone: '4155550100', kakaoId: null,
  consent: { accepted: true }, source: '인스타그램', sourceDetail: null, course: '아트북', message: '문의합니다', manual: false, timezone: 'America/Los_Angeles', residence, ...over,
});

test('auth: visitor is never admin, login/logout, forged and expired cookies', async () => {
  let r = await call('GET', 'public');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { page: null, admin: false });
  r = await call('POST', 'login', { body: { password: 'wrong' } });
  assert.equal(r.status, 401);
  r = await call('POST', 'login', { body: { password: process.env.ADMIN_PASSWORD, name: '테스터' } });
  assert.equal(r.status, 200);
  const set = r.cookies.find((c) => c.startsWith('au_admin='));
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);
  admin = cookieOf(r, 'au_admin');
  r = await call('GET', 'public', { cookie: admin });
  assert.equal(r.data.admin, true);
  // tampered payload
  const [payload, mac] = admin.slice('au_admin='.length).split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 1e9, name: 'x' })).toString('base64url');
  r = await call('GET', 'public', { cookie: `au_admin=${forgedPayload}.${mac}` });
  assert.equal(r.data.admin, false);
  r = await call('GET', 'admin/state', { cookie: `au_admin=${forgedPayload}.${mac}` });
  assert.equal(r.status, 403);
  // expired cookie signed with the real secret
  const { createHmac } = await import('node:crypto');
  const exp = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() - 1000 })).toString('base64url');
  const expMac = createHmac('sha256', process.env.SESSION_SECRET).update(exp).digest('base64url');
  r = await call('GET', 'admin/state', { cookie: `au_admin=${exp}.${expMac}` });
  assert.equal(r.status, 403);
  assert.ok(payload);
  r = await call('POST', 'logout', { cookie: admin });
  assert.match(r.cookies[0], /Max-Age=0/);
});

test('auth: login disabled without ADMIN_PASSWORD / short SESSION_SECRET', async () => {
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'short';
  const r = await call('POST', 'login', { body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(r.status, 503);
  const r2 = await call('GET', 'public', { cookie: admin });
  assert.equal(r2.data.admin, false);
  process.env.SESSION_SECRET = saved;
});

test('auth: every admin endpoint rejects visitors (403)', async () => {
  const endpoints = [
    ['GET', 'admin/state'], ['PUT', 'admin/state'], ['GET', 'admin/links'], ['POST', 'admin/links'], ['PATCH', 'admin/links'],
    ['POST', 'admin/marketers'], ['PATCH', 'admin/marketers'], ['PATCH', 'admin/leads'], ['POST', 'admin/lead-order'], ['POST', 'admin/lead-history'],
    ['POST', 'admin/media'], ['POST', 'admin/media/upload'], ['POST', 'admin/media/complete'], ['POST', 'admin/monday/check'], ['POST', 'admin/monday/sync'],
    ['POST', 'admin/monday/reconcile'], ['POST', 'admin/import'],
  ];
  for (const [m, p] of endpoints) {
    const r = await call(m, p, { body: {} });
    assert.equal(r.status, 403, `${m} ${p} should be 403, got ${r.status}`);
  }
  // cross-site origin is rejected even with a valid cookie
  const r = await call('PUT', 'admin/state', { cookie: admin, body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal((await call('GET', 'nope')).status, 404);
  assert.equal((await call('DELETE', 'public')).status, 405);
});

test('config: revision checks, conflicts, publish', async () => {
  let r = await call('GET', 'admin/state', { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.config, null);
  assert.equal(r.data.revision, 0);
  assert.deepEqual([r.data.leads, r.data.trash, r.data.leadOrder, r.data.syncs, r.data.orderRevision, r.data.visits], [[], [], [], [], 0, 0]);
  const page = { title: '제목', description: '설명', courses: [{ id: 'c1', name: '아트북', description: 'd', media: [] }] };
  const config = { page, published: null, rules: [{ id: 'r1', keyword: '클래스', reply: '안녕하세요', enabled: true }] };
  r = await call('PUT', 'admin/state', { cookie: admin, body: { config, revision: 0 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.revision, 1);
  r = await call('PUT', 'admin/state', { cookie: admin, body: { config, revision: 0 } });
  assert.equal(r.status, 409, 'stale revision must conflict');
  assert.equal(r.data.revision, 1);
  // two concurrent writers with the same revision: exactly one wins
  const [a, b] = await Promise.all([1, 2].map(() => call('PUT', 'admin/state', { cookie: admin, body: { config, revision: 1 } })));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  r = await call('PUT', 'admin/state', { cookie: admin, body: { config: { ...config, published: page }, revision: 2 } });
  assert.equal(r.data.revision, 3);
  r = await call('GET', 'public');
  assert.equal(r.data.page.title, '제목');
  assert.equal(r.data.admin, false);
  r = await call('PUT', 'admin/state', { cookie: admin, body: { config: { page: { title: 1 } }, revision: 3 } });
  assert.equal(r.status, 400);
});

test('residence options', async () => {
  const r = await call('GET', 'residence-options');
  assert.ok(r.data.countries.length > 200);
  assert.ok(r.data.regions.US.length > 40);
});

let marketer, link;
test('marketers & links: create, revision conflict, reassignment rules, history', async () => {
  let r = await call('POST', 'admin/marketers', { cookie: admin, body: { name: '마케터 A', active: true } });
  assert.equal(r.status, 200);
  marketer = r.data.marketer;
  const m2 = (await call('POST', 'admin/marketers', { cookie: admin, body: { name: '마케터 B' } })).data.marketer;
  r = await call('POST', 'admin/links', { cookie: admin, body: { label: 'A 대표 링크', marketer_id: marketer.id, active: true } });
  assert.equal(r.status, 200);
  link = r.data.link;
  assert.match(link.code, /^[a-z0-9]{10}$/);
  r = await call('PATCH', 'admin/links', { cookie: admin, body: { id: link.id, label: 'A 링크', marketer_id: marketer.id, active: true, revision: 99 } });
  assert.equal(r.status, 409);
  r = await call('PATCH', 'admin/marketers', { cookie: admin, body: { id: marketer.id, name: '마케터 A', active: false } });
  assert.equal(r.status, 409, 'cannot retire marketer with active links');
  r = await call('PATCH', 'admin/links', { cookie: admin, body: { id: link.id, label: 'A 링크', marketer_id: m2.id, active: true, revision: 1 } });
  assert.equal(r.status, 200);
  r = await call('PATCH', 'admin/marketers', { cookie: admin, body: { id: m2.id, name: '마케터 B', active: false } });
  assert.equal(r.status, 409);
  r = await call('PATCH', 'admin/links', { cookie: admin, body: { id: link.id, label: 'A 링크', marketer_id: marketer.id, active: true, revision: 2 } });
  assert.equal(r.status, 200);
  r = await call('PATCH', 'admin/marketers', { cookie: admin, body: { id: m2.id, name: '마케터 B (퇴사)', active: false } });
  assert.equal(r.status, 200);
  r = await call('POST', 'admin/links', { cookie: admin, body: { label: 'x', marketer_id: m2.id, active: true } });
  assert.equal(r.status, 400, 'inactive marketer cannot get new links');
  r = await call('GET', 'admin/links', { cookie: admin });
  assert.equal(r.data.links.length, 1);
  assert.equal(r.data.links[0].revision, 3);
  assert.equal(r.data.marketers.length, 2);
  assert.equal(r.data.history.filter((h) => h.link_id === link.id).length, 3);
  assert.equal(r.data.history[0].before_json, null);
});

let visitorCookies;
test('visit: per-session counting and attribution cookie', async () => {
  let r = await call('POST', 'visit', { body: { code: link.code, referrer: '', landingUrl: `${BASE}/consult?ref=${link.code}&utm_source=instagram`, timezone: 'Asia/Seoul' } });
  assert.equal(r.status, 200);
  const sid = cookieOf(r, 'au_sid'), ref = cookieOf(r, 'au_ref');
  assert.ok(sid && ref);
  visitorCookies = `${sid}; ${ref}`;
  r = await call('POST', 'visit', { cookie: visitorCookies, body: { code: link.code, referrer: '', landingUrl: `${BASE}/consult?ref=${link.code}`, timezone: 'Asia/Seoul' } });
  assert.equal(r.data.recorded, true);
  await call('POST', 'visit', { body: { code: '', referrer: 'https://m.blog.naver.com/x', landingUrl: `${BASE}/consult` } });
  await call('POST', 'visit', { body: { code: 'unknown-code', referrer: '', landingUrl: `${BASE}/consult` } });
  r = await call('POST', 'visit', { cookie: admin, body: { code: link.code } });
  assert.equal(r.data.recorded, false, 'admin preview not counted');
  r = await call('GET', 'admin/links', { cookie: admin });
  assert.equal(r.data.links[0].visits, 1, 'same session counted once');
  r = await call('GET', 'admin/state', { cookie: admin });
  assert.equal(r.data.visits, 3);
  r = await call('POST', 'visit', { raw: 'not json', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
});

let lead1;
test('inquiries: validation, geo snapshot, attribution, idempotency, rate limit', async () => {
  ipCounter = 50;
  const bad = [
    [{ consent: { accepted: false } }, /동의/],
    [{ name: '  ' }, /이름/],
    [{ phone: '12' }, /자릿수/],
    [{ callingCode: '+0' }, /국가번호/],
    [{ contactType: 'kakao', kakaoId: 'a b' }, /카카오톡/],
    [{ source: '' }, /유입 경로/],
    [{ source: '기타', sourceDetail: '' }, /유입 경로/],
    [{ residence: { ...residence, timezone: 'Asia/Seoul' } }, /시간대/],
    [{ residence: { ...residence, confirmed: false } }, /확인/],
    [{ residence: null }, /거주 국가/],
    [{ id: 'not-a-uuid' }, /형식/],
    [{ message: 'x'.repeat(2001) }, /너무/],
  ];
  for (const [over, re] of bad) {
    _resetRateLimits();
    const r = await call('POST', 'inquiries', { body: inquiry(over), headers: GEO });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.data.error, re);
  }
  _resetRateLimits();
  lead1 = inquiry();
  let r = await call('POST', 'inquiries', { cookie: visitorCookies, body: lead1, headers: GEO });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('POST', 'inquiries', { cookie: visitorCookies, body: lead1, headers: GEO });
  assert.equal(r.data.duplicate, true, 'double submit is idempotent');
  // visitor claiming manual:true is still treated as a visitor (residence required)
  r = await call('POST', 'inquiries', { body: inquiry({ manual: true, residence: null }) });
  assert.equal(r.status, 400);
  const kakao = await call('POST', 'inquiries', { body: inquiry({ contactType: 'kakao', kakaoId: 'kakao_id1', phone: null, callingCode: null, residence: { countryCode: 'KR', region: '서울특별시', timezone: 'Asia/Seoul', confirmed: true } }) });
  assert.equal(kakao.status, 200);
  for (let i = 0; i < 3; i++) await call('POST', 'inquiries', { body: inquiry() });
  r = await call('POST', 'inquiries', { body: inquiry() });
  assert.equal(r.status, 429, 'sixth inquiry from same IP within 10 min is limited');
  // admin manual add (no residence, no geo)
  r = await call('POST', 'inquiries', { cookie: admin, body: inquiry({ manual: true, residence: null, name: '직접 추가' }), headers: GEO });
  assert.equal(r.status, 200);
  r = await call('GET', 'admin/state', { cookie: admin });
  const l = r.data.leads.find((x) => x.id === lead1.id);
  assert.equal(l.status, '신규 문의');
  assert.equal(l.contact, '+1 4155550100');
  assert.equal(l.locationCountry, '미국');
  assert.equal(l.locationRegion, '캘리포니아 · California');
  assert.equal(l.locationCity, 'San Jose');
  assert.equal(l.locationTimezone, 'America/Los_Angeles');
  assert.equal(l.residence.country, '미국');
  assert.equal(l.residence.region, '캘리포니아 · California');
  assert.equal(l.referralCode, link.code);
  assert.equal(l.marketerId, marketer.id);
  assert.equal(l.marketerName, '마케터 A');
  assert.equal(l.referralChannel, '인스타그램');
  assert.equal(l.channelMethod, 'utm');
  assert.match(l.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(l.opsRevision, 0);
  const manual = r.data.leads.find((x) => x.name === '직접 추가');
  assert.equal(manual.manual, true);
  assert.equal(manual.locationCountry, '확인 불가');
  assert.equal(manual.marketerId, null);
  const kl = r.data.leads.find((x) => x.contactType === 'kakao');
  assert.equal(kl.contact, '카카오톡 ID: kakao_id1');
  assert.equal(kl.residence.region, '서울특별시');
  ipCounter = 1;
});

test('leads: patch, opsRevision conflict, history, trash/restore, order', async () => {
  let r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: lead1.id, opsRevision: 0, status: '상담 중' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.lead.opsRevision, 1);
  r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: lead1.id, opsRevision: 0, status: '보류' } });
  assert.equal(r.status, 409);
  r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: lead1.id, opsRevision: 1, status: '등록 완료', note: '메모', operations: { paymentStatus: '부분 결제', amount: 300000, paidAmount: 100000, commissionRate: 20, trialDate: '2026-11-20', studentName: '홍길동' }, sync: false } });
  assert.equal(r.status, 200);
  assert.equal(r.data.lead.operations.paidAmount, 100000);
  r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: lead1.id, opsRevision: 2, operations: { trialDate: 'tomorrow' } } });
  assert.equal(r.status, 400);
  r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: lead1.id, opsRevision: 2, status: '없는 상태' } });
  assert.equal(r.status, 400);
  r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: '../../etc', opsRevision: 0 } });
  assert.equal(r.status, 400);
  r = await call('POST', 'admin/lead-history', { cookie: admin, body: { id: lead1.id } });
  assert.equal(r.data.history.length, 3);
  assert.equal(JSON.parse(r.data.history[2].after_json).status, '등록 완료');
  assert.equal(r.data.history[2].actor, '관리자 · 테스터');
  assert.equal(r.data.history[0].actor, '고객 접수');
  const other = (await call('GET', 'admin/state', { cookie: admin })).data.leads.find((x) => x.name === '직접 추가');
  r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: other.id, opsRevision: 0, deleted: true } });
  let s = (await call('GET', 'admin/state', { cookie: admin })).data;
  assert.ok(s.trash.some((x) => x.id === other.id));
  assert.ok(!s.leads.some((x) => x.id === other.id));
  r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: other.id, opsRevision: 1, deleted: false } });
  s = (await call('GET', 'admin/state', { cookie: admin })).data;
  assert.ok(s.leads.some((x) => x.id === other.id));
  const ids = s.leads.map((x) => x.id).reverse();
  r = await call('POST', 'admin/lead-order', { cookie: admin, body: { ids, revision: 0 } });
  assert.equal(r.status, 200);
  r = await call('POST', 'admin/lead-order', { cookie: admin, body: { ids, revision: 0 } });
  assert.equal(r.status, 409);
  s = (await call('GET', 'admin/state', { cookie: admin })).data;
  assert.deepEqual(s.leadOrder, ids);
  assert.equal(s.orderRevision, 1);
});

test('media: upload raw body, fetch, range, type/size limits', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 7)]);
  let r = await call('POST', 'admin/media', { cookie: admin, raw: png, headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('코스 사진.png') } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const m = r.data;
  assert.deepEqual([m.kind, m.type, m.size, m.name], ['image', 'image/png', png.length, '코스 사진.png']);
  r = await call('GET', 'media/' + m.id);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok(r.text.equals(png));
  r = await call('GET', 'media/' + m.id, { headers: { range: 'bytes=0-7' } });
  assert.equal(r.status, 206);
  assert.equal(r.text.length, 8);
  assert.match(r.headers.get('content-range'), /^bytes 0-7\/2008$/);
  r = await call('POST', 'admin/media', { cookie: admin, raw: 'x', headers: { 'content-type': 'text/html' } });
  assert.equal(r.status, 415);
  r = await call('POST', 'admin/media', { cookie: admin, raw: Buffer.alloc(10 * 1024 * 1024 + 1), headers: { 'content-type': 'image/jpeg' } });
  assert.equal(r.status, 413);
  r = await call('POST', 'admin/media', { raw: png, headers: { 'content-type': 'image/png' } });
  assert.equal(r.status, 403);
  assert.equal((await call('GET', 'media/' + crypto.randomUUID())).status, 404);
  assert.equal((await call('GET', 'media/..%2F..%2Fconfig')).status, 404);
  r = await call('POST', 'admin/media/upload', { cookie: admin, body: { type: 'blob.generate-client-token', payload: {} } });
  assert.equal(r.status, 501, 'client upload needs real Vercel Blob');
  // the page config accepts uploaded media references
  const st = (await call('GET', 'admin/state', { cookie: admin })).data;
  const page = { ...st.config.page, courses: [{ ...st.config.page.courses[0], media: [m], coverId: m.id }] };
  r = await call('PUT', 'admin/state', { cookie: admin, body: { config: { ...st.config, page, published: page }, revision: st.revision } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', 'public')).data.page.courses[0].media[0].id, m.id);
});

// ---------- fake Monday ----------
function fakeMonday() {
  const s = { items: new Map(), nextId: 1000, fail: null, calls: [] };
  const boards = {
    111: { id: '111', name: '[TEST] AF DISTANCE', columns: [{ id: 'name', title: 'Name', type: 'name' }, { id: 'subitems', title: 'Subitems', type: 'subtasks', settings_str: '{"boardIds":[112]}' }] },
    112: { id: '112', name: 'Subitems of DISTANCE', columns: [{ id: 'name', type: 'name' }, { id: 'text_contact', title: '연락처', type: 'text' }, { id: 'status_1', title: '상태', type: 'status' }, { id: 'date_1', title: '트라이얼', type: 'date' }] },
    222: { id: '222', name: '[TEST] 2026 REVENUE', columns: [{ id: 'name', type: 'name' }, { id: 'numbers_cost', title: '비용', type: 'numbers' }, { id: 'status_pay', title: '결제', type: 'status' }, { id: 'check_20', title: '20%', type: 'checkbox' }] },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://api.monday.com/v2') return original(url, init);
    const { query, variables: v } = JSON.parse(init.body);
    const op = /\{\s*(\w+)/.exec(query.replace(/^(query|mutation)[^{]*/, ''))[1];
    s.calls.push(op);
    if (init.headers.Authorization !== 'tok') return new Response('{}', { status: 401 });
    if (s.fail === op) { s.fail = null; throw new TypeError('fetch failed (socket hang up)'); }
    const ok = (data) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    const mk = (name, board, parent) => { const id = String(s.nextId++); s.items.set(id, { id, name, board: { id: board }, parent_item: parent ? { id: parent } : null, values: {} }); return s.items.get(id); };
    switch (op) {
      case 'boards': return ok({ boards: v.ids.map((id) => boards[id]).filter(Boolean) });
      case 'items_page_by_column_values': return ok({ items_page_by_column_values: { items: [...s.items.values()].filter((i) => i.board.id === v.b && v.v.includes(i.name)) } });
      case 'create_item': return ok({ create_item: mk(v.n, v.b) });
      case 'create_subitem': return ok({ create_subitem: mk(v.n, '112', v.p) });
      case 'change_multiple_column_values': { const it = s.items.get(v.i); Object.assign(it.values, JSON.parse(v.v)); return ok({ change_multiple_column_values: { id: v.i } }); }
      case 'items': return ok({ items: v.ids.map((id) => s.items.get(id)).filter(Boolean) });
      default: return new Response(JSON.stringify({ errors: [{ message: 'unknown ' + op }] }), { status: 200 });
    }
  };
  return s;
}

test('monday: clear errors when not configured', async () => {
  let r = await call('POST', 'admin/monday/check', { cookie: admin, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.ready, false);
  assert.match(r.data.summary, /MONDAY_API_TOKEN/);
  assert.equal(r.data.checks.length, 2);
  r = await call('POST', 'admin/monday/sync', { cookie: admin, body: { id: lead1.id, opsRevision: 2, confirm: true } });
  assert.equal(r.status, 503);
  assert.equal(r.data.provider.status, 'binding_unavailable');
  r = await call('POST', 'admin/monday/reconcile', { cookie: admin, body: { id: lead1.id } });
  assert.equal(r.status, 503);
  process.env.MONDAY_API_TOKEN = 'tok';
  process.env.MONDAY_DISTANCE_BOARD_ID = '111';
  process.env.MONDAY_REVENUE_BOARD_ID = '222';
  process.env.MONDAY_DISTANCE_COLUMNS = '{oops';
  r = await call('POST', 'admin/monday/check', { cookie: admin, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.ready, false);
  assert.match(r.data.summary, /JSON/);
});

test('monday: check, sync (create then update), ambiguous failure -> review -> reconcile', async () => {
  const fake = fakeMonday();
  process.env.MONDAY_DISTANCE_COLUMNS = JSON.stringify({ contact: 'text_contact', status: 'status_1', trialDate: 'date_1' });
  process.env.MONDAY_REVENUE_COLUMNS = JSON.stringify({ cost: 'numbers_cost', revenueStatus: 'status_pay', commission20: 'check_20' });
  let r = await call('POST', 'admin/monday/check', { cookie: admin, body: {} });
  assert.equal(r.data.ready, true, JSON.stringify(r.data));
  process.env.MONDAY_API_TOKEN = 'bad';
  r = await call('POST', 'admin/monday/check', { cookie: admin, body: {} });
  assert.equal(r.data.ready, false);
  assert.match(r.data.summary, /토큰/);
  process.env.MONDAY_API_TOKEN = 'tok';

  r = await call('POST', 'admin/monday/sync', { cookie: admin, body: { id: lead1.id, opsRevision: 1, confirm: true } });
  assert.equal(r.status, 409, 'stale opsRevision');
  r = await call('POST', 'admin/monday/sync', { cookie: admin, body: { id: lead1.id, opsRevision: 2 } });
  assert.equal(r.status, 400, 'confirm required');
  r = await call('POST', 'admin/monday/sync', { cookie: admin, body: { id: lead1.id, opsRevision: 2, confirm: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const items = [...fake.items.values()];
  const month = items.find((i) => i.board.id === '111');
  const sub = items.find((i) => i.board.id === '112');
  const rev = items.find((i) => i.board.id === '222');
  assert.match(month.name, /^\d{4}-\d{2}$/);
  assert.equal(sub.name, `홍길동 [AU:${lead1.id}]`);
  assert.deepEqual(sub.values, { text_contact: '+1 4155550100', status_1: { label: '등록 완료' }, date_1: { date: '2026-11-20' } });
  assert.deepEqual(rev.values, { numbers_cost: '100000', status_pay: { label: 'SPLIT' }, check_20: { checked: 'true' } });
  let s = (await call('GET', 'admin/state', { cookie: admin })).data.syncs.find((x) => x.lead_id === lead1.id);
  assert.equal(s.state, 'synced');
  assert.equal(s.destinations.distance.itemId, sub.id);
  assert.equal(s.destinations.revenue.itemId, rev.id);
  // second sync updates the same items
  const before = fake.items.size;
  r = await call('POST', 'admin/monday/sync', { cookie: admin, body: { id: lead1.id, opsRevision: 2, confirm: true } });
  assert.equal(r.status, 200);
  assert.equal(fake.items.size, before, 'no duplicates on re-sync');
  // editing a synced lead marks it pending again
  await call('PATCH', 'admin/leads', { cookie: admin, body: { id: lead1.id, opsRevision: 2, note: '수정' } });
  s = (await call('GET', 'admin/state', { cookie: admin })).data.syncs.find((x) => x.lead_id === lead1.id);
  assert.equal(s.state, 'pending');

  // ambiguous network failure while creating -> review; further syncs are blocked
  const l2 = (await call('GET', 'admin/state', { cookie: admin })).data.leads.find((x) => x.contactType === 'kakao');
  fake.fail = 'create_subitem';
  r = await call('POST', 'admin/monday/sync', { cookie: admin, body: { id: l2.id, opsRevision: 0, confirm: true } });
  assert.equal(r.status, 502);
  s = (await call('GET', 'admin/state', { cookie: admin })).data.syncs.find((x) => x.lead_id === l2.id);
  assert.equal(s.state, 'review');
  r = await call('POST', 'admin/monday/sync', { cookie: admin, body: { id: l2.id, opsRevision: 0, confirm: true } });
  assert.equal(r.status, 409);
  assert.equal(r.data.provider.status, 'review_required');
  // reconcile: wrong item is rejected, empty ids = nothing was created
  r = await call('POST', 'admin/monday/reconcile', { cookie: admin, body: { id: l2.id, distanceId: sub.id, revenueId: '' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /식별자/);
  r = await call('POST', 'admin/monday/reconcile', { cookie: admin, body: { id: l2.id, distanceId: 'abc' } });
  assert.equal(r.status, 400);
  r = await call('POST', 'admin/monday/reconcile', { cookie: admin, body: { id: l2.id, distanceId: '', revenueId: '' } });
  assert.equal(r.status, 200);
  r = await call('POST', 'admin/monday/sync', { cookie: admin, body: { id: l2.id, opsRevision: 0, confirm: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.summary, /Revenue는 등록 완료 건만/);
  s = (await call('GET', 'admin/state', { cookie: admin })).data.syncs.find((x) => x.lead_id === l2.id);
  assert.equal(s.destinations.revenue.state, 'skipped');
  for (const k of Object.keys(process.env)) if (k.startsWith('MONDAY_')) delete process.env[k];
});

test('import: backup JSON is ingested idempotently', async () => {
  const backup = {
    page: { title: '가져온 페이지', description: 'd', courses: [{ name: '픽처북', description: '' }] },
    published: null,
    leads: [
      { id: 'legacy-1', name: '기존 고객', contact: '+82 1012345678', contactType: 'phone', course: '픽처북', source: '블로그', date: '2026-10-01', status: '상담 중', message: '', submittedAt: '2026-10-01T01:00:00.000Z', operations: { paymentStatus: '결제 확인' }, opsRevision: 4 },
      { id: crypto.randomUUID(), name: '두번째', contact: '카카오톡 ID: abc', course: '아트북', source: '기타', date: '2026-10-02', status: '신규 문의', message: 'm' },
    ],
    rules: [{ id: 'r9', keyword: '수강료', reply: '안내', enabled: true }],
    posts: [], events: [],
    links: [{ id: 'old-link', code: 'oldcode123', label: '이전 링크', marketer_id: 'old-mkt', active: 1, visits: 42, revision: 3 }],
    marketers: [{ id: 'old-mkt', name: '이전 마케터', active: 1 }],
    history: [{ link_id: 'old-link', before_json: null, after_json: '{"active":true,"marketer_id":"old-mkt"}', at: '2026-09-01T00:00:00Z', actor: 'staff@x' }],
  };
  let r = await call('POST', 'admin/import', { body: backup });
  assert.equal(r.status, 403);
  r = await call('POST', 'admin/import', { cookie: admin, body: backup });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.created, { marketers: 1, links: 1, history: 1, leads: 2 });
  assert.equal(r.data.skipped.config, 1, 'existing config kept unless replaceConfig');
  r = await call('POST', 'admin/import', { cookie: admin, body: backup });
  assert.deepEqual(r.data.created, {});
  assert.equal(r.data.skipped.leads, 2);
  r = await call('POST', 'admin/import?replaceConfig=1', { cookie: admin, body: { page: backup.page, published: null, rules: backup.rules } });
  assert.equal(r.data.created.config, 1);
  const s = (await call('GET', 'admin/state', { cookie: admin })).data;
  assert.equal(s.config.page.title, '가져온 페이지');
  const legacy = s.leads.find((x) => x.id === 'legacy-1');
  assert.equal(legacy.status, '상담 중');
  assert.equal(legacy.opsRevision, 4);
  assert.equal(legacy.imported, true);
  assert.equal(s.visits, 3 + 42);
  const links = (await call('GET', 'admin/links', { cookie: admin })).data;
  assert.equal(links.links.find((l) => l.id === 'old-link').visits, 42);
  // imported legacy lead can be edited with its preserved opsRevision
  r = await call('PATCH', 'admin/leads', { cookie: admin, body: { id: 'legacy-1', opsRevision: 4, status: '등록 완료' } });
  assert.equal(r.status, 200);
  // the UI's "import from this browser" path (POST inquiries with imported:true)
  r = await call('POST', 'inquiries', { cookie: admin, body: inquiry({ manual: true, imported: true, residence: null, status: '보류', date: '2026-09-09', submittedAt: '2026-09-09T03:00:00Z' }) });
  assert.equal(r.status, 200);
  const imp = (await call('GET', 'admin/state', { cookie: admin })).data.leads.find((x) => x.date === '2026-09-09');
  assert.equal(imp.status, '보류');
});
