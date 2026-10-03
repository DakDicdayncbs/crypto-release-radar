import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DEFAULTS, validateConfig, resolveRepositoryPolicies } from '../src/config.js';
import { collectReport } from '../src/radar.js';
import { runCli } from '../src/cli.js';

const entries = [
  { slug: 'demo/one', limit: 1, includePrereleases: false },
  { slug: 'demo/two', limit: 2, includePrereleases: true },
];
const records = repo => [
  { id: 1, published_at: '2026-09-29T10:00:00Z' },
  { id: 2, prerelease: true, published_at: '2026-09-29T15:00:00+03:00' },
  { id: 3, published_at: '2026-09-29T06:00:00-05:00' },
  { id: 4, tag_name: 'other', published_at: '2026-09-29T14:00:00Z' },
  { id: 5, draft: true, published_at: '2026-09-29T13:00:00Z' },
  { id: 6, published_at: '2026-09-28T10:00:00Z' },
].map(item => ({
  name: null, body: null, draft: false, prerelease: false, tag_name: 'v' + item.id,
  html_url: `https://github.com/${repo}/releases/tag/v${item.id}`, ...item,
}));
const window = { since: '2026-09-29T10:00:00Z', until: '2026-09-29T12:00:00Z', tagPatterns: ['v*'] };
const fakeApi = async url => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://api.github.com');
  assert.equal(parsed.search, '?per_page=100&page=1');
  const match = /^\/repos\/(demo\/(?:one|two))\/releases$/.exec(parsed.pathname);
  assert.ok(match);
  return new Response(JSON.stringify(records(match[1])), { headers: { 'content-type': 'application/json' } });
};

test('string, object and mixed configs retain defaults and independently copy repository entries', () => {
  const source = { repositories: ['demo/one', { slug: 'demo/two', includePrereleases: false }] };
  const config = validateConfig(source);
  assert.equal(config.limit, DEFAULTS.limit);
  assert.deepEqual(resolveRepositoryPolicies(config), [
    { repository: 'demo/one', limit: 5, includePrereleases: false },
    { repository: 'demo/two', limit: 5, includePrereleases: false },
  ]);
  config.repositories[1].includePrereleases = true;
  config.repositories.push('demo/three');
  assert.equal(source.repositories[1].includePrereleases, false);
  assert.equal(source.repositories.length, 2);
  const maximum = validateConfig({ repositories: Array.from({ length: 20 }, (_, i) => ({ slug: 'demo/repo' + i, limit: i % 2 ? 1 : 50 })) });
  assert.equal(resolveRepositoryPolicies(maximum).length, 20);
});

test('per-field precedence is CLI, object, top-level, defaults and explicit false is preserved', () => {
  const config = validateConfig({
    repositories: ['demo/one', { slug: 'demo/two', includePrereleases: false }, { slug: 'demo/three', limit: 50 }],
    limit: 3, includePrereleases: true,
  });
  assert.deepEqual(resolveRepositoryPolicies(config), [
    { repository: 'demo/one', limit: 3, includePrereleases: true },
    { repository: 'demo/two', limit: 3, includePrereleases: false },
    { repository: 'demo/three', limit: 50, includePrereleases: true },
  ]);
  assert.deepEqual(resolveRepositoryPolicies(config, { limit: 1, includePrereleases: true }).map(p => [p.limit, p.includePrereleases]), [[1, true], [1, true], [1, true]]);
  assert.deepEqual(resolveRepositoryPolicies(config, { limit: 2 }).map(p => p.includePrereleases), [true, false, true]);
  assert.deepEqual(resolveRepositoryPolicies(config, { includePrereleases: true }).map(p => p.limit), [3, 3, 50]);
  assert.deepEqual(resolveRepositoryPolicies(config, { includePrereleases: false }).map(p => p.includePrereleases), [false, false, false]);
  assert.equal(config.limit, 3); assert.equal(config.repositories[1].includePrereleases, false);
});

