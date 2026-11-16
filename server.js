// 로컬 서버 — 정적 파일(public/) + 공공데이터 중계 API.
// 인증키(DATA_GO_KR_KEY)는 .env.local에서 서버 메모리로만 읽고, 브라우저에는 결과만 보낸다.
// 실행: node server.js → http://localhost:5173
const http = require('http');
const fs = require('fs');
const path = require('path');
const { lookupRegion } = require('./server/region.js');
const { createTradeService } = require('./server/trades.js');
const { createApplyhomeService } = require('./server/applyhome.js');

const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// JSON 응답 — 캐시하지 않음
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// 서버 만들기 — 테스트에서 key·fetchImpl을 직접 넣을 수 있게 분리
function createApp({ key = '', fetchImpl = fetch, cacheDir, now } = {}) {
  const cache = new Map();
  const getMonth = createTradeService({ key, fetchImpl, cacheDir: cacheDir && path.join(cacheDir, 'trades'), now, regionCache: cache });
  const applyhome = createApplyhomeService({ key, fetchImpl, cacheDir: cacheDir && path.join(cacheDir, 'applyhome'), now, regionCache: cache });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // 실거래가 한 달치: /api/trades?site=부산광역시 해운대구&kind=silv|rent&ym=YYYYMM
    // 브라우저는 지역 이름만 보낸다 — 지역코드는 서버가 다시 확인
    if (url.pathname === '/api/trades') {
      const p = url.searchParams;
      return sendJson(res, 200, await getMonth({ site: p.get('site'), kind: p.get('kind'), ym: p.get('ym') }));
    }

    // 지역 확인: /api/region?name=부산광역시 해운대구
    if (url.pathname === '/api/region') {
      const result = await lookupRegion(url.searchParams.get('name') || '', { key, fetchImpl, cache });
      return sendJson(res, 200, result);
    }
    // 청약홈 인근 신규 분양: 단지 목록 → 단지별 상세 (브라우저는 지역 이름과 목록에 있는 단지 번호만 보낸다)
    if (url.pathname === '/api/applyhome/list') {
      return sendJson(res, 200, await applyhome.list({ site: url.searchParams.get('site') }));
    }
    if (url.pathname === '/api/applyhome/complex') {
      return sendJson(res, 200, await applyhome.complex({ site: url.searchParams.get('site'), id: url.searchParams.get('id') }));
    }
    // 인증키 설정 여부만 알려준다 (값은 절대 보내지 않음)
    if (url.pathname === '/api/status') return sendJson(res, 200, { keyConfigured: !!key });

    // 정적 파일
    const urlPath = decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

// .env.local 읽기 — 값은 출력하지 않는다. 파일이 없어도 서버는 뜬다.
function loadKey() {
  try { process.loadEnvFile(path.join(__dirname, '.env.local')); } catch { /* 파일 없음 */ }
  return (process.env.DATA_GO_KR_KEY || '').trim();
}

if (require.main === module) {
  const PORT = process.env.PORT || 5173;
  const key = loadKey();
  createApp({ key }).listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
    console.log(`공공데이터 인증키: ${key ? '설정됨' : '없음 — 지역 확인을 건너뜁니다'}`);
  });
}

module.exports = { createApp };
