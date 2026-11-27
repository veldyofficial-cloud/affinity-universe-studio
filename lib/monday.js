// Monday.com GraphQL integration (Distance + Revenue boards).
//
// Distance board: one parent item per month ("YYYY-MM" from the lead's KST date) and
// one subitem per consultation named "<name> [AU:<leadId>]".
// Revenue board: one item per consultation, only when status is "등록 완료".
// Column mapping is configured with env JSON (field -> column id); see README.

const ENDPOINT = 'https://api.monday.com/v2';

export class MondayError extends Error {
  constructor(message, { ambiguous = false, status = 502, provider } = {}) {
    super(message);
    this.ambiguous = ambiguous;
    this.status = status;
    this.provider = provider;
  }
}

function parseColumns(raw, name) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return Object.fromEntries(Object.entries(v).filter(([k, c]) => FIELDS[k] && typeof c === 'string' && c));
  } catch {
    throw new MondayError(`${name} 환경 변수의 JSON 형식이 올바르지 않습니다.`, { status: 500, provider: { status: 'misconfigured' } });
  }
}

export function mondayConfig() {
  const env = process.env;
  return {
    token: env.MONDAY_API_TOKEN || '',
    apiVersion: env.MONDAY_API_VERSION || '',
    distanceBoard: env.MONDAY_DISTANCE_BOARD_ID || '',
    revenueBoard: env.MONDAY_REVENUE_BOARD_ID || '',
    distanceGroup: env.MONDAY_DISTANCE_GROUP_ID || '',
    revenueGroup: env.MONDAY_REVENUE_GROUP_ID || '',
    distanceColumns: () => parseColumns(env.MONDAY_DISTANCE_COLUMNS, 'MONDAY_DISTANCE_COLUMNS'),
    revenueColumns: () => parseColumns(env.MONDAY_REVENUE_COLUMNS, 'MONDAY_REVENUE_COLUMNS'),
  };
}

export function missingConfig(cfg = mondayConfig()) {
  const missing = [];
  if (!cfg.token) missing.push('MONDAY_API_TOKEN');
  if (!cfg.distanceBoard) missing.push('MONDAY_DISTANCE_BOARD_ID');
  if (!cfg.revenueBoard) missing.push('MONDAY_REVENUE_BOARD_ID');
  return missing;
}

const op = (l) => ({ paymentStatus: '결제 대기', amount: 0, paidAmount: 0, commissionRate: 10, ...(l.operations || {}) });

export function revenueStatus(l) {
  const o = op(l);
  const paid = Number(o.paidAmount) || 0, total = Number(o.amount) || 0;
  if (paid <= 0) return 'DUE';
  if (o.paymentStatus === '결제 확인' || (total > 0 && paid >= total)) return 'CLEAR';
  return 'SPLIT';
}

// Every field that can be mapped to a Monday column.
export const FIELDS = {
  leadId: (l) => l.id,
  identifier: (l) => `[AU:${l.id}]`,
  name: (l) => l.name,
  contact: (l) => l.contact,
  phone: (l) => (l.contactType === 'phone' ? `${l.callingCode || ''}${l.phone || ''}` : ''),
  kakaoId: (l) => l.kakaoId || '',
  course: (l) => l.course,
  source: (l) => [l.source, l.sourceDetail].filter(Boolean).join(' · '),
  status: (l) => l.status,
  message: (l) => [l.message, l.operations?.device && '보유 기기: ' + l.operations.device, l.language && '수업 언어: ' + l.language].filter(Boolean).join('\n'),
  language: (l) => l.language,
  note: (l) => l.note,
  date: (l) => l.date,
  submittedAt: (l) => l.submittedAt,
  marketer: (l) => l.marketerName || '',
  referralCode: (l) => l.referralCode || '',
  referralChannel: (l) => l.referralChannel || '',
  country: (l) => op(l).country || l.residence?.country || l.locationCountry || '',
  region: (l) => op(l).region || l.residence?.region || l.locationRegion || '',
  timezone: (l) => op(l).timezone || l.residence?.timezone || l.locationTimezone || '',
  guardianName: (l) => op(l).guardianName,
  availability: (l) => op(l).availability,
  device: (l) => op(l).device,
  preferredSchedule: (l) => op(l).preferredSchedule,
  confirmedCurriculum: (l) => op(l).confirmedCurriculum,
  studentName: (l) => op(l).studentName || l.name,
  classSchedule: (l) => op(l).classSchedule,
  instructor: (l) => op(l).instructor,
  specialNotes: (l) => op(l).specialNotes,
  studentDBId: (l) => op(l).studentDBId,
  trialDate: (l) => op(l).trialDate,
  enrollmentDate: (l) => op(l).enrollmentDate,
  renewalDate: (l) => op(l).renewalDate,
  paymentStatus: (l) => op(l).paymentStatus,
  paymentMethod: (l) => op(l).paymentMethod,
  payerName: (l) => op(l).payerName,
  paymentEmail: (l) => op(l).paymentEmail,
  paymentDate: (l) => op(l).paymentDate,
  amount: (l) => Number(op(l).amount) || 0,
  paidAmount: (l) => Number(op(l).paidAmount) || 0,
  cost: (l) => Number(op(l).paidAmount) || 0,
  revenueStatus: (l) => revenueStatus(l),
  commission20: (l) => Number(op(l).commissionRate) === 20,
};

