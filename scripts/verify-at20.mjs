#!/usr/bin/env node
// AT-20: an unknown or hostile settings schema must not crash the plugin, must fall back to safe
// defaults in memory, and must not destroy the stored file.

import { obsidianExe } from './obsidian-exe.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, cp, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connectPage } from './cdp-client.mjs';

const OBSIDIAN = obsidianExe();
const vault = '.sandbox/at20-vault', profile = '.sandbox/at20-profile', port = 9290;

// A schema from a hypothetical future version, plus values that a naive reader would trust.
const STORED = {
  folders: 'not-an-array',
  tags: ['ok', { nested: true }, 42],
  enabled: 'yes',
  endpoint: ['direct'],
  secrets: { openrouter: '../../etc/passwd', direct: 'UPPER CASE', gateway: 'a'.repeat(200) },
  futureFeature: { threshold: 0.9, nested: { deep: [1, 2, 3] } },
  schemaVersion: 99,
};

await rm(vault, { recursive: true, force: true });
await mkdir(join(vault, 'notes'), { recursive: true });
for (let i = 0; i < 12; i++) await writeFile(join(vault, 'notes', 'n' + i + '.md'), '# 見出し ' + i + '\nat20body' + i + ' の本文です。\n');
const pluginDir = join(vault, '.obsidian', 'plugins', 'jev-search');
await mkdir(pluginDir, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join('dist', file), join(pluginDir, file));
await writeFile(join(pluginDir, 'data.json'), JSON.stringify(STORED, null, 2));
await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['jev-search']));
await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });
await writeFile(join(profile, 'obsidian.json'), JSON.stringify({
  vaults: { at20: { path: resolve(vault).replace(/\//g, '\\'), ts: Date.now(), open: true } },
}));
const beforeBytes = await readFile(join(pluginDir, 'data.json'), 'utf8');

const child = spawn(OBSIDIAN, [
  '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + resolve(profile).replace(/\//g, '\\'),
], { detached: true, stdio: 'ignore' });
let exited = false;
child.on('exit', () => { exited = true; });
const stop = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

const report = { stored: STORED };
try {
  const client = await connectPage(port);
  const P = 'window.app.plugins.plugins["jev-search"]';
  await client.wait(P + '?.indexed === true', 180000);
  report.loaded = true;
  report.effective = JSON.parse(await client.evaluate('JSON.stringify(' + P + '.settings)'));
  report.searchStillWorks = JSON.parse(await client.evaluate('(()=>{const p=' + P + ';const h=p.index.search("at20body3",50);return JSON.stringify({hits:h.length,top:h.length?h[0].path:null});})()'));
  report.rendererErrors = client.errors.length;
  await client.evaluate('window.close()').catch(() => {});
  client.close();
  for (let i = 0; i < 60 && !exited; i++) await new Promise(r => setTimeout(r, 500));
  report.gracefulExit = exited;
} catch (error) {
  report.error = String(error && error.message);
} finally { if (!exited) stop(); }

const afterBytes = await readFile(join(pluginDir, 'data.json'), 'utf8').catch(() => null);
report.dataJsonPreserved = afterBytes === beforeBytes;
report.dataJsonStillParses = (() => { try { JSON.parse(afterBytes); return true; } catch { return false; } })();
console.log(JSON.stringify(report, null, 2));
