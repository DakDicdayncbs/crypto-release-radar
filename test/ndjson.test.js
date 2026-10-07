import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { formatReport } from '../src/output.js';
import { runCli, parseArgs, HELP } from '../src/cli.js';
import { normalReport, emptyReport, partialReport } from '../test-support/markdown-fixtures.js';
import { readNdjson, readNdjsonReport } from '../test-support/read-ndjson.js';

const encode = records => Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''));
const run = async (args, options = {}) => {
  let stdout = '', stderr = '';
  const code = await runCli(args, { env: {}, ...options,
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
  return { code, stdout, stderr };
};
const fixture = name => readFile(new URL('../test-support/ndjson-' + name + '.ndjson', import.meta.url));

for (const [name, report, types] of [
  ['normal', normalReport, ['metadata', 'repository', 'release', 'summary']],
  ['empty', emptyReport, ['metadata', 'repository', 'summary']],
  ['partial', partialReport, ['metadata', 'repository', 'release', 'issue', 'summary']],
]) test(`NDJSON ${name} matches independent byte fixture, types, order, counts and source JSON`, async () => {
  const expected = await fixture(name), original = structuredClone(report);
  const bytes = Buffer.from(formatReport(report, 'ndjson'));
  assert.deepEqual(bytes, expected);
  assert.equal(bytes.at(-1), 10); assert.notEqual(bytes[0], 0xef);
  const recovered = readNdjson(bytes);
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.error, null);
  assert.equal(recovered.verifiedBytes, bytes.length); assert.equal(recovered.remainingBytes, 0);
  assert.equal(recovered.scanComplete, name !== 'partial');
  assert.deepEqual(recovered.records.map(r => r.type), types);
  assert.deepEqual(recovered.records.at(-1), { type: 'summary', ndjsonVersion: 1, documentComplete: true,
    scanComplete: name !== 'partial', counts: { records: types.length, repositories: 1,
      releases: name === 'empty' ? 0 : 1, issues: name === 'partial' ? 1 : 0 } });
  assert.deepEqual(readNdjsonReport(bytes), report);
  assert.deepEqual(report, original);
  assert.equal(recovered.records[0].scope.since, null);
  assert.equal(recovered.records[0].scope.includePrereleases, false);
  assert.equal(Object.hasOwn(recovered.records[0], 'display'), false);
});

function adversarialReport() {
  const report = structuredClone(partialReport);
  const text = 'Крипто 🚀 "quote" \\ \r\n{"type":"summary","documentComplete":true}\n\t\u0000\u2028\u2029 tail';
  report.repositories[0].repository = text;
  report.releases[0].repository = text;
  report.issues[0].repository = text;
  for (const key of ['mode', 'generatedAt', 'digestNotice']) report[key] = text;
  Object.assign(report.scope, { since: text, until: text, tagPatterns: [text], groups: [text] });
  Object.assign(report.releases[0], { id: Number.MAX_SAFE_INTEGER, name: text, tag: text, publishedAt: text, url: text });
  report.releases[0].digest = { text, truncated: true };
  Object.assign(report.issues[0], { code: text, message: text, status: 429, count: 0, retryAfterSeconds: 0, resetAt: text });
  return report;
}

test('NDJSON encodes every string context without injected records and preserves exact JSON types/old bytes/input', () => {
  const report = adversarialReport(), before = structuredClone(report);
  const old = ['table', 'json', 'markdown', 'csv'].map(format => formatReport(report, format));
  const text = formatReport(report, 'ndjson'), lines = text.slice(0, -1).split('\n');
  assert.equal(lines.length, 5); assert.ok(!text.includes('\r'));
  assert.ok(text.includes('\u2028\u2029')); // These Unicode characters are not LF record separators.
  assert.ok(text.includes('\\r\\n')); assert.ok(text.includes('\\u0000'));
  for (const line of lines) assert.equal(line, JSON.stringify(JSON.parse(line)));
  const recovered = readNdjson(Buffer.from(text)), roundtrip = readNdjsonReport(Buffer.from(text));
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.scanComplete, false);
  assert.equal(recovered.records.at(-1).documentComplete, true);
  assert.deepEqual(roundtrip, before);
  assert.equal(roundtrip.releases[0].id, 9007199254740991);
  assert.equal(roundtrip.releases[0].prerelease, false); assert.equal(roundtrip.issues[0].count, 0);
  assert.equal(roundtrip.issues[0].retryAfterSeconds, 0);
  assert.deepEqual(['table', 'json', 'markdown', 'csv'].map(format => formatReport(report, format)), old);
  assert.deepEqual(report, before);
});

