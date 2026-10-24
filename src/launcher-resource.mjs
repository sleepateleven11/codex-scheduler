export const LAUNCHER_URI = 'ui://codex-scheduler/launcher-v0.3.4.html';
export const LAUNCHER_MIME = 'text/html;profile=mcp-app';

// A native entrypoint only launches the existing, authenticated local manager.
// It never embeds localhost, grants network permissions, or sends model input.
export const launcherHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>时序任务管理器</title><style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color-scheme:light dark;color:light-dark(#222238,#eeeefa);background:light-dark(#f7f6fc,#1f1f2d)}
body{margin:0;min-height:100vh;display:grid;place-items:center}.card{max-width:520px;padding:40px;text-align:center}h1{font-size:28px;margin:18px 0 12px}p{line-height:1.8;opacity:.75}.logo{font-size:38px}button{border:0;border-radius:12px;background:#795cdb;color:white;padding:14px 24px;font:inherit;cursor:pointer}button:disabled{opacity:.6;cursor:wait}#status{min-height:56px;font-size:14px}small{display:block;margin-top:28px;opacity:.55;line-height:1.8}
</style></head><body><main class="card"><div class="logo" aria-hidden="true">⌛</div><h1>时序任务管理器</h1><p>安排下一步，让任务按时开始。</p><button id="open" disabled>正在连接…</button><p id="status" role="status" aria-live="polite">正在连接 Codex 插件。</p><small>打开管理器无需发送聊天消息。<br>也可以从桌面或开始菜单直接打开。</small></main>
<script>
const openButton=document.getElementById('open'),status=document.getElementById('status');
let rpcId=0,ready=false,busy=false,initialResult=null,openedAutomatically=false,fullscreenEntry=false;
const pending=new Map();
function request(method,params){return new Promise((resolve,reject)=>{const id=++rpcId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('连接暂时没有响应，请再试一次。'))},20000);pending.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*')})}
function notify(method,params){window.parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function readUrl(result){if(result?.isError)throw new Error('管理器暂时无法启动，请打开 Codex 后重试。');let value=result?.structuredContent;if(!value){const text=(result?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');value=JSON.parse(text)}const url=new URL(value.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/')throw new Error('管理器地址无效，请重新加载时序插件。');return url.href}
async function openManager(prepared){if(busy||!ready)return;busy=true;openButton.disabled=true;openButton.textContent='正在打开…';status.textContent='正在启动本地任务管理器。';try{const result=prepared||await request('tools/call',{name:'scheduler_open',arguments:{}});const answer=await request('ui/open-link',{url:readUrl(result)});if(answer?.isError)throw new Error('无法自动打开，请使用桌面上的“时序任务管理器”。');status.textContent='管理器已打开。可以在管理器中创建、编辑和查看任务。'}catch(error){status.textContent=error?.message||'打开失败，请重试。'}finally{busy=false;openButton.disabled=false;openButton.textContent='打开任务管理器'}}
function autoOpen(){if(!ready||!fullscreenEntry||!initialResult||openedAutomatically)return;openedAutomatically=true;void openManager(initialResult)}
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=='2.0')return;if(message.id!==undefined&&pending.has(message.id)){const operation=pending.get(message.id);pending.delete(message.id);clearTimeout(operation.timer);if(message.error)operation.reject(message.error);else operation.resolve(message.result);return}if(message.method==='ui/notifications/tool-result'){initialResult=message.params;autoOpen()}},{passive:true});
openButton.addEventListener('click',()=>void openManager());
(async()=>{try{const initialized=await request('ui/initialize',{appInfo:{name:'codex-scheduler-launcher',version:'0.3.4'},appCapabilities:{},protocolVersion:'2026-01-26'});fullscreenEntry=initialized?.hostContext?.displayMode==='fullscreen';notify('ui/notifications/initialized',{});ready=true;openButton.disabled=false;openButton.textContent='打开任务管理器';status.textContent='点击即可打开，无需发送聊天消息。';autoOpen()}catch(error){openButton.textContent='连接尚未就绪';status.textContent='请重新打开这个入口，或使用桌面上的“时序任务管理器”。'}})();
</script></body></html>`;

export function launcherResource() {
  return { uri: LAUNCHER_URI, name: '时序任务管理器', description: '时序定时任务管理器的原生点击入口。', mimeType: LAUNCHER_MIME };
}

export function readLauncherResource(uri) {
  if (uri !== LAUNCHER_URI) throw new Error('未知的插件界面。');
  return { contents: [{ uri: LAUNCHER_URI, mimeType: LAUNCHER_MIME, text: launcherHtml, _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] } } }] };
}
