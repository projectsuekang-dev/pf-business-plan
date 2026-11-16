// 사업수지 계산 — 화면(app.js)과 분리된 순수 계산 모듈.
// 브라우저에서는 window.Calc, Node(테스트)에서는 require('./calc')로 사용한다.
// 단위: 공급면적 평, 평당가 만원, 그 외 금액 억원. 분양률은 0~1 (1 = 100%).
(function (root) {
  // 상수
  const SCHOOL_LAND_RATE = 0.008;   // 학교용지부담금 0.8% (분양수입 대비)
  const SALES_AGENCY_FEE = 300;     // 분양대행 수수료 — 팔린 세대당 300만원
  const MAN_PER_EOK = 10000;        // 1억원 = 10,000만원

  // 주택형 표의 공급면적 합계(평)와 세대수 합계를 구한다.
  // units: [{ supply: 공급평, count: 세대수 }, ...]
  function totals(units) {
    let supplyArea = 0, households = 0;
    for (const u of units) {
      supplyArea += (u.supply || 0) * (u.count || 0);
      households += u.count || 0;
    }
    return { supplyArea, households };
  }

  // 분양수입(억원) = (공급면적 × 평당가 ÷ 10,000 + 상가) × 분양률
  function salesRevenue(input, rate) {
    const { supplyArea } = totals(input.units);
    return (supplyArea * input.pricePerPyeong / MAN_PER_EOK + input.retail) * rate;
  }

  // 팔린 세대수 = 세대수 합계 × 분양률
  function soldHouseholds(input, rate) {
    return totals(input.units).households * rate;
  }

  // 기말현금(억원) = 분양수입 × (1 − 학교용지 0.8%)
  //               − 팔린 세대 × 분양대행 300만원 + 기타유입 − 고정비
  function endingCash(input, rate) {
    const revenue = salesRevenue(input, rate);
    const agencyFee = soldHouseholds(input, rate) * SALES_AGENCY_FEE / MAN_PER_EOK; // 만원 → 억원
    return revenue * (1 - SCHOOL_LAND_RATE) - agencyFee + input.otherInflow - input.fixedCost;
  }

  // 만기 누적 DSCR = 1 + (기말현금 + 후순위) ÷ (본PF + 본PF 금융비용)
  function dscr(input, rate) {
    return 1 + (endingCash(input, rate) + input.subordinated) / (input.mainPF + input.pfFinanceCost);
  }

  // LTV = 본PF ÷ 분양률 100%일 때 분양수입 — 분양률과 무관하게 항상 100% 기준
  function ltv(input) {
    return input.mainPF / salesRevenue(input, 1);
  }

  // 사업수지 항목별 금액과 폭포 차트 단계 — 3장 표와 차트가 같은 값을 쓰도록 여기서 한 번만 계산한다.
  // 단계: 분양수입 → 변동비(학교용지 + 분양대행) → 고정비 → 기타유입 → 기말현금
  // 각 단계의 from/to는 누적 금액(억원)이다. 차트는 이 값을 그리기만 한다.
  function breakdown(input, rate) {
    const revenue = salesRevenue(input, rate);
    const schoolLand = revenue * SCHOOL_LAND_RATE;
    const agencyFee = soldHouseholds(input, rate) * SALES_AGENCY_FEE / MAN_PER_EOK;
    const variableCost = schoolLand + agencyFee;
    const cash = endingCash(input, rate);
    const afterVariable = revenue - variableCost;
    const afterFixed = afterVariable - input.fixedCost;
    return {
      rate, revenue, schoolLand, agencyFee, variableCost, fixedCost: input.fixedCost, otherInflow: input.otherInflow, endingCash: cash,
      stages: [
        { key: 'revenue', label: '분양수입', kind: 'total', value: revenue, from: 0, to: revenue },
        { key: 'variable', label: '변동비', kind: 'down', value: -variableCost, from: revenue, to: afterVariable },
        { key: 'fixed', label: '고정비', kind: 'down', value: -input.fixedCost, from: afterVariable, to: afterFixed },
        { key: 'other', label: '기타유입', kind: 'up', value: input.otherInflow, from: afterFixed, to: afterFixed + input.otherInflow },
        { key: 'cash', label: '기말현금', kind: 'total', value: cash, from: 0, to: cash },
      ],
    };
  }

  // 상환 가능 여부 — 기말현금이 −후순위 이상이면 본PF(원금+금융비용)를 전액 상환할 수 있다.
  function canRepay(input, rate) {
    return endingCash(input, rate) >= -input.subordinated;
  }

  // 평당가만 바꾼 입력 사본을 만든다 (원본은 건드리지 않음).
  function withPrice(input, pricePerPyeong) {
    return { ...input, pricePerPyeong };
  }

  // 기말현금이 target(억원)이 되는 분양률(0~1)을 구한다. 평당가는 계획값 그대로.
  // 기말현금은 분양률에 대해 직선이므로 분양률 0%와 100% 두 점으로 정확히 풀린다.
  // 분양률을 올려도 기말현금이 늘지 않으면 null.
  function rateForCash(input, target) {
    const at0 = endingCash(input, 0), at1 = endingCash(input, 1);
    const slope = at1 - at0;
    if (!(slope > 0)) return null;
    return (target - at0) / slope;
  }

  // 기말현금이 target(억원)이 되는 평당가(만원)를 구한다. 분양률은 rate(기본 100%).
  // 기말현금은 평당가에 대해 직선이므로 평당가 0과 1만원 두 점으로 풀린다.
  function priceForCash(input, target, rate = 1) {
    const at0 = endingCash(withPrice(input, 0), rate);
    const slope = endingCash(withPrice(input, 1), rate) - at0;
    if (!(slope > 0)) return null;
    return (target - at0) / slope;
  }

  // 두 한계선: 기말현금 0(손익분기)과 기말현금 −후순위(PF 전액 상환 한계)
  // 각각 분양률(계획 평당가 기준)과 평당가(분양률 100% 기준)로 돌려준다.
  function thresholds(input) {
    return {
      breakEven: { rate: rateForCash(input, 0), price: priceForCash(input, 0) },
      repayLimit: { rate: rateForCash(input, -input.subordinated), price: priceForCash(input, -input.subordinated) },
    };
  }

  // 민감도 표 — 행: 분양률, 열: 평당가 변동(만원). 칸마다 기말현금과 상환 가능 여부.
  // 기본값: 분양률 75~100% 5%p 간격, 평당가 계획 −500 ~ +100만원 100만원 간격.
  function sensitivity(input, {
    rates = [0.75, 0.80, 0.85, 0.90, 0.95, 1.00],
    priceDeltas = [-500, -400, -300, -200, -100, 0, 100],
  } = {}) {
    const prices = priceDeltas.map((d) => input.pricePerPyeong + d);
    const rows = rates.map((rate) => ({
      rate,
      cells: prices.map((price) => {
        const x = withPrice(input, price);
        return { price, endingCash: endingCash(x, rate), canRepay: canRepay(x, rate) };
      }),
    }));
    return { rates, priceDeltas, prices, rows };
  }

  // 분양률 하나에 대한 결과를 한 번에 묶어 돌려준다.
  function summarize(input, rate) {
    return {
      rate,
      ...totals(input.units),
      salesRevenue: salesRevenue(input, rate),
      soldHouseholds: soldHouseholds(input, rate),
      endingCash: endingCash(input, rate),
      dscr: dscr(input, rate),
      ltv: ltv(input),
    };
  }

  const Calc = { SCHOOL_LAND_RATE, SALES_AGENCY_FEE, totals, salesRevenue, soldHouseholds, endingCash, dscr, ltv, summarize,
    breakdown, canRepay, withPrice, rateForCash, priceForCash, thresholds, sensitivity };
  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(typeof window !== 'undefined' ? window : globalThis);
