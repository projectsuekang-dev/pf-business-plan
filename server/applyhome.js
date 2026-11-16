// 청약홈 인근 신규 분양 — 서버 전용 모듈.
// 근거: 「청약홈 분양정보 조회 서비스」(ApplyhomeInfoDetailSvc) · 「청약홈 청약접수 경쟁률 및 특별공급 신청현황 조회 서비스」(ApplyhomeInfoCmpetRtSvc)
// - 사업대상지 이름은 서버가 법정동코드로 다시 확인하고, 확인된 공식 이름을 공급위치(HSSPLY_ADRES) LIKE 조건에 쓴다.
// - 최근 3년 모집공고 APT 분양주택만. 단지 목록·단지별 상세는 하루 동안 파일 캐시.
// - 인증키는 응답·오류 메시지에 넣지 않는다.
const fs = require('fs');
const path = require('path');
const { lookupRegion, encodeKey, redact, norm } = require('./region.js');

const BASE = 'https://api.odcloud.kr/api';
const EP = {
  list: 'ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail',   // APT 분양정보 상세조회
  mdl: 'ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl',       // APT 분양정보 주택형별 상세조회
  cmpet: 'ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet',  // APT 분양정보/경쟁률 조회
};
const YEARS = 3;
const PER_PAGE = 100;
const MAX_PAGES = 20;
const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', '.cache', 'applyhome');

// 기술문서 "OpenAPI 에러 코드정리" (HTTP 상태)
const HTTP_ERROR = {
  401: '인증 정보가 정확하지 않습니다 — 청약홈 API 활용신청을 확인하세요',
  500: '청약홈 API 서버에 문제가 발생했습니다',
};

const num = (v) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : null; };

// 한국 날짜 기준 3년 전 'YYYY-MM-DD'
function sinceDate(now, years = YEARS) {
  const [y, m, d] = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).split('-');
  return `${Number(y) - years}-${m}-${d}`;
}

// odcloud 조건 쿼리: cond[필드::연산]=값
function query(cond, page) {
  const parts = [`page=${page}`, `perPage=${PER_PAGE}`];
  for (const [k, v] of Object.entries(cond)) parts.push(`${encodeURIComponent(`cond[${k}]`)}=${encodeURIComponent(v)}`);
  return parts.join('&');
}

