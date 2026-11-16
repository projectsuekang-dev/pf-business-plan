// 청약홈 인근 신규 분양 검사 — 실제 API를 부르지 않고 가짜 응답·임시 캐시 폴더로 확인 (키 불필요)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AH = require('../server/applyhome.js');
const Market = require('../public/market.js');
const Report = require('../public/report.js');
const { createApp } = require('../server.js');

const NOW = Date.parse('2026-11-16T03:00:00Z');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'applyhome-test-'));

// ── 가짜 청약홈 자료 (실제 응답 모양) ──
const listRow = (id, name, o = {}) => ({ HOUSE_MANAGE_NO: id, PBLANC_NO: id, HOUSE_NM: name, HOUSE_SECD: '01', RENT_SECD: '0',
  HSSPLY_ADRES: '부산광역시 해운대구 반여동 610-5번지 일원', RCRIT_PBLANC_DE: '2026-10-16', TOT_SUPLY_HSHLDCO: 792, ...o });
const LIST = [
  listRow('2026000514', '트리븐센텀 2단지'),
  listRow('2025000415', '베뉴브 해운대', { RCRIT_PBLANC_DE: '2025-09-19' }),
  listRow('2026000900', '사전청약 단지', { HOUSE_SECD: '09' }),
  listRow('2026000901', '임대 단지', { RENT_SECD: '1' }),
];
const mdl = (ty, supplyAr, top, general, special) => ({ HOUSE_TY: ty, SUPLY_AR: String(supplyAr), LTTOT_TOP_AMOUNT: String(top), SUPLY_HSHLDCO: general, SPSPLY_HSHLDCO: special });
const cmp = (ty, rank, reside, req, supply) => ({ HOUSE_TY: ty, SUBSCRPT_RANK_CODE: rank, RESIDE_SECD: reside, REQ_CNT: String(req), SUPLY_HSHLDCO: supply, CMPET_RATE: '-' });
const MDL = {
  '2026000514': [mdl('075.9453 ', 96.8511, 69280, 27, 38), mdl('084.8860A', 107.7959, 77200, 171, 214)],
  '2025000415': [mdl('084.9900 ', 112.0, 90000, 100, 50)],
};
const CMPET = {
  // 실제 응답 수치: 075형 공급 59 · 1순위 31+2 · 2순위 17+5 → 잔여 4 / 084A 공급 375 · 1순위 72+13 · 2순위 31+4 → 잔여 255
  '2026000514': [cmp('075.9453 ', 1, '01', 31, 59), cmp('075.9453 ', 1, '02', 2, 59), cmp('075.9453 ', 2, '01', 17, 59), cmp('075.9453 ', 2, '02', 5, 59),
    cmp('084.8860A', 1, '01', 72, 375), cmp('084.8860A', 1, '02', 13, 375), cmp('084.8860A', 2, '01', 31, 375), cmp('084.8860A', 2, '02', 4, 375)],
  '2025000415': [cmp('084.9900 ', 1, '01', 1500, 100)],
};
const regionJson = JSON.stringify({ StanReginCd: [
  { head: [{ totalCount: 1 }, { RESULT: { resultCode: 'INFO-0' } }] },
  { row: [{ region_cd: '2635000000', sgg_cd: '350', umd_cd: '000', ri_cd: '00', locatadd_nm: '부산광역시 해운대구' }] },
] });
function fakeFetch(calls = [], { fail = () => false } = {}) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.includes('StanReginCd')) return { ok: true, status: 200, text: async () => regionJson };
    if (fail(u)) return { ok: false, status: 401, text: async () => '{"code":-401}' };
    const id = u.searchParams.get('cond[HOUSE_MANAGE_NO::EQ]');
    let data = [];
    if (u.pathname.endsWith('getAPTLttotPblancDetail')) data = LIST;
    if (u.pathname.endsWith('getAPTLttotPblancMdl')) data = MDL[id] || [];
    if (u.pathname.endsWith('getAPTLttotPblancCmpet')) data = CMPET[id] || [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ currentCount: data.length, data, matchCount: data.length, page: 1, perPage: 100 }) };
  };
}

test('최근 3년: 2026-11-16 → 2023-11-16 이후 모집공고', () => {
  assert.equal(AH.sinceDate(NOW), '2023-11-16');
});

test('단지 목록: APT 분양주택만 — 민간사전청약·분양전환 임대·다른 지역 제외', () => {
  const rows = [...LIST, listRow('2026000999', '다른 구', { HSSPLY_ADRES: '부산광역시 수영구 광안동' }), LIST[0]];
  const { complexes, excluded } = AH.pickComplexes(rows, '부산광역시 해운대구');
  assert.deepEqual(complexes.map((c) => c.id), ['2026000514', '2025000415']);
  assert.deepEqual(excluded, { notApt: 1, rental: 1, address: 1 });
});

