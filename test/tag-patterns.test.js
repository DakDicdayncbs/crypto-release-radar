import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { compileTagPatterns } from '../src/tag-patterns.js';
import { parseArgs, runCli } from '../src/cli.js';
import { collectReport } from '../src/radar.js';
import { validateConfig } from '../src/config.js';
import { normalizeReleases } from '../src/releases.js';

const matches = (pattern, tag) => compileTagPatterns([pattern]).matches(tag);
const release = (id, tag, extra = {}) => ({
  id, tag_name: tag, name: 'Example', body: null, draft: false, prerelease: false,
  published_at: '2026-09-29T12:00:00Z', html_url: 'https://github.com/demo/one/releases/tag/v1', ...extra,
});

test('globs match the whole case-sensitive string with literal, star and question tokens', () => {
  for (const [pattern, tag, expected] of [
    ['v1', 'v1', true], ['v1', 'av1', false], ['v1', 'v1a', false], ['v1', 'V1', false],
    ['*', '', true], ['*', 'release', true], ['v*', 'v', true], ['v*', 'version', true],
    ['*1', 'v1', true], ['*1', 'v1x', false], ['?', '', false], ['?', 'ab', false], ['?', 'a', true],
    ['v?.*', 'v1.0', true], ['v?.*', 'v10.0', false], ['**v**', 'avb', true],
    [' ', ' ', true], [' v1 ', 'v1', false], ['v1  beta', 'v1 beta', false],
  ]) assert.equal(matches(pattern, tag), expected, JSON.stringify([pattern, tag]));
});

test('wildcards consume Unicode code points without normalization or grapheme folding', () => {
  for (const [pattern, tag, expected] of [
    ['?', '🚀', true], ['??', '🚀', false], ['v?', 'v界', true], ['v*界', 'v🚀界', true],
    ['?', 'e\u0301', false], ['??', 'e\u0301', true], ['é', 'e\u0301', false],
    ['???', '👩\u200d💻', true], ['*', 'line\nend', true],
  ]) assert.equal(matches(pattern, tag), expected);
});

test('only star, question and backslash escapes are interpreted; regex and expansion syntax are literals', () => {
  assert.equal(matches('v\\*\\?\\\\', 'v*?\\'), true);
  assert.equal(matches('v\\*', 'v123'), false);
  for (const literal of ['[ab]', '{a,b}', '(v1|v2)', '^v1.$', 'a+b', 'a/b', '!(v1)', '$(id)', '`id`']) {
    assert.equal(matches(literal, literal), true);
    assert.equal(matches(literal, 'v1'), false);
  }
  // The ? token still means one point inside text resembling an extglob.
  assert.equal(matches('?(v1)', 'x(v1)'), true);
  assert.equal(matches('?(v1)', 'v1'), false);
});

test('pattern lists use OR, preserve order/duplicates, and enforce inclusive size limits', () => {
  assert.equal(compileTagPatterns().matches('anything'), true);
  const patterns = ['v1*', 'v2?', 'v1*'];
  const compiled = compileTagPatterns(patterns);
  patterns[0] = 'changed';
  assert.deepEqual(compiled.patterns, ['v1*', 'v2?', 'v1*']);
  assert.equal(compiled.matches('v2a'), true);
  assert.equal(compiled.matches('v3'), false);
  for (const pattern of ['a', 'a'.repeat(128), '🚀'.repeat(128), '\\*'.repeat(64)]) {
    assert.ok(compileTagPatterns([pattern]));
  }
  const ten = Array.from({ length: 10 }, (_, i) => 'v' + i);
  assert.equal(compileTagPatterns(ten).matches('v9'), true);
  assert.deepEqual(parseArgs(ten.flatMap(p => ['--tag-pattern', p])).tagPatterns, ten);
  assert.deepEqual(parseArgs(['--tag-pattern=--v*', '--tag-pattern', 'v1']).tagPatterns, ['--v*', 'v1']);
});

const invalidPatterns = [
  '', 'a'.repeat(129), '🚀'.repeat(129), 'a'.repeat(257), 'v\\', 'v\\q', '\\[',
  'v\0', 'v\t', 'v\n', 'v\r', 'v\u001b', 'v\u007f', 'v\u0085', 'v\u202e',
  'v\u2066', 'v\u200f', 'v\u200b', 'v\u200d', 'v\ufeff', 'v\u2028', 'v\u2029', 'v\ud800',
];

