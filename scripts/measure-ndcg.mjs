#!/usr/bin/env node
// AT-13 remainder: does reranking with Jev change nDCG on a public corpus?
//
// The local stage is measured separately by scripts/experiment-katakana-qrels.mjs. This asks the other
// half of the question: given the candidates the local stage already found, does Jev's ordering place
// the relevant ones higher?
//
// It talks to the live API, so it refuses to run without a key in the environment and it never prints
// one. Relevance comes from the corpus (documents containing the katakana query word), not from Jev, so
// Jev cannot be graded against its own opinion.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SearchIndex } from '../src/core/search.ts';
import { prepare, evaluate } from '../src/core/jev.ts';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const vault = arg('vault', '.sandbox/wiki/vault');
const truthPath = arg('truth', '.sandbox/wiki/katakana-truth.json');
const maxQueries = Number(arg('queries', '40'));
const cut = Number(arg('cut', '10'));
const out = arg('out', '');

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('OPENROUTER_API_KEY is required: this measurement calls the live API.');
  console.error('Run it through scripts/live-with-stored-key.mjs so the key never enters an argument list.');
  process.exit(2);
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}
const rel = (root, full) => full.slice(root.length + 1).split('\\').join('/');

const files = await walk(vault);
const index = new SearchIndex();
const notes = new Map();
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const path = rel(vault, file);
  notes.set(path, text);
  index.upsert({ path, title: file.split(/[\\/]/).pop().replace(/\.md$/, ''), text, tags: [] });
}
const truth = JSON.parse(await readFile(truthPath, 'utf8'));
const relevant = new Map();
for (const r of truth.relevance) {
  if (!relevant.has(r.key)) relevant.set(r.key, new Set());
  relevant.get(r.key).add(r.path);
}

// Graded gain: 1 for a document that contains the query word, 0 otherwise.
const dcg = (paths, target) => paths.slice(0, cut).reduce((sum, path, i) => sum + (target.has(path) ? 1 / Math.log2(i + 2) : 0), 0);
const ideal = target => {
  const hits = Math.min(target.size, cut);
  let sum = 0;
  for (let i = 0; i < hits; i++) sum += 1 / Math.log2(i + 2);
  return sum;
};

const chosen = truth.queries.slice(0, maxQueries);
const rows = [];
let failures = 0;
for (const q of chosen) {
  const target = relevant.get(q.key) ?? new Set();
  const hits = index.search(q.query, 20);
  if (!hits.length) { rows.push({ key: q.key, query: q.query, skipped: 'no local hits' }); continue; }
  const before = hits.map(h => h.path);
  let after = before, note = '';
  try {
    const docs = hits.map(h => ({ title: h.title, heading: h.heading, text: h.text }));
    const prepared = prepare(q.query, docs, 'openrouter');
    const judgement = await evaluate(prepared.body, prepared.count, key, new AbortController().signal, 'openrouter');
    const scored = hits.slice(0, prepared.count).map((h, i) => ({ h, score: judgement.scores[i] }));
    // Same rule as the plugin: Jev reorders, it never drops a candidate, and an all-low result keeps
    // the local order.
    const allLow = judgement.scores.every(s => s < 1);
    const ordered = allLow ? hits : [...scored].sort((a, b) => b.score - a.score).map(x => x.h);
    after = ordered.map(h => h.path);
    note = allLow ? 'all-low, local order kept' : 'reranked';
  } catch (error) {
    failures++;
    note = 'fallback: ' + String(error && error.message);
  }
  const denom = ideal(target);
  rows.push({
    key: q.key, query: q.query, relevant: target.size, note,
    before: denom ? dcg(before, target) / denom : null,
    after: denom ? dcg(after, target) / denom : null,
  });
}

const usable = rows.filter(r => r.before !== null && r.after !== null);
const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
const improved = usable.filter(r => r.after > r.before + 1e-9).length;
const worsened = usable.filter(r => r.after < r.before - 1e-9).length;
const same = usable.length - improved - worsened;
const report = {
  vault, documents: notes.size, queriesAsked: chosen.length, queriesScored: usable.length, cut,
  failures, nDCG: { before: mean(usable.map(r => r.before)), after: mean(usable.map(r => r.after)) },
  movement: { improved, worsened, same },
  rows,
};
if (out) { await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2)); }

console.log('queries scored=' + usable.length + '/' + chosen.length + '  cut=' + cut + '  live failures=' + failures);
console.log('nDCG@' + cut + ' before=' + report.nDCG.before.toFixed(4) + '  after=' + report.nDCG.after.toFixed(4));
console.log('improved ' + improved + ', worsened ' + worsened + ', unchanged ' + same);
if (out) console.log('report: ' + out);
