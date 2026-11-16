// 사업계획서 차트 — 라이브러리 없이 SVG 문자열로 그린다.
// 원칙: 숫자는 이미 계산된 값만 받는다. 여기서는 위치(축 눈금 · 좌표)만 정하고 금액을 다시 계산하지 않는다.
// 브라우저에서는 window.Charts, Node에서는 require('./charts.js').
(function (root) {
  // 색 — 기본 팔레트(라이트) · 텍스트는 텍스트 색, 막대·점만 계열 색
  const C = {
    blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', red: '#d03b3b',
    ink: '#1d232b', muted: '#6b7480', grid: '#e6e8ec', surface: '#ffffff',
  };
  const FONT = '"Pretendard","Malgun Gothic",system-ui,sans-serif';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 0) => {
    const p = 10 ** d, r = Math.round(v * p) / p;
    const s = Math.abs(r).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (r < 0 ? '−' : '') + s;
  };

  // 축 눈금 — 1·2·5 × 10^k 간격 (보기 좋은 눈금은 배치일 뿐, 자료 값은 바꾸지 않음)
  function ticks(min, max, target = 5) {
    if (!(max > min)) { max = min + 1; }
    const raw = (max - min) / target;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
    return { lo, hi, step, values: out };
  }

  // 글자 폭 대략값 (한글 12px ≈ 12px, 숫자·영문 ≈ 7px)
  const textW = (s, size = 12) => [...String(s)].reduce((w, ch) => w + (/[ㄱ-힝]/.test(ch) ? size : size * 0.6), 0);
  function clip(s, maxW, size = 12) {
    if (textW(s, size) <= maxW) return s;
    let out = '';
    for (const ch of String(s)) { if (textW(out + ch + '…', size) > maxW) break; out += ch; }
    return out + '…';
  }

  const svgOpen = (w, h, label) =>
    `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg" style="font-family:${FONT}">`;

  // ① 점 + 기준선 차트
  // points: [{ label, value, note }]  — 인근 신규 단지별 84㎡ 공급평당 분양가 (계산된 값)
  // lines:  [{ label, value, color, dash, weight }] — 계획가 · 상환 한계 평당가 · 인근 평균 (계산된 값)
  function dotLines({ width = 720, points, lines, unit = '만원', title = '' }) {
    const W = Math.max(300, Math.round(width));
    const labelW = Math.min(170, Math.round(W * 0.32));
    const ROW = 26, padR = 18;
    const lineLabels = lines.length;
    const top = 16 + lineLabels * 16, bottom = 30;
    const H = top + points.length * ROW + bottom;
    const x0 = labelW + 12, x1 = W - padR;
    const vals = [...points.map((p) => p.value), ...lines.map((l) => l.value)];
    const span = Math.max(...vals) - Math.min(...vals) || Math.max(...vals) * 0.1 || 1;
    const t = ticks(Math.min(...vals) - span * 0.06, Math.max(...vals) + span * 0.06, W < 480 ? 4 : 6);
    const X = (v) => x0 + ((v - t.lo) / (t.hi - t.lo)) * (x1 - x0);
    const yBottom = top + points.length * ROW;

    let s = svgOpen(W, H, title);
    // 격자 · 축
    for (const v of t.values) {
      s += `<line x1="${X(v)}" x2="${X(v)}" y1="${top - 4}" y2="${yBottom}" stroke="${C.grid}" stroke-width="1"/>`;
      s += `<text x="${X(v)}" y="${yBottom + 16}" font-size="11" fill="${C.muted}" text-anchor="middle">${fmt(v)}</text>`;
    }
    s += `<text x="${x1}" y="${H - 2}" font-size="11" fill="${C.muted}" text-anchor="end">${esc(unit)}</text>`;
    // 단지 행
    points.forEach((p, i) => {
      const y = top + i * ROW + ROW / 2;
      s += `<text x="${labelW}" y="${y + 4}" font-size="12" fill="${C.ink}" text-anchor="end">${esc(clip(p.label, labelW - 4))}</text>`;
      s += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1" stroke-dasharray="1 3"/>`;
    });
    // 기준선 (점 아래에 깔고, 이름표는 위쪽에 줄을 나눠 겹치지 않게)
    // 이름표 방향: 가장 왼쪽 선은 왼쪽으로, 가장 오른쪽 선은 오른쪽으로 — 다른 선을 가로지르지 않게. 자리가 없으면 반대쪽.
    const order = lines.map((l, i) => i).sort((a, b) => lines[a].value - lines[b].value);
    lines.forEach((l, i) => {
      const x = X(l.value);
      const ly = 12 + i * 16;
      const label = `${l.label} ${fmt(l.value)}`;
      const w = textW(label, 11.5) + 6;
      const rank = order.indexOf(i);
      let anchor = rank === 0 ? 'end' : rank === lines.length - 1 ? 'start' : (x > (x0 + x1) / 2 ? 'end' : 'start');
      if (anchor === 'end' && x - w < 0) anchor = 'start';
      if (anchor === 'start' && x + w > W) anchor = 'end';
      const dx = anchor === 'end' ? -4 : 4;
      s += `<line x1="${x}" x2="${x}" y1="${ly + 3}" y2="${yBottom}" stroke="${l.color}" stroke-width="${l.weight || 2}"${l.dash ? ` stroke-dasharray="${l.dash}"` : ''}><title>${esc(l.label)} ${fmt(l.value)}${esc(unit)}</title></line>`;
      s += `<text x="${x + dx}" y="${ly + 4}" font-size="11.5" font-weight="700" fill="${C.ink}" text-anchor="${anchor}" stroke="${C.surface}" stroke-width="3" paint-order="stroke">${esc(label)}</text>`;
    });
    // 점 (2px 바탕색 테두리) + 넓은 투명 영역으로 마우스 설명
    points.forEach((p, i) => {
      const y = top + i * ROW + ROW / 2, x = X(p.value);
      s += `<g class="pt"><title>${esc(p.label)} — ${fmt(p.value)}${esc(unit)}${p.note ? ' · ' + esc(p.note) : ''}</title>`;
      s += `<rect x="${x0}" y="${y - ROW / 2}" width="${x1 - x0}" height="${ROW}" fill="transparent"/>`;
      s += `<circle cx="${x}" cy="${y}" r="6" fill="${C.blue}" stroke="${C.surface}" stroke-width="2"/></g>`;
    });
    return s + '</svg>';
  }

  // ② 폭포 차트
  // stages: [{ label, kind: 'total'|'down'|'up', value, from, to }] — Calc.breakdown()이 만든 값 그대로
  function waterfall({ width = 720, stages, unit = '억원', title = '' }) {
    const W = Math.max(300, Math.round(width));
    const H = W < 480 ? 260 : 300;
    const padL = W < 480 ? 46 : 58, padR = 12, top = 26, bottom = 40;
    const ext = stages.flatMap((st) => [st.from, st.to]).concat(0);
    const t = ticks(Math.min(...ext), Math.max(...ext), 5);
    const Y = (v) => top + (1 - (v - t.lo) / (t.hi - t.lo)) * (H - top - bottom);
    const band = (W - padL - padR) / stages.length;
    const bw = Math.min(64, band * 0.56);
    const color = { total: C.blue, down: C.orange, up: C.aqua };

    let s = svgOpen(W, H, title);
    for (const v of t.values) {
      s += `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? C.muted : C.grid}" stroke-width="1"/>`;
      s += `<text x="${padL - 6}" y="${Y(v) + 4}" font-size="11" fill="${C.muted}" text-anchor="end">${fmt(v)}</text>`;
    }
    s += `<text x="${padL - 6}" y="${12}" font-size="11" fill="${C.muted}" text-anchor="end">${esc(unit)}</text>`;
    stages.forEach((st, i) => {
      const cx = padL + band * i + band / 2;
      const yA = Y(Math.max(st.from, st.to)), yB = Y(Math.min(st.from, st.to));
      const h = Math.max(1, yB - yA);
      // 다음 막대로 이어지는 연결선 (누적 금액 수준)
      if (i < stages.length - 1 && stages[i + 1].kind !== 'total') {
        s += `<line x1="${cx + bw / 2}" x2="${cx + band - bw / 2}" y1="${Y(st.to)}" y2="${Y(st.to)}" stroke="${C.muted}" stroke-width="1" stroke-dasharray="3 3"/>`;
      }
      s += `<g class="bar"><title>${esc(st.label)} ${st.value >= 0 ? '+' : ''}${fmt(st.value, 1)}${esc(unit)}</title>`;
      s += `<rect x="${cx - bw / 2}" y="${yA}" width="${bw}" height="${h}" rx="3" fill="${color[st.kind]}"/></g>`;
      // 값 이름표: 막대 위쪽 끝에 — 음수 합계(0 아래로 내려간 기말현금)만 아래쪽 끝에
      const above = !(st.kind === 'total' && st.value < 0);
      const ly = above ? yA - 6 : yB + 14;
      s += `<text x="${cx}" y="${ly}" font-size="11.5" font-weight="700" fill="${C.ink}" text-anchor="middle">${st.value > 0 && st.kind !== 'total' ? '+' : ''}${fmt(st.value, 1)}</text>`;
      s += `<text x="${cx}" y="${H - bottom + 18}" font-size="12" fill="${C.ink}" text-anchor="middle">${esc(st.label)}</text>`;
    });
    return s + '</svg>';
  }

  // 범례 (HTML) — 색만으로 구분하지 않도록 이름을 붙인다
  const legend = (items) => `<p class="chart-legend">${items.map(([label, color, style]) =>
    `<span><i style="background:${color};${style || ''}"></i>${esc(label)}</span>`).join('')}</p>`;

  const Charts = { C, ticks, dotLines, waterfall, legend };
  if (typeof module !== 'undefined' && module.exports) module.exports = Charts;
  else root.Charts = Charts;
})(typeof window !== 'undefined' ? window : globalThis);
