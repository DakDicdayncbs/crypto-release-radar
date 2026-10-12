import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runCli, parseArgs, HELP } from '../src/cli.js';
import { validateConfig } from '../src/config.js';
import { compileReportSubset } from '../test-support/report-schema.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = fileURLToPath(new URL('../bin/crypto-release-radar.js', import.meta.url));
const demo = fileURLToPath(new URL('../fixtures/demo-releases.json', import.meta.url));
const accepts = compileReportSubset(JSON.parse(await fs.readFile(new URL('../schemas/snapshot-v1.schema.json', import.meta.url), 'utf8')));
const formats = ['table', 'json', 'markdown', 'csv', 'ndjson'];
const now = () => new Date('2026-10-12T08:30:00.000Z');
const blocked = { env: new Proxy({}, { get() { assert.fail('No token access'); } }), fetchImpl() { assert.fail('No network'); } };
const run = async (args, options = {}) => {
  let stdout = '', stderr = '';
  const code = await runCli(args, { env: {}, now, ...options,
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr };
};
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const release = (repo, id = 1, extra = {}) => ({ id, name: 'Synthetic 🚀', tag_name: 'v1',
  published_at: '2026-10-04T12:00:00Z', html_url: `https://github.com/${repo}/releases/tag/v1`,
  body: 'Synthetic notes.', draft: false, prerelease: false, ...extra });
async function fixture(t, value = { repositories: ['example/one', 'example/two'], maxPages: 2 }) {
  const dir = await fs.realpath(await fs.mkdtemp(tmpdir() + '/radar-snapshot-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = dir + '/config.json', output = dir + '/test.radar-snapshot.json';
  await fs.writeFile(config, JSON.stringify(value));
  return { dir, config, output };
}
const saved = async path => {
  const value = JSON.parse(await fs.readFile(path, 'utf8')); assert.equal(accepts(value), true); return value;
};

test('snapshot arguments, suffix, conflicts and config keys fail before I/O, token or API', async () => {
  const s = 'test.radar-snapshot.json';
  for (const args of [['--snapshot'], ['--snapshot', ''], ['--snapshot', ' '], ['--snapshot', 'report.json'],
    ['--snapshot', 'secret\n' + s], ['--snapshot', s + '/'], ['--snapshot=' + s],
    ['--snapshot', s, '--snapshot', s], ['--snapshot', s, '--output', 'x'], ['--output', 'x', '--snapshot', s],
    ['--snapshot', s, '--validate-config'], ['--validate-config', '--snapshot', s], ['--snapshot', s, '--overwrite=true'],
    ['--snapshot', s, '--overwrite', 'true'], ['--snapshot', s, '--format', 'snapshot']]) {
    const result = await run(['--format', 'json', ...args], { ...blocked, outputIo: new Proxy({}, { get() { assert.fail('No file I/O'); } }) });
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /^usage:/);
    assert.ok(!result.stderr.includes('secret'));
  }
  assert.equal(parseArgs(['--overwrite', '--snapshot', './ space ' + s]).snapshotPath, './ space ' + s);
  for (const key of ['snapshot', 'snapshotPath', 'snapshotVersion', 'overwrite']) {
    assert.throws(() => validateConfig({ repositories: ['example/one'], [key]: s }), { code: 'invalid_config' });
  }
});

test('help/version do not inspect or create snapshot destinations', async t => {
  const f = await fixture(t), outputIo = new Proxy({}, { get() { assert.fail('No file I/O'); } });
  assert.deepEqual(await run(['--snapshot', f.output, '--overwrite', '--help'], { ...blocked, outputIo }), { code: 0, stdout: HELP, stderr: '' });
  assert.deepEqual(await run(['--snapshot', f.output, '--version'], { ...blocked, outputIo }), { code: 0, stdout: '0.1.0\n', stderr: '' });
  assert.deepEqual(await fs.readdir(f.dir), ['config.json']);
});

test('snapshot simple destination refusals and input aliases precede token/API and preserve files', async t => {
  const f = await fixture(t), before = await fs.readFile(f.config);
  await fs.writeFile(f.output, 'OLD');
  await fs.link(f.config, f.dir + '/alias.radar-snapshot.json');
  await fs.symlink(f.dir, f.dir + '/parent');
  await fs.symlink(f.output, f.dir + '/symlink.radar-snapshot.json');
  await fs.mkdir(f.dir + '/directory.radar-snapshot.json');
  const fifo = f.dir + '/fifo.radar-snapshot.json';
  assert.equal(spawnSync('mkfifo', [fifo], { cwd: root }).status, 0);
  const namedInput = f.dir + '/input.radar-snapshot.json'; await fs.link(f.config, namedInput);
  for (const [config, path, flags, code] of [
    [f.config, f.output, [], 'output_exists'], [f.config, f.dir + '/alias.radar-snapshot.json', ['--overwrite'], 'output_input'],
    [namedInput, namedInput, ['--overwrite'], 'output_input'],
    [namedInput, f.dir + '/parent/input.radar-snapshot.json', ['--overwrite'], 'output_input'],
    [f.config, f.dir + '/symlink.radar-snapshot.json', ['--overwrite'], 'output_type'],
    [f.config, f.dir + '/directory.radar-snapshot.json', [], 'output_type'], [f.config, fifo, ['--overwrite'], 'output_type'],
    [f.config, f.dir + '/missing/test.radar-snapshot.json', [], 'output_path'],
  ]) {
    const result = await run(['--config', config, '--format', 'json', '--snapshot', path, ...flags], blocked);
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.startsWith(code + ':'));
    assert.ok(!result.stderr.includes(f.dir));
  }
  assert.deepEqual(await fs.readFile(f.config), before); assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD');
  await fs.link(demo, f.dir + '/demo.radar-snapshot.json');
  const refused = await run(['--demo', '--snapshot', f.dir + '/demo.radar-snapshot.json', '--overwrite'], blocked);
  assert.equal(refused.code, 2); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /^output_input:/);
});

