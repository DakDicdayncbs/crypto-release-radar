import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateConfig, validateGroupSelection, selectRepositoryGroups, resolveRepositoryPolicies } from '../src/config.js';
import { parseArgs, runCli } from '../src/cli.js';
import { collectReport } from '../src/radar.js';

const base = { repositories: ['demo/base'] };
const definition = {
  ...base, limit: 3, includePrereleases: true,
  groups: {
    stable: [{ slug: 'demo/one', limit: 1, includePrereleases: false }],
    preview: ['demo/two', { slug: 'demo/three', limit: 2 }],
  },
};
const slugs = entries => entries.map(e => typeof e === 'string' ? e : e.slug);

test('group selection replaces the base list and preserves CLI order and member order', () => {
  const config = validateConfig(definition);
  assert.deepEqual(selectRepositoryGroups(config), { groups: [], repositories: ['demo/base'] });
  assert.deepEqual(slugs(selectRepositoryGroups(config, ['stable']).repositories), ['demo/one']);
  const selected = selectRepositoryGroups(config, ['preview', 'stable']);
  assert.deepEqual(selected.groups, ['preview', 'stable']);
  assert.deepEqual(slugs(selected.repositories), ['demo/two', 'demo/three', 'demo/one']);
  assert.deepEqual(resolveRepositoryPolicies({ ...config, repositories: selected.repositories }), [
    { repository: 'demo/two', limit: 3, includePrereleases: true },
    { repository: 'demo/three', limit: 2, includePrereleases: true },
    { repository: 'demo/one', limit: 1, includePrereleases: false },
  ]);
  assert.deepEqual(resolveRepositoryPolicies({ ...config, repositories: selected.repositories }, { limit: 4, includePrereleases: true }).map(p => [p.limit, p.includePrereleases]), [[4, true], [4, true], [4, true]]);
});

test('validated definitions and selected objects are copied without mutating source policies', () => {
  const source = structuredClone(definition);
  const config = validateConfig(source);
  const selected = selectRepositoryGroups(config, ['stable']);
  selected.repositories[0].limit = 50;
  selected.groups.push('preview');
  assert.equal(config.groups.stable[0].limit, 1);
  config.groups.stable[0].limit = 2;
  config.groups.preview.push('demo/four');
  assert.equal(source.groups.stable[0].limit, 1);
  assert.equal(source.groups.preview.length, 2);
});

test('valid bounds permit ten definitions of twenty members, but only twenty selected repositories', () => {
  const groups = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
    'g' + i, Array.from({ length: 20 }, (_, j) => ({ slug: `demo/g${i}-${j}`, limit: j % 2 ? 1 : 50 })),
  ]));
  const config = validateConfig({ ...base, groups });
  assert.equal(selectRepositoryGroups(config, ['g0']).repositories.length, 20);
  assert.throws(() => selectRepositoryGroups(config, ['g0', 'g1']), { code: 'usage' });
  const smallGroups = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['g' + i, [`demo/g${i}-a`, `demo/g${i}-b`]]));
  const names = Object.keys(smallGroups);
  assert.equal(selectRepositoryGroups(validateConfig({ ...base, groups: smallGroups }), names).repositories.length, 20);
  assert.deepEqual(parseArgs(names.flatMap(n => ['--group', n])).groups, names);
  const maximumName = 'a'.repeat(32);
  assert.deepEqual(selectRepositoryGroups(validateConfig({ ...base, groups: { a: ['demo/a'], [maximumName]: ['demo/b'] } }), ['a', maximumName]).groups, ['a', maximumName]);
  assert.deepEqual(selectRepositoryGroups(validateConfig({ ...base, groups: {} })).repositories, base.repositories);
});

const invalidNames = ['', 'a'.repeat(33), 'Core', '0core', '-core', 'a_b', 'a.b', 'a/b', 'a b', 'a\n', 'a\u202e', 'é', '__proto__'];
const invalidGroups = [
  null, [], 'private-sentinel', 42, true,
  ...invalidNames.map(name => Object.fromEntries([[name, ['demo/one']]])),
  Object.fromEntries(Array.from({ length: 11 }, (_, i) => ['g' + i, ['demo/r' + i]])),
  ...[[], null, 'demo/one', { repositories: ['demo/one'] }, Array(21).fill('demo/one'), [null], [[]],
    [{ group: 'stable' }], ['@stable'], ['https://private-sentinel/one'],
    [{ slug: 'demo/one', limit: 0 }], [{ slug: 'demo/one', includePrereleases: 'private-sentinel' }],
    [{ slug: 'demo/one', groups: ['stable'] }], ['Demo/One', { slug: 'demo/one' }],
  ].map(entries => ({ unused: entries })),
];

