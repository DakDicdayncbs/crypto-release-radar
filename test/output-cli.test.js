import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runCli, parseArgs, HELP } from '../src/cli.js';
import { readNdjson, readNdjsonReport } from '../test-support/read-ndjson.js';
import { readCsv } from '../test-support/read-csv.js';

const formats = ['table', 'json', 'markdown', 'csv', 'ndjson'];
const now = () => new Date('2026-10-10T17:30:00.000Z');
const bin = fileURLToPath(new URL('../bin/crypto-release-radar.js', import.meta.url));
const demoPath = fileURLToPath(new URL('../fixtures/demo-releases.json', import.meta.url));
const run = async (args, options = {}) => {
  let stdout = '', stderr = '';
  const code = await runCli(args, { env: {}, now, ...options,
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr };
};
const blocked = { env: new Proxy({}, { get() { assert.fail('No token read'); } }), fetchImpl() { assert.fail('No requests'); } };
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(tmpdir() + '/radar-output-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = dir + '/config.json', output = dir + '/report';
  await fs.writeFile(config, '{"repositories":["demo/one"]}');
  return { dir, config, output };
}
const release = (id, repo = 'demo/one', extra = {}) => ({ id, name: 'Release "🚀" ' + id, tag_name: 'v' + id,
  published_at: `2026-10-0${id}T12:00:00Z`, html_url: `https://github.com/${repo}/releases/tag/v${id}`,
  draft: false, prerelease: false, body: 'Unicode é and quoted "notes"', ...extra });
const response = (data, headers = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });

test('output/overwrite syntax and conflicts fail before config, token, requests or file preparation', async () => {
  for (const args of [['--output'], ['--output', ''], ['--output', '   '], ['--output', 'x\nsecret'], ['--output', 'x\0'],
    ['--output', '.'], ['--output', '..'], ['--output', 'dir/'], ['--output', 'dir/.'], ['--output', 'dir/..'],
    ['--output=report'], ['--overwrite'], ['--overwrite=true'], ['--overwrite', '--overwrite', '--output', 'x'],
    ['--output', 'one', '--output', 'two'], ['--output', '--help'], ['--output', 'x', '--validate-config'],
    ['--validate-config', '--output', 'x'], ['--validate-config', '--overwrite'], ['--overwrite', '--help'],
    ['--output', 'x', '--overwrite', 'yes']]) {
    const result = await run(['--format', 'json', '--config', '/missing-private-sentinel', ...args], {
      ...blocked, outputIo: new Proxy({}, { get() { assert.fail('No output I/O'); } }),
    });
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /^usage:/);
    assert.ok(!result.stderr.includes('private-sentinel'));
  }
  assert.equal(parseArgs(['--output', ' x ', '--overwrite']).outputPath, ' x ');
  assert.equal(parseArgs(['--overwrite', '--output', 'x']).overwrite, true);
});

test('help/version and validate-config have no file output or token/network access', async t => {
  const f = await fixture(t), io = new Proxy({}, { get() { assert.fail('No output I/O'); } });
  assert.deepEqual(await run(['--output', f.output, '--overwrite', '--help'], { ...blocked, outputIo: io }), { code: 0, stdout: HELP, stderr: '' });
  assert.deepEqual(await run(['--output', f.output, '--version'], { ...blocked, outputIo: io }), { code: 0, stdout: '0.1.0\n', stderr: '' });
  const validated = await run(['--validate-config', '--config', f.config], { ...blocked, outputIo: io });
  assert.equal(validated.code, 0); assert.match(validated.stdout, /Config is valid locally/);
  assert.deepEqual(await fs.readdir(f.dir), ['config.json']);
});

test('existing output, input aliases, unsafe destinations and missing parents fail before token/API', async t => {
  const f = await fixture(t), original = await fs.readFile(f.config);
  await fs.writeFile(f.output, 'OLD');
  await fs.link(f.config, f.dir + '/hardlink');
  await fs.symlink(f.dir, f.dir + '/alias');
  await fs.symlink(f.output, f.dir + '/symlink');
  for (const [path, extra, code] of [[f.output, [], 'output_exists'], [f.config, ['--overwrite'], 'output_input'],
    [f.dir + '/alias/config.json', ['--overwrite'], 'output_input'], [f.dir + '/hardlink', ['--overwrite'], 'output_input'],
    [f.dir + '/symlink', ['--overwrite'], 'output_type'], [f.dir, ['--overwrite'], 'output_type'],
    [f.dir + '/missing/report', [], 'output_path']]) {
    const result = await run(['--config', f.config, '--format', 'json', '--output', path, ...extra], blocked);
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.startsWith(code + ':'));
    assert.ok(!result.stderr.includes(f.dir));
  }
  assert.deepEqual(await fs.readFile(f.config), original); assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD');
});

