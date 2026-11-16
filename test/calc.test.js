// 사업수지 검산 테스트 — Node 내장 node:test 사용 (npm test)
const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../public/calc.js');

// 임시 값 A: 해운대 그린테라스 (금액 억원, 평당가 만원)
const A = {
  units: [{ supply: 25.6, count: 200 }, { supply: 34.6, count: 320 }],
  pricePerPyeong: 2420, retail: 150, otherInflow: 175, fixedCost: 3815.0,
  mainPF: 2450, pfFinanceCost: 480, subordinated: 400,
};

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

test('샘플 A 합계: 공급면적 16,192평 · 520세대', () => {
  assert.deepEqual(Calc.totals(A.units), { supplyArea: 16192, households: 520 });
});

test('샘플 A 분양률 100%: 기말현금 +380.3억', () => {
  assert.equal(round(Calc.endingCash(A, 1), 1), 380.3);
});

test('샘플 A 분양률 100%: DSCR 1.27', () => {
  assert.equal(round(Calc.dscr(A, 1), 2), 1.27);
});

test('샘플 A: LTV 60.2%', () => {
  assert.equal(round(Calc.ltv(A) * 100, 1), 60.2);
});

test('샘플 A 기말현금 0 한계: 분양률 90.5% · 평당 2,183만원', () => {
  const { breakEven } = Calc.thresholds(A);
  assert.equal(round(breakEven.rate * 100, 1), 90.5);
  assert.equal(Math.round(breakEven.price), 2183);
  // 한계값에서 실제로 기말현금이 0인지 되짚기
  assert.ok(Math.abs(Calc.endingCash(A, breakEven.rate)) < 1e-6);
  assert.ok(Math.abs(Calc.endingCash(Calc.withPrice(A, breakEven.price), 1)) < 1e-6);
});

test('샘플 A 상환 한계(기말현금 −후순위): 분양률 80.6% · 평당 1,934만원', () => {
  const { repayLimit } = Calc.thresholds(A);
  assert.equal(round(repayLimit.rate * 100, 1), 80.6);
  assert.equal(Math.round(repayLimit.price), 1934);
  assert.ok(Math.abs(Calc.endingCash(A, repayLimit.rate) + A.subordinated) < 1e-6);
});

test('샘플 A 민감도 표: 6행 × 7열, 상환 가능 판정이 한계선과 일치', () => {
  const s = Calc.sensitivity(A);
  assert.equal(s.rows.length, 6);
  assert.deepEqual(s.prices, [1920, 2020, 2120, 2220, 2320, 2420, 2520]);
  const at = (rate, price) => s.rows.find((r) => Math.abs(r.rate - rate) < 1e-9).cells.find((c) => c.price === price);
  assert.equal(at(0.80, 2420).canRepay, false); // 80% < 80.6%
  assert.equal(at(0.85, 2420).canRepay, true);
  assert.equal(at(1.00, 1920).canRepay, false); // 1,920 < 1,934
  assert.equal(at(1.00, 2020).canRepay, true);
  assert.equal(round(at(1.00, 2420).endingCash, 1), 380.3); // 계획값 칸 = 기존 기말현금
});

test('분양률을 낮추면 분양수입은 비례해서 줄고 LTV는 그대로', () => {
  assert.ok(Math.abs(Calc.salesRevenue(A, 0.8) - Calc.salesRevenue(A, 1) * 0.8) < 1e-9);
  assert.equal(Calc.summarize(A, 0.8).ltv, Calc.ltv(A));
});
