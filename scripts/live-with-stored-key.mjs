#!/usr/bin/env node
// Runs a live harness using the key held in Obsidian's SecretStorage or in the session-only field.
//
// Defaults to scripts/smoke-live.mjs (AT-07); pass --script= to run another harness the same way.
//
// The key is read from the running Obsidian instance over CDP - either from SecretStorage or from the
// session-only field - and handed to the child process through its environment. It is never printed, never written to disk, and never placed in an
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
let source = null;
let names = [];
try {
  const plugin = 'window.app.plugins.plugins["jev-search"]';
  const info = JSON.parse(await client.evaluate('JSON.stringify({names:window.app.secretStorage.listSecrets(),configured:(' + plugin + '?.settings?.secrets??{})[' + JSON.stringify(target) + ']??"",session:(' + plugin + '?.keys??{})[' + JSON.stringify(target) + ']??""})'));
  names = info.names;
  chosen = explicit || info.configured || (names.length === 1 ? names[0] : '');
  if (chosen) {
    secret = await client.evaluate('window.app.secretStorage.getSecret(' + JSON.stringify(chosen) + ')');
    if (secret) source = 'the SecretStorage entry ' + JSON.stringify(chosen);
  }
  // The session-only field is never written to disk. It is read out of the running plugin, handed to
  // this one child process, and gone when Obsidian closes - which is the whole point of the field.
  if (!secret && info.session) { secret = info.session; source = 'the session-only key field'; }
} finally { client.close(); }

if (!secret) {
  console.error('No key available.');
  console.error('  secret names in SecretStorage: ' + JSON.stringify(names));
  console.error('  name configured in plugin settings: ' + JSON.stringify(chosen ?? ''));
  console.error('In Obsidian: Settings -> Jev Search, then either store a secret under "Stored secret"');
  console.error('or paste the key into "Session-only key", which is never written to disk.');
  process.exit(3);
}
console.log('using the key from ' + source + ' (' + secret.length + ' chars); value not shown');
if (process.argv.includes('--check')) { console.log('check only; the live test was not run'); process.exit(0); }

// --script lets another live harness reuse the same key handling instead of duplicating it.
const script = arg('script', 'scripts/smoke-live.mjs');
const passthrough = process.argv.filter(a => a.startsWith('--') && !/^--(port|target|secret|script|check)=?/.test(a) && a !== '--check');
const child = spawnSync(process.execPath, [script, ...passthrough], {
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
