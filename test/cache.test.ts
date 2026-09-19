import test from 'node:test';
import assert from 'node:assert/strict';
import { JudgementCache, judgementKey } from '../src/core/cache.ts';

const judgement = (score: number) => ({ scores: [score], inputTokens: 10, cost: 0.0001 });

test('judgement keys separate the body, the route and the key', () => {
  const a = judgementKey('{"q":1}', 'openrouter', 'key-a');
  assert.notEqual(a, judgementKey('{"q":2}', 'openrouter', 'key-a'));
  assert.notEqual(a, judgementKey('{"q":1}', 'direct', 'key-a'));
  assert.notEqual(a, judgementKey('{"q":1}', 'openrouter', 'key-b'));
  assert.equal(a, judgementKey('{"q":1}', 'openrouter', 'key-a'));
  // The key material is hashed, so the API key never appears in the map key.
  assert.ok(!a.includes('key-a'));
});

test('a stored judgement is returned until its TTL passes', () => {
  const cache = new JudgementCache(30);
  assert.equal(cache.get('body', 0), null);
  cache.set('body', judgement(2), 0);
  assert.deepEqual(cache.get('body', 0), judgement(2));
  assert.deepEqual(cache.get('body', 30 * 60000 - 1), judgement(2));
  assert.equal(cache.get('body', 30 * 60000), null);
  assert.equal(cache.size, 0);
});

test('a zero TTL disables the cache in both directions', () => {
  const cache = new JudgementCache(0);
  assert.equal(cache.enabled, false);
  cache.set('body', judgement(1), 0);
  assert.equal(cache.size, 0);
  assert.equal(cache.get('body', 0), null);
});

test('the cache evicts the least recently used entry, and a read counts as use', () => {
  const cache = new JudgementCache(30, 2);
  cache.set('a', judgement(0), 0);
  cache.set('b', judgement(1), 0);
  // Reading 'a' makes 'b' the oldest.
  assert.deepEqual(cache.get('a', 0), judgement(0));
  cache.set('c', judgement(2), 0);
  assert.equal(cache.get('b', 0), null);
  assert.deepEqual(cache.get('a', 0), judgement(0));
  assert.deepEqual(cache.get('c', 0), judgement(2));
  assert.equal(cache.size, 2);
});

test('clear drops every entry, and a later set starts over', () => {
  const cache = new JudgementCache(30);
  cache.set('a', judgement(0), 0);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a', 0), null);
});
