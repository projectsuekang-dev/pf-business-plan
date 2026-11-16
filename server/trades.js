// 실거래가(분양권전매 · 전월세) 한 달치 조회 — 서버 전용 모듈.
// 근거: 「아파트 분양권전매 실거래가 자료」「아파트 전월세 실거래가 자료」 기술문서 (국토교통부, XML 응답)
// - 지역코드(LAWD_CD)는 브라우저가 아니라 서버가 사업대상지 이름으로 다시 확인한다.
// - 같은 조회(종류·지역코드·계약월)는 하루 동안 파일 캐시로 답하고 다시 부르지 않는다.
// - 인증키는 응답·오류 메시지에 넣지 않는다.
const fs = require('fs');
const path = require('path');
const { lookupRegion, encodeKey, redact } = require('./region.js');
const Market = require('../public/market.js');

const SERVICES = {
  silv: 'https://apis.data.go.kr/1613000/RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade',
  rent: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
};
const ROWS_PER_PAGE = 1000;
const MAX_PAGES = 20;
const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 하루
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', '.cache', 'trades');

// 기술문서 "OpenAPI 에러 코드정리"
const ERROR_TEXT = {
  '01': '제공기관 서비스 상태가 원활하지 않습니다 (Application Error)',
  '02': '제공기관 서비스 상태가 원활하지 않습니다 (DB Error)',
  '04': '제공기관 서비스 상태가 원활하지 않습니다 (HTTP Error)',
  '05': '제공기관 응답 시간 초과 (service time out)',
  '10': 'ServiceKey 파라미터가 없습니다',
  '11': '필수 요청 파라미터가 없습니다',
  '12': '해당 오픈 API 서비스가 없거나 폐기되었습니다',
  '20': '서비스 접근 거부 — 활용신청 승인 상태를 확인하세요',
  '22': '일일 활용 건수를 초과했습니다',
  '30': '등록되지 않은 서비스키입니다',
  '31': '기간이 만료된 서비스키입니다',
  '32': '등록되지 않은 도메인명 또는 IP 주소입니다',
};
const NO_DATA_CODES = new Set(['03', '003']); // No Data → 0건

// XML 한 덩어리에서 태그 값 꺼내기 (없으면 '')
function tag(name, src) {
  const a = src.indexOf(`<${name}>`);
  if (a < 0) return '';
  const b = src.indexOf(`</${name}>`, a);
  return b < 0 ? '' : src.slice(a + name.length + 2, b).trim();
}

// 응답 XML → { code, message, totalCount, items: [{필드: 값}] }
function parseTradeXml(text) {
  const t = String(text);
  const reason = tag('returnReasonCode', t);               // 포털 공통 오류 형식
  if (reason) return { code: reason.padStart(2, '0'), message: tag('returnAuthMsg', t) || tag('errMsg', t), totalCount: 0, items: [] };
  if (!t.includes('<response>')) throw new Error('응답 형식을 알 수 없습니다');
  const items = t.split('<item>').slice(1).map((chunk) => {
    const body = chunk.slice(0, chunk.indexOf('</item>'));
    const obj = {};
    for (const m of body.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) obj[m[1]] = m[2].trim();
    return obj;
  });
  return { code: tag('resultCode', t), message: tag('resultMsg', t), totalCount: Number(tag('totalCount', t)) || items.length, items };
}

// 결과코드 → 오류 문장 (정상·데이터 없음이면 null)
function tradeErrorText(code, message) {
  const c = String(code || '');
  if (c === '000' || c === '00' || NO_DATA_CODES.has(c)) return null;
  const k = c.replace(/^0+(?=\d{2})/, '');
  return ERROR_TEXT[k] || ERROR_TEXT[k.padStart(2, '0')] || `공공데이터 오류 (${c.slice(0, 10)}${message ? ' · ' + String(message).slice(0, 60) : ''})`;
}

const num = (s) => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };

// 한 달치 거래 → 요약. 원자료는 브라우저로 보내지 않는다.
// 분양권: 해제여부(cdealType)가 'O'인 거래는 뺀다. 입주권(ownershipGbn '입')은 포함하되 따로 센다.
// 전월세: 기술문서에 해제 항목이 없어 전부 센다. 84㎡ 전세는 계약구분별로 나눠 둔다.
function summarize(kind, items) {
  if (kind === 'silv') {
    const cancelled = items.filter((i) => (i.cdealType || '').toUpperCase() === 'O').length;
    const kept = items.filter((i) => (i.cdealType || '').toUpperCase() !== 'O');
    // 웃돈 계산(2장 ④)용 거래 목록 — 단지명 · 전용면적 · 거래금액(만원) · 입주권 여부만
    const deals = kept.map((i) => ({ apt: (i.aptNm || '').trim(), area: num(i.excluUseAr), amount: num(i.dealAmount), right: i.ownershipGbn === '입' }));
    return { total: items.length, cancelled, count: kept.length, occupancyRights: kept.filter((i) => i.ownershipGbn === '입').length, deals };
  }
  const s = { total: items.length, count: items.length, jeonse84New: { n: 0, sum: 0 }, renewal84: 0, blankType84: 0, monthly84: 0 };
  for (const i of items) {
    if (!Market.is84(num(i.excluUseAr))) continue;
    const rent = num(i.monthlyRent), deposit = num(i.deposit);
    if (rent == null || rent > 0) { s.monthly84++; continue; }          // 월세(반전세 포함) 제외
    if (i.contractType === '갱신') { s.renewal84++; continue; }       // 갱신 계약 제외
    if (i.contractType !== '신규' || deposit == null) { s.blankType84++; continue; } // 계약구분 미기재 제외
    s.jeonse84New.n++;
    s.jeonse84New.sum += deposit;
  }
  return s;
}

