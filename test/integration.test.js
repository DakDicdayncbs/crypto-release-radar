import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runCli } from '../src/cli.js';

const release = (id, repo = 'demo/one', overrides = {}) => ({
  id, tag_name: `v${id}`, name: `Release ${id}`, draft: false, prerelease: false,
  published_at: `2026-09-${String(id).padStart(2, '0')}T12:00:00Z`,
  html_url: `https://github.com/${repo}/releases/tag/v${id}`, body: `Changes ${id}`, ...overrides,
});
const respond = (res, data, headers = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
};

async function harness(t, handler, config = {}) {
  const requests = [];
  const server = createServer((req, res) => { requests.push(req.url); handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const dir = await mkdtemp(join(tmpdir(), 'release-radar-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ repositories: ['demo/one'], timeoutMs: 500, ...config }));
  // Only tests translate the canonical GitHub URL to a loopback server.
  const fetchImpl = (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.headers.Authorization, undefined);
    const { pathname, search } = new URL(url);
    return fetch(`http://127.0.0.1:${server.address().port}${pathname}${search}`, options);
  };
  async function run(extra = [], format = 'json') {
    let stdout = '', stderr = '';
    const code = await runCli(['--config', path, '--format', format, ...extra], {
      stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } },
      env: {}, fetchImpl, now: () => new Date('2026-09-30T00:00:00Z'),
    });
    return { code, report: format === 'json' ? JSON.parse(stdout) : undefined, stderr, stdout };
  }
  return { run, requests };
}

test('CLI over HTTP: reads config, merges pages and repositories, filters then limits, globally sorts UTC', async (t) => {
  const h = await harness(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.includes('/two/')) return respond(res, [release(4, 'demo/two')]);
    if (url.searchParams.get('page') === '1') return respond(res, [release(1), release(5, 'demo/one', { prerelease: true }), { draft: true }], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    respond(res, [release(3)]);
  }, { repositories: ['demo/one', 'demo/two'], limit: 1 });
  const { code, report, stderr } = await h.run();
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(report.complete, true);
  assert.deepEqual(report.releases.map((r) => r.id), [4, 3]);
  assert.equal(report.repositories[0].selectionLimited, true);
  assert.equal(report.repositories[0].pagesFetched, 2);
  assert.equal(h.requests.length, 3);
  const withPrereleases = await h.run(['--include-prereleases']);
  assert.deepEqual(withPrereleases.report.releases.map((r) => r.id), [5, 4]);
});

test('CLI over HTTP: 404 does not hide successful repository results or raw body', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.includes('/missing/')) { res.writeHead(404); res.end('private-remote-error'); }
    else respond(res, [release(1, 'demo/two')]);
  }, { repositories: ['demo/missing', 'demo/two'] });
  const { code, report, stderr, stdout } = await h.run();
  assert.equal(code, 1);
  assert.equal(report.complete, false);
  assert.equal(report.releases.length, 1);
  assert.equal(report.issues[0].code, 'not_found');
  assert.match(stderr, /not_found/);
  assert.ok(!(stderr + stdout).includes('private-remote-error'));
});

test('CLI over HTTP: later-page HTTP failure retains earlier releases', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.endsWith('page=1')) respond(res, [release(1)], { link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"' });
    else { res.writeHead(500); res.end('private-remote-error'); }
  });
  const { code, report } = await h.run();
  assert.equal(code, 1);
  assert.equal(report.releases.length, 1);
  assert.equal(report.repositories[0].pagesFetched, 1);
});

for (const status of [401, 403, 429]) {
  test(`CLI over HTTP: ${status} stops remaining requests and reports skipped repositories`, async (t) => {
    const h = await harness(t, (req, res) => { res.writeHead(status, { 'retry-after': '30' }); res.end('private error'); }, { repositories: ['demo/one', 'demo/two'] });
    const { code, report } = await h.run();
    assert.equal(code, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(report.issues[1].code, 'skipped');
    assert.equal(report.repositories[1].complete, false);
  });
}

test('CLI over HTTP: request deadline includes a stalled body', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('['); // Headers arrive; body intentionally never ends.
  }, { timeoutMs: 100 });
  const { code, report } = await h.run();
  assert.equal(code, 1);
  assert.equal(report.issues[0].code, 'timeout');
});

test('CLI over HTTP: truncated transfer is incomplete and sanitized', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2000' });
    res.write('[{"private":');
    res.socket.destroy();
  });
  const { code, report, stderr } = await h.run();
  assert.equal(code, 1);
  assert.equal(report.issues[0].code, 'network_error');
  assert.ok(!stderr.includes('private'));
});