test('demo snapshots are format-independent, private, offline, and preserve ordinary stdout bytes and acquisition time', async t => {
  const f = await fixture(t);
  let bytes;
  for (const format of formats) {
    const args = ['--demo', '--format', format, '--include-prereleases', '--total-limit', '1'];
    const before = await run(args, blocked);
    const result = await run([...args, '--snapshot', f.output], blocked);
    assert.deepEqual(result, before); assert.equal(result.code, 0);
    const snapshot = await saved(f.output), currentBytes = await fs.readFile(f.output);
    assert.equal(snapshot.synthetic, true); assert.equal(snapshot.report.generatedAt, now().toISOString());
    assert.ok(snapshot.report.repositories.every(r => r.requested === false));
    if (format === 'json') assert.deepEqual(snapshot.report, JSON.parse(result.stdout));
    if (bytes) assert.deepEqual(currentBytes, bytes); else bytes = currentBytes;
    assert.equal((await fs.stat(f.output)).mode & 0o777, 0o600);
    await fs.unlink(f.output);
  }
  const r = await run(['--demo', '--format', 'json', '--snapshot', f.output], blocked);
  const old = await fs.readFile(f.output); await fs.link(f.output, f.dir + '/old-copy');
  const replaced = await run(['--demo', '--format', 'json', '--snapshot', f.output, '--overwrite', '--total-limit', '1'], blocked);
  assert.equal(r.code, 0); assert.equal(replaced.code, 0);
  assert.deepEqual(await fs.readFile(f.dir + '/old-copy'), old); assert.equal((await saved(f.output)).report.releases.length, 1);
});

