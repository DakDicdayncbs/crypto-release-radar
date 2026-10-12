import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { consumeJson } from '../examples/consume-json.js';
import { compileReportSubset } from '../test-support/report-schema.js';
import { fixtures } from '../test-support/report-corpus.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const consumer = fileURLToPath(new URL('../examples/consume-json.js', import.meta.url));
const bin = fileURLToPath(new URL('../bin/crypto-release-radar.js', import.meta.url));
const accepts = compileReportSubset(JSON.parse(await fs.readFile(new URL('../schemas/report-v1.schema.json', import.meta.url), 'utf8')));
const now = () => new Date('2026-10-04T12:00:00.000Z');
async function run(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { env: {}, now, ...options,
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr };
}
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const raw = (repo, id = 1, extra = {}) => ({ id, name: 'Release 🚀', tag_name: 'v1',
  published_at: '2026-10-03T12:00:00Z', prerelease: false, draft: false,
  html_url: `https://github.com/${repo}/releases/tag/v1`, body: 'Synthetic notes.', ...extra });
const noNetwork = () => assert.fail('No network expected');
const noEnv = new Proxy({}, { get() { assert.fail('No environment access expected'); } });
async function files(t, config = { repositories: ['example/one', 'example/two', 'example/three'], maxPages: 3 }) {
  const dir = await fs.realpath(await fs.mkdtemp(tmpdir() + '/radar-json-contract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = dir + '/config.json'; await fs.writeFile(path, JSON.stringify(config));
  return { dir, path, output: dir + '/report.json' };
}
const consume = input => spawnSync(process.execPath, [consumer], { cwd: root, input, encoding: 'utf8', timeout: 10000 });
function checked(result, kind = 'report') {
  const value = JSON.parse(result.stdout);
  assert.equal(accepts(value), true);
  assert.deepEqual(consumeJson(value), { kind, data: value });
  assert.equal(result.stdout, JSON.stringify(value, null, 2) + '\n');
  const child = consume(result.stdout);
  assert.equal(child.status, result.code); assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { kind, data: value });
  return value;
}

test('real demo JSON and atomic file bytes validate and feed the independent stdin consumer', async t => {
  const f = await files(t), args = ['--demo', '--format', 'json', '--include-prereleases', '--total-limit', '1'];
  const result = await run(args, { env: noEnv, fetchImpl: noNetwork });
  assert.equal(result.code, 0);
  const value = checked(result);
  assert.equal(value.mode, 'demo'); assert.equal(value.complete, true);
  assert.ok(value.repositories.every(r => r.requested === false && r.pagesFetched === 0));
  assert.equal(value.display.globalSelectionLimited, true);
  const saved = await run([...args, '--output', f.output], { env: noEnv, fetchImpl: noNetwork });
  assert.deepEqual(saved, { code: 0, stdout: '', stderr: '' });
  const bytes = await fs.readFile(f.output);
  assert.deepEqual(bytes, Buffer.from(result.stdout));
  const fromFile = consume(bytes), fromStdout = consume(result.stdout);
  assert.equal(fromFile.status, fromStdout.status);
  assert.equal(fromFile.stdout, fromStdout.stdout); assert.equal(fromFile.stderr, fromStdout.stderr);
});

test('real collector fake-API complete/empty/partial/failed/skipped JSON retains states and identical file bytes', async t => {
  const f = await files(t);
  for (const state of ['complete', 'empty', 'partial', 'failed', 'skipped']) {
    const calls = [];
    const fetchImpl = async url => {
      const u = new URL(url), repo = u.pathname.split('/').slice(2, 4).join('/');
      calls.push(url);
      if (state === 'skipped') return new Response('', { status: 429, headers: { 'retry-after': '0', 'x-ratelimit-reset': '0' } });
      if (state === 'failed' || (state === 'partial' && u.searchParams.get('page') === '2')) return new Response('private-remote-error', { status: 500 });
      const response = json(state === 'empty' ? [] : [raw(repo)]);
      if (state === 'partial' && repo === 'example/one') response.headers.set('link', '<https://api.github.com/repos/example/one/releases?per_page=100&page=2>; rel="next"');
      return response;
    };
    const args = ['--config', f.path, '--format', 'json', '--total-limit', '1'];
    const result = await run(args, { fetchImpl }), trace = calls.splice(0);
    assert.equal(result.code, ['complete', 'empty'].includes(state) ? 0 : 1);
    const value = checked(result);
    assert.equal(value.complete, result.code === 0); assert.equal(value.repositories.length, 3);
    assert.ok(!result.stdout.includes('private-remote-error'));
    if (state === 'partial') { assert.equal(value.repositories[0].complete, false); assert.equal(value.repositories[1].complete, true); assert.equal(value.releases.length, 1); }
    if (state === 'skipped') { assert.equal(trace.length, 1); assert.equal(value.issues[0].retryAfterSeconds, 0); assert.equal(value.repositories[1].requested, false); }
    if (['empty', 'failed', 'skipped'].includes(state)) assert.equal(value.releases.length, 0);
    const saved = await run([...args, '--output', f.output], { fetchImpl });
    assert.equal(saved.code, result.code); assert.equal(saved.stdout, ''); assert.equal(saved.stderr, result.stderr);
    assert.deepEqual(calls, trace);
    const bytes = await fs.readFile(f.output);
    assert.deepEqual(bytes, Buffer.from(result.stdout));
    assert.deepEqual(JSON.parse(consume(bytes).stdout), { kind: 'report', data: value });
    await fs.unlink(f.output);
  }
});

test('groups, mixed policies, dates, raw tag filters, both display limits and UTC/large-ID ordering interoperate', async t => {
  const f = await files(t, { repositories: ['example/unused'], maxPages: 2, groups: {
    stable: [{ slug: 'example/a', limit: 1, includePrereleases: false }],
    preview: [{ slug: 'example/z', limit: 2, includePrereleases: true }],
  } });
  const calls = [], fetchImpl = async url => {
    calls.push(url);
    return url.includes('/a/') ? json([raw('example/a', 4), raw('example/a', 3), raw('example/a', 2, { prerelease: true })])
      : json([raw('example/z', 9007199254740990, { published_at: '2026-10-04T15:00:00+03:00', prerelease: true }),
        raw('example/z', 9007199254740991, { published_at: '2026-10-04T12:00:00Z' }), raw('example/z', 5),
        raw('example/z', 6, { tag_name: 'excluded' })]);
  };
  const result = await run(['--config', f.path, '--format', 'json', '--group', 'stable', '--group', 'preview',
    '--since', '2026-10-02T00:00:00Z', '--until', '2026-10-04T12:00:00Z', '--tag-pattern', 'v*', '--total-limit', '2'], { fetchImpl });
  const value = checked(result);
  assert.equal(result.code, 0); assert.equal(calls.length, 2);
  assert.deepEqual(value.scope.groups, ['stable', 'preview']);
  assert.equal(value.scope.limitPerRepository, null); assert.equal(value.scope.includePrereleases, null);
  assert.equal(value.repositories[0].returnedReleases, 0); assert.equal(value.repositories[0].globalSelectionLimited, true);
  assert.deepEqual(value.releases.map(r => r.id), [9007199254740991, 9007199254740990]);
  assert.deepEqual(value.display, { matchingReleases: 5, selectedReleases: 3, returnedReleases: 2,
    perRepositoryHiddenReleases: 2, globallyHiddenReleases: 1, globalSelectionLimited: true });
});

test('only parsed JSON stdout mode emits fatal envelopes; usage, validation and file failures do not', async t => {
  const f = await files(t);
  const missing = f.dir + '/missing';
  const fatal = await run(['--config', missing, '--format', 'json'], { env: noEnv, fetchImpl: noNetwork });
  assert.equal(fatal.code, 2); assert.deepEqual(checked(fatal, 'fatal'), fixtures.fatal);
  for (const args of [
    ['--format', 'json', '--unknown'], ['--format', 'json', '--limit', '0'],
    ['--validate-config', '--format', 'json'], ['--validate-config', '--config', missing],
    ['--config', missing, '--format', 'json', '--output', f.output],
  ]) {
    const result = await run(args, { env: noEnv, fetchImpl: noNetwork });
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr);
  }
  await fs.writeFile(f.output, 'PREVIOUS');
  const failedWrite = await run(['--demo', '--format', 'json', '--output', f.output, '--overwrite'],
    { env: noEnv, fetchImpl: noNetwork, outputIo: { ...fs, rename: async () => { throw new Error('private-write-error'); } } });
  assert.equal(failedWrite.code, 2); assert.equal(failedWrite.stdout, '');
  assert.equal(await fs.readFile(f.output, 'utf8'), 'PREVIOUS'); assert.ok(!failedWrite.stderr.includes('private-write-error'));
  for (const args of [['--help', '--format', 'json'], ['--version', '--format', 'json'], ['--validate-config', '--config', f.path]]) {
    const result = await run(args, { env: noEnv, fetchImpl: noNetwork });
    assert.equal(result.code, 0); assert.throws(() => consumeJson(JSON.parse(result.stdout)));
  }
});

