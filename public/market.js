// 시장 분석(실거래가) 공용 기준 — 서버(server/trades.js)와 보고서(report.js)가 같은 기준을 쓴다.
// 브라우저에서는 window.Market, Node에서는 require('./market.js').
(function (root) {
  const MONTHS = 12;                       // 최근 12개월
  const AREA_84 = { min: 83, max: 86 };    // "84㎡"로 보는 전용면적 범위 (83㎡ 이상 86㎡ 미만)
  const KINDS = { silv: '분양권', rent: '전월세' };

  // 전용면적이 84㎡ 범위인지
  function is84(area) {
    const a = Number(area);
    return Number.isFinite(a) && a >= AREA_84.min && a < AREA_84.max;
  }

  // 최근 12개월 계약월 목록(오래된 달 → 최근 달), 'YYYYMM'.
  // 이번 달은 신고 기한(계약 후 30일)이 남아 건수가 덜 잡히므로 빼고, 지난달까지로 한다.
  function recentMonths(today = new Date(), n = MONTHS) {
    const out = [];
    let y = today.getFullYear(), m = today.getMonth() + 1; // 이번 달
    for (let i = 0; i < n; i++) {
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
      out.unshift(`${y}${String(m).padStart(2, '0')}`);
    }
    return out;
  }

  // 'YYYYMM' → 'YYYY.MM'
  const ymLabel = (ym) => `${ym.slice(0, 4)}.${ym.slice(4, 6)}`;

  // ISO 시각 → 한국 날짜 'YYYY-MM-DD'
  const kstDate = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

  // ── 청약홈 인근 신규 분양 계산 (2장 ③④⑤) ─────────────────
  // ah = { status, list: { complexes, excluded, since, fetchedAt, region }, details: { id: { status, types, fetchedAt } } }
  const M2_PER_PYEONG = 400 / 121;   // 1평 = 3.3058㎡
  // 분양권 거래 ↔ 주택형 전용면적 허용 차이(㎡). 두 자료 모두 소수 4자리까지 같은 전용면적을 쓰므로 "일치"로 본다.
  // (±0.5로 넓히면 같은 이름의 2차 단지·다른 타입이 섞이는 것을 실데이터에서 확인 — 2026-11-16)
  const AREA_MATCH = 0.01;

  const okDetails = (ah) => (ah && ah.status === 'ok' ? ah.list.complexes.map((c) => ({ c, d: ah.details[c.id] })) : [])
    .filter(({ d }) => d && d.status === 'ok');

  // ③ 인근 신규 84㎡ 공급평당 분양가 — 주택형별 분양최고금액 ÷ 공급면적(평), 세대수(일반+특별) 가중평균
  function nearby84(ah) {
    const rows = [], without84 = [];
    let sumW = 0, sumPW = 0, typesN = 0;
    for (const { c, d } of okDetails(ah)) {
      const ts = d.types.filter((t) => is84(t.excl) && t.supplyAr > 0 && t.topAmount > 0);
      if (!ts.length) { without84.push(c.name); continue; }
      let w = 0, pw = 0;
      for (const t of ts) {
        const per = t.topAmount / (t.supplyAr / M2_PER_PYEONG);
        const hh = (t.general || 0) + (t.special || 0) || 1;
        w += hh; pw += per * hh;
      }
      rows.push({ id: c.id, name: c.name, noticeDate: c.noticeDate, types: ts.length, households: w, perPyeong: pw / w });
      sumW += w; sumPW += pw; typesN += ts.length;
    }
    return { rows, without84, typesN, households: sumW, avg: sumW ? sumPW / sumW : null };
  }

  // 단지명 비교용 — 괄호 내용 · 공백 · '아파트' · '주상복합' 제거
  const normName = (s) => String(s || '').replace(/\(.*?\)/g, '').replace(/아파트|주상복합/g, '').replace(/\s+/g, '').toLowerCase();

  // 분양권 거래의 단지명 → 청약홈 단지 (한쪽 이름이 다른 쪽에 들어 있으면 같은 단지, 여럿이면 가장 긴 이름)
  // 단, 남는 글자가 차수·단지 번호("2차", "1단지")면 다른 단지로 본다. 예: 해운대경동리인뷰2차 ≠ 해운대경동리인뷰
  function matchComplex(apt, complexes) {
    const a = normName(apt);
    if (a.length < 2) return null;
    const otherPhase = (long, short) => /^\d+(차|단지)|(\d+)(차|단지)$/.test(long.replace(short, ''));
    let best = null;
    for (const x of complexes) {
      const b = normName(x.c.name);
      if (b.length < 2 || !(a.includes(b) || b.includes(a))) continue;
      if (a !== b && otherPhase(a.length > b.length ? a : b, a.length > b.length ? b : a)) continue;
      if (!best || b.length > normName(best.c.name).length) best = x;
    }
    return best;
  }

  // ④ 분양권 웃돈 = 분양권 거래가 − 같은 단지 · 같은 주택형(전용면적 ±0.5㎡) 분양가. 입주권 제외.
  function premiums(market, ah) {
    const complexes = okDetails(ah);
    const counts = { deals: 0, rights: 0, unmatchedName: 0, unmatchedType: 0, matched: 0 };
    const by = new Map();
    if (!market) return { rows: [], counts, avg: null };
    for (const ym of market.months) {
      const r = market.silv[ym];
      if (!r || r.status !== 'ok' || !r.summary.deals) continue;
      for (const deal of r.summary.deals) {
        counts.deals++;
        if (deal.right) { counts.rights++; continue; }
        const x = matchComplex(deal.apt, complexes);
        if (!x) { counts.unmatchedName++; continue; }
        // 전용면적이 같은 주택형 — 같은 면적에 A/B/C 타입이 여럿이면 분양가 평균
        const same = x.d.types.filter((t) => t.topAmount > 0 && Math.abs((t.excl ?? -99) - (deal.area ?? 99)) <= AREA_MATCH);
        if (!same.length || deal.amount == null) { counts.unmatchedType++; continue; }
        const price = same.reduce((s, t) => s + t.topAmount, 0) / same.length;
        counts.matched++;
        const row = by.get(x.c.id) || { id: x.c.id, name: x.c.name, n: 0, deal: 0, price: 0, min: Infinity, max: -Infinity };
        const p = deal.amount - price;
        row.n++; row.deal += deal.amount; row.price += price;
        row.min = Math.min(row.min, p); row.max = Math.max(row.max, p);
        by.set(x.c.id, row);
      }
    }
    const rows = [...by.values()].map((r) => ({ ...r, avgDeal: r.deal / r.n, avgPrice: r.price / r.n, avgPremium: (r.deal - r.price) / r.n }))
      .sort((a, b) => b.n - a.n);
    const n = rows.reduce((s, r) => s + r.n, 0);
    return { rows, counts, avg: n ? rows.reduce((s, r) => s + r.deal - r.price, 0) / n : null };
  }

  // ⑤ 1·2순위 미달 주택형 · 잔여세대 (잔여 = 일반공급 − 1순위 − 2순위 접수)
  function shortfalls(ah) {
    const rows = [];
    let typesTotal = 0, noComp = 0;
    for (const { c, d } of okDetails(ah)) {
      for (const t of d.types) {
        typesTotal++;
        if (!t.competition) { noComp++; continue; }
        if (t.competition.remain > 0) rows.push({ id: c.id, name: c.name, noticeDate: c.noticeDate, type: t.type, excl: t.excl, topAmount: t.topAmount, ...t.competition });
      }
    }
    return { rows, typesTotal, noComp, remain: rows.reduce((s, r) => s + r.remain, 0), supply: rows.reduce((s, r) => s + r.supply, 0) };
  }

  const Market = { MONTHS, AREA_84, KINDS, is84, recentMonths, ymLabel, kstDate,
    M2_PER_PYEONG, AREA_MATCH, normName, matchComplex, nearby84, premiums, shortfalls };
  if (typeof module !== 'undefined' && module.exports) module.exports = Market;
  else root.Market = Market;
})(typeof window !== 'undefined' ? window : globalThis);
