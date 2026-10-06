import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { csvObjects } from '../test-support/read-csv.js';

const displayCounts = report => report.repositories.map(r => [
  r.matchingReleases, r.selectedReleases, r.returnedReleases, r.selectionLimited, r.globalSelectionLimited,
]);
const scanState = report => report.repositories.map(r => ({
  repository: r.repository, policy: r.policy, requested: r.requested,
  complete: r.complete, pagesFetched: r.pagesFetched, scannedEntries: r.scannedEntries,
}));
const markdownIds = text => [...text.matchAll(/^- Release ID: (\d+)\.$/gm)].map(match => Number(match[1]));

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
    repository: 'demo/one', complete: true, requested: true, pagesFetched: 2, scannedEntries: 6,
    policy: { limit: 5, includePrereleases: false },
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

test('tag patterns scan past nonmatching pages and combine OR with dates, prereleases and limits', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.endsWith('page=1')) return respond(res, [release(1, 'demo/one', { tag_name: 'other' })], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    respond(res, [release(2), release(3, 'demo/one', { prerelease: true }), release(4), release(5, 'demo/one', { draft: true })]);
  });
  const args = ['--tag-pattern', 'v2', '--tag-pattern', 'v?', '--since', '2026-09-02T12:00:00Z', '--until', '2026-09-03T12:00:00Z', '--limit', '1'];
  const stable = await h.run(args);
  assert.equal(stable.code, 0); assert.equal(stable.report.complete, true);
  assert.deepEqual(stable.report.releases.map(r => r.id), [2]);
  assert.equal(stable.report.repositories[0].pagesFetched, 2);
  assert.equal(stable.report.repositories[0].scannedEntries, 5);
  assert.equal(stable.report.repositories[0].matchingReleases, 1);
  const preview = await h.run([...args, '--include-prereleases']);
  assert.equal(preview.code, 0);
  assert.deepEqual(preview.report.releases.map(r => r.id), [3]);
  assert.equal(preview.report.repositories[0].matchingReleases, 2);
  assert.equal(preview.report.repositories[0].selectionLimited, true);
  assert.equal(h.requests.length, 4);
  assert.ok(h.requests.every(url => !/pattern|since|until/.test(url)));
});

test('tag selection cannot hide duplicate IDs or malformed records outside selected tags', async (t) => {
  const h = await harness(t, (req, res) => respond(res, [
    release(1, 'demo/one', { tag_name: 'excluded' }), release(1, 'demo/one', { tag_name: 'selected' }),
    release(2, 'demo/one', { tag_name: 'excluded', body: 7 }),
  ]));
  const result = await h.run(['--tag-pattern', 'selected']);
  assert.equal(result.code, 1); assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.releases, []);
  assert.deepEqual(result.report.issues.map(i => i.code), ['invalid_record', 'duplicate_release']);
});

test('nonmatching tag filters preserve page-budget and later HTTP failures in table and JSON', async (t) => {
  for (const maxPages of [1, 2]) {
    const h = await harness(t, (req, res) => {
      if (req.url.endsWith('page=1')) return respond(res, [release(1)], {
        link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
      });
      res.writeHead(500); res.end('private-remote-body');
    }, { maxPages });
    for (const format of ['json', 'table']) {
      const result = await h.run(['--tag-pattern', 'unmatched*'], format);
      assert.equal(result.code, 1);
      assert.match(result.stderr, maxPages === 1 ? /page_limit/ : /http_error/);
      assert.ok(!(result.stdout + result.stderr).includes('private-remote-body'));
      if (format === 'json') {
        assert.equal(result.report.complete, false); assert.deepEqual(result.report.releases, []);
        assert.equal(result.report.repositories[0].matchingReleases, 0);
        assert.equal(result.report.repositories[0].selectionLimited, false);
      } else {
        assert.match(result.stdout, /INCOMPLETE scan/); assert.match(result.stdout, /Tag filter.*unmatched/);
      }
    }
    assert.equal(h.requests.length, maxPages * 2);
  }
});

test('empty tag matches and empty API responses are complete without changing exit codes', async (t) => {
  for (const items of [[], [release(1)]]) {
    const h = await harness(t, (req, res) => respond(res, items));
    for (const format of ['json', 'table']) {
      const result = await h.run(['--tag-pattern', 'unmatched*'], format);
      assert.equal(result.code, 0); assert.equal(result.stderr, '');
      if (format === 'json') {
        assert.equal(result.report.complete, true); assert.deepEqual(result.report.releases, []);
        assert.deepEqual(result.report.issues, []);
      } else assert.match(result.stdout, /No matching releases/);
    }
  }
});

