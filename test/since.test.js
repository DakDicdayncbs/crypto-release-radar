import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseSince } from '../src/since.js';
import { parseArgs, runCli } from '../src/cli.js';
import { collectReport } from '../src/radar.js';
import { validateConfig } from '../src/config.js';

const valid = [
  ['2026-09-29T19:30:00Z', '2026-09-29T19:30:00.000Z'],
  ['2026-09-29T22:30:00+03:00', '2026-09-29T19:30:00.000Z'],
  ['2026-09-29T14:00:00-05:30', '2026-09-29T19:30:00.000Z'],
  ['2026-09-29T19:30:00+00:00', '2026-09-29T19:30:00.000Z'],
  ['2026-09-29T19:30:00.1Z', '2026-09-29T19:30:00.100Z'],
  ['2026-09-29T19:30:00.12Z', '2026-09-29T19:30:00.120Z'],
  ['2026-09-29T19:30:00.123Z', '2026-09-29T19:30:00.123Z'],
  ['2024-02-29T00:30:00.001+01:00', '2024-02-28T23:30:00.001Z'],
  ['2000-02-29T23:59:59Z', '2000-02-29T23:59:59.000Z'],
  ['2026-01-01T00:00:00+23:59', '2025-12-31T00:01:00.000Z'],
  ['2026-12-31T23:59:59-23:59', '2027-01-01T23:58:59.000Z'],
  ['1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z'],
  ['9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
];

test('since normalizes the documented timestamp subset without rounding', () => {
  for (const [input, utc] of valid) {
    assert.equal(parseSince(input), utc);
    assert.equal(parseSince(utc), utc);
    assert.equal(parseArgs(['--since', input]).since, utc);
  }
});

const invalid = [
  '2026-09-29', '2026-09-29T19:30:00', '2026-09-29T19:30Z',
  '2026-09-29t19:30:00Z', '2026-09-29T19:30:00z', '2026-09-29 19:30:00Z',
  '2026-09-29T19:30:00.1234Z', '2026-09-29T19:30:00.Z', '2026-09-29T19:30:00,123Z',
  '2026-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
  '2026-00-01T00:00:00Z', '2026-13-01T00:00:00Z', '2026-09-00T00:00:00Z',
  '2026-09-31T00:00:00Z', '2026-09-29T24:00:00Z', '2026-09-29T19:60:00Z',
  '2026-09-29T19:30:60Z', '2026-09-29T19:30:00+24:00', '2026-09-29T19:30:00-24:00',
  '2026-09-29T19:30:00+01:60', '2026-09-29T19:30:00+0300', '2026-09-29T19:30:00+3:00',
  '2026-09-29T19:30:00-00:00', '2026-09-29T19:30:00UTC',
  ' 2026-09-29T19:30:00Z', '2026-09-29T19:30:00Z ', '2026-09-29T19:30:00Z\n',
  '\t2026-09-29T19:30:00Z', '2026-09-29T19:30:00Z\u00a0',
  '2026-09-29T19:30:00Zprivate-input', '1969-12-31T23:59:59Z',
  '1970-01-01T00:00:00+00:01', '9999-12-31T23:59:59-00:01',
  '10000-01-01T00:00:00Z', '',
];

test('invalid since values fail safely before config, credentials or any fetch', async () => {
  let fetches = 0, envReads = 0;
  const cases = [
    ...invalid.map(value => ['--since', value]),
    ['--since'], ['--since', '--demo'],
    ['--since', valid[0][0], '--since', valid[1][0]],
    ['--since=2026-09-29T19:30:00Z'],
  ];
  for (const args of cases) {
    let stdout = '', stderr = '';
    const code = await runCli(['--config', '/missing-config-private-input.json', ...args], {
      fetchImpl: () => { fetches++; throw new Error('Must not fetch'); },
      env: new Proxy({}, { get() { envReads++; throw new Error('Must not access environment'); } }),
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
    });
    assert.equal(code, 2, JSON.stringify(args));
    assert.equal(stdout, '');
    assert.match(stderr, /^usage:/);
    assert.ok(!stderr.includes('private-input'));
    for (const value of args.filter(arg => arg.length > 10 && !arg.startsWith('--'))) assert.ok(!stderr.includes(value));
  }
  assert.equal(fetches, 0);
  assert.equal(envReads, 0);
});

test('report entry point also validates since before transport', async () => {
  let fetched = false;
  await assert.rejects(collectReport(validateConfig({ repositories: ['demo/one'] }), {
    since: '2026-02-30T00:00:00Z', fetchImpl: () => { fetched = true; },
  }), { code: 'usage' });
  assert.equal(fetched, false);
});

test('demo includes exact boundary, excludes older entries, and preserves prerelease and limit policies', async () => {
  async function run(extra) {
    let stdout = '', stderr = '';
    const code = await runCli(['--demo', '--format', 'json', ...extra], {
      fetchImpl: () => { throw new Error('Demo must remain offline'); }, env: {},
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
    });
    assert.equal(code, 0); assert.equal(stderr, '');
    return JSON.parse(stdout);
  }
  const unchanged = await run([]);
  assert.equal(unchanged.scope.since, null);
  assert.deepEqual(unchanged.releases.map(r => r.id), [201, 101, 200]);
  const stable = await run(['--since', '2026-09-29T22:30:00+03:00']);
  assert.equal(stable.scope.since, '2026-09-29T19:30:00.000Z');
  assert.deepEqual(stable.releases.map(r => r.id), [201]);
  const preview = await run(['--since', '2026-09-29T19:30:00Z', '--include-prereleases', '--limit', '1']);
  assert.deepEqual(preview.releases.map(r => r.id), [102, 201]);
  assert.equal(preview.repositories[0].scannedEntries, 3); // Includes the excluded draft.
  const empty = await run(['--since', '2026-10-01T00:00:00Z', '--include-prereleases']);
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.releases, []);
  assert.deepEqual(empty.issues, []);
});

test('real CLI table/JSON filters are identical across different local timezones', () => {
  const bin = fileURLToPath(new URL('../bin/crypto-release-radar.js', import.meta.url));
  const variants = ['2026-09-29T19:30:00.000Z', '2026-09-29T22:30:00+03:00', '2026-09-29T14:00:00-05:30'];
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    for (const since of variants) {
      const result = spawnSync(process.execPath, [bin, '--demo', '--format', 'json', '--since', since], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
      assert.equal(result.status, 0); assert.equal(result.stderr, '');
      const report = JSON.parse(result.stdout);
      assert.equal(report.scope.since, '2026-09-29T19:30:00.000Z');
      assert.deepEqual(report.releases.map(r => r.id), [201]);
    }
  }
  const table = spawnSync(process.execPath, [bin, '--demo', '--since', variants[1]], { encoding: 'utf8' });
  assert.equal(table.status, 0);
  assert.match(table.stdout, /Publication filter: published_at >= 2026-09-29T19:30:00\.000Z \(inclusive\)/);
  assert.ok(!table.stdout.includes(variants[1]));
  const bad = spawnSync(process.execPath, [bin, '--demo', '--since', '2026-02-30T00:00:00Zprivate-input'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^usage:/);
  assert.ok(!(bad.stdout + bad.stderr).includes('private-input'));
});
