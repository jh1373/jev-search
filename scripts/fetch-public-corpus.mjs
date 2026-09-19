#!/usr/bin/env node
// Fetch a reproducible Japanese public corpus from Wikipedia and build a ground truth from it.
//
// The synthetic corpus in scripts/gen-corpus.mjs is written by the same author as the tokenizer, so it
// cannot show whether a change helps on real Japanese prose. This fetches real articles instead.
//
// Reproducibility:
//   * every article is recorded with its pageid and revision id in the manifest
//   * re-running with --manifest re-fetches those exact revisions, so the text cannot drift
//   * the query for each article is chosen by a rule over the article text, not by hand
//   * Wikipedia text is CC BY-SA; it is fetched into .sandbox/ and never committed

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://ja.wikipedia.org/w/api.php';
const UA = 'jev-search-benchmark/0.1 (local evaluation; contact: repository owner)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(params) {
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params }).toString();
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': UA } }); }
    catch (error) { last = 'network ' + error.message; await sleep(1000 * (attempt + 1)); continue; }
    if (res.ok) {
      const data = await res.json();
      // maxlag is returned as a body error rather than an HTTP status.
      if (data.error?.code === 'maxlag') { last = 'maxlag'; await sleep(2000 * (attempt + 1)); continue; }
      if (data.error) throw new Error('API error ' + data.error.code + ': ' + data.error.info);
      return data;
    }
    last = 'HTTP ' + res.status;
    if (res.status === 429 || res.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
    throw new Error('API ' + res.status + ' for ' + url);
  }
  throw new Error('API gave up (' + last + ') for ' + url);
}
// Whole-article extracts cannot be batched: the API lowers exlimit to 1 and warns, and fetching them
// one at a time trips HTTP 429 quickly. Introductions can be batched 20 at a time, so the default
// corpus is built from introductions. Use --mode=full for whole articles when the throttle allows it.
async function collect({ target, manifest, mode }) {
  const pages = [];
  const seen = new Set();
  const extractParams = mode === 'intro' ? { exintro: '1', exlimit: '20' } : {};
  const absorb = data => {
    for (const page of data.query?.pages ?? []) {
      if (!page.extract || seen.has(page.pageid)) continue;
      seen.add(page.pageid);
      pages.push(page);
    }
  };
  if (manifest) {
    for (let i = 0; i < manifest.articles.length && pages.length < target; i += 20) {
      const ids = manifest.articles.slice(i, i + 20).map(a => a.pageid).join('|');
      absorb(await api({ action: 'query', pageids: ids, prop: 'extracts|revisions', explaintext: '1', rvprop: 'ids', rvslots: 'main', ...extractParams }));
      await sleep(2000);
      process.stderr.write('\rfetching ' + pages.length + '/' + target);
    }
    return pages;
  }
  // The API throttles long runs, so a run that trips 429 keeps whatever it collected rather than
  // throwing the whole corpus away. Re-run with --manifest to top up the same articles later.
  try {
    while (pages.length < target) {
      absorb(await api({ action: 'query', generator: 'random', grnnamespace: '0', grnlimit: '20', prop: 'extracts|revisions', explaintext: '1', rvprop: 'ids', rvslots: 'main', ...extractParams }));
      await sleep(2000);
      process.stderr.write('\rfetching ' + pages.length + '/' + target);
    }
  } catch (error) {
    process.stderr.write('\nstopped early: ' + error.message + '\n');
  }
  return pages.slice(0, target);
}

const safeName = title => title.replace(/[\\/:*?"<>|#^[\]]/g, '_').slice(0, 120);

// A sentence is usable as a query when it is long enough to carry meaning, short enough to look like a
// search, and does not contain the article title (which would make the match trivial).
function pickSentence(text, title, pageid) {
  const sentences = text.split('。').map(s => s.trim()).filter(s => s.length >= 15 && s.length <= 90);
  const usable = sentences.filter(s => !s.includes(title));
  if (!usable.length) return null;
  return usable[pageid % usable.length];
}

export async function build({ out, articles, manifestPath, mode = 'intro' }) {
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
  const pages = await collect({ target: articles, manifest, mode });
  process.stderr.write('\n');

  await mkdir(out, { recursive: true });
  const entries = [];
  const sentenceOwners = new Map();
  for (const page of pages) {
    const text = String(page.extract ?? '').trim();
    if (text.length < 100) continue;
    const file = safeName(page.title) + '.md';
    await writeFile(join(out, file), '# ' + page.title + '\n\n' + text + '\n');
    const sentence = pickSentence(text, page.title, page.pageid);
    if (sentence) {
      if (!sentenceOwners.has(sentence)) sentenceOwners.set(sentence, []);
      sentenceOwners.get(sentence).push(file);
    }
    entries.push({ pageid: page.pageid, revid: page.revisions?.[0]?.revid ?? null, title: page.title, file, sentence });
  }

  // A sentence that appears in more than one article cannot identify one target, so drop those queries
  // rather than label an arbitrary one as relevant.
  const ambiguous = new Set([...sentenceOwners].filter(([, owners]) => owners.length > 1).map(([sentence]) => sentence));
  const queries = [], relevance = [];
  for (const entry of entries) {
    if (!entry.sentence || ambiguous.has(entry.sentence)) continue;
    const key = 'w' + entry.pageid;
    queries.push({ key, kind: 'literal', query: entry.sentence });
    relevance.push({ key, path: entry.file, grade: 2 });
  }

  const truth = { source: 'ja.wikipedia.org', seed: null, queries, relevance };
  const manifestOut = {
    source: 'ja.wikipedia.org', fetchedAt: new Date().toISOString(),
    articles: entries.map(e => ({ pageid: e.pageid, revid: e.revid, title: e.title, file: e.file })),
    corpusHash: createHash('sha256').update(entries.map(e => e.pageid + ':' + e.revid).sort().join('\n')).digest('hex').slice(0, 16),
  };
  await writeFile(join(out, '..', 'wiki-manifest.json'), JSON.stringify(manifestOut, null, 2));
  await writeFile(join(out, '..', 'wiki-truth.json'), JSON.stringify(truth, null, 2));
  return { articles: entries.length, queries: queries.length, dropped: entries.length - queries.length, corpusHash: manifestOut.corpusHash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const hit = process.argv.find(a => a.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const result = await build({
    out: arg('out', '.sandbox/wiki/vault'),
    articles: Number(arg('articles', '400')),
    manifestPath: arg('manifest', '') || null,
    mode: arg('mode', 'intro'),
  });
  console.log(JSON.stringify(result));
}