test('repository policies govern paginated selection independently without changing request budgets', async (t) => {
  const h = await harness(t, (req, res) => {
    const repo = req.url.includes('/two/') ? 'demo/two' : 'demo/one';
    if (req.url.endsWith('page=1')) return respond(res, [release(20, repo, { prerelease: true })], {
      link: `<https://api.github.com/repos/${repo}/releases?per_page=100&page=2>; rel="next"`,
    });
    respond(res, [release(3, repo), release(1, repo)]);
  }, {
    repositories: [{ slug: 'demo/one', limit: 1, includePrereleases: false }, { slug: 'demo/two', limit: 2 }],
    limit: 5, includePrereleases: true,
  });
  const result = await h.run(['--tag-pattern', 'v*', '--since', '2026-09-01T12:00:00Z', '--until', '2026-09-20T15:00:00+03:00']);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(result.report.releases.map(r => [r.repository, r.id]), [['demo/two', 20], ['demo/one', 3], ['demo/two', 3]]);
  assert.deepEqual(result.report.repositories.map(r => r.policy), [{ limit: 1, includePrereleases: false }, { limit: 2, includePrereleases: true }]);
  assert.deepEqual(result.report.repositories.map(r => [r.pagesFetched, r.scannedEntries, r.matchingReleases, r.selectionLimited]), [[2, 3, 2, true], [2, 3, 3, true]]);
  assert.equal(h.requests.length, 4);
  assert.ok(h.requests.every(url => /^\/repos\/demo\/(one|two)\/releases\?per_page=100&page=[12]$/.test(url)));
});

test('mixed policy reports retain partial HTTP errors and empty complete repositories', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.includes('/two/')) return respond(res, []);
    if (req.url.endsWith('page=1')) return respond(res, [release(1), release(2, 'demo/one', { prerelease: true })], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    res.writeHead(500); res.end('private-remote-body');
  }, { repositories: [{ slug: 'demo/one', includePrereleases: false }, 'demo/two'], limit: 2, includePrereleases: true });
  for (const [extra, expected] of [[[], [1]], [['--tag-pattern', 'nothing'], []]]) {
    const result = await h.run(extra);
    assert.equal(result.code, 1); assert.equal(result.report.complete, false);
    assert.deepEqual(result.report.releases.map(r => r.id), expected);
    assert.equal(result.report.issues[0].code, 'http_error');
    assert.equal(result.report.repositories[0].complete, false);
    assert.equal(result.report.repositories[1].complete, true);
    assert.deepEqual(result.report.repositories.map(r => r.policy), [{ limit: 2, includePrereleases: false }, { limit: 2, includePrereleases: true }]);
    assert.equal(result.report.scope.limitPerRepository, 2);
    assert.equal(result.report.scope.includePrereleases, null);
    assert.ok(!(result.stdout + result.stderr).includes('private-remote-body'));
  }
  assert.equal(h.requests.length, 6);
});

test('skipped repositories keep their own effective policy in JSON and table', async (t) => {
  const h = await harness(t, (req, res) => { res.writeHead(401); res.end('private-remote-body'); }, {
    repositories: [{ slug: 'demo/one', limit: 1 }, { slug: 'demo/two', limit: 3, includePrereleases: true }],
  });
  const result = await h.run();
  assert.equal(result.code, 1); assert.deepEqual(result.report.releases, []);
  assert.deepEqual(result.report.issues.map(i => i.code), ['unauthorized', 'skipped']);
  assert.deepEqual(result.report.repositories.map(r => r.policy), [{ limit: 1, includePrereleases: false }, { limit: 3, includePrereleases: true }]);
  assert.equal(result.report.repositories[1].pagesFetched, 0);
  assert.equal(result.report.scope.limitPerRepository, null); assert.equal(result.report.scope.includePrereleases, null);
  const table = await h.run([], 'table');
  assert.equal(table.code, 1); assert.match(table.stderr, /skipped/);
  assert.match(table.stdout, /demo\/two: INCOMPLETE;.*policy: limit 3, prereleases included/);
  assert.equal(h.requests.length, 2);
});

test('per-repository prerelease exclusion does not mask malformed or duplicate excluded rows', async (t) => {
  const h = await harness(t, (req, res) => respond(res, [
    release(1, 'demo/one', { prerelease: true }), release(1, 'demo/one', { prerelease: true }),
    release(2, 'demo/one', { prerelease: true, body: 7 }),
  ]), { repositories: [{ slug: 'demo/one', includePrereleases: false }], includePrereleases: true });
  const result = await h.run();
  assert.equal(result.code, 1); assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.releases, []);
  assert.deepEqual(result.report.issues.map(i => i.code), ['invalid_record', 'duplicate_release']);
  assert.equal(result.report.repositories[0].policy.includePrereleases, false);
  assert.equal(result.report.scope.includePrereleases, false);
});

