import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { connectPage } from './cdp-client.mjs';
export async function verifyGui(port=9222,title='vault - Obsidian',output='.sandbox/gui-e2e/evidence',vaultSuffix='.sandbox/gui-e2e/vault') {
  await mkdir(output,{recursive:true});
  const results=[];let client;
  const record=(name,details={})=>{results.push({name,pass:true,...details});console.log('PASS: '+name);};
  const screenshot=async name=>{const shot=await client.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(`${output}/${name}.png`,Buffer.from(shot.data,'base64'));};
  try {
    client=await connectPage(port);
    const vaultPath=String(await client.evaluate(`(window.app?.vault?.adapter?.getBasePath?.()??'').replace(/\\\\/g,'/')`));
    if(!vaultPath.endsWith(vaultSuffix))throw Error('Refusing to automate an unexpected vault: '+vaultPath);
    record('dedicated test vault confirmed',{vaultPath});
    // On a freshly created profile Obsidian may still be finishing plugin startup; enable
    // our plugin explicitly if it is registered but not yet loaded. Safe: dedicated vault only.
    await client.evaluate(`(async()=>{const api=window.app.plugins;if(!api.plugins['jev-search']){try{await api.enablePlugin('jev-search');}catch(e){}}return true;})()`);
    await client.wait(`!!document.querySelector('[aria-label="Jev Search"]')`,30000);
    record('plugin ribbon rendered');
    await client.click('[aria-label="Jev Search"]');
    await client.wait(`!!document.querySelector('.jev-search input[type="search"]')`);
    await client.wait(`document.querySelector('.jev-search [role="status"]')?.textContent.includes('Ready')`);
    record('search view rendered and index ready');await screenshot('01-search-ready');
    const plugin=await client.evaluate(`(()=>{const p=window.app.plugins.plugins['jev-search'];return {loaded:!!p,keyPresent:p?!!p.key:null,externalSendingEnabled:p?p.settings.enabled:null,indexed:p?p.index.size:null};})()`);
    assert.deepEqual({loaded:plugin.loaded,keyPresent:plugin.keyPresent,externalSendingEnabled:plugin.externalSendingEnabled},{loaded:true,keyPresent:false,externalSendingEnabled:false});
    record('plugin loaded with external sending off by default',plugin);
    const started=Date.now();
    await client.type('.jev-search input[type="search"]','定例会');
    await client.wait(`Array.from(document.querySelectorAll('.jev-search .jev-result button')).some(x=>x.textContent==='Meeting.md')`);
    const searchMs=Date.now()-started;
    const text=await client.evaluate(`document.querySelector('.jev-search').innerText`);
    assert.ok(text.includes('毎週火曜日'));assert.ok(!text.includes('Cooking.md'));
    record('query 定例会 returns Meeting.md and Tuesday excerpt',{query:'定例会',searchMs});
    await screenshot('02-meeting-hit');
    await client.click('.jev-search .jev-result button');
    await client.wait(`!!document.querySelector('.workspace-leaf.mod-active .view-header-title')?.textContent.includes('Meeting')`);
    record('result click opens Meeting');await screenshot('03-note-opened');
    await client.type('.jev-search input[type="search"]','ZZZunfindable8899');
    await client.wait(`document.querySelectorAll('.jev-search .jev-result').length===0`);
    record('unmatched query renders zero results');await screenshot('04-no-results');
    assert.equal(client.errors.length,0,'Unexpected renderer exception');
    const external=client.requests.filter(url=>/typesafe|api\.|ai-gateway|vercel/i.test(url));
    assert.deepEqual(external,[],'No external API request may occur without approval');
    record('no external request during local-only flow',{totalRequests:client.requests.length,external});
    const report={pass:true,results,rendererErrors:client.errors,observedRequests:client.requests,completedAt:new Date().toISOString()};
    await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));return report;
  } catch(error){
    if(client)try{await screenshot('failure');}catch{}
    const report={pass:false,results,error:String(error?.stack??error),rendererErrors:client?.errors??[]};
    await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));throw error;
  } finally {client?.close();}
}
if(process.argv.includes('--attach'))await verifyGui();
