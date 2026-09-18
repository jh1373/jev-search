import {writeFile} from 'node:fs/promises';
const pages=await(await fetch('http://127.0.0.1:9222/json/list')).json();
const page=pages.find(p=>p.type==='page'&&p.url==='app://obsidian.md/index.html');
if(!page)throw Error('No Obsidian page');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pending=new Map();const contexts=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.executionContextCreated')contexts.push(m.params.context);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},10000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
try {await call('Runtime.enable');await new Promise(r=>setTimeout(r,500));
 for(const c of contexts){const r=await call('Runtime.evaluate',{contextId:c.id,returnByValue:true,expression:`JSON.stringify({app:typeof app,document:typeof document,text:typeof document==='undefined'?'':document.body.innerText.slice(0,6000),buttons:typeof document==='undefined'?[]:Array.from(document.querySelectorAll('[aria-label]')).map(x=>({tag:x.tagName,label:x.getAttribute('aria-label')})).slice(0,80)})`});console.log(JSON.stringify({context:c,result:r}));}
 const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile('.sandbox/gui-e2e/evidence/initial.png',Buffer.from(shot.data,'base64'));
}finally{ws.close();}