test('all group definitions are strict and bounded, including names and unused invalid members', () => {
  for (const groups of invalidGroups) {
    assert.throws(() => validateConfig({ ...base, groups }), error => error.code === 'invalid_config' && !error.message.includes('private-sentinel'));
  }
  assert.throws(() => validateConfig({ ...base, groups: { unused: Array(1) } }), { code: 'invalid_config' });
  assert.throws(() => validateConfig({ groups: { stable: ['demo/one'] } }), { code: 'invalid_config' });
  assert.throws(() => validateConfig({ repositories: [], groups: { stable: ['demo/one'] } }), { code: 'invalid_config' });
});

test('unknown/repeated selections fail and overlapping slugs cannot merge or silently change policies', () => {
  const config = validateConfig(definition);
  for (const names of [['missing'], ['constructor'], ['stable', 'stable'], Array(11).fill('stable'), ...invalidNames.map(n => [n])]) {
    assert.throws(() => selectRepositoryGroups(config, names), { code: 'usage' });
  }
  for (const second of ['DEMO/one', { slug: 'Demo/One', limit: 1 }, { slug: 'demo/one', limit: 3, includePrereleases: true }]) {
    const overlap = validateConfig({ repositories: ['demo/one'], groups: {
      first: [{ slug: 'demo/one', limit: 1 }], second: [second],
    } });
    assert.equal(selectRepositoryGroups(overlap, ['first']).repositories.length, 1);
    assert.equal(selectRepositoryGroups(overlap, ['second']).repositories.length, 1);
    assert.throws(() => selectRepositoryGroups(overlap, ['first', 'second']), { code: 'usage' });
  }
  const own = validateConfig({ ...base, groups: { constructor: ['demo/one'] } });
  assert.deepEqual(selectRepositoryGroups(own, ['constructor']).repositories, ['demo/one']);
});

test('CLI rejects invalid group syntax, repeated names and demo combinations before reading config', async () => {
  let envReads = 0, requests = 0;
  for (const args of [
    ['--group'], ['--group', '--format'], ['--group=stable'], ['--group', 'stable', '--group', 'stable'],
    ['--demo', '--group', 'stable'], ...invalidNames.map(name => ['--group', name]),
    Array.from({ length: 11 }, (_, i) => ['--group', 'g' + i]).flat(),
  ]) {
    let stdout = '', stderr = '';
    const code = await runCli(args.includes('--demo') ? args : ['--config', '/missing-private-sentinel', ...args], {
      env: new Proxy({}, { get() { envReads++; throw new Error('Token access forbidden'); } }),
      fetchImpl: () => { requests++; },
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 2); assert.equal(stdout, ''); assert.match(stderr, /^usage:/);
    assert.ok(!stderr.includes('private-sentinel'));
  }
  assert.equal(envReads, 0); assert.equal(requests, 0);
  assert.throws(() => validateGroupSelection(Array(1)), { code: 'usage' });
});

test('unused definition, unknown, overlap and expansion errors all precede token/API access despite overrides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  let envReads = 0, requests = 0;
  const overlap = { ...base, groups: { first: ['demo/one'], second: [{ slug: 'DEMO/one', limit: 2 }] } };
  const large = { ...base, groups: { first: Array.from({ length: 20 }, (_, i) => 'demo/r' + i), second: ['demo/last'] } };
  for (const [config, names, error] of [
    ...invalidGroups.map(groups => [{ ...base, groups }, [], 'invalid_config']),
    [{ ...definition, groups: { ...definition.groups, unused: [{ slug: 'demo/bad', limit: 0 }] } }, ['stable'], 'invalid_config'],
    [base, ['private-sentinel'], 'usage'], [overlap, ['first', 'second'], 'usage'], [large, ['first', 'second'], 'usage'],
  ]) {
    await writeFile(path, JSON.stringify(config));
    let stdout = '', stderr = '';
    const code = await runCli(['--config', path, '--format', 'json', '--limit', '1', '--include-prereleases', ...names.flatMap(n => ['--group', n])], {
      env: new Proxy({}, { get() { envReads++; throw new Error('Token access forbidden'); } }),
      fetchImpl: () => { requests++; },
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 2); assert.equal(JSON.parse(stdout).issues[0].code, error);
    assert.ok(stderr.startsWith(error + ':')); assert.ok(!(stdout + stderr).includes('private-sentinel'));
  }
  await assert.rejects(collectReport(validateConfig(overlap), { groups: ['first', 'second'], fetchImpl: () => { requests++; } }), { code: 'usage' });
  assert.equal(envReads, 0); assert.equal(requests, 0);
});

const release = (repo, id, extra = {}) => ({
  id, tag_name: 'v' + id, name: null, body: null, draft: false, prerelease: false,
  published_at: '2026-09-29T10:00:00Z', html_url: `https://github.com/${repo}/releases/tag/v${id}`, ...extra,
});

test('fake API receives only selected slugs in expansion order with policies and composable filters', async () => {
  const config = validateConfig(definition);
  const requests = [];
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    const repo = path.slice('/repos/'.length, -'/releases'.length);
    requests.push(repo);
    return new Response(JSON.stringify([
      release(repo, 1), release(repo, 2, { prerelease: true, published_at: '2026-09-29T13:00:00+03:00' }),
      release(repo, 3, { tag_name: 'other' }), release(repo, 4, { published_at: '2026-09-30T10:00:00Z' }),
      release(repo, 5, { draft: true }),
    ]), { headers: { 'content-type': 'application/json' } });
  };
  const report = await collectReport(config, {
    groups: ['preview', 'stable'], tagPatterns: ['v*'], since: '2026-09-29T10:00:00Z', until: '2026-09-29T10:00:00Z', fetchImpl,
  });
  assert.deepEqual(requests, ['demo/two', 'demo/three', 'demo/one']);
  assert.deepEqual(report.repositories.map(r => [r.repository, r.requested]), requests.map(r => [r, true]));
  assert.equal(report.complete, true); assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.scope.groups, ['preview', 'stable']);
  assert.deepEqual(report.repositories.map(r => [r.policy.limit, r.policy.includePrereleases, r.matchingReleases]), [[3, true, 2], [2, true, 2], [1, false, 1]]);
  assert.deepEqual(report.releases.map(r => [r.repository, r.id]), [['demo/one', 1], ['demo/three', 2], ['demo/three', 1], ['demo/two', 2], ['demo/two', 1]]);
  const overridden = await collectReport(config, { groups: ['stable'], fetchImpl, policyOverrides: { limit: 2, includePrereleases: true } });
  assert.deepEqual(overridden.repositories[0].policy, { limit: 2, includePrereleases: true });
  assert.equal(overridden.repositories[0].selectionLimited, true);
});

