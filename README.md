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

## 部署方式

三种方式任选其一，对外能力完全一致。

### A. Docker Compose（推荐，分容器）

```bash
bash deploy/get-fonts.sh   # 下载方正兰亭黑字体（授权资产不入 git，见「自定义字体」一节）
docker compose up -d --build
```

首次启动会拉取 `jgraph/drawio`（约 1GB，内含 Tomcat + Chrome + Puppeteer 导出服务）。

### B. all-in-one 单容器

四个组件（drawio webapp / export-server / svg-exporter / 主服务）打包进一个镜像，适合只想跑一个容器的场景：

```bash
docker build -f Dockerfile.allinone -t umeko-drawio-server .
docker run -d --name drawio \
  -p 3000:3000 \
  -v "$PWD/output:/app/output" \
  -v "$PWD/data:/app/data" \
  -v "$PWD/fonts:/usr/share/fonts/drawio:ro" `# 可选：自定义字体` \
  umeko-drawio-server
```

容器内由 `deploy/entrypoint.sh` 编排四个进程（Tomcat 启动较慢，首次就绪约 10~30 秒，健康检查通过前请稍候）。所有环境变量与 compose 方式相同，用 `-e NODE_TRANSPORT=sse` 等方式传入。

### C. 裸机 Linux（不依赖 Docker）

Debian/Ubuntu 一键安装（OpenJDK + Tomcat + draw.war + Chromium + Node.js 全部落本机）：

```bash
sudo bash deploy/install-linux.sh
```

完成后按提示用 `start.sh`（前台/调试）、`nohup` 或 systemd 单元启动。裸机模式下 PNG/SVG 都由本仓库的导出器（embed 协议无头导出）承担。可用环境变量覆盖：`INSTALL_DIR`、`PORT`、`DRAWIO_VERSION`、`TOMCAT_VERSION`、`NODE_MAJOR`、`CHROME_BIN`。Ubuntu 服务器版若 Chromium 只能走 snap，请自行安装 Chrome 后以 `CHROME_BIN=/path/to/chrome` 重跑。

## 服务地址

| 服务 | 地址 |
| --- | --- |
| 节点入口页（申请/进入画布） | http://localhost:3000/node |
| draw.io 原生编辑器 | http://localhost:3000/ |
| 节点页 | http://localhost:3000/node/:id |
| 渲染服务 | `POST http://localhost:3000/render` |
| 渲染产物下载 | http://localhost:3000/output/`<file>` |
| MCP 用户态 | http://localhost:3000/mcp |
| MCP 开发态 | http://localhost:3000/mcp-dev |
| 管理面板 | http://localhost:3000/manage |
| 调试直达编辑器 | http://localhost:8081/ （仅 compose 方式） |

## 节点与入口页

每个「节点」是一块独立画布，ID 为 12 位加密随机串（base64url）。入口页 `http://localhost:3000/node` 提供两个功能：

- **输入节点 ID 进入画布**——在当前页**内嵌打开**画布，地址栏链接保持不变（适配不支持跳转新链接的在线工具）；
- **申请新节点 ID**——创建后把 ID 交给你的 agent（配合 MCP 地址）即可继续绘图；「打开画布」同样内嵌打开。

直链 `http://localhost:3000/node/:id` 依旧合法：页面上每个节点都有「新标签页打开 ↗」入口，直接访问该链接也能进入画布。内嵌视图中按 `Esc` 或点「← 返回」回到入口页。页面会在本浏览器 localStorage 里保留最近使用记录（点击 ID 内嵌打开，点 ↗ 新标签页打开）。

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
| `/mcp` | **用户态**（面向最终用户的 agent） | `delete_node`、`get_xml`、`set_xml`、`push_to_editor`、`get_errors`、`render_diagram`——**每项交互都必须传入 `nodeId`**，无法看到或触达其他人的节点；节点由用户在 `/node` 入口页手动申请 |
| `/mcp-dev` | **开发态**（自调试） | 上述全部 + `create_node`（编程建节点）、`list_nodes`（列举所有节点及在线状态） |

同一端点支持**多客户端并发连接**：每个 MCP 会话独立创建 server 实例，互不影响。

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
| `create_node` | 仅 `/mcp-dev` | 创建临时编辑器节点 → `{nodeId, url}`（在浏览器打开 url 即可看到节点页）；正式环境请引导用户在 `/node` 入口页手动申请 |
| `get_xml` | 两者 | 获取节点当前 XML（页面在线则实时取自编辑器） |
| `set_xml` | 两者 | 校验并推送 XML 修改，返回 `{ok, pushed, nodeId, ...}`；不合法时不推送并返回编译错误 |
| `push_to_editor` | 两者 | `set_xml` 的平台画布交互别名：推送 XML 到打开的编辑器画布，返回 `{ok, pushed, nodeId}`——`pushed=true` 表示页面在线实时接收 |
| `get_errors` | 两者 | 获取节点当前 XML 的编译错误（`deep=true` 做真实渲染验证） |
| `render_diagram` | 两者 | 渲染节点/任意 XML 为 png/svg，存到 `output/`，png 直接以图片返回 |
| `delete_node` | 两者 | 删除节点 |
| `list_nodes` | 仅 `/mcp-dev` | 列出全部节点及在线状态 |

