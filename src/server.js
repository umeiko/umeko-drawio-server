import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { NodeRegistry } from './nodes.js';
import { validateDiagramXml } from './validate.js';
import { renderDiagram, renderEndpoints } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DRAWIO_URL = (process.env.DRAWIO_URL || 'http://localhost:8081').replace(/\/$/, '');
// 编辑器静态直出模式：设置后根路径用 express.static 直接提供 drawio webapp 静态文件
// （内网拉不到镜像时，可把 draw.war 解压/ webapp 目录拷到本机指过来），不再走反向代理
const DRAWIO_STATIC_DIR = (process.env.DRAWIO_STATIC_DIR || '').replace(/\/+$/, '');
// 对外基础地址：UMEKO_DRAWIO_SERVER_BASE_URL 显式指定（可含 ALB 路径前缀），否则回退 PUBLIC_BASE_URL
const PUBLIC_BASE_URL = (
  process.env.UMEKO_DRAWIO_SERVER_BASE_URL ||
  process.env.PUBLIC_BASE_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, '');
// 从基础地址解析路径前缀（如 https://example.com/drawio -> /drawio），整站挂载到该前缀下
const BASE_PATH = (() => {
  try {
    const p = new URL(PUBLIC_BASE_URL).pathname.replace(/\/+$/, '');
    return p === '/' ? '' : p;
  } catch {
    return '';
  }
})();
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// 自定义字体目录（方正兰亭黑等，deploy/get-fonts.sh 下载，不入 git）
const FONTS_DIR = process.env.FONTS_DIR || path.join(__dirname, '..', 'fonts');
const COLD_DIR = path.join(DATA_DIR, 'cold');
const HOT_TTL_MS = Number(process.env.NODE_HOT_MINUTES || 30) * 60 * 1000;
const COLD_TTL_MS = Number(process.env.NODE_COLD_HOURS || 48) * 3600 * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_SECONDS || 30) * 1000;
const ADMIN_USER = process.env.ADMIN_USER || 'umeko';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';
// 节点页实时通道：auto（WS 优先，失败自动降级 SSE）| ws | sse（ALB 不支持 WebSocket 时设为 sse）
const NODE_TRANSPORT = ['auto', 'ws', 'sse'].includes(process.env.NODE_TRANSPORT)
  ? process.env.NODE_TRANSPORT
  : 'auto';
const ADMIN_SESSION_MS = 12 * 3600 * 1000;
const COOKIE_PATH = BASE_PATH || '/';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const registry = new NodeRegistry({ coldDir: COLD_DIR, hotTtlMs: HOT_TTL_MS, coldTtlMs: COLD_TTL_MS });
const endpoints = renderEndpoints();

const app = express();
app.disable('x-powered-by');
const router = express.Router();

const nodeUrl = (id) => `${PUBLIC_BASE_URL}/node/${id}`;
const notFound = (res) => res.status(404).json({ ok: false, error: 'node not found or expired' });

// ---------- 工具 ----------

async function dirSize(dir) {
  let total = 0;
  try {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else total += (await fs.promises.stat(p)).size;
    }
  } catch {}
  return total;
}

async function probe(url, timeoutMs = 3000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await r.arrayBuffer().catch(() => {});
    return { ok: true, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
  }
}

async function validateDeep(xml, deep) {
  const v = validateDiagramXml(xml);
  if (v.ok && deep) {
    try {
      await renderDiagram(xml, 'svg');
      v.deep = 'ok';
    } catch (e) {
      v.ok = false;
      v.errors.push(`渲染(编译)失败: ${e.message}`);
    }
  }
  return v;
}

async function checkNode(node, deep) {
  let xml = node.xml;
  let source = 'cache';
  try {
    ({ xml } = await registry.getXml(node, 8000));
    source = 'live';
  } catch {}
  const v = await validateDeep(xml, deep);
  const result = { ...v, source, at: new Date().toISOString() };
  node.lastValidation = result;
  return result;
}

