# umeko draw.io server

在一个 Docker Compose 里复合提供四类服务（Linux 原生容器，可在本机 Docker Desktop 运行 Linux 容器）：

```
浏览器/MCP 客户端
      │  http://localhost:3000
      ▼
┌───────────────────────────────────────────────────┐
│ server (Node.js)                                  │
│  /              → 反向代理 draw.io 原生编辑器       │
│  /node          → 入口页(输ID进画布/申请新节点)     │
│  /node/:id      → 节点页(左源码 + 右编辑器)         │
│  /api/*  /render→ 节点管理 / XML→PNG/SVG           │
│  /mcp           → MCP 用户态(全部工具需 nodeId)     │
│  /mcp-dev       → MCP 开发态(可列举所有节点)        │
│  /manage        → 管理面板(登录后可用)              │
│  /ws            → 节点页 <-> 服务器 实时通道        │
└──┬───────────────┬───────────────┬────────────────┘
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
| 节点入口页（申请/进入画布） | http://localhost:3000/node |
| draw.io 原生编辑器 | http://localhost:3000/ |
| 节点页 | http://localhost:3000/node/:id |
| 渲染服务 | `POST http://localhost:3000/render` |
| MCP 用户态 | http://localhost:3000/mcp |
| MCP 开发态 | http://localhost:3000/mcp-dev |
| 管理面板 | http://localhost:3000/manage |
| 调试直达编辑器 | http://localhost:8081/ |

## 节点与入口页

每个「节点」是一块独立画布，ID 为 12 位加密随机串（base64url）。入口页 `http://localhost:3000/node` 提供两个功能：

- **输入节点 ID 跳转**进入对应画布；
- **申请新节点 ID**——创建后把 ID 交给你的 agent（配合 MCP 地址）即可继续绘图；页面会在本浏览器 localStorage 里保留最近使用记录。

节点页 UI：左侧 XML 源码，右侧嵌入的完整 draw.io 编辑器。两侧**不自动同步**——点击「更新源码」才把编辑器内容取到左侧；另有「应用到编辑器」「检查错误」两个辅助按钮。源码面板支持拖动分隔条调宽（双击分隔条折叠）、点「« 源码」按钮折叠，折叠后点击左缘「源码 »」竖条展开；宽度与折叠状态保存在浏览器 localStorage。

## 节点生命周期

- 节点最后一次修改或访问后空闲 **30 分钟**自动转入**冷存储**（XML 落盘到 `./data/cold/`，从内存卸载）；
- 冷存储保留 **48 小时**，到期自动清理；
- 访问冷节点（打开节点页、调 API/MCP）会**自动解冻**回热状态，生命周期重新计时；
- 后台每 **30 秒**扫描一次；管理面板也可手动触发「立即清理」。

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
| POST | `/api/nodes` `{title?}` | 创建节点，返回 `nodeId`（12 位）和 `url` |
| GET | `/api/nodes/:id` | 单节点信息（不含列举全部，列举见管理面板） |
| GET | `/api/nodes/:id/xml` | 当前 XML（页面在线时实时从编辑器取回） |
| PUT | `/api/nodes/:id/xml` | 推送 XML（先校验，不合法返回 422 + 错误） |
| GET | `/api/nodes/:id/errors?deep=1` | 编译错误（deep 额外做真实渲染验证） |
| POST | `/api/validate` `{xml, deep?}` | 无状态校验任意 XML |
| DELETE | `/api/nodes/:id` | 删除节点 |

## MCP 接入

Streamable HTTP 传输，两个端点：

| 端点 | 定位 | 工具 |
| --- | --- | --- |
| `/mcp` | **用户态**（面向最终用户的 agent） | `create_node`、`delete_node`、`get_xml`、`set_xml`、`get_errors`、`render_diagram`——除 `create_node` 外**每项交互都必须传入 `nodeId`**，无法看到或触达其他人的节点 |
| `/mcp-dev` | **开发态**（自调试） | 上述全部 + `list_nodes`（列举所有节点及在线状态） |

客户端配置示例（用户态）：

```json
{
  "mcpServers": {
    "umeko-drawio": { "type": "http", "url": "http://localhost:3000/mcp" }
  }
}
```

工具一览：