典型流程：用户在 `/node` 入口页申请节点 → 把 nodeId 交给 agent → `set_xml`/`push_to_editor` 推送图内容 → `get_xml` 取回 → `get_errors` 查错 → `render_diagram` 出图。

### 平台集成端点

- **`/widgets.json`**：静态直出的平台 widget 声明（画布 widget + `tools_allow` 工具白名单）。默认内容见 `public/widgets.json`，schema 需要调整时直接挂载覆盖该文件即可（compose：`-v "$PWD/widgets.json:/app/public/widgets.json:ro"`）。
- **`/skills-mcp`（可选）**：平台技能工具的独立 MCP 端点。设置 `SKILLS_MCP_MODULE=/path/to/tools.mjs` 后自动挂载（路径可用 `SKILLS_MCP_PATH` 改）；模块需导出 `register(mcp, ctx)`，在其中 `mcp.registerTool(...)` 注册自定义工具，`ctx = { registry, validateDiagramXml, renderDiagram, PUBLIC_BASE_URL }`。每个会话独立实例，工具名不会与 `/mcp`、`/mcp-dev` 冲突。
- **`/editor`**：302 重定向到 `/node`，兼容指向 `/editor` 的旧链接与平台配置。

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
| `UMEKO_DRAWIO_SERVER_BASE_URL` | 空 | **显式指定完整对外基础地址**（优先级最高），可含路径前缀，如 `https://example.com/drawio`；设置后整站（页面/API/MCP/WS/编辑器代理）挂载到该前缀下 |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | 对外基础地址（`UMEKO_DRAWIO_SERVER_BASE_URL` 未设置时生效），同样支持路径前缀 |
| `DRAWIO_URL` | `http://localhost:8081` | drawio webapp 上游地址（compose 内为 `http://drawio:8080`） |
| `OUTPUT_DIR` | `./output` | 渲染产物目录 |
| `DATA_DIR` | `./data` | 冷存储目录（`<DATA_DIR>/cold/*.xml`） |
| `NODE_HOT_MINUTES` | `30` | 节点空闲多少分钟后转冷存储 |
| `NODE_COLD_HOURS` | `48` | 冷存储保留多少小时后清理 |
| `SWEEP_INTERVAL_SECONDS` | `30` | 生命周期扫描间隔 |
| `ADMIN_USER` | `umeko` | 管理面板账号 |
| `ADMIN_PASSWORD` | `1234` | 管理面板密码（**生产部署务必修改**） |
| `NODE_TRANSPORT` | `auto` | 节点页实时通道：`auto`（WebSocket 优先，连不上自动降级 SSE）、`ws`（仅 WebSocket）、`sse`（仅 SSE，用于不支持 WebSocket 的 ALB） |

以上均可在 `docker-compose.yml` 的 `environment` 中以 `${VAR:-默认}` 形式覆盖，例如：

```bash
ADMIN_PASSWORD=secret NODE_HOT_MINUTES=60 docker compose up -d
```

### ALB 路径前缀部署

ALB 按路径转发（如 `https://example.com/drawio/*` → 本服务，且**不剥离前缀**）时：

```bash
UMEKO_DRAWIO_SERVER_BASE_URL=https://example.com/drawio docker compose up -d
```

- 整站自动挂载到 `/drawio` 前缀：`https://example.com/drawio/node`（入口页）、`.../drawio/mcp`、`.../drawio/manage` 等；API 返回的节点链接、MCP 工具返回的 URL 均自动带前缀；
- 管理面板会话 Cookie 的 `Path`、节点页 WebSocket 路径同样随前缀调整；
- 根路径 `/healthz` 始终保留在前缀之外，可直接作为 ALB 目标组健康检查路径；访问裸 `/` 或裸 `/drawio` 会 302 到 `/drawio/`；
- 前提：ALB **不剥离**前缀（AWS ALB 默认行为）；若网关会剥离前缀，保持该变量不带路径即可（如 `https://example.com`）。

### 不支持 WebSocket 的 ALB

节点页与服务器之间的实时通道默认用 WebSocket；部分 ALB/网关不支持 WS 升级时，可切换为 SSE（Server-Sent Events）实现——下行是普通 HTTP 长响应（`GET /api/nodes/:id/events`），上行走普通 POST（`/api/nodes/:id/report`），任何 HTTP 负载均衡都支持：

```bash
NODE_TRANSPORT=sse docker compose up -d
```

