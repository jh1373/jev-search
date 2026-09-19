#!/usr/bin/env node
// Runs the live smoke test using the key held in Obsidian's SecretStorage.
//
// The key is read from the running Obsidian instance over CDP and handed to the child process
// through its environment. It is never printed, never written to disk, and never placed in an
// argument list. As a backstop the script scans the child's output and fails if the value appears.
//
// Requires an Obsidian instance started with --remote-debugging-port (scripts/launch-obsidian.mjs).

import { spawnSync } from 'node:child_process';
import { connectPage } from './cdp-client.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const port = arg('port', '9222');
const target = arg('target', 'openrouter');
const explicit = arg('secret', '');
const KEY_ENV = { openrouter: 'OPENROUTER_API_KEY', direct: 'TYPESAFE_API_KEY', gateway: 'AI_GATEWAY_API_KEY' };
const keyEnv = KEY_ENV[target];
if (!keyEnv) { console.error('unknown target: ' + target); process.exit(2); }

const client = await connectPage(port);
let secret = null;
let chosen = null;
let names = [];
try {
  const info = JSON.parse(await client.evaluate('JSON.stringify({names:window.app.secretStorage.listSecrets(),configured:(window.app.plugins.plugins["jev-search"]?.settings?.secrets??{})[' + JSON.stringify(target) + ']??""})'));
  names = info.names;
  chosen = explicit || info.configured || (names.length === 1 ? names[0] : '');
  if (!chosen) {
    console.error('No secret to use.');
    console.error('  secret names in SecretStorage: ' + JSON.stringify(names));
    console.error('  name configured in plugin settings: ' + JSON.stringify(info.configured));
    console.error('Set one in Obsidian: Settings -> Jev Search -> "Stored secret", then retry.');
    process.exit(3);
  }
  secret = await client.evaluate('window.app.secretStorage.getSecret(' + JSON.stringify(chosen) + ')');
} finally { client.close(); }

if (!secret) { console.error('Secret ' + JSON.stringify(chosen) + ' is empty or missing.'); process.exit(3); }
console.log('using secret ' + JSON.stringify(chosen) + ' (' + secret.length + ' chars) from SecretStorage; value not shown');

const child = spawnSync(process.execPath, ['scripts/smoke-live.mjs'], {
  env: { ...process.env, RUN_LIVE_TESTS: '1', [keyEnv]: secret, LIVE_TARGET: target },
  encoding: 'utf8',
});
const out = (child.stdout ?? '') + (child.stderr ?? '');
if (out.includes(secret)) {
  console.error('REFUSING to show output: the key appeared in the child output.');
  process.exit(4);
}
process.stdout.write(out);
process.exit(child.status ?? 1);
