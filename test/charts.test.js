// 차트 검사 — SVG 문자열 확인 (라이브러리 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../public/calc.js');
const Charts = require('../public/charts.js');
const Report = require('../public/report.js');

const A_INPUT = {
  units: [{ supply: 25.6, count: 200 }, { supply: 34.6, count: 320 }],
  pricePerPyeong: 2420, retail: 150, otherInflow: 175, fixedCost: 3815.0, mainPF: 2450, pfFinanceCost: 480, subordinated: 400,
};
const A = {
  name: '해운대 그린테라스', site: '부산광역시 해운대구',
  units: [{ name: '59형', excl: 59.9, supply: 25.6, count: 200 }, { name: '84형', excl: 84.9, supply: 34.6, count: 320 }],
  pricePerPyeong: 2420, retail: 150, otherInflow: 175, fixedCost: 3815.0, mainPF: 2450, pfFinanceCost: 480, subordinated: 400,
};
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const section = (raw, no) => Report.render(raw).match(new RegExp(`<section class="chapter" id="ch${no}">([\\s\\S]*?)</section>`))[1];

test('폭포 단계: 분양수입 → 변동비 → 고정비 → 기타유입 → 기말현금 (샘플 A)', () => {
  const b = Calc.breakdown(A_INPUT, 1);
  assert.deepEqual(b.stages.map((s) => s.label), ['분양수입', '변동비', '고정비', '기타유입', '기말현금']);
  const r1 = (v) => Math.round(v * 10) / 10;
  assert.deepEqual(b.stages.map((s) => r1(s.value)), [4068.5, -48.1, -3815, 175, 380.3]);
  // 누적이 끊김 없이 이어지고, 마지막 누적 = 기말현금
  for (let i = 1; i < 4; i++) assert.ok(Math.abs(b.stages[i].from - b.stages[i - 1].to) < 1e-9);
  assert.ok(Math.abs(b.stages[3].to - b.endingCash) < 1e-9);
  assert.equal(b.endingCash, Calc.endingCash(A_INPUT, 1));
});

test('차트는 받은 값만 그린다 — 다시 계산하지 않음', () => {
  // 일부러 맞지 않는 값을 넣어도 이름표는 받은 value 그대로
  const svg = Charts.waterfall({ stages: [
    { label: '가', kind: 'total', value: 111.1, from: 0, to: 50 },
    { label: '나', kind: 'down', value: -7.7, from: 50, to: 40 },
  ] });
  assert.match(svg, />111\.1</);
  assert.match(svg, />−7\.7</);
  const dots = Charts.dotLines({ points: [{ label: '갑', value: 2500 }], lines: [{ label: '계획가', value: 2420, color: '#000' }] });
  assert.match(dots, /계획가 2,420/);
  assert.equal((dots.match(/<circle/g) || []).length, 1);
});

test('3장 차트 ②: 표와 같은 값 · 아래에 단위 · 건수 · 조회일 · 출처', () => {
  const h = section(A, 3);
  assert.match(h, /<svg class="chart"/);
  const t = text(h);
  assert.match(t, /차트 ② · 사업수지 폭포/);
  for (const v of ['4,068.5', '−48.1', '−3,815.0', '\\+175.0', '380.3']) assert.match(h, new RegExp(`>${v}<`));
  assert.match(t, /단위 억원 · 분양률 100%/);
  assert.match(t, /건수 5단계 · 주택형 2개 · 520세대/);
  assert.match(t, /조회일 해당 없음/);
  assert.match(t, /출처 입력값/);
});

test('데이터가 없으면 빈 축 대신 "자료 없음"', () => {
  const zero = section({ ...A, pricePerPyeong: 0, retail: 0 }, 3);
  assert.doesNotMatch(zero, /<svg/);
  assert.match(zero, /chart-empty">자료 없음 — 분양수입이 0이거나 계산할 수 없음/);
  const ch5 = section(A, 5);
  assert.doesNotMatch(ch5, /<svg/);
  assert.match(ch5, /chart-empty">자료 없음 — 청약홈 조회 전/);
  assert.match(text(ch5), /차트 ① · 시장 대비 여유/);
  assert.match(text(ch5), /출처 한국부동산원 청약홈/);
});

test('5장 차트 ①: 인근 신규 점 + 계획가 · 상환 한계 · 인근 평균 선', () => {
  const ah = {
    status: 'ok',
    list: { complexes: [{ id: '1', name: '가 단지', noticeDate: '2026-10-16' }, { id: '2', name: '나 단지', noticeDate: '2025-09-19' }], fetchedAt: '2026-11-16T03:00:00Z', excluded: {} },
    details: {
      1: { status: 'ok', fetchedAt: '2026-11-16T03:00:00Z', types: [{ excl: 84.9, supplyAr: 112, topAmount: 90000, general: 100, special: 50 }] },
      2: { status: 'ok', fetchedAt: '2026-11-16T03:00:00Z', types: [{ excl: 84.8, supplyAr: 110, topAmount: 70000, general: 50, special: 0 }] },
    },
  };
  const h = section({ ...A, applyhome: ah }, 5);
  assert.equal((h.match(/<circle/g) || []).length, 2);
  assert.match(h, /계획가 2,420/);
  assert.match(h, /상환 한계 1,934/);
  assert.match(h, /인근 평균 /);
  const t = text(h);
  assert.match(t, /단위 만원 \/ 공급평/);
  assert.match(t, /건수 인근 신규 2곳 · 84㎡ 주택형 2개 · 200세대/);
  assert.match(t, /조회일 2026-11-16/);
});

test('차트 폭은 화면 폭을 따른다 (휴대폰 폭에서도 글자 크기 유지)', () => {
  const svg = Charts.waterfall({ width: 343, stages: Calc.breakdown(A_INPUT, 1).stages });
  assert.match(svg, /viewBox="0 0 343 /);
});
