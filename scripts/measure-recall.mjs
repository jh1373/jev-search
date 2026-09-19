#!/usr/bin/env node
// Recall / MRR harness for the local BM25 stage.
//
// RV-02 warns that Jev cannot rescue a candidate the local stage never surfaced, so this measures
// the local stage on its own. It imports the shipped search core directly, so the numbers describe
// the code that ships rather than a reimplementation.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SearchIndex } from '../src/core/search.ts';

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function rel(root, full) {
  return full.slice(root.length + 1).split('\\').join('/');
}

export function measure({ index, truth, limit }) {
  const ks = [5, 10, 20, 50].filter(k => k <= limit);
  const relevantByKey = new Map();
  for (const r of truth.relevance) {
    if (!relevantByKey.has(r.key)) relevantByKey.set(r.key, []);
    relevantByKey.get(r.key).push(r);
  }
  const rows = [];
  for (const q of truth.queries) {
    const hits = index.search(q.query, limit);
    const order = [];
    const seen = new Set();
    for (const hit of hits) if (!seen.has(hit.path)) { seen.add(hit.path); order.push(hit.path); }
    const rel = relevantByKey.get(q.key) ?? [];
    const grade2 = rel.find(r => r.grade === 2)?.path;
    const rankAny = order.findIndex(p => rel.some(r => r.path === p));
    const rankExact = grade2 ? order.indexOf(grade2) : -1;
    rows.push({
      key: q.key, kind: q.kind, query: q.query,
      rankAny: rankAny < 0 ? null : rankAny + 1,
      rankExact: rankExact < 0 ? null : rankExact + 1,
      top: order.slice(0, 3),
    });
  }
  const summarise = subset => {
    const out = { queries: subset.length };
    for (const k of ks) out['recallAt' + k] = subset.length ? subset.filter(r => r.rankAny !== null && r.rankAny <= k).length / subset.length : 0;
    const exact = subset.filter(r => r.rankExact !== null);
    out.exactRecallAt50 = subset.length ? exact.filter(r => r.rankExact <= limit).length / subset.length : 0;
    out.mrr = subset.length ? subset.reduce((sum, r) => sum + (r.rankAny ? 1 / r.rankAny : 0), 0) / subset.length : 0;
    out.medianRank = (() => {
      const ranks = subset.filter(r => r.rankAny !== null).map(r => r.rankAny).sort((a, b) => a - b);
      return ranks.length ? ranks[Math.floor(ranks.length / 2)] : null;
    })();
    return out;
  };
  const failures = rows.filter(r => r.rankAny === null || r.rankAny > 50);
  return {
    limit,
    overall: summarise(rows),
    byKind: {
      literal: summarise(rows.filter(r => r.kind === 'literal')),
      synonym: summarise(rows.filter(r => r.kind === 'synonym')),
    },
    failures,
    rows,
  };
}

async function main() {
  const arg = (name, fallback) => {
    const hit = process.argv.find(a => a.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const vault = arg('vault', '.sandbox/corpus-small/vault');
  const truthPath = arg('truth', '.sandbox/corpus-small/ground-truth.json');
  const limit = Number(arg('limit', '50'));
  const out = arg('out', '');

  const files = await walk(vault);
  const index = new SearchIndex();
  const started = Date.now();
  let bytes = 0;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    bytes += Buffer.byteLength(text);
    index.upsert({ path: rel(vault, file), title: file.split(/[\\/]/).pop().replace(/\.md$/, ''), text, tags: [] });
  }
  const buildMs = Date.now() - started;

  const truth = JSON.parse(await readFile(truthPath, 'utf8'));
  const startedQuery = Date.now();
  const result = measure({ index, truth, limit });
  const queryMs = Date.now() - startedQuery;

  const report = { vault, files: files.length, indexedNotes: index.size, bytes, buildMs, queryMs, ...result };
  if (out) { await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2)); }

  const pct = v => (v * 100).toFixed(1) + '%';
  console.log('notes=' + index.size + '  build=' + buildMs + 'ms  queries=' + truth.queries.length + '  limit=' + limit);
  console.log('overall  R@5=' + pct(result.overall.recallAt5) + '  R@10=' + pct(result.overall.recallAt10) + '  R@20=' + pct(result.overall.recallAt20) + '  R@50=' + pct(result.overall.recallAt50) + '  MRR=' + result.overall.mrr.toFixed(3));
  for (const kind of ['literal', 'synonym']) {
    const s = result.byKind[kind];
    console.log(kind.padEnd(7) + '  R@5=' + pct(s.recallAt5) + '  R@10=' + pct(s.recallAt10) + '  R@50=' + pct(s.recallAt50) + '  MRR=' + s.mrr.toFixed(3) + '  medianRank=' + s.medianRank);
  }
  console.log('failures(not in top ' + limit + '): ' + result.failures.length);
  for (const f of result.failures.slice(0, 12)) console.log('  [' + f.kind + '] ' + f.query + '  top=' + JSON.stringify(f.top));
  if (out) console.log('report: ' + out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
