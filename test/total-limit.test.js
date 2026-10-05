import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseArgs, runCli, HELP } from '../src/cli.js';
import { collectReport } from '../src/radar.js';
import { validateConfig } from '../src/config.js';
import { MAX_TOTAL_LIMIT, parseTotalLimit, validateTotalLimit } from '../src/display-budget.js';
import { formatReport } from '../src/output.js';

const now = () => new Date('2026-10-05T17:00:00Z');
const release = (repo, id, publishedAt = '2026-10-05T12:00:00Z', overrides = {}) => ({
  id, name: `Release ${id}`, tag_name: `v${id}`, body: 'Notes', draft: false, prerelease: false,
  published_at: publishedAt, html_url: `https://github.com/${repo}/releases/tag/v${id}`, ...overrides,
});
const ids = report => report.releases.map(r => [r.repository, r.id]);
const counts = report => report.repositories.map(r => [r.matchingReleases, r.selectedReleases, r.returnedReleases, r.selectionLimited, r.globalSelectionLimited]);
const fakeApi = (data, requests = []) => async url => {
  const parsed = new URL(url);
  requests.push(parsed.pathname + parsed.search);
  assert.equal(parsed.origin, 'https://api.github.com');
  assert.equal(parsed.search, '?per_page=100&page=1');
  const repo = parsed.pathname.slice('/repos/'.length, -'/releases'.length);
  assert.ok(Object.hasOwn(data, repo));
  return new Response(JSON.stringify(data[repo]), { headers: { 'content-type': 'application/json' } });
};
async function configFile(t, config) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-total-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config));
  return path;
}
async function run(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, {
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    now, ...options,
  });
  return { code, stdout, stderr };
}

test('total limit parses inclusive canonical bounds and rejects bad values before config/env/network', async () => {
  assert.equal(MAX_TOTAL_LIMIT, 1000);
  for (const value of ['1', '2', '999', '1000']) {
    assert.equal(parseTotalLimit(value), Number(value));
    assert.equal(parseArgs(['--total-limit', value]).totalLimit, Number(value));
  }
  assert.equal(validateTotalLimit(undefined), undefined);
  const badValues = ['', '0', '-1', '+1', '01', '0001', '1001', '1.0', '1.5', '1e2', '0x10', ' 1', '1 ', '1\n', '1\r', '1\t', '1\u0000', '1\u2028', '１', 'true', 'null', 'Infinity', 'private-sentinel', '9'.repeat(10000)];
  const badArgs = [
    ...badValues.map(value => ['--total-limit', value]),
    ['--total-limit'], ['--total-limit', '--demo'], ['--total-limit=1'],
    ['--total-limit', '1', '--total-limit', '2'],
    ['--validate-config', '--total-limit', '1'], ['--total-limit', '1', '--validate-config'],
  ];
  for (const args of badArgs) {
    let envReads = 0, requests = 0;
    const result = await run(['--config', 'private-sentinel/missing.json', '--format', 'json', ...args], {
      env: new Proxy({}, { get() { envReads++; throw new Error('private-sentinel'); } }),
      fetchImpl: () => { requests++; throw new Error('private-sentinel'); },
    });
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^usage:/); assert.ok(!result.stderr.includes('private-sentinel'));
    assert.equal(envReads, 0); assert.equal(requests, 0);
  }
});

test('collector validates numeric total limit without reading config or calling transport', async () => {
  for (const totalLimit of [null, false, true, 0, -1, 1.5, 1001, NaN, Infinity, '1', [], {}, 1n, Symbol('bad')]) {
    let configReads = 0, fetches = 0;
    await assert.rejects(collectReport(new Proxy({}, { get() { configReads++; throw new Error(); } }), {
      totalLimit, fetchImpl: () => { fetches++; },
    }), { code: 'usage' });
    assert.equal(configReads, 0); assert.equal(fetches, 0);
  }
});

const data = {
  'demo/z': [1, 2, 3, 4].map(id => release('demo/z', id, `2026-10-0${id}T00:00:00Z`)),
  'demo/a': [
    release('demo/a', 13, '2026-10-01T00:00:00Z'),
    release('demo/a', 11, '2026-10-05T00:00:00Z'),
    release('demo/a', 12, '2026-10-02T12:00:00Z'),
  ],
};
const config = validateConfig({ repositories: ['demo/z', { slug: 'demo/a', limit: 2 }], limit: 3 });

