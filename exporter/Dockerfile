# 复用官方 export-server 镜像中的 Chrome + puppeteer，仅替换为我们的 SVG 导出脚本
FROM jgraph/export-server:latest

COPY --chown=pptruser:pptruser svg-export.js /home/pptruser/draw-image-export2/svg-export.js
WORKDIR /home/pptruser/draw-image-export2

EXPOSE 8001
CMD ["node", "svg-export.js"]