// 页面为纯静态文件（运行时自行推导路径前缀，见各页面内 JS），clean URL 与 /xxx.html 直出均可
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const sendPage = (res, name) => res.sendFile(path.join(PUBLIC_DIR, name));

// ---------- 管理员会话 ----------

const adminTokens = new Map(); // token -> expiresAt

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function requireAdmin(req, res, next) {
  const t = parseCookies(req).umeko_admin;
  const exp = t && adminTokens.get(t);
  if (exp && exp > Date.now()) {
    adminTokens.set(t, Date.now() + ADMIN_SESSION_MS);
    return next();
  }
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ---------- 基础 ----------

router.get('/healthz', (req, res) => res.json({ ok: true }));

router.get('/api', (req, res) =>
  res.json({
    name: 'umeko drawio server',
    endpoints: {
      editor: `${PUBLIC_BASE_URL}/  (draw.io 原生编辑器)`,
      entry: `${PUBLIC_BASE_URL}/node  (入口页：输入节点 ID 或申请新节点)`,
      nodePage: `${PUBLIC_BASE_URL}/node/:id`,
      createNode: 'POST /api/nodes {title?}',
      getXml: 'GET /api/nodes/:id/xml',
      pushXml: 'PUT /api/nodes/:id/xml',
      getErrors: 'GET /api/nodes/:id/errors?deep=1',
      validate: 'POST /api/validate {xml, deep?}',
      render: 'POST /render {xml, format: png|svg}',
      mcpUser: `POST ${PUBLIC_BASE_URL}/mcp  (用户态：所有工具需 nodeId，无节点列举)`,
      mcpDev: `POST ${PUBLIC_BASE_URL}/mcp-dev  (开发态：含 list_nodes 等全部工具)`,
      manage: `${PUBLIC_BASE_URL}/manage  (管理面板)`,
    },
  }),
);

// ---------- 节点 REST API（节点 ID 即访问凭证，无全量列举） ----------

// 前端页面运行时配置（页面静态直出，通过该接口获取服务端配置）
router.get('/api/config', (req, res) => res.json({ ok: true, transport: NODE_TRANSPORT }));

router.use('/api', express.json({ limit: '10mb' }));

router.post('/api/nodes', (req, res) => {
  const node = registry.create(String((req.body && req.body.title) || ''));
  res.json({ ok: true, nodeId: node.id, url: nodeUrl(node.id) });
});

router.get('/api/nodes/:id', (req, res) => {
  const n = registry.resolve(req.params.id);
  if (!n) return notFound(res);
  res.json({
    ok: true,
    id: n.id,
    title: n.title,
    createdAt: n.createdAt,
    connected: registry.isConnected(n),
    url: nodeUrl(n.id),
  });
});

router.delete('/api/nodes/:id', (req, res) => {
  if (!registry.delete(req.params.id)) return notFound(res);
  res.json({ ok: true });
});

router.get('/api/nodes/:id/xml', async (req, res) => {
  const n = registry.resolve(req.params.id);
  if (!n) return notFound(res);
  try {
    const { xml } = await registry.getXml(n, 8000);
    res.type('application/xml').send(xml);
  } catch {
    res.type('application/xml').send(n.xml);
  }
});

router.put('/api/nodes/:id/xml', express.text({ type: () => true, limit: '25mb' }), (req, res) => {
  const n = registry.resolve(req.params.id);
  if (!n) return notFound(res);
  const xml = String(req.body || '');
  const v = validateDiagramXml(xml);
  n.lastValidation = { ...v, at: new Date().toISOString(), source: 'push' };
  if (!v.ok) return res.status(422).json({ ok: false, errors: v.errors, warnings: v.warnings });
  const pushed = registry.setXml(n, xml);
  res.json({
    ok: true,
    pushed,
    note: pushed ? '已推送到打开的编辑器页面' : '页面未连接，已缓存，打开节点页后自动加载',
  });
});

router.get('/api/nodes/:id/errors', async (req, res) => {
  const n = registry.resolve(req.params.id);
  if (!n) return notFound(res);
  const deep = req.query.deep === '1' || req.query.deep === 'true';
  res.json(await checkNode(n, deep));
});

router.post('/api/validate', async (req, res) => {
  const xml = String((req.body && req.body.xml) ?? '');
  res.json(await validateDeep(xml, !!(req.body && req.body.deep)));
});

// ---------- 页面实时通道的 SSE 传输（ALB 不支持 WebSocket 时的替代实现） ----------
// 下行：GET /api/nodes/:id/events（EventSource）；上行：POST /api/nodes/:id/report

router.get('/api/nodes/:id/events', (req, res) => {
  const n = registry.resolve(req.params.id);
  if (!n) return notFound(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁止 nginx/网关缓冲 SSE
  });
  res.write('retry: 3000\n\n');
  registry.attachSse(n, res);
  // 25s 心跳，低于 ALB 默认 60s 空闲超时
  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 25000);
  req.on('close', () => clearInterval(hb));
});