function formatValue(type, value, lead) {
  if (value === undefined || value === null) value = '';
  switch (type) {
    case 'long_text': return { text: String(value) };
    case 'numbers': case 'numeric': return value === '' ? '' : String(Number(value) || 0);
    case 'status': case 'color': return value === '' ? null : { label: String(value) };
    case 'dropdown': return value === '' ? null : { labels: [String(value)] };
    case 'date': return /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? { date: String(value).slice(0, 10) } : null;
    case 'checkbox': return value ? { checked: 'true' } : null;
    case 'email': return value ? { email: String(value), text: String(value) } : null;
    case 'phone': return value ? { phone: String(value).replace(/[^\d+]/g, ''), countryShortName: lead.country || '' } : null;
    case 'link': return value ? { url: String(value), text: String(value) } : null;
    default: return String(value);
  }
}

export function buildColumnValues(lead, mapping, columns) {
  const types = new Map(columns.map((c) => [c.id, c.type]));
  const out = {};
  for (const [field, colId] of Object.entries(mapping)) {
    if (!types.has(colId)) continue;
    out[colId] = formatValue(types.get(colId), FIELDS[field](lead), lead);
  }
  return out;
}

export function createClient(cfg = mondayConfig(), fetchImpl = globalThis.fetch) {
  async function gql(query, variables = {}, { mutation = false } = {}) {
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: cfg.token, ...(cfg.apiVersion ? { 'API-Version': cfg.apiVersion } : {}) },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new MondayError('Monday 서버에 연결하지 못했습니다: ' + (e?.message || e), { ambiguous: mutation });
    }
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (res.status === 401 || res.status === 403) throw new MondayError('Monday API 토큰이 유효하지 않거나 권한이 없습니다.', { status: 502, provider: { status: 'unauthorized' } });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') || 30) * 1000;
      throw new MondayError('Monday API 호출 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.', { status: 429, provider: { status: 'rate_limited', retryAfterMs: retry } });
    }
    if (res.status >= 500 || !body) throw new MondayError(`Monday 응답 오류 (${res.status})`, { ambiguous: mutation });
    if (body.errors?.length || body.error_message) {
      const msg = body.errors?.map((e) => e.message).join(' / ') || body.error_message;
      throw new MondayError('Monday 오류: ' + msg);
    }
    return body.data;
  }

  async function boardInfo(id) {
    const d = await gql('query($ids:[ID!]){ boards(ids:$ids){ id name columns { id title type settings_str } } }', { ids: [String(id)] });
    return d.boards?.[0] || null;
  }

  async function subitemBoardId(board) {
    const col = board.columns.find((c) => c.type === 'subtasks');
    if (!col) return null;
    try { return JSON.parse(col.settings_str || '{}').boardIds?.[0] ?? null; } catch { return null; }
  }

  async function columnsOf(boardId) {
    const b = await boardInfo(boardId);
    return b?.columns || [];
  }

  async function items(ids) {
    if (!ids.length) return [];
    const d = await gql('query($ids:[ID!]){ items(ids:$ids){ id name board { id } parent_item { id } } }', { ids: ids.map(String) });
    return d.items || [];
  }

  async function findOrCreateMonth(boardId, groupId, month) {
    const d = await gql(
      'query($b:ID!,$v:[String]!){ items_page_by_column_values(board_id:$b, limit:5, columns:[{column_id:"name", column_values:$v}]){ items { id name } } }',
      { b: String(boardId), v: [month] },
    );
    const hit = d.items_page_by_column_values?.items?.find((i) => i.name === month);
    if (hit) return hit.id;
    const c = await gql(
      'mutation($b:ID!,$n:String!,$g:String){ create_item(board_id:$b, item_name:$n, group_id:$g){ id } }',
      { b: String(boardId), n: month, g: groupId || null },
      { mutation: true },
    );
    return c.create_item.id;
  }

  async function createSubitem(parentId, name) {
    const d = await gql('mutation($p:ID!,$n:String!){ create_subitem(parent_item_id:$p, item_name:$n){ id board { id } } }', { p: String(parentId), n: name }, { mutation: true });
    return d.create_subitem;
  }

  async function createItem(boardId, groupId, name) {
    const d = await gql('mutation($b:ID!,$n:String!,$g:String){ create_item(board_id:$b, item_name:$n, group_id:$g){ id board { id } } }', { b: String(boardId), n: name, g: groupId || null }, { mutation: true });
    return d.create_item;
  }

  async function updateColumns(boardId, itemId, values) {
    if (!Object.keys(values).length) return;
    await gql(
      'mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v, create_labels_if_missing:true){ id } }',
      { b: String(boardId), i: String(itemId), v: JSON.stringify(values) },
    );
  }

  return { gql, boardInfo, subitemBoardId, columnsOf, items, findOrCreateMonth, createSubitem, createItem, updateColumns };
}

