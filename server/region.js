// 사업대상지 → 시군구 법정동코드(5자리) 확인 — 서버 전용 모듈.
// 근거: 기술문서_행정안전부_행정표준코드_법정동코드 (StanReginCd / getStanReginCdList)
// 인증키는 이 모듈 밖으로 나가지 않는다: 응답·오류 메시지에 키나 요청 URL을 넣지 않는다.

const ENDPOINT = 'https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList';
const ROWS_PER_PAGE = 1000;   // 문서: 한 번에 최대 1,000건 (에러 336)
const MAX_PAGES = 5;          // 시도 단위로 넓게 검색해도 5,000건까지만 본다
const MAX_CANDIDATES = 30;
const TIMEOUT_MS = 10000;

// 기술문서의 에러 코드 → 사용자에게 보여줄 문장
const ERROR_TEXT = {
  // 포털 공통 오류(returnReasonCode)
  '20': '서비스 접근이 거부되었습니다 (활용신청 확인)',
  '22': '서비스 요청 제한 횟수를 넘었습니다',
  '30': '등록되지 않은 인증키입니다',
  '31': '활용 기간이 만료된 인증키입니다',
  // 기술문서 에러 코드
  '290': '인증키가 유효하지 않습니다',
  '300': '관리자에 의해 인증키 사용이 제한되었습니다',
  '310': '해당하는 서비스를 찾을 수 없습니다',
  '333': '요청위치 값의 타입이 유효하지 않습니다',
  '336': '한 번에 1,000건을 넘게 요청할 수 없습니다',
  '337': '일별 트래픽 제한을 넘었습니다',
  '500': '공공데이터 서버 오류입니다',
  '600': '공공데이터 데이터베이스 연결 오류입니다',
  '601': '공공데이터 SQL 문장 오류입니다',
};

