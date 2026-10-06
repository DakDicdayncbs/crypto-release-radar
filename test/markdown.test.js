import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { markdownText, markdownSource } from '../src/markdown.js';
import { formatReport } from '../src/output.js';
import { parseArgs, runCli, HELP } from '../src/cli.js';
import { normalReport, emptyReport, partialReport } from '../test-support/markdown-fixtures.js';

test('Markdown escapes literal punctuation, HTML, entities, autolinks and line boundaries centrally', () => {
  assert.equal(markdownText('`\\[]()|*_{}#+-=!~<> &'), '\\`\\\\\\[\\]\\(\\)\\|\\*\\_\\{\\}\\#\\+\\-\\=\\!\\~&lt;&gt; &amp;');
  assert.equal(markdownText('![x](https://evil.example/a) &lt;script&gt; &#10;'),
    String.raw`\!\[x\]\(https&#58;\/\/evil&#46;example\/a\) &amp;lt\;script&amp;gt\; &amp;\#10\;`);
  assert.equal(markdownText('https://evil.example www.evil.example x@evil.example <x@y.example>'),
    String.raw`https&#58;\/\/evil&#46;example www&#46;evil&#46;example x&#64;evil&#46;example &lt;x&#64;y&#46;example&gt;`);
  assert.equal(markdownText('first\r\n\n# heading\t| next\u2028<script>\u2029😀 кирилиця'),
    String.raw`first \# heading \| next &lt;script&gt; 😀 кирилиця`);
  assert.equal(markdownText('\x1b[31mred\x1b[0m\u202ehidden'), 'red hidden');
});

test('Markdown link destinations preserve percent encoding and encode brackets, parentheses, spaces and entity syntax', () => {
  const base = 'https://github.com/demo/one/releases/tag/';
  for (const [suffix, expected] of [
    ['v(1)[x] space', 'v%281%29%5Bx%5D%20space'],
    ['v%28x%29%20%2F', 'v%28x%29%20%2F'],
    ['v%bad%zz%', 'v%bad%25zz%25'],
    ['v&copy;"\'`|{}', 'v%26copy%3B%22%27%60%7C%7B%7D'],
    ['тег😀', '%D1%82%D0%B5%D0%B3%F0%9F%98%80'],
  ]) assert.equal(markdownSource(base + suffix, 'demo/one', 'v[1](x)`|'),
    '[v\\[1\\]\\(x\\)\\`\\|](' + base + expected + ')');
});

test('Markdown refuses active sources outside the validated repository or changed by redaction', () => {
  for (const url of ['javascript:alert(1)', 'http://github.com/demo/one/releases/tag/v1',
    'https://evil.example/demo/one/releases/tag/v1', 'https://github.com/demo/two/releases/tag/v1',
    'https://github.com/demo/one/releases/tag/v1?x=1', 'https://github.com/demo/one/releases/tag/v1#x',
    'https://user:pass@github.com/demo/one/releases/tag/v1', 'https://github.com/demo/one/releases/tag/[REDACTED]']) {
    const text = markdownSource(url, 'demo/one', 'source');
    assert.ok(text.startsWith('Link unavailable after validation/redaction: '));
    assert.ok(!text.includes('](')); assert.ok(!text.includes('https://'));
  }
  assert.equal(markdownSource('https://github.com/demo/one/releases/tag/[REDACTED]', 'demo/one', 'source'),
    String.raw`Link unavailable after validation/redaction: https&#58;\/\/github&#46;com\/demo\/one\/releases\/tag\/\[REDACTED\]`);
});

for (const [name, report] of [['normal', normalReport], ['empty', emptyReport], ['partial', partialReport]]) {
  test(`Markdown ${name} report matches an independently written complete document without mutating input`, async () => {
    const before = structuredClone(report);
    const expected = await readFile(new URL(`../test-support/markdown-${name}.md`, import.meta.url), 'utf8');
    assert.equal(formatReport(report, 'markdown'), expected);
    assert.deepEqual(report, before);
    assert.equal(typeof report.repositories[0].returnedReleases, 'number');
    assert.equal(typeof report.repositories[0].complete, 'boolean');
  });
}