export async function checkConnection(cfg = mondayConfig(), fetchImpl) {
  const missing = missingConfig(cfg);
  if (missing.length) {
    return {
      ready: false,
      summary: `Monday 연동 환경 변수가 설정되지 않았습니다: ${missing.join(', ')}. Vercel 프로젝트 설정에서 추가해 주세요.`,
      checks: [
        { name: 'Distance 보드', ready: false, summary: cfg.distanceBoard ? '토큰 필요' : 'MONDAY_DISTANCE_BOARD_ID 미설정' },
        { name: 'Revenue 보드', ready: false, summary: cfg.revenueBoard ? '토큰 필요' : 'MONDAY_REVENUE_BOARD_ID 미설정' },
      ],
      provider: { status: 'binding_unavailable' },
    };
  }
  const client = createClient(cfg, fetchImpl);
  const checks = [];
  const inspect = async (label, boardId, mapping, sub) => {
    const b = await client.boardInfo(boardId);
    if (!b) return { name: label, ready: false, summary: `보드 ${boardId}를 찾을 수 없거나 토큰에 접근 권한이 없습니다.` };
    let cols = b.columns;
    let note = '';
    if (sub) {
      const sid = await client.subitemBoardId(b);
      if (sid) cols = await client.columnsOf(sid);
      else note = ' · 하위 아이템 보드가 아직 없어 열 매핑은 첫 전송 때 확인됩니다.';
    }
    const ids = new Set(cols.map((c) => c.id));
    const missingCols = Object.values(mapping).filter((c) => !ids.has(c));
    if (missingCols.length && !note) return { name: label, ready: false, summary: `${b.name}: 매핑된 열을 찾을 수 없습니다 (${missingCols.join(', ')}).` };
    return { name: label, ready: true, summary: `${b.name} · 매핑된 열 ${Object.keys(mapping).length}개${note}` };
  };
  try {
    checks.push(await inspect('Distance 보드', cfg.distanceBoard, cfg.distanceColumns(), true));
    checks.push(await inspect('Revenue 보드', cfg.revenueBoard, cfg.revenueColumns(), false));
  } catch (e) {
    return { ready: false, summary: e.message, checks, provider: e.provider };
  }
  const ready = checks.every((c) => c.ready);
  return { ready, summary: ready ? 'Monday 연결 설정을 확인했습니다. 보드 구조만 읽었으며 기록은 변경하지 않았습니다.' : 'Monday 연결 설정을 확인해 주세요.', checks };
}

