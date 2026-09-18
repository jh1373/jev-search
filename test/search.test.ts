import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchIndex, isExcluded, tokenize } from '../src/core/search.ts';
import type { SearchNote } from '../src/core/search.ts';

const note = (path: string, text: string, title = ''): SearchNote => ({ path, text, title, tags: [] });

test('tokenize normalizes width/case and uses Japanese code point bigrams only', () => {
  assert.deepEqual(tokenize('ＢＭ２５ 管理 再ランキング'), ['bm25', '管理', '再ラ', 'ラン', 'ンキ', 'キン', 'ング']);
  assert.deepEqual(tokenize('Foo_bar １２３ a-b 日 あ カ ｶﾀｶﾅ'), ['foo_bar', '123', 'a', 'b', '日', 'あ', 'カ', 'カタ', 'タカ', 'カナ']);
  assert.deepEqual(tokenize('𠮷野家 😀 ABC'), ['𠮷野', '野家', 'abc']);
  assert.deepEqual(tokenize('! 😀'), []);
});

test('exclusions use folder/config boundaries, hidden directories, and normalized paths', () => {
  const excluded = (path: string) => isExcluded(path, [], ['Private', 'Archive/old/'], [], 'Settings');
  for (const path of ['Private/a.md', 'private', 'Archive/old/a.md', 'Settings/a.md', '.obsidian/a.md', 'a/.cache/n.md', 'a\\.cache\\n.md', './Private//a.md', 'x/../Private/a.md', '../a.md']) {
    assert.equal(excluded(path), true, path);
  }
  for (const path of ['Privateish/a.md', 'Archive/older/a.md', 'Settings2/a.md', 'x/Private/a.md', 'public/a.md', '.hidden.md']) {
    assert.equal(excluded(path), false, path);
  }
  assert.equal(isExcluded('anything.md', [], [''], [], ''), false);
  assert.equal(isExcluded('anything.md', [], ['/'], [], ''), true);
});

test('excluded tags match exact tags and descendants, not similar prefixes', () => {
  for (const tag of ['#Private', 'private/child', '#PRIVATE/child/deep']) {
    assert.equal(isExcluded('a.md', [tag], [], ['#private'], ''), true);
  }
  for (const tag of ['privateish', 'x/private', 'public']) {
    assert.equal(isExcluded('a.md', [tag], [], ['private', ''], ''), false);
  }
});

test('frontmatter is withheld, original CRLF and one-based lines are retained', () => {
  const index = new SearchIndex();
  index.upsert(note('a.md', '\uFEFF---\r\nsecret: hiddenvalue\r\n---\r\nintro\r\n# Topic ##\r\nbody\r\n'));
  assert.deepEqual(index.search('hiddenvalue'), []);
  const intro = index.search('intro')[0];
  assert.equal(intro.startLine, 4);
  assert.equal(intro.text, 'intro\r\n');
  assert.equal(intro.heading, '');
  const body = index.search('body')[0];
  assert.equal(body.startLine, 5);
  assert.equal(body.heading, 'Topic');
  assert.equal(body.text, '# Topic ##\r\nbody\r\n');
  index.upsert(note('unclosed.md', '---\nsecret: hiddenvalue'));
  assert.equal(index.size, 1);
  index.upsert(note('dots.md', '---\nsecret: hiddenvalue\n...\nvisible'));
  assert.equal(index.search('visible')[0].startLine, 4);
});

test('ATX boundaries ignore fenced headings and preserve searchable code/link text', () => {
  const index = new SearchIndex();
  index.upsert(note('a.md', 'lead\n# Real\n````js\n# fake\n```\n# stillfake\n````\n~~~\n## tildefake\n~~~\n###### Last\n[linkword](target.md) ![[embed.md]]'));
  for (const query of ['fake', 'stillfake', 'tildefake']) {
    assert.equal(index.search(query)[0].heading, 'Real');
  }
  assert.equal(index.search('lead')[0].startLine, 1);
  assert.equal(index.search('linkword')[0].heading, 'Last');
  assert.equal(index.search('target')[0].startLine, 11);
  index.upsert(note('unclosed.md', '# First\n~~~\n# notheading\n'));
  assert.equal(index.search('notheading')[0].heading, 'First');
});

test('hard chunks have 1200 code points, 120 overlap, and stable unique IDs', () => {
  const index = new SearchIndex();
  const text = '😀'.repeat(2500);
  index.upsert(note('a.md', text, 'marker'));
  const hits = index.search('marker').sort((a, b) => JSON.parse(a.id)[2] - JSON.parse(b.id)[2]);
  assert.deepEqual(hits.map(hit => Array.from(hit.text).length), [1200, 1200, 340]);
  assert.equal(hits.map((hit, i) => i ? Array.from(hit.text).slice(120).join('') : hit.text).join(''), text);
  assert.ok(hits.every(hit => hit.startLine === 1));
  assert.equal(new Set(hits.map(hit => hit.id)).size, 3);
  const ids = index.search('marker').map(hit => hit.id);
  index.upsert(note('a.md', text, 'marker'));
  assert.deepEqual(index.search('marker').map(hit => hit.id), ids);
});