test('주택형: 분양가 · 1·2순위 경쟁률 · 잔여세대 (실제 응답 수치)', () => {
  const [t75, t84] = AH.buildTypes(MDL['2026000514'], CMPET['2026000514']);
  assert.equal(t75.excl, 75.9453);
  assert.equal(t75.topAmount, 69280);
  assert.deepEqual({ ...t75.competition, rate1: undefined, rate2: undefined }, { supply: 59, rank1: 33, rank2: 22, remain: 4, rate1: undefined, rate2: undefined });
  assert.equal(t75.competition.rate1.toFixed(2), '0.56');
  assert.equal(t84.competition.remain, 255);
  const [full] = AH.buildTypes(MDL['2025000415'], CMPET['2025000415']);
  assert.equal(full.competition.remain, 0);
  assert.equal(full.competition.rate1, 15);
  assert.equal(AH.buildTypes([mdl('059.9', 80, 50000, 10, 5)], [])[0].competition, null); // 경쟁률 자료 없음
});

test('조회: 확인된 지역 이름으로 공급위치 LIKE · 모집공고일 GTE', async () => {
  const calls = [];
  const s = AH.createApplyhomeService({ key: 'K', fetchImpl: fakeFetch(calls), cacheDir: tmpDir(), now: () => NOW });
  const l = await s.list({ site: '부산광역시 해운대구' });
  assert.equal(l.status, 'ok');
  assert.equal(l.complexes.length, 2);
  const u = new URL(calls.find((x) => x.includes('getAPTLttotPblancDetail')));
  assert.equal(u.origin + u.pathname, 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail');
  assert.equal(u.searchParams.get('cond[HSSPLY_ADRES::LIKE]'), '부산광역시 해운대구');
  assert.equal(u.searchParams.get('cond[RCRIT_PBLANC_DE::GTE]'), '2023-11-16');
  const c = await s.complex({ site: '부산광역시 해운대구', id: '2026000514' });
  assert.equal(c.status, 'ok');
  assert.equal(c.types.length, 2);
  assert.ok(calls.some((x) => x.includes('ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet')));
});

test('하루 캐시: 목록·단지 모두 다시 부르지 않고, 하루 뒤에는 다시 부른다', async () => {
  const calls = [];
  let now = NOW;
  const dir = tmpDir();
  const opts = { key: 'K', fetchImpl: fakeFetch(calls), cacheDir: dir, now: () => now };
  const odc = () => calls.filter((x) => x.includes('odcloud')).length;
  await AH.createApplyhomeService(opts).complex({ site: '부산광역시 해운대구', id: '2026000514' });
  const first = odc();
  assert.equal(first, 3); // 목록 · 주택형 · 경쟁률
  const again = await AH.createApplyhomeService(opts).complex({ site: '부산광역시 해운대구', id: '2026000514' });
  assert.equal(again.cached, true);
  assert.equal(odc(), first);
  now += AH.CACHE_TTL_MS + 1;
  await AH.createApplyhomeService(opts).complex({ site: '부산광역시 해운대구', id: '2026000514' });
  assert.equal(odc(), first + 3);
});

test('목록에 없는 단지 번호 · 키 없음 · 인증 오류', async () => {
  const s = AH.createApplyhomeService({ key: 'K', fetchImpl: fakeFetch(), cacheDir: tmpDir(), now: () => NOW });
  assert.equal((await s.complex({ site: '부산광역시 해운대구', id: '1234567890' })).status, 'error');
  assert.equal((await AH.createApplyhomeService({ key: '', cacheDir: tmpDir() }).list({ site: '부산광역시 해운대구' })).status, 'no_key');
  const bad = AH.createApplyhomeService({ key: 'K', fetchImpl: fakeFetch([], { fail: () => true }), cacheDir: tmpDir(), now: () => NOW });
  const r = await bad.list({ site: '부산광역시 해운대구' });
  assert.equal(r.status, 'error');
  assert.match(r.message, /인증 정보가 정확하지 않습니다/);
});

test('서버 /api/applyhome: 결과만 보내고 인증키는 보내지 않는다', async () => {
  const server = createApp({ key: 'SECRETKEY123', fetchImpl: fakeFetch(), cacheDir: tmpDir(), now: () => NOW }).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const site = encodeURIComponent('부산광역시 해운대구');
    const t1 = await (await fetch(`${base}/api/applyhome/list?site=${site}`)).text();
    const t2 = await (await fetch(`${base}/api/applyhome/complex?site=${site}&id=2026000514`)).text();
    assert.equal(JSON.parse(t1).complexes.length, 2);
    assert.equal(JSON.parse(t2).types[0].competition.remain, 4);
    assert.doesNotMatch(t1 + t2, /SECRETKEY123/);
  } finally { server.close(); }
});