- `NODE_TRANSPORT=auto`（默认）：节点页先试 WebSocket，3 秒未连通自动降级 SSE，无需配置即可穿透两种网络环境；
- 单个页面也可用 URL 参数强制：`/node/:id?transport=sse` 或 `?transport=ws`；
- SSE 流带 25 秒心跳（低于 ALB 默认 60s 空闲超时）和 `X-Accel-Buffering: no` 反缓冲头；
- 两种传输功能完全一致（推送 XML、实时取回、在线状态），管理面板「页面在线」列会显示当前传输方式（WS/SSE）。

## 自定义字体（方正兰亭黑）

项目内置接入**方正兰亭黑简体**（公司正式授权字体）。字体文件是授权资产，**不入 git 仓库**，由各部署形态在部署时拉取或本地放入：

```bash
bash deploy/get-fonts.sh   # 下载到 fonts/FZLanTingHeiS-R-GB.ttf（幂等；离线环境手动放文件到 fonts/ 即可）
```

接入效果（三种部署形态一致）：

- 编辑器字体菜单出现「方正兰亭黑简体」；XML 里写 `fontFamily=方正兰亭黑简体` 或 `fontFamily=FZLanTingHeiS-R-GB` 均可；
- 浏览器侧通过 webfont 加载（编辑器 `DRAWIO_CONFIG.customFonts` 注册，字体经主服务 `/fonts/` 直出）；
- PNG/SVG 导出侧：导出器的无头 Chrome 既加载 webfont，也把 ttf 装进了 fontconfig 兜底，服务端渲染不缺字形。

各形态的具体接线：

- **compose**：`docker-compose.yml` 给 drawio 容器传 `DRAWIO_CONFIG`（镜像 entrypoint 原生支持，写入 PreConfig.js），并把 `./fonts` 挂载进 webapp、export-server、svg-exporter 与主服务；
- **all-in-one**：构建时 `COPY fonts/` 进镜像；构建时没下载的话，容器启动时会尝试在线补下载（内网离线可 `-v "$PWD/fonts:/app/fonts"` 挂载覆盖）；`entrypoint.sh` 负责 `fc-cache` 和向 PreConfig.js 注入配置；
- **裸机**：`install-linux.sh` 自动调 `get-fonts.sh`，装入 `/usr/share/fonts/drawio` 并 `fc-cache`，每次启动时同步到 webapp 目录并注入 `DRAWIO_CONFIG`。

要换成其它字体：替换 `fonts/` 下的文件并修改 `deploy/drawio-config.json` 里的 `fontFamily`/`fontUrl`（compose 还需同步改 yml 里的 `DRAWIO_CONFIG`）。

## 注意事项

- **安全**：`/mcp` 用户态不暴露节点列举，但知道 nodeId 即可操作对应节点——节点 ID 即凭证，勿泄露；`/mcp-dev` 与 `/manage` 仅应在内网/受信环境开放；生产部署务必修改 `ADMIN_PASSWORD`。
- **持久化**：热节点在内存中，**server 重启即丢失**；已冻结的冷节点以 XML 文件存于 `./data/cold/`（已挂载宿主机），重启后可解冻恢复。
- 推送/校验的 XML 支持 `<mxfile>`（可含多个 `<diagram>`）或裸 `<mxGraphModel>`，非压缩格式可做完整结构校验，压缩内容仅做语法校验。
- PNG/JPG 默认由官方 `jgraph/export-server` 渲染（compose / all-in-one）；`exporter/` 下自研脚本（embed 协议无头导出）渲染 SVG，同时**也支持 PNG/JPG**——裸机 Linux 模式下用它渲染全部格式，可不依赖官方导出服务。
- PNG 导出如需额外字体（如特定中文字体），放入 `./fonts` 目录即可（挂载到导出服务的 `/usr/share/fonts/drawio`；裸机模式已装 `fonts-noto-cjk`）。方正兰亭黑已内置接入，见「自定义字体」一节。
- 渲染产物写入 `./output`（挂载到宿主机），可直接通过 `http://localhost:3000/output/<文件名>` 下载；MCP `render_diagram` 返回结果中带 `url` 字段。产物需自行定期清理；冷存储由生命周期自动清理。
- **内网拉不到 drawio 镜像时**：可把 drawio webapp 的静态文件（draw.war 解压内容）放到本机目录，设 `DRAWIO_STATIC_DIR=/path/to/webapp` 后根路径改为 `express.static` 直出，不再反向代理 drawio 容器；管理面板的上游状态会显示为 `static` 模式。注意纯静态直出缺少 webapp 的 `/export` 服务端，PNG/SVG 渲染需走本仓库的 svg-exporter（embed 协议无头导出，不依赖 webapp 服务端），并把 svg-exporter 的 `DRAWIO_URL` 指向主服务自身（如 `http://server:3000`），让无头 Chrome 从静态直出的页面加载编辑器。
