import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig, DEFAULTS } from '../src/config.js';
import { parseArgs } from '../src/cli.js';

test('config applies bounded defaults and copies the explicit repository list', () => {
  const input = { repositories: ['bitcoin/bitcoin', 'ethereum/go-ethereum'] };
  const config = validateConfig(input);
  assert.deepEqual(config, { ...DEFAULTS, ...input });
  config.repositories.push('owner/repo');
  assert.equal(input.repositories.length, 2);
});

for (const [label, value] of [
  ['null', null], ['array', []], ['missing repositories', {}],
  ['empty repositories', { repositories: [] }],
  ['too many repositories', { repositories: Array.from({ length: 21 }, (_, i) => `owner/repo${i}`) }],
  ['URL', { repositories: ['https://github.com/a/b'] }],
  ['path traversal', { repositories: ['a/..'] }],
  ['query injection', { repositories: ['a/b?token=secret'] }],
  ['newline injection', { repositories: ['a/b\n'] }],
  ['non-string repository', { repositories: [42] }],
  ['duplicates', { repositories: ['Owner/Repo', 'owner/repo'] }],
  ['unbounded limit', { repositories: ['a/b'], limit: 100 }],
  ['fractional pages', { repositories: ['a/b'], maxPages: 1.5 }],
  ['unbounded timeout', { repositories: ['a/b'], timeoutMs: 30001 }],
  ['wrong boolean', { repositories: ['a/b'], includePrereleases: 'false' }],
  ['embedded token', { repositories: ['a/b'], token: 'do-not-output' }],
  ['alternate host', { repositories: ['a/b'], apiUrl: 'https://example.org' }],
  ['CLI-only since', { repositories: ['a/b'], since: '2026-09-29T00:00:00Z' }],
  ['CLI-only until', { repositories: ['a/b'], until: '2026-09-30T00:00:00Z' }],
]) {
  test(`config rejects ${label} without reflecting input`, () => {
    assert.throws(() => validateConfig(value), (error) => error.code === 'invalid_config' && !error.message.includes('do-not-output'));
  });
}

test('CLI parses documented options', () => {
  assert.deepEqual(parseArgs(['--config', 'repos.json', '--format', 'json', '--limit', '4', '--include-prereleases']), {
    configPath: 'repos.json', format: 'json', demo: false, limit: 4, includePrereleases: true,
  });
});

for (const args of [
  ['--token', 'secret'], ['--config'], ['--format', 'xml'], ['--limit', '1e2'],
  ['--limit', '0'], ['--demo', '--demo'], ['--demo', '--config', 'x'], ['--config', '--demo'], ['positional'],
]) {
  test(`CLI rejects invalid arguments ${args[0]} ${args[1] ?? ''}`, () => {
    assert.throws(() => parseArgs(args), { code: 'usage' });
  });
}