test('CLI over HTTP: corrupt rows and duplicates keep good data but mark report incomplete', async (t) => {
  const h = await harness(t, (req, res) => respond(res, [release(1), release(1), { draft: false, tag_name: 'malformed' }]));
  const { code, report } = await h.run();
  assert.equal(code, 1);
  assert.equal(report.releases.length, 1);
  assert.deepEqual(report.issues.map((i) => i.code), ['invalid_record', 'duplicate_release']);
});

test('CLI over HTTP: redirects are not followed', async (t) => {
  const h = await harness(t, (req, res) => {
    res.writeHead(302, { location: '/another-path' }); res.end();
  });
  const { code, report } = await h.run();
  assert.equal(code, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(report.issues[0].code, 'redirect_refused');
});

test('since scans past old pages, compares instants inclusively, then sorts and limits', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.endsWith('page=1')) return respond(res, [release(1, 'demo/one', { published_at: '2026-09-29T10:00:00.122Z' })], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    respond(res, [
      release(2, 'demo/one', { published_at: '2026-09-29T13:00:00.123+03:00' }),
      release(3, 'demo/one', { published_at: '2026-09-29T05:00:00.124-05:00' }),
      release(4, 'demo/one', { published_at: '2026-09-29T10:00:00.125Z', prerelease: true }),
      release(5, 'demo/one', { published_at: '2026-09-29T10:00:00.126Z', draft: true }),
    ]);
  });
  const full = await h.run(['--since', '2026-09-29T10:00:00.123Z']);
  assert.equal(full.code, 0);
  assert.equal(full.report.complete, true);
  assert.deepEqual(full.report.releases.map(r => r.id), [3, 2]);
  assert.equal(full.report.repositories[0].pagesFetched, 2);
  assert.equal(full.report.repositories[0].scannedEntries, 5);
  assert.equal(full.report.repositories[0].matchingReleases, 2);
  assert.equal(full.report.scope.since, '2026-09-29T10:00:00.123Z');
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(url => !url.includes('since=')));
  const limited = await h.run(['--since', '2026-09-29T13:00:00.123+03:00', '--limit', '1', '--include-prereleases']);
  assert.equal(limited.code, 0);
  assert.deepEqual(limited.report.releases.map(r => r.id), [4]);
  assert.equal(limited.report.repositories[0].matchingReleases, 3);
  assert.equal(limited.report.repositories[0].selectionLimited, true);
  assert.equal(h.requests.length, 4);
});

test('since filtering everything preserves page-budget incompleteness and table/JSON diagnostics', async (t) => {
  const h = await harness(t, (req, res) => respond(res, [release(1)], {
    link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
  }), { maxPages: 1 });
  const result = await h.run(['--since', '2026-10-01T00:00:00Z']);
  assert.equal(result.code, 1);
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.releases, []);
  assert.equal(result.report.issues[0].code, 'page_limit');
  assert.equal(result.report.repositories[0].matchingReleases, 0);
  assert.equal(result.report.repositories[0].selectionLimited, false);
  const table = await h.run(['--since', '2026-10-01T03:00:00+03:00'], 'table');
  assert.equal(table.code, 1);
  assert.match(table.stdout, /INCOMPLETE scan/);
  assert.match(table.stdout, /published_at >= 2026-10-01T00:00:00\.000Z/);
  assert.match(table.stderr, /page_limit/);
});

test('since preserves later-page HTTP errors for both empty and matching partial results', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.endsWith('page=1')) return respond(res, [release(1), release(29)], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    res.writeHead(500); res.end('private-remote-error');
  });
  const result = await h.run(['--since', '2026-10-01T00:00:00Z']);
  assert.equal(result.code, 1);
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.releases, []);
  assert.equal(result.report.issues[0].code, 'http_error');
  assert.equal(result.report.repositories[0].pagesFetched, 1);
  assert.equal(h.requests.length, 2);
  assert.ok(!(result.stdout + result.stderr).includes('private-remote-error'));
  const matching = await h.run(['--since', '2026-09-29T15:00:00+03:00']);
  assert.equal(matching.code, 1);
  assert.equal(matching.report.complete, false);
  assert.deepEqual(matching.report.releases.map(release => release.id), [29]);
  assert.equal(matching.report.issues[0].code, 'http_error');
  assert.equal(h.requests.length, 4);
});