test('selected groups define request order and completeness, excluding default and unused repositories', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.includes('/one/')) return respond(res, [release(1)]);
    if (req.url.includes('/two/')) return respond(res, [release(2, 'demo/two', { prerelease: true })]);
    res.writeHead(404); res.end('unselected-private-error');
  }, {
    repositories: ['demo/default'],
    groups: { first: [{ slug: 'demo/one', limit: 1 }], second: [{ slug: 'demo/two', includePrereleases: true }], unused: ['demo/missing'] },
  });
  const result = await h.run(['--group', 'second', '--group', 'first', '--tag-pattern', 'v?', '--since', '2026-09-01T12:00:00Z', '--until', '2026-09-02T12:00:00Z']);
  assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.equal(result.report.complete, true);
  assert.deepEqual(result.report.scope.groups, ['second', 'first']);
  assert.deepEqual(result.report.repositories.map(r => r.repository), ['demo/two', 'demo/one']);
  assert.ok(result.report.repositories.every(r => r.requested));
  assert.deepEqual(result.report.releases.map(r => r.id), [2, 1]);
  assert.deepEqual(h.requests, ['/repos/demo/two/releases?per_page=100&page=1', '/repos/demo/one/releases?per_page=100&page=1']);
});

test('group scans retain partial errors, continue pagination and keep selected policies', async (t) => {
  const h = await harness(t, (req, res) => {
    if (req.url.includes('/two/')) return respond(res, []);
    if (req.url.endsWith('page=1')) return respond(res, [release(1)], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    res.writeHead(500); res.end('private-remote-error');
  }, { groups: { selected: [{ slug: 'demo/one', limit: 1 }, 'demo/two'] } });
  for (const [extra, expected] of [[[], [1]], [['--tag-pattern', 'unmatched'], []]]) {
    const result = await h.run(['--group', 'selected', ...extra]);
    assert.equal(result.code, 1); assert.equal(result.report.complete, false);
    assert.deepEqual(result.report.releases.map(r => r.id), expected);
    assert.deepEqual(result.report.repositories.map(r => [r.requested, r.complete]), [[true, false], [true, true]]);
    assert.equal(result.report.repositories[0].policy.limit, 1);
    assert.equal(result.report.issues[0].code, 'http_error');
    assert.ok(!(result.stdout + result.stderr).includes('private-remote-error'));
  }
  assert.equal(h.requests.length, 6);
});

test('selected group members skipped after authentication failure remain visible but not requested', async (t) => {
  const h = await harness(t, (req, res) => { res.writeHead(401); res.end('private error'); }, {
    groups: { selected: ['demo/one', { slug: 'demo/two', includePrereleases: true }] },
  });
  const result = await h.run(['--group', 'selected']);
  assert.equal(result.code, 1); assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.scope.groups, ['selected']);
  assert.deepEqual(result.report.repositories.map(r => r.requested), [true, false]);
  assert.deepEqual(result.report.issues.map(i => i.code), ['unauthorized', 'skipped']);
  const table = await h.run(['--group', 'selected'], 'table');
  assert.equal(table.code, 1); assert.match(table.stdout, /Repository selection: groups \["selected"\]/);
  assert.match(table.stdout, /demo\/two: INCOMPLETE;.*API requested: no/);
  assert.equal(h.requests.length, 2);
});