// 한 달치 전체 페이지 조회
async function fetchMonth(kind, code, ym, { key, fetchImpl }) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = `serviceKey=${encodeKey(key)}&LAWD_CD=${code}&DEAL_YMD=${ym}&pageNo=${page}&numOfRows=${ROWS_PER_PAGE}`;
    let res;
    try {
      res = await fetchImpl(`${SERVICES[kind]}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new Error(e && e.name === 'TimeoutError' ? '공공데이터 응답 시간 초과' : '공공데이터 서버에 연결할 수 없습니다');
    }
    if (!res.ok) throw new Error(`공공데이터 HTTP ${res.status}`);
    let body;
    try { body = parseTradeXml(await res.text()); } catch { throw new Error('공공데이터 응답을 해석할 수 없습니다'); }
    const err = tradeErrorText(body.code, body.message);
    if (err) throw new Error(err);
    items.push(...body.items);
    if (items.length >= body.totalCount || body.items.length < ROWS_PER_PAGE) return items;
  }
  throw new Error(`한 달 거래가 ${ROWS_PER_PAGE * MAX_PAGES}건을 넘어 다 받지 못했습니다`);
}

// ── 하루 캐시 (파일) ─────────────────────────────
const CACHE_VERSION = 2; // 요약 형식이 바뀌면 올린다 (v2: 분양권 거래 목록 추가)
const cacheFile = (dir, kind, code, ym) => path.join(dir, `v${CACHE_VERSION}-${kind}-${code}-${ym}.json`);
function readCache(dir, kind, code, ym, now) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(dir, kind, code, ym), 'utf8'));
    return now - Date.parse(c.fetchedAt) < CACHE_TTL_MS ? c : null;
  } catch { return null; }
}
function writeCache(dir, kind, code, ym, data) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cacheFile(dir, kind, code, ym), JSON.stringify(data)); } catch { /* 캐시 실패는 무시 */ }
}

// 요청 검사 — 종류는 silv/rent, 계약월은 YYYYMM이고 미래가 아니어야 한다
function validate(kind, ym, now) {
  if (!SERVICES[kind]) return '알 수 없는 조회 종류';
  if (!/^\d{6}$/.test(ym || '')) return '계약월 형식 오류 (YYYYMM)';
  const m = Number(ym.slice(4));
  const d = new Date(now);
  if (m < 1 || m > 12 || ym > `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`) return '계약월 범위 오류';
  return null;
}

// 브라우저 요청 처리: 사업대상지 이름 → (서버가 다시 확인한) 지역코드 → 한 달치 요약
function createTradeService({ key = '', fetchImpl = fetch, cacheDir = DEFAULT_CACHE_DIR, now = () => Date.now(), regionCache = new Map() } = {}) {
  const inflight = new Map();
  return async function getMonth({ site, kind, ym }) {
    const bad = validate(kind, ym, now());
    if (bad) return { status: 'error', kind, ym, message: bad };
    if (!key) return { status: 'no_key', kind, ym };

    const region = await lookupRegion(site || '', { key, fetchImpl, cache: regionCache });
    if (region.status !== 'ok') return { status: 'region', kind, ym, region: { status: region.status, message: region.message } };
    const code = region.code;

    const cached = readCache(cacheDir, kind, code, ym, now());
    if (cached) return { status: 'ok', ...cached, cached: true };

    const id = `${kind}-${code}-${ym}`;
    if (!inflight.has(id)) {
      inflight.set(id, (async () => {
        try {
          const items = await fetchMonth(kind, code, ym, { key, fetchImpl });
          const data = { kind, ym, region: { name: region.name, code }, fetchedAt: new Date(now()).toISOString(), summary: summarize(kind, items) };
          writeCache(cacheDir, kind, code, ym, data);
          return { status: 'ok', ...data, cached: false };
        } catch (e) {
          return { status: 'error', kind, ym, region: { name: region.name, code }, message: redact(e.message, key) };
        } finally { inflight.delete(id); }
      })());
    }
    return inflight.get(id);
  };
}

module.exports = { SERVICES, CACHE_TTL_MS, parseTradeXml, tradeErrorText, summarize, validate, createTradeService };