test('invalid or oversized patterns and lists are rejected without reflecting input', () => {
  for (const list of [null, 'v*', [null], [42], Array(1), Array(11).fill('v*'), ...invalidPatterns.map(p => [p])]) {
    assert.throws(() => compileTagPatterns(list), { code: 'usage' });
  }
  assert.throws(() => compileTagPatterns(['private-sentinel\\q']), error => error.code === 'usage' && !error.message.includes('private-sentinel'));
});

test('bad pattern options fail before config, token access or requests, preserving safe usage output', async () => {
  let envReads = 0, requests = 0;
  for (const args of [
    ...invalidPatterns.map(p => ['--tag-pattern', p]), ['--tag-pattern'], ['--tag-pattern', '--demo'],
    ['--tag-pattern='], ['--tag-pattern', 'private-sentinel\\q'],
    Array(11).fill(['--tag-pattern', 'v*']).flat(),
  ]) {
    let stdout = '', stderr = '';
    const code = await runCli(['--format', 'json', '--config', '/missing-private-sentinel.json', ...args], {
      env: new Proxy({}, { get() { envReads++; throw new Error('Forbidden environment read'); } }),
      fetchImpl: () => { requests++; throw new Error('Forbidden request'); },
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    });
    assert.equal(code, 2); assert.equal(stdout, ''); assert.match(stderr, /^usage:/);
    assert.ok(!stderr.includes('private-sentinel'));
    for (const pattern of args.filter(p => p.length > 10 && !p.startsWith('--'))) assert.ok(!stderr.includes(pattern));
  }
  await assert.rejects(collectReport(validateConfig({ repositories: ['demo/one'] }), {
    tagPatterns: ['bad\\q'], fetchImpl: () => { requests++; },
  }), { code: 'usage' });
  assert.equal(envReads, 0); assert.equal(requests, 0);
});

test('bounded worst-case glob families are correct without backtracking timing assumptions', () => {
  const tag = 'a'.repeat(1023) + 'b';
  assert.equal(matches('*a'.repeat(63) + '*b', tag), true); // Exactly 128 code points.
  assert.equal(matches('*a'.repeat(63) + '*c', tag), false);
  assert.equal(matches('?'.repeat(127) + '*', tag), true);
  assert.equal(matches('?'.repeat(128), tag), false);
  assert.equal(matches('*'.repeat(128), tag), true);
  const patterns = Array.from({ length: 10 }, (_, i) => '*a'.repeat(63) + '*' + (i === 9 ? 'b' : 'c'));
  assert.equal(compileTagPatterns(patterns).matches(tag), true);
  assert.equal(compileTagPatterns(patterns.slice(0, 9)).matches(tag), false);
});

test('selection sees original tags before truncation, whitespace cleanup, controls or redaction', () => {
  const long = 'v' + 'x'.repeat(220) + '-tail';
  const records = [release(1, long), release(2, ' v1  beta '), release(3, 'v1\u202ebeta'), release(4, 'private-sentinel')];
  const selected = normalizeReleases(records, 'demo/one', false, 'private-sentinel', compileTagPatterns(['*tail', ' v1  beta ', 'v1?beta', 'private-sentinel']).matches);
  assert.deepEqual(selected.releases.map(r => r.id), [1, 2, 3, 4]);
  assert.equal(selected.releases[0].tag.length, 200);
  assert.equal(selected.releases[1].tag, 'v1 beta');
  assert.equal(selected.releases[2].tag, 'v1 beta');
  assert.equal(selected.releases[3].tag, '[REDACTED]');
  assert.ok(!JSON.stringify(selected).includes(long));
  assert.deepEqual(Object.keys(selected.releases[0]).sort(), ['repository', 'id', 'name', 'tag', 'publishedAt', 'prerelease', 'url', 'digest'].sort());
  assert.equal(normalizeReleases(records, 'demo/one', false, '', compileTagPatterns([long.slice(0, 100), 'v1 beta', '[REDACTED]']).matches).releases.length, 0);
});

