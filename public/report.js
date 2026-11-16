// 사업계획서 7개 장 — 입력값(raw)을 받아 보고서 HTML 문자열을 만든다.
// 계산은 calc.js에만 있고, 여기서는 그 결과를 문장·표로 옮기기만 한다.
// 원칙: 입력이 빈 항목은 "자료 없음"으로 두고, 근거 없는 숫자를 채우지 않는다.
// 브라우저에서는 window.Report, Node(테스트·빌드)에서는 require('./report')로 사용한다.
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const Calc = isNode ? require('./calc.js') : root.Calc;
  const Market = isNode ? require('./market.js') : root.Market;
  const Charts = isNode ? require('./charts.js') : root.Charts;

  const NO_DATA = '자료 없음';
  const LABEL = {
    pricePerPyeong: '평당가', retail: '상가', otherInflow: '기타유입', fixedCost: '고정비',
    mainPF: '본PF', pfFinanceCost: '본PF 금융비용', subordinated: '후순위',
  };
  const REQ_PL = ['pricePerPyeong', 'retail', 'otherInflow', 'fixedCost'];          // 3장에 필요한 값
  const REQ_FIN = [...REQ_PL, 'mainPF', 'pfFinanceCost', 'subordinated'];           // 4~6장에 필요한 값

  // ── 표기 도우미 ─────────────────────────────────────────

  // HTML 특수문자 이스케이프 — 사용자가 입력한 문자열에 사용
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 숫자 → 천단위 콤마, 소수 d자리 고정. 음수는 빨간색(span.neg)과 '−' 기호.
  // signed=true면 양수 앞에 '+'. 반올림 결과가 0이면 부호 없이 0으로 표시.
  function n(v, d = 0, { signed = false, unit = '' } = {}) {
    const p = 10 ** d;
    const r = Math.round(v * p) / p;
    const s = Math.abs(r).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }) + unit;
    if (r < 0) return `<span class="neg">−${s}</span>`;
    return (signed && r > 0 ? '+' : '') + s;
  }
  const eok = (v, signed = false) => n(v, 1, { signed, unit: '억' });     // 억원, 소수 1자리
  const man = (v) => n(v, 0, { unit: '만원' });                              // 만원, 정수
  const pct = (ratio, d = 1) => n(ratio * 100, d, { unit: '%' });            // 비율(0~1) → %

  // 분양률 한계값 표기 — 0~100% 밖이면 의미를 덧붙인다.
  function rateText(r) {
    if (r == null) return '계산 불가';
    if (r > 1) return `${pct(r)} <small>(100% 초과 — 전량 분양해도 미달)</small>`;
    if (r <= 0) return `${pct(r)} <small>(분양 없이도 충족)</small>`;
    return pct(r);
  }

  const noData = (reason) => `<p class="nodata">${NO_DATA}${reason ? ' — ' + esc(reason) : ''}</p>`;
  const chapter = (no, title, body) =>
    `<section class="chapter" id="ch${no}"><h2><span class="no">${no}</span>${title}</h2>${body}</section>`;

  // ── 입력 점검 ─────────────────────────────────────────

  // 빈 칸을 가려낸다. 숫자는 null이면 미입력. 완전히 빈 주택형 행은 무시.
  function inspect(raw) {
    const blank = (v) => v == null || v === '';
    const rows = (raw.units || []).filter((u) => ['name', 'excl', 'supply', 'count'].some((k) => !blank(u[k])));
    const unitsOk = rows.length > 0 && rows.every((u) => !blank(u.supply) && !blank(u.count));
    const missing = (keys) => keys.filter((k) => blank(raw[k]));
    const reason = (keys) => {
      const list = [...(unitsOk ? [] : ['주택형(공급평·세대수)']), ...missing(keys).map((k) => LABEL[k])];
      return list.length ? '미입력: ' + list.join(', ') : '';
    };
    return { rows, unitsOk, missing, reason, ready: (keys) => unitsOk && missing(keys).length === 0 };
  }

  // 계산 모듈 입력 형태로 바꾼다 (점검을 통과한 값만 들어온다는 전제).
  function toInput(raw, rows) {
    const input = { units: rows.map((u) => ({ supply: u.supply, count: u.count })) };
    for (const k of REQ_FIN) input[k] = raw[k] ?? null;
    return input;
  }

  // ── 지역 확인 결과 (서버 /api/region) ────────────────
  // 정확히 하나로 맞은 경우(ok)만 지역·코드를 쓰고, 나머지는 사유와 함께 "자료 없음".
  function regionInfo(raw) {
    const r = raw.region;
    if (!raw.site || !raw.site.trim()) return { ok: false, reason: '사업대상지 미입력' };
    if (!r) return { ok: false, reason: '지역 확인 전' };
    switch (r.status) {
      case 'ok': return { ok: true, name: r.name, code: r.code };
      case 'pending': return { ok: false, reason: '지역 확인 중' };
      case 'no_key': return { ok: false, reason: '공공데이터 인증키 미설정' };
      case 'not_found': return { ok: false, reason: '일치하는 시군구 없음' };
      case 'error': return { ok: false, reason: '조회 실패: ' + (r.message || '') };
      case 'ambiguous': {
        const list = (r.candidates || []).slice(0, 8).map((c) => `${esc(c.name)}(${esc(c.code)})`).join(', ');
        const rest = (r.candidates || []).length > 8 || r.more ? ' 외' : '';
        return { ok: false, reason: `하나로 확인되지 않음 · 후보 ${(r.candidates || []).length}${r.more ? '+' : ''}개`, candidates: list + rest };
      }
      default: return { ok: false, reason: '' };
    }
  }

  // ── 1장 사업 개요 ─────────────────────────────────────

  function ch1(raw, chk) {
    const hasName = !!(raw.name && raw.name.trim()), hasSite = !!(raw.site && raw.site.trim());
    if (!hasName && !hasSite && chk.rows.length === 0) return chapter(1, '사업 개요', noData('사업명·사업대상지·주택형 미입력'));

    const rg = regionInfo(raw);
    const kv = `<table class="kv stack"><tbody>
      <tr><th>사업명</th><td data-label="사업명">${hasName ? esc(raw.name) : NO_DATA}</td></tr>
      <tr><th>사업대상지</th><td data-label="사업대상지">${hasSite ? esc(raw.site) : NO_DATA}</td></tr>
      <tr><th>확인된 지역</th><td data-label="확인된 지역">${rg.ok ? esc(rg.name) : `${NO_DATA}${rg.reason ? ' — ' + esc(rg.reason) : ''}`}</td></tr>
      <tr><th>법정동코드</th><td data-label="법정동코드 (시군구)">${rg.ok ? `<span class="code">${esc(rg.code)}</span> <small>시군구 5자리 · 행정안전부 법정동코드</small>` : NO_DATA}</td></tr>
    </tbody></table>${rg.candidates ? `<p class="basis">후보: ${rg.candidates}</p>` : ''}`;

    let units;
    if (chk.rows.length === 0) units = noData('주택형 미입력');
    else {
      let sumCount = 0, sumArea = 0;
      const cell = (v, d) => (v == null || v === '' ? NO_DATA : n(v, d));
      const body = chk.rows.map((u) => {
        const ok = u.supply != null && u.count != null;
        if (ok) { sumCount += u.count; sumArea += u.supply * u.count; }
        return `<tr>
          <td data-label="주택형">${u.name ? esc(u.name) : NO_DATA}</td>
          <td data-label="전용㎡" class="r">${cell(u.excl, 1)}</td>
          <td data-label="공급평" class="r">${cell(u.supply, 1)}</td>
          <td data-label="세대수" class="r">${cell(u.count, 0)}</td>
          <td data-label="공급면적(평)" class="r">${ok ? n(u.supply * u.count, 1) : NO_DATA}</td></tr>`;
      }).join('');
      const foot = chk.unitsOk
        ? `<tfoot><tr><td data-label="">합계</td><td></td><td></td>
             <td data-label="세대수 합계" class="r">${n(sumCount)}</td>
             <td data-label="공급면적 합계(평)" class="r">${n(sumArea, 1)}</td></tr></tfoot>`
        : '';
      units = `<table class="grid stack"><thead><tr><th>주택형</th><th class="r">전용㎡</th><th class="r">공급평</th><th class="r">세대수</th>
        <th class="r">공급면적(평)<small>= 공급평 × 세대수</small></th></tr></thead><tbody>${body}</tbody>${foot}</table>`;
    }
    return chapter(1, '사업 개요', kv + '<h3>주택형</h3>' + units);
  }

  // ── 2장 시장 분석 ─────────────────────────────────────

  // raw.market = { months: ['YYYYMM'…], silv: {ym: 결과}, rent: {ym: 결과} } — 서버 /api/trades 결과
  // 결과: { status: 'ok' | 'pending' | 'error', summary, region, fetchedAt, message }
  // 끝난 달만 숫자로 쓰고, 진행 중인 달은 "…", 실패한 달은 오류와 [다시 시도].

  // 시장 자료 진행 상태 요약
  function marketState(m) {
    const kinds = Object.keys(Market.KINDS);
    const list = (k) => m.months.map((ym) => m[k][ym] || { status: 'pending' });
    const ok = (k) => list(k).filter((r) => r.status === 'ok');
    const all = kinds.flatMap(list);
    const done = all.filter((r) => r.status === 'ok');
    const region = (done[0] || {}).region;
    const dates = [...new Set(done.map((r) => Market.kstDate(r.fetchedAt)))].sort();
    return {
      ok, region,
      complete: all.every((r) => r.status === 'ok'),
      fetched: dates.length ? (dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`) : null,
      period: `${Market.ymLabel(m.months[0])} ~ ${Market.ymLabel(m.months[m.months.length - 1])}`,
    };
  }

  // 표 아래 근거 줄: 지역 · 건수 · 제외 기준 · 조회일
  const basisList = (items) => `<ul class="basis-list">${items.map(([k, v]) => `<li><b>${k}</b> ${v}</li>`).join('')}</ul>`;

  // 월별 칸: 끝난 달 → 숫자, 진행 중 → …, 실패 → 오류 + [다시 시도]
  function monthCell(r, kind, ym, label) {
    if (!r || r.status === 'pending') return `<td data-label="${label}" class="r muted">…</td>`;
    if (r.status === 'error') {
      return `<td data-label="${label}" class="r"><span class="neg">오류</span> <small>${esc(r.message || '')}</small>
        <button type="button" class="ghost retry no-print" data-retry="${kind}:${ym}">다시 시도</button></td>`;
    }
    return `<td data-label="${label}" class="r">${n(r.summary.count)}</td>`;
  }

  function ch2(raw, chk) {
    const m = raw.market;
    if (!m) return chapter(2, '시장 분석', noData('공공데이터 확인 필요'));
    const st = marketState(m);
    const regionText = st.region ? `${esc(st.region.name)} (법정동코드 ${esc(st.region.code)})` : esc(raw.region && raw.region.name || NO_DATA);
    const partial = (k) => (st.ok(k).length < m.months.length ? ` <small>(${st.ok(k).length}/${m.months.length}개월 집계)</small>` : '');
    const sum = (k, f) => st.ok(k).reduce((a, r) => a + f(r.summary), 0);

    // ① 월별 거래 건수
    const rows = m.months.map((ym) => `<tr><th>${Market.ymLabel(ym)}</th>
      ${monthCell(m.silv[ym], 'silv', ym, '분양권')}${monthCell(m.rent[ym], 'rent', ym, '전월세')}</tr>`).join('');
    const silvN = sum('silv', (s) => s.count), rentN = sum('rent', (s) => s.count);
    const t1 = `<h3>① 월별 거래 건수 <small>계약월 기준 · 건</small></h3>
      <table class="grid stack monthly"><thead><tr><th>계약월</th><th class="r">분양권</th><th class="r">전월세</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td data-label="">합계</td><td data-label="분양권 합계" class="r">${n(silvN)}${partial('silv')}</td><td data-label="전월세 합계" class="r">${n(rentN)}${partial('rent')}</td></tr></tfoot></table>
      ${basisList([
        ['지역', regionText],
        ['건수', `분양권 ${n(silvN)}건 · 전월세 ${n(rentN)}건 (${st.period}, 이번 달은 신고 기한이 남아 제외)`],
        ['제외 기준', `분양권 — 해제된 거래(해제여부 'O') ${n(sum('silv', (s) => s.cancelled))}건 제외, 입주권 ${n(sum('silv', (s) => s.occupancyRights))}건 포함 · 전월세 — 기술문서에 해제 항목이 없어 제외 없음`],
        ['조회일', st.fetched || '조회 중'],
      ])}`;

    // ② 잔금 여력 — 84㎡ 신규 전세 평균 ÷ 우리 84㎡ 세대당 분양가
    const band = `전용 ${Market.AREA_84.min}~${Market.AREA_84.max}㎡`;
    const jn = sum('rent', (s) => s.jeonse84New.n), js = sum('rent', (s) => s.jeonse84New.sum);
    const avg = jn > 0 ? js / jn : null;
    const our = chk.rows.find((u) => Market.is84(u.excl) && u.supply != null);
    const price = raw.pricePerPyeong;
    const unitPrice = our && price != null ? our.supply * price : null;
    const ratio = avg != null && unitPrice ? avg / unitPrice : null;
    const pending = st.ok('rent').length < m.months.length;
    const r2 = (label, formula, value, cls = '') =>
      `<tr class="${cls}"><th>${label}</th><td data-label="수식" class="formula">${formula}</td><td data-label="값" class="r amt">${value}</td></tr>`;
    const t2 = `<h3>② 잔금 여력 <small>84㎡ 신규 전세 평균 ÷ 우리 84㎡ 세대당 분양가</small></h3>
      <table class="pl stack"><thead><tr><th>항목</th><th>수식</th><th class="r">값</th></tr></thead><tbody>
      ${r2('84㎡ 신규 전세', `${band} · 월세 0 · 계약구분 '신규'`, st.ok('rent').length ? `${n(jn)}건` : '…')}
      ${r2('평균 보증금', '보증금 합계 ÷ 건수', avg != null ? man(avg) : (st.ok('rent').length ? NO_DATA : '…'))}
      ${r2('우리 84㎡ 세대당 분양가', our && price != null ? `${esc(our.name || '84㎡형')} 공급 ${n(our.supply, 1)}평 × 평당가 ${man(price)}` : `${NO_DATA} — ${band} 주택형 또는 평당가 미입력`, unitPrice != null ? man(unitPrice) : NO_DATA)}
      ${r2('잔금 여력', '평균 보증금 ÷ 세대당 분양가', ratio != null ? pct(ratio) + (pending ? ' <small>(잠정)</small>' : '') : NO_DATA, 'total')}
      </tbody></table>
      ${basisList([
        ['지역', regionText],
        ['건수', `84㎡ 신규 전세 ${n(jn)}건 (${st.period})${pending ? ` — 전월세 ${st.ok('rent').length}/${m.months.length}개월 집계, 잠정` : ''}`],
        ['제외 기준', `${band} 전세 중 갱신 계약 ${n(sum('rent', (s) => s.renewal84))}건 · 계약구분 미기재 ${n(sum('rent', (s) => s.blankType84))}건 제외, 월세(월세 > 0) ${n(sum('rent', (s) => s.monthly84))}건 제외`],
        ['조회일', st.fetched || '조회 중'],
      ])}`;

    return chapter(2, '시장 분석',
      `<p class="basis">출처: 국토교통부 실거래가 공개(아파트 분양권전매 · 아파트 전월세) · 한국부동산원 청약홈(분양정보 · 청약 경쟁률) · 금액 만원</p>
       ${t1}${t2}${applyhomeTables(raw, m, st, regionText)}`);
  }

  // ── 2장 ③④⑤ 청약홈 인근 신규 분양 ─────────────────
  function ahState(ah) {
    const details = ah && ah.status === 'ok' ? ah.list.complexes.map((c) => ah.details[c.id] || { status: 'pending' }) : [];
    const ok = details.filter((d) => d.status === 'ok');
    const dates = [...new Set([ah && ah.list && ah.list.fetchedAt, ...ok.map((d) => d.fetchedAt)].filter(Boolean).map(Market.kstDate))].sort();
    return {
      total: details.length, done: ok.length,
      complete: details.every((d) => d.status === 'ok'),
      fetched: dates.length ? (dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`) : '조회 중',
    };
  }

  // 단지 상세가 아직이거나 실패한 경우의 칸
  function complexPendingCell(d, id, colspan) {
    if (!d || d.status === 'pending') return `<td colspan="${colspan}" class="muted">…</td>`;
    return `<td colspan="${colspan}"><span class="neg">오류</span> <small>${esc(d.message || '')}</small>
      <button type="button" class="ghost retry no-print" data-retry="ah:${esc(id)}">다시 시도</button></td>`;
  }

  function applyhomeTables(raw, m, st, regionText) {
    const ah = raw.applyhome;
    const head = (no, title, sub) => `<h3>${no} ${title} <small>${sub}</small></h3>`;
    const titles = [
      ['③', '인근 신규 84㎡ 공급평당 분양가 vs 우리 계획가', '청약홈 · 최근 3년 모집공고'],
      ['④', '분양권 웃돈', '분양권 거래가 − 같은 단지 분양가 · 입주권 제외'],
      ['⑤', '1·2순위 미달 주택형 · 잔여세대', '잔여 = 일반공급 − 1·2순위 접수'],
    ];
    // 목록 단계에서 멈춘 경우: 세 표 모두 같은 상태 문구
    let blocker = null;
    if (!ah) blocker = noData('청약홈 조회 전');
    else if (ah.status === 'pending') blocker = '<p class="nodata">청약홈 단지 목록 확인 중…</p>';
    else if (ah.status === 'error') blocker = `<p class="nodata"><span class="neg">청약홈 목록 오류</span> ${esc(ah.message || '')} <button type="button" class="ghost retry no-print" data-retry="ahlist:">다시 시도</button></p>`;
    else if (!ah.list.complexes.length) blocker = noData(`최근 ${3}년 공급위치에 '${ah.list.region.name}'이(가) 들어간 APT 분양 단지 없음`);
    if (blocker) return titles.map(([no, t, s]) => head(no, t, s) + blocker).join('');

    const L = ah.list, S = ahState(ah);
    const ex = L.excluded || {};
    const period = `${L.since} 이후 모집공고`;
    const progress = S.complete ? '' : ` — ${S.done}/${S.total}곳 집계, 잠정`;
    const areaLabel = `전용 ${Market.AREA_84.min}~${Market.AREA_84.max}㎡`;
    const listExcl = `민간사전청약·신혼희망타운 ${n(ex.notApt || 0)}곳 · 분양전환 가능임대 ${n(ex.rental || 0)}곳 제외`;
    const plan = raw.pricePerPyeong;

    // ③
    const nb = Market.nearby84(ah);
    const nbRow = new Map(nb.rows.map((r) => [r.id, r]));
    const diffCells = (per) => (plan == null
      ? `<td data-label="우리 계획가 대비" class="r">${NO_DATA}</td>`
      : `<td data-label="우리 계획가 대비" class="r">${n(plan - per, 0, { signed: true })}만원 <small>(${pct((plan - per) / per)})</small></td>`);
    const rows3 = L.complexes.map((c) => {
      const d = ah.details[c.id], r = nbRow.get(c.id);
      const lead = `<tr><th>${esc(c.name)}</th><td data-label="모집공고">${esc(c.noticeDate || '')}</td>`;
      if (!d || d.status !== 'ok') return `${lead}${complexPendingCell(d, c.id, 3)}</tr>`;
      if (!r) return `${lead}<td colspan="3" class="muted">84㎡ 주택형 없음</td></tr>`;
      return `${lead}<td data-label="84㎡ 주택형 · 세대" class="r">${n(r.types)}개 · ${n(r.households)}세대</td>
        <td data-label="공급평당 분양가" class="r">${man(r.perPyeong)}</td>${diffCells(r.perPyeong)}</tr>`;
    }).join('');
    const foot3 = nb.avg != null
      ? `<tfoot><tr><td data-label="">인근 평균 <small>세대 가중</small></td><td></td><td data-label="84㎡ 주택형 · 세대" class="r">${n(nb.typesN)}개 · ${n(nb.households)}세대</td>
         <td data-label="공급평당 분양가" class="r">${man(nb.avg)}</td>${diffCells(nb.avg)}</tr>
         <tr><td data-label="">우리 계획가</td><td></td><td></td><td data-label="평당가" class="r">${plan == null ? NO_DATA : man(plan)}</td><td></td></tr></tfoot>`
      : '';
    const t3 = head(...titles[0]) + `<table class="grid stack nearby"><thead><tr><th>단지</th><th>모집공고</th><th class="r">84㎡ 주택형 · 세대</th>
        <th class="r">공급평당 분양가<small>= 분양최고금액 ÷ 공급면적(평)</small></th><th class="r">우리 계획가 대비<small>= 계획가 − 인근</small></th></tr></thead>
        <tbody>${rows3}</tbody>${foot3}</table>
      ${basisList([
        ['지역', regionText],
        ['건수', `단지 ${n(L.complexes.length)}곳 중 84㎡ 공급 ${n(nb.rows.length)}곳 · 주택형 ${n(nb.typesN)}개 · ${n(nb.households)}세대 (${period})${progress}`],
        ['제외 기준', `공급위치에 지역 이름이 없는 단지 · ${listExcl} · 84㎡(${areaLabel}) 주택형이 없는 단지 ${n(nb.without84.length)}곳 · 분양가는 주택형별 분양최고금액(층·향 할인 미반영)`],
        ['조회일', S.fetched],
      ])}`;

    // ④
    const pr = Market.premiums(m, ah);
    const rows4 = pr.rows.length
      ? pr.rows.map((r) => `<tr><th>${esc(r.name)}</th><td data-label="거래" class="r">${n(r.n)}건</td>
          <td data-label="평균 거래가" class="r">${man(r.avgDeal)}</td><td data-label="평균 분양가" class="r">${man(r.avgPrice)}</td>
          <td data-label="평균 웃돈" class="r"><b>${n(r.avgPremium, 0, { signed: true })}만원</b></td>
          <td data-label="웃돈 범위" class="r">${n(r.min, 0, { signed: true })} ~ ${n(r.max, 0, { signed: true })}</td></tr>`).join('')
      : `<tr><td colspan="6" class="muted">${S.done || st.ok('silv').length ? '청약홈 단지와 맞는 분양권 거래 없음' : '…'}</td></tr>`;
    const foot4 = pr.avg != null
      ? `<tfoot><tr><td data-label="">전체 평균</td><td data-label="거래" class="r">${n(pr.counts.matched)}건</td><td></td><td></td>
         <td data-label="평균 웃돈" class="r">${n(pr.avg, 0, { signed: true })}만원</td><td></td></tr></tfoot>` : '';
    const silvPartial = st.ok('silv').length < m.months.length;
    const t4 = head(...titles[1]) + `<table class="grid stack"><thead><tr><th>단지</th><th class="r">거래</th><th class="r">평균 거래가</th>
        <th class="r">평균 분양가<small>같은 주택형 최고금액</small></th><th class="r">평균 웃돈<small>= 거래가 − 분양가</small></th><th class="r">웃돈 범위</th></tr></thead>
        <tbody>${rows4}</tbody>${foot4}</table>
      ${basisList([
        ['지역', regionText],
        ['건수', `분양권 거래 ${n(pr.counts.deals)}건 중 ${n(pr.counts.matched)}건 (①의 ${st.period}, 해제 거래 제외 후)${silvPartial || !S.complete ? ' — 집계 중, 잠정' : ''}`],
        ['제외 기준', `입주권 ${n(pr.counts.rights)}건 · 청약홈 단지와 이름이 맞지 않는 거래(차수·단지 번호가 다른 단지 포함) ${n(pr.counts.unmatchedName)}건 · 전용면적이 일치하는 주택형이 없는 거래 ${n(pr.counts.unmatchedType)}건 제외 · 같은 면적 타입이 여럿이면 분양가 평균 · 분양가가 최고금액이라 웃돈은 실제보다 작게 잡힘(발코니 확장·옵션 미반영)`],
        ['조회일', `분양권 ${st.fetched || '조회 중'} · 청약홈 ${S.fetched}`],
      ])}`;

    // ⑤
    const sf = Market.shortfalls(ah);
    const rows5 = sf.rows.length
      ? sf.rows.map((r) => `<tr><th>${esc(r.name)}</th><td data-label="주택형">${esc(r.type)}</td>
          <td data-label="일반공급" class="r">${n(r.supply)}</td>
          <td data-label="1순위 접수 (경쟁률)" class="r">${n(r.rank1)} <small>(${n(r.rate1, 2)} : 1)</small></td>
          <td data-label="2순위 접수" class="r">${r.rank2 == null ? '–' : n(r.rank2)}</td>
          <td data-label="잔여세대" class="r"><b class="neg">${n(r.remain)}</b></td></tr>`).join('')
      : `<tr><td colspan="6" class="muted">${S.done ? '1·2순위에서 미달된 주택형 없음' : '…'}</td></tr>`;
    const foot5 = sf.rows.length
      ? `<tfoot><tr><td data-label="">합계</td><td data-label="주택형">${n(sf.rows.length)}개</td><td data-label="일반공급" class="r">${n(sf.supply)}</td><td></td><td></td>
         <td data-label="잔여세대" class="r">${n(sf.remain)}</td></tr></tfoot>` : '';
    const t5 = head(...titles[2]) + `<table class="grid stack"><thead><tr><th>단지</th><th>주택형</th><th class="r">일반공급</th>
        <th class="r">1순위 접수<small>(경쟁률)</small></th><th class="r">2순위 접수</th><th class="r">잔여세대</th></tr></thead>
        <tbody>${rows5}</tbody>${foot5}</table>
      ${basisList([
        ['지역', regionText],
        ['건수', `미달 주택형 ${n(sf.rows.length)}개 / 전체 ${n(sf.typesTotal)}개 · 잔여 ${n(sf.remain)}세대 (${period})${progress}`],
        ['제외 기준', `경쟁률 자료가 없는 주택형 ${n(sf.noComp)}개 제외 · ${listExcl} · 잔여는 접수 기준이라 당첨 후 계약 포기·부적격·무순위 결과는 반영 안 됨`],
        ['조회일', S.fetched],
      ])}`;

    return t3 + t4 + t5;
  }

  // ── 3장 사업수지 ─────────────────────────────────────

  function ch3(raw, chk) {
    if (!chk.ready(REQ_PL)) return chapter(3, '사업수지', noData(chk.reason(REQ_PL)));
    const x = toInput(raw, chk.rows);
    const { supplyArea, households } = Calc.totals(x.units);
    const b = Calc.breakdown(x, 1);   // 표와 폭포 차트가 같은 값을 쓴다
    const revenue = b.revenue, school = b.schoolLand, agency = b.agencyFee, cash = b.endingCash;

    const row = (label, formula, value, cls = '') =>
      `<tr class="${cls}"><th>${label}</th><td data-label="수식" class="formula">${formula}</td><td data-label="금액" class="r amt">${value}</td></tr>`;
    const body = [
      row('분양수입', `(공급면적 ${n(supplyArea, 1)}평 × 평당가 ${man(x.pricePerPyeong)} ÷ 10,000 + 상가 ${eok(x.retail)}) × 분양률 100%`, eok(revenue)),
      row('학교용지', `분양수입 × ${n(Calc.SCHOOL_LAND_RATE * 100, 1)}%`, eok(-school)),
      row('분양대행', `팔린 세대 ${n(households)}세대 × ${n(Calc.SALES_AGENCY_FEE)}만원`, eok(-agency)),
      row('기타유입', '입력값', eok(x.otherInflow)),
      row('고정비', '입력값', eok(-x.fixedCost)),
      row('기말현금', '분양수입 × (1 − 0.8%) − 분양대행 + 기타유입 − 고정비', eok(cash, true), 'total'),
    ].join('');
    return chapter(3, '사업수지',
      `<p class="basis">기준: 분양률 100% · 금액 억원</p>
       <table class="pl stack"><thead><tr><th>항목</th><th>수식</th><th class="r">금액</th></tr></thead><tbody>${body}</tbody></table>
       ${waterfallFigure(raw, b, households)}`);
  }

  // ── 차트 ② 사업수지 폭포 ─────────────────────────────
  // Calc.breakdown()의 단계 값을 그대로 그린다 (차트에서 다시 계산하지 않음).
  function figure(no, title, body, notes) {
    return `<figure class="chart-fig"><figcaption>차트 ${no} · ${title}</figcaption>${body}
      ${basisList(notes)}</figure>`;
  }
  const chartEmpty = (reason) => `<div class="chart-empty">${NO_DATA}${reason ? ' — ' + esc(reason) : ''}</div>`;

  function waterfallFigure(raw, b, households) {
    const width = raw.chartWidth || 720;
    const ok = b && b.stages.every((s) => Number.isFinite(s.from) && Number.isFinite(s.to)) && b.revenue > 0;
    const body = ok
      ? Charts.waterfall({ width, stages: b.stages, title: '사업수지 폭포 — 분양수입에서 기말현금까지' }) +
        Charts.legend([['합계', Charts.C.blue], ['감소', Charts.C.orange], ['증가', Charts.C.aqua]])
      : chartEmpty('분양수입이 0이거나 계산할 수 없음');
    return figure('②', '사업수지 폭포 — 분양수입 → 변동비 → 고정비 → 기타유입 → 기말현금', body, [
      ['단위', '억원 · 분양률 100%'],
      ['건수', `5단계 · 주택형 ${n(raw.units.filter((u) => u.supply != null && u.count != null).length)}개 · ${n(households)}세대 · 변동비 = 학교용지 ${n(Calc.SCHOOL_LAND_RATE * 100, 1)}% + 분양대행 세대당 ${n(Calc.SALES_AGENCY_FEE)}만원`],
      ['조회일', '해당 없음 — 입력값으로 계산'],
      ['출처', '입력값 · 위 3장 표와 같은 계산(calc.js)'],
    ]);
  }

  // ── 차트 ① 시장 대비 여유 ────────────────────────────
  // 점: 인근 신규 단지별 84㎡ 공급평당 분양가(2장 ③과 같은 값) · 선: 계획가(입력) · 상환 한계 평당가(5장) · 인근 평균(2장 ③)
  function marginFigure(raw, t) {
    const ah = raw.applyhome;
    const nb = ah ? Market.nearby84(ah) : null;
    const plan = raw.pricePerPyeong, limit = t.repayLimit.price;
    let reason = null;
    if (!ah) reason = '청약홈 조회 전';
    else if (ah.status !== 'ok') reason = ah.status === 'pending' ? '청약홈 단지 목록 확인 중' : '청약홈 목록 오류';
    else if (!nb.rows.length) reason = '인근 신규 84㎡ 분양가 없음';
    else if (plan == null || limit == null) reason = '계획가 또는 상환 한계 평당가 없음';
    const S = ah && ah.status === 'ok' ? ahState(ah) : null;
    const body = reason ? chartEmpty(reason) : Charts.dotLines({
      width: raw.chartWidth || 720,
      title: '시장 대비 여유 — 인근 신규 공급평당가와 계획가 · 상환 한계 평당가',
      points: [...nb.rows].sort((a, b) => b.perPyeong - a.perPyeong).map((r) => ({ label: r.name, value: r.perPyeong, note: `${r.noticeDate} 공고 · 84㎡ ${r.households}세대` })),
      lines: [
        { label: '계획가', value: plan, color: Charts.C.ink, weight: 2 },
        { label: '상환 한계', value: limit, color: Charts.C.red, weight: 2, dash: '6 4' },
        { label: '인근 평균', value: nb.avg, color: Charts.C.muted, weight: 1.5, dash: '2 3' },
      ],
    }) + Charts.legend([['인근 신규 단지 (84㎡ 공급평당)', Charts.C.blue, 'border-radius:50%'], ['계획가', Charts.C.ink, 'height:2px'],
      ['상환 한계 평당가', Charts.C.red, 'height:2px'], ['인근 평균 (세대 가중)', Charts.C.muted, 'height:2px']]);
    return figure('①', '시장 대비 여유 — 인근 신규 공급평당가 vs 계획가 · 상환 한계 평당가', body, [
      ['단위', '만원 / 공급평 (84㎡형 · 분양최고금액 ÷ 공급면적)'],
      ['건수', nb && nb.rows.length ? `인근 신규 ${n(nb.rows.length)}곳 · 84㎡ 주택형 ${n(nb.typesN)}개 · ${n(nb.households)}세대${S && !S.complete ? ` — ${S.done}/${S.total}곳 집계, 잠정` : ''}` : NO_DATA],
      ['조회일', S ? S.fetched : NO_DATA],
      ['출처', '한국부동산원 청약홈(2장 ③) · 계획가 입력값 · 상환 한계 평당가 5장(분양률 100% 기준)'],
    ]);
  }

  // ── 4장 자금조달과 상환 ──────────────────────────────

  function ch4(raw, chk) {
    if (!chk.ready(REQ_FIN)) return chapter(4, '자금조달과 상환', noData(chk.reason(REQ_FIN)));
    const x = toInput(raw, chk.rows);
    const cash = Calc.endingCash(x, 1);
    const due = x.mainPF + x.pfFinanceCost;
    const dscr = Calc.dscr(x, 1);
    const ltv = Calc.ltv(x);
    const repay = Calc.canRepay(x, 1);

    const row = (label, formula, value, cls = '') =>
      `<tr class="${cls}"><th>${label}</th><td data-label="수식" class="formula">${formula}</td><td data-label="값" class="r amt">${value}</td></tr>`;
    const funding = [
      row('본PF', '입력값', eok(x.mainPF)),
      row('본PF 금융비용', '입력값', eok(x.pfFinanceCost)),
      row('후순위', '입력값', eok(x.subordinated)),
    ].join('');
    const metrics = [
      row('본PF 원리금', `본PF ${eok(x.mainPF)} + 금융비용 ${eok(x.pfFinanceCost)}`, eok(due)),
      row('기말현금 + 후순위', `${eok(cash, true)} + ${eok(x.subordinated)}`, eok(cash + x.subordinated, true)),
      row('만기 누적 DSCR', `1 + (기말현금 + 후순위) ÷ (본PF + 본PF 금융비용)<br>= 1 + ${eok(cash + x.subordinated)} ÷ ${eok(due)}`, n(dscr, 2), 'total'),
      row('LTV', `본PF ÷ 분양률 100% 분양수입<br>= ${eok(x.mainPF)} ÷ ${eok(Calc.salesRevenue(x, 1))}`, pct(ltv), 'total'),
    ].join('');
    const verdict = repay
      ? `상환 가능 — 기말현금 ${eok(cash, true)} ≥ −후순위 ${eok(-x.subordinated)}`
      : `상환 불가 — 기말현금 ${eok(cash, true)} < −후순위 ${eok(-x.subordinated)}`;
    return chapter(4, '자금조달과 상환',
      `<h3>조달</h3><table class="pl stack"><thead><tr><th>항목</th><th>근거</th><th class="r">금액</th></tr></thead><tbody>${funding}</tbody></table>
       <h3>상환 <small>분양률 100%</small></h3><table class="pl stack"><thead><tr><th>지표</th><th>수식</th><th class="r">값</th></tr></thead><tbody>${metrics}</tbody></table>
       <p class="verdict ${repay ? '' : 'bad'}">${verdict}</p>`);
  }

  // ── 5장 민감도 ───────────────────────────────────────

  // 결론 문장 — 상환 한계 평당가(분양률 100%)와 분양률(계획 평당가)
  function verdictSentence(t) {
    const r = t.repayLimit.rate, p = t.repayLimit.price;
    if (r == null || p == null) return '상환 한계를 계산할 수 없습니다.';
    if (r > 1) return `계획 평당가로는 분양률 100%에서도 상환 불가 — 분양률 100% 기준 평당 ${man(p)} 이상 필요`;
    if (r <= 0) return `계획 평당가 기준 분양률과 무관하게 상환 가능 · 분양률 100%면 평당 ${man(p)} 이상`;
    return `평당 ${man(p)} / 분양률 ${pct(r)} 이상이면 상환 가능`;
  }

  // 결론 옆 "시장 대비 여유" — 상환 한계 평당가(분양률 100%) vs 인근 신규 84㎡ 공급평당 분양가(2장 ③)
  function marketMargin(raw, t) {
    const label = '<b>시장 대비 여유</b>';
    const nb = raw.applyhome ? Market.nearby84(raw.applyhome) : { avg: null };
    const p = t.repayLimit.price;
    if (nb.avg == null || p == null) {
      return `<p class="margin">${label} — ${NO_DATA}${raw.applyhome ? ' (인근 신규 84㎡ 분양가 없음 또는 집계 중)' : ' (청약홈 조회 전)'}</p>`;
    }
    const gap = nb.avg - p;
    const S = ahState(raw.applyhome);
    return `<p class="margin ${gap < 0 ? 'bad' : ''}">${label}<br>
      상환 한계 평당 ${man(p)} vs 인근 신규 84㎡ 공급평당 ${man(nb.avg)}<br>
      → ${gap >= 0 ? `인근 신규 분양가보다 ${man(gap)}(${pct(gap / nb.avg)}) 낮게 팔아도 상환 가능` : `인근 신규 분양가보다 ${man(-gap)} 높게 팔아야 상환 가능`}
      ${S.complete ? '' : '<small>(청약홈 집계 중, 잠정)</small>'}</p>`;
  }

  function ch5(raw, chk) {
    if (!chk.ready(REQ_FIN)) return chapter(5, '민감도', noData(chk.reason(REQ_FIN)));
    const x = toInput(raw, chk.rows);
    const t = Calc.thresholds(x);
    const s = Calc.sensitivity(x);

    const limits = `<table class="grid limits stack"><thead><tr><th>한계선</th><th class="r">분양률<small>계획 평당가 기준</small></th><th class="r">평당가<small>분양률 100% 기준</small></th></tr></thead><tbody>
      <tr><th>기말현금 0</th><td data-label="분양률" class="r">${rateText(t.breakEven.rate)}</td><td data-label="평당가" class="r">${t.breakEven.price == null ? '계산 불가' : man(t.breakEven.price)}</td></tr>
      <tr><th>상환 한계 <small>기말현금 = −후순위</small></th><td data-label="분양률" class="r">${rateText(t.repayLimit.rate)}</td><td data-label="평당가" class="r">${t.repayLimit.price == null ? '계산 불가' : man(t.repayLimit.price)}</td></tr>
    </tbody></table>`;

    const head = s.prices.map((p, i) => {
      const d = s.priceDeltas[i];
      return `<th class="r${d === 0 ? ' plan' : ''}">${n(p)}<small>${d === 0 ? '계획' : (d > 0 ? '+' : '−') + n(Math.abs(d))}</small></th>`;
    }).join('');
    const body = s.rows.map((row) => `<tr><th>${n(row.rate * 100)}%</th>${row.cells.map((c, i) =>
      `<td class="r ${c.canRepay ? 'ok' : 'ng'}${s.priceDeltas[i] === 0 && row.rate === 1 ? ' plan' : ''}">${n(c.endingCash, 1, { signed: true })}</td>`).join('')}</tr>`).join('');

    return chapter(5, '민감도',
      `<h3>두 한계선</h3>${limits}
       <h3>기말현금 민감도 <small>억원 · 행 분양률 · 열 평당가(만원)</small></h3>
       <div class="table-wrap"><table class="sens"><thead><tr><th>분양률</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
       <p class="legend"><i class="ok"></i>상환 가능 (기말현금 ≥ −후순위) <i class="ng"></i>상환 불가</p>
       <div class="verdict-row"><p class="verdict">${verdictSentence(t)}</p>${marketMargin(raw, t)}</div>
       ${marginFigure(raw, t)}`);
  }

  // ── 6장 리스크와 완화 방안 ───────────────────────────
  // 두 한계선에서 거꾸로 짚는다: "어디까지 떨어지면 무엇이 깨지는가"와
  // "어떤 값을 얼마나 바꾸면 한계선이 얼마나 움직이는가"(계산 모듈로 다시 계산).

  function ch6(raw, chk) {
    if (!chk.ready(REQ_FIN)) return chapter(6, '리스크와 완화 방안', noData(chk.reason(REQ_FIN)));
    const x = toInput(raw, chk.rows);
    const t = Calc.thresholds(x);
    const be = t.breakEven, rp = t.repayLimit;
    if ([be.rate, be.price, rp.rate, rp.price].some((v) => v == null)) {
      return chapter(6, '리스크와 완화 방안', noData('한계선을 계산할 수 없어 리스크를 짚지 못함'));
    }
    const plan = x.pricePerPyeong;

    // 분양률 1%p · 평당가 1만원당 기말현금 변동 (억원)
    const perRatePt = (Calc.endingCash(x, 1) - Calc.endingCash(x, 0)) / 100;
    const perPrice = Calc.endingCash(Calc.withPrice(x, plan + 1), 1) - Calc.endingCash(x, 1);

    // 완화 예시: 후순위 100억 증액 / 고정비 100억 절감 시 한계선 이동
    const STEP = 100;
    const tSub = Calc.thresholds({ ...x, subordinated: x.subordinated + STEP });
    const tFix = Calc.thresholds({ ...x, fixedCost: x.fixedCost - STEP });

    const card = (title, risk, mitigations) => `<div class="risk"><h3>${title}</h3><p>${risk}</p>
      <p class="mit-h">완화 방안</p><ul>${mitigations.map((m) => `<li>${m}</li>`).join('')}</ul></div>`;
    const inRange = (r) => r > 0 && r <= 1;
    const items = [];

    // 0) 계획값 자체가 한계선 밖인 경우를 먼저 알린다
    if (!Calc.canRepay(x, 1)) {
      items.push(card('계획값에서 이미 상환 불가',
        `분양률 100% · 계획 평당가 ${man(plan)}에서도 기말현금 ${eok(Calc.endingCash(x, 1), true)}로 −후순위 ${eok(-x.subordinated)}에 못 미칩니다.`,
        [`상환 한계를 넘으려면 분양률 100% 기준 평당 ${man(rp.price)} 이상 필요 (계획 대비 ${n(rp.price - plan, 0, { signed: true })}만원)`,
         `또는 기말현금을 ${eok(-x.subordinated - Calc.endingCash(x, 1))} 이상 개선 (고정비 절감·후순위 증액 등)`]));
    }

    // 1) 분양률 미달
    if (inRange(rp.rate)) {
      items.push(card('분양률 미달',
        `계획 평당가 ${man(plan)} 기준으로 분양률이 <b>${pct(be.rate)}</b> 아래면 기말현금 적자, <b>${pct(rp.rate)}</b> 아래면 후순위로도 손실을 흡수하지 못해 본PF 전액 상환이 어렵습니다.
         분양률 100% 대비 <b>${n((1 - rp.rate) * 100, 1)}%p</b> 하락까지가 상환 여유입니다. (분양률 1%p당 기말현금 ${eok(perRatePt)} 변동)`,
        [`분양률 점검 기준을 상환 한계 ${pct(rp.rate)}보다 위인 손익분기 ${inRange(be.rate) ? pct(be.rate) : '분양률'}에 두고, 그 아래로 내려가는 시점에 대응 착수`,
         `후순위 ${n(STEP)}억 증액 시 상환 한계 분양률 ${pct(rp.rate)} → ${rateText(tSub.repayLimit.rate)}`,
         `고정비 ${n(STEP)}억 절감 시 손익분기 분양률 ${rateText(be.rate)} → ${rateText(tFix.breakEven.rate)}, 상환 한계 ${pct(rp.rate)} → ${rateText(tFix.repayLimit.rate)}`]));
    }

    // 2) 분양가 하락(할인 분양)
    if (rp.price > 0 && rp.price <= plan) {
      const beCut = plan - be.price, rpCut = plan - rp.price;
      items.push(card('분양가 하락 (할인 분양)',
        `분양률 100% 기준 평당가가 <b>${man(be.price)}</b>(계획 대비 ${n(-beCut, 0)}만원, ${pct(-beCut / plan)}) 아래면 적자,
         <b>${man(rp.price)}</b>(계획 대비 ${n(-rpCut, 0)}만원, ${pct(-rpCut / plan)}) 아래면 상환 불가입니다. (평당가 1만원당 기말현금 ${eok(perPrice)} 변동)`,
        [`할인 분양 한도를 상환 한계 기준 계획 대비 ${n(rpCut, 0)}만원 이내, 손익 기준 ${n(Math.max(beCut, 0), 0)}만원 이내로 관리`,
         `후순위 ${n(STEP)}억 증액 시 상환 한계 평당가 ${man(rp.price)} → ${man(tSub.repayLimit.price)}`,
         `고정비 ${n(STEP)}억 절감 시 상환 한계 평당가 ${man(rp.price)} → ${man(tFix.repayLimit.price)}`]));
    }

    // 3) 분양률·분양가 동시 하락 — 민감도 표와 중간 분양률의 평당가 한계
    const s = Calc.sensitivity(x);
    const cells = s.rows.flatMap((r) => r.cells);
    const ng = cells.filter((c) => !c.canRepay).length;
    const midRates = [0.95, 0.90].filter((r) => r > rp.rate);
    const mid = midRates.map((r) => {
      const p = Calc.priceForCash(x, -x.subordinated, r);
      return `분양률 ${pct(r, 0)}면 평당 ${man(p)} 이상 (계획 대비 ${n(p - plan, 0, { signed: true })}만원)`;
    });
    items.push(card('분양률 · 분양가 동시 하락',
      `5장 민감도 표 ${n(cells.length)}칸 중 <b>${n(ng)}칸</b>이 상환 불가입니다. 분양률이 낮아질수록 버틸 수 있는 할인 폭도 함께 줄어듭니다.`,
      [...(mid.length ? [`분양률별 상환 가능 평당가: ${mid.join(' · ')}`] : []),
       '분양률과 평균 분양가를 함께 점검 — 분양률이 떨어지는 국면에서는 할인 분양 한도를 그만큼 줄여 적용']));

    return chapter(6, '리스크와 완화 방안',
      `<p class="basis">5장의 두 한계선에서 거꾸로 짚은 리스크입니다. 완화 방안의 수치는 이 앱의 계산식으로 다시 계산한 것이며, 실행 가능성은 확인하지 않았습니다(7장).</p>
       ${items.join('')}`);
  }

  // ── 7장 확인하지 못한 것 ────────────────────────────

  function ch7(raw, chk) {
    const missing = chk.reason(REQ_FIN);
    const rg = regionInfo(raw);
    const items = [
      ...(rg.ok ? [] : [`사업대상지 법정동코드 — 미확인${rg.reason ? ' (' + esc(rg.reason) + ')' : ''}`]),
      '<b>월별 자금수지 · IRR은 이 앱의 범위 밖</b>',
      raw.market
        ? `시장 분석(2장) — 실거래 건수와 84㎡ 신규 전세만 반영, 매매 시세 · 주변 분양 사례 · 청약 경쟁률은 확인하지 않음${marketState(raw.market).complete ? '' : ' · 일부 달 미집계'}`
        : '시장 분석(2장) — 분양가·분양률의 근거가 될 주변 시세·분양 사례는 공공데이터 확인 필요',
      '분양 속도 — 분양률은 만기 시점 누적값으로만 반영, 기간별 분양 흐름은 반영하지 않음',
      '고정비 — 입력한 합계를 그대로 사용, 세부 항목과 증빙은 검증하지 않음',
      '본PF 금융비용 — 입력값 고정, 금리 변동·만기 연장은 반영하지 않음',
      `고정 가정 — 학교용지 ${n(Calc.SCHOOL_LAND_RATE * 100, 1)}% · 분양대행 세대당 ${n(Calc.SALES_AGENCY_FEE)}만원, 사업장별 실제 요율 확인 필요`,
      '상가 — 주택과 같은 분양률을 적용한다고 가정',
      ...(raw.applyhome ? [
        '청약홈 분양가(2장 ③④) — 주택형별 분양최고금액 기준, 층·향별 차등과 발코니 확장·옵션은 반영하지 않음',
        '청약홈 잔여세대(2장 ⑤) — 1·2순위 접수 기준, 당첨 후 계약 포기·부적격·무순위 결과는 반영하지 않음',
        '분양권 웃돈(2장 ④) — 실거래 단지명과 청약홈 주택명을 글자로 맞춘 것이라 오매칭·누락 가능',
      ] : []),
      '6장 완화 방안(후순위 증액·고정비 절감 등)의 실현 가능성',
      ...(missing ? [`입력되지 않은 값 — ${esc(missing.replace('미입력: ', ''))}`] : []),
    ];
    return chapter(7, '확인하지 못한 것', `<ul class="unchecked">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`);
  }

  // ── 보고서 전체 ─────────────────────────────────────

  function render(raw) {
    const chk = inspect(raw);
    const title = raw.name && raw.name.trim() ? esc(raw.name) : `사업명 ${NO_DATA}`;
    const site = raw.site && raw.site.trim() ? esc(raw.site) : `사업대상지 ${NO_DATA}`;
    const head = `<header class="doc-head"><p class="kicker">대주단 제출용 사업계획서</p><h1>${title}</h1>
      <p class="site">${site}</p><p class="basis">기준: 입력값 · 분양률 100% · 금액 억원 · 평당가 만원</p></header>`;
    return head + [ch1, ch2, ch3, ch4, ch5, ch6, ch7].map((f) => f(raw, chk)).join('');
  }

  const Report = { render, inspect, NO_DATA };
  if (typeof module !== 'undefined' && module.exports) module.exports = Report;
  else root.Report = Report;
})(typeof window !== 'undefined' ? window : globalThis);
