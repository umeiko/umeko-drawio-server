#!/usr/bin/env bash
# 裸机 Linux（Debian/Ubuntu）部署 umeko drawio server —— 不依赖 Docker
# 组件：OpenJDK 17 + Tomcat 9(draw.war) + Chromium + Node.js + 本仓库 server/exporter
# 用法：在仓库根目录执行  sudo bash deploy/install-linux.sh
# 可选环境变量：INSTALL_DIR PORT DRAWIO_VERSION TOMCAT_VERSION NODE_MAJOR CHROME_BIN
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/umeko-drawio}"
PORT="${PORT:-3000}"
DRAWIO_VERSION="${DRAWIO_VERSION:-v32.4.1}"
TOMCAT_VERSION="${TOMCAT_VERSION:-9.0.122}"
NODE_MAJOR="${NODE_MAJOR:-22}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { echo -e "\033[1;34m[install]\033[0m $*"; }
die() { echo -e "\033[1;31m[install] ERROR:\033[0m $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "需要 root 运行（sudo bash deploy/install-linux.sh）"
command -v apt-get >/dev/null || die "仅支持 Debian/Ubuntu（需要 apt-get）；其它发行版请参照本脚本手动安装"

# ---------- 1. 系统依赖 ----------
say "安装系统依赖（OpenJDK 17 / Chromium / 中文字体 ...）"
export DEBIAN_FRONTEND=noninteractive

# apt 下载可能因网络抖动失败，统一重试 3 次
apt_retry() {
  local n=0
  until apt-get install -y -qq "$@"; do
    n=$((n + 1))
    [ "$n" -ge 3 ] && return 1
    say "apt 安装失败，重试第 $n 次: $*"
    apt-get update -qq || true
    sleep 3
  done
}

apt-get update -qq
apt_retry openjdk-17-jre-headless curl unzip fontconfig fonts-noto-cjk ca-certificates gnupg

if [ -z "${CHROME_BIN:-}" ]; then
  if apt_retry chromium; then
    CHROME_BIN="$(command -v chromium)"
  elif apt_retry chromium-browser && command -v chromium-browser >/dev/null; then
    CHROME_BIN="$(command -v chromium-browser)"
  else
    die "未能安装 Chromium（可能是网络问题，可重跑重试）。也可手动安装 Chrome/Chromium 后用 CHROME_BIN=/path/to/chrome 重跑"
  fi
fi
say "Chromium: $CHROME_BIN"

# ---------- 2. Node.js ----------
if ! command -v node >/dev/null || [ "$(node -e 'console.log(parseInt(process.version.slice(1)))')" -lt 20 ]; then
  say "安装 Node.js $NODE_MAJOR（NodeSource）"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
say "Node.js: $(node -v)"

# ---------- 3. Tomcat + drawio webapp ----------
say "下载 Tomcat $TOMCAT_VERSION 与 draw.war $DRAWIO_VERSION"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
if [ ! -d "tomcat" ]; then
  curl -fSL --retry 3 --retry-all-errors "https://archive.apache.org/dist/tomcat/tomcat-9/v${TOMCAT_VERSION}/bin/apache-tomcat-${TOMCAT_VERSION}.tar.gz" -o tomcat.tgz
  mkdir -p tomcat && tar -xzf tomcat.tgz -C tomcat --strip-components=1 && rm tomcat.tgz
fi
# drawio webapp 部署在根路径（去掉 Tomcat 自带的 ROOT 欢迎页与示例应用）
if [ -d "tomcat/webapps/draw" ] && [ ! -f "tomcat/webapps/ROOT.war" ]; then
  rm -rf tomcat/webapps/draw tomcat/webapps/ROOT
  mv tomcat/webapps/draw.war tomcat/webapps/ROOT.war
fi
if [ ! -f "tomcat/webapps/ROOT.war" ]; then
  curl -fSL --retry 3 --retry-all-errors "https://github.com/jgraph/drawio/releases/download/${DRAWIO_VERSION}/draw.war" -o tomcat/webapps/ROOT.war
fi
rm -rf tomcat/webapps/ROOT tomcat/webapps/docs tomcat/webapps/examples tomcat/webapps/host-manager tomcat/webapps/manager

# ---------- 3.5 自定义字体（方正兰亭黑，公司授权资产，不入 git） ----------
say "准备方正兰亭黑字体"
if ! bash "$REPO_ROOT/deploy/get-fonts.sh"; then
  echo "[install] WARN: 字体下载失败（离线环境可手动把 FZLanTingHeiS-R-GB.ttf 放入 fonts/ 后重跑）" >&2
fi
# 主服务默认 FONTS_DIR=<app>/../fonts 即 $INSTALL_DIR/app/fonts（server.js 位于 app/src 下）
mkdir -p "$INSTALL_DIR/app/fonts"
cp "$REPO_ROOT/fonts/"*.ttf "$INSTALL_DIR/app/fonts/" 2>/dev/null || true
if ls "$INSTALL_DIR/app/fonts/"*.ttf >/dev/null 2>&1; then
  mkdir -p /usr/share/fonts/drawio
  cp "$INSTALL_DIR/app/fonts/"*.ttf /usr/share/fonts/drawio/
  fc-cache -f >/dev/null 2>&1 || true
  say "字体已安装到 fontconfig: $(ls "$INSTALL_DIR/app/fonts/"*.ttf | xargs -n1 basename | tr '\n' ' ')"
fi
mkdir -p "$INSTALL_DIR/deploy"
cp "$REPO_ROOT/deploy/drawio-config.json" "$REPO_ROOT/deploy/patch-preconfig.sh" "$INSTALL_DIR/deploy/"

# ---------- 4. 主服务与导出器 ----------
say "安装主服务与导出器到 $INSTALL_DIR"
mkdir -p app exporter data output logs
cp -r "$REPO_ROOT/src" "$REPO_ROOT/public" "$REPO_ROOT/package.json" app/
[ -f "$REPO_ROOT/package-lock.json" ] && cp "$REPO_ROOT/package-lock.json" app/
( cd app && npm ci --omit=dev 2>/dev/null || npm install --omit=dev )

cp "$REPO_ROOT/exporter/svg-export.js" exporter/
( cd exporter && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install --omit=dev --no-fund --no-audit express puppeteer )

# ---------- 5. 启动/停止脚本 ----------
say "生成 start.sh / stop.sh / systemd unit"
cat > start.sh <<EOF
#!/usr/bin/env bash
# 启动全部组件（前台运行主服务；Ctrl-C 停止全部）
set -u
cd "$INSTALL_DIR"
export JAVA_HOME="\$(dirname "\$(dirname "\$(readlink -f "\$(command -v java)")")")"
export EXPORT_URL=http://127.0.0.1:8001/          # webapp 的 /export 转发到我们的导出器
export PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN"
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

pids=""
tomcat/bin/catalina.sh run >> "$INSTALL_DIR/logs/tomcat.log" 2>&1 & pids="\$pids \$!"

# 等 webapp 就绪
for _ in \$(seq 1 120); do
  curl -fsS -o /dev/null http://127.0.0.1:8080/index.html 2>/dev/null && break
  sleep 1
done

# webapp 就绪后（ROOT.war 已解压）注入自定义字体：webfont 文件 + DRAWIO_CONFIG
mkdir -p tomcat/webapps/ROOT/fonts
cp app/fonts/*.ttf tomcat/webapps/ROOT/fonts/ 2>/dev/null || true
bash deploy/patch-preconfig.sh tomcat/webapps/ROOT deploy/drawio-config.json || true

( cd exporter && PORT=8001 DRAWIO_URL=http://127.0.0.1:8080 exec node svg-export.js ) >> "$INSTALL_DIR/logs/exporter.log" 2>&1 & pids="\$pids \$!"

cd "$INSTALL_DIR/app"
PORT=$PORT \\
DRAWIO_URL=http://127.0.0.1:8080 \\
EXPORT_URLS=http://127.0.0.1:8001/ \\
SVG_EXPORT_URLS=http://127.0.0.1:8001/ \\
OUTPUT_DIR=$INSTALL_DIR/output \\
DATA_DIR=$INSTALL_DIR/data \\
PUBLIC_BASE_URL=\${PUBLIC_BASE_URL:-http://localhost:$PORT} \\
node src/server.js >> "$INSTALL_DIR/logs/server.log" 2>&1 &
SERVER_PID=\$!; pids="\$pids \$SERVER_PID"

echo \$pids > "$INSTALL_DIR/run.pids"
echo "[start] 全部组件已启动，日志见 $INSTALL_DIR/logs/"
trap 'kill \$pids 2>/dev/null' TERM INT
wait "\$SERVER_PID"
kill \$pids 2>/dev/null || true
EOF
chmod +x start.sh

cat > stop.sh <<EOF
#!/usr/bin/env bash
# 停止全部组件（优先用 start.sh 记录的 pid，其次按特征匹配）
if [ -f "$INSTALL_DIR/run.pids" ]; then
  kill \$(cat "$INSTALL_DIR/run.pids") 2>/dev/null || true
  rm -f "$INSTALL_DIR/run.pids"
fi
pkill -f 'node src/server.js' 2>/dev/null || true
pkill -f 'svg-export.js' 2>/dev/null || true
pkill -f 'catalina.base=$INSTALL_DIR' 2>/dev/null || true
echo "[stop] 已发送停止信号"
EOF
chmod +x stop.sh

cat > umeko-drawio.service <<EOF
[Unit]
Description=umeko drawio server (all-in-one bare-metal)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/start.sh
ExecStop=$INSTALL_DIR/stop.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

say "完成！"
echo
echo "  启动:        $INSTALL_DIR/start.sh          # 前台运行，日志在 $INSTALL_DIR/logs/"
echo "  后台(nohup): nohup $INSTALL_DIR/start.sh >/dev/null 2>&1 &"
echo "  systemd:     cp $INSTALL_DIR/umeko-drawio.service /etc/systemd/system/ && systemctl enable --now umeko-drawio"
echo "  访问:        http://localhost:$PORT/node    (入口页)"
echo "  管理面板:    http://localhost:$PORT/manage  (默认 umeko / 1234，请在 start.sh 中加 ADMIN_PASSWORD=... 修改)"
