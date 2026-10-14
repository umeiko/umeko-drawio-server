#!/usr/bin/env bash
# 下载方正兰亭黑字体到 fonts/（幂等：已存在则跳过）
# 字体为公司授权资产，不入 git 仓库；内网离线环境可手动放入 fonts/ 目录
set -euo pipefail

FONT_URL="${FONT_URL:-https://github.com/umeiko/UmEkO/releases/download/assets/FZLanTingHeiS-R-GB.ttf}"
FONT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fonts"
FONT_FILE="$FONT_DIR/FZLanTingHeiS-R-GB.ttf"

mkdir -p "$FONT_DIR"
if [ -s "$FONT_FILE" ]; then
  echo "[fonts] 已存在: $FONT_FILE"
  exit 0
fi

echo "[fonts] 下载方正兰亭黑: $FONT_URL"
curl -fSL --retry 3 --retry-all-errors --connect-timeout 15 "$FONT_URL" -o "$FONT_FILE.tmp"
mv "$FONT_FILE.tmp" "$FONT_FILE"
echo "[fonts] 完成: $FONT_FILE ($(du -h "$FONT_FILE" | cut -f1))"
