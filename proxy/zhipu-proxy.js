const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = 3000;

const TARGET_BASE = 'https://bigmodel.cn';
const TARGET_CAPTCHA = 'https://turing.captcha.qcloud.com';

const PROXY_API = 'https://share.proxy.qg.net/get?key=xxxx&num=1';
const PROXY_AUTH_KEY = process.env.PROXY_AUTH_KEY || 'xxx';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || 'xxxxx';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// 代理池配置
let proxyPool = [];
let poolIndex = 0;
let requestCount = 0;
const MAX_REQUESTS_PER_IP = 4;
const MAX_RETRY = 1;
const BASE_DELAY = 0;
let fetchingProxy   = null;   // 并发锁：复用同一个拉取 Promise，避免竞态

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function getProxyInfo() {
  if (proxyPool.length === 0 || requestCount >= MAX_REQUESTS_PER_IP * proxyPool.length) {
    try {
      if (!fetchingProxy) { 
          fetchingProxy = axios.get(PROXY_API, { timeout: 8000 });
          fetchingData = await fetchingProxy
          const json = fetchingData.data;
          const servers = json.data ?? [];
          if (!servers.length) throw new Error('代理列表为空');
          proxyPool = servers
            .map(item => item.server)
            .filter(s => s && s.includes(':'))
            .map(s => {
              const [host, port] = s.split(':');
              return { host, port: Number(port) };
            });
          poolIndex = 0;
          requestCount = 0;
          console.log('更新代理池，共', proxyPool.length, '个IP:', proxyPool.map(p => p.host).join(', '));
      } else {
        await fetchingProxy; // 等待正在进行的拉取完成，复用结果
      }
    } catch (err) {
      console.error('获取代理失败', err.message);
      proxyPool = [];
      throw err;
    } finally {
      fetchingProxy = null;
    }
  }

  const proxy = proxyPool[poolIndex % proxyPool.length];
  poolIndex++;
  requestCount++;
  return proxy;
}

function evictCurrentProxy() {
  if (proxyPool.length === 0) return;
  const badIndex = (poolIndex - 1) % proxyPool.length;
  console.log('淘汰代理IP:', proxyPool[badIndex]?.host);
  proxyPool.splice(badIndex, 1);
  if (poolIndex > 0) poolIndex = Math.max(0, poolIndex - 1);
}

// const HOP_HEADERS = [
//   'host', 'connection', 'content-length', 'origin', 'referer',
//   'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
//   'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'
// ];
const HOP_HEADERS = ['host', 'connection', 'content-length', 'content-encoding'];

async function proxyRequest(targetBase, path, req, res, retry = 0) {
  const targetUrl = targetBase + path;
  const proxyInfo = await getProxyInfo();

  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_HEADERS.includes(k.toLowerCase())) continue;
    forwardHeaders[k] = v;
  }
  forwardHeaders.Host = new URL(targetBase).host;

  const proxyUrl = `http://${PROXY_AUTH_KEY}:${PROXY_PASSWORD}@${proxyInfo.host}:${proxyInfo.port}`;
  const agent = new HttpsProxyAgent(proxyUrl);

  const isBinary = req.headers.accept?.includes('image') || targetUrl.includes('getcapbysig');

  try {
    const response = await axios({
      url: targetUrl,
      method: req.method,
      headers: forwardHeaders,
      data: req.body,
      httpsAgent: agent,
      httpAgent: agent,
      timeout: 5000,
      validateStatus: () => true,
      responseType: isBinary ? 'arraybuffer' : 'stream'
    });
    console.log(`[${req.method}] ${targetUrl} | 代理${proxyInfo.host}:${proxyInfo.port} | 状态:${response.status} len:${response.data?.readable ? 'stream' : response.data?.length ?? 0}`);
    
    if ((response.status === 429 || response.status === 407 || response.status === 408) && retry < MAX_RETRY) {
      evictCurrentProxy();
      const wait = (retry + 1) * 100;
      console.log(`命中${response.status}，等待${wait}ms后换新IP重试，剩余重试:${MAX_RETRY - retry}`);
      if (response.data?.resume) response.data.resume();
      await sleep(wait);
      return proxyRequest(targetBase, path, req, res, retry + 1);
    }

    if (response.headers['set-cookie']) res.setHeader('Set-Cookie', response.headers['set-cookie']);
    if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
    console.log(res, 66);
    
    res.status(response.status);
    if (isBinary) res.end(response.data);
    else response.data.pipe(res);

  } catch (err) {
    if (retry < MAX_RETRY) {
      evictCurrentProxy();
      await sleep((retry + 1) * 100);
      return proxyRequest(targetBase, path, req, res, retry + 1);
    }
    throw err;
  }
}
 
app.all('/api/biz/pay/preview', async (req, res) => {
  try { 
    await proxyRequest(TARGET_BASE, req.originalUrl, req, res); 
  }
  catch (e) { res.status(500).json({ err: e.message }); }
});

app.all('/cap_union_prehandle', async (req, res) => {
  try {
    await proxyRequest(TARGET_CAPTCHA, req.originalUrl, req, res);
  } catch (e) { res.status(500).json({ err: e.message }); }
});

app.listen(PORT, () => console.log(`代理启动: localhost:${PORT}`));