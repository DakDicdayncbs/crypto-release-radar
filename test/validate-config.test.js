import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseArgs, runCli, HELP } from '../src/cli.js';
import { readConfig } from '../src/config.js';
import { structuralCases, semanticExceptions } from '../test-support/config-corpus.js';

const success = 'Config is valid locally. Repository existence, access and authentication were not checked.\n';
const bin = fileURLToPath(new URL('../bin/crypto-release-radar.js', import.meta.url));
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-validation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function offlineRun(args) {
  let stdout = '', stderr = '', envReads = 0, fetches = 0, clocks = 0;
  const denied = () => { envReads++; throw new Error('private-sentinel environment accessed'); };
  const env = new Proxy(Object.defineProperty({}, 'GITHUB_TOKEN', { get: denied }), {
    get: denied, has: denied, ownKeys: denied, getOwnPropertyDescriptor: denied,
  });
  const code = await runCli(args, {
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, env,
    fetchImpl: () => { fetches++; throw new Error('private-sentinel network accessed'); },
    now: () => { clocks++; throw new Error('report collection must not run'); },
  });
  assert.equal(envReads, 0, 'environment must not be inspected');
  assert.equal(fetches, 0, 'transport must not be called');
  assert.equal(clocks, 0, 'report generation must not run');
  assert.ok(!stdout.includes('private-sentinel') && !stderr.includes('private-sentinel'));
  return { code, stdout, stderr };
}

test('validation shares runtime constraints for the complete corpus without environment/network or file writes', async t => {
  const dir = await directory(t), path = join(dir, 'private-sentinel.json');
  const cases = [...structuralCases, ...semanticExceptions.map(value => ['semantic duplicate', value, false])];
  for (const [label, value, valid] of cases) {
    const before = JSON.stringify(value) + '\n';
    await writeFile(path, before, { mode: 0o600 });
    const beforeStat = await stat(path);
    let expectedError;
    try { await readConfig(path); assert.equal(valid, true, label); }
    catch (error) { assert.equal(valid, false, label); expectedError = error; }
    const result = await offlineRun(['--validate-config', '--config', path]);
    assert.equal(result.code, valid ? 0 : 2, label);
    assert.equal(result.stdout, valid ? success : '', label);
    assert.equal(result.stderr, valid ? '' : `${expectedError.code}: ${expectedError.message}\n`, label);
    assert.equal(await readFile(path, 'utf8'), before, label);
    const afterStat = await stat(path);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, label);
    assert.equal(afterStat.mode, beforeStat.mode, label);
    assert.deepEqual(await readdir(dir), ['private-sentinel.json']);
  }
});

test('unreadable and malformed input fail safely without reflecting file paths or contents', async t => {
  const dir = await directory(t), path = join(dir, 'private-sentinel.json');
  let result = await offlineRun(['--validate-config', '--config', path]);
  assert.deepEqual(result, { code: 2, stdout: '', stderr: 'config_read: Cannot read config file. Pass --config with a readable JSON file.\n' });
  assert.deepEqual(await readdir(dir), []);
  for (const text of ['', '{"token":"private-sentinel",', 'private-sentinel', '\u0000', 'false trailing']) {
    await writeFile(path, text);
    result = await offlineRun(['--config', path, '--validate-config']);
    assert.deepEqual(result, { code: 2, stdout: '', stderr: 'config_syntax: Config is not valid JSON.\n' });
    assert.equal(await readFile(path, 'utf8'), text);
  }
  result = await offlineRun(['--validate-config', '--config', dir]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^config_read:/);
});

test('validation rejects every scan option in either order and preserves safe usage errors', async () => {
  const conflicts = [
    ['--demo'], ['--group', 'stable'], ['--format', 'table'], ['--format', 'json'], ['--format', 'markdown'],
    ['--format', 'csv'], ['--format', 'ndjson'],
    ['--output', 'report.json'], ['--overwrite'], ['--output', 'report.json', '--overwrite'],
    ['--limit', '5'], ['--include-prereleases'], ['--tag-pattern', 'v*'], ['--tag-pattern=v*'],
    ['--total-limit', '1'],
    ['--since', '2026-10-04T00:00:00Z'], ['--until', '2026-10-04T23:59:59Z'],
  ];
  for (const args of conflicts) {
    for (const combined of [['--validate-config', ...args], [...args, '--validate-config']]) {
      assert.throws(() => parseArgs(combined), { code: 'usage' });
      const result = await offlineRun(combined);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, ''); // Even --format json is a parse error, not a scan envelope.
      assert.match(result.stderr, /^usage:/);
    }
  }
  for (const args of [
    ['--validate-config', '--validate-config'], ['--validate-config=true'], ['--validate-config', 'true'],
    ['--validate-config', '--config'], ['--validate-config', '--config', 'a', '--config', 'b'],
    ['--validate-config', '--token', 'private-sentinel'], ['--validate-config', '--unknown-private-sentinel'],
  ]) {
    const result = await offlineRun(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^usage:/);
  }
});

test('validation help/version skip file reads and preserve ordinary informational behavior', async () => {
  assert.deepEqual(parseArgs(['--validate-config']), { configPath: 'radar.config.json', format: 'table', demo: false, validateConfig: true });
  for (const args of [['--help'], ['--validate-config', '--config', 'private-sentinel/missing', '--help']]) {
    assert.deepEqual(await offlineRun(args), { code: 0, stdout: HELP, stderr: '' });
  }
  for (const args of [['--version'], ['--validate-config', '--config', 'private-sentinel/missing', '--version']]) {
    assert.deepEqual(await offlineRun(args), { code: 0, stdout: '0.1.0\n', stderr: '' });
  }
  assert.match(HELP, /--validate-config/);
  assert.match(HELP, /Draft 2020-12/);
});

test('both example files validate without token access or network calls', async () => {
  for (const file of ['repos', 'groups']) {
    const path = fileURLToPath(new URL(`../examples/${file}.json`, import.meta.url));
    assert.deepEqual(await offlineRun(['--validate-config', '--config', path]), { code: 0, stdout: success, stderr: '' });
  }
});

test('executable uses the default path and leaves files unchanged with blocked global fetch', async t => {
  const dir = await directory(t), path = join(dir, 'radar.config.json');
  const content = '{"repositories":["synthetic-not-checked/repository"]}\n';
  await writeFile(path, content);
  // If the command accidentally runs a scan, this also fails when no injected fetch is supplied.
  const preload = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("network forbidden"); };');
  const run = args => spawnSync(process.execPath, ['--import', preload, bin, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'invalid\nprivate-sentinel' }, timeout: 10000,
  });
  let result = run(['--validate-config']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, success);
  assert.equal(result.stderr, '');
  assert.equal(await readFile(path, 'utf8'), content);
  assert.deepEqual(await readdir(dir), ['radar.config.json']);
  result = run(['--validate-config', '--config', 'missing-private-sentinel.json']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^config_read:/);
  assert.ok(!result.stderr.includes('private-sentinel'));
});
