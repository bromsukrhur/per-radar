/**
 * PER 레이더 — 한국투자증권 API 로컬 프록시 서버
 * 
 * 사용법:
 *   npm install express cors node-fetch
 *   node proxy.js
 * 
 * 브라우저에서 직접 KIS API를 호출하면 CORS 오류가 발생할 수 있습니다.
 * 이 프록시를 통해 해결합니다.
 * 
 * 접속: http://localhost:3001
 */

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const KIS_BASE = {
  paper: 'https://openapivts.koreainvestment.com:29443',
  real:  'https://openapi.koreainvestment.com:9443',
};

// 토큰 캐시
const tokenCache = {};

async function getToken(appKey, appSecret, env) {
  const cacheKey = `${appKey}_${env}`;
  const now = Date.now();
  if (tokenCache[cacheKey] && tokenCache[cacheKey].expires > now) {
    return tokenCache[cacheKey].token;
  }
  const fetch = (await import('node-fetch')).default;
  const base = KIS_BASE[env] || KIS_BASE.paper;
  const res = await fetch(`${base}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('토큰 발급 실패: ' + JSON.stringify(data));
  tokenCache[cacheKey] = { token: data.access_token, expires: now + (data.expires_in || 86400) * 900 };
  return data.access_token;
}

// 현재가 조회
app.get('/api/price/:code', async (req, res) => {
  const { appKey, appSecret, env = 'paper' } = req.query;
  const { code } = req.params;
  try {
    const fetch = (await import('node-fetch')).default;
    const token = await getToken(appKey, appSecret, env);
    const base = KIS_BASE[env];
    const r = await fetch(
      `${base}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
      { headers: { authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHKST01010100' } }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 업종 PER 조회 (KRX 통계)
app.get('/api/sector-per', async (req, res) => {
  const { appKey, appSecret, env = 'paper', iscd } = req.query;
  try {
    const fetch = (await import('node-fetch')).default;
    const token = await getToken(appKey, appSecret, env);
    const base = KIS_BASE[env];
    const r = await fetch(
      `${base}/uapi/domestic-stock/v1/quotations/inquire-pbr-per?FID_DIV_CLS_CODE=1&FID_INPUT_ISCD=${iscd || '0001'}`,
      { headers: { authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHPST02280000' } }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 배치: 여러 종목 한번에
app.post('/api/batch-price', async (req, res) => {
  const { codes, appKey, appSecret, env = 'paper' } = req.body;
  if (!codes?.length) return res.json({ results: [] });
  const fetch = (await import('node-fetch')).default;
  const results = [];
  try {
    const token = await getToken(appKey, appSecret, env);
    const base = KIS_BASE[env];
    for (const code of codes) {
      try {
        const r = await fetch(
          `${base}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
          { headers: { authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHKST01010100' } }
        );
        const d = await r.json();
        results.push({ code, data: d.output });
      } catch(e) { results.push({ code, error: e.message }); }
      await new Promise(r => setTimeout(r, 100)); // KIS rate limit
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ PER 레이더 프록시 서버 실행 중`);
  console.log(`   http://localhost:${PORT}\n`);
  console.log(`   대시보드를 열려면 브라우저에서 위 주소를 입력하세요.`);
});
