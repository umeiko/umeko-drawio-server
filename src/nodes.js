import { randomUUID } from 'node:crypto';

export const defaultDiagramXml = () =>
  `<mxfile host="embed"><diagram id="${randomUUID()}" name="Page-1">` +
  `<mxGraphModel dx="1024" dy="768" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" ` +
  `page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">` +
  `<root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;

export class NodeRegistry {
  constructor() {
    this.nodes = new Map();
  }

  create(title = '') {
    const id = randomUUID().slice(0, 8);
    const node = {
      id,
      title,
      createdAt: new Date().toISOString(),
      lastSeenAt: Date.now(),
      xml: defaultDiagramXml(),
      lastValidation: null,
      ws: null,
      pending: new Map(),
    };
    this.nodes.set(id, node);
    return node;
  }

  get(id) {
    return this.nodes.get(id);
  }

  delete(id) {
    const n = this.nodes.get(id);
    if (!n) return false;
    try {
      n.ws && n.ws.close(4000, 'node deleted');
    } catch {}
    this.nodes.delete(id);
    return true;
  }

  isConnected(n) {
    return !!n.ws && n.ws.readyState === 1;
  }

  list() {
    return [...this.nodes.values()].map((n) => ({
      id: n.id,
      title: n.title,
      createdAt: n.createdAt,
      connected: this.isConnected(n),
    }));
  }

  attachWs(node, ws) {
    if (node.ws && node.ws !== ws) {
      try {
        node.ws.close(4001, 'replaced by new connection');
      } catch {}
    }
    node.ws = ws;
    node.lastSeenAt = Date.now();
    ws.on('message', (raw) => this.onMessage(node, raw));
    ws.on('close', () => {
      if (node.ws === ws) node.ws = null;
    });
  }

  onMessage(node, raw) {
    node.lastSeenAt = Date.now();
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === 'xml') {
      if (typeof m.xml === 'string') node.xml = m.xml;
      if (m.requestId && node.pending.has(m.requestId)) {
        const p = node.pending.get(m.requestId);
        node.pending.delete(m.requestId);
        p.resolve(typeof m.xml === 'string' ? m.xml : '');
      }
    } else if (m.type === 'error') {
      node.lastValidation = {
        ok: false,
        errors: [String(m.message || 'editor error')],
        warnings: [],
        at: new Date().toISOString(),
        source: 'editor',
      };
    }
  }

  // 优先向打开着的页面实时取 XML；页面未连接时返回缓存
  getXml(node, timeoutMs = 8000) {
    const ws = node.ws;
    if (!ws || ws.readyState !== 1) return Promise.resolve({ xml: node.xml, source: 'cache' });
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        node.pending.delete(requestId);
        reject(new Error('等待编辑器响应超时'));
      }, timeoutMs);
      node.pending.set(requestId, {
        resolve: (xml) => {
          clearTimeout(timer);
          resolve({ xml, source: 'live' });
        },
      });
      try {
        ws.send(JSON.stringify({ type: 'getXml', requestId }));
      } catch (e) {
        clearTimeout(timer);
        node.pending.delete(requestId);
        reject(e);
      }
    });
  }

  // 更新缓存并（在页面在线时）推送到页面
  setXml(node, xml) {
    node.xml = xml;
    node.lastSeenAt = Date.now();
    const pushed = this.isConnected(node);
    if (pushed) node.ws.send(JSON.stringify({ type: 'setXml', xml }));
    return pushed;
  }

  sweep(ttlMs) {
    const now = Date.now();
    for (const n of this.nodes.values()) {
      if (!this.isConnected(n) && now - n.lastSeenAt > ttlMs) this.delete(n.id);
    }
  }
}
