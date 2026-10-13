import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { NodeRegistry } from './nodes.js';
import { validateDiagramXml } from './validate.js';
import { renderDiagram } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DRAWIO_URL = (process.env.DRAWIO_URL || 'http://localhost:8081').replace(/\/$/, '');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');
const NODE_TTL_MS = Math.max(1, Number(process.env.NODE_TTL_HOURS || 24)) * 3600 * 1000;
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const registry = new NodeRegistry();
const app = express();
app.disable('x-powered-by');

const nodeUrl = (id) => `${PUBLIC_BASE_URL}/node/${id}`;
const notFound = (res) => res.status(404).json({ ok: false, error: 'node not found' });

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

// ---------- 基础 ----------

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api', (req, res) =>
  res.json({
    name: 'umeko drawio server',
    mcp: `${PUBLIC_BASE_URL}/mcp`,
    endpoints: {
      editor: `${PUBLIC_BASE_URL}/            # draw.io 原生编辑器（代理自 drawio 容器）`,
      nodePage: `${PUBLIC_BASE_URL}/node/:id   # 节点页：左侧源码 + 右侧嵌入编辑器`,
      createNode: `POST /api/nodes {title?}`,
      listNodes: `GET /api/nodes`,
      getXml: `GET /api/nodes/:id/xml`,
      pushXml: `PUT /api/nodes/:id/xml (body 为 XML 文本)`,
      getErrors: `GET /api/nodes/:id/errors?deep=1`,
      validate: `POST /api/validate {xml, deep?}`,
      render: `POST /render {xml, format: png|svg, scale?, background?}`,
      mcp: `POST ${PUBLIC_BASE_URL}/mcp (MCP Streamable HTTP)`,
    },
  }),
);

// ---------- 节点 REST API ----------

app.use('/api', express.json({ limit: '10mb' }));

app.post('/api/nodes', (req, res) => {
  const node = registry.create(String((req.body && req.body.title) || ''));
  res.json({ ok: true, nodeId: node.id, url: nodeUrl(node.id) });
});

app.get('/api/nodes', (req, res) =>
  res.json({ ok: true, nodes: registry.list().map((n) => ({ ...n, url: nodeUrl(n.id) })) }),
);