test('Markdown escapes every text context, including headings, source labels, filters and diagnostic details', () => {
  const report = structuredClone(normalReport);
  const attack = '[x](https://evil.example)\n# <img src=x> `code` | ![p](x)';
  const escaped = '\\[x\\]\\(https&#58;\\/\\/evil&#46;example\\) \\# &lt;img src\\=x&gt; \\`code\\` \\| \\!\\[p\\]\\(x\\)';
  report.generatedAt = attack; report.digestNotice = attack;
  report.scope.since = attack; report.scope.until = attack;
  report.scope.tagPatterns = ['[x](y)*']; report.scope.groups = ['x[link]'];
  Object.assign(report.releases[0], { name: attack, tag: attack, publishedAt: attack, digest: { text: attack, truncated: true } });
  report.issues = [{ code: attack, repository: attack, message: attack, status: 429, count: 2, retryAfterSeconds: 0, resetAt: attack }];
  const text = formatReport(report, 'markdown');
  for (const prefix of ['Generated at (UTC): ', '### demo\\/one — ', '- Tag: ', '- Published at (UTC): ',
    '- Published from (inclusive): ', '- Published through (inclusive): ', 'Automatic excerpt (not verified; truncated: yes): ']) {
    assert.ok(text.includes(prefix + escaped), prefix);
  }
  assert.ok(text.includes('[GitHub release ' + escaped + '](https://github.com/demo/one/releases/tag/v2)'));
  assert.ok(text.includes('- **' + escaped + '** — ' + escaped + ': ' + escaped));
  assert.ok(text.includes('HTTP 429\\; count 2\\; retry after 0s\\; reset ' + escaped));
  assert.ok(text.includes(String.raw`groups \[\"x\[link\]\"\]`));
  assert.ok(text.includes(String.raw`tag): \[\"\[x\]\(y\)\*\"\]`));
  assert.ok(!text.includes('<img')); assert.ok(!text.includes('\n# <'));
});

async function run(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { env: {}, stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } }, ...options });
  return { code, stdout, stderr };
}

test('Markdown CLI validates format, duplicates and validation conflicts before file/env/network access', async () => {
  assert.equal(parseArgs(['--format', 'markdown']).format, 'markdown');
  const blocked = { env: new Proxy({}, { get() { throw new Error('Environment must not be read'); } }),
    fetchImpl: () => assert.fail('Network must not be called') };
  for (const args of [
    ['--format', 'md'], ['--format', 'Markdown'], ['--format', 'markdown '], ['--format=markdown'], ['--format'],
    ['--format', 'markdown', '--format', 'json'], ['--format', 'markdown', '--format', 'markdown'],
    ['--format', 'markdown', '--validate-config'], ['--validate-config', '--format', 'markdown'],
    ['--format', 'markdown', '--output', 'private-sentinel'],
  ]) {
    const result = await run(['--config', 'private-sentinel/missing', ...args], blocked);
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^usage:/); assert.ok(!result.stderr.includes('private-sentinel'));
  }
  assert.deepEqual(await run(['--format', 'markdown', '--config', 'missing', '--help'], blocked), { code: 0, stdout: HELP, stderr: '' });
  assert.deepEqual(await run(['--format', 'markdown', '--version'], blocked), { code: 0, stdout: '0.1.0\n', stderr: '' });
  assert.match(HELP, /--format markdown/);
});

test('fatal Markdown config/token/local failures produce safe stderr and no report or output file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-markdown-errors-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'private-sentinel.json');
  const fetchImpl = () => assert.fail('Network must not be called');
  for (const [content, expected] of [[null, 'config_read'], ['{"private-sentinel":', 'config_syntax'], ['{"repositories":[]}', 'invalid_config']]) {
    if (content !== null) await writeFile(path, content);
    const result = await run(['--config', path, '--format', 'markdown'], { fetchImpl });
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(expected + ':')); assert.ok(!result.stderr.includes('private-sentinel'));
  }
  await writeFile(path, '{"repositories":["demo/one"]}');
  const invalidToken = await run(['--config', path, '--format', 'markdown'], { env: { GITHUB_TOKEN: 'invalid\nprivate-sentinel' }, fetchImpl });
  assert.equal(invalidToken.code, 2); assert.equal(invalidToken.stdout, '');
  assert.match(invalidToken.stderr, /^invalid_token:/); assert.ok(!invalidToken.stderr.includes('private-sentinel'));
  const localFailure = await run(['--demo', '--format', 'markdown'], { now: () => { throw new Error('private-sentinel'); }, fetchImpl });
  assert.equal(localFailure.code, 2); assert.equal(localFailure.stdout, '');
  assert.ok(!localFailure.stderr.includes('private-sentinel'));
  assert.deepEqual(await readdir(dir), ['private-sentinel.json']);
});

