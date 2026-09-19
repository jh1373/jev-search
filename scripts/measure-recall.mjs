#!/usr/bin/env node
// Recall / MRR harness for the local BM25 stage, plus a failure diagnosis.
//
// RV-02 warns that Jev cannot rescue a candidate the local stage never surfaced, so this measures
// the local stage on its own. It imports the shipped search core directly, so the numbers describe
// the code that ships rather than a reimplementation.
//
// The diagnosis separates two very different problems that both look like "recall is low":
//   no-shared-token  the query and the note share no term at all, so no BM25 variant can ever find
//                    it; only synonyms, aliases or embeddings can
//   ranked-too-low   the note matches but sits below the cut; better scoring or a larger cut helps

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SearchIndex, tokenize } from '../src/core/search.ts';

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const rel = (root, full) => full.slice(root.length + 1).split('\\').join('/');
const distinctNotes = hits => {
  const order = [], seen = new Set();
  for (const hit of hits) if (!seen.has(hit.path)) { seen.add(hit.path); order.push(hit.path); }
  return order;
};

export function measure({ index, truth, limit, texts, deepLimit = 100000 }) {
  const ks = [5, 10, 20, 50, 100, 200, 500, 1000].filter(k => k <= deepLimit);
  const relevantByKey = new Map();
  for (const r of truth.relevance) {
    if (!relevantByKey.has(r.key)) relevantByKey.set(r.key, []);
    relevantByKey.get(r.key).push(r);
  }
  const rows = [];
  for (const q of truth.queries) {
    const rel = relevantByKey.get(q.key) ?? [];
    const grade2 = rel.find(r => r.grade === 2)?.path;
    const order = distinctNotes(index.search(q.query, limit));
    const deep = distinctNotes(index.search(q.query, deepLimit));
    const rankAny = order.findIndex(p => rel.some(r => r.path === p));
    const rankExact = grade2 ? order.indexOf(grade2) : -1;
    const deepRankAny = deep.findIndex(p => rel.some(r => r.path === p));
    const deepRankExact = grade2 ? deep.indexOf(grade2) : -1;
    const queryTerms = new Set(tokenize(q.query));
    const targetText = grade2 ? (texts.get(grade2) ?? '') : '';
    const targetTerms = new Set(tokenize(targetText));
    const shared = [...queryTerms].filter(t => targetTerms.has(t));
    rows.push({
      key: q.key, kind: q.kind, query: q.query,
      rankAny: rankAny < 0 ? null : rankAny + 1,
      rankExact: rankExact < 0 ? null : rankExact + 1,
      deepRankAny: deepRankAny < 0 ? null : deepRankAny + 1,
      deepRankExact: deepRankExact < 0 ? null : deepRankExact + 1,
      sharedTerms: shared.length,
      shared: shared.slice(0, 8),
      top: order.slice(0, 3),
    });
  }
  const summarise = subset => {
    const out = { queries: subset.length };
    // Use the true (uncapped) rank: rankAny is truncated at the cut, so it cannot answer k > limit.
    for (const k of ks) out['recallAt' + k] = subset.length ? subset.filter(r => r.deepRankAny !== null && r.deepRankAny <= k).length / subset.length : 0;
    out.matchedAnywhere = subset.length ? subset.filter(r => r.deepRankAny !== null).length / subset.length : 0;
    out.mrr = subset.length ? subset.reduce((sum, r) => sum + (r.rankAny ? 1 / r.rankAny : 0), 0) / subset.length : 0;
    const ranks = subset.filter(r => r.rankAny !== null).map(r => r.rankAny).sort((a, b) => a - b);
    out.medianRank = ranks.length ? ranks[Math.floor(ranks.length / 2)] : null;
    return out;
  };
  const missed = rows.filter(r => r.deepRankAny === null || r.deepRankAny > limit);
  const causes = {
    noSharedTerm: missed.filter(r => r.sharedTerms === 0).length,
    rankedBelowCut: missed.filter(r => r.sharedTerms > 0 && r.deepRankAny !== null).length,
    matchedButAbsent: missed.filter(r => r.sharedTerms > 0 && r.deepRankAny === null).length,
  };
  const belowRanks = missed.filter(r => r.deepRankAny !== null).map(r => r.deepRankAny).sort((a, b) => a - b);
  return {
    limit,
    overall: summarise(rows),
    byKind: {
      literal: summarise(rows.filter(r => r.kind === 'literal')),
      synonym: summarise(rows.filter(r => r.kind === 'synonym')),
    },
    missedCount: missed.length,
    causes,
    deepRankMedian: belowRanks.length ? belowRanks[Math.floor(belowRanks.length / 2)] : null,
    deepRankMax: belowRanks.length ? belowRanks[belowRanks.length - 1] : null,
    failures: missed,
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
  const texts = new Map();
  const started = Date.now();
  let bytes = 0;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const path = rel(vault, file);
    bytes += Buffer.byteLength(text);
    texts.set(path, text);
    index.upsert({ path, title: file.split(/[\\/]/).pop().replace(/\.md$/, ''), text, tags: [] });
  }
  const buildMs = Date.now() - started;

  const truth = JSON.parse(await readFile(truthPath, 'utf8'));
  const startedQuery = Date.now();
  const result = measure({ index, truth, limit, texts });
  const queryMs = Date.now() - startedQuery;

  const report = { vault, files: files.length, indexedNotes: index.size, bytes, buildMs, queryMs, ...result };
  if (out) { await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2)); }

  const pct = v => (v * 100).toFixed(1) + '%';
  console.log('notes=' + index.size + '  chunks=' + (index.size ? 'n/a' : '') + '  build=' + buildMs + 'ms  queries=' + truth.queries.length + '  cut=' + limit);
  const o = result.overall;
  console.log('overall  R@5=' + pct(o.recallAt5) + '  R@10=' + pct(o.recallAt10) + '  R@50=' + pct(o.recallAt50) + '  R@200=' + pct(o.recallAt200) + '  R@1000=' + pct(o.recallAt1000) + '  matchedAnywhere=' + pct(o.matchedAnywhere) + '  MRR=' + o.mrr.toFixed(3));
  for (const kind of ['literal', 'synonym']) {
    const s = result.byKind[kind];
    console.log(kind.padEnd(7) + '  R@50=' + pct(s.recallAt50) + '  R@1000=' + pct(s.recallAt1000) + '  matchedAnywhere=' + pct(s.matchedAnywhere) + '  MRR=' + s.mrr.toFixed(3) + '  medianRank=' + s.medianRank);
  }
  console.log('missed at cut: ' + result.missedCount);
  console.log('  no shared term at all (BM25 cannot find it): ' + result.causes.noSharedTerm);
  console.log('  shares a term but ranked below the cut:      ' + result.causes.rankedBelowCut + '  (median deep rank ' + result.deepRankMedian + ', worst ' + result.deepRankMax + ')');
  console.log('  shares a term but absent from the index:     ' + result.causes.matchedButAbsent);
  for (const f of result.failures.slice(0, 10)) console.log('  [' + f.kind + '] shared=' + f.sharedTerms + ' deepRank=' + f.deepRankAny + '  ' + f.query);
  if (out) console.log('report: ' + out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