// 공백을 하나로 모으고 앞뒤 공백 제거 — 이름 비교용
function norm(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// 시군구 단위 행인지 판단 — 시군구코드가 있고 읍면동·리코드가 0인 행
function isSigungu(row) {
  return !!row.sgg_cd && row.sgg_cd !== '000' && row.umd_cd === '000' && (row.ri_cd ?? '00') === '00';
}

// 행 → 후보 {이름, 5자리 코드, 10자리 지역코드}
function toCandidate(row) {
  return { name: norm(row.locatadd_nm), code: String(row.region_cd).slice(0, 5), regionCd: String(row.region_cd) };
}

// 조회 결과 행에서 입력 이름과 "정확히 하나" 일치하는 시군구를 고른다.
// 정확히 하나 → ok, 그 외 → 후보 목록(ambiguous) 또는 없음(not_found)
function matchRegion(input, rows) {
  const name = norm(input);
  const seen = new Set();
  const sgg = rows.filter(isSigungu).filter((r) => (seen.has(r.region_cd) ? false : seen.add(r.region_cd)));
  const exact = sgg.filter((r) => norm(r.locatadd_nm) === name);
  if (exact.length === 1) return { status: 'ok', input: name, ...toCandidate(exact[0]) };
  const pool = (exact.length > 1 ? exact : sgg).map(toCandidate).sort((a, b) => a.code.localeCompare(b.code));
  return pool.length
    ? { status: 'ambiguous', input: name, candidates: pool.slice(0, MAX_CANDIDATES), more: pool.length > MAX_CANDIDATES }
    : { status: 'not_found', input: name, candidates: [] };
}

// 응답 본문(JSON 또는 XML) → { code, message, totalCount, rows }
// code: 'INFO-0' 정상, 'INFO-200' 데이터 없음, 그 외 오류
function parseBody(text) {
  const t = String(text).trim();
  if (t.startsWith('{')) {
    const obj = JSON.parse(t);
    if (obj.RESULT) return { code: obj.RESULT.resultCode, message: obj.RESULT.resultMsg, totalCount: 0, rows: [] };
    const parts = obj.StanReginCd || [];
    const head = (parts.find((p) => p.head) || {}).head || [];
    const result = (head.find((h) => h.RESULT) || {}).RESULT || {};
    const total = (head.find((h) => 'totalCount' in h) || {}).totalCount;
    const rows = (parts.find((p) => p.row) || {}).row || [];
    return { code: result.resultCode || 'INFO-0', message: result.resultMsg || '', totalCount: Number(total) || rows.length, rows };
  }
  // XML: 포털 공통 오류(OpenAPI_ServiceResponse) 또는 문서의 XML 응답 형식
  const tag = (name, src = t) => { const m = src.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };
  const reason = tag('returnReasonCode');
  if (reason) return { code: 'ERR-' + reason.replace(/^0+/, ''), message: tag('returnAuthMsg') || tag('errMsg'), totalCount: 0, rows: [] };
  const fields = ['region_cd', 'sido_cd', 'sgg_cd', 'umd_cd', 'ri_cd', 'locatadd_nm'];
  const rows = [...t.matchAll(/<row>([\s\S]*?)<\/row>/g)].map((m) => Object.fromEntries(fields.map((f) => [f, tag(f, m[1])])));
  return { code: tag('resultCode') || 'INFO-0', message: tag('resultMsg'), totalCount: Number(tag('totalCount')) || rows.length, rows };
}

// 결과코드 → 오류 문장 (정상·데이터 없음이면 null)
// 데이터 없음: 기술문서는 INFO-200이지만, 실제 서비스는 INFO-3("데이터없음 에러")으로 답한다(2026-11-16 확인).
const OK_CODES = new Set(['INFO-0', 'INFO-00', 'INFO-200', 'INFO-3']);
function errorText(code, message) {
  if (OK_CODES.has(code)) return null;
  const num = String(code).replace(/^\D+-?/, '').replace(/^0+(?=\d)/, '');
  return ERROR_TEXT[num] || `공공데이터 오류 (${String(code).slice(0, 20)}${message ? ' · ' + String(message).slice(0, 60) : ''})`;
}

// 인증키 쿼리 값 — 포털의 "인코딩 키"(% 포함)는 그대로, "디코딩 키"는 URL 인코딩
function encodeKey(key) {
  return /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
}

// 지역주소명으로 법정동코드 행을 가져온다 (최대 MAX_PAGES 페이지)
async function fetchRows(name, key, fetchImpl) {
  const rows = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = `ServiceKey=${encodeKey(key)}&type=json&pageNo=${page}&numOfRows=${ROWS_PER_PAGE}&flag=Y&locatadd_nm=${encodeURIComponent(name)}`;
    let res;
    try {
      res = await fetchImpl(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new Error(e && e.name === 'TimeoutError' ? '공공데이터 응답 시간 초과' : '공공데이터 서버에 연결할 수 없습니다');
    }
    if (!res.ok) throw new Error(`공공데이터 HTTP ${res.status}`);
    let body;
    try { body = parseBody(await res.text()); } catch { throw new Error('공공데이터 응답을 해석할 수 없습니다'); }
    const err = errorText(body.code, body.message);
    if (err) throw new Error(err);
    rows.push(...body.rows);
    if (rows.length >= body.totalCount || body.rows.length < ROWS_PER_PAGE) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { rows, truncated };
}

// 사업대상지 이름 → 확인 결과. 키가 없으면 조회하지 않고 no_key.
// 전체 이름으로 시군구가 안 나오면 마지막 단어(예: "해운대구")로 한 번 더 찾아 후보를 만든다.
async function lookupRegion(input, { key, fetchImpl = fetch, cache } = {}) {
  const name = norm(input);
  if (!name) return { status: 'empty' };
  if (!key) return { status: 'no_key', input: name };
  if (cache && cache.has(name)) return cache.get(name);
  try {
    let { rows, truncated } = await fetchRows(name, key, fetchImpl);
    let result = matchRegion(name, rows);
    const words = name.split(' ');
    if (result.status === 'not_found' && words.length > 1) {
      ({ rows, truncated } = await fetchRows(words[words.length - 1], key, fetchImpl));
      result = { ...matchRegion(name, rows), input: name };
    }
    if (truncated && result.status !== 'ok') result.more = true;
    if (cache) cache.set(name, result);
    return result;
  } catch (e) {
    return { status: 'error', input: name, message: redact(e.message, key) };
  }
}

// 혹시라도 문장에 키가 섞이면 가린다
function redact(text, key) {
  let s = String(text || '조회 실패');
  for (const k of [key, encodeKey(key)]) if (k) s = s.split(k).join('***');
  return s;
}

module.exports = { ENDPOINT, norm, isSigungu, matchRegion, parseBody, errorText, encodeKey, lookupRegion, redact };
