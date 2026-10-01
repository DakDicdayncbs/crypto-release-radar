import assert from 'node:assert/strict';
import test from 'node:test';
import { compareReleases, normalizeReleases, publishedDate } from '../src/releases.js';
import { cleanText, digest, redactValues } from '../src/text.js';

const release = (overrides = {}) => ({
  id: 1, name: 'Example', tag_name: 'v1', published_at: '2026-09-29T12:00:00Z',
  draft: false, prerelease: false, html_url: 'https://github.com/demo/repo/releases/tag/v1', body: 'Notes', ...overrides,
});

test('filter drafts and optional prereleases; nullable name/body have fallbacks', () => {
  const records = [release(), { draft: true }, release({ id: 2, prerelease: true }), release({ id: 3, name: null, body: null })];
  const stable = normalizeReleases(records, 'demo/repo', false);
  assert.equal(stable.invalidCount, 0);
  assert.deepEqual(stable.releases.map((r) => r.id), [1, 3]);
  assert.equal(stable.releases[1].name, 'v1');
  assert.equal(stable.releases[1].digest.text, 'No release notes provided.');
  assert.equal(normalizeReleases(records, 'demo/repo', true).releases.length, 3);
});

test('sort by publication instant in UTC, not API order, offset text, or tag', () => {
  const records = [
    release({ id: 1, published_at: '2026-09-29T12:00:00+03:00' }),
    release({ id: 2, published_at: '2026-09-29T10:00:00Z' }),
    release({ id: 3, published_at: '2026-09-29T05:30:00-05:00' }),
  ];
  const { releases } = normalizeReleases(records, 'demo/repo', false);
  releases.sort(compareReleases);
  assert.deepEqual(releases.map((r) => r.id), [3, 2, 1]);
  assert.equal(releases[2].publishedAt, '2026-09-29T09:00:00.000Z');
});

test('equal dates use deterministic repository and ID tie-breakers', () => {
  const base = { publishedAt: '2026-09-29T12:00:00Z' };
  const records = [{ ...base, repository: 'b/r', id: 1 }, { ...base, repository: 'a/r', id: 1 }, { ...base, repository: 'a/r', id: 3 }];
  assert.deepEqual(records.sort(compareReleases).map((r) => `${r.repository}:${r.id}`), ['a/r:3', 'a/r:1', 'b/r:1']);
});

for (const value of [null, 'yesterday', '2026-02-30T12:00:00Z', '2026-09-29T12:00:00', '2026-09-29T24:00:00Z', '2026-09-29T12:00:00+24:00', '2026-00-01T00:00:00Z']) {
  test(`reject invalid publication date ${value}`, () => assert.equal(publishedDate(value), null));
}
test('accept valid leap date and millisecond offset', () => assert.equal(publishedDate('2024-02-29T12:30:10.123+02:00'), '2024-02-29T10:30:10.123Z'));

test('malformed entries do not discard valid neighboring releases', () => {
  const records = [null, release({ id: '1' }), release({ prerelease: 'false' }), release({ body: 123 }), release({ published_at: null }), release({ tag_name: '' }), release()];
  const result = normalizeReleases(records, 'demo/repo', false);
  assert.equal(result.invalidCount, 6);
  assert.equal(result.releases.length, 1);
});

for (const url of ['javascript:alert(1)', 'https://evil.example/release', 'https://github.com/other/repo/releases/tag/v1', 'https://user:pass@github.com/demo/repo/releases/tag/v1', 'https://github.com/demo/repo/releases/tag/v1?token=x']) {
  test(`reject unsafe source URL ${url.split(':')[0]}`, () => assert.equal(normalizeReleases([release({ html_url: url })], 'demo/repo', false).invalidCount, 1));
}

test('duplicate published IDs are flagged and emitted once', () => {
  const result = normalizeReleases([release(), release()], 'demo/repo', false);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.releases.length, 1);
});

test('digest removes Markdown, code blocks and control sequences without adding risk claims', () => {
  const result = digest('## Changes\n- Fix [parser](https://example.org).\n```sh\nrm -rf data\n```\n\u001b[31mSecurity note from author\u001b[0m');
  assert.equal(result.text, 'Changes Fix parser. Security note from author');
  assert.equal(result.truncated, false);
  assert.equal(digest('```code only```').text, 'No plain-text release notes available.');
});

test('digest truncates long Unicode content without splitting code points', () => {
  const result = digest('🌍'.repeat(300));
  assert.equal([...result.text].length, 280);
  assert.equal(result.truncated, true);
  assert.ok(result.text.endsWith('…'));
});

test('sanitize terminal escapes and bidi, redact configured token in all remote strings', () => {
  assert.equal(cleanText('\u001b]8;;https://evil.test\u0007text\u001b]8;;\u0007\u202e\nmore'), 'text more');
  const result = normalizeReleases([release({ name: 'sentinel-secret', tag_name: 'sentinel-secret', body: 'sentinel-secret', html_url: 'https://github.com/demo/repo/releases/tag/sentinel-secret' })], 'demo/repo', false, 'sentinel-secret');
  assert.ok(!JSON.stringify(result).includes('sentinel-secret'));
  assert.ok(result.releases[0].digest.text.includes('[REDACTED]'));
});

test('very long notes have bounded preprocessing and honest truncation', () => {
  const result = digest('```' + 'x'.repeat(20000) + '```\nLater notes');
  assert.equal(result.truncated, true);
  assert.equal(result.text, 'No plain-text release notes available.');
  assert.equal(digest('['.repeat(20000)).truncated, true);
});

test('redaction preserves JSON types and escaping', () => {
  const secret = 'quoted"value';
  const report = { complete: true, items: [{ name: secret, count: 1 }], note: null };
  const serialized = JSON.stringify(redactValues(report, secret));
  assert.deepEqual(JSON.parse(serialized), { complete: true, items: [{ name: '[REDACTED]', count: 1 }], note: null });
  assert.equal(redactValues({ complete: true, name: 'true' }, 'true').complete, true);
});
