/**
 * PER 레이더 — 한국투자증권 API 로컬 프록시 서버
 * v2.0 — KRX 업종 PER + 네이버 금융 종목별 실시간 PER 추가
 *
 * 사용법:
 *   npm install express cors node-fetch
 *   node proxy.js
 *
 * 접속: http://localhost:3001
 */

const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const KIS_BASE = {
  paper: 'https://openapivts.koreainvestment.com:29443',
  real:  'https://openapi.koreainvestment.com:9443',
};

// ── 토큰 캐시 ────────────────────────────────────────────────
const tokenCache = {};

async function getToken(appKey, appSecret, env) {
  const cacheKey = `${appKey}_${env}`;
  const now = Date.now();
  if (tokenCache[cacheKey] && tokenCache[cacheKey].expires > now) {
    return tokenCache[cacheKey].token;
  }
  const fetch = (await import('node-fetch')).default;
  const base  = KIS_BASE[env] || KIS_BASE.paper;
  const res   = await fetch(`${base}/oauth2/tokenP`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('토큰 발급 실패: ' + JSON.stringify(data));
  tokenCache[cacheKey] = {
    token:   data.access_token,
    expires: now + (data.expires_in || 86400) * 900,
  };
  return data.access_token;
}

// ── KIS: 현재가 조회 ─────────────────────────────────────────
app.get('/api/price/:code', async (req, res) => {
  const { appKey, appSecret, env = 'paper' } = req.query;
  const { code } = req.params;
  try {
    const fetch = (await import('node-fetch')).default;
    const token = await getToken(appKey, appSecret, env);
    const base  = KIS_BASE[env];
    const r     = await fetch(
      `${base}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
      { headers: { authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHKST01010100' } }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── KIS: 업종 PER 조회 ───────────────────────────────────────
app.get('/api/sector-per', async (req, res) => {
  const { appKey, appSecret, env = 'paper', iscd } = req.query;
  try {
    const fetch = (await import('node-fetch')).default;
    const token = await getToken(appKey, appSecret, env);
    const base  = KIS_BASE[env];
    const r     = await fetch(
      `${base}/uapi/domestic-stock/v1/quotations/inquire-pbr-per?FID_DIV_CLS_CODE=1&FID_INPUT_ISCD=${iscd || '0001'}`,
      { headers: { authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHPST02280000' } }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── KIS: 배치 현재가 ─────────────────────────────────────────
app.post('/api/batch-price', async (req, res) => {
  const { codes, appKey, appSecret, env = 'paper' } = req.body;
  if (!codes?.length) return res.json({ results: [] });
  const fetch   = (await import('node-fetch')).default;
  const results = [];
  try {
    const token = await getToken(appKey, appSecret, env);
    const base  = KIS_BASE[env];
    for (const code of codes) {
      try {
        const r = await fetch(
          `${base}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
          { headers: { authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHKST01010100' } }
        );
        const d = await r.json();
        results.push({ code, data: d.output });
      } catch (e) {
        results.push({ code, error: e.message });
      }
      await new Promise(r => setTimeout(r, 100));
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// ── 네이버 금융: 종목별 PER/PBR/ROE 크롤링 ──────────────────
// ════════════════════════════════════════════════════════════
const naverCache = {};
const NAVER_TTL  = 5 * 60 * 1000; // 5분 캐시

app.get('/api/naver/stock/:code', async (req, res) => {
  const { code } = req.params;
  const now      = Date.now();

  if (naverCache[code] && now - naverCache[code].ts < NAVER_TTL) {
    return res.json({ ...naverCache[code].data, cached: true });
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const url   = `https://finance.naver.com/item/main.naver?code=${code}`;
    const r     = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer':         'https://finance.naver.com',
      },
    });
    const html = await r.text();

    const perMatch     = html.match(/PER<\/th>[\s\S]*?<td[^>]*>([\d,.]+)<\/td>/);
    const pbrMatch     = html.match(/PBR<\/th>[\s\S]*?<td[^>]*>([\d,.]+)<\/td>/);
    const epsMatch     = html.match(/EPS<\/th>[\s\S]*?<td[^>]*>([\d,.-]+)<\/td>/);
    const priceMatch   = html.match(/"no_val">([\d,]+)<\/span>/);
    const chgMatch     = html.match(/no_exday[^>]*>([\d.]+)<\/span>/);
    const chgSignMatch = html.match(/blind">(상승|하락|보합)<\/span>/);

    const per   = perMatch   ? parseFloat(perMatch[1].replace(/,/g, ''))  : null;
    const pbr   = pbrMatch   ? parseFloat(pbrMatch[1].replace(/,/g, ''))  : null;
    const eps   = epsMatch   ? parseInt(epsMatch[1].replace(/,/g, ''))    : null;
    const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''))  : null;
    let   chg   = chgMatch   ? parseFloat(chgMatch[1]) : 0;
    if (chgSignMatch && chgSignMatch[1] === '하락') chg = -chg;

    const data = { code, per, pbr, eps, price, chg, ts: now };
    naverCache[code] = { data, ts: now };
    res.json({ ...data, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 네이버: 배치 (여러 종목 한번에) ─────────────────────────
app.post('/api/naver/batch', async (req, res) => {
  const { codes } = req.body;
  if (!codes?.length) return res.json({ results: [] });

  const fetch   = (await import('node-fetch')).default;
  const now     = Date.now();
  const results = [];

  for (const code of codes) {
    if (naverCache[code] && now - naverCache[code].ts < NAVER_TTL) {
      results.push({ ...naverCache[code].data, cached: true });
      continue;
    }
    try {
      const url = `https://finance.naver.com/item/main.naver?code=${code}`;
      const r   = await fetch(url, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Referer':         'https://finance.naver.com',
        },
      });
      const html         = await r.text();
      const perMatch     = html.match(/PER<\/th>[\s\S]*?<td[^>]*>([\d,.]+)<\/td>/);
      const pbrMatch     = html.match(/PBR<\/th>[\s\S]*?<td[^>]*>([\d,.]+)<\/td>/);
      const epsMatch     = html.match(/EPS<\/th>[\s\S]*?<td[^>]*>([\d,.-]+)<\/td>/);
      const priceMatch   = html.match(/"no_val">([\d,]+)<\/span>/);
      const chgMatch     = html.match(/no_exday[^>]*>([\d.]+)<\/span>/);
      const chgSignMatch = html.match(/blind">(상승|하락|보합)<\/span>/);

      const per   = perMatch   ? parseFloat(perMatch[1].replace(/,/g, ''))  : null;
      const pbr   = pbrMatch   ? parseFloat(pbrMatch[1].replace(/,/g, ''))  : null;
      const eps   = epsMatch   ? parseInt(epsMatch[1].replace(/,/g, ''))    : null;
      const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''))  : null;
      let   chg   = chgMatch   ? parseFloat(chgMatch[1]) : 0;
      if (chgSignMatch && chgSignMatch[1] === '하락') chg = -chg;

      const data = { code, per, pbr, eps, price, chg, ts: now };
      naverCache[code] = { data, ts: now };
      results.push({ ...data, cached: false });
    } catch (e) {
      results.push({ code, error: e.message });
    }
    await new Promise(r => setTimeout(r, 200)); // 네이버 rate limit 방지
  }
  res.json({ results });
});

// ════════════════════════════════════════════════════════════
// ── KRX: 업종별 공식 PER/PBR 데이터 ─────────────────────────
// ════════════════════════════════════════════════════════════
const krxCache = { data: null, ts: 0 };
const KRX_TTL  = 60 * 60 * 1000; // 1시간 캐시

app.get('/api/krx/sector-per', async (req, res) => {
  const now = Date.now();
  if (krxCache.data && now - krxCache.ts < KRX_TTL) {
    return res.json({ data: krxCache.data, cached: true });
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const today = new Date();
    const trdDd = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

    const body = new URLSearchParams({
      bld:         'dbms/MDC/STAT/standard/MDCSTAT03901',
      locale:      'ko_KR',
      trdDd,
      share:       '1',
      money:       '1',
      csvxls_isNo: 'false',
    });

    const r = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':      'https://data.krx.co.kr',
        'Origin':       'https://data.krx.co.kr',
      },
      body: body.toString(),
    });

    const json = await r.json();
    const rows = json.OutBlock_1 || [];

    const sectorMap = {
      '반도체':      { id: 'semi',    name: '반도체·HBM'     },
      '방위산업':    { id: 'defense', name: '방산·조선'       },
      '은행':        { id: 'finance', name: '금융·증권·지주'  },
      '증권':        { id: 'finance', name: '금융·증권·지주'  },
      '전기·가스업': { id: 'power',   name: '전력기기·에너지' },
      '의약품':      { id: 'bio',     name: '제약·바이오'     },
      '화학':        { id: 'beauty',  name: '화장품·K소비재'  },
    };

    const processed = {};
    rows.forEach(row => {
      const name = row.IDX_NM || '';
      const per  = parseFloat((row.PER || '').replace(/,/g, '')) || null;
      const pbr  = parseFloat((row.PBR || '').replace(/,/g, '')) || null;

      Object.entries(sectorMap).forEach(([keyword, sector]) => {
        if (name.includes(keyword) && per) {
          if (!processed[sector.id] || per < processed[sector.id].per) {
            processed[sector.id] = { ...sector, per, pbr, krxName: name };
          }
        }
      });
    });

    krxCache.data = processed;
    krxCache.ts   = now;
    res.json({ data: processed, cached: false });
  } catch (e) {
    if (krxCache.data) return res.json({ data: krxCache.data, cached: true, fallback: true });
    res.status(500).json({ error: e.message });
  }
});