// Runs a sync. `persist(partial)` is awaited after each created item so an
// interrupted run still remembers the item IDs (prevents duplicates on retry).
export async function syncLead(lead, sync, persist, cfg = mondayConfig(), fetchImpl) {
  const client = createClient(cfg, fetchImpl);
  const tag = `[AU:${lead.id}]`;
  const state = { distance_id: sync.distance_id || null, revenue_id: sync.revenue_id || null };

  // Distance (always)
  let distanceBoardId = sync.distance_board_id || null;
  if (!state.distance_id) {
    const parent = await client.findOrCreateMonth(cfg.distanceBoard, cfg.distanceGroup, String(lead.date || '').slice(0, 7) || 'unknown');
    const sub = await client.createSubitem(parent, `${lead.name} ${tag}`);
    state.distance_id = sub.id;
    distanceBoardId = sub.board?.id;
    await persist({ distance_id: state.distance_id, distance_board_id: distanceBoardId });
  }
  if (!distanceBoardId) distanceBoardId = (await client.items([state.distance_id]))[0]?.board?.id;
  if (!distanceBoardId) throw new MondayError(`Distance 아이템 ${state.distance_id}을(를) 찾을 수 없습니다. 결과 확인 후 다시 연결해 주세요.`);
  const dCols = await client.columnsOf(distanceBoardId);
  await client.updateColumns(distanceBoardId, state.distance_id, buildColumnValues(lead, cfg.distanceColumns(), dCols));

  // Revenue (only enrolled)
  let revenue;
  if (lead.status === '등록 완료') {
    if (!state.revenue_id) {
      const item = await client.createItem(cfg.revenueBoard, cfg.revenueGroup, `${FIELDS.studentName(lead)} ${tag}`);
      state.revenue_id = item.id;
      await persist({ revenue_id: state.revenue_id });
    }
    const rCols = await client.columnsOf(cfg.revenueBoard);
    await client.updateColumns(cfg.revenueBoard, state.revenue_id, buildColumnValues(lead, cfg.revenueColumns(), rCols));
    revenue = { state: 'synced', label: `반영 완료 · ${revenueStatus(lead)}`, reason: `실입금액 ${FIELDS.cost(lead).toLocaleString('ko-KR')}원을 ${revenueStatus(lead)}로 반영했습니다.`, itemId: state.revenue_id };
  } else if (state.revenue_id) {
    revenue = { state: 'kept', label: '기존 기록 유지', reason: '등록 완료가 아니어서 기존 Revenue 기록을 변경하지 않았습니다. 취소·환불은 자동 삭제하지 않습니다.', itemId: state.revenue_id };
  } else {
    revenue = { state: 'skipped', label: '등록 완료 시 반영', reason: '등록 완료 건만 Revenue에 반영합니다.', itemId: null };
  }
  return {
    ...state,
    distance_board_id: distanceBoardId,
    destinations: { distance: { state: 'synced', label: '반영 완료', itemId: state.distance_id }, revenue },
  };
}

export async function reconcileItems(lead, { distanceId, revenueId }, cfg = mondayConfig(), fetchImpl) {
  const client = createClient(cfg, fetchImpl);
  const ids = [distanceId, revenueId].filter(Boolean);
  for (const id of ids) if (!/^\d{1,20}$/.test(id)) throw new MondayError('아이템 ID는 숫자만 입력해 주세요.', { status: 400 });
  const found = await client.items(ids);
  const tag = `[AU:${lead.id}]`;
  const check = (id, label) => {
    if (!id) return null;
    const it = found.find((i) => String(i.id) === String(id));
    if (!it) throw new MondayError(`${label} 아이템 ${id}을(를) 찾을 수 없습니다.`, { status: 400 });
    if (!String(it.name).includes(tag)) throw new MondayError(`${label} 아이템 이름에 상담 식별자 ${tag}가 없습니다.`, { status: 400 });
    return it;
  };
  const d = check(distanceId, 'Distance');
  const r = check(revenueId, 'Revenue');
  if (r && String(r.board?.id) !== String(cfg.revenueBoard)) throw new MondayError('Revenue 아이템이 설정된 Revenue 보드에 있지 않습니다.', { status: 400 });
  return { distance_id: d?.id || null, distance_board_id: d?.board?.id || null, revenue_id: r?.id || null };
}