const badEntries = [
  null, [], {}, 42, true, { limit: 1 }, { slug: null }, { slug: [] }, { slug: 4 }, { slug: '' },
  { slug: 'https://github.com/demo/one' }, { slug: 'demo/..' }, { slug: 'private-sentinel/one?key=value' },
  ...[0, 51, 1.5, '2', null, undefined, false].map(limit => ({ slug: 'demo/one', limit })),
  ...['false', null, undefined, 0, [], {}].map(includePrereleases => ({ slug: 'demo/one', includePrereleases })),
  ...['repository', 'token', 'maxPages', 'timeoutMs', 'since', 'until', 'tagPatterns', 'private-sentinel'].map(key => ({ slug: 'demo/one', [key]: 'private-sentinel' })),
];

test('repository objects reject missing/invalid slugs, unknown keys and invalid policy types/ranges safely', () => {
  for (const entry of badEntries) {
    assert.throws(() => validateConfig({ repositories: [entry] }), error => error.code === 'invalid_config' && !error.message.includes('private-sentinel'));
  }
  assert.throws(() => validateConfig({ repositories: [Object.create({ slug: 'demo/one' })] }), { code: 'invalid_config' });
  assert.throws(() => validateConfig({ repositories: Array(1) }), { code: 'invalid_config' });
});

test('case-insensitive duplicates are rejected across both entry forms and in either order', () => {
  for (const repositories of [
    ['Demo/One', { slug: 'demo/one', limit: 1 }],
    [{ slug: 'Demo/One' }, 'demo/one'],
    [{ slug: 'Demo/One', includePrereleases: false }, { slug: 'demo/one', includePrereleases: true }],
  ]) assert.throws(() => validateConfig({ repositories }), { code: 'invalid_config' });
});

test('equivalent string and object configs produce identical complete reports including policies', async () => {
  const options = { fetchImpl: fakeApi, now: () => new Date('2026-10-03T00:00:00Z'), ...window };
  const strings = validateConfig({ repositories: ['demo/one', 'demo/two'], limit: 2, includePrereleases: true });
  const objects = validateConfig({ repositories: [{ slug: 'demo/one' }, { slug: 'demo/two' }], limit: 2, includePrereleases: true });
  assert.deepEqual(await collectReport(strings, options), await collectReport(objects, options));
  const mixed = validateConfig({ repositories: ['demo/one', { slug: 'demo/two', limit: 2, includePrereleases: true }], limit: 2, includePrereleases: true });
  assert.deepEqual(await collectReport(strings, options), await collectReport(mixed, options));
});

test('different repository policies compose with raw tags, date instants, UTC sorting and display limits', async () => {
  const config = validateConfig({ repositories: entries, limit: 3, includePrereleases: true });
  const report = await collectReport(config, { fetchImpl: fakeApi, ...window });
  assert.equal(report.schemaVersion, 1); assert.equal(report.complete, true);
  assert.deepEqual(report.releases.map(r => [r.repository, r.id]), [['demo/two', 2], ['demo/one', 3], ['demo/two', 3]]);
  assert.deepEqual(report.repositories.map(r => r.policy), [{ limit: 1, includePrereleases: false }, { limit: 2, includePrereleases: true }]);
  assert.deepEqual(report.repositories.map(r => [r.matchingReleases, r.returnedReleases, r.selectionLimited]), [[2, 1, true], [3, 2, true]]);
  assert.equal(report.scope.limitPerRepository, null); assert.equal(report.scope.includePrereleases, null);
  for (const [policyOverrides, limit, prereleases] of [
    [{ limit: 2 }, 2, null], [{ includePrereleases: true }, null, true], [{ limit: 2, includePrereleases: true }, 2, true],
  ]) {
    const overridden = await collectReport(config, { fetchImpl: fakeApi, ...window, policyOverrides });
    assert.equal(overridden.scope.limitPerRepository, limit);
    assert.equal(overridden.scope.includePrereleases, prereleases);
  }
});

