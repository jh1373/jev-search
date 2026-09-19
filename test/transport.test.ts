import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestUrlTransport } from '../src/adapters/transport.ts';

test('requestUrl transport: sends headers, credentials and body correctly', async () => {
  let captured: any = null;
  const mockRequester = async (params: any) => {
    captured = params;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      arrayBuffer: new ArrayBuffer(10),
      json: { ok: true },
      text: '{"ok":true}',
    };
  };

  const transport = createRequestUrlTransport(mockRequester);
  const signal = new AbortController().signal;
  const endpoint = { url: 'https://example.com/api', headers: { 'custom-header': 'val' } };
  const res = await transport('{"query":"test"}', 'test-key', signal, endpoint);

  assert.equal(res.status, 200);
  assert.equal(res.body, '{"ok":true}');
  assert.equal(captured.url, 'https://example.com/api');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Authorization'], 'Bearer test-key');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.equal(captured.headers['custom-header'], 'val');
  assert.equal(captured.throw, false);
});

test('requestUrl transport: extracts retry-after header in any case', async () => {
  // Lowercase
  const transport1 = createRequestUrlTransport(async () => ({
    status: 429,
    headers: { 'retry-after': '60' },
    arrayBuffer: new ArrayBuffer(0),
    json: null,
    text: 'rate-limited',
  }));
  const res1 = await transport1('{}', 'k', new AbortController().signal);
  assert.equal(res1.status, 429);
  assert.equal(res1.retryAfter, '60');

  // Title case
  const transport2 = createRequestUrlTransport(async () => ({
    status: 429,
    headers: { 'Retry-After': '120' },
    arrayBuffer: new ArrayBuffer(0),
    json: null,
    text: 'rate-limited',
  }));
  const res2 = await transport2('{}', 'k', new AbortController().signal);
  assert.equal(res2.status, 429);
  assert.equal(res2.retryAfter, '120');
});

test('requestUrl transport: rejects pre-cancelled requests without sending', async () => {
  let called = false;
  const transport = createRequestUrlTransport(async () => {
    called = true;
    return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: '{}' };
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transport('{}', 'k', controller.signal), /cancelled/);
  assert.equal(called, false, 'Requester must not be called if signal was already aborted');
});

test('requestUrl transport: cancels immediately when abort signal fires mid-request', async () => {
  const controller = new AbortController();
  const transport = createRequestUrlTransport(async () => {
    // Simulate long hanging request
    await new Promise(r => setTimeout(r, 5000));
    return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: '{}' };
  });

  const promise = transport('{}', 'k', controller.signal);
  // Abort after 50ms
  setTimeout(() => controller.abort(), 50);

  const start = Date.now();
  await assert.rejects(promise, /cancelled/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `Must cancel promptly, took ${elapsed}ms`);
});

test('requestUrl transport: rejects payloads over 1MiB', async () => {
  const bigText = 'a'.repeat(1048577);
  const transport = createRequestUrlTransport(async () => ({
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(bigText.length),
    json: null,
    text: bigText,
  }));

  await assert.rejects(transport('{}', 'k', new AbortController().signal), /response-too-large/);
});
