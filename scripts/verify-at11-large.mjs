#!/usr/bin/env node
// AT-11 remainder: a single ~50MiB note, and ~50MiB of notes that are each under the per-note cap.
//
// eligible() refuses a note whose stat.size exceeds 1MiB, so the huge note should be skipped without
// ever being read, while the 900KB notes should all be indexed. The point is that one oversized file
// does not stall the vault or crash the index.

import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, rm, stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connectPage } from './cdp-client.mjs';
import { obsidianExe } from './obsidian-exe.mjs';

const OBSIDIAN = obsidianExe();
const vault = '.sandbox/at11-vault', profile = '.sandbox/at11-profile', port = 9315;

await rm(vault, { recursive: true, force: true });
await mkdir(join(vault, 'notes'), { recursive: true });
await mkdir(join(vault, 'bulk'), { recursive: true });

// ~50MiB in one file. The plugin must refuse it on stat.size alone.
// 'あ' is three bytes in UTF-8, so this is about 51MiB rather than 51M characters.
const huge = '# 巨大ノート\n\n巨大marker の本文。\n' + 'あ'.repeat(17 * 1024 * 1024);
await writeFile(join(vault, 'notes', 'huge.md'), huge);
// 55 notes of ~900KB, just under the 1MiB per-note cap: about 50MiB in total.
// 24 bytes per repetition, so ~888KB: under the 1MiB per-note cap and therefore indexed.
const chunk = '計測用の本文。'.repeat(37000);
for (let i = 0; i < 55; i++) await writeFile(join(vault, 'bulk', 'bulk' + i + '.md'), '# 中ノート ' + i + '\n\nbulkmarker の本文 ' + i + '。\n' + chunk + '\n');
for (let i = 0; i < 10; i++) await writeFile(join(vault, 'notes', 'small' + i + '.md'), '# 小ノート ' + i + '\n\nsmallmarker の本文。\n');

const pluginDir = join(vault, '.obsidian', 'plugins', 'jev-search');
await mkdir(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join('dist', file), join(pluginDir, file));
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['jev-search']));
await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({ vaults: { at11: { path: resolve(vault).replace(/\//g, '\\'), ts: Date.now(), open: true } } }));

const hugeBytes = (await stat(join(vault, 'notes', 'huge.md'))).size;
let bulkBytes = 0;
for (const name of await readdir(join(vault, 'bulk'))) bulkBytes += (await stat(join(vault, 'bulk', name))).size;

const child = spawn(OBSIDIAN, ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + resolve(profile).replace(/\//g, '\\')], { detached: true, stdio: 'ignore' });
let exited = false; child.on('exit', () => { exited = true; });
const stop = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

const report = { hugeBytes, bulkBytes, notes: { huge: 1, bulk: 55, small: 10 } };
try {
  const client = await connectPage(port);
  const P = 'window.app.plugins.plugins["jev-search"]';
  await client.wait(P + '?.loaded === true', 240000);
  // Sample frame gaps while the index builds.
  await client.evaluate('(()=>{window.__gaps=[];let last=performance.now();const tick=()=>{const n=performance.now();window.__gaps.push(n-last);last=n;if(window.__gaps.length<4000)requestAnimationFrame(tick);};requestAnimationFrame(tick);return true;})()');
  const started = Date.now();
  await client.wait(P + '.indexed === true', 600000);
  report.indexMs = Date.now() - started;
  await new Promise(r => setTimeout(r, 3000));
  report.indexed = JSON.parse(await client.evaluate('(()=>{const p=' + P + ';return JSON.stringify({size:p.index.size,skipped:p.skipped,indexed:p.indexed});})()'));
  report.heapMB = await client.evaluate('Math.round((performance.memory?.usedJSHeapSize ?? 0)/1048576)');
  report.frames = JSON.parse(await client.evaluate('(()=>{const g=window.__gaps.slice().sort((a,b)=>a-b);return JSON.stringify({samples:g.length,p95:Math.round(g[Math.floor(g.length*0.95)]*10)/10,max:Math.round(g[g.length-1]*10)/10,over200:g.filter(x=>x>200).length});})()'));
  report.search = JSON.parse(await client.evaluate('(async()=>{const p=' + P + ';await p.open();await new Promise(r=>setTimeout(r,600));const i=document.querySelector(".jev-search input[type=search]");const t0=performance.now();i.value="bulkmarker";i.dispatchEvent(new Event("input"));await new Promise(r=>setTimeout(r,700));const rows=document.querySelectorAll(".jev-result").length;const ms=Math.round(performance.now()-t0);i.value="巨大marker";i.dispatchEvent(new Event("input"));await new Promise(r=>setTimeout(r,500));const hugeRows=document.querySelectorAll(".jev-result").length;return JSON.stringify({bulkRows:rows,bulkMs:ms,hugeRows});})()'));
  await client.evaluate('window.close()').catch(() => {});
  client.close();
  for (let i = 0; i < 60 && !exited; i++) await new Promise(r => setTimeout(r, 500));
  report.gracefulExit = exited;
} catch (error) { report.error = String(error && error.message); } finally { if (!exited) stop(); }

const outArg = process.argv.find(a => a.startsWith('--out='));
if (outArg) await writeFile(outArg.slice('--out='.length), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
