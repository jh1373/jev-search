#!/usr/bin/env node
// Test the katakana word token where it is supposed to matter, on real Japanese text.
//
// A verbatim sentence from a short article is found trivially (R@50 100%, median rank 1), so that task
// cannot separate two segmentations. This builds a harder one: a query is a single katakana loanword
// taken from the corpus, and every document containing that word is relevant. The bigram-only
// segmentation has to work with デプ / プロ / ロイ, and プロ also occurs in プロジェクト and
// プログラマー, so the candidate pool fills with documents that do not contain the word at all.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SearchIndex, tokenize } from '../src/core/search.ts';
import { measure } from './measure-recall.mjs';

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
const katakanaRuns = text => text.normalize('NFKC').toLowerCase().match(/[\p{Script=Katakana}ー]{3,}/gu) ?? [];
const bigramsOf = word => { const p = Array.from(word); const out = []; for (let i = 1; i < p.length; i++) out.push(p[i - 1] + p[i]); return out; };

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
const limit = Number(arg('limit', '50'));
const maxQueries = Number(arg('max-queries', '400'));
const out = arg('out', '');
const truthOut = arg('truth-out', '');

const files = await walk(vault);
const notes = [], texts = new Map(), runsByPath = new Map();
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const path = rel(vault, file);
  texts.set(path, text);
  runsByPath.set(path, new Set(katakanaRuns(text)));
  notes.push({ path, title: file.split(/[\\/]/).pop().replace(/\.md$/, ''), text, tags: [] });
}

// Document frequency of every katakana word, then keep the ones that identify a small set of documents.
const df = new Map();
for (const [, runs] of runsByPath) for (const run of runs) df.set(run, (df.get(run) ?? 0) + 1);
const words = [...df].filter(([word, count]) => count >= 1 && count <= 4 && word.length >= 3 && word.length <= 12).sort((a, b) => a[0].localeCompare(b[0]));
const chosen = words.slice(0, maxQueries);

const queries = [], relevance = [];
for (const [word] of chosen) {
  const key = 'k:' + word;
  queries.push({ key, kind: 'literal', query: word });
  for (const [path, runs] of runsByPath) if (runs.has(word)) relevance.push({ key, path, grade: 2 });
}
const truth = { source: 'ja.wikipedia.org katakana words', queries, relevance };
if (truthOut) await writeFile(truthOut, JSON.stringify(truth, null, 2));

// How much noise the bigram-only view sees for these words: documents sharing a bigram but not the word.
const bigramOnly = chosen.map(([word]) => {
  const bigrams = bigramsOf(word);
  let noise = 0;
  for (const [path, runs] of runsByPath) {
    if (runs.has(word)) continue;
    const text = texts.get(path).normalize('NFKC').toLowerCase();
    if (bigrams.some(b => text.includes(b))) noise++;
  }
  return noise;
}).sort((a, b) => a - b);

const build = tokenizer => {
  const index = new SearchIndex(tokenizer);
  for (const note of notes) index.upsert(note);
  return index;
};
const shippedIndex = build(tokenize);
const baselineIndex = build(baseline);
const shipped = measure({ index: shippedIndex, truth, limit, texts });
const base = measure({ index: baselineIndex, truth, limit, texts });

const pct = v => (v * 100).toFixed(1) + '%';
const row = (label, s) => [label, pct(s.recallAt5), pct(s.recallAt10), pct(s.recallAt20), pct(s.recallAt50), pct(s.matchedAnywhere), s.mrr.toFixed(3), s.medianRank ?? '-'].join('\t');
const shippedRanks = new Map(shipped.rows.map(r => [r.key, r.deepRankAny]));
let improved = 0, worsened = 0, same = 0;
const examples = [];
for (const r of base.rows) {
  const before = r.deepRankAny, after = shippedRanks.get(r.key) ?? null;
  if (before === after) { same++; continue; }
  const gain = (before === null ? Infinity : before) - (after === null ? Infinity : after);
  if (gain > 0) improved++; else worsened++;
  if (examples.length < 15) examples.push({ query: r.query, relevant: truth.relevance.filter(x => x.key === r.key).length, before, after });
}

const report = {
  vault, documents: notes.length, queries: queries.length, cut: limit,
  bigramNoise: { median: bigramOnly[Math.floor(bigramOnly.length / 2)], p90: bigramOnly[Math.floor(bigramOnly.length * 0.9)], max: bigramOnly[bigramOnly.length - 1] },
  baseline: { recallAt5: base.overall.recallAt5, recallAt10: base.overall.recallAt10, recallAt20: base.overall.recallAt20, recallAt50: base.overall.recallAt50, matchedAnywhere: base.overall.matchedAnywhere, mrr: base.overall.mrr, medianRank: base.overall.medianRank, causes: base.causes },
  shipped: { recallAt5: shipped.overall.recallAt5, recallAt10: shipped.overall.recallAt10, recallAt20: shipped.overall.recallAt20, recallAt50: shipped.overall.recallAt50, matchedAnywhere: shipped.overall.matchedAnywhere, mrr: shipped.overall.mrr, medianRank: shipped.overall.medianRank, causes: shipped.causes },
  movement: { improved, worsened, same, examples },
};
if (out) { await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2)); }

console.log('documents=' + notes.length + '  katakana-word queries=' + queries.length + '  cut=' + limit);
console.log('documents sharing a bigram but not the word: median ' + report.bigramNoise.median + ', p90 ' + report.bigramNoise.p90 + ', max ' + report.bigramNoise.max);
console.log(['variant', 'R@5', 'R@10', 'R@20', 'R@50', 'matched', 'MRR', 'medianRank'].join('\t'));
console.log(row('baseline', base.overall));
console.log(row('shipped', shipped.overall));
console.log('rank movement: improved ' + improved + ', worsened ' + worsened + ', unchanged ' + same);
for (const e of examples) console.log('  ' + e.query + ' (relevant ' + e.relevant + ')  ' + e.before + ' -> ' + e.after);
if (out) console.log('report: ' + out);