test('executable Markdown demo is explicitly synthetic, offline and keeps current exit semantics', () => {
  const preload = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("network forbidden"); };');
  const execute = args => spawnSync(process.execPath, ['--import', preload, 'bin/crypto-release-radar.js', ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'invalid\nprivate-sentinel' }, timeout: 10000,
  });
  const result = execute(['--demo', '--format', 'markdown', '--include-prereleases', '--total-limit', '1']);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.match(result.stdout, /^# Crypto Release Radar\n/);
  assert.match(result.stdout, /SYNTHETIC DEMO — fictional data and source links/);
  assert.match(result.stdout, /\*\*Result: COMPLETE scan \| 1 shown releases\*\*/);
  assert.match(result.stdout, /- Release ID: 102\./);
  assert.match(result.stdout, /hidden by total limit: 3\./);
  assert.equal(execute(['--format', 'markdown', '--version']).stdout, '0.1.0\n');
  const bad = execute(['--format', 'md']);
  assert.equal(bad.status, 2); assert.equal(bad.stdout, '');
});

test('Markdown applies token redaction before escaping and source linking while preserving JSON types and selection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-markdown-redaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ repositories: ['demo/one'], groups: { secret: ['demo/one'] }, includePrereleases: true }));
  for (const token of ['secret', 'github', '1', 'true']) {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push(url); assert.equal(options.headers.Authorization, 'Bearer ' + token);
      return new Response(JSON.stringify([{ id: 1, name: token + ' [x](https://evil.example)\n# <img src=x>', tag_name: token,
        published_at: '2026-10-05T12:00:00Z', draft: false, prerelease: true,
        html_url: 'https://github.com/demo/one/releases/tag/' + token, body: token + ' notes' }]), { headers: { 'content-type': 'application/json' } });
    };
    const args = ['--config', path, '--group', 'secret', '--tag-pattern', token, '--total-limit', '1'];
    const options = { env: { GITHUB_TOKEN: token }, fetchImpl, now: () => new Date('2026-10-06T09:30:00Z') };
    const json = await run([...args, '--format', 'json'], options);
    const markdown = await run([...args, '--format', 'markdown'], options);
    assert.equal(json.code, 0); assert.equal(markdown.code, 0); assert.equal(markdown.stderr, '');
    assert.deepEqual(requests, Array(2).fill('https://api.github.com/repos/demo/one/releases?per_page=100&page=1'));
    const report = JSON.parse(json.stdout);
    assert.equal(report.releases[0].id, 1); assert.equal(report.releases[0].prerelease, true);
    assert.equal(report.repositories[0].returnedReleases, 1); assert.equal(report.display.globalSelectionLimited, false);
    assert.equal(report.scope.totalLimit, 1); assert.equal(report.scope.includePrereleases, true);
    assert.match(markdown.stdout, /Release ID: 1\./); assert.match(markdown.stdout, /Prerelease: yes\./);
    assert.match(markdown.stdout, /Matching: 1; after per-repository limits: 1; shown: 1/);
    assert.match(markdown.stdout, /Link unavailable after validation\/redaction/);
    assert.ok(markdown.stdout.includes('\\[REDACTED\\]'));
    assert.ok(!markdown.stdout.includes('](https://'));
    assert.ok(!markdown.stdout.includes('<img')); assert.ok(!markdown.stdout.includes('https://evil.example'));
    assert.ok(!report.releases[0].name.includes(token)); assert.ok(!report.releases[0].url.includes(token));
    if (token === 'secret') assert.ok(!markdown.stdout.includes('secret'));
  }
});
