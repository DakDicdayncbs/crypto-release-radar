import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { csvCell } from '../src/csv.js';
import { formatReport } from '../src/output.js';
import { runCli, parseArgs, HELP } from '../src/cli.js';
import { normalReport, emptyReport, partialReport } from '../test-support/markdown-fixtures.js';
import { readCsv, csvObjects } from '../test-support/read-csv.js';

// Intentionally independent of the formatter's column array.
const header = 'row_type,csv_version,report_schema_version,mode,generated_at,complete,digest_notice,since,until,tag_patterns,groups,limit_per_repository,include_prereleases,max_pages_per_repository,total_limit,repository,requested,pages_fetched,scanned_entries,matching_releases,selected_releases,returned_releases,per_repository_hidden_releases,globally_hidden_releases,selection_limited,global_selection_limited,release_id,name,tag,published_at,prerelease,url,digest_text,digest_truncated,issue_code,issue_message,http_status,issue_count,retry_after_seconds,reset_at'.split(',');

test('independent CSV reader handles doubled quotes and multiline fields, rejecting broken records and width', () => {
  assert.deepEqual(readCsv('a,b\r\n"x,y","""quoted""\r\nline\nlast\rpart"\r\n'), [['a', 'b'], ['x,y', '"quoted"\r\nline\nlast\rpart']]);
  for (const invalid of ['a,b\n', 'a,b\r\nx\r\n', '"a","b', '"a"x,"b"\r\n', 'a,b', 'a"b,c\r\n']) assert.throws(() => readCsv(invalid));
});

test('CSV quotes every field, doubles quotes and preserves Unicode, commas and embedded CR/LF exactly', () => {
  for (const [input, expected] of [
    ['a,b', '"a,b"'], ['say "yes"', '"say ""yes"""'], ['Крипто 🚀', '"Крипто 🚀"'],
    ['first\r\nsecond\nthird\rlast', '"first\r\nsecond\nthird\rlast"'],
    ['', '""'], [null, '""'], [undefined, '""'], [0, '"0"'], [false, '"false"'], [true, '"true"'],
    [Number.MAX_SAFE_INTEGER, '"9007199254740991"'], ['0001', '"0001"'],
  ]) assert.equal(csvCell(input), expected);
});

test('all formula starts are neutralized after leading Unicode whitespace/control/format, without stripping original data', () => {
  const prefixes = ['', ' ', '  ', '\t', '\r', '\n', '\r\n', '\u0000', '\u001b', '\u007f', '\u0085', '\u00a0', '\u1680', '\u2000', '\u200b', '\u200d', '\u2028', '\u2029', '\u2066', '\ufeff', '\u3000', ' \u200b\t\u0000'];
  for (const marker of ['=', '+', '-', '@', '＝', '＋', '－', '＠']) {
    for (const prefix of prefixes) {
      const value = prefix + marker + 'SUM(1,2)';
      assert.deepEqual(readCsv(csvCell(value) + '\r\n'), [["'" + value]]);
    }
  }
  for (const value of ['\tordinary', '\rordinary', '\nordinary', ' \u200b\r\nordinary', '\t', '\r\n']) {
    assert.deepEqual(readCsv(csvCell(value) + '\r\n'), [["'" + value]]);
  }
  for (const value of ["'=SUM(1,2)", 'ordinary = text', 'ordinary\n=SUM(1,2)', 'x\t+1', ' unicode 🚀', '\u200bordinary']) {
    assert.deepEqual(readCsv(csvCell(value) + '\r\n'), [[value]]);
  }
});

for (const [name, report, types] of [
  ['normal', normalReport, ['report', 'repository', 'release']],
  ['empty', emptyReport, ['report', 'repository']],
  ['partial', partialReport, ['report', 'repository', 'release', 'issue']],
]) {
  test(`CSV ${name} bytes match independent expectations with one header/report and 40 columns per row`, async () => {
    const before = structuredClone(report);
    const csv = formatReport(report, 'csv');
    const expected = await readFile(new URL(`../test-support/csv-${name}.csv`, import.meta.url), 'utf8');
    assert.equal(csv, expected);
    assert.deepEqual(readCsv(csv)[0], header);
    assert.deepEqual(csvObjects(csv).map(row => row.row_type), types);
    assert.ok(csv.endsWith('\r\n')); assert.ok(!csv.startsWith('\ufeff'));
    assert.deepEqual(report, before);
  });
}

