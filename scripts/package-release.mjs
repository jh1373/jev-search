#!/usr/bin/env node
// AT-14: build the archive the release workflow would publish, then inspect it, without publishing.
//
// The workflow's own steps are run here so the packaging can be checked on a working machine instead of
// only after a tag. Nothing is uploaded.

import { mkdir, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const out = '.sandbox/release';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join('dist', file), join(out, file));

// Prefer the same command the workflow uses; fall back to PowerShell on a machine without zip.
const archive = '.sandbox/jev-search.zip';
await rm(archive, { force: true });
let packedWith;
try {
  execFileSync('zip', ['-r', '../jev-search.zip', '.'], { cwd: out, stdio: 'ignore' });
  packedWith = 'zip';
} catch {
  execFileSync('powershell', ['-NoProfile', '-Command',
    'Compress-Archive -Path "' + out + '/*" -DestinationPath "' + archive + '" -Force'], { stdio: 'ignore' });
  packedWith = 'Compress-Archive';
}
console.log('packed ' + archive + ' with ' + packedWith);

const inspection = execFileSync(process.execPath, ['scripts/verify-release.mjs', '--zip=' + archive], { encoding: 'utf8' });
process.stdout.write(inspection);
