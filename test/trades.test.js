// 실거래가 검사 — 실제 공공데이터를 부르지 않고 가짜 응답·임시 캐시 폴더로 확인 (키 불필요)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Trades = require('../server/trades.js');
const Market = require('../public/market.js');
const Report = require('../public/report.js');
const { createApp } = require('../server.js');

// ── 가짜 응답 ──
const xml = (items) => `<?xml version="1.0" encoding="utf-8"?><response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header><body><items>${
  items.map((i) => `<item>${Object.entries(i).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</item>`).join('')
}</items><numOfRows>1000</numOfRows><pageNo>1</pageNo><totalCount>${items.length}</totalCount></body></response>`;
const silvItem = (o = {}) => ({ aptNm: '가', dealAmount: '95,815', excluUseAr: '84.97', ownershipGbn: ' ', cdealType: ' ', ...o });
const rentItem = (o = {}) => ({ aptNm: '나', excluUseAr: '84.98', deposit: '50,000', monthlyRent: '0', contractType: '신규', ...o });
const regionJson = JSON.stringify({ StanReginCd: [
  { head: [{ totalCount: 1 }, { RESULT: { resultCode: 'INFO-0', resultMsg: 'NORMAL SERVICE' } }] },
  { row: [{ region_cd: '2635000000', sgg_cd: '350', umd_cd: '000', ri_cd: '00', locatadd_nm: '부산광역시 해운대구' }] },
] });

// 서비스별로 응답을 돌려주는 가짜 fetch. 호출 기록(URL)을 남긴다.
function fakeFetch({ silv = [silvItem()], rent = [rentItem()], fail = () => false } = {}, calls = []) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    let body;
    if (u.pathname.includes('StanReginCd')) body = regionJson;
    else if (fail(u)) return { ok: false, status: 500, text: async () => '' };
    else body = xml(u.pathname.includes('Silv') ? silv : rent);
    return { ok: true, status: 200, text: async () => body };
  };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trades-test-'));
const NOW = Date.parse('2026-11-16T03:00:00Z');

test('최근 12개월: 이번 달 빼고 지난달까지 (2026-11-16 → 2025.11 ~ 2026.10)', () => {
  const ms = Market.recentMonths(new Date(2026, 10, 16));
  assert.equal(ms.length, 12);
  assert.equal(ms[0], '202511');
  assert.equal(ms[11], '202610');
});

test('84㎡ 범위: 83 이상 86 미만', () => {
  assert.deepEqual([82.9, 83, 84.98, 85.99, 86].map(Market.is84), [false, true, true, true, false]);
});

test('XML 해석: 기술문서 응답 예제 형식', () => {
  const p = Trades.parseTradeXml(xml([silvItem(), silvItem()]));
  assert.equal(p.code, '000');
  assert.equal(p.items.length, 2);
  assert.equal(p.items[0].dealAmount, '95,815');
  const err = Trades.parseTradeXml('<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>');
  assert.equal(Trades.tradeErrorText(err.code), '등록되지 않은 서비스키입니다');
  assert.equal(Trades.tradeErrorText('03'), null); // No Data는 0건
});

test('분양권: 해제된 거래(cdealType O)는 뺀다, 입주권은 포함해 따로 센다', () => {
  const s = Trades.summarize('silv', [silvItem(), silvItem({ cdealType: 'O' }), silvItem({ ownershipGbn: '입' })]);
  assert.deepEqual({ ...s, deals: undefined }, { total: 3, cancelled: 1, count: 2, occupancyRights: 1, deals: undefined });
  assert.deepEqual(s.deals, [{ apt: '가', area: 84.97, amount: 95815, right: false }, { apt: '가', area: 84.97, amount: 95815, right: true }]);
});

test('전월세: 84㎡ 신규 전세만 평균에 — 갱신·월세·계약구분 미기재·84㎡ 밖은 제외', () => {
  const s = Trades.summarize('rent', [
    rentItem({ deposit: '40,000' }), rentItem({ deposit: '60,000' }),     // 평균에 포함
    rentItem({ contractType: '갱신' }),                                   // 갱신
    rentItem({ monthlyRent: '50' }),                                      // 월세
    rentItem({ contractType: ' ' }),                                      // 미기재
    rentItem({ excluUseAr: '59.9' }),                                     // 84㎡ 밖
  ]);
  assert.equal(s.count, 6);
  assert.deepEqual(s.jeonse84New, { n: 2, sum: 100000 });
  assert.equal(s.renewal84, 1);
  assert.equal(s.monthly84, 1);
  assert.equal(s.blankType84, 1);
});

