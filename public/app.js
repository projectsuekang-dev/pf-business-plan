// 화면(입력 폼) — 계산은 calc.js, 보고서 문장·표는 report.js가 맡는다.

// 임시 값 (금액: 평당가 만원, 나머지 억원)
const PRESETS = {
  A: { name: '해운대 그린테라스', site: '부산광역시 해운대구',
    units: [['59형', 59.9, 25.6, 200], ['84형', 84.9, 34.6, 320]],
    pricePerPyeong: 2420, retail: 150, otherInflow: 175, fixedCost: 3815.0,
    mainPF: 2450, pfFinanceCost: 480, subordinated: 400 },
  B: { name: '영통 센트럴파크', site: '경기도 수원시 영통구',
    units: [['59형', 59.8, 25.4, 300], ['84형', 84.9, 34.3, 480]],
    pricePerPyeong: 2650, retail: 180, otherInflow: 260, fixedCost: 6296.4,
    mainPF: 4100, pfFinanceCost: 820, subordinated: 600 },
  C: { name: '유성 리버뷰', site: '대전광역시 유성구',
    units: [['74형', 74.6, 30.8, 140], ['84형', 84.9, 34.5, 240]],
    pricePerPyeong: 1980, retail: 90, otherInflow: 120, fixedCost: 2461.2,
    mainPF: 1650, pfFinanceCost: 330, subordinated: 260 },
};
const NUM_KEYS = ['pricePerPyeong', 'retail', 'otherInflow', 'fixedCost', 'mainPF', 'pfFinanceCost', 'subordinated'];
const DECIMALS = { fixedCost: 1 };

const form = document.getElementById('form');
const tbody = document.querySelector('#units tbody');

// 콤마 섞인 문자열 → 숫자. 빈 칸·잘못된 값은 null (0으로 채우지 않는다).
const parseOrNull = (s) => {
  const t = String(s).replace(/,/g, '').trim();
  if (t === '') return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
};
const parse = (s) => parseOrNull(s) ?? 0;
const fmt = (v, d = 0) => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, 2) });
const fmtInput = (v, d = 0) => (v === '' || v == null ? '' : fmt(Number(v), d));

