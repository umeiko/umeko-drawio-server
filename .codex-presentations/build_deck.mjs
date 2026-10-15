import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';
import { GlobalFonts } from '@napi-rs/canvas';

const ROOT = 'D:/Users/admin/Desktop/umeko_draw.io_server';
const BUILD = path.join(ROOT, '.codex-presentations');
const OUT = path.join(ROOT, 'deliverables');
const SKILL = 'C:/Users/admin/.codex/plugins/cache/openai-primary-runtime/presentations/26.1013.11914/skills/presentations';
const PYTHON = 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
process.env.RUNTIME_NODE_MODULES = 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
process.env.RUNTIME_NODE = 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe';
process.env.RUNTIME_PYTHON = PYTHON;
GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'Microsoft YaHei');
GlobalFonts.registerFromPath('C:/Windows/Fonts/msyhbd.ttc', 'Microsoft YaHei');
const FONT = 'Microsoft YaHei';
const C = {red:'#C7000B', ink:'#222222', gray:'#5B6068', light:'#F4F5F7', line:'#DADDE2', blue:'#355775', pale:'#FFF4F4', white:'#FFFFFF'};
const P = Presentation.create({slideSize:{width:1280,height:720}});
P.theme.defaultFont = FONT;
const notes = [];

function text(s, value, x, y, w, h, size=26, opt={}) {
  const sh = s.shapes.add({geometry:'textbox', name:opt.name||value.slice(0,32),position:{left:x,top:y,width:w,height:h},fill:opt.fill||'none',line:{fill:'none',width:0}});
  sh.text=value;
  sh.text.style={typeface:FONT,fontSize:size,color:opt.color||C.ink,bold:!!opt.bold,alignment:opt.align||'left',verticalAlignment:opt.valign||'top',wrap:'square',autoFit:'none',insets:0};
  return sh;
}
function rule(s,x,y,w,color=C.red,h=3) {
  return s.shapes.add({geometry:'rect',name:'分隔线',position:{left:x,top:y,width:w,height:h},fill:color,line:{fill:'none',width:0}});
}
function base(title, number, appendix=false) {
  const s=P.slides.add();
  s.background.fill=C.white;
  text(s,title,64,44,1152,70,41,{bold:true,name:'slide-title'});
  rule(s,64,128,1152);
  rule(s,64,666,1152,C.line,1);
  text(s,'UMEKO DRAW.IO SERVER',64,680,760,20,14,{color:C.gray});
  text(s,appendix?`备查 ${String(number-8).padStart(2,'0')}`:`${String(number).padStart(2,'0')} / 08`,1106,678,110,24,16,{color:C.gray,align:'right'});
  return s;
}
function note(s,title,seconds,speech,sources=[]) {
  const body=[seconds?`建议用时 ${seconds} 秒`:'备查页，不计入主讲',speech,sources.length?'资料依据：\n'+sources.join('\n'):''].filter(Boolean).join('\n\n');
  s.speakerNotes.text=body;
  notes.push({title,seconds,speech,sources});
}
function table(s, values, x,y,w,h,widths,opts={}) {
  const t=s.tables.add({rows:values.length,columns:values[0].length,left:x,top:y,width:w,height:h,columnWidths:widths,values});
  const rh=opts.heights||values.map((_,i)=>i===0?60:(h-60)/(values.length-1));
  t.borders.assign({style:'solid',fill:C.white,width:2});
  for(let r=0;r<values.length;r++) {
    t.rows[r].height=rh[r];
    for(let c=0;c<values[0].length;c++) {
      const cell=t.getCell(r,c);
      cell.fill=r===0?(opts.headerColor||C.red):(r%2?C.light:C.white);
      cell.text.style={typeface:FONT,fontSize:r===0?(opts.headerSize||24):(opts.size||25),color:r===0?C.white:C.ink,bold:r===0||(opts.boldFirst&&c===0),verticalAlignment:'middle',alignment:opts.align||'left',wrap:'square',insets:{left:16,right:14,top:10,bottom:10}};
    }
  }
  return t;
}
function box(s, title, desc, x,y,w,h,{fill=C.light,stroke=C.line,titleSize=25,descSize=21}={}) {
  const b=s.shapes.add({geometry:'rect',name:title,position:{left:x,top:y,width:w,height:h},fill,line:{fill:stroke,width:1.3}});
  text(s,title,x+16,y+12,w-32,36,titleSize,{bold:true,align:'center'});
  if(desc)text(s,desc,x+14,y+50,w-28,h-56,descSize,{color:C.gray,align:'center'});
  return b;
}
function connect(s,a,b,from='bottom',to='top',color=C.gray,kind='elbow',both=false) {
  return s.shapes.connect(a,b,{kind,fromSide:from,toSide:to,line:{fill:color,width:2},head:{type:both?'arrow':'none',width:'med',length:'med'},tail:{type:'arrow',width:'med',length:'med'}});
}

