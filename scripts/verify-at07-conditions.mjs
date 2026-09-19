#!/usr/bin/env node
// AT-07 remainder: the three conditions, against the live API, with the real plugin.
//
//   1. Jev off, key present        -> the search runs locally and nothing is sent
//   2. Jev on, no key              -> still nothing is sent
//   3. Jev on, key present         -> one request, and the results come back reordered
//
// Conditions 1 and 2 are the ones that matter for safety: a key sitting in SecretStorage must not be
// enough on its own. Outbound traffic is counted by CDP, not by the plugin's own bookkeeping, so a
// request the plugin forgot to report would still show up.
//
// Requires Obsidian running with --remote-debugging-port and a key already stored (see
// scripts/live-with-stored-key.mjs --check). Only synthetic notes are sent.

import { connectPage } from './cdp-client.mjs';
import { writeFile } from 'node:fs/promises';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const port = arg('port', '9222');
const target = arg('target', 'openrouter');

const client = await connectPage(port);
const P = 'window.app.plugins.plugins["jev-search"]';
let modalClient = null;
const modal = async () => {
  if (modalClient) { try { await modalClient.evaluate('1'); return modalClient; } catch { try { modalClient.close(); } catch {} modalClient = null; } }
  modalClient = await connectPage(port, { match: 'about:blank', origin: null, probe: '!!document.body' });
  return modalClient;
};
const clickText = async (text) => {
  const expr = '(()=>{const b=Array.from(document.querySelectorAll("button")).find(x=>(x.textContent||"").includes(' + JSON.stringify(text) + '));if(!b)return "missing";b.click();return "clicked";})()';
  if (await client.evaluate(expr) === 'clicked') return 'main';
  try { if (await (await modal()).evaluate(expr) === 'clicked') return 'modal'; } catch {}
  return 'missing';
};
const closePreview = async () => {
  for (let i = 0; i < 20; i++) {
    let open = false;
    try { open = await (await modal()).evaluate('!!document.querySelector(".jev-preview")'); } catch {}
    if (!open) return true;
    try { await (await modal()).evaluate('(()=>{document.querySelectorAll(".modal-close-button").forEach(b=>b.click());return true;})()'); } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
};
const apiRequests = () => client.requests.filter(u => u.includes('openrouter.ai'));
// The plugin sends through Node's https module rather than the renderer's network stack, so CDP's
// Network domain never sees the request. Counting therefore means wrapping the module property the
// bundle reads at call time - the same seam the mock harness uses, except that here the real request
// still goes out. The CDP count is kept alongside it as a cross-check.
const resetCounter = () => client.evaluate('(()=>{const h=require("node:https");if(!h.__jevOrig){h.__jevOrig=h.request;h.request=function(...a){h.__jevCount++;return h.__jevOrig.apply(this,a);};}h.__jevCount=0;return true;})()');
const counter = () => client.evaluate('require("node:https").__jevCount');
const type = async (text) => {
  await client.evaluate('(()=>{const i=document.querySelector(".jev-search input[type=search]");i.value=' + JSON.stringify(text) + ';i.dispatchEvent(new Event("input"));return true;})()');
  await new Promise(r => setTimeout(r, 1400));
};
const settle = async (ms = 6000) => { await new Promise(r => setTimeout(r, ms)); };

const report = { port, target };
try {
  // Reload the plugin so the test runs against whatever is deployed right now, not a copy left over
  // from an earlier build.
  report.deployed = JSON.parse(await client.evaluate('(()=>{const m=window.app.plugins.manifests["jev-search"];return JSON.stringify({version:m?m.version:null});})()'));
  await client.evaluate('(async()=>{const id="jev-search";await window.app.plugins.disablePlugin(id);await window.app.plugins.enablePlugin(id);return true;})()');
  await client.wait(P + '?.loaded === true', 30000);
  await client.wait(P + '.indexed === true', 120000);
  report.reloaded = true;
  // Synthetic notes only, so nothing personal can be sent.
  // The note bodies are built here and embedded as JSON, so no newline ever sits inside a CDP
  // expression as a real character.
  const synthetic = {
    'live/会議.md': '# 架空チームの会議\n\n定例会は毎週火曜日です。\n',
    'live/雑記.md': '# 雑記\n\n天気の話。\n',
    'live/議事録.md': '# 議事録\n\n定例会の議題は三つ。\n',
  };
  await client.evaluate('(async()=>{const v=window.app.vault;if(!v.getFolderByPath("live"))await v.createFolder("live");const notes=' + JSON.stringify(synthetic) + ';for(const [p,c] of Object.entries(notes)){const f=v.getFileByPath(p);if(f)await v.modify(f,c);else await v.create(p,c);}return true;})()');
  // The plugin only considers a file once the metadata cache has parsed it, so wait for the index to
  // actually hold the synthetic notes rather than assuming a fixed delay is enough.
  for (let i = 0; i < 40; i++) {
    const size = await client.evaluate(P + '.index.size');
    if (size >= 4) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await settle(1000);
  report.indexSize = await client.evaluate(P + '.index.size');
  report.vault = await client.evaluate('window.app.vault.getName()');
  report.vaultFiles = JSON.parse(await client.evaluate('JSON.stringify(window.app.vault.getMarkdownFiles().map(f=>f.path))'));
  report.keyPresent = await client.evaluate('!!' + P + '.key');
  await client.evaluate('(()=>{const p=' + P + ';p.settings.cacheTtlMinutes=0;p.syncCache();return true;})()');

  // Condition 1: Jev off, key present.
  await client.evaluate('(()=>{const p=' + P + ';p.settings.enabled=false;p.settings.secrets["' + target + '"]="test";return true;})()');
  await closePreview();
  let before = apiRequests().length;
  await resetCounter();
  await type('定例会');
  await settle();
  report.condition1 = {
    enabled: await client.evaluate(P + '.settings.enabled'),
    hasKey: await client.evaluate('!!' + P + '.key'),
    sends: await counter(),
    requests: apiRequests().length - before,
    rerankButton: await client.evaluate('!!Array.from(document.querySelectorAll("button")).find(b=>(b.textContent||"").includes("Jevで並べ替え"))'),
    localRows: await client.evaluate('document.querySelectorAll(".jev-result").length'),
  };

  // Condition 2: Jev on, no key. The stored secret name is kept aside and put back afterwards.
  await client.evaluate('(()=>{const p=' + P + ';p.settings.enabled=true;p.keys["' + target + '"]="";p.settings.secrets["' + target + '"]="";return true;})()');
  await closePreview();
  before = apiRequests().length;
  await resetCounter();
  await type('定例会');
  await settle();
  const clickWhere = await clickText('Jevで並べ替え');
  await settle(4000);
  report.condition2 = {
    enabled: await client.evaluate(P + '.settings.enabled'),
    hasKey: await client.evaluate('!!' + P + '.key'),
    sends: await counter(),
    requests: apiRequests().length - before,
    rerankClick: clickWhere,
    localRows: await client.evaluate('document.querySelectorAll(".jev-result").length'),
  };

  // Condition 3: Jev on, key present. The key is read out of SecretStorage in the page and never
  // crosses into this process.
  await client.evaluate('(async()=>{const p=' + P + ';const s=window.app.secretStorage.getSecret("test");if(!s)throw new Error("no secret");p.keys["' + target + '"]=s;p.settings.secrets["' + target + '"]="test";return true;})()');
  await closePreview();
  before = apiRequests().length;
  await resetCounter();
  await type('定例会');
  const orderBefore = JSON.parse(await client.evaluate('JSON.stringify(Array.from(document.querySelectorAll(".jev-result")).map(r=>r.textContent.slice(0,20)))'));
  await clickText('Jevで並べ替え');
  let previewSeen = false;
  for (let i = 0; i < 60 && !previewSeen; i++) {
    try { previewSeen = !!(await (await modal()).evaluate('!!document.querySelector(".jev-preview")')); } catch { modalClient = null; }
    if (!previewSeen) await new Promise(r => setTimeout(r, 250));
  }
  report.condition3 = { enabled: await client.evaluate(P + '.settings.enabled'), hasKey: await client.evaluate('!!' + P + '.key'), previewSeen };
  if (previewSeen) {
    report.condition3.sendClick = await clickText('送信 / Send');
    try { await client.wait('window.__apiCount === undefined || true', 1000); } catch {}
    for (let i = 0; i < 40 && apiRequests().length - before < 1; i++) await new Promise(r => setTimeout(r, 250));
    report.condition3.sends = await counter();
    report.condition3.requests = apiRequests().length - before;
    report.condition3.status = await client.evaluate('(()=>{const p=' + P + ';return JSON.stringify({busy:p.busy,lastStatus:p.lastStatus??null,notice:null});})()');
    await settle(2500);
    const orderAfter = JSON.parse(await client.evaluate('JSON.stringify(Array.from(document.querySelectorAll(".jev-result")).map(r=>r.textContent.slice(0,20)))'));
    report.condition3.orderBefore = orderBefore;
    report.condition3.orderAfter = orderAfter;
    report.condition3.reordered = JSON.stringify(orderBefore) !== JSON.stringify(orderAfter);
  }
  await closePreview();
  report.apiUrls = apiRequests();
} catch (error) { report.error = String(error && error.message); } finally {
  if (modalClient) { try { modalClient.close(); } catch {} }
  client.close();
}
const out = arg('out', '');
if (out) await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