test('since cannot hide malformed records or duplicate IDs outside the matching date window', async (t) => {
  const h = await harness(t, (req, res) => respond(res, [release(1), release(1), release(2, 'demo/one', { published_at: '2026-02-30T00:00:00Z' })]));
  const result = await h.run(['--since', '2026-10-01T00:00:00Z']);
  assert.equal(result.code, 1);
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.releases, []);
  assert.deepEqual(result.report.issues.map(issue => issue.code), ['invalid_record', 'duplicate_release']);
});

test('since and an empty valid API response remain a complete empty result', async (t) => {
  const h = await harness(t, (req, res) => respond(res, []));
  const result = await h.run(['--since', '2026-10-01T00:00:00Z']);
  assert.equal(result.code, 0);
  assert.equal(result.report.complete, true);
  assert.deepEqual(result.report.releases, []);
  assert.deepEqual(result.report.issues, []);
});

test('closed windows scan past newer pages and apply bounds before prerelease selection and limits', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.endsWith('page=1')) return respond(res, [release(1, 'demo/one', { published_at: '2026-09-29T10:00:00.126Z' })], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    respond(res, [
      release(2, 'demo/one', { published_at: '2026-09-29T10:00:00.122Z' }),
      release(3, 'demo/one', { published_at: '2026-09-29T13:00:00.123+03:00' }),
      release(4, 'demo/one', { published_at: '2026-09-29T05:00:00.124-05:00' }),
      release(5, 'demo/one', { published_at: '2026-09-29T10:00:00.125Z', prerelease: true }),
      release(6, 'demo/one', { published_at: '2026-09-29T10:00:00.125Z', draft: true }),
    ]);
  });
  const bounds = ['--since', '2026-09-29T10:00:00.123Z', '--until', '2026-09-29T13:00:00.125+03:00'];
  const stable = await h.run(bounds);
  assert.equal(stable.code, 0); assert.equal(stable.stderr, '');
  assert.deepEqual(stable.report.releases.map(r => r.id), [4, 3]);
  assert.equal(stable.report.scope.until, '2026-09-29T10:00:00.125Z');
  assert.deepEqual(stable.report.repositories[0], {
    repository: 'demo/one', complete: true, pagesFetched: 2, scannedEntries: 6,
    matchingReleases: 2, returnedReleases: 2, selectionLimited: false,
  });
  const limited = await h.run([...bounds, '--include-prereleases', '--limit', '2']);
  assert.equal(limited.code, 0);
  assert.deepEqual(limited.report.releases.map(r => r.id), [5, 4]);
  assert.equal(limited.report.repositories[0].matchingReleases, 3);
  assert.equal(limited.report.repositories[0].selectionLimited, true);
  assert.equal(h.requests.length, 4);
  assert.ok(h.requests.every(url => !/since|until/.test(url)));
});

test('upper bounds preserve empty incomplete page-budget reports in table and JSON', async (t) => {
  const h = await harness(t, (req, res) => respond(res, [release(29)], {
    link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
  }), { maxPages: 1 });
  const bounds = ['--until', '2026-09-01T00:00:00Z'];
  const result = await h.run(bounds);
  assert.equal(result.code, 1);
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.releases, []);
  assert.equal(result.report.issues[0].code, 'page_limit');
  assert.equal(result.report.repositories[0].matchingReleases, 0);
  assert.equal(result.report.repositories[0].selectionLimited, false);
  const table = await h.run(bounds, 'table');
  assert.equal(table.code, 1);
  assert.match(table.stdout, /INCOMPLETE scan/);
  assert.match(table.stdout, /published_at <= 2026-09-01T00:00:00\.000Z \(inclusive\)/);
  assert.match(table.stderr, /page_limit/);
});

test('intervals retain HTTP failures with both empty and matching partial results', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.endsWith('page=1')) return respond(res, [release(1), release(29)], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    res.writeHead(500); res.end('private-remote-error');
  });
  for (const [since, until, expected] of [
    ['2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z', []],
    ['2026-09-01T12:00:00Z', '2026-09-01T15:00:00+03:00', [1]],
  ]) {
    const result = await h.run(['--since', since, '--until', until]);
    assert.equal(result.code, 1);
    assert.equal(result.report.complete, false);
    assert.deepEqual(result.report.releases.map(r => r.id), expected);
    assert.equal(result.report.issues[0].code, 'http_error');
    assert.equal(result.report.repositories[0].pagesFetched, 1);
    assert.ok(!(result.stdout + result.stderr).includes('private-remote-error'));
  }
  assert.equal(h.requests.length, 4);
});

