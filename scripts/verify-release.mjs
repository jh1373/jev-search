#!/usr/bin/env node
// AT-14: inspect what would actually be released.
//
// A clean checkout plus npm ci plus npm run check proves the build works from scratch. This adds the
// checks that are about the artefact rather than the build: version agreement across the three files
// that declare it, the licence files the manifest promises, and a scan for anything that must never
// ship (a key, a personal address, a developer's absolute path).

import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const failures = [];
const notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const read = async p => { try { return await readFile(p, 'utf8'); } catch { return null; } };

// 1. Version agreement. Obsidian reads manifest.json; the repository and versions.json must agree.
const manifest = JSON.parse(await read('manifest.json'));
const pkg = JSON.parse(await read('package.json'));
const versions = JSON.parse(await read('versions.json'));
check(manifest.version === pkg.version, 'manifest.json version ' + manifest.version + ' != package.json version ' + pkg.version);
check(versions[manifest.version] === manifest.minAppVersion,
  'versions.json[' + manifest.version + '] is ' + versions[manifest.version] + ', expected ' + manifest.minAppVersion);
check(pkg.author === manifest.author, 'package.json author and manifest.json author differ');
check(manifest.isDesktopOnly === true, 'manifest.json must declare isDesktopOnly');
check(typeof manifest.id === 'string' && /^[a-z][a-z0-9-]*$/.test(manifest.id), 'manifest.json id must be lowercase-with-dashes');
notes.push('version ' + manifest.version + ', minAppVersion ' + manifest.minAppVersion + ', id ' + manifest.id);

// 2. Licence and attribution files the README and manifest point at.
const license = await read('LICENSE');
const notice = await read('NOTICE');
check(license !== null, 'LICENSE is missing');
check(notice !== null, 'NOTICE is missing');
check(pkg.license === 'MIT', 'package.json license is ' + pkg.license + ', expected MIT');
check((license ?? '').includes('MIT License'), 'LICENSE does not look like the MIT licence');
check((notice ?? '').length > 200, 'NOTICE looks empty');

// 3. The shipped files must exist and must not carry anything private.
const shipped = ['dist/main.js', 'dist/manifest.json', 'dist/styles.css'];
for (const file of shipped) {
  const info = await stat(file).catch(() => null);
  check(info !== null && info.isFile(), 'missing release file ' + file);
}

const forbidden = [
  [/sk-or-v1-[A-Za-z0-9]{16,}/, 'an OpenRouter API key'],
  [/sk-[A-Za-z0-9]{24,}/, 'an OpenAI-shaped API key'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, 'an email address'],
  [/[A-Za-z]:\\Users\\/i, 'a developer absolute path'],
  [/\/(Users|home)\/[A-Za-z0-9._-]+\//, 'a developer absolute path'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

// Scan every tracked file rather than only the bundle: a secret in a test or a document leaks too.
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
let scanned = 0;
for (const file of tracked) {
  const text = await read(file);
  if (text === null) continue;
  scanned++;
  for (const [pattern, what] of forbidden) {
    const hit = text.match(pattern);
    if (!hit) continue;
    // The repository owner's noreply address is the intended public contact.
    if (what === 'an email address' && /noreply\.github\.com$/.test(hit[0])) continue;
    if (what === 'an email address' && /@example\.(com|org)$/.test(hit[0])) continue;
    failures.push(file + ' contains ' + what + ': ' + hit[0].slice(0, 40));
  }
}
notes.push('scanned ' + scanned + ' tracked files');

// 4. A tag being released must name the version the manifest declares.
const tagArg = process.argv.find(a => a.startsWith('--tag='));
if (tagArg) {
  const tag = tagArg.slice('--tag='.length);
  check(tag === 'v' + manifest.version, 'tag ' + tag + ' does not match manifest version v' + manifest.version);
  notes.push('tag ' + tag + ' matches the manifest');
}

// 5. A release archive, when one is being inspected, must contain exactly the three shipped files.
// `npm run test:release:zip` packages one first so this can be exercised without publishing.
const zipArg = process.argv.find(a => a.startsWith('--zip='));
if (zipArg) {
  const zip = zipArg.slice('--zip='.length);
  // unzip is not present on Windows, but the bundled bsdtar lists a zip just as well.
  let listing;
  try { listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean); }
  catch { listing = execFileSync('tar', ['-tf', zip], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean); }
  const expected = ['main.js', 'manifest.json', 'styles.css'];
  check(JSON.stringify([...listing].sort()) === JSON.stringify([...expected].sort()),
    'archive holds ' + JSON.stringify(listing) + ', expected ' + JSON.stringify(expected));
  notes.push('archive ' + zip + ' holds ' + listing.length + ' files');
}

for (const note of notes) console.log('  ' + note);
if (failures.length) {
  for (const failure of failures) console.log('FAIL: ' + failure);
  console.log('FAIL: release inspection found ' + failures.length + ' problem(s)');
  process.exit(1);
}
console.log('PASS: release inspection clean (versions agree, licence files present, no key, address or absolute path).');
