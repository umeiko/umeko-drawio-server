// 内网导出服务：用无头 Chrome 打开自托管 drawio 编辑器（embed 协议），
// 载入 XML 后取回编辑器客户端导出的 SVG/PNG/JPG。基于 jgraph/export-server 镜像构建，
// 复用其中的 Chrome + puppeteer，完全离线。
const express = require('express');
const puppeteer = require('puppeteer');

const PORT = Number(process.env.PORT || 8001);
const DRAWIO_URL = (process.env.DRAWIO_URL || 'http://drawio:8080').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS || 60000);

const CHROME_ARGS = [
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-popup-blocking',
  '--disable-renderer-backgrounding',
  '--disable-setuid-sandbox',
  '--disable-sync',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-pings',
  '--no-sandbox',
  '--no-zygote',
  '--use-gl=swiftshader',
  '--use-mock-keychain',
];

const app = express();
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

let browserPromise = null;
let queue = Promise.resolve();

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch {}
    browserPromise = null;
  }
  browserPromise = puppeteer
    .launch({ headless: 'chrome-headless-shell', args: CHROME_ARGS })
    .catch((e) => {
      browserPromise = null;
      throw e;
    });
  return browserPromise;
}

async function exportDrawio(xml, opts) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const wrapper =
      '<!doctype html><html><body style="margin:0">' +
      `<iframe id="f" src="${DRAWIO_URL}/?embed=1&proto=json&spin=0&analytics=0&picker=0&stealth=1" ` +
      'style="width:1400px;height:1000px;border:0"></iframe></body></html>';
    await page.setContent(wrapper, { waitUntil: 'load', timeout: REQUEST_TIMEOUT_MS });

    const data = await page.evaluate(
      (xmlInput, options, timeoutMs) =>
        new Promise((resolve, reject) => {
          const iframe = document.getElementById('f');
          const timer = setTimeout(() => reject(new Error('editor export timeout')), timeoutMs);
          const send = (o) => iframe.contentWindow.postMessage(JSON.stringify(o), '*');
          let exportSent = false;
          const requestExport = () => {
            if (exportSent) return;
            exportSent = true;
            send({ action: 'export', format: options.format, scale: options.scale, bg: options.bg, border: options.border });
          };
          window.addEventListener('message', (e) => {
            if (e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
            let m;
            try {
              m = JSON.parse(e.data);
            } catch {
              return;
            }
            if (m.event === 'init') {
              send({ action: 'load', xml: xmlInput });
              // 部分版本不发 'load' 事件，3 秒后兜底直接导出
              setTimeout(requestExport, 3000);
            } else if (m.event === 'load') {
              requestExport();
            } else if (m.event === 'export') {
              clearTimeout(timer);
              resolve(m.data || '');
            }
          });
        }),
      xml,
      opts,
      REQUEST_TIMEOUT_MS - 5000,
    );
    return data;
  } finally {
    page.close().catch(() => {});
  }
}

const MIME = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

// 编辑器导出结果为 data URI：svg 为 URL 编码文本，png/jpg 为 base64
function decodeDataUri(data) {
  if (typeof data !== 'string' || data === '') throw new Error('empty export result');
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',');
    const meta = data.slice(0, comma);
    const payload = data.slice(comma + 1);
    return meta.includes('base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
  }
  return Buffer.from(data, 'utf8');
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/', (req, res) => {
  const xml = req.body && req.body.xml;
  const format = String((req.body && req.body.format) || 'svg').toLowerCase();
  if (!xml) return res.status(400).end('Missing xml');
  if (!MIME[format]) return res.status(400).end('Unsupported Format! (支持 svg/png/jpg)');

  const opts = { format };
  if (req.body.scale) opts.scale = Number(req.body.scale);
  if (req.body.bg) opts.bg = req.body.bg;
  if (req.body.border) opts.border = Number(req.body.border);

  // 串行处理请求，避免并发压垮无头浏览器
  queue = queue.then(async () => {
    try {
      const buf = decodeDataUri(await exportDrawio(String(xml), opts));
      res.header('Access-Control-Allow-Origin', '*');
      res.type(MIME[format]).send(buf);
    } catch (e) {
      res.status(500).end(String((e && e.message) || e));
    }
  });
  queue.catch(() => {});
});

app.listen(PORT, () => console.log(`svg-exporter listening on ${PORT}, editor: ${DRAWIO_URL}`));