router.post('/api/nodes/:id/report', express.text({ type: () => true, limit: '25mb' }), (req, res) => {
  const n = registry.resolve(req.params.id);
  if (!n) return notFound(res);
  registry.onMessage(n, typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  res.json({ ok: true });
});

// ---------- XML -> PNG/SVG 渲染服务 ----------

router.post('/render', express.json({ limit: '25mb' }), async (req, res) => {
  const { xml, format = 'svg', scale, background } = req.body || {};
  const fmt = String(format).toLowerCase();
  if (!['png', 'svg'].includes(fmt)) {
    return res.status(400).json({ ok: false, error: 'format 必须是 png 或 svg' });
  }
  const v = validateDiagramXml(String(xml || ''));
  if (!v.ok) return res.status(422).json({ ok: false, errors: v.errors, warnings: v.warnings });
  try {
    const extra = {};
    if (scale !== undefined) extra.scale = String(scale);
    if (background !== undefined) extra.bg = String(background);
    const { buffer, via } = await renderDiagram(String(xml), fmt, extra);
    res.type(fmt === 'png' ? 'image/png' : 'image/svg+xml').set('X-Render-Via', via).send(buffer);
  } catch (e) {
    res.status(502).json({ ok: false, error: `渲染失败: ${e.message}` });
  }
});

// ---------- 节点页与入口页 ----------

router.get('/node', (req, res) => sendPage(res, 'index.html'));

router.get('/node/:id', (req, res) => {
  if (!registry.resolve(req.params.id)) return res.status(404).send('node not found or expired');
  sendPage(res, 'node.html');
});

// ---------- 管理面板 ----------

router.get('/manage', (req, res) => sendPage(res, 'manage.html'));

router.post('/manage/login', express.json(), (req, res) => {
  const { user, password } = req.body || {};
  if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = randomBytes(24).toString('base64url');
    adminTokens.set(token, Date.now() + ADMIN_SESSION_MS);
    res.setHeader(
      'Set-Cookie',
      `umeko_admin=${token}; HttpOnly; Path=${COOKIE_PATH}; SameSite=Lax; Max-Age=${ADMIN_SESSION_MS / 1000}`,
    );
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: '账号或密码错误' });
});