test('paragraph splits are preferred and long multiline chunks retain source line offsets', () => {
  const index = new SearchIndex();
  const text = 'a'.repeat(700) + '\r\n\r\n' + 'b'.repeat(700);
  index.upsert(note('paragraph.md', text, 'marker'));
  const paragraphs = index.search('marker').sort((a, b) => a.startLine - b.startLine);
  assert.deepEqual(paragraphs.map(hit => hit.startLine), [1, 3]);
  assert.equal(paragraphs.map(hit => hit.text).join(''), text);
  index.clear();
  const multiline = ('x'.repeat(99) + '\n').repeat(25);
  index.upsert(note('lines.md', multiline, 'marker'));
  const hits = index.search('marker').sort((a, b) => a.startLine - b.startLine);
  assert.deepEqual(hits.map(hit => hit.startLine), [1, 11, 22]);
  assert.equal(hits.map((hit, i) => i ? hit.text.slice(120) : hit.text).join(''), multiline);
  index.clear();
  index.upsert(note('crlf.md', ('x'.repeat(98) + '\r\n').repeat(25), 'marker'));
  assert.deepEqual(index.search('marker').map(hit => hit.text.length).sort((a, b) => a - b), [340, 1200, 1200]);
});

test('BM25 uses exact formula, deduplicates queries and boosts title/heading', () => {
  const index = new SearchIndex();
  index.upsert(note('a.md', 'apple'));
  assert.ok(Math.abs(index.search('apple')[0].score - Math.log(1 + 0.5 / 1.5)) < 1e-12);
  assert.deepEqual(index.search('apple apple'), index.search('apple'));
  index.clear();
  index.upsert(note('body.md', 'needle filler'));
  index.upsert(note('title.md', 'other filler', 'needle'));
  assert.equal(index.search('needle')[0].path, 'title.md');
  index.clear();
  index.upsert(note('body.md', 'needle filler'));
  index.upsert(note('heading.md', '# needle\nfiller'));
  assert.equal(index.search('needle')[0].path, 'heading.md');
  index.upsert(note('ja.md', '再ランキングと管理'));
  assert.equal(index.search('再ランキング')[0].path, 'ja.md');
  assert.ok(index.search('needle 管理').every(hit => Number.isFinite(hit.score) && hit.score > 0));
});

test('upsert/remove/clear maintain statistics, discard stale terms and return copies', () => {
  const index = new SearchIndex();
  const original = note('a.md', '# repeated\noldword\n# repeated\noldword');
  index.upsert(original);
  const old = index.search('oldword');
  assert.equal(index.size, 1);
  assert.equal(old.length, 2);
  assert.equal(new Set(old.map(hit => hit.id)).size, 2);
  assert.deepEqual(old.map(hit => hit.startLine), [1, 3]);
  old[0].text = 'mutated';
  original.text = 'caller mutation';
  assert.notEqual(index.search('oldword')[0].text, 'mutated');
  index.upsert(note('a.md', 'newword'));
  assert.deepEqual(index.search('oldword'), []);
  const fresh = new SearchIndex();
  fresh.upsert(note('a.md', 'newword'));
  assert.deepEqual(index.search('newword'), fresh.search('newword'));
  index.remove('missing.md');
  index.remove('a.md');
  assert.equal(index.size, 0);
  assert.deepEqual(index.search('newword'), []);
  index.upsert(note('a.md', 'newword'));
  index.clear();
  assert.equal(index.size, 0);
  index.upsert(note('a.md', 'newword'));
  assert.deepEqual(index.search('newword'), fresh.search('newword'));
});

test('incremental field statistics match a rebuilt multi-note index', () => {
  const index = new SearchIndex();
  index.upsert(note('a.md', '# apple\napple pear', 'apple'));
  index.upsert(note('b.md', 'pear pear apple', 'pear'));
  index.upsert(note('c.md', 'obsolete apple'));
  const before = index.search('apple').find(hit => hit.path === 'a.md')!.id;
  const updated = note('a.md', '# pear\napple pear pear', 'pear');
  index.upsert(updated);
  index.remove('c.md');
  const fresh = new SearchIndex();
  fresh.upsert(updated);
  fresh.upsert(note('b.md', 'pear pear apple', 'pear'));
  assert.deepEqual(index.search('apple pear'), fresh.search('apple pear'));
  assert.deepEqual(index.search('obsolete'), []);
  assert.notEqual(index.search('apple').find(hit => hit.path === 'a.md')!.id, before);
});

test('empty input, default/explicit limits and ties are deterministic', () => {
  const index = new SearchIndex();
  assert.deepEqual(index.search('word'), []);
  for (let i = 59; i >= 0; i--) index.upsert(note(`${i.toString().padStart(2, '0')}.md`, 'word'));
  assert.equal(index.size, 60);
  assert.equal(index.search('word').length, 50);
  assert.deepEqual(index.search('word', 2).map(hit => hit.path), ['00.md', '01.md']);
  assert.equal(index.search('word', Infinity).length, 60);
  assert.equal(index.search('word', 1.9).length, 1);
  for (const limit of [0, -1, NaN]) assert.deepEqual(index.search('word', limit), []);
  for (const query of ['', '😀!?', 'unmatched']) assert.deepEqual(index.search(query), []);
});

test('blank/frontmatter-only and over-1MiB notes are not retained; oversize replaces stale entries', () => {
  const index = new SearchIndex();
  index.upsert(note('blank.md', '\n \t\r\n', 'title'));
  index.upsert(note('meta.md', '---\nkey: value\n---\n'));
  assert.equal(index.size, 0);
  index.upsert(note('a.md', 'oldword'));
  index.upsert(note('a.md', 'x'.repeat(1024 * 1024 + 1)));
  index.upsert(note('unicode.md', '日'.repeat(350000)));
  assert.equal(index.size, 0);
  assert.deepEqual(index.search('oldword'), []);
});