// 주택형 행 추가 — 휴대폰에서는 data-label로 카드처럼 보인다.
function addRow([name = '', excl = '', supply = '', count = ''] = []) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td data-label="이름"><input data-k="name" type="text" placeholder="예: 84형"></td>
    <td data-label="전용㎡"><input data-k="excl" class="n" inputmode="decimal"></td>
    <td data-label="공급평"><input data-k="supply" class="n" inputmode="decimal"></td>
    <td data-label="세대수"><input data-k="count" class="n" inputmode="numeric"></td>
    <td data-label="공급면적 소계(평)" class="num sub-area">0</td>
    <td><button type="button" class="del" title="행 삭제">✕ <span class="del-t">행 삭제</span></button></td>`;
  tr.querySelector('[data-k=name]').value = name;
  tr.querySelector('[data-k=excl]').value = fmtInput(excl, 1);
  tr.querySelector('[data-k=supply]').value = fmtInput(supply, 1);
  tr.querySelector('[data-k=count]').value = fmtInput(count);
  tr.querySelector('.del').onclick = () => { tr.remove(); recalc(); };
  tbody.appendChild(tr);
  recalc();
}

// 폼 합계 갱신 후 보고서 다시 그리기
function recalc() {
  let households = 0, area = 0;
  for (const tr of tbody.rows) {
    const supply = parse(tr.querySelector('[data-k=supply]').value);
    const count = parse(tr.querySelector('[data-k=count]').value);
    households += count;
    area += supply * count;
    tr.querySelector('.sub-area').textContent = fmt(supply * count, 1);
  }
  document.getElementById('sumHouseholds').textContent = fmt(households);
  document.getElementById('sumArea').textContent = fmt(area, 1);
  document.getElementById('report').innerHTML = Report.render(readRaw());
}

// ── 지역 확인 (서버 /api/region 경유 — 인증키는 서버에만 있음) ──
let region = null;        // 마지막 확인 결과
let regionSeq = 0;        // 늦게 도착한 이전 응답 무시용
let regionTimer = null;

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 사업대상지 입력이 바뀌면 잠시 기다렸다가 확인
function scheduleRegionCheck(delay = 500) {
  clearTimeout(regionTimer);
  regionTimer = setTimeout(checkRegion, delay);
}

async function checkRegion() {
  const name = form.elements.namedItem('site').value.trim();
  const seq = ++regionSeq;
  if (!name) { region = null; stopMarket(); return renderRegion(); }
  stopMarket();
  region = { status: 'pending', input: name };
  renderRegion();
  let result;
  try {
    const res = await fetch('/api/region?name=' + encodeURIComponent(name));
    result = await res.json();
  } catch {
    result = { status: 'error', input: name, message: '앱 서버에 연결할 수 없습니다' };
  }
  if (seq !== regionSeq) return;
  region = result;
  renderRegion();
  if (region.status === 'ok') { startMarket(name); startApplyhome(name); }
  else stopMarket();
}

// ── 청약홈 인근 신규 분양 (서버 /api/applyhome — 지역 이름과 목록의 단지 번호만 보낸다) ──
let applyhome = null;   // { site, status, list, message, details: {id: 결과} }
let applyhomeSeq = 0;

async function getJson(url) {
  try { return await (await fetch(url)).json(); } catch { return { status: 'error', message: '앱 서버에 연결할 수 없습니다' }; }
}
function friendly(r) {
  if (r.status === 'region') return { status: 'error', message: '서버에서 지역을 다시 확인하지 못했습니다' };
  if (r.status === 'no_key') return { status: 'error', message: '공공데이터 인증키 미설정' };
  return r;
}

// 단지 목록을 받고, 단지마다 한 곳씩 차례로 상세를 받는다
async function startApplyhome(site) {
  const seq = ++applyhomeSeq;
  applyhome = { site, status: 'pending', details: {} };
  renderMarketStatus();
  const l = friendly(await getJson(`/api/applyhome/list?site=${encodeURIComponent(site)}`));
  if (seq !== applyhomeSeq) return;
  if (l.status !== 'ok') { applyhome = { site, status: 'error', message: l.message, details: {} }; return renderMarketStatus(); }
  applyhome = { site, status: 'ok', list: l, details: Object.fromEntries(l.complexes.map((c) => [c.id, { status: 'pending' }])) };
  renderMarketStatus();
  for (const c of l.complexes) {
    if (seq !== applyhomeSeq) return;
    await loadComplex(seq, c.id);
  }
}

async function loadComplex(seq, id) {
  applyhome.details[id] = { status: 'pending' };
  const r = friendly(await getJson(`/api/applyhome/complex?site=${encodeURIComponent(applyhome.site)}&id=${encodeURIComponent(id)}`));
  if (seq !== applyhomeSeq) return;
  applyhome.details[id] = r;
  renderMarketStatus();
}

// ── 실거래가 (서버 /api/trades 경유 — 지역 이름만 보내고 코드는 서버가 다시 확인) ──
let market = null;   // { site, months, silv: {ym: 결과}, rent: {ym: 결과} }
let marketSeq = 0;

function stopMarket() {
  marketSeq++;
  applyhomeSeq++;
  market = null;
  applyhome = null;
  renderMarketStatus();
}

// 최근 12개월을 한 달씩 — 분양권과 전월세는 나란히, 각자는 한 달씩 차례로
function startMarket(site) {
  const seq = ++marketSeq;
  const months = Market.recentMonths(new Date());
  market = { site, months, silv: {}, rent: {} };
  for (const kind of Object.keys(Market.KINDS)) {
    for (const ym of months) market[kind][ym] = { status: 'pending' };
  }
  renderMarketStatus();
  for (const kind of Object.keys(Market.KINDS)) {
    (async () => {
      for (const ym of months) {
        if (seq !== marketSeq) return;
        await loadMonth(seq, kind, ym);
      }
    })();
  }
}

async function loadMonth(seq, kind, ym) {
  const site = market.site;
  market[kind][ym] = { status: 'pending' };
  let r;
  try {
    const res = await fetch(`/api/trades?site=${encodeURIComponent(site)}&kind=${kind}&ym=${ym}`);
    r = await res.json();
  } catch {
    r = { status: 'error', message: '앱 서버에 연결할 수 없습니다' };
  }
  if (seq !== marketSeq) return;
  if (r.status === 'region') r = { status: 'error', message: '서버에서 지역을 다시 확인하지 못했습니다' };
  if (r.status === 'no_key') r = { status: 'error', message: '공공데이터 인증키 미설정' };
  market[kind][ym] = r;
  renderMarketStatus();
}

// 진행 표시: 분양권 n/12 · 전월세 n/12 (n = 끝난 달, 실패 포함) + 보고서 갱신
function renderMarketStatus() {
  const el = document.getElementById('marketStatus');
  if (!market) { el.innerHTML = ''; recalc(); return; }
  const part = (kind) => {
    const all = Object.values(market[kind]);
    const done = all.filter((r) => r.status !== 'pending').length;
    const failed = all.filter((r) => r.status === 'error').length;
    return `${Market.KINDS[kind]} <b>${done}/${all.length}</b>${failed ? ` <span class="bad">(실패 ${failed})</span>` : ''}`;
  };
  // 청약홈 k/N곳 (k = 끝난 단지, 실패 포함)
  let ah = '';
  let ahBusy = false;
  if (applyhome) {
    if (applyhome.status === 'pending') { ah = '청약홈 <b>목록 확인 중</b>'; ahBusy = true; }
    else if (applyhome.status === 'error') ah = '청약홈 <span class="bad">목록 실패</span>';
    else {
      const all = Object.values(applyhome.details);
      const done = all.filter((r) => r.status !== 'pending').length;
      const failed = all.filter((r) => r.status === 'error').length;
      ahBusy = done < all.length;
      ah = `청약홈 <b>${done}/${all.length}곳</b>${failed ? ` <span class="bad">(실패 ${failed})</span>` : ''}`;
    }
  }
  const busy = ahBusy || Object.keys(Market.KINDS).some((k) => Object.values(market[k]).some((r) => r.status === 'pending'));
  el.innerHTML = `<span class="muted">공공데이터 ${busy ? '불러오는 중' : '조회 완료'} —</span> ${part('silv')} · ${part('rent')}${ah ? ' · ' + ah : ''}`;
  recalc();
}

// 보고서 2장의 [다시 시도] 버튼 — 실거래가 달 / 청약홈 목록 / 청약홈 단지
document.getElementById('report').addEventListener('click', (e) => {
  const b = e.target.closest('[data-retry]');
  if (!b || !market) return;
  const [kind, ym] = b.dataset.retry.split(':');
  if (kind === 'ahlist') return startApplyhome(market.site);
  if (kind === 'ah') {
    if (!applyhome || !applyhome.details) return;
    applyhome.details[ym] = { status: 'pending' };
    renderMarketStatus();
    return loadComplex(applyhomeSeq, ym);
  }
  market[kind][ym] = { status: 'pending' };
  renderMarketStatus();
  loadMonth(marketSeq, kind, ym);
});

// 폼 아래 상태 줄 + 보고서 1장 갱신
function renderRegion() {
  const el = document.getElementById('regionStatus');
  const r = region;
  if (!r || r.status === 'empty') el.innerHTML = '';
  else if (r.status === 'pending') el.innerHTML = '<span class="muted">지역 확인 중…</span>';
  else if (r.status === 'ok') el.innerHTML = `<span class="good">✔ 확인됨</span> ${escHtml(r.name)} · 시군구 법정동코드 <b>${escHtml(r.code)}</b>`;
  else if (r.status === 'no_key') el.innerHTML = '<span class="muted">공공데이터 인증키가 없어 지역 확인을 건너뜁니다 (.env.local의 DATA_GO_KR_KEY)</span>';
  else if (r.status === 'error') el.innerHTML = `<span class="bad">지역 확인 실패</span> ${escHtml(r.message || '')}`;
  else if (r.status === 'not_found') el.innerHTML = '<span class="bad">일치하는 시군구가 없습니다</span> — 시도와 시군구 이름을 함께 적어 주세요 (예: 부산광역시 해운대구)';
  else if (r.status === 'ambiguous') {
    el.innerHTML = `<span class="bad">하나로 확인되지 않았습니다</span> — 후보를 고르세요${r.more ? ' (일부만 표시)' : ''}
      <div class="cands">${r.candidates.map((c) => `<button type="button" class="ghost cand" data-name="${escHtml(c.name)}">${escHtml(c.name)} <small>${escHtml(c.code)}</small></button>`).join('')}</div>`;
    el.querySelectorAll('.cand').forEach((b) => (b.onclick = () => {
      form.elements.namedItem('site').value = b.dataset.name;
      checkRegion();
    }));
  }
  recalc();
}

// 폼 값을 그대로 모은다 — 빈 칸은 null로 남겨 보고서가 "자료 없음"을 판단하게 한다.
function readRaw() {
  const f = form.elements;
  const raw = {
    name: f.namedItem('name').value,
    site: f.namedItem('site').value,
    units: [...tbody.rows].map((tr) => ({
      name: tr.querySelector('[data-k=name]').value.trim(),
      excl: parseOrNull(tr.querySelector('[data-k=excl]').value),
      supply: parseOrNull(tr.querySelector('[data-k=supply]').value),
      count: parseOrNull(tr.querySelector('[data-k=count]').value),
    })),
  };
  for (const k of NUM_KEYS) raw[k] = parseOrNull(f.namedItem(k).value);
  raw.chartWidth = chartWidth();
  // 지역 확인 결과는 지금 입력된 사업대상지에 대한 것일 때만 넘긴다
  const siteNow = raw.site.trim().replace(/\s+/g, ' ');
  raw.region = region && region.input === siteNow ? region : null;
  raw.market = market && raw.region && raw.region.status === 'ok' && market.site === siteNow ? market : null;
  raw.applyhome = raw.market && applyhome && applyhome.site === siteNow ? applyhome : null;
  return raw;
}

// 차트 폭 = 보고서 본문 폭 (글자가 화면 크기와 상관없이 같은 크기로 보이게 SVG를 실제 폭으로 그린다)
function chartWidth() {
  const el = document.getElementById('report');
  const cs = getComputedStyle(el);
  return Math.max(300, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
}
let lastChartWidth = 0;
window.addEventListener('resize', () => {
  const w = chartWidth();
  if (Math.abs(w - lastChartWidth) > 8) { lastChartWidth = w; recalc(); }
});

function fill(p) {
  const f = form.elements;
  f.namedItem('name').value = p.name;
  f.namedItem('site').value = p.site;
  tbody.innerHTML = '';
  p.units.forEach((u) => addRow(u));
  for (const k of NUM_KEYS) f.namedItem(k).value = fmtInput(p[k], DECIMALS[k] || 0);
  recalc();
  checkRegion();
}

function clearAll() {
  form.reset();
  tbody.innerHTML = '';
  addRow(); addRow();
  checkRegion();
}

// 입력 중 갱신, 포커스 아웃 시 천단위 콤마
form.addEventListener('input', (e) => {
  if (e.target.name === 'site') scheduleRegionCheck();
  recalc();
});
form.addEventListener('focusout', (e) => {
  const el = e.target;
  if (!el.classList.contains('n') || el.value.trim() === '') return;
  const d = (el.value.split('.')[1] || '').length;
  el.value = fmt(parse(el.value), Math.min(d, 2));
});

document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => fill(PRESETS[b.dataset.preset])));
document.getElementById('clear').onclick = clearAll;
document.getElementById('addRow').onclick = () => addRow();
document.getElementById('print').onclick = () => window.print();

clearAll();
