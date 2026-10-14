import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 12 位加密随机 ID（base64url），不可枚举，同时仍可手动转抄
const newId = () => randomBytes(9).toString('base64url');

export const defaultDiagramXml = () =>
  `<mxfile host="embed"><diagram id="${newId()}" name="Page-1">` +
  `<mxGraphModel dx="1024" dy="768" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" ` +
  `page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">` +
  `<root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;

export class NodeRegistry {
  // hotTtlMs：无修改/访问多久后转冷存储；coldTtlMs：冷存储保留多久后清理
  constructor({ coldDir, hotTtlMs, coldTtlMs }) {
    this.nodes = new Map();
    this.coldDir = coldDir;
    this.hotTtlMs = hotTtlMs;
    this.coldTtlMs = coldTtlMs;
    fs.mkdirSync(coldDir, { recursive: true });
  }

  coldFile(id) {
    return path.join(this.coldDir, `${id}.json`);
  }

  touch(n) {
    n.lastSeenAt = Date.now();
  }

  create(title = '') {
    const id = newId();
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

  // 仅查热节点，不改变生命周期（管理面板用）
  get(id) {
    return this.nodes.get(id);
  }

  // 用户访问入口：热节点直接返回并续期；冷节点解冻回热
  resolve(id) {
    const n = this.nodes.get(id);
    if (n) {
      this.touch(n);
      return n;
    }
    return this.thaw(id);
  }

  thaw(id) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.coldFile(id), 'utf8'));
      fs.unlinkSync(this.coldFile(id));
    } catch {
      return null;
    }
    const node = {
      id: data.id,
      title: data.title || '',
      createdAt: data.createdAt,
      lastSeenAt: Date.now(),
      xml: data.xml,
      lastValidation: data.lastValidation || null,
      ws: null,
      pending: new Map(),
    };
    this.nodes.set(node.id, node);
    return node;
  }

  freeze(id) {
    const n = this.nodes.get(id);
    if (!n) return false;
    try {
      n.ws && n.ws.close(4002, 'node frozen (idle)');
    } catch {}
    const data = {
      id: n.id,
      title: n.title,
      createdAt: n.createdAt,
      lastSeenAt: n.lastSeenAt,
      xml: n.xml,
      lastValidation: n.lastValidation,
    };
    try {
      fs.writeFileSync(this.coldFile(id), JSON.stringify(data));
    } catch {
      return false;
    }
    this.nodes.delete(id);
    return true;
  }

  delete(id) {
    let ok = false;
    const n = this.nodes.get(id);
    if (n) {
      try {
        n.ws && n.ws.close(4000, 'node deleted');
      } catch {}
      this.nodes.delete(id);
      ok = true;
    }
    try {
      if (fs.existsSync(this.coldFile(id))) {
        fs.unlinkSync(this.coldFile(id));
        ok = true;
      }
    } catch {}
    return ok;
  }

  // 读取 XML 但不改变生命周期（管理面板查看用）
  peekXml(id) {
    const n = this.nodes.get(id);
    if (n) return n.xml;
    try {
      return JSON.parse(fs.readFileSync(this.coldFile(id), 'utf8')).xml;
    } catch {
      return null;
    }
  }

  isConnected(n) {
    return !!n.ws && n.ws.readyState === 1;
  }

  list() {
    const hot = [...this.nodes.values()].map((n) => ({
      id: n.id,
      title: n.title,
      state: 'hot',
      createdAt: n.createdAt,
      lastSeenAt: new Date(n.lastSeenAt).toISOString(),
      connected: this.isConnected(n),
      bytes: Buffer.byteLength(n.xml || ''),
    }));
    let cold = [];
    try {
      cold = fs
        .readdirSync(this.coldDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const p = path.join(this.coldDir, f);
          try {
            const d = JSON.parse(fs.readFileSync(p, 'utf8'));
            const st = fs.statSync(p);
            return {
              id: d.id,
              title: d.title || '',
              state: 'cold',
              createdAt: d.createdAt,
              lastSeenAt: new Date(d.lastSeenAt).toISOString(),
              connected: false,
              bytes: st.size,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {}
    return [...hot, ...cold];
  }

  // 空闲热节点转冷；过期冷节点清理。返回 {frozen, deleted}
  sweep() {
    const now = Date.now();
    let frozen = 0;
    let deleted = 0;
    for (const n of [...this.nodes.values()]) {
      if (!this.isConnected(n) && now - n.lastSeenAt > this.hotTtlMs) {
        if (this.freeze(n.id)) frozen++;
      }
    }
    try {
      for (const f of fs.readdirSync(this.coldDir)) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(this.coldDir, f);
        let ts;
        try {
          ts = JSON.parse(fs.readFileSync(p, 'utf8')).lastSeenAt;
        } catch {
          ts = fs.statSync(p).mtimeMs;
        }
        if (now - ts > this.coldTtlMs) {
          try {
            fs.unlinkSync(p);
            deleted++;
          } catch {}
        }
      }
    } catch {}
    return { frozen, deleted };
  }

  attachWs(node, ws) {
    if (node.ws && node.ws !== ws) {
      try {
        node.ws.close(4001, 'replaced by new connection');
      } catch {}
    }
    node.ws = ws;
    this.touch(node);
    ws.on('message', (raw) => this.onMessage(node, raw));
    ws.on('close', () => {
      if (node.ws === ws) node.ws = null;
    });
  }

  onMessage(node, raw) {
    this.touch(node);
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
    const requestId = newId() + newId();
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
    this.touch(node);
    const pushed = this.isConnected(node);
    if (pushed) node.ws.send(JSON.stringify({ type: 'setXml', xml }));
    return pushed;
  }
}