// ── KRX: 전체 종목 저PER 순위 ────────────────────────────────
app.get('/api/krx/low-per', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const today = new Date();
    const trdDd = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

    const body = new URLSearchParams({
      bld:         'dbms/MDC/STAT/standard/MDCSTAT03501',
      locale:      'ko_KR',
      mktId:       'STK',
      trdDd,
      share:       '1',
      money:       '1',
      csvxls_isNo: 'false',
    });

    const r = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':      'https://data.krx.co.kr',
        'Origin':       'https://data.krx.co.kr',
      },
      body: body.toString(),
    });

    const json = await r.json();
    const rows = (json.OutBlock_1 || [])
      .filter(row => {
        const per = parseFloat((row.PER || '').replace(/,/g, ''));
        return per > 0 && per < 15;
      })
      .map(row => ({
        code:   row.ISU_SRT_CD,
        name:   row.ISU_ABBRV,
        per:    parseFloat((row.PER  || '').replace(/,/g, '')),
        pbr:    parseFloat((row.PBR  || '').replace(/,/g, '')),
        price:  parseInt((row.TDD_CLSPRC || '').replace(/,/g, '')),
        mktCap: row.MKTCAP,
      }))
      .sort((a, b) => a.per - b.per)
      .slice(0, 100);

    res.json({ results: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// ── AI API 중계 (CORS 우회) ───────────────────────────────────
// ════════════════════════════════════════════════════════════
app.post('/api/ai/messages', async (req, res) => {
  const apiKey   = req.headers['x-api-key'];
  const endpoint = req.headers['x-ai-endpoint'] || 'https://aiprimetech.io/v1';
  if (!apiKey) return res.status(400).json({ error: 'x-api-key 헤더 필요' });
  try {
    const fetch = (await import('node-fetch')).default;

    // aiprimetech.io / anthropic 둘 다 호환되게 헤더 전송
    const r = await fetch(`${endpoint}/messages`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'Authorization':     `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const text = await r.text();
    console.log(`[AI] ${r.status} ${endpoint} →`, text.slice(0, 200));

    try {
      const data = JSON.parse(text);
      res.status(r.status).json(data);
    } catch(e) {
      res.status(r.status).send(text);
    }
  } catch (e) {
    console.error('[AI 중계 오류]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 헬스체크 ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:          'ok',
    version:         '2.1',
    features:        ['kis-price', 'naver-per', 'krx-sector-per', 'krx-low-per', 'ai-proxy'],
    naverCacheCount: Object.keys(naverCache).length,
    krxCached:       !!krxCache.data,
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ PER 레이더 프록시 서버 v2.0 실행 중`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n   추가된 기능:`);
  console.log(`   · 네이버 금융 종목별 PER/PBR 실시간 크롤링 (5분 캐시)`);
  console.log(`   · KRX 업종별 공식 PER 데이터 (1시간 캐시)`);
  console.log(`   · KRX 저PER 종목 전체 순위 KOSPI\n`);
});