test('no total limit preserves existing report shape, selection, counts and table output', async () => {
  const report = await collectReport(config, { fetchImpl: fakeApi(data), now });
  assert.deepEqual(ids(report), [['demo/a', 11], ['demo/z', 4], ['demo/z', 3], ['demo/a', 12], ['demo/z', 2]]);
  assert.deepEqual(report.repositories.map(r => [r.matchingReleases, r.returnedReleases, r.selectionLimited]), [[4, 3, true], [3, 2, true]]);
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'mode', 'generatedAt', 'complete', 'digestNotice', 'scope', 'repositories', 'releases', 'issues']);
  assert.deepEqual(Object.keys(report.repositories[0]), ['repository', 'policy', 'requested', 'complete', 'pagesFetched', 'scannedEntries', 'matchingReleases', 'returnedReleases', 'selectionLimited']);
  assert.deepEqual(report.scope, { limitPerRepository: null, includePrereleases: false, maxPagesPerRepository: 3, since: null, until: null, tagPatterns: [], groups: [] });
  assert.deepEqual(report, await collectReport(config, { fetchImpl: fakeApi(data), now, totalLimit: undefined }));
  const table = formatReport(report, 'table');
  assert.ok(!table.includes('Display budget:'));
  assert.match(table, /demo\/z: complete; 4 entries scanned; 3\/4 matching releases shown \(display limit\)/);
  assert.match(table, /demo\/a: complete; 3 entries scanned; 2\/3 matching releases shown \(display limit\)/);
});

test('global limit follows per-repository caps and keeps independently expected counters for 1/equal/larger bounds', async () => {
  for (const [totalLimit, expectedIds, expectedCounts] of [
    [1, [['demo/a', 11]], [[4, 3, 0, true, true], [3, 2, 1, true, true]]],
    [4, [['demo/a', 11], ['demo/z', 4], ['demo/z', 3], ['demo/a', 12]], [[4, 3, 2, true, true], [3, 2, 2, true, false]]],
    [5, [['demo/a', 11], ['demo/z', 4], ['demo/z', 3], ['demo/a', 12], ['demo/z', 2]], [[4, 3, 3, true, false], [3, 2, 2, true, false]]],
    [1000, [['demo/a', 11], ['demo/z', 4], ['demo/z', 3], ['demo/a', 12], ['demo/z', 2]], [[4, 3, 3, true, false], [3, 2, 2, true, false]]],
  ]) {
    const requests = [];
    const report = await collectReport(config, { fetchImpl: fakeApi(data, requests), now, totalLimit });
    assert.deepEqual(ids(report), expectedIds); assert.deepEqual(counts(report), expectedCounts);
    assert.equal(report.scope.totalLimit, totalLimit);
    assert.equal(report.complete, true); assert.deepEqual(report.issues, []);
    assert.deepEqual(report.display, {
      matchingReleases: 7, selectedReleases: 5, returnedReleases: expectedIds.length,
      perRepositoryHiddenReleases: 2, globallyHiddenReleases: 5 - expectedIds.length,
      globalSelectionLimited: totalLimit < 5,
    });
    assert.deepEqual(requests, ['/repos/demo/z/releases?per_page=100&page=1', '/repos/demo/a/releases?per_page=100&page=1']);
  }
});

test('total ordering uses UTC instants then original repository and descending safe integer ID regardless of input order', async () => {
  const maximumId = Number.MAX_SAFE_INTEGER;
  const records = {
    'demo/z': [release('demo/z', maximumId, '2026-10-05T14:00:00+03:00')],
    'demo/a': [
      release('demo/a', 2, '2026-10-05T06:00:00-05:00'),
      release('demo/a', maximumId - 1, '2026-10-05T11:00:00Z'),
      release('demo/a', maximumId, '2026-10-05T13:00:00+02:00'),
      release('demo/a', 4, '2026-10-05T12:00:00Z'),
    ],
  };
  for (const reversed of [false, true]) {
    const repositories = reversed ? ['demo/a', 'demo/z'] : ['demo/z', 'demo/a'];
    const input = Object.fromEntries(Object.entries(records).map(([key, items]) => [key, reversed ? [...items].reverse() : items]));
    const report = await collectReport(validateConfig({ repositories }), { fetchImpl: fakeApi(input), totalLimit: 4, now });
    assert.deepEqual(ids(report), [['demo/a', 4], ['demo/a', maximumId], ['demo/a', maximumId - 1], ['demo/a', 2]]);
    assert.equal(report.releases[1].publishedAt, '2026-10-05T11:00:00.000Z');
    assert.equal(report.repositories.find(r => r.repository === 'demo/z').returnedReleases, 0);
    assert.equal(report.display.globallyHiddenReleases, 1);
    assert.equal(report.display.perRepositoryHiddenReleases, 0);
  }
});

test('the maximum total budget supports all 20 repositories selecting 50 releases', async () => {
  const repositories = Array.from({ length: 20 }, (_, i) => 'demo/r' + String(i).padStart(2, '0'));
  const records = Object.fromEntries(repositories.map(repo => [repo, Array.from({ length: 50 }, (_, i) => release(repo, i + 1))]));
  const report = await collectReport(validateConfig({ repositories, limit: 50 }), { fetchImpl: fakeApi(records), totalLimit: 1000, now });
  assert.equal(report.releases.length, 1000); assert.equal(report.complete, true);
  assert.deepEqual(report.display, { matchingReleases: 1000, selectedReleases: 1000, returnedReleases: 1000, perRepositoryHiddenReleases: 0, globallyHiddenReleases: 0, globalSelectionLimited: false });
  assert.deepEqual(ids(report).slice(0, 2), [['demo/r00', 50], ['demo/r00', 49]]);
  assert.deepEqual(ids(report).slice(-2), [['demo/r19', 2], ['demo/r19', 1]]);
  assert.ok(report.repositories.every(r => r.returnedReleases === 50 && !r.globalSelectionLimited));
});

