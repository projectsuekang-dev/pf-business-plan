// 지역 확인 검사 — 실제 공공데이터를 호출하지 않고 가짜 응답으로 확인 (키 불필요)
const test = require('node:test');
const assert = require('node:assert/strict');
const Region = require('../server/region.js');
const { createApp } = require('../server.js');
const Report = require('../public/report.js');

// 기술문서 응답 필드 형태의 가짜 행
const row = (region_cd, locatadd_nm) => ({
  region_cd, sido_cd: region_cd.slice(0, 2), sgg_cd: region_cd.slice(2, 5),
  umd_cd: region_cd.slice(5, 8), ri_cd: region_cd.slice(8, 10), locatadd_nm,
});
const BUSAN = [
  row('2600000000', '부산광역시'),
  row('2635000000', '부산광역시 해운대구'),
  row('2635010500', '부산광역시 해운대구 우동'),
  row('2635010600', '부산광역시 해운대구 중동'),
  row('2614000000', '부산광역시 서구'),
];
const SUWON = [
  row('4111000000', '경기도 수원시'),
  row('4111700000', '경기도 수원시 영통구'),
  row('4111710100', '경기도 수원시 영통구 매탄동'),
];
// 포털 JSON 응답 모양으로 감싸기
const jsonBody = (rows) => JSON.stringify({ StanReginCd: [
  { head: [{ totalCount: rows.length }, { numOfRows: '1000' }, { pageNo: '1' }, { type: 'JSON' }, { RESULT: { resultCode: 'INFO-0', resultMsg: 'NORMAL SERVICE' } }] },
  { row: rows },
] });
const NO_DATA_BODY = JSON.stringify({ RESULT: { resultCode: 'INFO-200', resultMsg: '해당하는 데이터가 없습니다.' } });

// locatadd_nm 포함 검색을 흉내 내는 가짜 fetch — 요청 URL도 기록
function fakeFetch(all, calls = []) {
  return async (url) => {
    calls.push(url);
    const q = new URL(url).searchParams.get('locatadd_nm');
    const hits = all.filter((r) => r.locatadd_nm.includes(q));
    return { ok: true, status: 200, text: async () => (hits.length ? jsonBody(hits) : NO_DATA_BODY) };
  };
}
const ALL = [...BUSAN, ...SUWON];

test('시군구 행만 고른다 (읍면동·시도 행 제외)', () => {
  assert.deepEqual(BUSAN.filter(Region.isSigungu).map((r) => r.region_cd), ['2635000000', '2614000000']);
});

test('정확히 하나로 맞으면 통과 — 부산광역시 해운대구 → 26350', () => {
  const r = Region.matchRegion('부산광역시  해운대구 ', BUSAN);
  assert.equal(r.status, 'ok');
  assert.equal(r.code, '26350');
  assert.equal(r.name, '부산광역시 해운대구');
});

test('구가 있는 시: 경기도 수원시 영통구 → 41117 (수원시 41110과 구분)', () => {
  assert.equal(Region.matchRegion('경기도 수원시 영통구', SUWON).code, '41117');
  assert.equal(Region.matchRegion('경기도 수원시', SUWON).code, '41110');
});

test('시도만 넣으면 통과하지 않고 후보 목록', () => {
  const r = Region.matchRegion('부산광역시', BUSAN);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map((c) => c.code), ['26140', '26350']);
});

test('같은 이름이 둘 이상이면 통과하지 않는다', () => {
  const dup = [row('2635000000', '부산광역시 해운대구'), row('2635100000', '부산광역시 해운대구')];
  assert.equal(Region.matchRegion('부산광역시 해운대구', dup).status, 'ambiguous');
});

test('응답 해석: JSON 정상 · 데이터 없음 · XML 인증 오류', () => {
  assert.equal(Region.parseBody(jsonBody(BUSAN)).rows.length, 5);
  assert.equal(Region.parseBody(NO_DATA_BODY).code, 'INFO-200');
  const xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
  const p = Region.parseBody(xml);
  assert.equal(Region.errorText(p.code, p.message), '등록되지 않은 인증키입니다');
  assert.equal(Region.errorText('INFO-0'), null);
});

test('실제 서비스의 "데이터없음"(INFO-3)은 오류가 아니라 0건', async () => {
  const body = JSON.stringify({ RESULT: { resultCode: 'INFO-3', resultMsg: '데이터없음 에러' } });
  assert.equal(Region.errorText(Region.parseBody(body).code), null);
  // 전체 이름은 0건(INFO-3), 마지막 단어로 다시 찾아 후보를 만든다
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams.get('locatadd_nm');
    const hits = ALL.filter((r) => r.locatadd_nm.includes(q));
    return { ok: true, status: 200, text: async () => (hits.length ? jsonBody(hits) : body) };
  };
  const r = await Region.lookupRegion('부산 해운대구', { key: 'K', fetchImpl });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates[0].code, '26350');
  assert.equal((await Region.lookupRegion('없는시 없는구', { key: 'K', fetchImpl })).status, 'not_found');
});