test('post-normalization redaction may change every string class and exceed pre-redaction lengths', async t => {
  const f = await files(t, { repositories: ['example/one'], groups: { example: ['example/one'] } });
  for (const token of ['live', '2026', 'github', 'example', '1', 'true', 'false', 'rate', 'R']) {
    const result = await run(['--config', f.path, '--format', 'json', '--group', 'example', '--tag-pattern', '*',
      '--since', '2026-01-01T00:00:00Z', '--until', '2026-12-31T00:00:00Z', '--total-limit', '1'], {
      env: { GITHUB_TOKEN: token }, fetchImpl: async () => token === 'rate'
        ? new Response('', { status: 429, headers: { 'retry-after': '9999999', 'x-ratelimit-reset': '999999999999' } })
        : json([raw('example/one', 1, { name: 'R'.repeat(200), body: 'R'.repeat(500), tag_name: 'v1' })]),
    });
    const value = checked(result);
    assert.equal(value.schemaVersion, 1); assert.equal(value.scope.totalLimit, 1);
    assert.equal(value.scope.includePrereleases, false); assert.equal(value.repositories[0].requested, true);
    if (token === 'live') assert.equal(value.mode, '[REDACTED]');
    if (token === '2026') { assert.ok(value.generatedAt.includes('[REDACTED]')); assert.ok(value.scope.since.includes('[REDACTED]')); assert.ok(value.releases[0].publishedAt.includes('[REDACTED]')); }
    if (token === 'github') assert.ok(value.releases[0].url.includes('[REDACTED]'));
    if (token === 'example') { assert.equal(value.scope.groups[0], '[REDACTED]'); assert.equal(value.repositories[0].repository, '[REDACTED]/one'); }
    if (token === 'rate') { assert.equal(value.issues[0].code, '[REDACTED]_limited'); assert.equal(value.issues[0].retryAfterSeconds, 9999999); assert.ok(value.issues[0].resetAt.startsWith('+')); }
    if (token === 'R') { assert.ok(value.releases[0].name.length > 200); assert.ok(value.releases[0].digest.text.length > 280); }
  }
});