test('default config and demo input, including hardlink aliases, cannot be overwritten', async t => {
  const f = await fixture(t), preload = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("network forbidden"); };');
  await fs.rename(f.config, f.dir + '/radar.config.json');
  await fs.link(f.dir + '/radar.config.json', f.output);
  for (const path of ['radar.config.json', 'report']) {
    const result = spawnSync(process.execPath, ['--import', preload, bin, '--format', 'json', '--output', path, '--overwrite'],
      { cwd: f.dir, encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'bad\nprivate-sentinel' }, timeout: 10000 });
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /^output_input:/);
  }
  const demoBefore = await fs.readFile(demoPath);
  await fs.link(demoPath, f.dir + '/demo-alias');
  for (const path of [demoPath, f.dir + '/demo-alias']) {
    const result = await run(['--demo', '--format', 'json', '--output', path, '--overwrite'], blocked);
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /^output_input:/);
  }
  assert.deepEqual(await fs.readFile(demoPath), demoBefore);
});

test('all five demo file formats equal stdout bytes on create and overwrite, without token/network access', async t => {
  const f = await fixture(t);
  for (const format of formats) {
    const args = ['--demo', '--format', format, '--include-prereleases', '--total-limit', '1'];
    const stdout = await run(args, blocked);
    for (const overwrite of [false, true]) {
      if (overwrite) await fs.writeFile(f.output, 'OLD');
      const saved = await run([...args, '--output', f.output, ...(overwrite ? ['--overwrite'] : [])], blocked);
      assert.deepEqual(saved, { code: 0, stdout: '', stderr: '' });
      const bytes = await fs.readFile(f.output);
      assert.deepEqual(bytes, Buffer.from(stdout.stdout));
      assert.equal((await fs.stat(f.output)).mode & 0o777, 0o600);
      if (format === 'csv') { assert.ok(bytes.subarray(-2).equals(Buffer.from('\r\n'))); assert.equal(readCsv(bytes.toString())[0].length, 40); }
      if (format === 'ndjson') { assert.equal(bytes.at(-1), 10); assert.equal(readNdjson(bytes).status, 'complete'); }
      await fs.unlink(f.output);
    }
  }
  assert.deepEqual(await fs.readdir(f.dir), ['config.json']);
});

test('file output preserves complete/empty/partial/all-failed/skipped reports, safe issues and exact requests in every format', async t => {
  const f = await fixture(t);
  for (const kind of ['complete', 'empty', 'partial', 'all-failed', 'skipped']) {
    await fs.writeFile(f.config, JSON.stringify({ repositories: ['demo/one', 'demo/two'], limit: 1, maxPages: 2 }));
    const calls = [];
    const fetchImpl = async url => {
      calls.push(url);
      const two = url.includes('/two/');
      if (kind === 'all-failed' || (kind === 'partial' && two)) return new Response('private-remote', { status: 500 });
      if (kind === 'skipped') return new Response('private-remote', { status: 429, headers: { 'retry-after': '0' } });
      return response(kind === 'empty' ? [] : [release(1, two ? 'demo/two' : 'demo/one'), release(2, two ? 'demo/two' : 'demo/one')]);
    };
    for (const format of formats) {
      const args = ['--config', f.config, '--format', format, '--total-limit', '1'];
      const stdout = await run(args, { fetchImpl }), expectedTrace = calls.splice(0);
      const result = await run([...args, '--output', f.output], { fetchImpl });
      assert.equal(result.code, ['complete', 'empty'].includes(kind) ? 0 : 1);
      assert.equal(result.code, stdout.code); assert.equal(result.stdout, ''); assert.equal(result.stderr, stdout.stderr);
      assert.deepEqual(calls.splice(0), expectedTrace);
      const bytes = await fs.readFile(f.output);
      assert.deepEqual(bytes, Buffer.from(stdout.stdout)); assert.ok(!bytes.includes(Buffer.from('private-remote')));
      if (format === 'ndjson') {
        const report = readNdjsonReport(bytes);
        assert.equal(report.complete, result.code === 0);
        assert.equal(report.repositories.length, 2);
        if (['empty', 'all-failed', 'skipped'].includes(kind)) assert.equal(report.releases.length, 0);
        if (kind === 'skipped') assert.equal(report.repositories[1].requested, false);
      }
      await fs.unlink(f.output);
    }
  }
});