test('default string/object configurations retain identical results when unused groups are added', async () => {
  const config = validateConfig({ repositories: ['demo/one', { slug: 'demo/two', includePrereleases: true }] });
  const options = { now: () => new Date('2026-10-04T00:00:00Z'), fetchImpl: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }) };
  const original = await collectReport(config, options);
  const withGroups = await collectReport(validateConfig({ ...config, groups: { unused: ['demo/other'] } }), options);
  assert.deepEqual(withGroups, original);
  assert.deepEqual(original.scope.groups, []);
});

test('group names are redacted in table and JSON with CLI policy overrides preserved', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...base, groups: { 'private-sentinel': [{ slug: 'demo/one', limit: 1 }] } }));
  for (const format of ['json', 'table']) {
    let stdout = '', stderr = '';
    const code = await runCli(['--config', path, '--group', 'private-sentinel', '--format', format, '--limit', '4', '--include-prereleases'], {
      env: { GITHUB_TOKEN: 'private-sentinel' },
      fetchImpl: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 0); assert.equal(stderr, ''); assert.ok(!stdout.includes('private-sentinel'));
    if (format === 'json') {
      const report = JSON.parse(stdout);
      assert.deepEqual(report.scope.groups, ['[REDACTED]']);
      assert.equal(report.repositories[0].requested, true);
      assert.deepEqual(report.repositories[0].policy, { limit: 4, includePrereleases: true });
    } else assert.match(stdout, /Repository selection: groups.*REDACTED/);
  }
});

test('real CLI rejects groups with demo and unknown groups; existing demo remains offline', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(base));
  const bin = new URL('../bin/crypto-release-radar.js', import.meta.url).pathname;
  for (const args of [['--demo', '--group', 'stable'], ['--config', path, '--group', 'private-sentinel']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2); assert.match(result.stderr, /^usage:/);
    assert.ok(!(result.stdout + result.stderr).includes('private-sentinel'));
  }
  const result = spawnSync(process.execPath, [bin, '--demo', '--format', 'json'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.scope.groups, []);
  assert.deepEqual(report.releases.map(r => r.id), [201, 101, 200]);
  assert.ok(report.repositories.every(r => r.requested === false));
});

test('documented group example validates and selects explicit disjoint groups', async () => {
  const config = validateConfig(JSON.parse(await readFile(new URL('../examples/groups.json', import.meta.url), 'utf8')));
  assert.deepEqual(slugs(selectRepositoryGroups(config, ['tooling', 'clients']).repositories), ['foundry-rs/foundry', 'bitcoin/bitcoin', 'ethereum/go-ethereum']);
});
