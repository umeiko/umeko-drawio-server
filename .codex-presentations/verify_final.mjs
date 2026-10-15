import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';
import { GlobalFonts } from '@napi-rs/canvas';
GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc','Microsoft YaHei');
GlobalFonts.registerFromPath('C:/Windows/Fonts/msyhbd.ttc','Microsoft YaHei');
const root='D:/Users/admin/Desktop/umeko_draw.io_server';
const p=await PresentationFile.importPptx(await FileBlob.load(path.join(root,'deliverables/Umeko_Agent协同绘图_5分钟汇报.pptx')));
const out=path.join(root,'.codex-presentations/final-renders');
await fs.mkdir(out,{recursive:true});
for(const [i,s] of p.slides.items.entries()) {
 const blob=await p.export({slide:s,format:'png',scale:1});
 await fs.writeFile(path.join(out,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await blob.arrayBuffer()));
}
console.log(`Rendered final PPTX: ${p.slides.items.length} slides`);