// 01  Cover
{
 const s=P.slides.add();s.background.fill=C.white;
 text(s,'Umeko Draw.io Server',64,96,1120,58,29,{color:C.gray});
 text(s,'面向多 Agent 的\n人机协同绘图服务',64,197,1130,178,58,{bold:true,name:'cover-title'});
 rule(s,64,408,1152,C.red,5);
 text(s,'平台 Widgets 伴生画布与个人编码 Agent 交互',64,445,1148,50,29,{color:C.gray});
 text(s,'项目方案与 10～100 人演进规划',64,511,1148,42,26,{color:C.ink});
 text(s,'2026.10.15',64,648,300,30,21,{color:C.gray});
 note(s,'面向多 Agent 的人机协同绘图服务',10,
 '这个项目面向业务同事与 Agent 协同绘图，提供可内部部署的交互画布。下面介绍它的价值、架构，以及从个人测试走向百人使用的建设路径。',
 ['用户提供：项目自研，当前在个人申请的单节点 ECS 测试，目标 10～100 人。','代码快照：b2b8c48，2026-10-15。']);
}
// 02  Business value and two entry modes
{
 const s=base('业务同事与 Agent 共用画布，持续修改同一份图',2);
 table(s,[
  ['使用入口','业务同事如何参与','Agent 如何协作'],
  ['平台伴生画布','在平台 Widgets 中查看、拖拽和修订\n目标场景：Nexent 等 Agent 平台','通过 MCP 生成、读取和修改 XML\n画布持续显示最新图形'],
  ['个人编码 Agent','浏览器打开独立画布\n本地编码 Agent、内网 CodeAgent / CodeArts 等','通过 MCP 与同一绘图服务交互\n人工调整可回读给 Agent']
 ],64,165,1152,273,[210,471,471],{heights:[57,108,108],size:24});
 const f1=box(s,'业务描述需求','自然语言说明',64,486,252,97,{descSize:20});
 const f2=box(s,'Agent 生成 XML','校验后推送画布',364,486,252,97,{descSize:20});
 const f3=box(s,'人工修改画布','实时看到并调整',664,486,252,97,{descSize:20});
 const f4=box(s,'Agent 回读迭代','沿用人工修改',964,486,252,97,{descSize:20});
 connect(s,f1,f2,'right','left',C.red,'straight');connect(s,f2,f3,'right','left',C.red,'straight');connect(s,f3,f4,'right','left',C.red,'straight');
 text(s,'内部部署为业务图形数据驻留提供基础，接入平台与模型的数据流需一并纳管',64,615,1152,34,23,{color:C.gray});
 note(s,'业务同事与 Agent 共用画布',40,
 '项目有两类入口。第一类是平台里的伴生画布，例如面向 Nexent 等 Agent 系统，由 Widgets 承载界面，MCP 承载绘图操作。第二类是个人入口，本地编码 Agent、内网 CodeAgent、CodeArts 等可以和浏览器画布交互。业务同事提出需求，Agent 生成图形，人可以直接拖拽修改，Agent 再读取最新 XML 继续作业。这样保留的是可以继续编辑的源图。图形服务支持内部部署，模型和接入平台的数据流也需要纳入管理。',
 ['用户补充：面向多种 Agent 系统的 Widgets 伴生能力，以及个人编码 Agent 交互绘图。','src/server.js:404-639 MCP 工具与多会话；666-690 widgets.json。','public/node.html: 与嵌入编辑器、服务器的双向 XML 通信。','平台名称表示目标接入场景，未取得 Nexent Widgets、CodeAgent、CodeArts 的端到端验收记录。']);
}
// 03  Current editable architecture
{
 const s=base('现有架构：MCP 控制图形，Widgets 承载交互',3);
 const a=box(s,'平台 Agent / 个人编码 Agent','MCP 工具调用',64,165,505,100,{fill:C.white,stroke:C.blue});
 const b=box(s,'业务同事的浏览器','平台 Widget 或独立 draw.io 画布',711,165,505,100,{fill:C.white,stroke:C.blue});
 text(s,'Node.js 主服务',64,295,1152,40,25,{bold:true,color:C.red});
 const m=box(s,'MCP / REST API','XML 读写、校验、导出编排',64,350,505,104);
 const r=box(s,'画布代理与实时通道','nodeId 节点状态、WebSocket / SSE',711,350,505,104);
 connect(s,a,m,'bottom','top',C.gray,'straight',true);connect(s,b,r,'bottom','top',C.gray,'straight',true);connect(s,m,r,'right','left',C.red,'straight',true);
 text(s,'XML',598,367,82,30,20,{color:C.red,align:'center'});
 const e=box(s,'PNG 导出服务','官方 export-server',64,514,350,99,{fill:C.white});
 const v=box(s,'SVG 导出器','自研脚本 + 无头 Chrome',465,514,350,99,{fill:C.white});
 const d=box(s,'draw.io Webapp','浏览器可视化编辑器',866,514,350,99,{fill:C.white});
 connect(s,m,e);connect(s,m,v);connect(s,r,d);
 text(s,'当前：单节点 ECS 测试，Compose 将主服务、编辑器和两类导出服务分开部署',64,628,1152,30,21,{color:C.gray});
 note(s,'现有架构',45,
 '架构上，Agent 通过 MCP 调用图形工具，业务同事通过平台 Widget 或独立页面操作 draw.io。Node.js 主服务负责 XML 校验、节点管理和实时同步，WebSocket 连不上时可以降级到 SSE。下面复用 draw.io 编辑器和官方 PNG 导出服务，并补充自研 SVG 导出器，统一字体与导出链路。这个服务本身不运行大模型，模型由接入的 Agent 系统提供。目前 XML 热状态、页面连接和 MCP 会话都在单进程里，这也是后续扩容时需要处理的边界。',
 ['docker-compose.yml：server、drawio、export-server、svg-exporter 四服务及内网地址。','src/server.js:184-301 REST 与实时通道；597-639 MCP 会话；666-715 Widgets 与编辑器代理。','src/nodes.js:15-20 节点 Map；215-248 页面连接。','部署形态还支持 all-in-one 与裸机 Linux。本页按推荐的 Compose 方案绘制。']);
}
// 04  Choice of draw.io
{
 const s=base('draw.io 的 XML 兼顾精细表达与人机双向编辑',4);
 table(s,[
  ['比较维度','draw.io XML','Mermaid 文本语法'],
  ['表达与布局','显式描述几何位置、样式和分组\n适合需要精细排版的业务图','简洁描述节点和关系\n主要由布局引擎计算位置'],
  ['人工参与','业务同事直接拖拽、修改图形\nAgent 可回读当前 XML','适合通过文本持续维护图形\n视觉效果随语法和布局配置生成'],
  ['模型配合','XML 可作为文本进入模型上下文\n配合结构校验与渲染反馈迭代','语法紧凑，适合快速表达关系\n适用于文档中的标准图形']
 ],64,169,1152,356,[186,483,483],{heights:[59,99,99,99],size:25});
 text(s,'本项目适合：需要人工精修、平台伴生画布和可编辑成果的业务场景',64,559,1152,48,28,{bold:true,color:C.red});
 text(s,'模型生成质量仍需按具体模型、图形复杂度和提示模板验证',64,618,1152,32,22,{color:C.gray});
 note(s,'draw.io 选型依据',35,
 '选择 draw.io 的主要原因，是业务图经常需要精修位置、样式和分组。XML 把这些结构明确表达出来，模型可以读写文本，人也能直接操作画布。人工修改又能回到 Agent 的上下文，适合反复协作。Mermaid 的优势是语法简洁，适合文档中标准关系图。两者各有适用场景。这里关于模型配合的判断是工程选型依据，具体模型能生成多复杂的图，还需要结合校验和渲染反馈做验证。',
 ['draw.io 官方 XML 文档：https://www.drawio.com/docs/manual/advanced/diagram-source-edit/','Mermaid 官方流程图文档：https://mermaid.js.org/syntax/flowchart.html','src/validate.js: 语法与部分 mxGraph 结构检查。','未做主流模型的统一成功率、编辑精度或 token 成本对比，不宣称已有量化结论。']);
}
// 05  Capacity: all values from explicit planning assumptions
{
 const s=base('容量规划：10 人试用，50～100 人按负载扩容',5);
 text(s,'示例假设：每人每 10 秒一次控制请求、每 5 分钟一次导出，单次导出占用 4 秒',64,164,1152,58,24,{color:C.gray});
 const t=table(s,[
  ['同时在线','控制请求','导出需求','单渲染槽占用','规划渲染槽位'],
  ['10 人','1 次/秒','2 次/分钟','13%','1 个'],
  ['50 人','5 次/秒','10 次/分钟','67%','2 个'],
  ['100 人','10 次/秒','20 次/分钟','133%','3 个']
 ],64,244,1152,290,[190,220,230,256,256],{heights:[62,76,76,76],size:28,align:'center'});
 t.getCell(3,3).text.style={typeface:FONT,fontSize:28,color:C.red,bold:true,alignment:'center',verticalAlignment:'middle'};
 text(s,'SVG 当前单实例串行。按 60% 稳态利用率规划 1 / 2 / 3 个独立渲染槽位',64,564,1152,46,26,{bold:true,color:C.red});
 text(s,'以上为测算，非压测结论。当前 ECS 规格和经实测确认的并发上限尚未提供',64,618,1152,32,21,{color:C.gray});
 note(s,'10～100 人容量规划',50,
 '容量要分开看在线编辑和渲染导出。普通画布编辑主要在浏览器完成，服务端重负载集中在无头浏览器导出。这里给出可复算的规划场景：每人十秒一次控制请求、五分钟一次导出，单次导出四秒。十人时每分钟两次导出，单槽占用约百分之十三。五十人占用百分之六十七。百人需要百分之一百三十三，单槽已经无法稳定消化。按百分之六十的利用率留余量，分别规划一、二、三个独立渲染槽位。目前 SVG 导出器串行，这些数字都是假设测算，实际能力要在当前 ECS 上压测后确认。',
 ['exporter/svg-export.js:44、145-154，单 Promise 队列串行导出。','src/render.js: 导出请求与端点回退。PNG 官方服务的内部并行能力未实测，本表采用统一独立渲染槽位模型。','假设 N 人，每人每 300 秒一次导出，T=4 秒。导出到达率 λ=N/300 次/秒。','单槽占用 ρ=λ×T=N×4/300。规划槽位 k=ceil(λ×T/0.6)，10/50/100 人分别为 1/2/3。','控制请求=N/10 次/秒，不包含静态资源首次加载、SSE 心跳、MCP 协议开销和重试。','槽位为独立执行能力，可通过多个受限 worker / exporter 实例实现，不能直接等同于现有单容器的并行度。','本测算不覆盖同时发起的批量导出、复杂图、外部图片、字体冷启动和用户思考时间分布。']);
}
// 06  Security and reliability
{
 const s=base('内网部署支撑数据保密，授权与可靠性逐步完善',6);
 table(s,[
  ['建设方向','当前基础与边界','多人试用前的重点'],
  ['数据驻留','编辑器、字体与导出可走内部地址\nAgent / 模型数据流需同步确认','出口白名单，禁访问云元数据\n模型、日志、产物一并纳管'],
  ['身份与权限','nodeId 即访问凭证\n开发端点有全量节点能力','统一身份与画布归属校验\n封闭开发端点，隔离管理入口'],
  ['保存与恢复','热画布在内存，重启可能丢失\n冷文件落本地磁盘','保存确认前持久化，增加版本\n建立备份与恢复演练'],
  ['服务可控性','SVG 串行队列无显式长度上限\n产物与会话缺少完整配额治理','限流、有界队列、超时与审计\n设置产物保留期及访问控制']
 ],64,166,1152,421,[192,478,482],{heights:[61,90,90,90,90],size:24});
 text(s,'建设目标：图形数据在受控环境中流转，每次操作可授权、可追溯、可恢复',64,614,1152,37,25,{bold:true,color:C.red});
 note(s,'安全与数据可靠性',45,
 '内部部署让编辑器和导出链路可以使用内部地址，为业务数据保密提供基础。扩大使用时，还要把 Agent、模型、外部图片、日志和导出文件都纳入同一数据边界。代码层面，当前知道 nodeId 就能操作画布，需要补统一身份和画布归属授权。热数据在内存，重启会丢失，所以保存成功前应当持久化，并增加版本和恢复演练。另一个重点是渲染限流、有界队列、超时和审计，防止少量突发导出影响整个服务。',
 ['src/server.js:46 管理员默认口令；184-301 业务接口；597-639 MCP 端点；694 产物静态下载。','src/nodes.js:15-20 热状态 Map；66-67 解冻后删除冷文件；85-103 冻结落盘。','exporter/svg-export.js:33 Chromium 使用 --no-sandbox；44、145 串行无界队列。建议在受限 worker、非特权容器和网络策略中隔离。','MCP 安全规范：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports','MCP 安全实践：https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices','draw.io 官方安全说明：https://github.com/jgraph/drawio/wiki/Security','本页为代码调研与建设建议，未进行渗透测试，也未获得实际 ECS 网关、网络策略和合规认证证据。']);
}
// 07  Incremental scaling
{
 const s=base('扩容路径：拆分渲染负载，再按需增加业务副本',7);
 table(s,[
  ['演进阶段','10 人受控验证','50 人小范围试用','100 人共享服务'],
  ['部署方式','沿用单 ECS\n保持四服务拆分','独立限制渲染资源\n增设渲染槽位与队列','按压测与可用性要求\n决定增加业务副本'],
  ['数据与会话','保存落盘、版本管理\n身份与画布授权','逐步外置权威状态\n统一产物存储与配额','数据库共享 XML\n跨实例通知与连接路由'],
  ['放量依据','功能闭环与恢复验证\n接入一个平台和个人端','记录导出耗时与排队\n压测覆盖突发请求','长稳测试与故障切换\n达到约定服务指标']
 ],64,167,1152,371,[180,324,324,324],{heights:[65,102,102,102],size:24});
 text(s,'多副本前置条件：XML 状态共享，MCP 会话可路由，WS / SSE 可跨实例通知',64,571,1152,43,25,{bold:true,color:C.red});
 text(s,'人数是验证分档，是否升级部署形态由瓶颈和可用性要求决定',64,622,1152,30,22,{color:C.gray});
 note(s,'分阶段扩容',40,
 '演进可以按十人、五十人、百人分档验证。十人阶段沿用当前单节点，先补授权、保存和恢复。五十人阶段重点拆开业务与渲染资源，增加受限渲染槽位，观察排队和突发。百人阶段根据压测和可用性要求决定是否增加业务副本。增加副本前，要把 XML 权威状态放入共享数据库，处理跨实例通知，并为 MCP 会话和浏览器长连接建立路由与重连机制。单纯把现有服务复制多份，会出现各实例画布与会话不一致。',
 ['src/nodes.js:17 Map、215-248 单页面实时连接。','src/server.js:139 adminTokens Map；597-633 每端点局部 MCP 会话表。','参考演进设计，当前代码尚未实现数据库、共享队列、消息总线或跨实例会话路由。','不预设 100 人必须采用 Kubernetes。可继续使用 ECS 与容器编排，在容量和故障指标要求下逐步演进。']);
}
// 08  Next actions
{
 const s=base('下一步：完成双入口试用，按指标逐步放量',8);
 const rows=[
  ['01','接入验收','选择一个平台 Agent 和一个个人编码 Agent\n验证打开画布、推送、人工修改、回读与导出'],
  ['02','补齐底座','落实身份授权与保存恢复\n增加渲染配额、排队监控和审计'],
  ['03','分档放量','在当前 ECS 上验证 10 / 50 / 100 人负载\n依据响应、成功率与资源余量决定扩容']
 ];
 rows.forEach((r,i)=>{
  const y=177+i*134;
  text(s,r[0],64,y,90,65,46,{bold:true,color:C.red});
  text(s,r[1],171,y+3,260,45,29,{bold:true});
  text(s,r[2],439,y,777,87,26,{color:C.gray});
  if(i<2)rule(s,171,y+109,1045,C.line,1);
 });
 text(s,'面向业务协作，让不同 Agent 复用可编辑、可控的绘图能力',64,610,1152,42,30,{bold:true,color:C.red});
 note(s,'下一步与放量目标',20,
 '下一步选一个平台和一个个人 Agent 完成协作闭环，补好授权、保存和渲染治理，再在当前 ECS 上分档压测。最终目标是让业务同事与不同 Agent 安全地围绕同一份可编辑图形持续协作。',
 ['阶段性计划，尚未完成平台验收、容量压测或生产放量。']);
}
// 09  Integration matrix
{
 const s=base('备查：平台适配矩阵与验收范围',9,true);
 table(s,[
  ['接入对象','已有基础','待验收项'],
  ['Nexent 等平台','服务提供 Streamable HTTP MCP\nNexent 官方支持远程 MCP 接入','鉴权、工具发现、会话与流式结果\nWidgets 协议、iframe 和入口联动'],
  ['个人编码 Agent','服务提供远程 MCP 与独立画布\nnodeId 关联人与 Agent 的操作','客户端版本与 HTTP MCP 支持\n仅支持 stdio 时需桥接适配'],
  ['CodeAgent / CodeArts','目标场景由项目作者提供\n复用 MCP 工具与浏览器入口','内网部署版本、证书与网络白名单\n平台鉴权和交互能力逐项确认'],
  ['现有 Widgets 声明','仓库按 AINA 规范动态生成\nwidgets.json、工具白名单与路径前缀','不能直接视为各平台通用协议\n按平台版本适配并留验收证据']
 ],64,166,1152,433,[220,456,476],{heights:[61,93,93,93,93],size:23});
 text(s,'最小验收闭环：建画布、推送、人工编辑、回读、校验、出图、断线重连',64,622,1152,31,23,{color:C.red,bold:true});
 note(s,'平台适配矩阵',0,
 '目标平台与当前代码接口分开确认。Nexent 的公开文档证明具备远程 MCP 接入方式，不能由此推定 Widgets 伴生画布已经兼容。内网 CodeAgent、CodeArts 的具体部署版本与能力由平台联调确认。Widgets 工具白名单是平台声明，后端仍需自行执行授权。',
 ['Nexent 官方 MCP 接入指南：https://modelengine-group.github.io/nexent/en/integration/integration-in/mcp.html','src/server.js:59、666-690 widgets.json 与 tools_allow；README.md 平台集成端点。','未检查或修改用户的真实平台配置。未取得端到端联调记录。']);
}
// 10  Future editable architecture
{
 const s=base('备查：百人阶段参考架构，按需部署多副本',10,true);
 const ingress=box(s,'Agent 与业务同事','MCP / Widgets / 浏览器',64,180,250,110,{fill:C.white,titleSize:23,descSize:19});
 const gate=box(s,'统一入口','身份、TLS、限流',354,180,230,110,{fill:C.white,stroke:C.red,titleSize:23,descSize:20});
 const svc=box(s,'业务服务 A / B','授权、版本、实时连接',624,180,270,110,{fill:C.white,titleSize:23,descSize:20});
 const queue=box(s,'有界渲染队列','并发配额、超时与重试',934,180,282,110,{fill:C.white,titleSize:23,descSize:20});
 connect(s,ingress,gate,'right','left',C.red,'straight');connect(s,gate,svc,'right','left',C.red,'straight');
 connect(s,svc,queue,'right','left',C.red,'straight');
 const bus=box(s,'会话路由与通知','MCP 会话亲和\nWS / SSE 重连',354,367,230,118,{titleSize:22,descSize:20});
 const db=box(s,'共享数据库','归属、XML、版本与任务',624,367,270,118,{titleSize:23,descSize:20});
 const workers=box(s,'独立渲染 Worker','隔离浏览器\n限制 CPU / 内存',934,367,282,118,{titleSize:23,descSize:20});
 const obs=box(s,'共享产物存储','保留期与授权下载',934,548,282,90,{fill:C.white,titleSize:23,descSize:20});
 connect(s,svc,db,'bottom','top',C.gray,'straight',true);connect(s,svc,bus,'bottom','top');
 connect(s,queue,workers,'bottom','top',C.gray,'straight');connect(s,workers,obs,'bottom','top',C.gray,'straight');
 text(s,'全链路治理',64,551,240,42,27,{bold:true,color:C.red});
 text(s,'访问审计、时延、排队、资源指标、恢复告警',64,603,810,36,24,{color:C.gray});
 note(s,'参考扩容架构',0,
 '本页全部为演进设计。数据库保存 XML 权威状态并记录所有者与版本。消息总线用于将更新通知至持有浏览器连接的实例。MCP transport 对象仍由实例持有，不能仅用 Redis 存一个会话 ID 就实现任意实例接续，需要会话路由、实例失效后的重新初始化和重试规则。队列中的渲染任务应包含不可变版本引用，worker 出图后写共享存储，更新任务状态并向用户提供授权下载。图中的监控、共享数据库、队列、双副本当前均未实现。',
 ['设计推导依据：src/nodes.js 内存状态、单链接；src/server.js MCP 会话局部表；src/render.js 同步渲染调用。','业务端将 XML 与任务提交到共享数据库及队列。渲染 Worker 将产物上传共享存储，监控采集各组件指标。图仅展示主要职责与依赖。']);
}
// 11  Acceptance plan
{
 const s=base('备查：容量与可靠性验收口径',11,true);
 table(s,[
  ['验证项','建议测试场景','建议通过标准，均为待验收目标'],
  ['负载与样本','在线 10 / 50 / 100，记录 ECS 规格\n图大小 50 / 200 / 1000 KiB','每档 15 分钟，百人档增加长稳测试\n覆盖 WS、SSE 与多个 MCP 客户端'],
  ['控制与同步','读写、校验、人工编辑后回读\n按每人 0.1 次/秒施加控制请求','控制接口 p95 < 500 ms\n200 KiB 保存确认 p95 < 1 秒'],
  ['渲染与突发','每人每 5 分钟导出，另加 10 个突发\nPNG / SVG 分开统计','200 KiB 图端到端导出 p95 < 15 秒\n成功率 ≥ 99.5%，资源保留余量'],
  ['恢复与安全','重启、断连、越权、过期任务和磁盘满\n多副本阶段覆盖实例故障','已确认保存的数据不丢失\n非所有者拒绝访问，恢复流程可演练']
 ],64,167,1152,427,[190,466,496],{heights:[63,91,91,91,91],size:23});
 text(s,'负载人数、成功率和响应时间必须共同报告，同时保留原始数据与测试环境',64,619,1152,34,24,{bold:true,color:C.red});
 note(s,'容量验收建议',0,
 '所有响应时间与成功率均为建议目标，需与业务方约定后执行。控制接口目标不含外部 Agent 模型推理时间。渲染端到端时延包含排队与执行，格式、图形元素数、字体和冷启动分别留样本。p95 与成功率需要给出样本量，不能只报告平均值。百人长稳建议至少 2 小时，资源监控重点观察无界积压、RSS 走势与会话清理。保存不丢失只适用于完成持久化提交并已返回成功的版本，当前内存方案尚未达到。',
 ['本页为项目建议测试方案，未执行多人压测。','当前 ECS 实际规格、镜像版本、平均图大小、导出耗时和峰值业务分布尚未提供。']);
}
// 12  Evidence and technical caveats
{
 const s=base('备查：代码证据与结论边界',12,true);
 text(s,'调研快照 b2b8c48，2026.10.15；当前项目处于个人单节点 ECS 测试阶段',64,165,1152,44,24,{color:C.gray});
 table(s,[
  ['关键结论','仓库证据与口径'],
  ['多人接入与协同边界','src/server.js:597-639 每个 MCP 会话独立实例\nsrc/nodes.js:215-248 一画布仅保留一个页面连接，无多人冲突合并'],
  ['状态与生命周期','src/nodes.js:15-103 热节点为内存 Map，冻结后写 JSON\n连接中不自动冻结，48 小时清理按 lastSeenAt 计时，解冻删除冷文件'],
  ['渲染与数据边界','exporter/svg-export.js:44、145-154 SVG 单实例串行队列\nrender_diagram 允许仅传 XML，deep 校验同样占用 SVG 导出能力'],
  ['授权与输入约束','nodeId 即操作凭证，tools_allow 为声明，不能代替服务端鉴权\n需统一 nodeId 格式与路径约束，覆盖 REST、MCP、WS、SSE 和产物']
 ],64,227,1152,359,[246,906],{heights:[55,76,76,76,76],size:22});
 text(s,'外部依据：draw.io XML / 安全说明、Mermaid 流程图、MCP 安全规范、Nexent MCP 指南',64,619,1152,33,21,{color:C.gray});
 note(s,'代码证据与边界',0,
 '优先以代码而非 README 的简化描述为准。冷存储实际使用 JSON 文件。生命周期清理按最后访问时间计算，不能表述为冻结后完整保留 48 小时。读取节点可能触发解冻并删除冷文件，因此冷存储也不是热节点的备份。README 的用户态所有交互必须传 nodeId 存在例外：render_diagram 可仅传 XML。业务页 report/WS 输入、冷存储路径、会话过期和导出下载控制都需要统一治理。本轮只作调研与方案建议，未改动业务源码，也未执行容量压测或合规认证。',
 ['src/nodes.js:24-25、66-67、183-209。','src/server.js:268-273、523-586、638-639、694。','https://www.drawio.com/docs/manual/advanced/diagram-source-edit/','https://github.com/jgraph/drawio/wiki/Security','https://mermaid.js.org/syntax/flowchart.html','https://modelcontextprotocol.io/specification/2025-06-18/basic/transports','https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices','https://modelengine-group.github.io/nexent/en/integration/integration-in/mcp.html']);
}