app.get('/api/nodes/:id', (req, res) => {
  const n = registry.get(req.params.id);
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

app.delete('/api/nodes/:id', (req, res) => {
  if (!registry.delete(req.params.id)) return notFound(res);
  res.json({ ok: true });
});

app.get('/api/nodes/:id/xml', async (req, res) => {
  const n = registry.get(req.params.id);
  if (!n) return notFound(res);
  try {
    const { xml } = await registry.getXml(n, 8000);
    res.type('application/xml').send(xml);
  } catch {
    res.type('application/xml').send(n.xml);
  }
});

app.put('/api/nodes/:id/xml', express.text({ type: () => true, limit: '25mb' }), (req, res) => {
  const n = registry.get(req.params.id);
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

app.get('/api/nodes/:id/errors', async (req, res) => {
  const n = registry.get(req.params.id);
  if (!n) return notFound(res);
  const deep = req.query.deep === '1' || req.query.deep === 'true';
  res.json(await checkNode(n, deep));
});

app.post('/api/validate', async (req, res) => {
  const xml = String((req.body && req.body.xml) ?? '');
  res.json(await validateDeep(xml, !!(req.body && req.body.deep)));
});

// ---------- XML -> PNG/SVG 渲染服务 ----------

app.post('/render', express.json({ limit: '25mb' }), async (req, res) => {
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

// ---------- 节点页（自有 UI：左侧源码 + 右侧嵌入 draw.io） ----------

app.get('/node/:id', (req, res) => {
  if (!registry.get(req.params.id)) return res.status(404).send('node not found');
  res.sendFile(path.join(__dirname, '..', 'public', 'node.html'));
});

// ---------- MCP (Streamable HTTP) ----------

function createMcpServer() {
  const mcp = new McpServer({ name: 'umeko-drawio', version: '0.1.0' });
  const ok = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
  const bad = (msg, extra = {}) => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) }],
    isError: true,
  });

  mcp.registerTool(
    'create_node',
    {
      title: '创建 draw.io 编辑器节点',
      description:
        '创建一个临时 draw.io 编辑器节点，返回 nodeId 和可在浏览器打开的 URL。页面左侧为 XML 源码，右侧为完整的 draw.io 嵌入编辑器。',
      inputSchema: { title: z.string().optional() },
    },
    async ({ title }) => {
      const n = registry.create(title || '');
      return ok({ ok: true, nodeId: n.id, url: nodeUrl(n.id) });
    },
  );

  mcp.registerTool(
    'list_nodes',
    {
      title: '列出编辑器节点',
      description: '列出所有临时 draw.io 编辑器节点：id、标题、创建时间、页面是否在线、URL。',
      inputSchema: {},
    },
    async () => ok({ ok: true, nodes: registry.list().map((n) => ({ ...n, url: nodeUrl(n.id) })) }),
  );

  mcp.registerTool(
    'delete_node',
    {
      title: '删除编辑器节点',
      description: '删除一个临时 draw.io 编辑器节点，并断开其页面连接。',
      inputSchema: { nodeId: z.string() },
    },
    async ({ nodeId }) => {
      if (!registry.delete(nodeId)) return bad('node not found');
      return ok({ ok: true });
    },
  );

  mcp.registerTool(
    'get_xml',
    {
      title: '获取节点当前 XML',
      description:
        '获取节点当前图形的 draw.io XML。若节点页面已在浏览器打开，则实时从编辑器取回（source=live）；否则返回服务器缓存（source=cache）。',
      inputSchema: { nodeId: z.string() },
    },
    async ({ nodeId }) => {
      const n = registry.get(nodeId);
      if (!n) return bad('node not found');
      try {
        const { xml, source } = await registry.getXml(n, 10000);
        return ok({ ok: true, source, xml });
      } catch (e) {
        return ok({ ok: true, source: 'cache', note: `实时获取失败(${e.message})，已返回缓存`, xml: n.xml });
      }
    },
  );

  mcp.registerTool(
    'set_xml',
    {
      title: '推送 XML 修改到节点',
      description:
        '校验并推送 draw.io XML 到节点：页面在线则实时载入右侧编辑器，离线则缓存待打开时加载。XML 不合法时不推送，返回编译错误列表。',
      inputSchema: { nodeId: z.string(), xml: z.string() },
    },
    async ({ nodeId, xml }) => {
      const n = registry.get(nodeId);
      if (!n) return bad('node not found');
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
        warnings: v.warnings,
        note: pushed ? '已推送到打开的编辑器页面' : '页面未连接，已缓存，打开节点页后自动加载',
      });
    },
  );

  mcp.registerTool(
    'get_errors',
    {
      title: '获取节点 XML 编译错误',
      description:
        '对节点当前 XML 做“编译”检查：XML 语法 + mxGraph 结构校验；deep=true 时额外调用渲染服务做真实编译验证。无错误时 errors 为空数组。',
      inputSchema: { nodeId: z.string(), deep: z.boolean().optional() },
    },
    async ({ nodeId, deep }) => {
      const n = registry.get(nodeId);
      if (!n) return bad('node not found');
      return ok(await checkNode(n, !!deep));
    },
  );

  mcp.registerTool(
    'render_diagram',
    {
      title: '渲染为 PNG/SVG',
      description:
        '把节点当前 XML（或直接传入的 xml）渲染成 png/svg，文件保存到服务器 output 目录；png 会同时以图片内容返回。',
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
        const n = registry.get(nodeId);
        if (!n) return bad('node not found');
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
        const blocks = [
          { type: 'text', text: JSON.stringify({ ok: true, file, via, bytes: buffer.length }, null, 2) },
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

  return mcp;
}

const mcp = createMcpServer();
const transports = Object.create(null);

app.post('/mcp', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? transports[sid] : undefined;
    if (!transport) {
      if (sid) {
        return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown session' }, id: null });
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[mcp]', e);
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e) });
  }
});

const mcpSession = async (req, res) => {
  const t = transports[req.headers['mcp-session-id']];
  if (!t) return res.status(404).json({ error: 'unknown session' });
  await t.handleRequest(req, res);
};
app.get('/mcp', mcpSession);
app.delete('/mcp', mcpSession);

// ---------- draw.io 原生编辑器（反向代理到 drawio 容器，挂在根路径） ----------

app.use(
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

// ---------- HTTP + WebSocket ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (u.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const node = registry.get(u.searchParams.get('node') || '');
    if (!node) {
      ws.close(4404, 'node not found');
      return;
    }
    registry.attachWs(node, ws);
    ws.send(JSON.stringify({ type: 'hello', nodeId: node.id }));
  });
});

setInterval(() => registry.sweep(NODE_TTL_MS), 3600 * 1000).unref();

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] draw.io editor proxied at / -> ${DRAWIO_URL}`);
  console.log(`[server] MCP endpoint: ${PUBLIC_BASE_URL}/mcp`);
});
