#!/usr/bin/env node
// AT-12: 100 consecutive changes, repeated reload/disable, and a check for leftover listeners,
// timers and queue work. Runs against a real Obsidian and a disposable vault.

import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connectPage } from './cdp-client.mjs';

const OBSIDIAN = 'C:/Users/systemuser/AppData/Local/Programs/Obsidian/Obsidian.exe';
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const vault = arg('vault', '.sandbox/at12-vault');
const profile = arg('profile', '.sandbox/at12-profile');
const port = Number(arg('port', '9280'));

// A disposable vault with a few base notes.
await rm(vault, { recursive: true, force: true });
await mkdir(join(vault, 'base'), { recursive: true });
for (let i = 0; i < 20; i++) await writeFile(join(vault, 'base', 'base-' + i + '.md'), '# 基礎 ' + i + '\nbaseline' + i + ' の本文です。\n');
const pluginDir = join(vault, '.obsidian', 'plugins', 'jev-search');
await mkdir(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join('dist', file), join(pluginDir, file));
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['jev-search']));
await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({
  vaults: { at12: { path: resolve(vault).replace(/\//g, '\\'), ts: Date.now(), open: true } },
}));

const child = spawn(OBSIDIAN, [
  '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + resolve(profile).replace(/\//g, '\\'),
], { detached: true, stdio: 'ignore' });
const stop = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

const report = {};
try {
  const client = await connectPage(port);
  const P = 'window.app.plugins.plugins["jev-search"]';
  await client.wait(P + '?.indexed === true', 180000);
  const size = () => client.evaluate(P + '.index.size');
  const settle = async (label) => {
    let last = -1;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      const now = await size();
      const busy = await client.evaluate('(()=>{const p=' + P + ';return !!(p.pending.size)||false;})()');
      if (now === last && !busy) return now;
      last = now;
    }
    throw Error('index did not settle after ' + label);
  };

  report.baselineNotes = await settle('startup');
  report.diskBaseNotes = (await readdir(join(vault, 'base'))).length;

  // 100 rapid creations, not awaited one by one: the point is to stress the queue and generation logic.
  await client.evaluate('(async()=>{const v=window.app.vault;if(!v.getFolderByPath("burst"))await v.createFolder("burst");const ps=[];for(let i=0;i<100;i++)ps.push(v.create("burst/note-"+i+".md","# 連続 "+i+"\\nat12token"+i+" の本文 "+i+"\\n"));await Promise.all(ps);return true;})()');
  report.afterCreates = await settle('100 creates');

  // 50 edits and 25 deletions, again fired together.
  await client.evaluate('(async()=>{const v=window.app.vault;const ps=[];for(let i=0;i<50;i++){const f=v.getFileByPath("burst/note-"+i+".md");if(f)ps.push(v.append(f,"\\n追記 at12edit"+i+"\\n"));}for(let i=50;i<75;i++){const f=v.getFileByPath("burst/note-"+i+".md");if(f)ps.push(v.delete(f));}await Promise.all(ps);return true;})()');
  report.afterEditsAndDeletes = await settle('50 edits and 25 deletes');

  // The index must agree with the vault, not with the sequence of events.
  report.consistency = JSON.parse(await client.evaluate('(()=>{const p=' + P + ';const v=window.app.vault;' +
    'const onDisk=v.getMarkdownFiles().length;' +
    'const probe=i=>{const hits=p.index.search("at12token"+i,50);return hits.length?hits[0].path:null;};' +
    'return JSON.stringify({onDisk,indexed:p.index.size,' +
    'kept:probe(10),edited:probe(10),deleted:probe(60),created:probe(99),' +
    'deletedStillFound:!!probe(60)});})()'));
  report.consistency.editedHasNewText = await client.evaluate('(()=>{const p=' + P + ';const h=p.index.search("at12edit10",50);return h.length?h[0].path:null;})()');
  report.consistency.oldTextGone = await client.evaluate('(()=>{const p=' + P + ';return p.index.search("at12token60",50).length;})()');

  // Renames must move the index entry, and must not leave the old path in the schedule map.
  await client.evaluate('(async()=>{const v=window.app.vault;if(!v.getFolderByPath("renamed"))await v.createFolder("renamed");const ps=[];for(let i=0;i<10;i++){const f=v.getFileByPath("burst/note-"+i+".md");if(f)ps.push(v.rename(f,"renamed/moved-"+i+".md"));}await Promise.all(ps);return true;})()');
  report.afterRenames = await settle('10 renames');
  report.renamed = JSON.parse(await client.evaluate('(()=>{const p=' + P + ';const v=window.app.vault;' +
    'const h=p.index.search("at12token0",50);return JSON.stringify({onDisk:v.getMarkdownFiles().length,indexed:p.index.size,' +
    'top:h.length?h[0].path:null,oldPathGone:!v.getFileByPath("burst/note-0.md"),updates:p.updates.size});})()'));

  // Repeated disable/enable cycles must rebuild a correct index and leave nothing behind.
  report.cycles = [];
  for (let cycle = 0; cycle < 5; cycle++) {
    await client.evaluate('(async()=>{const a=window.app.plugins;a.disablePlugin("jev-search");await new Promise(r=>setTimeout(r,300));await a.enablePlugin("jev-search");return true;})()');
    await client.wait(P + '?.indexed === true', 120000);
    await settle('cycle ' + cycle);
    report.cycles.push(JSON.parse(await client.evaluate('(()=>{const p=' + P + ';const v=window.app.vault;' +
      'return JSON.stringify({indexed:p.index.size,onDisk:v.getMarkdownFiles().length,loaded:p.loaded,' +
      'updates:p.updates.size,pending:p.pending.size});})()')));
  }

  report.resources = JSON.parse(await client.evaluate('(()=>{const p=' + P + ';' +
    'const info=typeof process!=="undefined"&&process.getActiveResourcesInfo?process.getActiveResourcesInfo():null;' +
    'return JSON.stringify({updates:p.updates.size,pending:p.pending.size,indexed:p.indexed,size:p.index.size,' +
    'timers:info?info.filter(x=>x==="Timeout"||x==="Immediate").length:null,resources:info?info.length:null});})()'));

  client.close();
} catch (error) {
  report.error = String(error && error.message);
} finally { stop(); }

console.log(JSON.stringify(report, null, 2));