test('validation and duplicate detection precede tag filtering, including nonmatching first copies', () => {
  const result = normalizeReleases([
    release(1, 'other'), release(1, 'wanted'), release(2, 'other', { body: 7 }),
    release(3, 'wanted', { draft: true }), release(4, 'wanted', { prerelease: true }), release(5, 'wanted'),
  ], 'demo/one', false, '', compileTagPatterns(['wanted']).matches);
  assert.equal(result.invalidCount, 1); assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.releases.map(r => r.id), [5]);
});

test('fake API filtering composes tag OR with dates and prerelease policy before the display limit', async () => {
  const config = validateConfig({ repositories: ['demo/one'], limit: 1, includePrereleases: true });
  const report = await collectReport(config, {
    tagPatterns: ['v1*', 'v2*'], since: '2026-09-29T12:00:00Z', until: '2026-09-29T13:00:00Z',
    fetchImpl: async url => {
      assert.equal(url, 'https://api.github.com/repos/demo/one/releases?per_page=100&page=1');
      return new Response(JSON.stringify([
        release(1, 'v1.0'), release(2, 'v2.0-rc', { prerelease: true }), release(3, 'v3.0'),
        release(4, 'v1.1', { published_at: '2026-09-29T14:00:00Z' }),
      ]), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(report.complete, true);
  assert.deepEqual(report.releases.map(r => r.id), [2]);
  assert.deepEqual(report.scope.tagPatterns, ['v1*', 'v2*']);
  assert.equal(report.repositories[0].matchingReleases, 2);
  assert.equal(report.repositories[0].selectionLimited, true);
});

test('new scope fields and original tag matching remain safe when a pattern equals the configured token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'release-radar-pattern-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ repositories: ['demo/one'] }));
  for (const format of ['json', 'table']) {
    let stdout = '', stderr = '';
    const code = await runCli(['--config', path, '--format', format, '--tag-pattern', 'private-sentinel'], {
      env: { GITHUB_TOKEN: 'private-sentinel' },
      fetchImpl: async () => new Response(JSON.stringify([release(1, 'private-sentinel')]), { headers: { 'content-type': 'application/json' } }),
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 0); assert.equal(stderr, ''); assert.ok(!stdout.includes('private-sentinel'));
    if (format === 'json') {
      const report = JSON.parse(stdout);
      assert.deepEqual(report.scope.tagPatterns, ['[REDACTED]']);
      assert.equal(report.releases[0].tag, '[REDACTED]');
    } else assert.match(stdout, /Tag filter.*REDACTED/);
  }
});

test('real CLI supports quoted globs, repeated OR patterns, empty selections and unchanged defaults', () => {
  const bin = new URL('../bin/crypto-release-radar.js', import.meta.url).pathname;
  for (const [extra, expected, patterns] of [
    [[], [201, 101, 200], []],
    [['--tag-pattern', 'v0.?*'], [201, 200], ['v0.?*']],
    [['--tag-pattern', 'v0.4.0', '--tag-pattern=v1.*', '--include-prereleases', '--limit', '1'], [102, 201], ['v0.4.0', 'v1.*']],
    [['--tag-pattern', 'v1.*', '--since', '2026-09-29T00:00:00Z', '--until', '2026-09-29T23:59:59.999Z'], [101], ['v1.*']],
    [['--tag-pattern', 'V*'], [], ['V*']],
  ]) {
    for (const format of ['json', 'table']) {
      const result = spawnSync(process.execPath, [bin, '--demo', '--format', format, ...extra], { encoding: 'utf8' });
      assert.equal(result.status, 0); assert.equal(result.stderr, '');
      if (format === 'json') {
        const report = JSON.parse(result.stdout);
        assert.deepEqual(report.releases.map(r => r.id), expected);
        assert.deepEqual(report.scope.tagPatterns, patterns);
      } else {
        assert.match(result.stdout, patterns.length ? /Tag filter \(OR, whole original tag\):/ : /Tag filter: none/);
        assert.ok(result.stdout.includes(expected.length + ' selected releases'));
      }
    }
  }
  const bad = spawnSync(process.execPath, [bin, '--demo', '--tag-pattern', 'private-sentinel\\q'], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /^usage:/);
  assert.ok(!bad.stderr.includes('private-sentinel'));
});