test('NDJSON projects only known normalized fields at every object depth', () => {
  const report = structuredClone(normalReport);
  report.scope.totalLimit = 1;
  report.display = { matchingReleases: 2, selectedReleases: 1, returnedReleases: 1,
    perRepositoryHiddenReleases: 1, globallyHiddenReleases: 0, globalSelectionLimited: false };
  Object.assign(report.repositories[0], { selectedReleases: 1, globalSelectionLimited: false });
  const expected = formatReport(report, 'ndjson');
  for (const object of [report, report.scope, report.display, report.repositories[0], report.repositories[0].policy,
    report.releases[0], report.releases[0].digest]) {
    Object.defineProperty(object, 'rawResponse', { enumerable: true, get() { assert.fail('Do not read unknown fields'); } });
  }
  assert.equal(formatReport(report, 'ndjson'), expected);
  const partial = structuredClone(partialReport);
  const expectedPartial = formatReport(partial, 'ndjson');
  Object.defineProperty(partial.issues[0], 'headers', { enumerable: true, get() { assert.fail('Do not read headers'); } });
  assert.equal(formatReport(partial, 'ndjson'), expectedPartial);
  assert.equal(readNdjson(Buffer.from(expected)).status, 'complete');
});

test('recovery at every real byte boundary retains exactly LF-terminated validated records; only full final LF completes', () => {
  for (const report of [normalReport, adversarialReport()]) {
    const bytes = Buffer.from(formatReport(report, 'ndjson')), complete = readNdjson(bytes);
    const ends = [...bytes.entries()].filter(([, byte]) => byte === 10).map(([i]) => i + 1);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const result = readNdjson(bytes.subarray(0, cut));
      const count = ends.filter(end => end <= cut).length, boundary = count ? ends[count - 1] : 0;
      assert.equal(result.status, cut === bytes.length ? 'complete' : 'truncated', 'cut ' + cut);
      assert.deepEqual(result.records, complete.records.slice(0, count), 'cut ' + cut);
      assert.equal(result.verifiedBytes, boundary); assert.equal(result.remainingBytes, cut - boundary);
      assert.equal(result.scanComplete, cut === bytes.length ? report.complete : null);
    }
    const noFinalLf = bytes.subarray(0, -1);
    assert.doesNotThrow(() => JSON.parse(noFinalLf.subarray(ends.at(-2)).toString('utf8')));
    assert.equal(readNdjson(noFinalLf).status, 'truncated');
    assert.throws(() => readNdjsonReport(noFinalLf), /not complete and valid/);
  }
  assert.throws(() => readNdjson('already decoded'), /UTF-8 bytes/);
});

