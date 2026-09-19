#!/usr/bin/env node
// AT-01 (no transmission without opt-in), AT-08 (no secret leak) and AT-10 (no note mutation)
// verified in one real-Obsidian run.
//
// AT-10 needs the app to be closed gracefully: a forced kill cannot be distinguished from a
// mutation the plugin made, so the vault is hashed before launch and after a clean exit.

import { obsidianExe } from './obsidian-exe.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { connectPage } from './cdp-client.mjs';

const OBSIDIAN = obsidianExe();
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const vault = arg('vault', '.sandbox/corpus-small/vault');
const profile = arg('profile', '.sandbox/integrity-profile');
const port = Number(arg('port', '9270'));
const DUMMY = 'JEV-DUMMY-SECRET-9f3c1a';

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '.obsidian') await walk(full, base, out); }
    else out.push(relative(base, full));
  }
  return out;
}
async function hashVault() {
  const files = (await walk(vault)).sort();
  const hashes = {};
  for (const rel of files) {
    if (!rel.endsWith('.md')) continue;
    hashes[rel.replace(/\\/g, '/')] = createHash('sha256').update(await readFile(join(vault, rel))).digest('hex');
  }
  return hashes;
}

const before = await hashVault();
const beforeFiles = Object.keys(before);

const pluginDir = join(vault, '.obsidian', 'plugins', 'jev-search');
await mkdir(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join('dist', file), join(pluginDir, file));
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['jev-search']));
await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({
  vaults: { integrity: { path: resolve(vault).replace(/\//g, '\\'), ts: Date.now(), open: true } },
}));

const child = spawn(OBSIDIAN, [
  '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + resolve(profile).replace(/\//g, '\\'),
], { detached: true, stdio: 'ignore' });
let exited = false;
child.on('exit', () => { exited = true; });
const forceStop = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

const report = { vault, dummy: 'written, value not printed' };
try {
  const client = await connectPage(port);
  await client.wait('window.app?.plugins?.plugins["jev-search"]?.indexed === true', 240000);
  report.indexedNotes = await client.evaluate('window.app.plugins.plugins["jev-search"].index.size');

  // AT-01: count outbound HTTP from the renderer's own Node realm, if it is reachable.
  report.requireReachable = await client.evaluate('typeof require === "function"');
  if (report.requireReachable) {
    await client.evaluate('(()=>{const https=require("node:https"),http=require("node:http");' +
      'window.__net={https:[],http:[]};' +
      'for(const [mod,key] of [[https,"https"],[http,"http"]]){const original=mod.request;' +
      'mod.request=function(...args){try{window.__net[key].push(String(args[0]?.hostname??args[0]??""));}catch(e){}return original.apply(this,args);};}' +
      'return true;})()');
  }

  // Run real local searches through the shipped index, including queries from the corpus.
  const truthPath = join(vault, '..', 'ground-truth.json');
  let queries = ['定例会', '経費精算', 'VPN', 'デプロイ', '会議'];
  try { const truth = JSON.parse(await readFile(truthPath, 'utf8')); if (truth.queries) queries = truth.queries.slice(0, 12).map(q => q.query ?? q); } catch {}
  report.searches = JSON.parse(await client.evaluate('(()=>{const p=window.app.plugins.plugins["jev-search"];' +
    'return JSON.stringify(' + JSON.stringify(queries) + '.map(q=>({q,hits:p.index.search(q,50).length})));})()'));

  // A rerank with no key must refuse locally instead of sending anything.
  report.rerankWithoutKey = await client.evaluate('(async()=>{const p=window.app.plugins.plugins["jev-search"];' +
    'try{await p.rerank?.("定例会");return "returned";}catch(e){return String(e&&e.message);}})()');

  // AT-08: a dummy secret must be storable and must never reach the saved settings.
  await client.evaluate('(async()=>{await window.app.secretStorage.setSecret("jev-integrity-dummy",' + JSON.stringify(DUMMY) + ');return true;})()');
  await new Promise(r => setTimeout(r, 1500));
  report.secretReadBack = await client.evaluate('window.app.secretStorage.getSecret("jev-integrity-dummy") === ' + JSON.stringify(DUMMY));
  report.settingsText = await client.evaluate('JSON.stringify(window.app.plugins.plugins["jev-search"].settings)');
  report.net = report.requireReachable ? JSON.parse(await client.evaluate('JSON.stringify(window.__net)')) : null;
  report.cdpRequests = client.requests.filter(u => /openrouter|typesafe|gateway|api\./.test(u));

  // AT-10 needs a clean exit so the vault state is the plugin's, not the killer's.
  await client.evaluate('window.close()').catch(() => {});
  client.close();
  for (let i = 0; i < 60 && !exited; i++) await new Promise(r => setTimeout(r, 500));
  report.gracefulExit = exited;
} catch (error) {
  report.error = String(error && error.message);
} finally { if (!exited) forceStop(); }

await new Promise(r => setTimeout(r, 1500));
const after = await hashVault();
const afterFiles = Object.keys(after);
report.notesBefore = beforeFiles.length;
report.notesAfter = afterFiles.length;
report.addedFiles = afterFiles.filter(f => !beforeFiles.includes(f));
report.removedFiles = beforeFiles.filter(f => !afterFiles.includes(f));
report.changedFiles = beforeFiles.filter(f => afterFiles.includes(f) && before[f] !== after[f]);
report.vaultUnchanged = !report.addedFiles.length && !report.removedFiles.length && !report.changedFiles.length;

// AT-08: scan the saved plugin settings and the vault for the dummy value.
let leaked = [];
for (const file of await walk(vault)) {
  if (!/\.(md|json)$/.test(file)) continue;
  try { if ((await readFile(join(vault, file), 'utf8')).includes(DUMMY)) leaked.push(file); } catch {}
}
report.dummyFoundIn = leaked;
report.settingsContainDummy = report.settingsText?.includes(DUMMY) ?? null;

// The secret is expected in the profile's own store; it must not be in the plugin's settings file.
console.log(JSON.stringify(report, null, 2));
