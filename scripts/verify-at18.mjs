#!/usr/bin/env node
// AT-18: the judgement cache must be memory-only, and diagnostics must carry counts and versions
// only. Also checks that the cache is emptied when the setting changes and when the plugin unloads.

import { obsidianExe } from './obsidian-exe.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connectPage } from './cdp-client.mjs';

const OBSIDIAN = obsidianExe();
const vault = '.sandbox/at18-vault', profile = '.sandbox/at18-profile', port = 9300;

await rm(vault, { recursive: true, force: true });
await mkdir(join(vault, 'secret-notes'), { recursive: true });
for (let i = 0; i < 12; i++) await writeFile(join(vault, 'secret-notes', 'secretnote' + i + '.md'), '# 極秘見出し ' + i + '\nat18secretbody' + i + ' という本文です。\n');
const pluginDir = join(vault, '.obsidian', 'plugins', 'jev-search');
await mkdir(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join('dist', file), join(pluginDir, file));
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['jev-search']));
await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({
  vaults: { at18: { path: resolve(vault).replace(/\//g, '\\'), ts: Date.now(), open: true } },
}));

const child = spawn(OBSIDIAN, [
  '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + resolve(profile).replace(/\//g, '\\'),
], { detached: true, stdio: 'ignore' });
let exited = false;
child.on('exit', () => { exited = true; });
const stop = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

const report = {};
try {
  const client = await connectPage(port);
  const P = 'window.app.plugins.plugins["jev-search"]';
  await client.wait(P + '?.indexed === true', 180000);

  report.defaultTtl = await client.evaluate(P + '.settings.cacheTtlMinutes');
  report.cacheEnabled = await client.evaluate(P + '.cache.enabled');

  // A stored judgement must come back, and must not be written anywhere.
  report.roundTrip = JSON.parse(await client.evaluate('(()=>{const p=' + P + ';' +
    'p.cache.set("at18probe",{scores:[1.5],inputTokens:7,cost:0.0002});' +
    'const got=p.cache.get("at18probe");' +
    'return JSON.stringify({size:p.cache.size,value:got});})()'));

  // Changing the TTL setting must rebuild the cache and empty it.
  report.afterSettingChange = JSON.parse(await client.evaluate('(async()=>{const p=' + P + ';' +
    'p.settings.cacheTtlMinutes=0;await p.save();const off=p.cache.size;' +
    'p.settings.cacheTtlMinutes=45;await p.save();' +
    'return JSON.stringify({sizeWhenDisabled:off,enabled:p.cache.enabled,ttl:p.settings.cacheTtlMinutes});})()'));

  // Diagnostics must carry counts and versions only.
  report.diagnostics = JSON.parse(await client.evaluate('JSON.stringify(' + P + '.diagnostics())'));
  const diagText = JSON.stringify(report.diagnostics);
  report.diagnosticsLeaksPath = /secret-notes|secretnote|\.md/.test(diagText);
  report.diagnosticsLeaksBody = /at18secretbody/.test(diagText);
  report.diagnosticsLeaksQuery = /定例会|query/.test(diagText);

  report.settingsControls = JSON.parse(await client.evaluate('(()=>{' +
    'const tab=window.app.setting.pluginTabs.find(x=>x.id==="jev-search");const el=document.createElement("div");' +
    'const original=tab.containerEl;tab.containerEl=el;tab.display();tab.containerEl=original;' +
    'const text=el.textContent||"";' +
    'return JSON.stringify({hasCache:text.includes("Cache TTL"),hasDiagnostics:text.includes("Copy diagnostics"),hasNumberInput:!!el.querySelector("input[type=number]")});})()'));

  // Unloading must drop every entry.
  report.afterUnload = JSON.parse(await client.evaluate('(async()=>{const p=' + P + ';' +
    'p.cache.set("at18probe2",{scores:[0],inputTokens:1,cost:null});const before=p.cache.size;' +
    'window.__cacheRef=p.cache;window.app.plugins.disablePlugin("jev-search");await new Promise(r=>setTimeout(r,500));' +
    'return JSON.stringify({beforeUnload:before,afterUnload:window.__cacheRef.size});})()'));

  await client.evaluate('window.close()').catch(() => {});
  client.close();
  for (let i = 0; i < 60 && !exited; i++) await new Promise(r => setTimeout(r, 500));
  report.gracefulExit = exited;
} catch (error) {
  report.error = String(error && error.message);
} finally { if (!exited) stop(); }

const data = await readFile(join(pluginDir, 'data.json'), 'utf8').catch(() => null);
report.dataJson = data;
report.dataJsonHasNoJudgement = data ? !/at18probe|scores|inputTokens/.test(data) : null;
report.dataJsonHasTtl = data ? /cacheTtlMinutes/.test(data) : null;
console.log(JSON.stringify(report, null, 2));
