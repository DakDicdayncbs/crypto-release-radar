import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { readConfig, validateConfig } from '../src/config.js';
import { MAX_CONFIG_BYTES } from '../src/config-file.js';
import { runCli } from '../src/cli.js';

const base = { repositories: ['demo/base'] };
const secret = 'private-sentinel';
const cases = [
  [null, '$'],
  [{ ...base, [secret + '\n\u202e']: secret }, '$'],
  [{}, '$.repositories'],
  [{ repositories: [] }, '$.repositories'],
  [{ repositories: Array(21).fill('a/b') }, '$.repositories'],
  [{ repositories: [null] }, '$.repositories[0]'],
  [{ repositories: [{ limit: 1 }] }, '$.repositories[0].slug'],
  [{ repositories: [{ slug: 'a/b', [secret + '\r\n']: secret }] }, '$.repositories[0]'],
  [{ repositories: [secret] }, '$.repositories[0]'],
  [{ repositories: [{ slug: secret + '\u0000' }] }, '$.repositories[0].slug'],
  [{ repositories: [{ slug: 'a/b', limit: secret }] }, '$.repositories[0].limit'],
  [{ repositories: [{ slug: 'a/b', includePrereleases: secret }] }, '$.repositories[0].includePrereleases'],
  [{ repositories: ['A/B', 'a/b'] }, '$.repositories[1]'],
  [{ repositories: ['A/B', { slug: 'a/b', limit: 2 }] }, '$.repositories[1].slug'],
  [{ ...base, limit: 51 }, '$.limit'],
  [{ ...base, maxPages: null }, '$.maxPages'],
  [{ ...base, timeoutMs: 99 }, '$.timeoutMs'],
  [{ ...base, includePrereleases: secret }, '$.includePrereleases'],
  [{ ...base, groups: null }, '$.groups'],
  [{ ...base, groups: Object.fromEntries(Array.from({ length: 11 }, (_, i) => ['g' + i, ['a/b']])) }, '$.groups'],
  [{ ...base, groups: { valid: ['a/b'], [secret + '\n']: ['a/b'] } }, '$.groups[1].name'],
  [{ ...base, groups: { valid: ['a/b'], [secret]: [] } }, '$.groups[1].entries'],
  [{ ...base, groups: { valid: ['a/b'], [secret]: [null] } }, '$.groups[1].entries[0]'],
  [{ ...base, groups: { valid: ['a/b'], [secret]: [{}] } }, '$.groups[1].entries[0].slug'],
  [{ ...base, groups: { valid: ['a/b'], [secret]: [{ slug: secret }] } }, '$.groups[1].entries[0].slug'],
  [{ ...base, groups: { valid: ['a/b'], [secret]: [{ slug: 'a/b', [secret]: secret }] } }, '$.groups[1].entries[0]'],
  [{ ...base, groups: { valid: ['a/b'], [secret]: ['a/b', { slug: 'a/c', limit: 0 }] } }, '$.groups[1].entries[1].limit'],
  [{ ...base, groups: { valid: ['a/b'], [secret]: [{ slug: 'a/b', includePrereleases: secret }] } }, '$.groups[1].entries[0].includePrereleases'],
  [{ ...base, groups: { valid: ['a/b'], [secret]: ['A/B', { slug: 'a/b' }] } }, '$.groups[1].entries[1].slug'],
  [{ ...base, groups: { constructor: [{ slug: 'a/b', limit: secret }] } }, '$.groups[0].entries[0].limit'],
];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-locations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, secret + '.json') };
}
async function compareModes(path, expected) {
  for (const args of [
    ['--validate-config'], ['--limit', '4', '--include-prereleases'],
    ['--format', 'json', '--limit', '4', '--include-prereleases'],
  ]) {
    let stdout = '', stderr = '', envReads = 0, requests = 0, reports = 0;
    const code = await runCli(['--config', path, ...args], {
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
      env: new Proxy({}, { get() { envReads++; throw new Error(secret); } }),
      fetchImpl: () => { requests++; throw new Error(secret); },
      now: () => { reports++; throw new Error(secret); },
    });
    assert.equal(code, 2); assert.equal(envReads, 0); assert.equal(requests, 0); assert.equal(reports, 0);
    assert.equal(stderr, `${expected.code}: ${expected.message}\n`);
    if (args.includes('json')) {
      assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, complete: false, releases: [], issues: [expected] });
    } else assert.equal(stdout, '');
    assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u202e]/u.test(stdout + stderr));
  }
}

test('semantic errors identify safe schema locations in memory, files and both CLI modes before overrides/token', async t => {
  const { path } = await fixture(t);
  for (const [value, location] of cases) {
    let message;
    assert.throws(() => validateConfig(value), error => {
      assert.equal(error.code, 'invalid_config');
      assert.ok(error.message.startsWith(location + ': '), error.message);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes('constructor'));
      message = error.message;
      return true;
    });
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readConfig(path), { code: 'invalid_config', message });
    await compareModes(path, { code: 'invalid_config', message });
  }
});

test('group ordinals follow parsed own-property enumeration; locations are not JSON source positions', async t => {
  const { path } = await fixture(t);
  const text = '{\r\n"repositories":["a/b"],"groups":{"private-sentinel":["a/b"],"2":["a/b"]}}';
  await writeFile(path, text);
  await assert.rejects(readConfig(path), error => error.code === 'invalid_config' && error.message.startsWith('$.groups[0].name: '));
  // Escaped fixed keys localize to the same decoded schema field, without offsets.
  await writeFile(path, '{"repositories":["a/b"],"\\u006cimit":"é🚀private-sentinel"}\r\n');
  await assert.rejects(readConfig(path), error => error.code === 'invalid_config' && error.message.startsWith('$.limit: ') && !error.message.includes(secret));
  let nested = {};
  for (let i = 0; i < 10000; i++) nested = { child: nested };
  assert.throws(() => validateConfig({ ...base, limit: nested }), error => error.code === 'invalid_config' && error.message.startsWith('$.limit: '));
});

test('read, syntax, encoding, byte and depth failures preserve scan JSON envelopes and offline validation', async t => {
  const { path, dir } = await fixture(t);
  const resources = [
    ['{"private-sentinel":}', 'config_syntax', 'Config is not valid JSON.'],
    [Buffer.from([0xff]), 'config_encoding', 'Config must be UTF-8 without a byte-order mark.'],
    [' '.repeat(MAX_CONFIG_BYTES + 1), 'config_size', 'Config exceeds the 131072-byte limit.'],
    ['['.repeat(9) + '"private-sentinel"' + ']'.repeat(9), 'config_depth', 'Config exceeds the maximum nesting depth of 8.'],
  ];
  for (const [content, code, message] of resources) {
    await writeFile(path, content);
    await compareModes(path, { code, message });
  }
  const readError = { code: 'config_read', message: 'Cannot read config file. Pass --config with a readable JSON file.' };
  await compareModes(dir, readError);
  await compareModes(join(dir, secret + '-missing'), readError);
});