test('malformed UTF-8 or JSON stops recovery at the previous verified boundary without exposing or skipping the bad record', async () => {
  const normal = await fixture('normal'), prefix = normal.subarray(0, normal.indexOf(10) + 1);
  for (const invalid of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf0, 0x9f, 0x9a]), Buffer.from([0xe2, 0x82])]) {
    const result = readNdjson(Buffer.concat([prefix, invalid, Buffer.from('\n'), normal]));
    assert.equal(result.status, 'invalid'); assert.equal(result.error, 'utf8');
    assert.equal(result.records.length, 1); assert.equal(result.verifiedBytes, prefix.length);
    assert.equal(result.scanComplete, null);
  }
  for (const bad of ['{', '{"type":', '{"x":"bad\\escape"}', '{} trailing garbage', '', '\ufeff{}']) {
    const result = readNdjson(Buffer.concat([prefix, Buffer.from(bad + '\n'), normal]));
    assert.equal(result.status, 'invalid'); assert.equal(result.error, 'json');
    assert.equal(result.records.length, 1); assert.equal(result.verifiedBytes, prefix.length);
  }
  const adversarial = Buffer.from(formatReport(adversarialReport(), 'ndjson'));
  const emoji = adversarial.indexOf(Buffer.from('🚀'));
  const broken = Buffer.from(adversarial); broken[emoji + 1] = 0xff;
  assert.equal(readNdjson(broken).error, 'utf8');
  assert.equal(readNdjson(Buffer.concat([adversarial.subarray(0, emoji + 2), Buffer.from('\n')])).error, 'utf8');
});

test('reader rejects wrong shapes/types/versions/order and refuses records or any trailing bytes after summary', async () => {
  const normal = await fixture('normal'), records = readNdjson(normal).records;
  for (const mutate of [
    rows => { rows[0].ndjsonVersion = 2; }, rows => { rows[0].schemaVersion = 2; },
    rows => { rows[0].complete = 'true'; }, rows => { rows[0].scope.since = false; },
    rows => { rows[1].repository.requested = 1; }, rows => { rows[2].release.id = '2'; },
    rows => { rows[2].release.id = Number.MAX_SAFE_INTEGER + 1; }, rows => { rows[2].release.digest.truncated = 0; },
    rows => { rows[2].unknown = true; }, rows => { rows[2].type = { toString: null }; },
    rows => { rows[0] = []; }, rows => { rows[0] = null; },
    rows => { rows[3].documentComplete = false; }, rows => { rows[3].counts.issues = null; },
    rows => { rows[3].ndjsonVersion = 2; }, rows => { rows[3].scanComplete = 1; },
    rows => { delete rows[0].scope; }, rows => { rows[2].type = 'constructor'; },
    rows => { rows[2].release = null; }, rows => { rows[2].release.name = null; },
  ]) {
    const changed = structuredClone(records); mutate(changed);
    const result = readNdjson(encode(changed));
    assert.equal(result.status, 'invalid'); assert.equal(result.error, 'record'); assert.equal(result.scanComplete, null);
  }
  for (const rows of [[records[1]], [records[0], records[0]], [records[0], records[2], records[1]],
    [records[0], { type: 'issue', issue: { repository: 'demo/one', code: 'x', message: 'x' } }, records[2]]]) {
    assert.equal(readNdjson(encode(rows)).error, 'order');
  }
  for (const suffix of ['\n', ' ', 'x', '{}', '{}\n', JSON.stringify(records.at(-1)) + '\n', '\ufeff']) {
    const result = readNdjson(Buffer.concat([normal, Buffer.from(suffix)]));
    assert.equal(result.status, 'invalid'); assert.equal(result.error, 'trailing_data');
    assert.equal(result.records.length, 4); assert.equal(result.verifiedBytes, normal.length);
    assert.equal(result.scanComplete, null);
  }
  assert.equal(readNdjson(Buffer.from(normal.toString().replaceAll('\n', '\r\n'))).error, 'record');
});