test('an interval cannot hide invalid records or duplicates newer than its upper bound', async (t) => {
  const h = await harness(t, (req, res) => respond(res, [release(29), release(29), release(28, 'demo/one', { body: 7 })]));
  const result = await h.run(['--since', '2026-09-01T00:00:00Z', '--until', '2026-09-02T00:00:00Z']);
  assert.equal(result.code, 1);
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.releases, []);
  assert.deepEqual(result.report.issues.map(issue => issue.code), ['invalid_record', 'duplicate_release']);
});

test('empty API responses and valid windows with no matches are complete in table and JSON', async (t) => {
  for (const items of [[], [release(29)]]) {
    const h = await harness(t, (req, res) => respond(res, items));
    const bounds = ['--since', '2026-09-01T00:00:00Z', '--until', '2026-09-02T00:00:00Z'];
    const result = await h.run(bounds);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.equal(result.report.complete, true);
    assert.deepEqual(result.report.releases, []);
    assert.deepEqual(result.report.issues, []);
    const table = await h.run(bounds, 'table');
    assert.equal(table.code, 0); assert.equal(table.stderr, '');
    assert.match(table.stdout, /complete scan/);
    assert.match(table.stdout, /No matching releases/);
  }
});

test('demo reads neither token nor network, includes synthetic provenance and source links', async () => {
  let stdout = '', stderr = '';
  const code = await runCli(['--demo', '--format', 'json', '--include-prereleases'], {
    env: new Proxy({}, { get() { throw new Error('Environment must not be accessed'); } }),
    fetchImpl: () => { throw new Error('Network must not be accessed'); },
    stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } },
  });
  const report = JSON.parse(stdout);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(report.mode, 'demo');
  assert.equal(report.releases.length, 4);
  assert.ok(report.releases.every((r) => r.url.startsWith('https://github.com/radar-demo/')));
  assert.match(report.digestNotice, /not a verified/);
});

test('config errors return code 2 and a JSON issue without leaking paths or content', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'release-radar-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'secret-file.json');
  for (const content of [null, 'private malformed JSON', '{"repositories":["demo/one"],"token":"private-secret"}']) {
    if (content !== null) await writeFile(path, content);
    let stdout = '', stderr = '';
    const code = await runCli(['--config', path, '--format', 'json'], {
      env: {}, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } },
    });
    assert.equal(code, 2);
    assert.equal(JSON.parse(stdout).complete, false);
    assert.ok(!(stdout + stderr).includes('private'));
    assert.ok(!(stdout + stderr).includes('secret-file'));
  }
});

test('CLI redacts echoed token in windowed remote results and never logs auth headers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'release-radar-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, '{"repositories":["demo/one"]}');
  let stdout = '', stderr = '';
  const code = await runCli(['--config', path, '--format', 'json', '--since', '2026-09-01T12:00:00Z', '--until', '2026-09-01T15:00:00+03:00'], {
    env: { GITHUB_TOKEN: 'test-sentinel' },
    stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } },
    fetchImpl: async (_, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-sentinel');
      return new Response(JSON.stringify([release(1, 'demo/one', { body: 'Echo test-sentinel', name: 'test-sentinel' })]), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(code, 0);
  assert.ok(!(stdout + stderr).includes('test-sentinel'));
  assert.equal(JSON.parse(stdout).releases[0].name, '[REDACTED]');
});

test('real executable provides help, version, table demo, JSON demo and usage exit code', () => {
  const bin = new URL('../bin/crypto-release-radar.js', import.meta.url);
  for (const [args, expectedCode, expected] of [
    [['--help'], 0, /Usage:/], [['--version'], 0, /0\.1\.0/],
    [['--demo'], 0, /SYNTHETIC DEMO/], [['--demo', '--format', 'json'], 0, /"mode": "demo"/],
    [['--unknown'], 2, /Unknown option/],
  ]) {
    const result = spawnSync(process.execPath, [bin.pathname, ...args], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
    assert.equal(result.status, expectedCode);
    assert.match(result.stdout + result.stderr, expected);
  }
});

test('table exposes page-budget incompleteness and safe diagnostics', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'release-radar-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, '{"repositories":["demo/one"],"maxPages":1}');
  let stdout = '', stderr = '';
  const code = await runCli(['--config', path], {
    env: {}, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } },
    fetchImpl: async () => new Response(JSON.stringify([release(1)]), { headers: {
      'content-type': 'application/json', link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    } }),
  });
  assert.equal(code, 1);
  assert.match(stdout, /INCOMPLETE scan/);
  assert.match(stdout, /Newer|Newest releases outside/);
  assert.match(stdout, /https:\/\/github.com\/demo\/one\/releases\/tag\/v1/);
  assert.match(stderr, /page_limit/);
});
