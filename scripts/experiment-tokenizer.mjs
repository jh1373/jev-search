#!/usr/bin/env node
// Compares tokenizer variants on the same corpus and the same queries.
//
// The shipped tokenizer splits a Japanese run into overlapping bigrams. That loses word identity
// for katakana loanwords: デプロイ becomes デプ / プロ / ロイ, and プロ also appears in プロジェクト
// and プログラマー, so its IDF collapses and unrelated notes match.
//
// A variant therefore adds each katakana span as one extra token. It has no tuned parameters, so it
// cannot be fitted to this query set, but the corpus is still synthetic and self-authored.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SearchIndex, tokenize } from '../src/core/search.ts';
import { measure } from './measure-recall.mjs';

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}
const rel = (root, full) => full.slice(root.length + 1).split('\\').join('/');

function katakanaSpans(text) {
  const runs = text.normalize('NFKC').toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? [];
  const spans = [];
  for (const run of runs) {
    if (/^[a-z0-9_]/.test(run)) continue;
    for (const span of run.match(/[\p{Script=Katakana}ー]{2,}/gu) ?? []) spans.push(span);
  }
  return spans;
}

// The pre-change tokenizer, kept here so this comparison stays reproducible after the change shipped.
function bigramOnly(text) {
  const tokens = [];
  const runs = text.normalize('NFKC').toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? [];
  for (const run of runs) {
    if (/^[a-z0-9_]/.test(run)) { tokens.push(run); continue; }
    const points = Array.from(run);
    if (points.length === 1) tokens.push(run);
    else for (let i = 1; i < points.length; i++) tokens.push(points[i - 1] + points[i]);
  }
  return tokens;
}

const VARIANTS = {
  baseline: bigramOnly,
  shipped: tokenize,
  // Katakana spans of any length >= 2 become one extra token.
  katakana: text => tokenize(text).concat(katakanaSpans(text).map(s => 'K:' + s)),
  // Only spans of length >= 3, so short katakana words do not add noise.
  katakana3: text => tokenize(text).concat(katakanaSpans(text).filter(s => s.length >= 3).map(s => 'K:' + s)),
};

async function main() {
  const arg = (name, fallback) => {
    const hit = process.argv.find(a => a.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const vault = arg('vault', '.sandbox/corpus-10k/vault');
  const truthPath = arg('truth', '.sandbox/corpus-10k/ground-truth.json');
  const limit = Number(arg('limit', '50'));

  const files = await walk(vault);
  const texts = new Map();
  const notes = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const path = rel(vault, file);
    texts.set(path, text);
    notes.push({ path, title: file.split(/[\\/]/).pop().replace(/\.md$/, ''), text, tags: [] });
  }
  const truth = JSON.parse(await readFile(truthPath, 'utf8'));

  const results = {};
  for (const [name, tokenizer] of Object.entries(VARIANTS)) {
    const index = new SearchIndex(tokenizer);
    const started = Date.now();
    for (const note of notes) index.upsert(note);
    const buildMs = Date.now() - started;
    results[name] = { buildMs, ...measure({ index, truth, limit, texts }) };
  }

  const pct = v => (v * 100).toFixed(1) + '%';
  console.log('corpus: ' + files.length + ' notes, ' + truth.queries.length + ' queries, cut=' + limit);
  const base = results.baseline;
  for (const [name, r] of Object.entries(results)) {
    const o = r.overall;
    console.log(name.padEnd(10) + ' build=' + String(r.buildMs).padStart(5) + 'ms  R@5=' + pct(o.recallAt5) + '  R@10=' + pct(o.recallAt10) + '  R@50=' + pct(o.recallAt50) + '  R@1000=' + pct(o.recallAt1000) + '  matchedAnywhere=' + pct(o.matchedAnywhere) + '  MRR=' + o.mrr.toFixed(3));
    console.log('           literal R@50=' + pct(r.byKind.literal.recallAt50) + '  synonym R@50=' + pct(r.byKind.synonym.recallAt50) + '  missed=' + r.missedCount + ' (noShared=' + r.causes.noSharedTerm + ', rankedLow=' + r.causes.rankedBelowCut + ')');
  }

  const byQuery = new Map(base.rows.map(r => [r.key + '|' + r.kind, r]));
  for (const name of Object.keys(VARIANTS)) {
    if (name === 'baseline' || name === 'shipped') continue;
    const r = results[name];
    const changes = [];
    for (const row of r.rows) {
      const before = byQuery.get(row.key + '|' + row.kind);
      const b = before.rankAny, a = row.rankAny;
      if (b === a) continue;
      if ((b === null && a !== null) || (b !== null && a !== null && a < b) || (b === null && a === null)) changes.push({ dir: '+', kind: row.kind, query: row.query, before: b, after: a });
      else changes.push({ dir: '-', kind: row.kind, query: row.query, before: b, after: a });
    }
    const improved = changes.filter(c => c.dir === '+').length;
    const worsened = changes.filter(c => c.dir === '-').length;
    console.log('');
    console.log('--- ' + name + ' vs baseline: ' + improved + ' improved, ' + worsened + ' worsened (at cut ' + limit + ') ---');
    for (const c of changes) console.log('  ' + c.dir + ' [' + c.kind + '] ' + c.query + '  ' + c.before + ' -> ' + c.after);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