test('invalid overridden config fields fail before token access or fake requests', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'private-sentinel.json');
  let envReads = 0, requests = 0;
  const values = [
    ...badEntries.filter(entry => !(entry && typeof entry === 'object' && Object.values(entry).includes(undefined))).map(entry => ({ repositories: ['demo/other', entry] })),
    { repositories: entries, limit: 0 }, { repositories: entries, includePrereleases: 'private-sentinel' },
  ];
  for (const value of values) {
    await writeFile(path, JSON.stringify(value));
    let stdout = '', stderr = '';
    const code = await runCli(['--config', path, '--format', 'json', '--limit', '1', '--include-prereleases'], {
      env: new Proxy({}, { get() { envReads++; throw new Error('Must not read token'); } }),
      fetchImpl: () => { requests++; throw new Error('Must not fetch'); },
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 2); assert.match(stderr, /^invalid_config:/);
    assert.equal(JSON.parse(stdout).issues[0].code, 'invalid_config');
    assert.ok(!(stdout + stderr).includes('private-sentinel'));
  }
  assert.equal(envReads, 0); assert.equal(requests, 0);
});

test('CLI overrides apply to every policy and table/JSON show effective values with redaction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ repositories: entries, includePrereleases: true }));
  for (const [args, expected] of [
    [[], [[1, false], [2, true]]],
    [['--limit', '2'], [[2, false], [2, true]]],
    [['--include-prereleases'], [[1, true], [2, true]]],
    [['--limit', '2', '--include-prereleases'], [[2, true], [2, true]]],
  ]) {
    for (const format of ['json', 'table']) {
      let stdout = '', stderr = '';
      const code = await runCli(['--config', path, '--format', format, ...args], {
        env: {}, fetchImpl: fakeApi,
        stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
      });
      assert.equal(code, 0); assert.equal(stderr, '');
      if (format === 'json') assert.deepEqual(JSON.parse(stdout).repositories.map(r => [r.policy.limit, r.policy.includePrereleases]), expected);
      else for (let i = 0; i < entries.length; i++) {
        const line = stdout.split('\n').find(s => s.startsWith(entries[i].slug + ':'));
        assert.ok(line.includes(`policy: limit ${expected[i][0]}, prereleases ${expected[i][1] ? 'included' : 'excluded'}`));
      }
    }
  }
  await writeFile(path, JSON.stringify({ repositories: [{ slug: 'private-sentinel/one', limit: 2, includePrereleases: true }] }));
  for (const format of ['json', 'table']) {
    let stdout = '', stderr = '';
    const code = await runCli(['--config', path, '--format', format], {
      env: { GITHUB_TOKEN: 'private-sentinel' },
      fetchImpl: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 0); assert.equal(stderr, ''); assert.ok(!stdout.includes('private-sentinel'));
    if (format === 'json') {
      const report = JSON.parse(stdout);
      assert.equal(report.repositories[0].repository, '[REDACTED]/one');
      assert.deepEqual(report.repositories[0].policy, { limit: 2, includePrereleases: true });
      assert.equal(report.scope.limitPerRepository, 2); assert.equal(report.scope.includePrereleases, true);
    }
  }
});

test('real CLI rejects malformed object config under overrides and demo keeps the default/override contract', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ repositories: [{ slug: 'demo/one', limit: 0 }] }));
  const bin = new URL('../bin/crypto-release-radar.js', import.meta.url).pathname;
  const invalid = spawnSync(process.execPath, [bin, '--config', path, '--limit', '2', '--include-prereleases'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /^invalid_config:/);
  for (const [args, policy, ids] of [
    [[], { limit: 5, includePrereleases: false }, [201, 101, 200]],
    [['--limit', '1', '--include-prereleases'], { limit: 1, includePrereleases: true }, [102, 201]],
  ]) {
    const result = spawnSync(process.execPath, [bin, '--demo', '--format', 'json', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.releases.map(r => r.id), ids);
    assert.deepEqual(report.repositories.map(r => r.policy), [policy, policy]);
    assert.equal(report.scope.limitPerRepository, policy.limit);
    assert.equal(report.scope.includePrereleases, policy.includePrereleases);
  }
});
