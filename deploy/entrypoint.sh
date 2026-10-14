#!/usr/bin/env bash
# all-in-one 容器编排：tomcat(drawio webapp) + export-server(PNG) + svg-exporter(SVG/PNG) + 主服务
set -u

log() { echo "[entrypoint] $*"; }

export CATALINA_HOME=/usr/local/tomcat
export EXPORT_URL=${EXPORT_URL:-http://127.0.0.1:8000/}

# JRE 路径自动探测（amd64/arm64 路径不同）
if [ -z "${JRE_HOME:-}" ]; then
  JRE_HOME=$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")
  export JRE_HOME
fi

# 自定义字体（可选挂载 /usr/share/fonts/drawio）
if ls /usr/share/fonts/drawio/* >/dev/null 2>&1; then
  fc-cache -f >/dev/null 2>&1 || true
  log "custom fonts cached"
fi

pids=""
start() { # start <name> <cmd...>
  local name=$1; shift
  "$@" > >(sed -u "s/^/[$name] /") 2>&1 &
  pids="$pids $!"
  log "started $name (pid $!)"
}

start tomcat "$CATALINA_HOME/bin/catalina.sh" run

# 等 webapp 就绪再启动导出服务（最多 120s）
ok=""
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null http://127.0.0.1:8080/ 2>/dev/null; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] && log "webapp ready" || log "WARN: webapp not ready after 120s, starting exporters anyway"

EXPORT_DIR=/home/pptruser/draw-image-export2
# Chrome 沙箱要求非 root 用户运行（pptruser 为基础镜像内置）
start export-server su -s /bin/bash pptruser -c "cd $EXPORT_DIR && PORT=8000 DRAWIO_BASE_URL=http://127.0.0.1:8080 exec node export.js"
start svg-exporter su -s /bin/bash pptruser -c "cd $EXPORT_DIR && PORT=8001 DRAWIO_URL=http://127.0.0.1:8080 exec node svg-export.js"

export DRAWIO_URL=${DRAWIO_URL:-http://127.0.0.1:8080}
export EXPORT_URLS=${EXPORT_URLS:-http://127.0.0.1:8000/,http://127.0.0.1:8080/export}
export SVG_EXPORT_URLS=${SVG_EXPORT_URLS:-http://127.0.0.1:8001/}
export PORT=${PORT:-3000}
export OUTPUT_DIR=${OUTPUT_DIR:-/app/output}
export DATA_DIR=${DATA_DIR:-/app/data}

shutdown() {
  log "shutting down"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  # shellcheck disable=SC2086
  wait $pids 2>/dev/null
  exit 0
}
trap shutdown TERM INT

cd /app
node src/server.js > >(sed -u "s/^/[server] /") 2>&1 &
SERVER_PID=$!
pids="$pids $SERVER_PID"

# 主服务退出即整体退出
wait "$SERVER_PID"
shutdown