test('normal/empty/partial/all-failed/skipped fake API snapshots preserve all five outputs, requests and exit codes', async t => {
  const f = await fixture(t);
  for (const state of ['normal', 'empty', 'partial', 'failed', 'skipped']) {
    const calls = [], fetchImpl = async url => {
      calls.push(url);
      const repo = url.includes('/two/') ? 'example/two' : 'example/one';
      if (state === 'skipped') return new Response('RAW_ERROR', { status: 429, headers: { 'retry-after': '0' } });
      if (state === 'failed' || (state === 'partial' && url.endsWith('page=2'))) return new Response('RAW_ERROR', { status: 500 });
      const res = response(state === 'empty' ? [] : [release(repo)]);
      if (state === 'partial' && repo === 'example/one') res.headers.set('link', '<https://api.github.com/repos/example/one/releases?per_page=100&page=2>; rel="next"');
      return res;
    };
    const expectedReport = JSON.parse((await run(['--config', f.config, '--format', 'json'], { fetchImpl })).stdout);
    calls.length = 0;
    for (const format of formats) {
      const args = ['--config', f.config, '--format', format];
      const before = await run(args, { fetchImpl }), trace = calls.splice(0);
      const result = await run([...args, '--snapshot', f.output], { fetchImpl });
      assert.deepEqual(result, before); assert.deepEqual(calls.splice(0), trace);
      const value = await saved(f.output);
      assert.equal(value.synthetic, false); assert.deepEqual(value.report, expectedReport);
      assert.equal(value.report.complete, ['normal', 'empty'].includes(state));
      assert.equal(result.code, value.report.complete ? 0 : 1);
      assert.ok(!(await fs.readFile(f.output, 'utf8')).includes('RAW_ERROR'));
      await fs.unlink(f.output);
    }
  }
});

test('mixed groups/policies/filters/both limits store only normalized redacted fields and preserve typed metadata', async t => {
  const token = 'private-token-sentinel';
  const f = await fixture(t, { repositories: ['example/unused'], maxPages: 2,
    groups: { stable: [{ slug: 'example/a', limit: 1, includePrereleases: false }], preview: [{ slug: 'example/z', limit: 2, includePrereleases: true }] } });
  const calls = [], fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, 'Bearer ' + token);
    return url.includes('/a/') ? response([release('example/a', 2), release('example/a', 3)])
      : response([release('example/z', Number.MAX_SAFE_INTEGER, { prerelease: true, name: token, tag_name: 'v' + token,
        html_url: 'https://github.com/example/z/releases/tag/' + token, body: '```\nRAW_ONLY\n```\n' + token,
        headers: { Authorization: token }, assets: [{ url: 'RAW_ASSET_URL' }] }), release('example/z', 4), release('example/z', 5)]);
  };
  const args = ['--config', f.config, '--format', 'json', '--group', 'stable', '--group', 'preview', '--since', '2026-10-04T00:00:00Z',
    '--until', '2026-10-04T23:59:59Z', '--tag-pattern', 'v*', '--total-limit', '2'];
  const options = { fetchImpl, env: { GITHUB_TOKEN: token } };
  const before = await run(args, options), trace = calls.splice(0);
  const result = await run([...args, '--snapshot', f.output], options);
  assert.deepEqual(result, before); assert.deepEqual(calls, trace); assert.equal(result.code, 0);
  const snapshot = await saved(f.output), text = await fs.readFile(f.output, 'utf8');
  assert.deepEqual(snapshot.report, JSON.parse(result.stdout));
  assert.equal(snapshot.report.scope.limitPerRepository, null); assert.equal(snapshot.report.scope.includePrereleases, null);
  assert.deepEqual(snapshot.report.display, { matchingReleases: 5, selectedReleases: 3, returnedReleases: 2,
    perRepositoryHiddenReleases: 2, globallyHiddenReleases: 1, globalSelectionLimited: true });
  assert.equal(snapshot.report.releases[1].id, Number.MAX_SAFE_INTEGER); // Repository ascending precedes ID tie-break.
  assert.equal(snapshot.report.releases[1].name, '[REDACTED]');
  for (const forbidden of [token, 'RAW_ONLY', 'RAW_ASSET_URL', 'api.github.com', '"body":', '"headers":', '"assets":', '"config":', '"env":']) assert.ok(!text.includes(forbidden));
});

test('redacted mode/date/link fields persist, while residual token in JSON syntax conservatively refuses the snapshot', async t => {
  const f = await fixture(t, { repositories: ['example/one'] });
  for (const token of ['live', '2026', 'github', 'true', 'R']) {
    const options = { env: { GITHUB_TOKEN: token }, fetchImpl: async () => response([release('example/one', 1, { name: 'R'.repeat(200), body: 'R'.repeat(500) })]) };
    const args = ['--config', f.config, '--format', 'json'];
    const before = await run(args, options); assert.equal(before.code, 0);
    const result = await run([...args, '--snapshot', f.output], options);
    if (['true', 'R'].includes(token)) {
      assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /^snapshot_secret:/);
      await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
    } else {
      assert.deepEqual(result, before); const value = await saved(f.output);
      assert.deepEqual(value.report, JSON.parse(before.stdout)); assert.equal(value.synthetic, false);
      await fs.unlink(f.output);
    }
  }
});

