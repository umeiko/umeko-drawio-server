#!/usr/bin/env bash
# 向 drawio webapp 的 js/PreConfig.js 注入 window.DRAWIO_CONFIG（幂等）
# 用法: patch-preconfig.sh <webapp目录> <config.json>
#   - 已存在 window.DRAWIO_CONFIG 行则整行替换，否则追加
#   - config.json 的内容须是一个 JSON 对象（写入时压缩为单行）
set -euo pipefail

WEBAPP_DIR="${1:?usage: patch-preconfig.sh <webapp_dir> <config.json>}"
CONFIG_JSON="${2:?usage: patch-preconfig.sh <webapp_dir> <config.json>}"
PRECONFIG="$WEBAPP_DIR/js/PreConfig.js"

[ -f "$PRECONFIG" ] || { echo "[preconfig] 未找到 $PRECONFIG（webapp 尚未部署？）"; exit 1; }

# 压缩为单行，供 sed 安全替换（json 内容不含 & 与 | 时以下分隔符安全；先转义 & 与 \）
one_line=$(tr -d '\n' < "$CONFIG_JSON" | tr -s ' ')
escaped=$(printf '%s' "$one_line" | sed 's/[&\\]/\\&/g')

if grep -q '^window\.DRAWIO_CONFIG = ' "$PRECONFIG"; then
  sed -i "s|^window\.DRAWIO_CONFIG = .*;|window.DRAWIO_CONFIG = $escaped;|" "$PRECONFIG"
else
  echo "window.DRAWIO_CONFIG = $one_line;" >> "$PRECONFIG"
fi
echo "[preconfig] 已注入 DRAWIO_CONFIG -> $PRECONFIG"