| 工具 | 端点 | 说明 |
| --- | --- | --- |
| `create_node` | 两者 | 创建临时编辑器节点 → `{nodeId, url}`（在浏览器打开 url 即可看到节点页） |
| `get_xml` | 两者 | 获取节点当前 XML（页面在线则实时取自编辑器） |
| `set_xml` | 两者 | 校验并推送 XML 修改；不合法时不推送并返回编译错误 |
| `get_errors` | 两者 | 获取节点当前 XML 的编译错误（`deep=true` 做真实渲染验证） |
| `render_diagram` | 两者 | 渲染节点/任意 XML 为 png/svg，存到 `output/`，png 直接以图片返回 |
| `delete_node` | 两者 | 删除节点 |
| `list_nodes` | 仅 `/mcp-dev` | 列出全部节点及在线状态 |

典型流程：入口页申请节点（或 `create_node`）→ 把 nodeId 交给 agent → `set_xml` 推送图内容 → `get_xml` 取回 → `get_errors` 查错 → `render_diagram` 出图。

## 管理面板 `/manage`

浏览器打开 `http://localhost:3000/manage`，默认账号 `umeko`、密码 `1234`（可用环境变量覆盖）。登录后可：

- 查看**服务状态**：运行时长、Node 版本、生命周期配置、节点统计、存储占用（渲染产物 + 冷存储）、三个上游（drawio webapp / export-server / svg-exporter）的探活结果；
- 查看**所有节点**（热 + 冷存储）：ID、标题、状态、页面在线、大小、创建/最后访问时间；
- 查看任意节点的**当前 XML**；
- **管理节点**：手动冻结、解冻、删除，以及「立即清理」（冻结全部空闲节点 + 删除全部过期冷数据）来控制存储空间。

管理 API（需先 `POST /manage/login` 取得会话 Cookie）：`GET /manage/api/status`、`GET /manage/api/nodes`、`GET /manage/api/nodes/:id/xml`、`POST /manage/api/nodes/:id/freeze`、`POST /manage/api/nodes/:id/thaw`、`DELETE /manage/api/nodes/:id`、`POST /manage/api/cleanup`、`POST /manage/logout`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | server 监听端口 |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | 对外展示用基础地址（节点链接、MCP 地址） |
| `DRAWIO_URL` | `http://localhost:8081` | drawio webapp 上游地址（compose 内为 `http://drawio:8080`） |
| `OUTPUT_DIR` | `./output` | 渲染产物目录 |
| `DATA_DIR` | `./data` | 冷存储目录（`<DATA_DIR>/cold/*.xml`） |
| `NODE_HOT_MINUTES` | `30` | 节点空闲多少分钟后转冷存储 |
| `NODE_COLD_HOURS` | `48` | 冷存储保留多少小时后清理 |
| `SWEEP_INTERVAL_SECONDS` | `30` | 生命周期扫描间隔 |
| `ADMIN_USER` | `umeko` | 管理面板账号 |
| `ADMIN_PASSWORD` | `1234` | 管理面板密码（**生产部署务必修改**） |

以上均可在 `docker-compose.yml` 的 `environment` 中以 `${VAR:-默认}` 形式覆盖，例如：

```bash
ADMIN_PASSWORD=secret NODE_HOT_MINUTES=60 docker compose up -d
```

## 注意事项

- **安全**：`/mcp` 用户态不暴露节点列举，但知道 nodeId 即可操作对应节点——节点 ID 即凭证，勿泄露；`/mcp-dev` 与 `/manage` 仅应在内网/受信环境开放；生产部署务必修改 `ADMIN_PASSWORD`。
- **持久化**：热节点在内存中，**server 重启即丢失**；已冻结的冷节点以 XML 文件存于 `./data/cold/`（已挂载宿主机），重启后可解冻恢复。
- 推送/校验的 XML 支持 `<mxfile>`（可含多个 `<diagram>`）或裸 `<mxGraphModel>`，非压缩格式可做完整结构校验，压缩内容仅做语法校验。
- PNG/JPG 由官方 `jgraph/export-server` 渲染；SVG 由 `exporter/` 下自研脚本渲染（复用同镜像的 Chrome，驱动 embed 编辑器客户端导出，保证与编辑器效果一致）。
- PNG 导出如需额外字体（如特定中文字体），放入 `./fonts` 目录即可（挂载到导出服务的 `/usr/share/fonts/drawio`）。
- 渲染产物写入 `./output`（已挂载到宿主机），需自行定期清理；冷存储由生命周期自动清理。