test('CSV explicitly distinguishes blanks, false and zero, retains exact large IDs and omits unknown fields', () => {
  const report = structuredClone(partialReport);
  report.releases[0].id = Number.MAX_SAFE_INTEGER;
  report.issues[0].count = 0; report.issues[0].retryAfterSeconds = 0;
  report.issues[0].status = 429; report.issues[0].resetAt = '2026-10-06T20:00:00.000Z';
  report.scope.limitPerRepository = null; report.scope.includePrereleases = null;
  for (const item of [report, report.scope, ...report.repositories, ...report.releases, report.releases[0].digest, ...report.issues]) {
    Object.defineProperty(item, 'private_sentinel_extra', { enumerable: true, get() { assert.fail('Unknown field must not be read'); } });
  }
  const csv = formatReport(report, 'csv'), rows = csvObjects(csv);
  assert.deepEqual(readCsv(csv)[0], header);
  assert.deepEqual([rows[0].since, rows[0].until, rows[0].total_limit, rows[0].limit_per_repository, rows[0].include_prereleases], ['', '', '', '', '']);
  assert.equal(rows[0].complete, 'false'); assert.equal(rows[0].globally_hidden_releases, '0');
  assert.equal(rows[1].include_prereleases, 'false'); assert.equal(rows[1].requested, 'true');
  assert.equal(rows[2].release_id, '9007199254740991'); assert.equal(rows[2].prerelease, 'false');
  assert.equal(rows[2].digest_truncated, 'false'); assert.equal(rows[2].complete, '');
  assert.deepEqual([rows[3].http_status, rows[3].issue_count, rows[3].retry_after_seconds, rows[3].reset_at], ['429', '0', '0', '2026-10-06T20:00:00.000Z']);
  assert.ok(!csv.includes('private_sentinel')); assert.equal(report.releases[0].id, Number.MAX_SAFE_INTEGER);
  assert.equal(typeof report.repositories[0].selectionLimited, 'boolean');
});

test('every CSV text context receives formula protection and structural escaping, including diagnostics and URLs', () => {
  const attacks = ['=SUM(1,2)', '＋1', '\u200b＠SUM(1)', '\r\n# "quoted",🚀', 'line\r\n"next",Україна'];
  for (const attack of attacks) {
    const report = structuredClone(partialReport);
    report.mode = attack; report.generatedAt = attack; report.digestNotice = attack;
    report.scope.since = attack; report.scope.until = attack;
    report.scope.groups = [attack]; report.scope.tagPatterns = [attack];
    report.repositories[0].repository = attack;
    Object.assign(report.releases[0], { repository: attack, name: attack, tag: attack, publishedAt: attack, url: attack });
    report.releases[0].digest.text = attack;
    Object.assign(report.issues[0], { repository: attack, code: attack, message: attack, resetAt: attack });
    const before = structuredClone(report);
    const rows = csvObjects(formatReport(report, 'csv'));
    const expected = attack.startsWith('line') ? attack : "'" + attack;
    for (const field of ['mode', 'generated_at', 'digest_notice', 'since', 'until']) assert.equal(rows[0][field], expected, field);
    assert.deepEqual(JSON.parse(rows[0].tag_patterns), [attack]);
    assert.deepEqual(JSON.parse(rows[0].groups), [attack]);
    assert.equal(rows[1].repository, expected);
    for (const field of ['repository', 'name', 'tag', 'published_at', 'url', 'digest_text']) assert.equal(rows[2][field], expected, field);
    for (const field of ['repository', 'issue_code', 'issue_message', 'reset_at']) assert.equal(rows[3][field], expected, field);
    assert.deepEqual(report, before);
  }
});

async function run(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { env: {}, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, ...options });
  return { code, stdout, stderr };
}

test('CSV format parsing rejects aliases, missing/repeated values and validation conflicts before env/network', async () => {
  assert.equal(parseArgs(['--format', 'csv']).format, 'csv');
  const blocked = { env: new Proxy({}, { get() { assert.fail('No environment access'); } }), fetchImpl: () => assert.fail('No request'), now: () => assert.fail('No collection') };
  for (const args of [
    ['--format', 'CSV'], ['--format', 'tsv'], ['--format', 'csv '], ['--format=csv'], ['--format'], ['--format', '--demo'],
    ['--format', 'csv', '--format', 'csv'], ['--format', 'csv', '--format', 'json'],
    ['--format', 'csv', '--validate-config'], ['--validate-config', '--format', 'csv'], ['--format', 'csv', '--output=private-sentinel'],
  ]) {
    const result = await run(['--config', 'private-sentinel/missing', ...args], blocked);
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^usage:/); assert.ok(!result.stderr.includes('private-sentinel'));
  }
  assert.deepEqual(await run(['--format', 'csv', '--config', 'missing', '--help'], blocked), { code: 0, stdout: HELP, stderr: '' });
  assert.deepEqual(await run(['--format', 'csv', '--version'], blocked), { code: 0, stdout: '0.1.0\n', stderr: '' });
  assert.match(HELP, /--format csv/);
});

