#!/usr/bin/env node
// AT-11 / AT-12: load the plugin against a large vault in a real Obsidian instance.
//
// The index build is sequential and yields to the event loop after every note, so the wall-clock
// cost is CPU plus one task per note. This measures both, and samples frame gaps and long tasks to
// see whether the UI actually freezes.
//
// The plugin is listed in community-plugins.json so Obsidian loads it during startup, the way a real
// user's vault does. Indexing starts from onLayoutReady, so the timer runs from layoutReady until
// plugin.indexed flips to true.

import { obsidianExe } from './obsidian-exe.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connectPage } from './cdp-client.mjs';

const OBSIDIAN = obsidianExe();
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const vault = arg('vault', '.sandbox/load-vault');
const profile = arg('profile', '.sandbox/load-profile');
const port = Number(arg('port', '9260'));
const timeoutMs = Number(arg('timeout', '300000'));

const pluginDir = join(vault, '.obsidian', 'plugins', 'jev-search');
await mkdir(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join('dist', file), join(pluginDir, file));
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['jev-search']));
await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({
  vaults: { loadtest: { path: resolve(vault).replace(/\//g, '\\'), ts: Date.now(), open: true } },
}));

const child = spawn(OBSIDIAN, [
  '--remote-debugging-port=' + port,
  '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + resolve(profile).replace(/\//g, '\\'),
], { detached: true, stdio: 'ignore' });
const stop = () => { if (!child?.pid) return; try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

try {
  const client = await connectPage(port);
  await client.wait('!!window.app && !!window.app.vault', 180000);
  await client.evaluate('(()=>{' +
    'window.__lt={longTasks:[],frames:[],last:performance.now()};' +
    'try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.longTasks.push(Math.round(e.duration));}).observe({entryTypes:["longtask"]});}catch(e){}' +
    'const tick=()=>{const n=performance.now();window.__lt.frames.push(Math.round(n-window.__lt.last));window.__lt.last=n;if(window.__lt.running!==false)requestAnimationFrame(tick);};' +
    'window.__lt.running=true;requestAnimationFrame(tick);return true;})()');

  await client.wait('window.app.workspace.layoutReady === true', 180000);
  const noteCount = Number(await client.evaluate('window.app.vault.getMarkdownFiles().length'));
  const started = Date.now();
  await client.wait('window.app.plugins.plugins["jev-search"]?.indexed === true', timeoutMs);
  const indexMs = Date.now() - started;

  const out = JSON.parse(await client.evaluate('(()=>{' +
    'window.__lt.running=false;const p=window.app.plugins.plugins["jev-search"];const f=window.__lt.frames.slice(1);f.sort((a,b)=>b-a);' +
    'const mem=performance.memory?{usedMB:Math.round(performance.memory.usedJSHeapSize/1048576),limitMB:Math.round(performance.memory.jsHeapSizeLimit/1048576)}:null;' +
    'return JSON.stringify({indexedNotes:p.index.size,skipped:p.skipped,indexMs:' + indexMs + ',noteCount:' + noteCount + ',' +
    'longTaskCount:window.__lt.longTasks.length,longTaskMaxMs:window.__lt.longTasks.length?window.__lt.longTasks.reduce((a,b)=>Math.max(a,b),0):0,' +
    'longTaskTotalMs:window.__lt.longTasks.reduce((a,b)=>a+b,0),' +
    'frameSamples:f.length,frameMaxGapMs:f.length?f[0]:0,frameP95GapMs:f.length?f[Math.floor(f.length*0.05)]:0,framesOver200ms:f.filter(x=>x>200).length,' +
    'mem:mem,visibility:document.visibilityState});})()'));

  // Notes whose metadata cache entry is not ready yet are skipped by rebuild() and must be picked up
  // later by the metadataCache 'changed' event. Measure whether the index actually settles complete.
  await new Promise(r => setTimeout(r, 25000));
  const settled = JSON.parse(await client.evaluate('(()=>{const p=window.app.plugins.plugins["jev-search"];return JSON.stringify({settledNotes:p.index.size,settledSkipped:p.skipped,settledIndexed:p.indexed});})()'));

  const queries = JSON.parse(await client.evaluate('(()=>{const p=window.app.plugins.plugins["jev-search"];const runs=[];' +
    'for(const q of ["定例会","経費精算の締め日","VPN","デプロイ","存在しない語句ZZZ"]){const t=performance.now();const hits=p.index.search(q,50);runs.push({q,ms:+(performance.now()-t).toFixed(1),hits:hits.length});}' +
    'return JSON.stringify(runs);})()'));

  const report = { ...out, ...settled, queries, vault, at: new Date().toISOString() };
  await writeFile(arg('out', '.sandbox/load-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  client.close();
} catch (error) {
  console.log('ERROR ' + String(error && error.message));
  process.exitCode = 1;
} finally { stop(); }