test('empty API and empty query results keep zero display counts and complete success', async () => {
  for (const [records, options] of [[{ 'demo/a': [] }, {}], [data, { tagPatterns: ['absent'] }]]) {
    const report = await collectReport(validateConfig({ repositories: Object.keys(records) }), { ...options, fetchImpl: fakeApi(records), totalLimit: 1, now });
    assert.deepEqual(report.releases, []); assert.equal(report.complete, true);
    assert.deepEqual(report.display, { matchingReleases: 0, selectedReleases: 0, returnedReleases: 0, perRepositoryHiddenReleases: 0, globallyHiddenReleases: 0, globalSelectionLimited: false });
    assert.ok(report.repositories.every(r => !r.selectionLimited && !r.globalSelectionLimited && r.returnedReleases === 0));
  }
});

test('redaction follows original identity sorting/counting, preserving numeric and boolean metadata', async t => {
  const path = await configFile(t, { repositories: ['demo/z', 'demo/a'], includePrereleases: true });
  const records = Object.fromEntries(['demo/z', 'demo/a'].map(repo => [repo, [release(repo, 1, undefined, {
    tag_name: 'v1-z-true', name: '1 z true', body: '1 z true', prerelease: true,
  })]]));
  for (const token of ['z', '1', 'true']) {
    for (const format of ['json', 'table']) {
      const result = await run(['--config', path, '--format', format, '--total-limit', '1'], { env: { GITHUB_TOKEN: token }, fetchImpl: fakeApi(records) });
      assert.equal(result.code, 0); assert.equal(result.stderr, '');
      if (format === 'json') {
        const report = JSON.parse(result.stdout);
        assert.equal(report.releases[0].repository, 'demo/a');
        assert.equal(report.releases[0].id, 1); assert.equal(report.releases[0].prerelease, true);
        assert.equal(report.scope.totalLimit, 1);
        assert.deepEqual(counts(report), [[1, 1, 0, false, true], [1, 1, 1, false, false]]);
        assert.equal(report.display.returnedReleases, 1); assert.equal(report.display.globalSelectionLimited, true);
        assert.ok(!report.releases[0].name.includes(token));
        assert.ok(!report.releases[0].tag.includes(token));
        assert.ok(!report.releases[0].digest.text.includes(token));
        if (token === 'z') assert.equal(report.repositories[0].repository, 'demo/[REDACTED]');
      } else {
        assert.match(result.stdout, /Display budget: total limit 1; 2 matching; 2 after per-repository limits; 1 shown; 0 hidden by per-repository limits; 1 hidden by total limit/);
        assert.match(result.stdout, /demo\/a \| /);
        assert.match(result.stdout, /1 matching; 1 after per-repository limit; 0 shown \(total limit\)/);
      }
    }
  }
});

test('real executable supports budgeted demos and informational options without config or token access', () => {
  const execute = args => spawnSync(process.execPath, ['bin/crypto-release-radar.js', ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'invalid\nprivate-sentinel' }, timeout: 10000,
  });
  const json = execute(['--demo', '--format', 'json', '--total-limit', '1']);
  assert.equal(json.status, 0); assert.equal(json.stderr, '');
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.releases.map(r => r.id), [201]);
  assert.deepEqual(counts(report), [[1, 1, 0, false, true], [2, 2, 1, false, true]]);
  assert.deepEqual(report.display, { matchingReleases: 3, selectedReleases: 3, returnedReleases: 1, perRepositoryHiddenReleases: 0, globallyHiddenReleases: 2, globalSelectionLimited: true });
  assert.ok(report.repositories.every(r => r.requested === false));
  const preview = execute(['--demo', '--format', 'json', '--include-prereleases', '--total-limit', '1']);
  assert.equal(preview.status, 0); assert.deepEqual(JSON.parse(preview.stdout).releases.map(r => r.id), [102]);
  const table = execute(['--demo', '--total-limit', '1']);
  assert.equal(table.status, 0); assert.match(table.stdout, /2 hidden by total limit/);
  assert.equal(execute(['--total-limit', '1', '--version']).stdout, '0.1.0\n');
  const help = execute(['--config', 'private-sentinel/missing', '--total-limit', '1', '--help']);
  assert.equal(help.status, 0); assert.equal(help.stdout, HELP); assert.match(HELP, /--total-limit/);
  const invalidHelp = execute(['--total-limit', '01', '--help']);
  assert.equal(invalidHelp.status, 2); assert.equal(invalidHelp.stdout, '');
});
