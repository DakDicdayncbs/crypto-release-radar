import assert from 'node:assert/strict';
import test from 'node:test';
import { API_VERSION, fetchReleases, MAX_RESPONSE_BYTES } from '../src/github.js';

const config = { maxPages: 3, timeoutMs: 1000 };
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
const next = (page, origin = 'https://api.github.com') => `<${origin}/repos/demo/repo/releases?per_page=100&page=${page}>; rel="next"`;

test('requests only canonical GitHub GET endpoint, pinned API version and optional env-derived token', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push({ url, options }); return json([]); };
  await fetchReleases('demo/repo', config, { fetchImpl });
  await fetchReleases('demo/repo', config, { fetchImpl, token: 'test-sentinel' });
  assert.equal(seen[0].url, 'https://api.github.com/repos/demo/repo/releases?per_page=100&page=1');
  assert.equal(seen[0].options.method, 'GET');
  assert.equal(seen[0].options.redirect, 'manual');
  assert.equal(seen[0].options.headers['X-GitHub-Api-Version'], API_VERSION);
  assert.equal(seen[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(seen[0].options.headers.Authorization, undefined);
  assert.equal(seen[1].options.headers.Authorization, 'Bearer test-sentinel');
});

test('follows validated pagination, including short pages with next link', async () => {
  let calls = 0;
  const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => ++calls === 1 ? json([{ id: 1 }], { link: next(2) }) : json([{ id: 2 }]) });
  assert.equal(calls, 2);
  assert.equal(result.scanComplete, true);
  assert.deepEqual(result.items, [{ id: 1 }, { id: 2 }]);
});

test('page budget surfaces incomplete result and keeps already received entries', async () => {
  const result = await fetchReleases('demo/repo', { ...config, maxPages: 1 }, { fetchImpl: async () => json([{ id: 1 }], { link: next(2) }) });
  assert.equal(result.scanComplete, false);
  assert.equal(result.issues[0].code, 'page_limit');
  assert.equal(result.items.length, 1);
});

test('a full page without Link is probed; empty terminal page finishes the scan', async () => {
  let calls = 0;
  const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => json(++calls === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : []) });
  assert.equal(calls, 2);
  assert.equal(result.scanComplete, true);
});

for (const link of [next(2, 'https://evil.example'), next(1), next(3), next(2).replace('demo/repo', 'other/repo'), next(2).replace('per_page=100', 'per_page=1'), 'garbage', `${next(2)}, ${next(2)}`, next(2).replace('page=2', 'page=2&token=x')]) {
  test('invalid pagination is rejected without making or disclosing an unsafe request', async () => {
    let calls = 0;
    const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => { calls++; return json([{ id: 1 }], { link }); } });
    assert.equal(calls, 1);
    assert.equal(result.issues[0].code, 'invalid_pagination');
    assert.equal(result.items.length, 1);
    assert.ok(!JSON.stringify(result.issues).includes('evil.example'));
  });
}

test('empty page claiming more results is incomplete', async () => {
  const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => json([], { link: next(2) }) });
  assert.equal(result.issues[0].code, 'invalid_pagination');
});

for (const [status, headers, code] of [
  [404, {}, 'not_found'], [401, {}, 'unauthorized'], [403, {}, 'forbidden'],
  [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'], [403, { 'retry-after': '12' }, 'rate_limited'],
  [429, {}, 'rate_limited'], [500, {}, 'http_error'], [302, { location: 'https://evil.example' }, 'redirect_refused'],
]) {
  test(`HTTP ${status} maps to ${code}, omitting raw remote errors`, async () => {
    let calls = 0;
    const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => { calls++; return new Response('remote-error-secret', { status, headers }); } });
    assert.equal(calls, 1);
    assert.equal(result.scanComplete, false);
    assert.equal(result.issues[0].code, code);
    assert.equal(result.issues[0].status, status);
    assert.ok(!JSON.stringify(result).includes('remote-error-secret'));
  });
}

test('rate limit retry hints are numeric and normalized to UTC', async () => {
  const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '60', 'x-ratelimit-reset': '1790762400' } }) });
  assert.equal(result.issues[0].retryAfterSeconds, 60);
  assert.equal(result.issues[0].resetAt, new Date(1790762400 * 1000).toISOString());
});

test('untrusted retry hints are not reflected', async () => {
  const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': 'secret', 'x-ratelimit-reset': 'remote-error' } }) });
  assert.equal(result.issues[0].retryAfterSeconds, undefined);
  assert.equal(result.issues[0].resetAt, undefined);
});

for (const [body, type] of [['not json', 'application/json'], ['{}', 'application/json'], ['[]', 'text/html'], [JSON.stringify(Array(101).fill({})), 'application/json']]) {
  test('rejects malformed JSON, unexpected shape or content type', async () => {
    const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => new Response(body, { headers: { 'content-type': type } }) });
    assert.equal(result.issues[0].code, 'invalid_response');
    assert.equal(result.scanComplete, false);
  });
}

test('rejects oversized declared and streamed responses', async () => {
  for (const headers of [{ 'content-length': String(MAX_RESPONSE_BYTES + 1) }, {}]) {
    const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => new Response(' '.repeat(MAX_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json', ...headers } }) });
    assert.equal(result.issues[0].code, 'response_too_large');
  }
});

test('network exceptions are never echoed', async () => {
  const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => { throw new Error('secret network details'); } });
  assert.equal(result.issues[0].code, 'network_error');
  assert.ok(!JSON.stringify(result).includes('secret network details'));
});

test('invalid UTF-8 cannot silently change remote release text', async () => {
  const bytes = new Uint8Array([91, 34, 255, 34, 93]);
  const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.issues[0].code, 'invalid_response');
});

test('deadline aborts fetch and returns a timeout issue', async () => {
  const result = await fetchReleases('demo/repo', { ...config, timeoutMs: 20 }, { fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private timeout details')), { once: true });
  }) });
  assert.equal(result.issues[0].code, 'timeout');
});

test('later page failure retains previous page and does not claim completeness', async () => {
  let calls = 0;
  const result = await fetchReleases('demo/repo', config, { fetchImpl: async () => ++calls === 1 ? json([{ id: 1 }], { link: next(2) }) : new Response('private error', { status: 500 }) });
  assert.equal(result.pagesFetched, 1);
  assert.deepEqual(result.items, [{ id: 1 }]);
  assert.equal(result.scanComplete, false);
  assert.equal(result.issues[0].code, 'http_error');
});