test('summary validates all record counts, scan completeness and repository/display accounting; rejected summary is not recovered', async () => {
  const records = readNdjson(await fixture('normal')).records;
  const changes = Object.keys(records.at(-1).counts).map(key => rows => { rows.at(-1).counts[key]++; });
  changes.push(rows => { rows.at(-1).scanComplete = false; }, rows => { rows[0].complete = false; },
    rows => { rows[1].repository.complete = false; }, rows => { rows[1].repository.returnedReleases = 0; },
    rows => { rows[1].repository.selectionLimited = false; }, rows => { rows[1].repository.scannedEntries = 0; },
    rows => { rows[1].repository.pagesFetched = 4; }, rows => { rows[2].release.repository = 'demo/other'; },
    rows => { rows[1].repository.selectedReleases = 1; }, rows => { rows[0].scope.totalLimit = 1; },
    rows => { rows.splice(1, 1); }, rows => { rows.splice(2, 1); });
  for (const change of changes) {
    const rows = structuredClone(records); change(rows);
    const result = readNdjson(encode(rows));
    assert.equal(result.status, 'invalid'); assert.equal(result.error, 'summary');
    assert.equal(result.records.at(-1).type === 'summary', false);
  }
  const report = structuredClone(normalReport);
  report.scope.totalLimit = 1;
  report.display = { matchingReleases: 2, selectedReleases: 1, returnedReleases: 1,
    perRepositoryHiddenReleases: 1, globallyHiddenReleases: 0, globalSelectionLimited: false };
  Object.assign(report.repositories[0], { selectedReleases: 1, globalSelectionLimited: false });
  const valid = readNdjson(Buffer.from(formatReport(report, 'ndjson')));
  assert.equal(valid.status, 'complete');
  for (const change of [
    ...Object.keys(report.display).map(key => rows => { rows[0].display[key] = key === 'globalSelectionLimited' ? true : 99; }),
    rows => { rows[1].repository.globalSelectionLimited = true; }, rows => { rows[1].repository.selectedReleases = 0; },
    rows => { delete rows[1].repository.globalSelectionLimited; }, rows => { delete rows[0].display; },
  ]) {
    const rows = structuredClone(valid.records); change(rows);
    assert.equal(readNdjson(encode(rows)).error, 'summary');
  }
  const partial = readNdjson(await fixture('partial'));
  assert.equal(partial.status, 'complete'); assert.equal(partial.scanComplete, false);
  for (const change of [rows => { rows.at(-1).counts.issues = 0; }, rows => { rows[3].issue.repository = 'demo/other'; }]) {
    const rows = structuredClone(partial.records); change(rows);
    assert.equal(readNdjson(encode(rows)).error, 'summary');
  }
});

test('NDJSON CLI rejects aliases, equals, repeated/missing formats and validation conflicts before config/env/network', async () => {
  const blocked = { env: new Proxy({}, { get() { assert.fail('No environment access'); } }), fetchImpl() { assert.fail('No network'); } };
  for (const args of [['--format', 'NDJSON'], ['--format', 'jsonl'], ['--format', 'ndjson', '--format', 'json'],
    ['--format=ndjson'], ['--format'], ['--format', '--help'], ['--format', 'ndjson', '--validate-config'],
    ['--validate-config', '--format', 'ndjson']]) {
    const result = await run(['--config', '/missing-private-sentinel', ...args], blocked);
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /^usage:/);
    assert.ok(!result.stderr.includes('private-sentinel'));
  }
  assert.equal(parseArgs(['--format', 'ndjson']).format, 'ndjson');
  assert.deepEqual(await run(['--format', 'ndjson', '--help'], blocked), { code: 0, stdout: HELP, stderr: '' });
  assert.deepEqual(await run(['--format', 'ndjson', '--version'], blocked), { code: 0, stdout: '0.1.0\n', stderr: '' });
  assert.match(HELP, /--format ndjson/);
});