router.post('/manage/logout', (req, res) => {
  const t = parseCookies(req).umeko_admin;
  if (t) adminTokens.delete(t);
  res.setHeader('Set-Cookie', `umeko_admin=; HttpOnly; Path=${COOKIE_PATH}; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/manage/api/status', requireAdmin, async (req, res) => {
  const [outputBytes, coldBytes, drawio, raster, svg] = await Promise.all([
    dirSize(OUTPUT_DIR),
    dirSize(COLD_DIR),
    DRAWIO_STATIC_DIR
      ? { ok: fs.existsSync(path.join(DRAWIO_STATIC_DIR, 'index.html')), mode: 'static' }
      : probe(`${DRAWIO_URL}/`),
    probe(endpoints.raster[0]),
    probe(`${endpoints.svg[0].replace(/\/$/, '')}/health`),
  ]);
  const nodes = registry.list();
  res.json({
    ok: true,
    now: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    nodeVersion: process.version,
    config: {
      hotTtlMinutes: HOT_TTL_MS / 60000,
      coldTtlHours: COLD_TTL_MS / 3600000,
      sweepIntervalSec: SWEEP_INTERVAL_MS / 1000,
      publicBaseUrl: PUBLIC_BASE_URL,
      basePath: BASE_PATH,
    },
    counts: {
      hot: nodes.filter((n) => n.state === 'hot').length,
      cold: nodes.filter((n) => n.state === 'cold').length,
      connected: nodes.filter((n) => n.connected).length,
    },
    storage: { outputBytes, coldBytes, totalBytes: outputBytes + coldBytes },
    upstream: {
      drawio: DRAWIO_STATIC_DIR ? { dir: DRAWIO_STATIC_DIR, ...drawio } : { url: DRAWIO_URL, ...drawio },
      exportServer: { url: endpoints.raster[0], ...raster },
      svgExporter: { url: endpoints.svg[0], ...svg },
    },
  });
});

router.get('/manage/api/nodes', requireAdmin, (req, res) =>
  res.json({ ok: true, nodes: registry.list().map((n) => ({ ...n, url: nodeUrl(n.id) })) }),
);

router.get('/manage/api/nodes/:id/xml', requireAdmin, async (req, res) => {
  const n = registry.get(req.params.id);
  if (n) {
    try {
      const { xml } = await registry.getXml(n, 5000);
      return res.type('application/xml').send(xml);
    } catch {
      return res.type('application/xml').send(n.xml);
    }
  }
  const cold = registry.peekXml(req.params.id);
  if (cold != null) return res.type('application/xml').send(cold);
  notFound(res);
});

router.post('/manage/api/nodes/:id/freeze', requireAdmin, (req, res) => {
  if (!registry.freeze(req.params.id)) return notFound(res);
  res.json({ ok: true });
});

router.post('/manage/api/nodes/:id/thaw', requireAdmin, (req, res) => {
  const n = registry.thaw(req.params.id);
  if (!n) return notFound(res);
  res.json({ ok: true });
});

router.delete('/manage/api/nodes/:id', requireAdmin, (req, res) => {
  if (!registry.delete(req.params.id)) return notFound(res);
  res.json({ ok: true });
});

router.post('/manage/api/cleanup', requireAdmin, (req, res) => res.json({ ok: true, ...registry.sweep() }));

// ---------- MCP (Streamable HTTP)：/mcp 用户态，/mcp-dev 开发态 ----------

function createMcpServer(mode) {
  const isDev = mode === 'dev';
  const mcp = new McpServer({ name: `umeko-drawio (${mode})`, version: '0.2.0' });
  const ok = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
  const bad = (msg, extra = {}) => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) }],
    isError: true,
  });
  const LIFECYCLE_NOTE = `节点空闲 ${HOT_TTL_MS / 60000} 分钟自动转冷存储，冷存储保留 ${COLD_TTL_MS / 3600000} 小时后清理；访问冷节点会自动解冻。`;

  if (isDev) {
    mcp.registerTool(
      'create_node',
      {
        title: '创建 draw.io 编辑器节点（开发）',
        description: `创建一个临时 draw.io 编辑器节点，返回 nodeId 和可在浏览器打开的 URL（左侧源码，右侧完整编辑器）。${LIFECYCLE_NOTE}仅限开发调试使用；正式环境用户应在 /node 入口页手动申请节点。`,
        inputSchema: { title: z.string().optional() },
      },
      async ({ title }) => {
        const n = registry.create(title || '');
        return ok({ ok: true, nodeId: n.id, url: nodeUrl(n.id) });
      },
    );
  }

  mcp.registerTool(
    'delete_node',
    {
      title: '删除编辑器节点',
      description: '按 nodeId 删除一个编辑器节点（热/冷存储均会移除），并断开其页面连接。',
      inputSchema: { nodeId: z.string() },
    },
    async ({ nodeId }) => {
      if (!registry.delete(nodeId)) return bad('node not found or expired');
      return ok({ ok: true });
    },
  );

  mcp.registerTool(
    'get_xml',
    {
      title: '获取节点当前 XML',
      description:
        '按 nodeId 获取节点当前图形的 draw.io XML。节点页面打开时实时取自编辑器（source=live），否则取缓存/冷存储。',
      inputSchema: { nodeId: z.string() },
    },
    async ({ nodeId }) => {
      const n = registry.resolve(nodeId);
      if (!n) return bad('node not found or expired');
      try {
        const { xml, source } = await registry.getXml(n, 10000);
        return ok({ ok: true, source, xml });
      } catch (e) {
        return ok({ ok: true, source: 'cache', note: `实时获取失败(${e.message})，已返回缓存`, xml: n.xml });
      }
    },
  );

  const pushXml = async (nodeId, xml) => {
    const n = registry.resolve(nodeId);
    if (!n) return bad('node not found or expired');
    const v = validateDiagramXml(xml);
    n.lastValidation = { ...v, at: new Date().toISOString(), source: 'push' };
    if (!v.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: v.errors, warnings: v.warnings }, null, 2) }],
        isError: true,
      };
    }
    const pushed = registry.setXml(n, xml);
    return ok({
      ok: true,
      pushed,
      nodeId: n.id,
      warnings: v.warnings,
      note: pushed ? '已推送到打开的编辑器页面' : '页面未连接，已缓存，打开节点页后自动加载',
    });
  };

  mcp.registerTool(
    'set_xml',
    {
      title: '推送 XML 修改到节点',
      description:
        '按 nodeId 校验并推送 draw.io XML：页面在线则实时载入编辑器，离线则缓存待打开时加载。XML 不合法时不推送，返回编译错误列表。',
      inputSchema: { nodeId: z.string(), xml: z.string() },
    },
    async ({ nodeId, xml }) => pushXml(nodeId, xml),
  );

  mcp.registerTool(
    'push_to_editor',
    {
      title: '推送 XML 到编辑器画布',
      description:
        '按 nodeId 校验并把 draw.io XML 推送到打开的编辑器画布，返回 pushed（页面是否在线实时接收）与 nodeId。页面离线时自动缓存，打开节点页后加载。功能与 set_xml 相同，供平台画布交互使用。',
      inputSchema: { nodeId: z.string(), xml: z.string() },
    },
    async ({ nodeId, xml }) => pushXml(nodeId, xml),
  );

  mcp.registerTool(
    'get_errors',
    {
      title: '获取节点 XML 编译错误',
      description:
        '按 nodeId 对当前 XML 做编译检查：语法 + mxGraph 结构；deep=true 额外做真实渲染验证。无错误时 errors 为空。',
      inputSchema: { nodeId: z.string(), deep: z.boolean().optional() },
    },
    async ({ nodeId, deep }) => {
      const n = registry.resolve(nodeId);
      if (!n) return bad('node not found or expired');
      return ok(await checkNode(n, !!deep));
    },
  );

  mcp.registerTool(
    'render_diagram',
    {
      title: '渲染为 PNG/SVG',
      description:
        '按 nodeId 渲染节点当前 XML（或直接传入 xml）为 png/svg，保存到服务器 output 目录；png 会同时以图片内容返回。',
      inputSchema: {
        nodeId: z.string().optional(),
        xml: z.string().optional(),
        format: z.enum(['png', 'svg']).default('svg'),
        scale: z.number().optional(),
        background: z.string().optional(),
      },
    },
    async ({ nodeId, xml, format, scale, background }) => {
      let target = xml;
      let label = 'adhoc';
      if (!target) {
        if (!nodeId) return bad('nodeId 与 xml 至少提供一个');
        const n = registry.resolve(nodeId);
        if (!n) return bad('node not found or expired');
        try {
          ({ xml: target } = await registry.getXml(n, 8000));
        } catch {
          target = n.xml;
        }
        label = nodeId;
      }
      const v = validateDiagramXml(String(target));
      if (!v.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: v.errors, warnings: v.warnings }, null, 2) }],
          isError: true,
        };
      }
      const extra = {};
      if (scale !== undefined) extra.scale = String(scale);
      if (background !== undefined) extra.bg = String(background);
      try {
        const { buffer, via } = await renderDiagram(String(target), format, extra);
        const file = path.join(OUTPUT_DIR, `${label}-${Date.now()}.${format}`);
        fs.writeFileSync(file, buffer);
        const url = `${PUBLIC_BASE_URL}/output/${path.basename(file)}`;
        const blocks = [
          { type: 'text', text: JSON.stringify({ ok: true, file, url, via, bytes: buffer.length }, null, 2) },
        ];
        if (format === 'png') {
          blocks.push({ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' });
        } else if (buffer.length < 200000) {
          blocks.push({ type: 'text', text: buffer.toString('utf8') });
        }
        return { content: blocks };
      } catch (e) {
        return bad(`渲染失败: ${e.message}`);
      }
    },
  );

  if (isDev) {
    mcp.registerTool(
      'list_nodes',
      {
        title: '列出全部编辑器节点（开发）',
        description: '列出所有节点：id、标题、热/冷状态、页面是否在线、大小、最后访问时间、URL。仅限开发调试使用。',
        inputSchema: {},
      },
      async () => ok({ ok: true, nodes: registry.list().map((n) => ({ ...n, url: nodeUrl(n.id) })) }),
    );
  }

  return mcp;
}

// makeServer 为工厂函数：每个 MCP 会话创建独立 McpServer 实例，
// 否则第二个并发客户端 connect 时会抛 "Already connected to a transport"
function mountMcp(mountPath, makeServer) {
  const sessions = Object.create(null); // sid -> { transport, server }

  router.post(mountPath, express.json({ limit: '10mb' }), async (req, res) => {
    try {
      const sid = req.headers['mcp-session-id'];
      let session = sid ? sessions[sid] : undefined;
      if (!session) {
        if (sid) {
          return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown session' }, id: null });
        }
        const server = makeServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomBytes(16).toString('hex'),
          onsessioninitialized: (id) => {
            sessions[id] = session;
          },
        });
        session = { transport, server };
        transport.onclose = () => {
          if (transport.sessionId) delete sessions[transport.sessionId];
          server.close().catch(() => {});
        };
        await server.connect(transport);
      }
      await session.transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(`[mcp ${mountPath}]`, e);
      if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  const sessionHandler = async (req, res) => {
    const s = sessions[req.headers['mcp-session-id']];
    if (!s) return res.status(404).json({ error: 'unknown session' });
    await s.transport.handleRequest(req, res);
  };
  router.get(mountPath, sessionHandler);
  router.delete(mountPath, sessionHandler);
}

mountMcp('/mcp', () => createMcpServer('user'));
mountMcp('/mcp-dev', () => createMcpServer('dev'));

// 可选：平台技能工具端点（如 /skills-mcp）。SKILLS_MCP_MODULE 指向一个 ESM 模块，
// 需导出 register(mcp, ctx)（或默认导出同签名函数），在其中 mcp.registerTool(...) 注册自定义工具。
// 每个会话同样独立实例；ctx = { registry, validateDiagramXml, renderDiagram, PUBLIC_BASE_URL }。
if (process.env.SKILLS_MCP_MODULE) {
  try {
    const mod = await import(path.resolve(process.env.SKILLS_MCP_MODULE));
    const register = mod.register || mod.default;
    if (typeof register !== 'function') throw new Error('模块需导出 register(mcp, ctx)');
    const skillsPath = process.env.SKILLS_MCP_PATH || '/skills-mcp';
    const ctx = { registry, validateDiagramXml, renderDiagram, PUBLIC_BASE_URL };
    mountMcp(skillsPath, () => {
      const mcp = new McpServer({ name: 'umeko-drawio (skills)', version: '0.2.0' });
      register(mcp, ctx);
      return mcp;
    });
    console.log(`[mcp] skills 工具端点已挂载: ${skillsPath} (module: ${process.env.SKILLS_MCP_MODULE})`);
  } catch (e) {
    console.error(`[mcp] SKILLS_MCP_MODULE 加载失败: ${(e && e.message) || e}`);
  }
}

// ---------- 静态文件直出 ----------

// 渲染产物直出：<base>/output/<file> 可直接下载
router.use('/output', express.static(OUTPUT_DIR, { index: false }));
// 自定义字体直出（编辑器 customFonts 的 fontUrl 指向此处；长缓存，字体内容不变）
router.use('/fonts', express.static(FONTS_DIR, { index: false, maxAge: '30d', immutable: true }));
// 前端页面静态直出（/node.html、/manage.html 等）；index:false 避免覆盖根路径的编辑器代理
router.use(express.static(PUBLIC_DIR, { index: false }));

// ---------- draw.io 原生编辑器（静态直出或反向代理，挂在根路径） ----------

// 旧链接兼容：/editor → /node（AINA 平台等历史配置可能指向 /editor）
router.get('/editor', (req, res) => res.redirect(`${BASE_PATH}/node`));
router.get('/editor/', (req, res) => res.redirect(`${BASE_PATH}/node`));

if (DRAWIO_STATIC_DIR) {
  router.use(express.static(DRAWIO_STATIC_DIR, { index: 'index.html' }));
} else {
  router.use(
    createProxyMiddleware({
      target: DRAWIO_URL,
      changeOrigin: true,
      on: {
        proxyReq: fixRequestBody,
        error: (err, req, res) => {
          try {
            if (res && res.writeHead && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'drawio upstream unavailable', detail: String((err && err.message) || err) }));
            }
          } catch {}
        },
      },
    }),
  );
}

// ---------- 挂载（支持 ALB 路径前缀） ----------

app.get('/healthz', (req, res) => res.json({ ok: true })); // 根级健康检查，供 ALB  target 健康探测
if (BASE_PATH) {
  app.get('/', (req, res) => res.redirect(`${BASE_PATH}/`));
  // 非严格模式下 '/drawio' 也匹配 '/drawio/'，需显式判断避免自重定向循环
  app.get(BASE_PATH, (req, res, next) => {
    if (req.path !== BASE_PATH) return next();
    res.redirect(`${BASE_PATH}/`);
  });
}
app.use(BASE_PATH || '/', router);

// ---------- HTTP + WebSocket ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const WS_PATH = `${BASE_PATH}/ws`;

server.on('upgrade', (req, socket, head) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (u.pathname !== WS_PATH) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const node = registry.resolve(u.searchParams.get('node') || '');
    if (!node) {
      ws.close(4404, 'node not found or expired');
      return;
    }
    registry.attachWs(node, ws);
    ws.send(JSON.stringify({ type: 'hello', nodeId: node.id }));
  });
});

setInterval(() => {
  const r = registry.sweep();
  if (r.frozen || r.deleted) console.log(`[sweep] frozen=${r.frozen} deleted=${r.deleted}`);
}, SWEEP_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] public base: ${PUBLIC_BASE_URL}${BASE_PATH ? ` (path prefix: ${BASE_PATH})` : ''}`);
  console.log(`[server] draw.io editor proxied at ${BASE_PATH || ''}/ -> ${DRAWIO_URL}`);
  console.log(`[server] MCP user endpoint: ${PUBLIC_BASE_URL}/mcp | dev endpoint: ${PUBLIC_BASE_URL}/mcp-dev`);
  console.log(`[server] lifecycle: hot ${HOT_TTL_MS / 60000}min -> cold ${COLD_TTL_MS / 3600000}h -> delete`);
});