await fs.mkdir(path.join(BUILD,'renders'),{recursive:true});
await fs.mkdir(OUT,{recursive:true});
const sum=notes.slice(0,8).reduce((n,r)=>n+r.seconds,0);
const narration=['Umeko Draw.io Server：5 分钟汇报讲稿',`主讲 8 页，建议总用时 ${sum} 秒（4 分 45 秒），保留 15 秒切页余量。`,
 '第 9～12 页为备查，正常汇报在第 8 页结束。平台名称为目标接入场景，容量数字为假设测算。','',
 ...notes.slice(0,8).flatMap((n,i)=>[`第 ${i+1} 页  ${n.title}（${n.seconds} 秒）`,n.speech,''])].join('\r\n');
await fs.writeFile(path.join(OUT,'5分钟逐页讲稿.txt'),'\ufeff'+narration,'utf8');
await fs.writeFile(path.join(BUILD,'notes.json'),JSON.stringify(notes,null,2));
const candidate=path.join(BUILD,'candidate.pptx');
await (await PresentationFile.exportPptx(P)).save(candidate);
console.log(`Exported ${P.slides.items.length} slides. Main talk: ${sum}s.`);
for(const [i,s] of P.slides.items.entries()) {
  const name=`slide-${String(i+1).padStart(2,'0')}`;
  await fs.writeFile(path.join(BUILD,'renders',`${name}.png`),new Uint8Array(await (await P.export({slide:s,format:'png',scale:1})).arrayBuffer()));
  console.log(`Rendered ${i+1}/${P.slides.items.length}`);
}
const {finalizePresentation}=await import(pathToFileURL(path.join(SKILL,'container_tools/artifact_tool_utils.mjs')).href);
const finalPath=path.join(OUT,'Umeko_Agent协同绘图_5分钟汇报.pptx');
const result=await finalizePresentation({
  workspaceDir:ROOT,candidatePath:candidate,finalPath,pythonExecutable:PYTHON,
  integrityValidatorPath:path.join(SKILL,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(SKILL,'container_tools/inspect_presentation_layout_geometry.py'),
  explicitTotalSlideCount:12,
  requiredNativeTableOwnerSlides:[2,4,5,6,7,9,11,12],
  requiredNativeChartOwnerSlides:[],
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit',...[2,4,5,6,7,9,11,12].flatMap(n=>['--require-native-table-slide',String(n)])],
  fontPolicy:{basis:'design',families:[FONT]},verifyArtifactToolImport:true,
  receiptPath:path.join(BUILD,'validation.json')
});
console.log(JSON.stringify(result));