// ── 2장 ③④⑤ · 5장 시장 대비 여유 ──
async function fullApplyhome() {
  const s = AH.createApplyhomeService({ key: 'K', fetchImpl: fakeFetch(), cacheDir: tmpDir(), now: () => NOW });
  const list = await s.list({ site: '부산광역시 해운대구' });
  const details = {};
  for (const c of list.complexes) details[c.id] = await s.complex({ site: '부산광역시 해운대구', id: c.id });
  return { site: '부산광역시 해운대구', status: 'ok', list, details };
}
const months = Market.recentMonths(new Date(2026, 10, 16));
function marketWith(deals) {
  const m = { site: '부산광역시 해운대구', months, silv: {}, rent: {} };
  months.forEach((ym, i) => {
    m.silv[ym] = { status: 'ok', region: { name: '부산광역시 해운대구', code: '26350' }, fetchedAt: '2026-11-16T03:00:00Z',
      summary: { total: 0, cancelled: 0, count: 0, occupancyRights: 0, deals: i === 0 ? deals : [] } };
    m.rent[ym] = { status: 'ok', region: { name: '부산광역시 해운대구', code: '26350' }, fetchedAt: '2026-11-16T03:00:00Z',
      summary: { total: 0, count: 0, jeonse84New: { n: 0, sum: 0 }, renewal84: 0, blankType84: 0, monthly84: 0 } };
  });
  return m;
}
const DEALS = [
  { apt: '트리븐센텀2단지', area: 84.886, amount: 80200, right: false },  // 웃돈 +3,000
  { apt: '트리븐센텀2단지', area: 84.886, amount: 76200, right: false },  // 웃돈 −1,000
  { apt: '트리븐센텀2단지', area: 84.886, amount: 99999, right: true },   // 입주권 → 제외
  { apt: '다른아파트', area: 84.9, amount: 50000, right: false },          // 이름 불일치
  { apt: '베뉴브해운대', area: 59.9, amount: 60000, right: false },        // 면적 불일치
];

test('③ 공급평당 분양가: 분양최고금액 ÷ 공급면적(평), 세대 가중평균', async () => {
  const nb = Market.nearby84(await fullApplyhome());
  // 트리븐 084A: 77,200 ÷ (107.7959 × 121/400 평) = 2,367.49 · 베뉴브: 90,000 ÷ (112 × 121/400) = 2,656.4
  assert.equal(nb.rows.length, 2);
  assert.equal(Math.round(nb.rows[0].perPyeong), 2367);
  assert.equal(Math.round(nb.rows[1].perPyeong), 2656);
  assert.equal(nb.households, 385 + 150);
  assert.equal(Math.round(nb.avg), Math.round((2367.52 * 385 + 2656.37 * 150) / 535));
});

test('④ 분양권 웃돈: 같은 단지 · 같은 주택형 분양가와 비교, 입주권 제외', async () => {
  const pr = Market.premiums(marketWith(DEALS), await fullApplyhome());
  assert.deepEqual(pr.counts, { deals: 5, rights: 1, unmatchedName: 1, unmatchedType: 1, matched: 2 });
  assert.equal(pr.rows[0].name, '트리븐센텀 2단지');
  assert.equal(pr.rows[0].avgPremium, 1000);
  assert.equal(pr.rows[0].min, -1000);
  assert.equal(pr.rows[0].max, 3000);
});

test('④ 매칭 규칙: 2차 단지는 다른 단지 · 면적은 일치해야 · 같은 면적 타입 여럿이면 평균', () => {
  const cx = (id, name, types) => ({ c: { id, name }, d: { status: 'ok', types } });
  const list = [cx('1', '해운대경동리인뷰', []), cx('2', '트리븐센텀 1단지', []), cx('3', '트리븐센텀 2단지', [])];
  assert.equal(Market.matchComplex('해운대경동리인뷰2차', list), null);
  assert.equal(Market.matchComplex('해운대경동리인뷰', list).c.id, '1');
  assert.equal(Market.matchComplex('트리븐센텀2단지', list).c.id, '3');
  const ah = { status: 'ok', list: { complexes: [{ id: '9', name: '르엘 리버파크 센텀' }] }, details: { 9: { status: 'ok', types: [
    { type: '125.8735A', excl: 125.8735, topAmount: 267600 }, { type: '125.8735D', excl: 125.8735, topAmount: 241000 },
    { type: '125.6543B', excl: 125.6543, topAmount: 228000 }] } } };
  const pr = Market.premiums(marketWith([
    { apt: '르엘 리버파크 센텀', area: 125.8735, amount: 254300, right: false }, // 평균 254,300 → 웃돈 0
    { apt: '르엘 리버파크 센텀', area: 125.7, amount: 230000, right: false },    // 일치하는 면적 없음
  ]), ah);
  assert.equal(pr.rows[0].avgPremium, 0);
  assert.equal(pr.counts.unmatchedType, 1);
});

