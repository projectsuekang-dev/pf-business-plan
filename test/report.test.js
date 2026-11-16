// 사업계획서 7개 장 검사 — Node 내장 node:test 사용 (npm test)
const test = require('node:test');
const assert = require('node:assert/strict');
const Report = require('../public/report.js');

// 화면 입력 형태(raw)의 샘플 A — 빈 칸은 null
const A = {
  name: '해운대 그린테라스', site: '부산광역시 해운대구',
  units: [{ name: '59형', excl: 59.9, supply: 25.6, count: 200 }, { name: '84형', excl: 84.9, supply: 34.6, count: 320 }],
  pricePerPyeong: 2420, retail: 150, otherInflow: 175, fixedCost: 3815.0,
  mainPF: 2450, pfFinanceCost: 480, subordinated: 400,
};
const EMPTY = { name: '', site: '', units: [{ name: '', excl: null, supply: null, count: null }],
  pricePerPyeong: null, retail: null, otherInflow: null, fixedCost: null, mainPF: null, pfFinanceCost: null, subordinated: null };

// 보고서를 장별 HTML로 나눈다 → { 1: '...', ..., 7: '...' }
function chapters(raw) {
  const out = Report.render(raw);
  const parts = {};
  for (const m of out.matchAll(/<section class="chapter" id="ch(\d)">([\s\S]*?)<\/section>/g)) parts[m[1]] = m[2];
  return parts;
}
const text = (html) => html.replace(/<[^>]+>/g, '');

test('7개 장이 순서대로 있다', () => {
  const out = Report.render(A);
  const titles = [...out.matchAll(/<h2><span class="no">(\d)<\/span>([^<]+)<\/h2>/g)].map((m) => m[1] + ' ' + m[2]);
  assert.deepEqual(titles, ['1 사업 개요', '2 시장 분석', '3 사업수지', '4 자금조달과 상환', '5 민감도', '6 리스크와 완화 방안', '7 확인하지 못한 것']);
});

test('2장은 "자료 없음 — 공공데이터 확인 필요"', () => {
  assert.match(chapters(A)[2], /자료 없음 — 공공데이터 확인 필요/);
});

test('7장에 "월별 자금수지 · IRR은 이 앱의 범위 밖"', () => {
  assert.match(text(chapters(A)[7]), /월별 자금수지 · IRR은 이 앱의 범위 밖/);
});

test('샘플 A 지표: 천단위 콤마와 수식이 함께 나온다', () => {
  const c = chapters(A);
  assert.match(text(c[1]), /16,192\.0/);
  assert.match(text(c[3]), /4,068\.5억/);
  assert.match(text(c[3]), /\+380\.3억/);
  assert.match(text(c[3]), /분양수입 × \(1 − 0\.8%\) − 분양대행 \+ 기타유입 − 고정비/);
  assert.match(text(c[4]), /1\.27/);
  assert.match(text(c[4]), /1 \+ \(기말현금 \+ 후순위\) ÷ \(본PF \+ 본PF 금융비용\)/);
  assert.match(text(c[4]), /60\.2%/);
  assert.match(text(c[5]), /평당 1,934만원 \/ 분양률 80\.6% 이상이면 상환 가능/);
});

test('음수는 빨간색(span.neg)으로 표시된다', () => {
  const c = chapters(A);
  assert.match(c[3], /<span class="neg">−3,815\.0억<\/span>/);   // 고정비
  assert.match(c[5], /<span class="neg">−1,227\.1<\/span>/);       // 민감도 75% · 1,920만원
});

test('6장은 두 한계선에서 리스크를 짚는다', () => {
  const t = text(chapters(A)[6]);
  assert.match(t, /분양률 미달/);
  assert.match(t, /90\.5%/);   // 손익분기 분양률
  assert.match(t, /80\.6%/);   // 상환 한계 분양률
  assert.match(t, /2,183만원/); // 손익분기 평당가
  assert.match(t, /1,934만원/); // 상환 한계 평당가
  assert.match(t, /완화 방안/);
});

test('빈 입력: 1~6장 모두 "자료 없음", 숫자로 채우지 않는다', () => {
  const c = chapters(EMPTY);
  for (const no of [1, 2, 3, 4, 5, 6]) {
    assert.match(c[no], /자료 없음/, `${no}장`);
    assert.doesNotMatch(text(c[no]), /\d+(\.\d+)?(억|만원|%)/, `${no}장에 근거 없는 숫자`);
  }
  assert.doesNotMatch(Report.render(EMPTY), /NaN|Infinity|undefined/);
});

test('일부만 빈 입력: 3장은 계산하고 4~6장만 "자료 없음"', () => {
  const c = chapters({ ...A, mainPF: null });
  assert.match(text(c[3]), /\+380\.3억/);
  for (const no of [4, 5, 6]) assert.match(text(c[no]), /자료 없음 — 미입력: 본PF/, `${no}장`);
  assert.match(text(c[7]), /입력되지 않은 값 — 본PF/);
});

test('0은 빈 칸이 아니다 — 기타유입 0을 입력하면 계산한다', () => {
  const c = chapters({ ...A, otherInflow: 0 });
  assert.doesNotMatch(c[3], /자료 없음/);
  assert.match(text(c[3]), /\+205\.3억/); // 380.3 − 175
});
