import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseSince, parseUntil } from '../src/publication-window.js';
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

for (const [bound, parse] of [['since', parseSince], ['until', parseUntil]]) {
  test(`${bound} normalizes the documented timestamp subset without rounding`, () => {
    for (const [input, utc] of valid) {
      assert.equal(parse(input), utc);
      assert.equal(parse(utc), utc);
      assert.equal(parseArgs(['--' + bound, input])[bound], utc);
    }
  });
}

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

test('invalid bounds and reversed windows fail safely before config, credentials or any fetch', async () => {
  let fetches = 0, envReads = 0;
  const cases = [
    ...['--since', '--until'].flatMap(option => [
      ...invalid.map(value => [option, value]),
      [option], [option, '--demo'],
      [option, valid[0][0], option, valid[1][0]],
      [option + '=2026-09-29T19:30:00Z'],
    ]),
    ['--since', '2026-09-29T19:30:00.001Z', '--until', '2026-09-29T22:30:00+03:00'],
    ['--until', '2026-09-29T22:30:00+03:00', '--since', '2026-09-29T19:30:00.001Z'],
  ];
  for (const args of cases) {
    let stdout = '', stderr = '';
    const code = await runCli(['--config', '/missing-config-private-input.json', '--format', 'json', ...args], {
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

test('report entry point also validates both bounds and order before transport', async () => {
  let fetched = false;
  for (const options of [
    { since: '2026-02-30T00:00:00Z' }, { until: '2026-02-30T00:00:00Z' },
    { since: '2026-09-29T19:30:00.001Z', until: '2026-09-29T22:30:00+03:00' },
  ]) {
    await assert.rejects(collectReport(validateConfig({ repositories: ['demo/one'] }), {
      ...options, fetchImpl: () => { fetched = true; },
    }), { code: 'usage' });
  }
  assert.equal(fetched, false);
});

test('window ordering uses instants, allowing equal bounds and either argument order', () => {
  for (const args of [
    ['--since', valid[1][0], '--until', valid[2][0]],
    ['--until', valid[2][0], '--since', valid[1][0]],
  ]) {
    const options = parseArgs(args);
    assert.equal(options.since, valid[0][1]);
    assert.equal(options.until, options.since);
  }
  const options = parseArgs(['--since', '2026-09-29T22:30:00+03:00', '--until', '2026-09-29T19:30:00.001Z']);
  assert.equal(options.until, '2026-09-29T19:30:00.001Z');
});

test('fake API selection includes each endpoint and excludes only instants beyond either bound', async () => {
  const items = [122, 123, 124, 125, 126].map(ms => ({
    id: ms, name: null, tag_name: 'v' + ms, draft: false, prerelease: false, body: null,
    html_url: 'https://github.com/demo/one/releases/tag/v' + ms,
    published_at: `2026-09-29T10:00:00.${ms}Z`,
  }));
  for (const [bounds, expected] of [
    [{}, [126, 125, 124, 123, 122]],
    [{ since: '2026-09-29T10:00:00.123Z' }, [126, 125, 124, 123]],
    [{ until: '2026-09-29T13:00:00.125+03:00' }, [125, 124, 123, 122]],
    [{ since: '2026-09-29T10:00:00.123Z', until: '2026-09-29T05:00:00.125-05:00' }, [125, 124, 123]],
    [{ since: '2026-09-29T13:00:00.123+03:00', until: '2026-09-29T10:00:00.123Z' }, [123]],
    [{ since: '2026-09-29T10:00:00.127Z', until: '2026-09-29T10:00:00.128Z' }, []],
  ]) {
    let requests = 0;
    const report = await collectReport(validateConfig({ repositories: ['demo/one'] }), {
      ...bounds, fetchImpl: async url => {
        requests++;
        assert.equal(url, 'https://api.github.com/repos/demo/one/releases?per_page=100&page=1');
        return new Response(JSON.stringify(items), { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(requests, 1);
    assert.equal(report.complete, true);
    assert.deepEqual(report.releases.map(r => r.id), expected);
    assert.equal(report.repositories[0].matchingReleases, expected.length);
    assert.equal(report.repositories[0].selectionLimited, false);
    assert.equal(report.scope.until, bounds.until ? parseUntil(bounds.until) : null);
  }
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
  assert.equal(unchanged.scope.until, null);
  assert.deepEqual(unchanged.releases.map(r => r.id), [201, 101, 200]);
  const stable = await run(['--since', '2026-09-29T22:30:00+03:00']);
  assert.equal(stable.scope.since, '2026-09-29T19:30:00.000Z');
  assert.equal(stable.scope.until, null);
  assert.deepEqual(stable.releases.map(r => r.id), [201]);
  const preview = await run(['--since', '2026-09-29T19:30:00Z', '--include-prereleases', '--limit', '1']);
  assert.deepEqual(preview.releases.map(r => r.id), [102, 201]);
  assert.equal(preview.repositories[0].scannedEntries, 3); // Includes the excluded draft.
  const empty = await run(['--since', '2026-10-01T00:00:00Z', '--include-prereleases']);
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.releases, []);
  assert.deepEqual(empty.issues, []);
  const until = await run(['--until', '2026-09-29T22:30:00+03:00', '--include-prereleases', '--limit', '1']);
  assert.equal(until.scope.since, null);
  assert.equal(until.scope.until, '2026-09-29T19:30:00.000Z');
  assert.deepEqual(until.releases.map(r => r.id), [201, 101]);
  assert.equal(until.repositories[1].matchingReleases, 2);
  assert.equal(until.repositories[1].selectionLimited, true);
  const window = await run(['--since', '2026-09-29T18:00:00Z', '--until', '2026-09-30T09:00:00Z', '--include-prereleases']);
  assert.deepEqual(window.releases.map(r => r.id), [102, 201, 101]);
  const exact = await run(['--since', valid[0][0], '--until', valid[1][0]]);
  assert.deepEqual(exact.releases.map(r => r.id), [201]);
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

test('real CLI upper bounds and closed windows keep UTC semantics in table and JSON across local TZs', () => {
  const bin = fileURLToPath(new URL('../bin/crypto-release-radar.js', import.meta.url));
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    for (const [bounds, expected, label] of [
      [[], [201, 101, 200], /Publication filter: none/],
      [['--until', valid[1][0]], [201, 101, 200], /published_at <= 2026-09-29T19:30:00\.000Z \(inclusive\)/],
      [['--since', valid[0][0], '--until', valid[2][0]], [201], /published_at >= 2026-09-29T19:30:00\.000Z and published_at <= 2026-09-29T19:30:00\.000Z \(inclusive\)/],
      [['--until', '2026-09-24T23:59:59.999Z'], [], /No matching releases/],
    ]) {
      for (const format of ['json', 'table']) {
        const result = spawnSync(process.execPath, [bin, '--demo', '--format', format, ...bounds], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
        assert.equal(result.status, 0); assert.equal(result.stderr, '');
        if (format === 'json') {
          const report = JSON.parse(result.stdout);
          assert.deepEqual(report.releases.map(r => r.id), expected);
          assert.equal(report.complete, true);
        } else assert.match(result.stdout, label);
      }
    }
  }
  const bad = spawnSync(process.execPath, [bin, '--demo', '--until', '2026-09-29T19:30:00Zprivate-input'], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^usage:/); assert.ok(!bad.stderr.includes('private-input'));
  const reversed = spawnSync(process.execPath, [bin, '--demo', '--since', '2026-09-30T00:00:00Z', '--until', valid[1][0]], { encoding: 'utf8' });
  assert.equal(reversed.status, 2); assert.equal(reversed.stdout, '');
  assert.match(reversed.stderr, /^usage:/); assert.ok(!reversed.stderr.includes('2026-'));
});