test('empty selected group results are complete in both table and JSON', async (t) => {
  const h = await harness(t, (req, res) => respond(res, []), { groups: { selected: ['demo/two'] } });
  const result = await h.run(['--group', 'selected']);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.equal(result.report.complete, true); assert.deepEqual(result.report.releases, []);
  assert.equal(result.report.repositories[0].repository, 'demo/two');
  assert.equal(result.report.repositories[0].requested, true);
  const table = await h.run(['--group', 'selected'], 'table');
  assert.equal(table.code, 0); assert.match(table.stdout, /No matching releases/);
  assert.match(table.stdout, /Repository selection: groups \["selected"\]/);
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

test('total limit follows full pagination, group policies and date/tag/prerelease filters', async t => {
  const h = await harness(t, (req, res) => {
    if (req.url.includes('/a/')) return respond(res, [
      release(7, 'demo/a', { published_at: '2026-09-03T12:00:00Z' }),
      release(8, 'demo/a', { published_at: '2026-09-04T15:00:00+03:00' }),
      release(9, 'demo/a', { published_at: '2026-09-04T12:00:00Z', prerelease: true }),
    ]);
    if (req.url.endsWith('page=1')) return respond(res, [
      release(1, 'demo/z', { published_at: '2026-09-02T12:00:00Z' }),
      release(2, 'demo/z', { published_at: '2026-09-03T12:00:00Z', prerelease: true }),
      release(10, 'demo/z', { published_at: '2026-09-01T12:00:00Z' }),
    ], { link: '<https://api.github.com/repos/demo/z/releases?per_page=100&page=2>; rel="next"' });
    respond(res, [
      release(3, 'demo/z', { published_at: '2026-09-04T12:00:00Z' }),
      release(4, 'demo/z', { published_at: '2026-09-04T12:00:00Z', tag_name: 'excluded' }),
      release(5, 'demo/z'), release(6, 'demo/z', { draft: true }),
    ]);
  }, {
    repositories: ['demo/unused'],
    groups: { preview: [{ slug: 'demo/z', limit: 2, includePrereleases: true }], stable: [{ slug: 'demo/a', limit: 1 }] },
  });
  const args = ['--group', 'preview', '--group', 'stable', '--tag-pattern', 'v*',
    '--since', '2026-09-02T12:00:00Z', '--until', '2026-09-04T12:00:00Z'];
  const requests = ['/repos/demo/z/releases?per_page=100&page=1', '/repos/demo/z/releases?per_page=100&page=2', '/repos/demo/a/releases?per_page=100&page=1'];
  const baseline = await h.run(args);
  assert.equal(baseline.code, 0); assert.equal(baseline.stderr, '');
  assert.deepEqual(baseline.report.releases.map(r => [r.repository, r.id]), [['demo/a', 8], ['demo/z', 3], ['demo/z', 2]]);
  assert.deepEqual(h.requests.splice(0), requests);
  const limited = await h.run([...args, '--total-limit', '2']);
  assert.equal(limited.code, 0); assert.equal(limited.report.complete, true);
  assert.deepEqual(h.requests.splice(0), requests);
  assert.deepEqual(scanState(limited.report), scanState(baseline.report));
  assert.deepEqual(limited.report.issues, baseline.report.issues);
  assert.deepEqual(limited.report.releases.map(r => [r.repository, r.id]), [['demo/a', 8], ['demo/z', 3]]);
  assert.deepEqual(displayCounts(limited.report), [[3, 2, 1, true, true], [2, 1, 1, true, false]]);
  assert.deepEqual(limited.report.display, { matchingReleases: 5, selectedReleases: 3, returnedReleases: 2, perRepositoryHiddenReleases: 2, globallyHiddenReleases: 1, globalSelectionLimited: true });
  const table = await h.run([...args, '--total-limit', '2'], 'table');
  assert.equal(table.code, 0); assert.equal(table.stderr, '');
  assert.deepEqual(h.requests.splice(0), requests);
  assert.match(table.stdout, /5 matching; 3 after per-repository limits; 2 shown; 2 hidden by per-repository limits; 1 hidden by total limit/);
  assert.match(table.stdout, /demo\/z: complete; 7 entries scanned; 3 matching; 2 after per-repository limit \(truncated\); 1 shown \(total limit\)/);
  const override = await h.run([...args, '--limit', '1', '--include-prereleases', '--total-limit', '1']);
  assert.equal(override.code, 0);
  assert.deepEqual(h.requests.splice(0), requests);
  assert.deepEqual(override.report.releases.map(r => [r.repository, r.id]), [['demo/a', 9]]);
  assert.deepEqual(displayCounts(override.report), [[3, 1, 0, true, true], [3, 1, 1, true, false]]);
});

test('total limit preserves later-page failure, malformed rows, duplicates and independent failed/empty repositories', async t => {
  const h = await harness(t, (req, res) => {
    if (req.url.includes('/missing/')) { res.writeHead(404); return res.end('private-remote-error'); }
    if (req.url.includes('/empty/')) return respond(res, []);
    if (req.url.includes('/two/')) return respond(res, [release(5, 'demo/two')]);
    if (req.url.endsWith('page=1')) return respond(res, [release(3), release(2), release(1), release(1), release(4, 'demo/one', { tag_name: 'excluded', body: 7 })], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    res.writeHead(500); res.end('private-remote-error');
  }, { repositories: ['demo/one', 'demo/missing', 'demo/empty', 'demo/two'], limit: 2 });
  const requests = ['/repos/demo/one/releases?per_page=100&page=1', '/repos/demo/one/releases?per_page=100&page=2',
    '/repos/demo/missing/releases?per_page=100&page=1', '/repos/demo/empty/releases?per_page=100&page=1', '/repos/demo/two/releases?per_page=100&page=1'];
  const baseline = await h.run(['--tag-pattern', 'v*']);
  assert.equal(baseline.code, 1);
  assert.deepEqual(baseline.report.issues.map(i => i.code), ['http_error', 'invalid_record', 'duplicate_release', 'not_found']);
  assert.deepEqual(h.requests.splice(0), requests);
  for (const empty of [false, true]) {
    const args = ['--tag-pattern', 'v*', '--total-limit', '1', ...(empty ? ['--since', '2026-10-01T00:00:00Z'] : [])];
    const result = await h.run(args);
    assert.equal(result.code, 1); assert.equal(result.report.complete, false);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.deepEqual(scanState(result.report), scanState(baseline.report));
    assert.deepEqual(result.report.issues, baseline.report.issues);
    assert.equal(result.stderr, baseline.stderr);
    assert.deepEqual(result.report.releases.map(r => r.id), empty ? [] : [5]);
    assert.deepEqual(displayCounts(result.report), empty
      ? Array.from({ length: 4 }, () => [0, 0, 0, false, false])
      : [[3, 2, 0, true, true], [0, 0, 0, false, false], [0, 0, 0, false, false], [1, 1, 1, false, false]]);
    assert.deepEqual(result.report.display, empty
      ? { matchingReleases: 0, selectedReleases: 0, returnedReleases: 0, perRepositoryHiddenReleases: 0, globallyHiddenReleases: 0, globalSelectionLimited: false }
      : { matchingReleases: 4, selectedReleases: 3, returnedReleases: 1, perRepositoryHiddenReleases: 1, globallyHiddenReleases: 2, globalSelectionLimited: true });
    const table = await h.run(args, 'table');
    assert.equal(table.code, 1); assert.equal(table.stderr, baseline.stderr);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.match(table.stdout, /INCOMPLETE scan/);
    assert.match(table.stdout, /demo\/missing: INCOMPLETE/);
    assert.ok(!(table.stdout + table.stderr + result.stdout).includes('private-remote-error'));
  }
});

for (const [status, issue] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited']]) {
  test(`total limit preserves ${status} and skipped status after collecting enough releases`, async t => {
    const h = await harness(t, (req, res) => {
      if (req.url.includes('/one/')) return respond(res, [release(1), release(2)]);
      res.writeHead(status); res.end('private-remote-error');
    }, { repositories: ['demo/one', 'demo/denied', 'demo/skipped'] });
    const requests = ['/repos/demo/one/releases?per_page=100&page=1', '/repos/demo/denied/releases?per_page=100&page=1'];
    const baseline = await h.run();
    assert.equal(baseline.code, 1);
    assert.deepEqual(h.requests.splice(0), requests);
    const result = await h.run(['--total-limit', '1']);
    assert.equal(result.code, 1); assert.equal(result.report.complete, false);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.deepEqual(result.report.issues, baseline.report.issues);
    assert.deepEqual(result.report.issues.map(i => i.code), [issue, 'skipped']);
    assert.deepEqual(scanState(result.report), scanState(baseline.report));
    assert.deepEqual(result.report.repositories.map(r => r.requested), [true, true, false]);
    assert.deepEqual(result.report.releases.map(r => r.id), [2]);
    assert.deepEqual(displayCounts(result.report), [[2, 2, 1, false, true], [0, 0, 0, false, false], [0, 0, 0, false, false]]);
    const table = await h.run(['--total-limit', '1'], 'table');
    assert.equal(table.code, 1); assert.equal(table.stderr, baseline.stderr);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.match(table.stdout, /demo\/skipped: INCOMPLETE; 0 entries scanned; 0 matching; 0 after per-repository limit; 0 shown; policy: limit 5, prereleases excluded; API requested: no/);
    assert.ok(!(result.stdout + result.stderr + table.stdout).includes('private-remote-error'));
  });
}

test('total limit keeps page-budget incompleteness with enough matches or no matches', async t => {
  const h = await harness(t, (req, res) => respond(res, [release(1), release(2)], {
    link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
  }), { maxPages: 1 });
  const baseline = await h.run();
  assert.equal(baseline.code, 1);
  assert.deepEqual(h.requests.splice(0), ['/repos/demo/one/releases?per_page=100&page=1']);
  for (const empty of [false, true]) {
    const args = ['--total-limit', '1', ...(empty ? ['--tag-pattern', 'absent'] : [])];
    const result = await h.run(args);
    assert.equal(result.code, 1); assert.equal(result.report.complete, false);
    assert.deepEqual(result.report.issues, baseline.report.issues);
    assert.equal(result.report.issues[0].code, 'page_limit');
    assert.deepEqual(result.report.releases.map(r => r.id), empty ? [] : [2]);
    assert.deepEqual(displayCounts(result.report), [empty ? [0, 0, 0, false, false] : [2, 2, 1, false, true]]);
    assert.deepEqual(h.requests.splice(0), ['/repos/demo/one/releases?per_page=100&page=1']);
    const table = await h.run(args, 'table');
    assert.equal(table.code, 1); assert.equal(table.stderr, baseline.stderr);
    assert.match(table.stdout, /INCOMPLETE scan/);
    assert.deepEqual(h.requests.splice(0), ['/repos/demo/one/releases?per_page=100&page=1']);
  }
});

test('total limit preserves complete empty and wholly failed scans in table and JSON', async t => {
  for (const kind of ['empty-api', 'empty-filter', 'failed']) {
    const h = await harness(t, (req, res) => {
      if (kind === 'failed') { res.writeHead(500); return res.end('private-remote-error'); }
      respond(res, kind === 'empty-api' ? [] : [release(1)]);
    });
    const args = ['--tag-pattern', 'absent'];
    const baseline = await h.run(args);
    const requests = ['/repos/demo/one/releases?per_page=100&page=1'];
    assert.deepEqual(h.requests.splice(0), requests);
    const result = await h.run([...args, '--total-limit', '1']);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.equal(result.code, kind === 'failed' ? 1 : 0);
    assert.equal(result.report.complete, kind !== 'failed');
    assert.deepEqual(result.report.issues, baseline.report.issues);
    assert.deepEqual(result.report.releases, []);
    assert.deepEqual(displayCounts(result.report), [[0, 0, 0, false, false]]);
    assert.deepEqual(result.report.display, { matchingReleases: 0, selectedReleases: 0, returnedReleases: 0, perRepositoryHiddenReleases: 0, globallyHiddenReleases: 0, globalSelectionLimited: false });
    const table = await h.run([...args, '--total-limit', '1'], 'table');
    assert.equal(table.code, result.code); assert.equal(table.stderr, baseline.stderr);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.match(table.stdout, /No matching releases/);
    assert.match(table.stdout, kind === 'failed' ? /INCOMPLETE scan/ : /complete scan/);
  }
});

test('Markdown, CSV and JSON preserve paginated group selection, mixed policies, filters and global limits', async t => {
  const h = await harness(t, (req, res) => {
    if (req.url.includes('/a/')) return respond(res, [
      release(4, 'demo/a'), release(5, 'demo/a', { published_at: '2026-09-04T12:00:00Z', prerelease: true }),
    ]);
    if (req.url.endsWith('page=1')) return respond(res, [release(1, 'demo/z'), release(2, 'demo/z', { prerelease: true })], {
      link: '<https://api.github.com/repos/demo/z/releases?per_page=100&page=2>; rel="next"',
    });
    respond(res, [release(3, 'demo/z'), release(6, 'demo/z', { tag_name: 'excluded' })]);
  }, {
    repositories: ['demo/unused'], groups: { preview: [{ slug: 'demo/z', limit: 2, includePrereleases: true }], stable: [{ slug: 'demo/a', limit: 1 }] },
  });
  const args = ['--group', 'preview', '--group', 'stable', '--since', '2026-09-02T12:00:00Z', '--until', '2026-09-04T15:00:00+03:00', '--tag-pattern', 'v*'];
  const requests = ['/repos/demo/z/releases?per_page=100&page=1', '/repos/demo/z/releases?per_page=100&page=2', '/repos/demo/a/releases?per_page=100&page=1'];
  for (const [extra, expectedIds, matching, selected] of [
    [['--total-limit', '2'], [4, 3], 3, 3],
    [['--limit', '1', '--include-prereleases', '--total-limit', '1'], [5], 4, 2],
  ]) {
    const json = await h.run([...args, ...extra]);
    assert.equal(json.code, 0); assert.equal(json.report.complete, true);
    assert.deepEqual(json.report.releases.map(r => r.id), expectedIds);
    assert.deepEqual(h.requests.splice(0), requests);
    const markdown = await h.run([...args, ...extra], 'markdown');
    assert.equal(markdown.code, json.code); assert.equal(markdown.stderr, json.stderr);
    assert.deepEqual(markdownIds(markdown.stdout), expectedIds);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.ok(markdown.stdout.includes('**Result: COMPLETE scan | ' + expectedIds.length + ' shown releases**'));
    assert.ok(markdown.stdout.includes(`Matching: ${matching}; after per-repository limits: ${selected}; shown: ${expectedIds.length}.`));
    assert.ok(markdown.stdout.includes(String.raw`groups \[\"preview\"\,\"stable\"\]`));
    assert.ok(markdown.stdout.includes(String.raw`Published from (inclusive): 2026\-09\-02T12&#58;00&#58;00&#46;000Z`));
    assert.ok(markdown.stdout.includes(String.raw`Published through (inclusive): 2026\-09\-04T12&#58;00&#58;00&#46;000Z`));
    assert.ok(markdown.stdout.includes(String.raw`Tag patterns (OR, whole original tag): \[\"v\*\"\]`));
    assert.match(markdown.stdout, /Pages fetched: 2 \/ 3; entries scanned: 4\./);
    assert.ok(!markdown.stdout.includes('unused'));
    for (const release of json.report.releases) assert.ok(markdown.stdout.includes('](' + release.url + ')'));
    if (selected === 3) {
      assert.match(markdown.stdout, /Prereleases: varies by repository/);
      assert.match(markdown.stdout, /Policy: per-repository limit 2; prereleases included/);
      assert.match(markdown.stdout, /Policy: per-repository limit 1; prereleases excluded/);
    } else {
      assert.equal((markdown.stdout.match(/Policy: per-repository limit 1; prereleases included/g) ?? []).length, 2);
    }
    const csv = await h.run([...args, ...extra], 'csv');
    assert.equal(csv.code, json.code); assert.equal(csv.stderr, json.stderr);
    assert.deepEqual(h.requests.splice(0), requests);
    const rows = csvObjects(csv.stdout), summary = rows[0];
    assert.deepEqual(rows.map(r => r.row_type), ['report', 'repository', 'repository', ...expectedIds.map(() => 'release')]);
    assert.deepEqual(rows.filter(r => r.row_type === 'release').map(r => Number(r.release_id)), expectedIds);
    assert.equal(summary.complete, 'true'); assert.equal(summary.mode, 'live');
    assert.equal(summary.generated_at, json.report.generatedAt);
    assert.equal(summary.groups, '["preview","stable"]'); assert.equal(summary.tag_patterns, '["v*"]');
    assert.equal(summary.since, '2026-09-02T12:00:00.000Z'); assert.equal(summary.until, '2026-09-04T12:00:00.000Z');
    assert.equal(summary.max_pages_per_repository, '3'); assert.equal(summary.total_limit, String(expectedIds.length));
    assert.deepEqual([summary.matching_releases, summary.selected_releases, summary.returned_releases], [matching, selected, expectedIds.length].map(String));
    assert.deepEqual([summary.per_repository_hidden_releases, summary.globally_hidden_releases], selected === 3 ? ['0', '1'] : ['2', '1']);
    assert.deepEqual([summary.limit_per_repository, summary.include_prereleases], selected === 3 ? ['', ''] : ['1', 'true']);
    const repos = rows.filter(r => r.row_type === 'repository');
    assert.deepEqual(repos.map(r => [r.repository, r.requested, r.complete, r.pages_fetched, r.max_pages_per_repository]), [['demo/z', 'true', 'true', '2', '3'], ['demo/a', 'true', 'true', '1', '3']]);
    assert.deepEqual(repos.map(r => [r.limit_per_repository, r.include_prereleases, r.matching_releases, r.selected_releases, r.returned_releases]), selected === 3
      ? [['2', 'true', '2', '2', '1'], ['1', 'false', '1', '1', '1']]
      : [['1', 'true', '2', '1', '0'], ['1', 'true', '2', '1', '1']]);
    assert.deepEqual(rows.filter(r => r.row_type === 'release').map(r => r.url), json.report.releases.map(r => r.url));
  }
});

test('Markdown and CSV retain later-page, malformed, duplicate, failed, rate-limited and skipped issues despite display/filters', async t => {
  const h = await harness(t, (req, res) => {
    if (req.url.includes('/missing/')) { res.writeHead(404); return res.end('private-remote-error'); }
    if (req.url.includes('/denied/')) { res.writeHead(429, { 'retry-after': '0' }); return res.end('private-remote-error'); }
    if (req.url.endsWith('page=1')) return respond(res, [release(1), release(2), release(2), release(3, 'demo/one', { body: 7 })], {
      link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
    });
    res.writeHead(500); res.end('private-remote-error');
  }, { repositories: ['demo/one', 'demo/missing', 'demo/denied', 'demo/skipped'] });
  const requests = ['/repos/demo/one/releases?per_page=100&page=1', '/repos/demo/one/releases?per_page=100&page=2', '/repos/demo/missing/releases?per_page=100&page=1', '/repos/demo/denied/releases?per_page=100&page=1'];
  for (const empty of [false, true]) {
    const args = ['--total-limit', '1', ...(empty ? ['--tag-pattern', 'absent'] : [])];
    const json = await h.run(args);
    assert.equal(json.code, 1); assert.equal(json.report.complete, false);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.deepEqual(json.report.issues.map(i => i.code), ['http_error', 'invalid_record', 'duplicate_release', 'not_found', 'rate_limited', 'skipped']);
    const markdown = await h.run(args, 'markdown');
    assert.equal(markdown.code, 1); assert.equal(markdown.stderr, json.stderr);
    assert.deepEqual(h.requests.splice(0), requests);
    assert.deepEqual(markdownIds(markdown.stdout), empty ? [] : [2]);
    assert.deepEqual(markdownIds(markdown.stdout), json.report.releases.map(r => r.id));
    assert.match(markdown.stdout, /\*\*Result: INCOMPLETE scan/);
    for (const code of ['http\\_error', 'invalid\\_record', 'duplicate\\_release', 'not\\_found', 'rate\\_limited', 'skipped']) {
      assert.ok(markdown.stdout.includes('**' + code + '**'), code);
    }
    assert.ok(markdown.stdout.includes(String.raw`### demo\/skipped`));
    assert.match(markdown.stdout, /Status: \*\*INCOMPLETE\*\*; API requested: no\./);
    assert.match(markdown.stdout, /Pages fetched: 0 \/ 3; entries scanned: 0\./);
    assert.match(markdown.stdout, /retry after 0s/);
    assert.ok(!(markdown.stdout + markdown.stderr).includes('private-remote-error'));
    if (empty) assert.match(markdown.stdout, /incomplete scan does not establish that the repositories have no releases/);
    else assert.match(markdown.stdout, /hidden by total limit: 1\./);
    const csv = await h.run(args, 'csv');
    assert.equal(csv.code, 1); assert.equal(csv.stderr, json.stderr);
    assert.deepEqual(h.requests.splice(0), requests);
    const rows = csvObjects(csv.stdout), issues = rows.filter(r => r.row_type === 'issue');
    assert.deepEqual(rows.map(r => r.row_type), ['report', ...Array(4).fill('repository'), ...(empty ? [] : ['release']), ...Array(6).fill('issue')]);
    assert.equal(rows[0].complete, 'false'); assert.equal(rows[0].returned_releases, empty ? '0' : '1');
    assert.equal(rows[0].globally_hidden_releases, empty ? '0' : '1');
    assert.deepEqual(rows.filter(r => r.row_type === 'release').map(r => r.release_id), empty ? [] : ['2']);
    assert.deepEqual(rows.filter(r => r.row_type === 'repository').map(r => [r.repository, r.requested, r.pages_fetched]), [
      ['demo/one', 'true', '1'], ['demo/missing', 'true', '0'], ['demo/denied', 'true', '0'], ['demo/skipped', 'false', '0'],
    ]);
    assert.ok(rows.filter(r => r.row_type === 'repository').every(r => r.complete === 'false'));
    assert.deepEqual(issues.map(r => [r.repository, r.issue_code, r.issue_message]), json.report.issues.map(i => [i.repository, i.code, i.message]));
    assert.deepEqual(issues.map(r => r.http_status), ['500', '', '', '404', '429', '']);
    assert.deepEqual(issues.map(r => r.issue_count), ['', '1', '1', '', '', '']);
    assert.deepEqual(issues.map(r => r.retry_after_seconds), ['', '', '', '', '0', '']);
    assert.ok(!csv.stdout.includes('private-remote-error'));
  }
});

test('Markdown and CSV preserve page-budget issues for displayed and empty selections', async t => {
  const h = await harness(t, (req, res) => respond(res, [release(1), release(2)], {
    link: '<https://api.github.com/repos/demo/one/releases?per_page=100&page=2>; rel="next"',
  }), { maxPages: 1 });
  for (const empty of [false, true]) {
    const args = ['--total-limit', '1', ...(empty ? ['--since', '2026-10-01T00:00:00Z'] : [])];
    const json = await h.run(args);
    const markdown = await h.run(args, 'markdown');
    assert.equal(json.code, 1); assert.equal(markdown.code, 1); assert.equal(markdown.stderr, json.stderr);
    assert.deepEqual(h.requests.splice(0), Array(2).fill('/repos/demo/one/releases?per_page=100&page=1'));
    assert.deepEqual(markdownIds(markdown.stdout), empty ? [] : [2]);
    assert.ok(markdown.stdout.includes('**page\\_limit**'));
    assert.match(markdown.stdout, /Pages fetched: 1 \/ 1/);
    assert.match(markdown.stdout, /\*\*Result: INCOMPLETE scan/);
    if (empty) assert.match(markdown.stdout, /incomplete scan does not establish/);
    const csv = await h.run(args, 'csv');
    assert.equal(csv.code, 1); assert.equal(csv.stderr, json.stderr);
    assert.deepEqual(h.requests.splice(0), ['/repos/demo/one/releases?per_page=100&page=1']);
    const rows = csvObjects(csv.stdout);
    assert.equal(rows[0].complete, 'false'); assert.equal(rows[0].returned_releases, empty ? '0' : '1');
    assert.equal(rows[1].pages_fetched, '1'); assert.equal(rows[1].max_pages_per_repository, '1');
    assert.deepEqual(rows.filter(r => r.row_type === 'release').map(r => r.release_id), empty ? [] : ['2']);
    assert.deepEqual(rows.filter(r => r.row_type === 'issue').map(r => r.issue_code), ['page_limit']);
  }
});

test('Markdown, CSV and JSON distinguish complete empty queries from wholly failed scans', async t => {
  for (const kind of ['empty-api', 'empty-filter', 'failed']) {
    const h = await harness(t, (req, res) => {
      if (kind === 'failed') { res.writeHead(500); return res.end('private-remote-error'); }
      respond(res, kind === 'empty-api' ? [] : [release(1)]);
    });
    const args = ['--tag-pattern', 'absent'];
    const json = await h.run(args);
    const markdown = await h.run(args, 'markdown');
    assert.equal(markdown.code, kind === 'failed' ? 1 : 0);
    assert.equal(markdown.code, json.code); assert.equal(markdown.stderr, json.stderr);
    assert.deepEqual(markdownIds(markdown.stdout), []);
    assert.deepEqual(h.requests, Array(2).fill('/repos/demo/one/releases?per_page=100&page=1'));
    assert.match(markdown.stdout, /No matching releases in the retrieved data/);
    if (kind === 'failed') {
      assert.match(markdown.stdout, /incomplete scan does not establish/);
      assert.ok(markdown.stdout.includes('**http\\_error**'));
    } else assert.match(markdown.stdout, /\*\*Result: COMPLETE scan \| 0 shown releases\*\*/);
    const csv = await h.run(args, 'csv');
    assert.equal(csv.code, json.code); assert.equal(csv.stderr, json.stderr);
    assert.deepEqual(h.requests, Array(3).fill('/repos/demo/one/releases?per_page=100&page=1'));
    const rows = csvObjects(csv.stdout);
    assert.deepEqual(rows.map(r => r.row_type), kind === 'failed' ? ['report', 'repository', 'issue'] : ['report', 'repository']);
    assert.equal(rows[0].complete, kind === 'failed' ? 'false' : 'true');
    assert.equal(rows[0].matching_releases, '0'); assert.equal(rows[0].returned_releases, '0');
    assert.equal(rows[0].total_limit, ''); assert.equal(rows[0].global_selection_limited, 'false');
    assert.equal(rows[1].requested, 'true'); assert.equal(rows[1].pages_fetched, kind === 'failed' ? '0' : '1');
    if (kind === 'failed') assert.equal(rows[2].issue_code, 'http_error');
  }
});