test('fatal config/token/write errors never save envelopes or print reports, and earlier scan issues survive writer failure', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'OLD');
  for (const [args, options] of [
    [['--config', f.dir + '/missing'], blocked],
    [['--config', f.config], { env: { GITHUB_TOKEN: 'bad\nprivate-sentinel' }, fetchImpl: blocked.fetchImpl }],
    [['--demo'], { ...blocked, now() { throw new Error('private-sentinel'); } }],
    [['--config', f.config], { fetchImpl: async () => new Response('private-sentinel', { status: 500 }),
      outputIo: { ...fs, rename: async () => { throw new Error('private-sentinel'); } } }],
  ]) {
    const result = await run([...args, '--format', 'json', '--snapshot', f.output, '--overwrite'], options);
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD');
    assert.ok(!result.stderr.includes('private-sentinel'));
    if (options.outputIo) { assert.match(result.stderr, /http_error:/); assert.match(result.stderr, /output_write:/); }
  }
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['config.json', 'test.radar-snapshot.json']);
});

test('late input replacement protects original and current config inode with snapshot mode', async t => {
  for (const original of [false, true]) {
    const f = await fixture(t, { repositories: ['example/one'] }), before = await fs.readFile(f.config);
    const result = await run(['--config', f.config, '--snapshot', f.output, '--overwrite', '--format', 'json'], { fetchImpl: async () => {
      await fs.rename(f.config, f.dir + '/original'); await fs.writeFile(f.config, '{"repositories":["example/new"]}');
      await fs.link(original ? f.dir + '/original' : f.config, f.output);
      return response([]);
    } });
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /^output_input:/);
    assert.deepEqual(await fs.readFile(f.dir + '/original'), before);
    assert.equal(await fs.readFile(f.config, 'utf8'), '{"repositories":["example/new"]}');
  }
});

test('synchronous stdout failure after snapshot publication reports the saved state without rollback', async t => {
  const f = await fixture(t); let stderr = '';
  const code = await runCli(['--demo', '--format', 'json', '--snapshot', f.output], { ...blocked, now,
    stdout: { write() { throw new Error('private-sentinel'); } }, stderr: { write(text) { stderr += text; } } });
  assert.equal(code, 2); assert.match(stderr, /^snapshot_stdout: Snapshot was published/);
  assert.ok(!stderr.includes('private-sentinel')); assert.equal((await saved(f.output)).synthetic, true);
});

test('a snapshot validation/secret refusal retains previously collected incomplete scan diagnostics', async t => {
  const f = await fixture(t, { repositories: ['example/one'] });
  const result = await run(['--config', f.config, '--format', 'json', '--snapshot', f.output], {
    env: { GITHUB_TOKEN: 'true' }, fetchImpl: async () => new Response('', { status: 429 }),
  });
  assert.equal(result.code, 2); assert.equal(result.stdout, '');
  assert.match(result.stderr, /rate_limited:/); assert.match(result.stderr, /snapshot_secret:/);
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('executable snapshot demo stays offline, ignores bad token env, and new snapshot/temp conventions are Git-ignored', async t => {
  const f = await fixture(t), preload = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch=()=>{throw new Error("network forbidden");};');
  const child = spawnSync(process.execPath, ['--import', preload, bin, '--demo', '--format', 'json', '--snapshot', f.output],
    { cwd: root, env: { ...process.env, GITHUB_TOKEN: 'bad\nprivate-sentinel' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0); assert.equal(child.stderr, ''); assert.deepEqual((await saved(f.output)).report, JSON.parse(child.stdout));
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root,
    input: 'local.radar-snapshot.json\nsnapshots/anything.json\n.radar-output-leftover.tmp\n', encoding: 'utf8' });
  assert.equal(ignored.status, 0); assert.equal(ignored.stdout.split('\n').filter(Boolean).length, 3);
});
