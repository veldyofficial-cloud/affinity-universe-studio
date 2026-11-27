// Request router + handlers for every /api/* endpoint. Uses Web-standard Request/Response,
// so the same code runs on Vercel (api/router.js), in the local dev server and in tests.
import { getStore } from './store.js';
import { HttpError, ConflictError, json, readJSON, readBody, parseCookies, cookie, isHttps, UUID_RE, str, clientIp, rateLimit, mapLimit, kstDate, randomId, randomCode } from './util.js';
import { authConfigured, createSessionCookie, clearSessionCookie, readSession, checkPassword, requireAdmin, actorName } from './auth.js';
import { mondayConfig, missingConfig, checkConnection, syncLead, reconcileItems, MondayError } from './monday.js';
import residenceOptions from './residence-options.js';

const P = {
  state: 'config/state.json',
  order: 'config/lead-order.json',
  lead: (id) => `leads/${id}.json`,
  leadHistDir: (id) => `history/leads/${id}/`,
  link: (id) => `links/${id}.json`,
  linkHistDir: (id) => `history/links/${id}/`,
  marketer: (id) => `marketers/${id}.json`,
  visit: (code, sid) => `visits/${code || '_direct'}/${sid}.json`,
  sync: (id) => `syncs/${id}.json`,
  mediaMeta: (id) => `media-meta/${id}.json`,
};
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const CONSULTATION_STATES = ['신규 문의', '상담 중', '등록 완료', '보류', '취소'];
const PAYMENT_STATES = ['결제 대기', '결제 확인', '부분 결제', '취소'];
const SOURCES = ['인스타그램', '스레드', '블로그', '유튜브', '지인 소개', '카톡 오픈채팅', '네이버카페', '기타'];
const MEDIA_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
const MB = 1024 * 1024;
const mediaLimit = (type) => (type.startsWith('video/') ? 25 * MB : 10 * MB);
const histKey = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomCode(6)}.json`;
const UNKNOWN = '확인 불가';

// ---------- storage helpers ----------
async function readAll(store, prefix) {
  const items = (await store.list(prefix)).filter((b) => b.pathname.endsWith('.json'));
  const docs = await mapLimit(items, 16, async (b) => (await store.getJSON(b.pathname))?.data);
  return docs.filter(Boolean);
}
async function mustLead(store, id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new HttpError(400, '상담 ID가 올바르지 않습니다.');
  const r = await store.getJSON(P.lead(id));
  if (!r) throw new HttpError(404, '상담을 찾을 수 없습니다.');
  return r;
}
async function writeHistory(store, dir, entry) {
  await store.putJSON(dir + histKey(), entry, { create: true });
}
async function visitCounts(store) {
  const counts = new Map();
  let total = 0;
  for (const b of await store.list('visits/')) {
    const code = b.pathname.split('/')[1];
    counts.set(code, (counts.get(code) || 0) + 1);
    total++;
  }
  return { counts, total };
}

// ---------- validation ----------
function cleanMedia(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > 12) throw new HttpError(400, '코스별 첨부 파일은 최대 12개입니다.');
  return list.map((m) => {
    if (!m || !UUID_RE.test(m.id)) throw new HttpError(400, '첨부 파일 정보가 올바르지 않습니다.');
    return { id: m.id, name: str(m.name, 200), kind: m.kind === 'video' ? 'video' : 'image', type: str(m.type, 40), size: Number(m.size) || 0 };
  });
}
function cleanPage(p, field) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.courses)) throw new HttpError(400, `${field} 형식이 올바르지 않습니다.`);
  if (p.courses.length > 40) throw new HttpError(400, '코스는 40개까지 추가할 수 있습니다.');
  return {
    title: str(p.title, 200, { field: '메인 문구' }),
    description: str(p.description, 1000, { field: '소개 문구' }),
    courses: p.courses.map((c) => {
      if (!c || typeof c !== 'object') throw new HttpError(400, '코스 형식이 올바르지 않습니다.');
      const media = cleanMedia(c.media);
      const coverId = typeof c.coverId === 'string' && media.some((m) => m.id === c.coverId) ? c.coverId : media[0]?.id || null;
      return { id: str(c.id, 64) || randomId(), name: str(c.name, 100, { field: '코스 이름' }), description: str(c.description, 400, { field: '코스 설명' }), media, coverId };
    }),
  };
}
function cleanRules(rules) {
  if (!Array.isArray(rules) || rules.length > 200) throw new HttpError(400, '응답 규칙 형식이 올바르지 않습니다.');
  return rules.map((r) => ({ id: str(r?.id, 64, { required: true, field: '규칙 ID' }), keyword: str(r.keyword, 300, { field: '키워드' }), reply: str(r.reply, 2000, { field: '응답 문구' }), enabled: Boolean(r.enabled) }));
}
function cleanConfig(c) {
  if (!c || typeof c !== 'object') throw new HttpError(400, '저장할 설정이 없습니다.');
  return { page: cleanPage(c.page, '페이지'), published: c.published == null ? null : cleanPage(c.published, '발행본'), rules: cleanRules(c.rules || []) };
}

function normalizeContact(b) {
  if (b.contactType === 'kakao') {
    const id = str(b.kakaoId, 50, { required: true, field: '카카오톡 아이디' });
    if (/[\s@]/.test(id)) throw new HttpError(400, '카카오톡 아이디를 확인해 주세요. 이메일이나 공백은 입력할 수 없습니다.');
    return { contactType: 'kakao', contact: '카카오톡 ID: ' + id, kakaoId: id, country: null, callingCode: null, phone: null };
  }
  if (b.contactType !== 'phone') throw new HttpError(400, '연락 방법을 선택해 주세요.');
  const code = String(b.callingCode || '').replace(/^\+/, '');
  if (!/^[1-9]\d{0,2}$/.test(code)) throw new HttpError(400, '국가번호를 확인해 주세요.');
  const number = String(b.phone || '').replace(/\D/g, '');
  if (number.length < 6 || number.length + code.length > 15) throw new HttpError(400, '전화번호의 자릿수를 확인해 주세요.');
  const country = /^([A-Z]{2}|OTHER)$/.test(String(b.country || '')) ? b.country : null;
  return { contactType: 'phone', contact: `+${code} ${number}`, country, callingCode: '+' + code, phone: number, kakaoId: null };
}

function validZone(z) {
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; }
}

function cleanResidence(r, required) {
  if (!r || typeof r !== 'object' || !r.countryCode) {
    if (required) throw new HttpError(400, '거주 국가를 선택해 주세요.');
    return null;
  }
  const c = residenceOptions.countries.find((x) => x.code === r.countryCode);
  if (!c) throw new HttpError(400, '거주 국가를 확인해 주세요.');
  const regions = residenceOptions.regions[c.code] || [];
  let regionCode = null, region;
  if (regions.length) {
    const hit = regions.find((x) => x[0] === r.regionCode);
    if (!hit) throw new HttpError(400, '거주 주 / 도를 선택해 주세요.');
    regionCode = hit[0];
    region = hit[1];
  } else region = str(r.region, 120, { required: true, field: '거주 지역' });
  if (!c.zones.some((z) => z.id === r.timezone)) throw new HttpError(400, '거주 지역 시간대를 선택해 주세요.');
  if (required && r.confirmed !== true) throw new HttpError(400, '거주 지역·시간대 확인에 체크해 주세요.');
  return { countryCode: c.code, country: c.name, regionCode, region, timezone: r.timezone, confirmed: r.confirmed === true };
}

function geo(request) {
  const h = (k) => {
    const v = request.headers.get(k);
    if (!v) return '';
    try { return decodeURIComponent(v); } catch { return v; }
  };
  const cc = h('x-vercel-ip-country').toUpperCase();
  let country = UNKNOWN;
  if (/^[A-Z]{2}$/.test(cc)) {
    try { country = new Intl.DisplayNames(['ko'], { type: 'region' }).of(cc) || cc; } catch { country = cc; }
  }
  const rc = h('x-vercel-ip-country-region');
  const regionName = (residenceOptions.regions[cc] || []).find((r) => r[0] === rc)?.[1];
  const tz = h('x-vercel-ip-timezone');
  return {
    locationCountryCode: /^[A-Z]{2}$/.test(cc) ? cc : null,
    locationCountry: country,
    locationRegion: regionName || rc || UNKNOWN,
    locationCity: h('x-vercel-ip-city') || UNKNOWN,
    locationTimezone: tz && validZone(tz) ? tz : UNKNOWN,
  };
}

const CHANNELS = [
  ['인스타그램', /instagram|^ig$/i], ['스레드', /threads/i], ['유튜브', /youtube|youtu\.be|^yt$/i],
  ['네이버카페', /cafe\.naver|navercafe|^cafe$/i], ['블로그', /blog/i], ['카톡 오픈채팅', /kakao/i],
  ['페이스북', /facebook|^fb$/i], ['네이버', /naver/i], ['구글', /google/i],
];
function detectChannel(landingUrl, referrer, ownHost) {
  let params = new URLSearchParams();
  try { params = new URL(landingUrl).searchParams; } catch {}
  const param = (params.get('utm_source') || params.get('ch') || params.get('channel') || '').slice(0, 80);
  let host = '';
  try { host = new URL(referrer).host.toLowerCase(); } catch {}
  if (host === ownHost) host = '';
  const classify = (v) => CHANNELS.find(([, re]) => re.test(v))?.[0] || null;
  if (param) return { channel: classify(param) || param, method: 'utm', param, host };
  if (host) return { channel: classify(host) || host, method: 'referrer', param: '', host };
  return { channel: null, method: 'direct', param: '', host: '' };
}

const OP_TEXT = ['studentName', 'classSchedule', 'instructor', 'specialNotes', 'studentDBId', 'country', 'region', 'city', 'timezone', 'availability', 'guardianName', 'device', 'preferredSchedule', 'paymentMethod', 'payerName', 'paymentEmail', 'confirmedCurriculum'];
const OP_DATE = ['trialDate', 'enrollmentDate', 'renewalDate', 'paymentDate'];
function cleanOperations(o) {
  if (o == null) return {};
  if (typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, '상담 정보 형식이 올바르지 않습니다.');
  const out = {};
  for (const k of OP_TEXT) if (k in o) out[k] = str(o[k], ['availability', 'preferredSchedule'].includes(k) ? 500 : 150, { field: k });
  for (const k of OP_DATE) if (k in o) {
    const v = str(o[k], 10, { field: k });
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, '날짜 형식이 올바르지 않습니다.');
    out[k] = v;
  }
  for (const k of ['amount', 'paidAmount']) if (k in o) {
    const n = Number(o[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1e10) throw new HttpError(400, '금액을 확인해 주세요.');
    out[k] = Math.round(n);
  }
  if ('commissionRate' in o) out.commissionRate = Number(o.commissionRate) === 20 ? 20 : 10;
  if ('paymentStatus' in o) {
    if (!PAYMENT_STATES.includes(o.paymentStatus)) throw new HttpError(400, '결제 상태가 올바르지 않습니다.');
    out.paymentStatus = o.paymentStatus;
  }
  if (out.paymentEmail && !/^[^\s@]+@[^\s@]+$/.test(out.paymentEmail)) throw new HttpError(400, '결제 이메일을 확인해 주세요.');
  if (out.timezone && !validZone(out.timezone)) throw new HttpError(400, '고객 시간대 ID를 확인해 주세요. 예: America/Los_Angeles');
  return out;
}

const historySnapshot = (l) => ({ status: l.status, note: l.note, operations: l.operations, archived: !!l.archived, deleted: !!l.deleted, opsRevision: l.opsRevision });

// ---------- link lookup (cached briefly per instance) ----------
let linkCache = { at: 0, links: null };
async function allLinks(store, fresh = false) {
  if (!fresh && linkCache.links && Date.now() - linkCache.at < 30000) return linkCache.links;
  const links = await readAll(store, 'links/');
  linkCache = { at: Date.now(), links };
  return links;
}
function invalidateLinks() { linkCache = { at: 0, links: null }; }

// ---------- handlers ----------
const routes = {};
const route = (method, path, fn) => (routes[method + ' ' + path] = fn);

route('GET', 'public', async (req, { store }) => {
  let page = null;
  try { page = (await store.getJSON(P.state))?.data?.config?.published || null; } catch (e) { console.error('public: store', e?.message); }
  return json({ page, admin: Boolean(readSession(req)) });
});

route('GET', 'residence-options', async () => json(residenceOptions, 200, { 'Cache-Control': 'public, max-age=3600' }));

route('POST', 'login', async (req) => {
  if (!authConfigured()) throw new HttpError(503, '관리자 로그인이 설정되지 않았습니다. ADMIN_PASSWORD와 SESSION_SECRET(16자 이상)을 설정해 주세요.');
  rateLimit('login:' + clientIp(req), 10, 15 * 60e3);
  const b = await readJSON(req, 8 * 1024);
  if (!checkPassword(b.password)) throw new HttpError(401, '비밀번호가 올바르지 않습니다.');
  return json({ ok: true }, 200, { 'Set-Cookie': createSessionCookie(req, str(b.name, 40)) });
});

route('POST', 'logout', async (req) => json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(req) }));

route('POST', 'visit', async (req, { store }) => {
  rateLimit('visit:' + clientIp(req), 60, 10 * 60e3);
  const b = await readJSON(req, 16 * 1024);
  const cookies = parseCookies(req);
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  const secure = isHttps(req);
  let sid = cookies.au_sid;
  if (!sid || !UUID_RE.test(sid)) {
    sid = randomId();
    headers.append('Set-Cookie', cookie('au_sid', sid, { secure })); // session cookie
  }
  if (readSession(req)) return new Response(JSON.stringify({ ok: true, recorded: false, reason: 'admin' }), { headers });
  const code = str(b.code, 40);
  const link = code && /^[A-Za-z0-9_-]+$/.test(code) ? (await allLinks(store)).find((l) => l.code === code) : null;
  const ownHost = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  const ch = detectChannel(str(b.landingUrl, 2000), str(b.referrer, 2000), ownHost);
  try {
    await store.putJSON(P.visit(link?.code, sid), { at: new Date().toISOString(), code: link?.code || null, channel: ch.channel, method: ch.method, referrerHost: ch.host, timezone: str(b.timezone, 64) }, { create: true });
  } catch (e) { if (!(e instanceof ConflictError)) throw e; } // same session already counted
  if (link || !cookies.au_ref) {
    const ref = { code: link?.code || '', channel: ch.channel, method: ch.method, param: ch.param, host: ch.host, at: Date.now() };
    headers.append('Set-Cookie', cookie('au_ref', JSON.stringify(ref), { maxAge: 30 * 86400, secure }));
  }
  return new Response(JSON.stringify({ ok: true, recorded: true }), { headers });
});

route('POST', 'inquiries', async (req, { store }) => {
  const session = readSession(req);
  const b = await readJSON(req, 64 * 1024);
  const asAdmin = Boolean(session && b.manual === true);
  if (asAdmin) requireAdmin(req);
  else rateLimit('inquiry:' + clientIp(req), 5, 10 * 60e3);
  if (!UUID_RE.test(String(b.id || '')) && !(asAdmin && b.imported && SAFE_ID.test(String(b.id || '')))) throw new HttpError(400, '요청 형식이 올바르지 않습니다. 페이지를 새로고침해 주세요.');
  if (b.consent?.accepted !== true) throw new HttpError(400, '정보 수집·이용 동의는 필수입니다.');
  const name = str(b.name, 60, { required: true, field: '이름' });
  const contact = normalizeContact(b);
  const imported = asAdmin && b.imported === true;
  let source = str(b.source, 40, { field: '유입 경로' });
  if (!imported && !SOURCES.includes(source)) throw new HttpError(400, '유입 경로를 선택해 주세요.');
  const sourceDetail = source === '기타' ? str(b.sourceDetail, 100, { required: !imported, field: '유입 경로' }) : '';
  const residence = cleanResidence(b.residence, !asAdmin);
  const now = new Date();
  let submittedAt = now.toISOString();
  if (imported && !Number.isNaN(Date.parse(b.submittedAt || b.createdAt))) submittedAt = new Date(b.submittedAt || b.createdAt).toISOString();
  const lead = {
    id: b.id,
    name,
    ...contact,
    consent: { accepted: true, at: imported ? b.consent?.at || submittedAt : now.toISOString() },
    source,
    sourceDetail,
    course: str(b.course, 100) || '상담 후 결정',
    message: str(b.message, 2000, { field: '문의 내용' }),
    manual: asAdmin,
    ...(imported ? { imported: true, importedAt: now.toISOString() } : {}),
    timezone: str(b.timezone, 64),
    residence,
    status: imported && CONSULTATION_STATES.includes(b.status) ? b.status : '신규 문의',
    date: imported && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : kstDate(new Date(submittedAt)),
    submittedAt,
    createdAt: submittedAt,
    note: imported ? str(b.note, 3000) : '',
    operations: imported ? cleanOperations(b.operations) : {device: str(b.device, 40)},
    language: str(b.language, 20),
    archived: false,
    deleted: false,
    opsRevision: 0,
    referralCode: null, linkId: null, marketerId: null, marketerName: null, referralChannel: null, channelMethod: null, attributionParam: null, referrerHost: null,
    ...(asAdmin ? { locationCountry: UNKNOWN, locationRegion: UNKNOWN, locationCity: UNKNOWN, locationTimezone: UNKNOWN } : geo(req)),
  };
  if (!asAdmin) {
    let ref = null;
    try { ref = JSON.parse(parseCookies(req).au_ref || 'null'); } catch {}
    if (ref && typeof ref === 'object') {
      lead.referralChannel = typeof ref.channel === 'string' ? ref.channel.slice(0, 80) : null;
      lead.channelMethod = ['utm', 'referrer', 'direct'].includes(ref.method) ? ref.method : null;
      lead.attributionParam = typeof ref.param === 'string' ? ref.param.slice(0, 80) : null;
      lead.referrerHost = typeof ref.host === 'string' ? ref.host.slice(0, 200) : null;
      const link = ref.code ? (await allLinks(store, true)).find((l) => l.code === ref.code) : null;
      if (link) {
        lead.referralCode = link.code;
        lead.linkId = link.id;
        if (link.active && link.marketer_id) {
          const m = (await store.getJSON(P.marketer(link.marketer_id)))?.data;
          if (m) { lead.marketerId = m.id; lead.marketerName = m.name; }
        }
      }
    }
  }
  try {
    await store.putJSON(P.lead(lead.id), lead, { create: true });
  } catch (e) {
    if (e instanceof ConflictError) return json({ ok: true, id: lead.id, duplicate: true }); // retried submit
    throw e;
  }
  await writeHistory(store, P.leadHistDir(lead.id), { at: submittedAt, actor: asAdmin ? actorName(session) : '고객 접수', after_json: JSON.stringify(historySnapshot(lead)) });
  if (!asAdmin) {
    try { if (!mondayConfig().token || !mondayConfig().distanceBoard) throw new Error(); await sendLeadToMonday(store, lead); }
    catch { return json({ ok: true, id: lead.id, mondayPending: true }); }
  }
  return json({ ok: true, id: lead.id });
});

route('GET', 'admin/state', async (req, { store }) => {
  requireAdmin(req);
  const [state, order, leads, syncs, visits] = await Promise.all([
    store.getJSON(P.state), store.getJSON(P.order), readAll(store, 'leads/'), readAll(store, 'syncs/'), visitCounts(store),
  ]);
  leads.sort((a, b) => String(a.submittedAt || a.createdAt || '').localeCompare(String(b.submittedAt || b.createdAt || '')));
  const imported = (await allLinks(store)).reduce((n, l) => n + (Number(l.importedVisits) || 0), 0);
  const cfg = state?.data?.config;
  return json({
    config: cfg ? { page: cfg.page, published: cfg.published, rules: cfg.rules } : null,
    revision: state?.data?.revision ?? 0,
    leads: leads.filter((l) => !l.deleted),
    trash: leads.filter((l) => l.deleted),
    leadOrder: order?.data?.ids || [],
    orderRevision: order?.data?.revision ?? 0,
    syncs: syncs.map((s) => ({ lead_id: s.lead_id, state: s.state, summary: s.summary, destinations: s.destinations || null, error: s.error || null, distance_id: s.distance_id || null, revenue_id: s.revenue_id || null })),
    visits: visits.total + imported + (Number(state?.data?.importedVisits) || 0),
  });
});

route('PUT', 'admin/state', async (req, { store }) => {
  const session = requireAdmin(req);
  const b = await readJSON(req, 2 * MB);
  const config = cleanConfig(b.config);
  const cur = await store.getJSON(P.state);
  const curRev = cur?.data?.revision ?? 0;
  if (b.revision !== curRev) throw new HttpError(409, '다른 화면에서 먼저 저장된 변경 사항이 있습니다. 새로고침 후 다시 시도해 주세요.', { revision: curRev });
  const next = { ...(cur?.data || {}), config: { ...(cur?.data?.config || {}), ...config }, revision: curRev + 1, updatedAt: new Date().toISOString(), updatedBy: actorName(session) };
  try {
    await store.putJSON(P.state, next, cur ? { ifMatch: cur.etag } : { create: true });
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, '다른 화면에서 먼저 저장된 변경 사항이 있습니다. 새로고침 후 다시 시도해 주세요.');
    throw e;
  }
  return json({ revision: next.revision });
});

route('PATCH', 'admin/leads', async (req, { store }) => {
  const session = requireAdmin(req);
  const b = await readJSON(req, 64 * 1024);
  const { data: lead, etag } = await mustLead(store, b.id);
  if ((b.opsRevision ?? 0) !== (lead.opsRevision || 0)) throw new HttpError(409, '다른 곳에서 이 상담이 먼저 수정되었습니다. 새로고침 후 다시 시도해 주세요.');
  const next = { ...lead };
  if ('status' in b) {
    if (!CONSULTATION_STATES.includes(b.status)) throw new HttpError(400, '상담 상태가 올바르지 않습니다.');
    next.status = b.status;
  }
  if ('note' in b) next.note = str(b.note, 3000, { field: '상담 메모' });
  if ('operations' in b) next.operations = { ...(lead.operations || {}), ...cleanOperations(b.operations) };
  if ('archived' in b) next.archived = Boolean(b.archived);
  if ('deleted' in b) next.deleted = Boolean(b.deleted);
  next.opsRevision = (lead.opsRevision || 0) + 1;
  next.updatedAt = new Date().toISOString();
  try {
    await store.putJSON(P.lead(lead.id), next, { ifMatch: etag });
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, '다른 곳에서 이 상담이 먼저 수정되었습니다. 새로고침 후 다시 시도해 주세요.');
    throw e;
  }
  await writeHistory(store, P.leadHistDir(lead.id), { at: next.updatedAt, actor: actorName(session), after_json: JSON.stringify(historySnapshot(next)) });
  const sync = await store.getJSON(P.sync(lead.id));
  if (sync?.data?.state === 'synced') {
    try { await store.putJSON(P.sync(lead.id), { ...sync.data, state: 'pending', summary: '변경 사항 있음 · Monday 재전송 대기' }, { ifMatch: sync.etag }); } catch (e) { if (!(e instanceof ConflictError)) throw e; }
  }
  return json({ lead: next });
});

route('POST', 'admin/lead-history', async (req, { store }) => {
  requireAdmin(req);
  const b = await readJSON(req, 8 * 1024);
  if (typeof b.id !== 'string' || !SAFE_ID.test(b.id)) throw new HttpError(400, '상담 ID가 올바르지 않습니다.');
  const history = (await readAll(store, P.leadHistDir(b.id))).sort((a, c) => String(a.at).localeCompare(String(c.at)));
  return json({ history });
});

route('POST', 'admin/lead-order', async (req, { store }) => {
  requireAdmin(req);
  const b = await readJSON(req, 2 * MB);
  if (!Array.isArray(b.ids) || b.ids.length > 50000 || !b.ids.every((id) => typeof id === 'string' && SAFE_ID.test(id))) throw new HttpError(400, '순서 정보가 올바르지 않습니다.');
  const cur = await store.getJSON(P.order);
  const curRev = cur?.data?.revision ?? 0;
  if (b.revision !== curRev) throw new HttpError(409, '다른 곳에서 순서가 먼저 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
  try {
    await store.putJSON(P.order, { ids: [...new Set(b.ids)], revision: curRev + 1, updatedAt: new Date().toISOString() }, cur ? { ifMatch: cur.etag } : { create: true });
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, '다른 곳에서 순서가 먼저 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
    throw e;
  }
  return json({ ok: true, revision: curRev + 1 });
});

// ----- marketers & links -----
route('GET', 'admin/links', async (req, { store }) => {
  requireAdmin(req);
  const [links, marketers, history, visits] = await Promise.all([allLinks(store, true), readAll(store, 'marketers/'), readAll(store, 'history/links/'), visitCounts(store)]);
  const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  return json({
    links: links.sort(byCreated).map((l) => ({ ...l, visits: (visits.counts.get(l.code) || 0) + (Number(l.importedVisits) || 0) })),
    marketers: marketers.sort(byCreated),
    history: history.sort((a, b) => String(a.at).localeCompare(String(b.at))),
  });
});

route('POST', 'admin/marketers', async (req, { store }) => {
  requireAdmin(req);
  const b = await readJSON(req, 8 * 1024);
  const m = { id: randomId(), name: str(b.name, 100, { required: true, field: '이름' }), active: true, createdAt: new Date().toISOString() };
  await store.putJSON(P.marketer(m.id), m, { create: true });
  return json({ marketer: m });
});

route('PATCH', 'admin/marketers', async (req, { store }) => {
  requireAdmin(req);
  const b = await readJSON(req, 8 * 1024);
  if (!UUID_RE.test(String(b.id || '')) && !SAFE_ID.test(String(b.id || ''))) throw new HttpError(400, '마케터 ID가 올바르지 않습니다.');
  const cur = await store.getJSON(P.marketer(b.id));
  if (!cur) throw new HttpError(404, '마케터를 찾을 수 없습니다.');
  const active = b.active !== false;
  if (!active && cur.data.active && (await allLinks(store, true)).some((l) => l.active && l.marketer_id === b.id)) {
    throw new HttpError(409, '이 마케터에게 배정된 활성 링크가 있습니다. 링크를 재배정하거나 비활성화한 후 퇴사 처리해 주세요.');
  }
  const next = { ...cur.data, name: str(b.name, 100, { required: true, field: '이름' }), active, updatedAt: new Date().toISOString() };
  try { await store.putJSON(P.marketer(b.id), next, { ifMatch: cur.etag }); } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, '다른 곳에서 먼저 수정되었습니다. 새로고침 후 다시 시도해 주세요.');
    throw e;
  }
  return json({ marketer: next });
});

async function activeMarketer(store, id, allowInactive) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new HttpError(400, '담당 마케터를 선택해 주세요.');
  const m = (await store.getJSON(P.marketer(id)))?.data;
  if (!m) throw new HttpError(400, '담당 마케터를 찾을 수 없습니다.');
  if (!m.active && !allowInactive) throw new HttpError(400, '퇴사 / 비활성 마케터에게는 링크를 배정할 수 없습니다.');
  return m;
}

route('POST', 'admin/links', async (req, { store }) => {
  const session = requireAdmin(req);
  const b = await readJSON(req, 8 * 1024);
  const label = str(b.label, 100, { required: true, field: '링크 이름' });
  await activeMarketer(store, b.marketer_id, false);
  const existing = new Set((await allLinks(store, true)).map((l) => l.code));
  let code;
  do code = randomCode(10); while (existing.has(code));
  const link = { id: randomId(), code, label, marketer_id: b.marketer_id, active: b.active !== false, revision: 1, createdAt: new Date().toISOString() };
  await store.putJSON(P.link(link.id), link, { create: true });
  invalidateLinks();
  await writeHistory(store, P.linkHistDir(link.id), { link_id: link.id, before_json: null, after_json: JSON.stringify(link), at: link.createdAt, actor: actorName(session) });
  return json({ link });
});

route('PATCH', 'admin/links', async (req, { store }) => {
  const session = requireAdmin(req);
  const b = await readJSON(req, 8 * 1024);
  if (typeof b.id !== 'string' || !SAFE_ID.test(b.id)) throw new HttpError(400, '링크 ID가 올바르지 않습니다.');
  const cur = await store.getJSON(P.link(b.id));
  if (!cur) throw new HttpError(404, '링크를 찾을 수 없습니다.');
  if (b.revision !== cur.data.revision) throw new HttpError(409, '다른 곳에서 이 링크가 먼저 수정되었습니다. 새로고침 후 다시 시도해 주세요.');
  const marketerId = b.marketer_id ?? cur.data.marketer_id;
  await activeMarketer(store, marketerId, marketerId === cur.data.marketer_id);
  const next = { ...cur.data, label: str(b.label ?? cur.data.label, 100, { required: true, field: '링크 이름' }), marketer_id: marketerId, active: b.active !== false, revision: cur.data.revision + 1, updatedAt: new Date().toISOString() };
  try { await store.putJSON(P.link(b.id), next, { ifMatch: cur.etag }); } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, '다른 곳에서 이 링크가 먼저 수정되었습니다. 새로고침 후 다시 시도해 주세요.');
    throw e;
  }
  invalidateLinks();
  await writeHistory(store, P.linkHistDir(b.id), { link_id: b.id, before_json: JSON.stringify(cur.data), after_json: JSON.stringify(next), at: next.updatedAt, actor: actorName(session) });
  return json({ link: next });
});

// ----- media -----
function safeFileName(name, type) {
  const ext = MEDIA_TYPES[type];
  const base = String(name || 'file').replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'file';
  return `${base}.${ext}`;
}
function mediaType(raw) {
  const t = String(raw || '').split(';')[0].trim().toLowerCase();
  if (!MEDIA_TYPES[t]) throw new HttpError(415, '사진(JPG·PNG·WebP·GIF)과 MP4·WebM 동영상만 첨부할 수 있습니다.');
  return t;
}
async function registerMedia(store, { id, pathname, name, type, size }) {
  const meta = { id, pathname, name, kind: type.startsWith('video/') ? 'video' : 'image', type, size, createdAt: new Date().toISOString() };
  await store.putJSON(P.mediaMeta(id), meta, { create: true });
  return { id, name, kind: meta.kind, type, size };
}

route('POST', 'admin/media', async (req, { store }) => {
  requireAdmin(req);
  const type = mediaType(req.headers.get('content-type'));
  let name = 'file';
  try { name = decodeURIComponent(req.headers.get('x-file-name') || 'file'); } catch {}
  name = name.slice(0, 200);
  const body = await readBody(req, mediaLimit(type));
  if (!body.byteLength) throw new HttpError(400, '빈 파일은 첨부할 수 없습니다.');
  const id = randomId();
  const pathname = `media/${id}/${safeFileName(name, type)}`;
  await store.putFile(pathname, body, { contentType: type });
  return json(await registerMedia(store, { id, pathname, name, type, size: body.byteLength }));
});

const MEDIA_PATH = /^media\/([0-9a-f-]{36})\/[\w.-]{1,80}$/i;

// Client-upload token endpoint for files larger than the 4.5 MB function body limit
// (protocol of @vercel/blob/client `upload()`).
route('POST', 'admin/media/upload', async (req, { store }) => {
  requireAdmin(req);
  if (store.kind !== 'blob') throw new HttpError(501, '대용량 업로드는 Vercel Blob 환경에서만 지원합니다.');
  const body = await readJSON(req, 16 * 1024);
  if (body.type !== 'blob.generate-client-token') throw new HttpError(400, '지원하지 않는 업로드 요청입니다.');
  const { handleUpload } = await import('@vercel/blob/client');
  const result = await handleUpload({
    request: req,
    body,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const m = MEDIA_PATH.exec(pathname);
      if (!m || !UUID_RE.test(m[1])) throw new HttpError(400, '업로드 경로가 올바르지 않습니다.');
      let type;
      try { type = mediaType(JSON.parse(clientPayload || '{}').type); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, '파일 형식을 확인해 주세요.'); }
      return { allowedContentTypes: [type], maximumSizeInBytes: mediaLimit(type), addRandomSuffix: false, allowOverwrite: false, validUntil: Date.now() + 15 * 60e3 };
    },
  });
  return json(result);
});

route('POST', 'admin/media/complete', async (req, { store }) => {
  requireAdmin(req);
  const b = await readJSON(req, 8 * 1024);
  const m = MEDIA_PATH.exec(String(b.pathname || ''));
  if (!m || !UUID_RE.test(m[1])) throw new HttpError(400, '업로드 경로가 올바르지 않습니다.');
  const h = await store.head(b.pathname);
  if (!h) throw new HttpError(404, '업로드된 파일을 찾을 수 없습니다.');
  const type = mediaType(h.contentType);
  if (h.size > mediaLimit(type)) {
    await store.del(b.pathname);
    throw new HttpError(413, '사진·GIF는 10MB, MP4·WebM은 25MB 이내로 선택해 주세요.');
  }
  try {
    return json(await registerMedia(store, { id: m[1], pathname: b.pathname, name: str(b.name, 200) || 'file', type, size: h.size }));
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, '이미 등록된 파일입니다.');
    throw e;
  }
});

async function serveMedia(req, { store }, id) {
  if (!UUID_RE.test(id)) throw new HttpError(404, '파일을 찾을 수 없습니다.');
  const meta = (await store.getJSON(P.mediaMeta(id)))?.data;
  if (!meta) throw new HttpError(404, '파일을 찾을 수 없습니다.');
  const cache = { 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' };
  const f = await store.getFile(meta.pathname, { range: req.headers.get('range') || undefined });
  if (!f) throw new HttpError(404, '파일을 찾을 수 없습니다.');
  const headers = new Headers(f.headers);
  for (const [k, v] of Object.entries({ ...cache, 'Content-Type': meta.type, 'Accept-Ranges': 'bytes' })) headers.set(k, v);
  return new Response(req.method === 'HEAD' ? null : f.body, { status: f.status, headers });
}

// ----- Monday -----
function mondayUnavailable() {
  const missing = missingConfig();
  if (missing.length) throw new HttpError(503, `Monday 연동이 설정되지 않았습니다. Vercel 환경 변수 ${missing.join(', ')}을(를) 추가해 주세요.`, { provider: { status: 'binding_unavailable' } });
}

route('POST', 'admin/monday/check', async (req) => {
  requireAdmin(req);
  try {
    return json(await checkConnection());
  } catch (e) {
    if (e instanceof MondayError) return json({ ready: false, summary: e.message, checks: [], provider: e.provider });
    throw e;
  }
});

route('POST', 'admin/monday/sync', async (req, { store }) => {
  requireAdmin(req);
  const b = await readJSON(req, 8 * 1024);
  if (b.confirm !== true) throw new HttpError(400, 'Monday 기록 동의에 체크해 주세요.');
  mondayUnavailable();
  const { data: lead } = await mustLead(store, b.id);
  if ((b.opsRevision ?? 0) !== (lead.opsRevision || 0)) throw new HttpError(409, '상담 정보가 변경되었습니다. 새로고침 후 다시 전송해 주세요.');
  return sendLeadToMonday(store, lead);
});

async function sendLeadToMonday(store, lead) {
  const cur = await store.getJSON(P.sync(lead.id));
  const prev = cur?.data || { lead_id: lead.id };
  if (['running', 'review'].includes(prev.state)) {
    throw new HttpError(409, '이전 전송 결과를 확인해야 합니다. 중복 생성을 막기 위해 ‘기존 아이템 ID 확인 · 연결’로 먼저 연결해 주세요.', { provider: { status: 'review_required' } });
  }
  let doc = { ...prev, lead_id: lead.id, state: 'running', summary: '전송 중', error: null, startedAt: new Date().toISOString() };
  let etag;
  try {
    ({ etag } = await store.putJSON(P.sync(lead.id), doc, cur ? { ifMatch: cur.etag } : { create: true }));
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, '이미 전송 중입니다. 잠시 후 새로고침해 주세요.');
    throw e;
  }
  const write = async (patch) => {
    doc = { ...doc, ...patch };
    ({ etag } = await store.putJSON(P.sync(lead.id), doc, { ifMatch: etag }));
  };
  try {
    const result = await syncLead(lead, doc, write);
    await write({ ...result, state: 'synced', summary: 'Monday 동기화 완료', syncedAt: new Date().toISOString(), syncedOpsRevision: lead.opsRevision || 0, error: null });
    return json({ ok: true, summary: lead.status === '등록 완료' ? 'Distance와 Revenue에 반영했습니다.' : 'Distance에 반영했습니다. Revenue는 등록 완료 건만 반영합니다.' });
  } catch (e) {
    const ambiguous = e instanceof MondayError ? e.ambiguous : true;
    await write({ state: ambiguous ? 'review' : 'error', summary: ambiguous ? '결과 확인 필요' : '전송 실패 · 다시 시도해 주세요', error: e.message }).catch((w) => console.error('sync state write failed', w));
    if (e instanceof MondayError) throw new HttpError(e.status === 429 ? 429 : 502, e.message, { provider: e.provider });
    throw e;
  }
}

route('POST', 'admin/monday/reconcile', async (req, { store }) => {
  requireAdmin(req);
  const b = await readJSON(req, 8 * 1024);
  mondayUnavailable();
  const { data: lead } = await mustLead(store, b.id);
  let ids;
  try {
    ids = await reconcileItems(lead, { distanceId: str(b.distanceId, 20), revenueId: str(b.revenueId, 20) });
  } catch (e) {
    if (e instanceof MondayError) throw new HttpError(e.status === 400 ? 400 : 502, e.message, { provider: e.provider });
    throw e;
  }
  const cur = await store.getJSON(P.sync(lead.id));
  const doc = {
    ...(cur?.data || {}), lead_id: lead.id, ...ids, state: 'pending', summary: '기존 아이템 연결 확인 · 다시 전송할 수 있습니다', error: null, reconciledAt: new Date().toISOString(),
    destinations: {
      distance: { state: ids.distance_id ? 'linked' : 'pending', label: ids.distance_id ? '연결 확인' : '미생성', itemId: ids.distance_id },
      revenue: { state: ids.revenue_id ? 'linked' : 'pending', label: ids.revenue_id ? '연결 확인' : '미생성', reason: '다시 전송하면 연결된 아이템을 갱신합니다.', itemId: ids.revenue_id },
    },
  };
  try { await store.putJSON(P.sync(lead.id), doc, cur ? { ifMatch: cur.etag } : { create: true }); } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, '다른 곳에서 먼저 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
    throw e;
  }
  return json({ ok: true });
});

// ----- backup import -----
// Accepts the UI backup file (affinity-studio-backup.json = {...data, ...linkData}) or a chunk
// of it. Idempotent: existing records (same id) are skipped, never overwritten.
route('POST', 'admin/import', async (req, { store }) => {
  const session = requireAdmin(req);
  const b = await readJSON(req, 4 * MB);
  const replaceConfig = new URL(req.url).searchParams.get('replaceConfig') === '1' || b.replaceConfig === true;
  const report = { created: {}, skipped: {}, errors: [] };
  const bump = (k, kind) => (report[kind][k] = (report[kind][k] || 0) + 1);
  const create = async (kind, path, doc) => {
    try { await store.putJSON(path, doc, { create: true }); bump(kind, 'created'); } catch (e) {
      if (e instanceof ConflictError) bump(kind, 'skipped'); else throw e;
    }
  };
  const ok = (id) => typeof id === 'string' && SAFE_ID.test(id);
  const now = new Date().toISOString();

  if (b.page) {
    const config = { ...cleanConfig({ page: b.page, published: b.published ?? null, rules: b.rules || [] }), posts: Array.isArray(b.posts) ? b.posts.slice(0, 1000) : [], events: Array.isArray(b.events) ? b.events.slice(0, 5000) : [] };
    const cur = await store.getJSON(P.state);
    if (!cur || replaceConfig) {
      const next = { ...(cur?.data || {}), config, revision: (cur?.data?.revision ?? 0) + 1, updatedAt: now, updatedBy: actorName(session) + ' · 백업 가져오기' };
      await store.putJSON(P.state, next, cur ? { ifMatch: cur.etag } : { create: true });
      bump('config', 'created');
    } else bump('config', 'skipped');
  }
  for (const m of Array.isArray(b.marketers) ? b.marketers : []) {
    if (!ok(m?.id)) { report.errors.push('marketer: invalid id'); continue; }
    await create('marketers', P.marketer(m.id), { id: m.id, name: str(m.name, 100) || '이름 없음', active: m.active !== false && m.active !== 0, createdAt: m.createdAt || m.created_at || now, importedAt: now });
  }
  for (const l of Array.isArray(b.links) ? b.links : []) {
    if (!ok(l?.id) || typeof l.code !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(l.code)) { report.errors.push('link: invalid id/code'); continue; }
    await create('links', P.link(l.id), { id: l.id, code: l.code, label: str(l.label, 100) || l.code, marketer_id: l.marketer_id || null, active: l.active !== false && l.active !== 0, revision: Number(l.revision) || 1, createdAt: l.createdAt || l.created_at || now, importedVisits: Number(l.visits) || 0, importedAt: now });
  }
  invalidateLinks();
  for (const h of Array.isArray(b.history) ? b.history : []) {
    if (!ok(h?.link_id)) { report.errors.push('history: invalid link_id'); continue; }
    const key = Buffer.from(`${h.at}|${h.after_json}`).toString('base64url').slice(-40);
    await create('history', `${P.linkHistDir(h.link_id)}import-${key}.json`, { link_id: h.link_id, before_json: h.before_json ?? null, after_json: String(h.after_json ?? '{}'), at: h.at || now, actor: str(h.actor, 100) || '가져오기' });
  }
  const importLead = async (l, deleted) => {
    if (!l || typeof l !== 'object' || !ok(l.id)) { report.errors.push('lead: invalid id'); return; }
    if (JSON.stringify(l).length > 64 * 1024) { report.errors.push(`lead ${l.id}: too large`); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? l.date : kstDate(new Date(Date.parse(l.submittedAt || l.createdAt) || Date.now()));
    await create('leads', P.lead(l.id), { ...l, date, status: CONSULTATION_STATES.includes(l.status) ? l.status : '신규 문의', opsRevision: Number(l.opsRevision) || 0, deleted: deleted || Boolean(l.deleted), imported: true, importedAt: now });
  };
  for (const l of Array.isArray(b.leads) ? b.leads : []) await importLead(l, false);
  for (const l of Array.isArray(b.trash) ? b.trash : []) await importLead(l, true);
  for (const s of Array.isArray(b.syncs) ? b.syncs : []) {
    if (!ok(s?.lead_id)) continue;
    await create('syncs', P.sync(s.lead_id), { lead_id: s.lead_id, state: ['synced', 'pending', 'review'].includes(s.state) ? s.state : 'pending', summary: s.summary || '가져온 동기화 기록', destinations: s.destinations || null, distance_id: s.distance_id || null, revenue_id: s.revenue_id || null, importedAt: now });
  }
  if (Array.isArray(b.leadOrder) && b.leadOrder.every(ok)) await create('leadOrder', P.order, { ids: b.leadOrder, revision: 1, updatedAt: now });
  return json({ ok: true, ...report });
});

// ---------- entry ----------
export async function handle(request, ctx = {}) {
  const url = new URL(request.url);
  let path = url.searchParams.get('__path');
  if (path == null) path = url.pathname.replace(/^\/api\/?/, '');
  path = path.replace(/^\/+|\/+$/g, '');
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  try {
    const store = ctx.store || (await getStore());
    const c = { store };
    if (method === 'GET' && path.startsWith('media/')) return await serveMedia(request, c, path.slice(6));
    const fn = routes[method + ' ' + path];
    if (!fn) {
      if (Object.keys(routes).some((k) => k.endsWith(' ' + path))) return json({ error: '지원하지 않는 요청 방식입니다.' }, 405);
      return json({ error: '요청한 API를 찾을 수 없습니다.' }, 404);
    }
    return await fn(request, c);
  } catch (e) {
    if (e instanceof HttpError) {
      const headers = e.extra?.retryAfterMs ? { 'Retry-After': String(Math.ceil(e.extra.retryAfterMs / 1000)) } : {};
      return json({ error: e.message, ...e.extra }, e.status, headers);
    }
    if (e?.status === 503) return json({ error: e.message }, 503);
    console.error('[api]', method, path, e);
    return json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 500);
  }
}