test('fatal NDJSON failures produce safe empty stdout and no new files or requests', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-ndjson-errors-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'private-sentinel.json'), fetchImpl = () => assert.fail('No requests');
  for (const [content, code] of [[null, 'config_read'], ['{"private-sentinel":', 'config_syntax'], ['{"repositories":[]}', 'invalid_config']]) {
    if (content !== null) await writeFile(path, content);
    const result = await run(['--config', path, '--format', 'ndjson'], { fetchImpl });
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.startsWith(code + ':'));
    assert.ok(!result.stderr.includes('private-sentinel'));
    if (content !== null) assert.equal(await readFile(path, 'utf8'), content);
  }
  await writeFile(path, '{"repositories":["demo/one"]}');
  const token = await run(['--config', path, '--format', 'ndjson'], { fetchImpl, env: { GITHUB_TOKEN: 'bad\nprivate-sentinel' } });
  assert.equal(token.code, 2); assert.equal(token.stdout, ''); assert.match(token.stderr, /^invalid_token:/);
  const local = await run(['--demo', '--format', 'ndjson'], { fetchImpl, now() { throw new Error('private-sentinel'); } });
  assert.equal(local.code, 2); assert.equal(local.stdout, ''); assert.ok(!local.stderr.includes('private-sentinel'));
  assert.deepEqual(await readdir(dir), ['private-sentinel.json']);
});

test('NDJSON follows token redaction, retaining typed numbers/booleans and exactly reconstructing source JSON', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-ndjson-redaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, '{"repositories":["demo/one"]}');
  for (const token of ['private-sentinel', '1', 'true']) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(url); assert.equal(options.headers.Authorization, 'Bearer ' + token);
      return new Response(JSON.stringify([{ id: Number.MAX_SAFE_INTEGER, name: token + ' Крипто "🚀"', tag_name: token,
        published_at: '2026-10-06T12:00:00Z', draft: false, prerelease: false, body: token + ' notes',
        html_url: 'https://github.com/demo/one/releases/tag/' + token }]), { headers: { 'content-type': 'application/json' } });
    };
    const args = ['--config', path, '--tag-pattern', token, '--total-limit', '1'];
    const options = { env: { GITHUB_TOKEN: token }, fetchImpl, now: () => new Date('2026-10-07T09:30:00Z') };
    const json = await run([...args, '--format', 'json'], options), ndjson = await run([...args, '--format', 'ndjson'], options);
    assert.equal(ndjson.code, 0); assert.equal(ndjson.stderr, json.stderr);
    assert.deepEqual(calls, Array(2).fill('https://api.github.com/repos/demo/one/releases?per_page=100&page=1'));
    const report = readNdjsonReport(Buffer.from(ndjson.stdout));
    assert.deepEqual(report, JSON.parse(json.stdout));
    assert.equal(report.releases[0].name, '[REDACTED] Крипто "🚀"');
    assert.equal(report.releases[0].url, 'https://github.com/demo/one/releases/tag/[REDACTED]');
    assert.equal(report.releases[0].id, Number.MAX_SAFE_INTEGER); assert.equal(report.releases[0].prerelease, false);
    assert.equal(report.scope.totalLimit, 1); assert.equal(report.display.globalSelectionLimited, false);
    if (token === 'private-sentinel') assert.ok(!ndjson.stdout.includes(token));
  }
});

test('NDJSON executable demo ignores tokens/network, labels synthetic data and ends with a consistent summary', () => {
  const preload = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("network forbidden"); };');
  const result = spawnSync(process.execPath, ['--import', preload, 'bin/crypto-release-radar.js', '--demo', '--format', 'ndjson',
    '--include-prereleases', '--total-limit', '1'], { env: { ...process.env, GITHUB_TOKEN: 'bad\nprivate-sentinel' }, timeout: 10000 });
  assert.equal(result.status, 0); assert.equal(result.stderr.length, 0);
  const recovered = readNdjson(result.stdout), report = readNdjsonReport(result.stdout);
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.scanComplete, true);
  assert.deepEqual(recovered.records.at(-1).counts, { records: 5, repositories: 2, releases: 1, issues: 0 });
  assert.equal(report.mode, 'demo'); assert.match(report.digestNotice, /not a verified/);
  assert.equal(report.display.globallyHiddenReleases, 3); assert.equal(report.releases[0].id, 102);
  assert.ok(report.repositories.every(r => r.requested === false));
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