// 전체 페이지 조회 → data 배열
async function fetchAll(ep, cond, { key, fetchImpl }) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res;
    try {
      res = await fetchImpl(`${BASE}/${ep}?${query(cond, page)}&serviceKey=${encodeKey(key)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new Error(e && e.name === 'TimeoutError' ? '청약홈 응답 시간 초과' : '청약홈 서버에 연결할 수 없습니다');
    }
    if (!res.ok) throw new Error(HTTP_ERROR[res.status] || `청약홈 HTTP ${res.status}`);
    let body;
    try { body = JSON.parse(await res.text()); } catch { throw new Error('청약홈 응답을 해석할 수 없습니다'); }
    const data = Array.isArray(body.data) ? body.data : [];
    out.push(...data);
    const total = Number(body.matchCount ?? body.totalCount ?? data.length);
    if (out.length >= total || data.length < PER_PAGE) return out;
  }
  throw new Error(`결과가 ${PER_PAGE * MAX_PAGES}건을 넘어 다 받지 못했습니다`);
}

// 단지 목록 행 → 정리된 단지. 제외 사유가 있으면 excluded에 담는다.
// APT 분양주택(주택구분 01 · 분양구분 0)만. 민간사전청약(09) · 신혼희망타운(10) · 분양전환 가능임대(1) 제외.
function pickComplexes(rows, regionName) {
  const name = norm(regionName);
  const complexes = [];
  const excluded = { notApt: 0, rental: 0, address: 0 };
  const seen = new Set();
  for (const r of rows) {
    const id = String(r.HOUSE_MANAGE_NO), pblanc = String(r.PBLANC_NO);
    if (seen.has(id + '/' + pblanc)) continue;
    seen.add(id + '/' + pblanc);
    if (!norm(r.HSSPLY_ADRES).includes(name)) { excluded.address++; continue; }
    if (String(r.HOUSE_SECD) !== '01') { excluded.notApt++; continue; }
    if (String(r.RENT_SECD) === '1') { excluded.rental++; continue; }
    complexes.push({
      id, pblanc, name: norm(r.HOUSE_NM), address: norm(r.HSSPLY_ADRES),
      noticeDate: r.RCRIT_PBLANC_DE, households: num(r.TOT_SUPLY_HSHLDCO), url: r.PBLANC_URL || null,
    });
  }
  complexes.sort((a, b) => String(b.noticeDate).localeCompare(String(a.noticeDate)));
  return { complexes, excluded };
}

// 주택형 문자열('084.9543T') → 전용면적 84.9543
const exclOf = (ty) => num(String(ty).trim().replace(/[^\d.].*$/, ''));

// 주택형별 분양가 + 1·2순위 접수 → 경쟁률 · 잔여세대
// 경쟁률 자료의 공급세대수(SUPLY_HSHLDCO)는 특별공급 잔여가 넘어온 실제 일반공급 세대수다.
// 잔여세대 = 일반공급 − 1순위 접수 − 2순위 접수 (0 미만이면 0). 당첨 후 계약 포기·부적격은 반영되지 않는다.
function buildTypes(mdlRows, cmpetRows) {
  const comp = new Map();
  for (const r of cmpetRows) {
    const ty = String(r.HOUSE_TY).trim();
    const c = comp.get(ty) || { supply: 0, r1: 0, r2: 0, has1: false, has2: false };
    c.supply = Math.max(c.supply, num(r.SUPLY_HSHLDCO) || 0);
    const req = num(r.REQ_CNT) || 0;
    if (Number(r.SUBSCRPT_RANK_CODE) === 1) { c.r1 += req; c.has1 = true; }
    if (Number(r.SUBSCRPT_RANK_CODE) === 2) { c.r2 += req; c.has2 = true; }
    comp.set(ty, c);
  }
  return mdlRows.map((m) => {
    const ty = String(m.HOUSE_TY).trim();
    const c = comp.get(ty);
    const base = {
      type: ty, excl: exclOf(ty), supplyAr: num(m.SUPLY_AR), topAmount: num(m.LTTOT_TOP_AMOUNT),
      general: num(m.SUPLY_HSHLDCO) || 0, special: num(m.SPSPLY_HSHLDCO) || 0,
    };
    if (!c || !c.has1 || !c.supply) return { ...base, competition: null };
    const short1 = Math.max(0, c.supply - c.r1);
    const remain = Math.max(0, short1 - c.r2);
    return {
      ...base,
      competition: {
        supply: c.supply, rank1: c.r1, rank2: c.has2 ? c.r2 : null,
        rate1: c.r1 / c.supply, rate2: short1 > 0 && c.has2 ? c.r2 / short1 : null, remain,
      },
    };
  });
}

// ── 하루 캐시 (파일) ─────────────────────────────
function readCache(file, now) {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return now - Date.parse(c.fetchedAt) < CACHE_TTL_MS ? c : null; } catch { return null; }
}
function writeCache(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch { /* 무시 */ }
}

function createApplyhomeService({ key = '', fetchImpl = fetch, cacheDir = DEFAULT_CACHE_DIR, now = () => Date.now(), regionCache = new Map() } = {}) {
  const deps = { key, fetchImpl };
  const inflight = new Map();
  const once = (id, fn) => {
    if (!inflight.has(id)) inflight.set(id, fn().finally(() => inflight.delete(id)));
    return inflight.get(id);
  };

  // 사업대상지 이름 → 서버가 다시 확인한 지역
  async function region(site) {
    if (!key) return { error: { status: 'no_key' } };
    const r = await lookupRegion(site || '', { key, fetchImpl, cache: regionCache });
    return r.status === 'ok' ? { region: r } : { error: { status: 'region', region: { status: r.status, message: r.message } } };
  }

  // 단지 목록: 공급위치에 확인된 지역 이름이 들어간 최근 3년 단지
  async function list({ site }) {
    const g = await region(site);
    if (g.error) return g.error;
    const since = sinceDate(now());
    const file = path.join(cacheDir, `list-${g.region.code}-${since}.json`);
    const cached = readCache(file, now());
    if (cached) return { status: 'ok', ...cached, cached: true };
    return once(file, async () => {
      try {
        const rows = await fetchAll(EP.list, { 'HSSPLY_ADRES::LIKE': g.region.name, 'RCRIT_PBLANC_DE::GTE': since }, deps);
        const data = { region: { name: g.region.name, code: g.region.code }, since, fetchedAt: new Date(now()).toISOString(), ...pickComplexes(rows, g.region.name) };
        writeCache(file, data);
        return { status: 'ok', ...data, cached: false };
      } catch (e) {
        return { status: 'error', message: redact(e.message, key) };
      }
    });
  }

  // 단지 하나: 주택형별 분양가 · 1·2순위 경쟁률 · 잔여세대. 목록에 있는 단지만 허용.
  async function complex({ site, id }) {
    const l = await list({ site });
    if (l.status !== 'ok') return l;
    const c = l.complexes.find((x) => x.id === String(id));
    if (!c) return { status: 'error', id, message: '이 사업대상지의 인근 단지 목록에 없는 단지입니다' };
    const file = path.join(cacheDir, `complex-${c.id}-${c.pblanc}.json`);
    const cached = readCache(file, now());
    if (cached) return { status: 'ok', ...cached, cached: true };
    return once(file, async () => {
      try {
        const cond = { 'HOUSE_MANAGE_NO::EQ': c.id, 'PBLANC_NO::EQ': c.pblanc };
        const [mdl, cmpet] = [await fetchAll(EP.mdl, cond, deps), await fetchAll(EP.cmpet, cond, deps)];
        const data = { id: c.id, name: c.name, noticeDate: c.noticeDate, fetchedAt: new Date(now()).toISOString(), types: buildTypes(mdl, cmpet) };
        writeCache(file, data);
        return { status: 'ok', ...data, cached: false };
      } catch (e) {
        return { status: 'error', id: c.id, message: redact(e.message, key) };
      }
    });
  }

  return { list, complex };
}

module.exports = { EP, YEARS, CACHE_TTL_MS, sinceDate, pickComplexes, buildTypes, exclOf, createApplyhomeService };