test('조회: 지역코드는 서버가 이름으로 다시 확인해 LAWD_CD로 보낸다', async () => {
  const calls = [];
  const get = Trades.createTradeService({ key: 'K', fetchImpl: fakeFetch({}, calls), cacheDir: tmpDir(), now: () => NOW });
  const r = await get({ site: '부산광역시 해운대구', kind: 'rent', ym: '202609' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.region, { name: '부산광역시 해운대구', code: '26350' });
  const trade = new URL(calls.find((u) => u.includes('RTMSDataSvcAptRent')));
  assert.equal(trade.pathname, '/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent');
  assert.equal(trade.searchParams.get('LAWD_CD'), '26350');
  assert.equal(trade.searchParams.get('DEAL_YMD'), '202609');
});

test('하루 캐시: 같은 조회는 다시 부르지 않고, 하루가 지나면 다시 부른다', async () => {
  const calls = [];
  let now = NOW;
  const dir = tmpDir();
  const opts = { key: 'K', fetchImpl: fakeFetch({}, calls), cacheDir: dir, now: () => now };
  const count = () => calls.filter((u) => u.includes('SilvTrade')).length;
  await Trades.createTradeService(opts)({ site: '부산광역시 해운대구', kind: 'silv', ym: '202609' });
  assert.equal(count(), 1);
  // 서버를 새로 띄워도(새 서비스) 파일 캐시로 답한다
  const r2 = await Trades.createTradeService(opts)({ site: '부산광역시 해운대구', kind: 'silv', ym: '202609' });
  assert.equal(r2.cached, true);
  assert.equal(count(), 1);
  now += Trades.CACHE_TTL_MS + 1;
  await Trades.createTradeService(opts)({ site: '부산광역시 해운대구', kind: 'silv', ym: '202609' });
  assert.equal(count(), 2);
});

test('실패한 달은 오류로 돌려주고 캐시에 남기지 않는다', async () => {
  const calls = [];
  let failing = true;
  const opts = { key: 'K', fetchImpl: fakeFetch({ fail: () => failing }, calls), cacheDir: tmpDir(), now: () => NOW };
  const r = await Trades.createTradeService(opts)({ site: '부산광역시 해운대구', kind: 'rent', ym: '202609' });
  assert.equal(r.status, 'error');
  assert.match(r.message, /HTTP 500/);
  failing = false;
  const again = await Trades.createTradeService(opts)({ site: '부산광역시 해운대구', kind: 'rent', ym: '202609' });
  assert.equal(again.status, 'ok');
});

test('잘못된 요청 · 키 없음 · 지역 미확인은 공공데이터를 부르지 않는다', async () => {
  const calls = [];
  const get = Trades.createTradeService({ key: 'K', fetchImpl: fakeFetch({}, calls), cacheDir: tmpDir(), now: () => NOW });
  assert.equal((await get({ site: '부산광역시 해운대구', kind: 'sale', ym: '202609' })).status, 'error');
  assert.equal((await get({ site: '부산광역시 해운대구', kind: 'silv', ym: '202612' })).status, 'error'); // 미래
  assert.equal(calls.length, 0);
  const noKey = Trades.createTradeService({ key: '', fetchImpl: fakeFetch({}, calls), cacheDir: tmpDir() });
  assert.equal((await noKey({ site: '부산광역시 해운대구', kind: 'silv', ym: '202609' })).status, 'no_key');
  assert.equal(calls.length, 0);
  const r = await get({ site: '부산광역시', kind: 'silv', ym: '202609' }); // 가짜 지역 응답에 '부산광역시' 시군구 없음 → 확인 실패
  assert.equal(r.status, 'region');
  assert.equal(calls.filter((u) => u.includes('RTMS')).length, 0);
});

test('서버 /api/trades: 요약만 보내고 인증키·원자료는 보내지 않는다', async () => {
  const server = createApp({ key: 'SECRETKEY123', fetchImpl: fakeFetch(), cacheDir: tmpDir(), now: () => NOW }).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const text = await (await fetch(`${base}/api/trades?site=${encodeURIComponent('부산광역시 해운대구')}&kind=rent&ym=202609`)).text();
    const r = JSON.parse(text);
    assert.equal(r.status, 'ok');
    assert.equal(r.summary.jeonse84New.n, 1);
    assert.doesNotMatch(text, /SECRETKEY123/);
    assert.doesNotMatch(text, /aptNm|items/);
  } finally { server.close(); }
});

