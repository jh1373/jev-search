#!/usr/bin/env node
// AT-03 / AT-04 / AT-06 / AT-15 / AT-17 verified against a controlled transport.
//
// The bundle calls (0, import_node_https.request)(...), so replacing the module's request property
// intercepts it. This exercises the plugin's own handling of a response without sending anything or
// using a key. The real API contract is a separate question (AT-07).
//
// Obsidian 1.13.4 opens modals in a separate window, so the consent dialog is driven through its own
// CDP target rather than the main one.

import { obsidianExe } from './obsidian-exe.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { connectPage } from './cdp-client.mjs';

const OBSIDIAN = obsidianExe();
const vault = '.sandbox/at-mock-vault', profile = '.sandbox/at-mock-profile', port = 9313;

await rm(vault, { recursive: true, force: true });
await mkdir(join(vault, 'notes'), { recursive: true });
for (let i = 0; i < 24; i++) await writeFile(join(vault, 'notes', 'mocknote' + i + '.md'), '# 定例会 見出し ' + i + '\n定例会は毎週火曜日です。mockbody' + i + ' の本文。\n');
// These carry a different term so the other scenarios keep their own candidate set, and they are long
// enough that twenty of them cannot fit the 24KiB request budget.
for (let i = 0; i < 25; i++) {
  await writeFile(join(vault, 'notes', 'bulknote' + i + '.md'), '# 巨大ノート ' + i + '\n巨大ノートの本文。' + '計測用の長い段落をここに置く。'.repeat(120) + '\n');
}
const pluginDir = join(vault, '.obsidian', 'plugins', 'jev-search');
await mkdir(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join('dist', file), join(pluginDir, file));
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['jev-search']));
await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({
  vaults: { atmock: { path: resolve(vault).replace(/\//g, '\\'), ts: Date.now(), open: true } },
}));

const child = spawn(OBSIDIAN, [
  '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + resolve(profile).replace(/\//g, '\\'),
], { detached: true, stdio: 'ignore' });
let exited = false;
child.on('exit', () => { exited = true; });
const stop = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

const report = { scenarios: [] };
try {
  const client = await connectPage(port);
  const P = 'window.app.plugins.plugins["jev-search"]';
  await client.wait(P + '?.indexed === true', 180000);

  await client.evaluate('(()=>{' +
    'const {EventEmitter}=require("node:events");const https=require("node:https");' +
    'window.__mock={requests:[],score:2,delayMs:0,mode:"ok",status:200,retryAfter:null,raw:null};' +
    'const dist=s=>s===2?{"0":0,"1":0,"2":1}:s===1?{"0":0.2,"1":0.6,"2":0.2}:{"0":1,"1":0,"2":0};' +
    'https.request=function(url,options,callback){' +
    '  const req=new EventEmitter();let body="";' +
    '  req.end=chunk=>{body=String(chunk??"");window.__mock.requests.push({url:String(url),headers:options&&options.headers,body});' +
    '    if(window.__mock.mode==="hang")return;' +
    '    const send=()=>{if(req.destroyed)return;const res=new EventEmitter();' +
    '      res.statusCode=window.__mock.status;res.headers=window.__mock.retryAfter?{"retry-after":window.__mock.retryAfter}:{};' +
    '      let payload=window.__mock.raw;' +
    '      if(payload===null){const parsed=JSON.parse(body);const answers={};' +
    '        for(const k of Object.keys(parsed.questions))answers[k]={type:"score",score:window.__mock.score,confidence:0.9,probabilities:dist(window.__mock.score)};' +
    '        payload=JSON.stringify({model:"typesafe/jev-1.13",answers,usage:{input_tokens:120,cost:0.000005}});}' +
    '      callback(res);res.emit("data",Buffer.from(payload));res.emit("end");};' +
    '    setTimeout(send,window.__mock.delayMs);};' +
    '  req.destroy=err=>{req.destroyed=true;if(err)req.emit("error",err);req.emit("close");};' +
    '  return req;};' +
    'return true;})()');

  // The judgement cache is correct behaviour but would swallow repeated identical scenarios, so these
  // transport and response tests run with it off. Cache behaviour is AT-18.
  await client.evaluate('(async()=>{const p=' + P + ';p.settings.enabled=true;p.keys.openrouter="mock-key";p.settings.cacheTtlMinutes=0;p.syncCache();await p.open();return true;})()');
  await client.wait('!!document.querySelector(".jev-search input[type=search]")');

  let modalClient = null;
  const modal = async () => {
    if (!modalClient) modalClient = await connectPage(port, { match: 'about:blank', origin: null, probe: '!!document.body' });
    return modalClient;
  };
  const clickText = async (text) => {
    const expr = '(()=>{const b=Array.from(document.querySelectorAll("button")).find(x=>(x.textContent||"").includes(' + JSON.stringify(text) + '));if(!b)return "missing";b.click();return "clicked";})()';
    if (await client.evaluate(expr) === 'clicked') return 'main';
    if (await (await modal()).evaluate(expr) === 'clicked') return 'modal';
    return 'missing';
  };
  // The consent window is reused, so make sure no preview from an earlier scenario is still mounted.
  const ensureNoPreview = async () => {
    const m = await modal();
    for (let i = 0; i < 25; i++) {
      if (!await m.evaluate('!!document.querySelector(".jev-preview")')) return true;
      await m.evaluate('(()=>{document.querySelectorAll(".modal-close-button").forEach(b=>b.click());return true;})()');
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  };
  const step = async (name, fn) => {
    try { report.scenarios.push({ name, ...(await fn()) }); }
    catch (e) { report.scenarios.push({ name, error: String(e && e.message) }); }
  };
  // Open a fresh preview, approve it, and confirm a request actually went out.
  const rerankAndApprove = async () => {
    const clean = await ensureNoPreview();
    await type('定例会');
    await clickText('Jevで並べ替え');
    const m = await modal();
    await m.wait('!!document.querySelector(".jev-preview")', 25000);
    const preview = await m.evaluate('document.querySelector(".jev-preview").textContent');
    const before = await requests();
    const sendWhere = await clickText('送信 / Send');
    let sent = false;
    try { await client.wait('window.__mock.requests.length > ' + before, 8000); sent = true; } catch {}
    const state = JSON.parse(await client.evaluate('(()=>{const p=' + P + ';return JSON.stringify({busy:p.busy,hasKey:!!p.key,enabled:p.settings.enabled,controller:!!p.controller});})()'));
    return { clean, sendWhere, sent, preview, previewHash: hash(preview), state };
  };
  const reset = async (opts = {}) => {
    await client.evaluate('(()=>{Object.assign(window.__mock,{requests:[],mode:"ok",status:200,retryAfter:null,raw:null,delayMs:0,score:2});Object.assign(window.__mock,' + JSON.stringify(opts) + ');return true;})()');
    await client.evaluate('(()=>{const p=' + P + ';p.controller?.abort();p.busy=false;return true;})()');
    await new Promise(r => setTimeout(r, 300));
  };
  const type = async (text) => {
    await client.evaluate('(()=>{const i=document.querySelector(".jev-search input[type=search]");i.value=' + JSON.stringify(text) + ';i.dispatchEvent(new Event("input"));return true;})()');
    await new Promise(r => setTimeout(r, 400));
  };
  const status = () => client.evaluate('document.querySelector(".jev-search [role=status]")?.textContent ?? null');
  const results = () => client.evaluate('(()=>Array.from(document.querySelectorAll(".jev-result button")).map(b=>b.textContent))()');
  const requests = () => client.evaluate('window.__mock.requests.length');
  const send = async () => { await clickText('送信 / Send'); };
  const openPreview = async () => { await type('定例会'); await clickText('Jevで並べ替え'); return waitPreview(); };

  const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

  await step('AT-03 preview equals sent', async () => {
    await reset();
    const { clean, sendWhere, sent: ok, preview, previewHash } = await rerankAndApprove();
    if (!ok) return { clean, sendWhere, previewHash, sent: false };
    const sent = await client.evaluate('window.__mock.requests[0].body');
    return { clean, sendWhere, match: preview === sent, previewHash: hash(preview), sentHash: hash(sent), bytes: Buffer.byteLength(preview), sentTo: await client.evaluate('window.__mock.requests[0].url'), authorization: await client.evaluate('String(window.__mock.requests[0].headers.Authorization).slice(0,10)') };
  });

  await step('AT-04 high score', async () => {
    await reset({ score: 2 });
    await rerankAndApprove();
    await new Promise(r => setTimeout(r, 900));
    return { status: await status(), rows: (await results()).length };
  });

  await step('AT-04 all low keeps local order', async () => {
    await reset({ score: 0 });
    await type('定例会');
    const before = await results();
    await rerankAndApprove();
    await new Promise(r => setTimeout(r, 900));
    return { status: await status(), orderUnchanged: JSON.stringify(before) === JSON.stringify(await results()) };
  });

  await step('AT-04 invalid response', async () => {
    await reset({ raw: JSON.stringify({ model: 'typesafe/other', answers: {}, usage: {} }) });
    await rerankAndApprove();
    await new Promise(r => setTimeout(r, 900));
    return { status: await status() };
  });

  await step('AT-06 late response ignored', async () => {
    await reset({ delayMs: 2500, score: 2 });
    await rerankAndApprove();
    await type('mockbody7');
    await new Promise(r => setTimeout(r, 3500));
    return { status: await status(), topRow: (await results())[0] ?? null };
  });

  await step('AT-15 deadline', async () => {
    await reset({ mode: 'hang' });
    const start = Date.now();
    await rerankAndApprove();
    await client.wait('(document.querySelector(".jev-search [role=status]")?.textContent ?? "").includes("Local fallback")', 15000);
    return { elapsedMs: Date.now() - start, status: await status() };
  });

  await step('AT-15 retry-after', async () => {
    await reset({ status: 429, retryAfter: '0' });
    await rerankAndApprove();
    await new Promise(r => setTimeout(r, 2000));
    const shortRetry = await requests();
    await reset({ status: 429, retryAfter: '600' });
    await rerankAndApprove();
    await new Promise(r => setTimeout(r, 1500));
    return { shortRetryRequests: shortRetry, longRetryRequests: await requests(), longRetryStatus: await status() };
  });

  await step('AT-15 cancel spam', async () => {
    await reset({ mode: 'hang' });
    await rerankAndApprove();
    for (let i = 0; i < 10; i++) await clickText('取消');
    await new Promise(r => setTimeout(r, 1200));
    return { requests: await requests() };
  });

  await step('AT-17 candidate removed during preview', async () => {
    await reset();
    const clean = await ensureNoPreview();
    await type('定例会');
    await clickText('Jevで並べ替え');
    const m = await modal();
    await m.wait('!!document.querySelector(".jev-preview")', 25000);
    const removed = await client.evaluate('(async()=>{const f=window.app.vault.getFileByPath("notes/mocknote0.md");if(!f)return "absent";await window.app.vault.delete(f);return "deleted";})()');
    const before = await requests();
    await clickText('送信 / Send');
    await new Promise(r => setTimeout(r, 1500));
    return { clean, removed, newRequests: (await requests()) - before, status: await status() };
  });

  await step('AT-16 budget stops before twenty candidates', async () => {
    await reset();
    await ensureNoPreview();
    await type('巨大ノート');
    await clickText('Jevで並べ替え');
    const m = await modal();
    await m.wait('!!document.querySelector(".jev-preview")', 25000);
    const preview = await m.evaluate('document.querySelector(".jev-preview").textContent');
    const before = await requests();
    await clickText('送信 / Send');
    await client.wait('window.__mock.requests.length > ' + before, 25000);
    const sent = await client.evaluate('window.__mock.requests[0].body');
    const parsed = JSON.parse(sent);
    await new Promise(r => setTimeout(r, 900));
    return {
      candidates: 25,
      documentsSent: parsed.documents.length,
      bytes: Buffer.byteLength(sent),
      withinBudget: Buffer.byteLength(sent) <= 24576,
      previewMatchesSent: preview === sent,
      status: await status(),
    };
  });

  await step('AT-19 IME does not search mid-composition', async () => {
    await reset();
    await ensureNoPreview();
    await client.evaluate('(()=>{const i=document.querySelector(".jev-search input[type=search]");i.value="";i.dispatchEvent(new Event("input"));return true;})()');
    await new Promise(r => setTimeout(r, 600));
    const before = await status();
    await client.evaluate('(()=>{const i=document.querySelector(".jev-search input[type=search]");i.dispatchEvent(new CompositionEvent("compositionstart"));i.value="定例会";i.dispatchEvent(new Event("input"));return true;})()');
    await new Promise(r => setTimeout(r, 700));
    const during = await status();
    await client.evaluate('(()=>{const i=document.querySelector(".jev-search input[type=search]");i.dispatchEvent(new CompositionEvent("compositionend"));return true;})()');
    await new Promise(r => setTimeout(r, 700));
    const after = await status();
    return { before, during, after, suppressedWhileComposing: during === before, searchedAfterCommit: (await results()).length > 0 };
  });

  await step('AT-19 Escape closes the preview without sending', async () => {
    await reset();
    await ensureNoPreview();
    await type('定例会');
    await clickText('Jevで並べ替え');
    const m = await modal();
    await m.wait('!!document.querySelector(".jev-preview")', 25000);
    await m.evaluate('(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",code:"Escape",keyCode:27,which:27,bubbles:true}));return true;})()');
    await new Promise(r => setTimeout(r, 900));
    return { previewGone: !(await m.evaluate('!!document.querySelector(".jev-preview")')), requests: await requests() };
  });

  await step('AT-19 zoom 200% keeps the view usable', async () => {
    await reset();
    const applied = await client.evaluate('(()=>{try{const {webFrame}=require("electron");webFrame.setZoomFactor(2);return "webFrame";}catch(e){document.body.style.zoom="200%";return "css";}})()');
    await new Promise(r => setTimeout(r, 400));
    await type('定例会');
    const rows = (await results()).length;
    await client.evaluate('(()=>{try{require("electron").webFrame.setZoomFactor(1);}catch(e){document.body.style.zoom="";}return true;})()');
    return { applied, rows, status: await status() };
  });

  if (modalClient) modalClient.close();
  await client.evaluate('window.close()').catch(() => {});
  client.close();
  for (let i = 0; i < 60 && !exited; i++) await new Promise(r => setTimeout(r, 500));
  report.gracefulExit = exited;
} catch (error) {
  report.error = String(error && error.message);
} finally { if (!exited) stop(); }

console.log(JSON.stringify(report, null, 2));
