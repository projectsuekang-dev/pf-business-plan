// 배포용 빌드 — public/ 을 dist/ 로 복사하고 기본 점검을 한다. (Node 내장 기능만 사용)
// 1) 모든 JS 문법 점검  2) index.html이 참조하는 파일이 있는지  3) 샘플 A로 보고서가 깨지지 않는지
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'dist');
const fail = (msg) => { console.error('✖ ' + msg); process.exit(1); };

// 1) JS 문법 점검
// (서버 코드도 문법만 점검 — 실행하지 않으므로 인증키가 없어도 통과)
const jsFiles = [
  ...fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => path.join('public', f)),
  'server.js',
  ...fs.readdirSync(path.join(__dirname, 'server')).filter((f) => f.endsWith('.js')).map((f) => path.join('server', f)),
];
for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(__dirname, f), 'utf8');
  try { new vm.Script(`(function (require, module, exports, __dirname, __filename) {${code}\n})`, { filename: f }); }
  catch (e) { fail(`${f} 문법 오류: ${e.message}`); }
}
console.log(`✔ JS 문법 점검 ${jsFiles.length}개`);

// 2) index.html 참조 파일 확인
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
for (const r of refs) if (!fs.existsSync(path.join(SRC, r))) fail(`index.html이 참조하는 ${r} 없음`);
console.log(`✔ index.html 참조 파일 ${refs.length}개 확인`);

// 3) 보고서 생성 점검 — 샘플 A와 빈 입력 모두 NaN/Infinity/undefined 없이 7개 장
const Report = require('./public/report.js');
const sampleA = {
  name: '해운대 그린테라스', site: '부산광역시 해운대구',
  units: [{ name: '59형', excl: 59.9, supply: 25.6, count: 200 }, { name: '84형', excl: 84.9, supply: 34.6, count: 320 }],
  pricePerPyeong: 2420, retail: 150, otherInflow: 175, fixedCost: 3815.0, mainPF: 2450, pfFinanceCost: 480, subordinated: 400,
};
const empty = { name: '', site: '', units: [], pricePerPyeong: null, retail: null, otherInflow: null, fixedCost: null, mainPF: null, pfFinanceCost: null, subordinated: null };
for (const [label, raw] of [['샘플 A', sampleA], ['빈 입력', empty]]) {
  const out = Report.render(raw);
  const chapters = (out.match(/class="chapter"/g) || []).length;
  if (chapters !== 7) fail(`${label} 보고서 장 수 ${chapters} (7이어야 함)`);
  if (/NaN|Infinity|undefined/.test(out)) fail(`${label} 보고서에 NaN/Infinity/undefined 포함`);
}
console.log('✔ 보고서 생성 점검 (샘플 A · 빈 입력)');

// 4) dist/ 로 복사
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });
console.log(`✔ dist/ 생성 — ${fs.readdirSync(OUT).join(', ')}`);
