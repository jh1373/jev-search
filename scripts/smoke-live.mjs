#!/usr/bin/env node
/**
 * Live Jev smoke test (AT-07).
 *
 * All three preconditions must hold, so this never runs from the normal test suite:
 *   1. the explicit "npm run test:live" script
 *   2. RUN_LIVE_TESTS=1
 *   3. an API key in the process environment
 *
 * Synthetic data only. Exactly one HTTP request. The key is never printed.
 * See docs/design/05-testing-release.md and docs/design/07-acceptance.md (AT-07).
 */
import { prepare, validate, requestFor, ENDPOINTS, PRICE_PER_MTOK, OPENROUTER_MODEL, MODEL, GATEWAY_MODEL } from '../src/core/jev.ts';
import { createRequestUrlTransport } from '../src/adapters/transport.ts';

const fetchRequester = async (params) => {
  const res = await fetch(params.url, {
    method: params.method,
    headers: params.headers,
    body: params.body,
  });
  const text = await res.text();
  const headers = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return {
    status: res.status,
    headers,
    text,
    arrayBuffer: Buffer.from(text).buffer,
    json: null,
  };
};

const transport = createRequestUrlTransport(fetchRequester);

const KEY_ENV = { openrouter: 'OPENROUTER_API_KEY', direct: 'TYPESAFE_API_KEY', gateway: 'AI_GATEWAY_API_KEY' };
const MODEL_OF = { openrouter: OPENROUTER_MODEL, direct: MODEL, gateway: GATEWAY_MODEL };
const SEND_CAP = 3;
const PRODUCT_DEADLINE_MS = 4000;
const SMOKE_TIMEOUT_MS = 30000;

function fail(message) { console.error('FAIL: ' + message); process.exit(1); }
function shapeOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(', ') : typeof value;
}

if (process.env.RUN_LIVE_TESTS !== '1') fail('set RUN_LIVE_TESTS=1 to acknowledge that this sends a real network request');

const target = process.env.LIVE_TARGET || (process.env.OPENROUTER_API_KEY ? 'openrouter' : process.env.TYPESAFE_API_KEY ? 'direct' : 'openrouter');
if (!Object.prototype.hasOwnProperty.call(KEY_ENV, target)) fail('unknown LIVE_TARGET: ' + target);
const key = process.env[KEY_ENV[target]];
if (!key || !key.trim()) fail(KEY_ENV[target] + ' is not set in this process environment');

// Synthetic data only: a fictional team. No personal vault content, no local paths.
const documents = [
  { title: '架空チームの議事録', heading: '定例会', text: '定例会は毎週火曜日に開催する。議題は各担当の進捗報告とする。' },
  { title: '架空チームの議事録', heading: '経費精算', text: '経費精算は毎月末日までに申請する。領収書はPDFで添付すること。' },
  { title: '無関係な資料', heading: '観葉植物', text: '窓辺のポトスには週に一度、土が乾いてから水をやる。' },
];
const prepared = prepare('定例会の曜日は？', documents, target);
if (prepared.count !== documents.length) fail('expected ' + documents.length + ' synthetic documents, got ' + prepared.count);

const markers = ['Desktop', 'Documents', '.sandbox', '.obsidian', 'AppData'];
const leaked = markers.filter(function (m) { return prepared.body.indexOf(m) !== -1; });
if (leaked.length > 0) fail('payload contains local path markers: ' + leaked.join(', '));

console.log('=== live Jev smoke test (AT-07) ===');
console.log('target        : ' + target);
console.log('destination   : ' + ENDPOINTS[target].url);
console.log('model (sent)  : ' + MODEL_OF[target]);
console.log('payload bytes : ' + Buffer.byteLength(prepared.body));
console.log('documents     : ' + prepared.count + ' synthetic');
console.log('sends         : 1 (cap ' + SEND_CAP + ')');
console.log('');

const controller = new AbortController();
const timer = setTimeout(function () { controller.abort(); }, SMOKE_TIMEOUT_MS);
const started = Date.now();
let response;
try {
  response = await transport(prepared.body, key, controller.signal, requestFor(target));
} catch (error) {
  clearTimeout(timer);
  fail('transport error: ' + (error instanceof Error ? error.message : String(error)));
}
clearTimeout(timer);
const latencyMs = Date.now() - started;

console.log('http status   : ' + response.status);
console.log('latency       : ' + latencyMs + ' ms (product deadline is ' + PRODUCT_DEADLINE_MS + ' ms)');
if (latencyMs > PRODUCT_DEADLINE_MS) console.warn('WARNING: slower than the 4s product deadline; evaluate() would have aborted this request.');
console.log('');

if (response.status !== 200) {
  console.error('--- response body (status ' + response.status + ') ---');
  console.error(response.body.slice(0, 4000));
  fail('non-200 status');
}

let raw;
try { raw = JSON.parse(response.body); } catch (error) { fail('response was not valid JSON'); }

console.log('--- response shape (field names, for the evidence record) ---');
console.log('top level     : ' + shapeOf(raw));
console.log('model resolved: ' + JSON.stringify(raw && raw.model));
console.log('usage fields  : ' + shapeOf(raw && raw.usage));
const first = raw && raw.answers ? raw.answers.d0 : undefined;
console.log('answer fields : ' + shapeOf(first));
if (first && typeof first === 'object') {
  console.log('  type         : ' + JSON.stringify(first.type));
  console.log('  score        : ' + JSON.stringify(first.score));
  console.log('  confidence   : ' + (first.confidence === undefined ? '(absent)' : JSON.stringify(first.confidence)));
  console.log('  probabilities: ' + (first.probabilities === undefined ? '(absent)' : JSON.stringify(first.probabilities)));
  console.log('  legend       : ' + (first.legend === undefined ? '(absent)' : JSON.stringify(first.legend)));
}
console.log('');

console.log('--- runtime validation (src/core/jev.ts validate) ---');
let judgement;
try {
  judgement = validate(raw, prepared.count, target);
} catch (error) {
  console.error('validate() rejected the live response: ' + (error instanceof Error ? error.message : String(error)));
  console.error('--- raw response (synthetic request) ---');
  console.error(response.body.slice(0, 4000));
  fail('the live response did not satisfy the runtime contract');
}
console.log('scores        : ' + JSON.stringify(judgement.scores));
console.log('input tokens  : ' + (judgement.inputTokens === null ? 'unknown' : judgement.inputTokens));
console.log('actual cost   : ' + (judgement.cost === null ? 'not reported by this route' : '$' + judgement.cost));
const estimate = judgement.inputTokens === null ? null : judgement.inputTokens * PRICE_PER_MTOK[target] / 1e6;
console.log('est. cost     : ' + (estimate === null ? 'unknown' : '$' + estimate.toFixed(8)));
if (estimate !== null && estimate > 0.01) console.warn('WARNING: estimated cost exceeds the $0.01 budget for this test.');
console.log('');

if (response.body.indexOf(key) !== -1 || prepared.body.indexOf(key) !== -1) fail('the API key appeared in the payload or response');

console.log('--- raw response (synthetic request, truncated) ---');
console.log(response.body.slice(0, 2000));
console.log('');
console.log('PASS: one synthetic request, response validated, no local path or key in the payload.');
