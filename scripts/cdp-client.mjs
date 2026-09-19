export async function listTargets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return []; }
}

export async function connectPage(port, options = {}) {
  // Obsidian opens modals in a separate window, so callers can select a target other than the main one.
  const match = options.match ?? 'app://obsidian.md/index.html';
  const origin = options.origin === undefined ? 'app://obsidian.md' : options.origin;
  const probe = options.probe ?? '!!(window.app&&window.app.vault&&window.app.workspace&&window.app.plugins)';
  const deadline=Date.now()+30000; let page;
  while(Date.now()<deadline){
    try {const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      // Target the real Obsidian window, never popups or about:blank debugging targets.
      page=pages.find(p=>p.type==='page'&&(typeof match==='function'?match(p):p.url===match));if(page)break;}catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  if(!page)throw Error('Target window not found: '+String(match));
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let id=0;const pending=new Map(),contexts=[],errors=[],requests=[],failedRequests=[];
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.method==='Runtime.executionContextCreated')contexts.push(m.params.context);
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);
    if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);
    if(m.method==='Network.loadingFailed')failedRequests.push(m.params.errorText);
    if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}
  };
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout: '+method));},10000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
  await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
  // Wait until the plugin host is actually ready; a fresh window has no title yet.
  let context=null;const readyDeadline=Date.now()+30000;
  while(Date.now()<readyDeadline&&!context){
    const candidate=contexts.find(c=>c.auxData?.isDefault&&(origin===null||c.origin===origin));
    if(candidate){
      try{const ready=await call('Runtime.evaluate',{contextId:candidate.id,expression:probe,returnByValue:true});
        if(ready?.result?.value===true)context=candidate;}catch{}
    }
    if(!context)await new Promise(r=>setTimeout(r,200));
  }
  if(!context){ws.close();throw Error('Context was not ready for '+String(match));}
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{contextId:context.id,expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const wait=async(expression,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Condition timed out: '+expression);};
  const click=async selector=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);const rect=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);if(!rect.w||!rect.h)throw Error('Element not visible: '+selector);await call('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1});};
  const type=async(selector,text)=>{await click(selector);await call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});if(text)await call('Input.insertText',{text});};
  return {call,evaluate,wait,click,type,errors,requests,failedRequests,close(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'));}pending.clear();ws.close();}};
}