test('fatal CSV config/token/local failures leave stdout empty and files unchanged with safe stderr', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-csv-errors-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'private-sentinel.json'), fetchImpl = () => assert.fail('No requests');
  for (const [content, code] of [[null, 'config_read'], ['{"private-sentinel":', 'config_syntax'], ['{"repositories":[]}', 'invalid_config']]) {
    if (content !== null) await writeFile(path, content);
    const result = await run(['--config', path, '--format', 'csv'], { fetchImpl });
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(code + ':')); assert.ok(!result.stderr.includes('private-sentinel'));
    if (content !== null) assert.equal(await readFile(path, 'utf8'), content);
  }
  await writeFile(path, '{"repositories":["demo/one"]}');
  const invalidToken = await run(['--config', path, '--format', 'csv'], { env: { GITHUB_TOKEN: 'bad\nprivate-sentinel' }, fetchImpl });
  assert.equal(invalidToken.code, 2); assert.equal(invalidToken.stdout, '');
  assert.match(invalidToken.stderr, /^invalid_token:/); assert.ok(!invalidToken.stderr.includes('private-sentinel'));
  const local = await run(['--demo', '--format', 'csv'], { now: () => { throw new Error('private-sentinel'); }, fetchImpl });
  assert.equal(local.code, 2); assert.equal(local.stdout, ''); assert.ok(!local.stderr.includes('private-sentinel'));
  assert.deepEqual(await readdir(dir), ['private-sentinel.json']);
});

test('CSV redacts before formula protection, preserves normalized Unicode and typed metadata, and never restores source URLs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-csv-redaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ repositories: ['demo/one'], includePrereleases: true }));
  for (const token of ['private-sentinel', '1', 'true', '=FORMULA']) {
    const name = token === '=FORMULA' ? token : '=' + token;
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(url); assert.equal(options.headers.Authorization, 'Bearer ' + token);
      return new Response(JSON.stringify([{ id: 1, name: name + '\r\nКрипто "🚀", next', tag_name: name,
        published_at: '2026-10-06T12:00:00Z', draft: false, prerelease: true, body: name + ' notes',
        html_url: 'https://github.com/demo/one/releases/tag/' + token }]), { headers: { 'content-type': 'application/json' } });
    };
    const args = ['--config', path, '--tag-pattern', name, '--total-limit', '1'];
    const options = { env: { GITHUB_TOKEN: token }, fetchImpl, now: () => new Date('2026-10-06T17:30:00Z') };
    const json = await run([...args, '--format', 'json'], options);
    const csv = await run([...args, '--format', 'csv'], options);
    assert.equal(json.code, 0); assert.equal(csv.code, 0); assert.equal(csv.stderr, '');
    assert.deepEqual(calls, Array(2).fill('https://api.github.com/repos/demo/one/releases?per_page=100&page=1'));
    const report = JSON.parse(json.stdout), rows = csvObjects(csv.stdout), release = rows[2];
    const protectedName = token === '=FORMULA' ? '[REDACTED]' : "'=[REDACTED]";
    assert.equal(release.name, protectedName + ' Крипто "🚀", next');
    assert.equal(release.tag, protectedName); assert.equal(release.digest_text, protectedName + ' notes');
    assert.equal(release.url, 'https://github.com/demo/one/releases/tag/[REDACTED]');
    assert.equal(release.release_id, '1'); assert.equal(release.prerelease, 'true');
    assert.equal(rows[0].returned_releases, '1'); assert.equal(rows[0].global_selection_limited, 'false');
    assert.equal(rows[0].total_limit, '1'); assert.equal(rows[0].include_prereleases, 'true');
    assert.equal(report.releases[0].id, 1); assert.equal(report.releases[0].prerelease, true);
    assert.equal(report.display.globalSelectionLimited, false); assert.equal(report.scope.totalLimit, 1);
    if (token === 'private-sentinel') assert.ok(!csv.stdout.includes(token));
  }
});

test('CSV executable demo is offline, explicitly synthetic and keeps partial-report-free fatal semantics', () => {
  const preload = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("network forbidden"); };');
  const execute = args => spawnSync(process.execPath, ['--import', preload, 'bin/crypto-release-radar.js', ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'bad\nprivate-sentinel' }, timeout: 10000,
  });
  const result = execute(['--demo', '--format', 'csv', '--include-prereleases', '--total-limit', '1']);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const rows = csvObjects(result.stdout);
  assert.deepEqual(readCsv(result.stdout)[0], header);
  assert.deepEqual(rows.map(r => r.row_type), ['report', 'repository', 'repository', 'release']);
  assert.equal(rows[0].mode, 'demo'); assert.equal(rows[0].complete, 'true');
  assert.equal(rows[0].returned_releases, '1'); assert.equal(rows[0].globally_hidden_releases, '3');
  assert.equal(rows[3].release_id, '102'); assert.equal(rows[1].requested, 'false');
  assert.match(rows[0].digest_notice, /not a verified/);
  assert.match(rows[0].generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(execute(['--format', 'csv', '--version']).stdout, '0.1.0\n');
  const bad = execute(['--format', 'CSV']);
  assert.equal(bad.status, 2); assert.equal(bad.stdout, '');
});
