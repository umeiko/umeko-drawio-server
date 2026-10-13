// 渲染服务客户端：
//  - png/jpg/pdf → jgraph/export-server（Puppeteer，:8000）
//  - svg         → 自建 svg-exporter（:8001，驱动 embed 编辑器客户端导出）
const RASTER_URLS = (process.env.EXPORT_URLS || 'http://export-server:8000/,http://drawio:8080/export')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SVG_URLS = (process.env.SVG_EXPORT_URLS || 'http://svg-exporter:8001/')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 90000);

const preferred = new Map();

export async function renderDiagram(xml, format, extra = {}) {
  const urls = format === 'svg' ? SVG_URLS : RASTER_URLS;
  const pref = preferred.get(format);
  const order = pref ? [pref, ...urls.filter((u) => u !== pref)] : urls;
  let lastError = null;

  for (const url of order) {
    try {
      const body = new URLSearchParams({ xml, format, ...extra });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        lastError = new Error(`render via ${url} failed: HTTP ${res.status} ${buf.toString('utf8').slice(0, 300)}`);
        continue;
      }
      preferred.set(format, url);
      return { buffer: buf, via: url };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('no render endpoint configured');
}