test('executable demo/fake API exit 0/1 and fatal 2 are consumable without external access', async t => {
  const f = await files(t, { repositories: ['example/one'] });
  for (const [args, preload, status, kind] of [
    [['--demo', '--format', 'json'], 'globalThis.fetch = () => { throw new Error("network forbidden"); };', 0, 'report'],
    [['--config', f.path, '--format', 'json'], 'globalThis.fetch = async () => new Response("[]", {headers:{"content-type":"application/json"}});', 0, 'report'],
    [['--config', f.path, '--format', 'json'], 'globalThis.fetch = async () => new Response("private-error", {status:500});', 1, 'report'],
    [['--config', f.dir + '/missing', '--format', 'json'], 'globalThis.fetch = () => { throw new Error("network forbidden"); };', 2, 'fatal'],
  ]) {
    const child = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), bin, ...args],
      { cwd: root, env: { ...process.env, GITHUB_TOKEN: '' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, status); checked({ ...child, code: status }, kind);
    assert.ok(!child.stdout.includes('private-error')); assert.ok(!child.stderr.includes('private-error'));
  }
});

test('example stdin consumer rejects malformed UTF-8/JSON and unsupported versions without reflecting input', () => {
  for (const input of [Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), '', '{private-input',
    '{}', JSON.stringify({ ...fixtures.current, schemaVersion: 2 }), JSON.stringify({ ...fixtures.fatal, complete: true }),
    JSON.stringify(fixtures.current).replace('9007199254740991', '9007199254740992')]) {
    const result = consume(input);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unsupported or invalid JSON report.\n');
  }
  const extraArg = spawnSync(process.execPath, [consumer, '--input', 'private-path'], { cwd: root, input: '{}', encoding: 'utf8', timeout: 10000 });
  assert.equal(extraArg.status, 2); assert.equal(extraArg.stdout, ''); assert.equal(extraArg.stderr, 'Unsupported or invalid JSON report.\n');
});
