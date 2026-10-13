# umeko draw.io server

在一个 Docker Compose 里复合提供四类服务（Linux 原生容器，可在本机 Docker Desktop 运行 Linux 容器）：

```
浏览器/MCP 客户端
      │  http://localhost:3000
      ▼
┌───────────────────────────────────────────────┐
│ server (Node.js)                              │
│  /              → 反向代理 draw.io 原生编辑器   │
│  /node/:id      → 节点页(左源码 + 右编辑器)     │
│  /api/*  /render→ 节点管理 / XML→PNG/SVG       │
│  /mcp           → MCP (Streamable HTTP)       │
│  /ws            → 节点页 <-> 服务器 实时通道    │
└──┬───────────────┬───────────────┬────────────┘
   │ :8080         │ :8000         │ :8001
   ▼               ▼               ▼
┌────────┐  ┌──────────────┐  ┌─────────────────┐
│ drawio │  │export-server │  │ svg-exporter    │
│ webapp │  │ PNG/JPG/PDF  │  │ SVG(自研脚本,    │
│        │  │ (Puppeteer)  │  │ 复用同镜像+Chrome)│
└────────┘  └──────────────┘  └─────────────────┘
```

> 全内网：`export-server` 通过 `DRAWIO_BASE_URL=http://drawio:8080` 强制走内网 webapp（其默认是公网 `viewer.diagrams.net`）；`svg-exporter` 直接驱动内网编辑器。整条链路无任何外联请求。

## 快速开始

```bash
docker compose up -d --build
```

首次启动会拉取 `jgraph/drawio`（约 1GB，内含 Tomcat + Chrome + Puppeteer 导出服务）。

| 服务 | 地址 |
| --- | --- |
| draw.io 原生编辑器 | http://localhost:3000/ |
| 节点页 | http://localhost:3000/node/:id |
| 渲染服务 | `POST http://localhost:3000/render` |
| MCP | http://localhost:3000/mcp |
| 调试直达编辑器 | http://localhost:8081/ |

## XML 渲染 PNG/SVG

```bash
curl -X POST http://localhost:3000/render \
  -H 'Content-Type: application/json' \
  -d '{"xml": "<mxfile>...</mxfile>", "format": "svg"}' -o out.svg
```

`format` 支持 `png` / `svg`；可选 `scale`、`background`。XML 不合法时返回 `422` 与编译错误列表。

## 节点 REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/nodes` `{title?}` | 创建临时节点，返回 `nodeId` 和 `url` |
| GET | `/api/nodes` | 节点列表 |
| GET | `/api/nodes/:id/xml` | 当前 XML（页面在线时实时从编辑器取回） |
| PUT | `/api/nodes/:id/xml` | 推送 XML（先校验，不合法返回 422 + 错误） |
| GET | `/api/nodes/:id/errors?deep=1` | 编译错误（deep 额外做真实渲染验证） |
| POST | `/api/validate` `{xml, deep?}` | 无状态校验任意 XML |
| DELETE | `/api/nodes/:id` | 删除节点 |

节点页 UI：左侧 XML 源码，右侧嵌入的完整 draw.io 编辑器。两侧**不自动同步**——点击「更新源码」才把编辑器内容取到左侧；另有「应用到编辑器」「检查错误」两个辅助按钮。

## MCP 接入

Streamable HTTP 传输，端点 `http://localhost:3000/mcp`。客户端配置示例：

```json
{
  "mcpServers": {
    "umeko-drawio": { "type": "http", "url": "http://localhost:3000/mcp" }
  }
}
```

工具一览：

| 工具 | 说明 |
| --- | --- |
| `create_node` | 创建临时编辑器节点 → `{nodeId, url}`（在浏览器打开 url 即可看到节点页） |
| `list_nodes` | 列出节点及在线状态 |
| `delete_node` | 删除节点 |
| `get_xml` | 获取节点当前 XML（页面在线则实时取自编辑器） |
| `set_xml` | 校验并推送 XML 修改；不合法时不推送并返回编译错误 |
| `get_errors` | 获取节点当前 XML 的编译错误（`deep=true` 做真实渲染验证） |
| `render_diagram` | 渲染节点/任意 XML 为 png/svg，存到 `output/`，png 直接以图片返回 |

典型流程：`create_node` → 打开 URL → `set_xml` 推送图内容 → `get_xml` 取回 → `get_errors` 查错 → `render_diagram` 出图。

## 备注

- 节点保存在内存中，服务重启即丢失；空闲超过 `NODE_TTL_HOURS`（默认 24h）自动清理。
- 渲染产物写入 `./output`（已挂载到宿主机）。
- 推送/校验的 XML 支持 `<mxfile>`（可含多个 `<diagram>`）或裸 `<mxGraphModel>`，非压缩格式可做完整结构校验，压缩内容仅做语法校验。
- PNG/JPG 由官方 `jgraph/export-server` 渲染；SVG 由 `exporter/` 下自研脚本渲染（复用同镜像的 Chrome，驱动 embed 编辑器客户端导出，保证与编辑器效果一致）。
- PNG 导出如需额外字体（如特定中文字体），放入 `./fonts` 目录即可（挂载到导出服务的 `/usr/share/fonts/drawio`）。
