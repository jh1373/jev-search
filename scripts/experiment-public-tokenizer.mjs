#!/usr/bin/env node
// Re-run the tokenizer comparison on real Japanese prose instead of the synthetic corpus.
//
// The synthetic corpus in scripts/gen-corpus.mjs was written by the same author as the tokenizer, so it
// cannot show whether the katakana word token helps on text nobody tuned for. This measures both
// segmentations over the Wikipedia corpus from scripts/fetch-public-corpus.mjs, using the same harness
// and the same shipped search core.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SearchIndex, tokenize } from '../src/core/search.ts';
import { measure } from './measure-recall.mjs';

// The shipped tokenizer minus the katakana whole-word token, and nothing else changed.
function baseline(text) {
  const tokens = [];
  const runs = text.normalize('NFKC').toLowerCase().match(
    /[a-z0-9_]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu,
  ) ?? [];
  for (const run of runs) {
    if (/^[a-z0-9_]/.test(run)) { tokens.push(run); continue; }
    const points = Array.from(run);
    if (points.length === 1) tokens.push(run);
    else for (let i = 1; i < points.length; i++) tokens.push(points[i - 1] + points[i]);
  }
  return tokens;
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

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const vault = arg('vault', '.sandbox/wiki/vault');
const truthPath = arg('truth', '.sandbox/wiki/wiki-truth.json');
const limit = Number(arg('limit', '50'));
const out = arg('out', '');

const files = await walk(vault);
const texts = new Map();
const notes = [];
let bytes = 0, chars = 0;
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const path = rel(vault, file);
  bytes += Buffer.byteLength(text);
  chars += text.length;
  texts.set(path, text);
  notes.push({ path, title: file.split(/[\\/]/).pop().replace(/\.md$/, ''), text, tags: [] });
}
const truth = JSON.parse(await readFile(truthPath, 'utf8'));

const build = tokenizer => {
  const index = new SearchIndex(tokenizer);
  const started = Date.now();
  for (const note of notes) index.upsert(note);
  return { index, buildMs: Date.now() - started };
};
const shippedBuilt = build(tokenize);
const baselineBuilt = build(baseline);
const shipped = measure({ index: shippedBuilt.index, truth, limit, texts });
const base = measure({ index: baselineBuilt.index, truth, limit, texts });

const pct = v => (v * 100).toFixed(1) + '%';
const row = (label, s) => [label, pct(s.recallAt5), pct(s.recallAt10), pct(s.recallAt20), pct(s.recallAt50), pct(s.matchedAnywhere), s.mrr.toFixed(3), s.medianRank ?? '-'].join('\t');

const shippedRanks = new Map(shipped.rows.map(r => [r.key, r.deepRankAny]));
let improved = 0, worsened = 0, same = 0;
const movements = [];
for (const r of base.rows) {
  const before = r.deepRankAny, after = shippedRanks.get(r.key) ?? null;
  if (before === after) { same++; continue; }
  const gain = (before === null ? Infinity : before) - (after === null ? Infinity : after);
  if (gain > 0) improved++; else worsened++;
  if (movements.length < 12) movements.push({ query: r.query.slice(0, 26), before, after });
}

const report = {
  vault, documents: notes.length, bytes, meanChars: Math.round(chars / notes.length),
  queries: truth.queries.length, cut: limit,
  buildMs: { baseline: baselineBuilt.buildMs, shipped: shippedBuilt.buildMs },
  baseline: { recallAt5: base.overall.recallAt5, recallAt10: base.overall.recallAt10, recallAt20: base.overall.recallAt20, recallAt50: base.overall.recallAt50, matchedAnywhere: base.overall.matchedAnywhere, mrr: base.overall.mrr, medianRank: base.overall.medianRank, causes: base.causes },
  shipped: { recallAt5: shipped.overall.recallAt5, recallAt10: shipped.overall.recallAt10, recallAt20: shipped.overall.recallAt20, recallAt50: shipped.overall.recallAt50, matchedAnywhere: shipped.overall.matchedAnywhere, mrr: shipped.overall.mrr, medianRank: shipped.overall.medianRank, causes: shipped.causes },
  movement: { improved, worsened, same, examples: movements },
};
if (out) { await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2)); }

console.log('documents=' + notes.length + '  meanChars=' + report.meanChars + '  queries=' + truth.queries.length + '  cut=' + limit);
console.log(['variant', 'R@5', 'R@10', 'R@20', 'R@50', 'matched', 'MRR', 'medianRank'].join('\t'));
console.log(row('baseline', base.overall));
console.log(row('shipped', shipped.overall));
console.log('rank movement: improved ' + improved + ', worsened ' + worsened + ', unchanged ' + same);
console.log('causes (shipped): no shared term ' + shipped.causes.noSharedTerm + ', below cut ' + shipped.causes.rankedBelowCut + ', absent ' + shipped.causes.matchedButAbsent);
for (const m of movements) console.log('  ' + m.query + '  ' + m.before + ' -> ' + m.after);
if (out) console.log('report: ' + out);
