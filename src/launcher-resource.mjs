export const LAUNCHER_URI = 'ui://codex-scheduler/launcher-v0.4.1.html';
export const LAUNCHER_MIME = 'text/html;profile=mcp-app';

// The native entrypoint checks the desktop connection or opens its local manager.
// It never embeds localhost, grants network permissions, or sends model input.
export const launcherHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>时序任务管理器</title><style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color-scheme:light dark;color:light-dark(#222238,#eeeefa);background:light-dark(#f7f6fc,#1f1f2d)}
body{margin:0;min-height:100vh;display:grid;place-items:center}.card{max-width:520px;padding:40px;text-align:center}h1{font-size:28px;margin:18px 0 12px}p{line-height:1.8;opacity:.75}.logo{font-size:38px}button{border:0;border-radius:12px;background:#795cdb;color:white;padding:14px 24px;font:inherit;cursor:pointer}button:disabled{opacity:.6;cursor:wait}#status{min-height:56px;font-size:14px}small{display:block;margin-top:28px;opacity:.55;line-height:1.8}
</style></head><body><main class="card"><div class="logo" aria-hidden="true">⌛</div><h1 id="heading">时序任务管理器</h1><p id="intro">安排下一步，让任务按时开始。</p><button id="open" disabled>正在连接…</button><p id="status" role="status" aria-live="polite">正在连接 Codex 插件。</p><small>无需发送聊天消息。</small></main>
<script>
const openButton=document.getElementById('open'),status=document.getElementById('status'),heading=document.getElementById('heading'),intro=document.getElementById('intro');
let rpcId=0,ready=false,busy=false,initializing=false,initialResult=null,openedAutomatically=false,hostContext={},contextRevision=0,connected=false;
const pending=new Map();
function request(method,params){return new Promise((resolve,reject)=>{const id=++rpcId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('连接暂时没有响应，请再试一次。'))},20000);pending.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*')})}
function notify(method,params){window.parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function initializingConnection(){const value=hostContext['openai/deepLink']?.url;return typeof value==='string'&&/^\/initialize(?:\?attempt=[a-f0-9]{32})?$/.test(value)}
function contextPath(){return hostContext['openai/deepLink']?.url||'/'}
function showButton(){openButton.disabled=busy||initializing;openButton.textContent=!ready?'重试连接':initializingConnection()?(connected?'重新检测':'重试连接'):'打开任务管理器'}
function showMode(){if(heading)heading.textContent=initializingConnection()?'连接 Codex':'时序任务管理器';if(intro)intro.textContent=initializingConnection()?'完成后返回任务管理器即可。':'安排下一步，让任务按时开始。'}
function readResult(result){if(result?.isError)throw new Error('连接未完成，请重试。');let value=result?.structuredContent;if(!value){const text=(result?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');try{value=JSON.parse(text)}catch{throw new Error('未能读取连接结果，请重试。')}}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('未能读取连接结果，请重试。');return value}
function readUrl(value){let url;try{url=new URL(value.url)}catch{throw new Error('管理器地址无效，请重试。')}if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/')throw new Error('管理器地址无效，请重试。');return url.href}
async function openManager(prepared){if(busy||!ready)return;const revision=contextRevision,initialize=initializingConnection();busy=true;connected=false;openButton.disabled=true;openButton.textContent=initialize?'正在连接…':'正在打开…';status.textContent=initialize?'正在检测连接…':'正在启动任务管理器…';try{const result=prepared||await request('tools/call',{name:'scheduler_open',arguments:{}});if(revision!==contextRevision)return;const value=readResult(result);if(initialize){if(value.desktop?.connected!==true)throw new Error(value.desktop?.message||'连接尚未完成，请重试。');connected=true;status.textContent='连接成功，可返回任务管理器。';return}const answer=await request('ui/open-link',{url:readUrl(value)});if(revision!==contextRevision)return;if(answer?.isError)throw new Error('无法自动打开，请使用桌面上的“时序任务管理器”。');status.textContent='管理器已打开。'}catch(error){if(revision===contextRevision)status.textContent=error?.message||'连接失败，请重试。'}finally{if(revision===contextRevision){busy=false;showButton()}}}
function autoOpen(){if(!ready||(!initializingConnection()&&hostContext.displayMode!=='fullscreen')||!initialResult||openedAutomatically)return;openedAutomatically=true;void openManager(initialResult)}
function updateContext(update){if(!update||typeof update!=='object'||Array.isArray(update))return;const previous=contextPath();hostContext={...hostContext,...update};showMode();if(previous!==contextPath()){contextRevision++;busy=false;connected=false;initialResult=null;openedAutomatically=false;if(ready){showButton();if(initializingConnection()||hostContext.displayMode==='fullscreen'){openedAutomatically=true;void openManager()}}}}
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=='2.0')return;if(message.id!==undefined&&pending.has(message.id)){const operation=pending.get(message.id);pending.delete(message.id);clearTimeout(operation.timer);if(message.error)operation.reject(message.error);else operation.resolve(message.result);return}if(message.method==='ui/notifications/host-context-changed'){updateContext(message.params);return}if(message.method==='ui/notifications/tool-result'){initialResult=message.params;autoOpen()}},{passive:true});
async function initialize(){if(initializing)return;initializing=true;openButton.disabled=true;openButton.textContent='正在连接…';try{const initialized=await request('ui/initialize',{appInfo:{name:'codex-scheduler-launcher',version:'0.4.1'},appCapabilities:{},protocolVersion:'2026-01-26'});const prepared=initialResult;updateContext(initialized?.hostContext);initialResult=prepared;notify('ui/notifications/initialized',{});ready=true;status.textContent=initializingConnection()?'正在检测连接，可点击重试。':'点击即可打开，无需发送聊天消息。';autoOpen()}catch{ready=false;status.textContent='连接失败，请重试。'}finally{initializing=false;showButton()}}
openButton.addEventListener('click',()=>void(ready?openManager():initialize()));
void initialize();
</script></body></html>`;

export function launcherResource() {
  return { uri: LAUNCHER_URI, name: '时序任务管理器', description: '时序定时任务管理器的原生点击入口。', mimeType: LAUNCHER_MIME };
}

export function readLauncherResource(uri) {
  if (uri !== LAUNCHER_URI) throw new Error('未知的插件界面。');
  return { contents: [{ uri: LAUNCHER_URI, mimeType: LAUNCHER_MIME, text: launcherHtml, _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] } } }] };
}