test('인증키 인코딩: 디코딩 키는 인코딩, 이미 인코딩된 키는 그대로', () => {
  assert.equal(Region.encodeKey('ab+c/d=='), 'ab%2Bc%2Fd%3D%3D');
  assert.equal(Region.encodeKey('ab%2Bc'), 'ab%2Bc');
});

test('조회: 기술문서대로 요청하고 결과를 고른다', async () => {
  const calls = [];
  const r = await Region.lookupRegion('부산광역시 해운대구', { key: 'TESTKEY', fetchImpl: fakeFetch(ALL, calls) });
  assert.equal(r.status, 'ok');
  assert.equal(r.code, '26350');
  const u = new URL(calls[0]);
  assert.equal(u.pathname, '/1741000/StanReginCd/getStanReginCdList');
  assert.equal(u.searchParams.get('type'), 'json');
  assert.equal(u.searchParams.get('flag'), 'Y');
  assert.equal(u.searchParams.get('locatadd_nm'), '부산광역시 해운대구');
});

test('조회: 전체 이름이 안 맞으면 마지막 단어로 후보를 찾는다', async () => {
  const r = await Region.lookupRegion('부산 해운대구', { key: 'TESTKEY', fetchImpl: fakeFetch(ALL) });
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map((c) => c.name), ['부산광역시 해운대구']);
});

test('조회: 키가 없으면 호출하지 않고 no_key', async () => {
  const calls = [];
  const r = await Region.lookupRegion('부산광역시 해운대구', { key: '', fetchImpl: fakeFetch(ALL, calls) });
  assert.equal(r.status, 'no_key');
  assert.equal(calls.length, 0);
});

test('조회 실패 메시지에 키가 섞이지 않는다', async () => {
  const failing = async () => { throw new Error('boom SECRETKEY123'); };
  const r = await Region.lookupRegion('부산광역시 해운대구', { key: 'SECRETKEY123', fetchImpl: failing });
  assert.equal(r.status, 'error');
  assert.doesNotMatch(JSON.stringify(r), /SECRETKEY123/);
});

// 실제 서버를 임시 포트로 띄워 브라우저가 받는 응답을 확인
async function withServer(opts, fn) {
  const server = createApp(opts).listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('서버 /api/region: 결과만 보내고 인증키는 보내지 않는다', async () => {
  await withServer({ key: 'SECRETKEY123', fetchImpl: fakeFetch(ALL) }, async (base) => {
    const res = await fetch(base + '/api/region?name=' + encodeURIComponent('부산광역시 해운대구'));
    const text = await res.text();
    assert.equal(JSON.parse(text).code, '26350');
    assert.doesNotMatch(text, /SECRETKEY123/);
    const status = await (await fetch(base + '/api/status')).text();
    assert.equal(status, '{"keyConfigured":true}');
  });
});

test('서버: 키 없이도 뜨고 no_key를 돌려준다', async () => {
  await withServer({ key: '' }, async (base) => {
    const r = await (await fetch(base + '/api/region?name=' + encodeURIComponent('부산광역시 해운대구'))).json();
    assert.equal(r.status, 'no_key');
  });
});

test('1장: 확인된 지역과 코드 표시 / 미확인은 "자료 없음"', () => {
  const base = { name: '해운대 그린테라스', site: '부산광역시 해운대구', units: [] };
  const ch1 = (region) => Report.render({ ...base, region }).match(/<section class="chapter" id="ch1">([\s\S]*?)<\/section>/)[1];
  const ok = ch1({ status: 'ok', input: '부산광역시 해운대구', name: '부산광역시 해운대구', code: '26350' });
  assert.match(ok, /확인된 지역<\/th><td[^>]*>부산광역시 해운대구</);
  assert.match(ok, /<span class="code">26350<\/span>/);
  assert.match(ch1({ status: 'no_key' }), /자료 없음 — 공공데이터 인증키 미설정/);
  const amb = ch1({ status: 'ambiguous', candidates: [{ name: '부산광역시 서구', code: '26140' }, { name: '부산광역시 해운대구', code: '26350' }] });
  assert.match(amb, /하나로 확인되지 않음 · 후보 2개/);
  assert.match(amb, /부산광역시 서구\(26140\)/);
  assert.doesNotMatch(amb, /<span class="code">/);
});