test('⑤ 1·2순위 미달 주택형만, 잔여 합계', async () => {
  const sf = Market.shortfalls(await fullApplyhome());
  assert.deepEqual(sf.rows.map((r) => [r.type, r.remain]), [['075.9453', 4], ['084.8860A', 255]]);
  assert.equal(sf.remain, 259);
  assert.equal(sf.typesTotal, 3);
});

const A = {
  name: '해운대 그린테라스', site: '부산광역시 해운대구',
  units: [{ name: '59형', excl: 59.9, supply: 25.6, count: 200 }, { name: '84형', excl: 84.9, supply: 34.6, count: 320 }],
  pricePerPyeong: 2420, retail: 150, otherInflow: 175, fixedCost: 3815.0, mainPF: 2450, pfFinanceCost: 480, subordinated: 400,
  region: { status: 'ok', input: '부산광역시 해운대구', name: '부산광역시 해운대구', code: '26350' },
};
const section = (raw, no) => Report.render(raw).match(new RegExp(`<section class="chapter" id="ch${no}">([\\s\\S]*?)</section>`))[1];
const text = (h) => h.replace(/<[^>]+>/g, '');

test('2장 ③④⑤: 표마다 지역 · 건수 · 제외 기준 · 조회일', async () => {
  const t = text(section({ ...A, market: marketWith(DEALS), applyhome: await fullApplyhome() }, 2));
  for (const h of ['③ 인근 신규 84㎡ 공급평당 분양가 vs 우리 계획가', '④ 분양권 웃돈', '⑤ 1·2순위 미달 주택형 · 잔여세대']) assert.match(t, new RegExp(h));
  assert.equal((t.match(/지역 부산광역시 해운대구 \(법정동코드 26350\)/g) || []).length, 5);
  assert.equal((t.match(/제외 기준/g) || []).length, 5);
  assert.equal((t.match(/조회일/g) || []).length, 5);
  assert.match(t, /단지 2곳 중 84㎡ 공급 2곳 · 주택형 2개 · 535세대/);
  assert.match(t, /민간사전청약·신혼희망타운 1곳 · 분양전환 가능임대 1곳 제외/);
  assert.match(t, /분양권 거래 5건 중 2건/);
  assert.match(t, /입주권 1건/);
  assert.match(t, /\+1,000만원/);
  assert.match(t, /미달 주택형 2개 \/ 전체 3개 · 잔여 259세대/);
});

test('5장: 결론 옆에 시장 대비 여유 — 상환 한계 평당가 vs 인근 신규 공급평당', async () => {
  const raw = { ...A, market: marketWith(DEALS), applyhome: await fullApplyhome() };
  const t = text(section(raw, 5));
  const avg = Math.round(Market.nearby84(raw.applyhome).avg);
  assert.match(t, /평당 1,934만원 \/ 분양률 80\.6% 이상이면 상환 가능/);
  assert.match(t, new RegExp(`시장 대비 여유.*상환 한계 평당 1,934만원 vs 인근 신규 84㎡ 공급평당 ${avg.toLocaleString('ko-KR')}만원`, 's'));
  // 여유 = 인근 평균 − 상환 한계 평당가 (반올림 전 값으로 계산)
  const gap = Math.round(Market.nearby84(raw.applyhome).avg - 1934.2);
  assert.match(t, new RegExp(`인근 신규 분양가보다 ${gap}만원\\(\\d+\\.\\d%\\) 낮게 팔아도 상환 가능`));
  assert.match(text(section({ ...A }, 5)), /시장 대비 여유 — 자료 없음 \(청약홈 조회 전\)/);
});

test('2장: 청약홈 진행 중 · 실패한 단지는 [다시 시도], 목록 실패도 [다시 시도]', async () => {
  const ah = await fullApplyhome();
  ah.details['2025000415'] = { status: 'error', message: '청약홈 HTTP 500' };
  const h = section({ ...A, market: marketWith([]), applyhome: ah }, 2);
  assert.match(h, /data-retry="ah:2025000415"/);
  assert.match(text(h), /1\/2곳 집계, 잠정/);
  const e = section({ ...A, market: marketWith([]), applyhome: { status: 'error', message: '인증 오류', details: {} } }, 2);
  assert.match(e, /data-retry="ahlist:"/);
});