test('groups, policies, pagination, filters, both limits and token redaction match stdout with unchanged traces', async t => {
  const f = await fixture(t), token = 'private-sentinel';
  await fs.writeFile(f.config, JSON.stringify({ repositories: ['demo/unused'], maxPages: 3,
    groups: { preview: [{ slug: 'demo/z', limit: 2, includePrereleases: true }], stable: [{ slug: 'demo/a', limit: 1 }] } }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, 'Bearer ' + token);
    if (url.includes('/a/')) return response([release(4, 'demo/a'), release(5, 'demo/a', { prerelease: true })]);
    if (url.endsWith('page=1')) return response([release(1, 'demo/z'), release(2, 'demo/z', { prerelease: true })],
      { link: '<https://api.github.com/repos/demo/z/releases?per_page=100&page=2>; rel="next"' });
    return response([release(3, 'demo/z', { name: token, body: token, html_url: 'https://github.com/demo/z/releases/tag/' + token }), release(6, 'demo/z', { tag_name: 'excluded' })]);
  };
  const args = ['--config', f.config, '--group', 'preview', '--group', 'stable', '--tag-pattern', 'v*',
    '--since', '2026-10-02T12:00:00Z', '--until', '2026-10-04T12:00:00Z', '--total-limit', '2'];
  for (const format of formats) {
    const options = { fetchImpl, env: { GITHUB_TOKEN: token } };
    const stdout = await run([...args, '--format', format], options), trace = calls.splice(0);
    const result = await run([...args, '--format', format, '--output', f.output], options);
    assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, stdout.stderr);
    assert.deepEqual(calls.splice(0), trace); assert.equal(trace.length, 3);
    const text = await fs.readFile(f.output, 'utf8'); assert.equal(text, stdout.stdout); assert.ok(!text.includes(token));
    if (format === 'ndjson') {
      const report = readNdjsonReport(Buffer.from(text));
      assert.deepEqual(report.releases.map(r => r.id), [4, 3]);
      assert.deepEqual(report.scope.groups, ['preview', 'stable']); assert.equal(report.scope.includePrereleases, null);
      assert.equal(report.display.selectedReleases, 3); assert.equal(report.display.returnedReleases, 2);
      assert.equal(report.releases[1].name, '[REDACTED]');
    }
    await fs.unlink(f.output);
  }
});

test('fatal config/token/formatter/write failures leave old output intact, stdout empty; ordinary JSON envelope is unchanged', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'OLD');
  for (const content of ['{', '{"repositories":[]}', '{"repositories":["demo/one"],"output":"private-sentinel"}', '{"repositories":["demo/one"],"overwrite":true}']) {
    await fs.writeFile(f.config, content);
    for (const format of formats) {
      const result = await run(['--config', f.config, '--format', format, '--output', f.output, '--overwrite'], blocked);
      assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD');
      assert.ok(!result.stderr.includes(f.dir));
    }
    const json = await run(['--config', f.config, '--format', 'json'], blocked);
    assert.equal(json.code, 2); assert.equal(JSON.parse(json.stdout).complete, false);
  }
  await fs.writeFile(f.config, '{"repositories":["demo/one"]}');
  const invalidToken = await run(['--config', f.config, '--format', 'json', '--output', f.output, '--overwrite'],
    { fetchImpl: blocked.fetchImpl, env: { GITHUB_TOKEN: 'bad\nprivate-sentinel' } });
  assert.equal(invalidToken.code, 2); assert.equal(invalidToken.stdout, ''); assert.match(invalidToken.stderr, /^invalid_token:/);
  const local = await run(['--demo', '--format', 'json', '--output', f.output, '--overwrite'],
    { ...blocked, now() { throw new Error('private-sentinel'); } });
  assert.equal(local.code, 2); assert.equal(local.stdout, ''); assert.ok(!local.stderr.includes('private-sentinel'));
  const write = await run(['--demo', '--format', 'json', '--output', f.output, '--overwrite'],
    { ...blocked, outputIo: { ...fs, rename: async () => { throw new Error('private-sentinel'); } } });
  assert.equal(write.code, 2); assert.equal(write.stdout, ''); assert.match(write.stderr, /^output_write:/);
  assert.ok(!write.stderr.includes('private-sentinel')); assert.equal(await fs.readFile(f.output, 'utf8'), 'OLD');
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['config.json', 'report']);
});

test('late destination races fail with safe diagnostics, retaining scan issues and changed user file', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'OLD');
  const result = await run(['--config', f.config, '--format', 'json', '--output', f.output, '--overwrite'], { fetchImpl: async () => {
    await fs.writeFile(f.dir + '/replacement', 'USER'); await fs.rename(f.dir + '/replacement', f.output);
    return new Response('private-remote', { status: 500 });
  } });
  assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /http_error:/);
  assert.match(result.stderr, /output_changed:/); assert.ok(!result.stderr.includes('private-remote'));
  assert.equal(await fs.readFile(f.output, 'utf8'), 'USER');
});

test('cleanup failure after publication returns 2 and explicitly reports saved output without a JSON envelope', async t => {
  const f = await fixture(t);
  const result = await run(['--demo', '--format', 'ndjson', '--output', f.output],
    { ...blocked, outputIo: { ...fs, unlink: async () => { throw new Error('private-sentinel'); } } });
  assert.equal(result.code, 2); assert.equal(result.stdout, '');
  assert.match(result.stderr, /output_cleanup: Report was published/); assert.match(result.stderr, /not rolled back/);
  assert.equal(readNdjson(await fs.readFile(f.output)).status, 'complete');
});