// ── 2장 보고서 ──
const A = {
  name: '해운대 그린테라스', site: '부산광역시 해운대구',
  units: [{ name: '59형', excl: 59.9, supply: 25.6, count: 200 }, { name: '84형', excl: 84.9, supply: 34.6, count: 320 }],
  pricePerPyeong: 2420, retail: 150, otherInflow: 175, fixedCost: 3815.0, mainPF: 2450, pfFinanceCost: 480, subordinated: 400,
  region: { status: 'ok', input: '부산광역시 해운대구', name: '부산광역시 해운대구', code: '26350' },
};
const months = Market.recentMonths(new Date(2026, 10, 16));
const okMonth = (kind, summary) => ({ status: 'ok', kind, region: { name: '부산광역시 해운대구', code: '26350' }, fetchedAt: '2026-11-16T03:00:00Z', summary });
function fullMarket() {
  const m = { site: A.site, months, silv: {}, rent: {} };
  for (const ym of months) {
    m.silv[ym] = okMonth('silv', { total: 11, cancelled: 1, count: 10, occupancyRights: 2 });
    m.rent[ym] = okMonth('rent', { total: 500, count: 500, jeonse84New: { n: 10, sum: 420000 }, renewal84: 4, blankType84: 1, monthly84: 30 });
  }
  return m;
}
const ch2 = (raw) => Report.render(raw).match(/<section class="chapter" id="ch2">([\s\S]*?)<\/section>/)[1];
const text = (h) => h.replace(/<[^>]+>/g, '');

test('2장 ①: 월별 건수 · 지역 · 건수 · 제외 기준 · 조회일', () => {
  const t = text(ch2({ ...A, market: fullMarket() }));
  assert.match(t, /① 월별 거래 건수/);
  assert.match(t, /2025\.11/);
  assert.match(t, /2026\.10/);
  assert.match(t, /지역 부산광역시 해운대구 \(법정동코드 26350\)/);
  assert.match(t, /분양권 120건 · 전월세 6,000건/);
  assert.match(t, /해제된 거래\(해제여부 'O'\) 12건 제외/);
  assert.match(t, /조회일 2026-11-16/);
});

test('2장 ②: 84㎡ 신규 전세 평균 ÷ 우리 84㎡ 세대당 분양가', () => {
  const t = text(ch2({ ...A, market: fullMarket() }));
  // 평균 = 420,000×12 ÷ 120 = 42,000만원 · 분양가 = 34.6평 × 2,420 = 83,732만원 → 50.2%
  assert.match(t, /120건/);
  assert.match(t, /42,000만원/);
  assert.match(t, /83,732만원/);
  assert.match(t, /50\.2%/);
  assert.match(t, /갱신 계약 48건 · 계약구분 미기재 12건 제외, 월세\(월세 > 0\) 360건 제외/);
  assert.doesNotMatch(t, /잠정/);
});

test('2장: 진행 중인 달은 …, 실패한 달은 오류와 [다시 시도], 비율은 잠정', () => {
  const m = fullMarket();
  m.rent[months[0]] = { status: 'error', message: '공공데이터 HTTP 500' };
  m.silv[months[1]] = { status: 'pending' };
  const h = ch2({ ...A, market: m });
  assert.match(h, /data-retry="rent:202511"/);
  assert.match(text(h), /오류 공공데이터 HTTP 500/);
  assert.match(text(h), /11\/12개월 집계/);
  assert.match(text(h), /잠정/);
});

test('2장: 우리 84㎡ 주택형이 없으면 분양가·잔금 여력은 "자료 없음"', () => {
  const raw = { ...A, units: [A.units[0]], market: fullMarket() };
  const t = text(ch2(raw));
  assert.match(t, /세대당 분양가자료 없음 — 전용 83~86㎡ 주택형 또는 평당가 미입력/);
  assert.match(t, /잔금 여력평균 보증금 ÷ 세대당 분양가자료 없음/);
});
