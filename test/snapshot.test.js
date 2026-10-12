import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { serializeSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_TEXT_UNITS, MAX_SNAPSHOT_ISSUES } from '../src/snapshot.js';
import { fixtures, reportCases, changed } from '../test-support/report-corpus.js';
import { compileReportSubset } from '../test-support/report-schema.js';
import { RadarError } from '../src/errors.js';

const schema = JSON.parse(await readFile(new URL('../schemas/snapshot-v1.schema.json', import.meta.url), 'utf8'));
const accepts = compileReportSubset(schema);
const serialize = (value, options = {}) => serializeSnapshot(value, { synthetic: false, ...options });
const rejects = code => error => {
  assert.equal(error.code, code); assert.ok(!error.message.includes('private-sentinel')); return true;
};

test('closed snapshot fixtures preserve original time, provenance, ordering, policies and typed omissions/null/false/zero', async () => {
  for (const name of ['legacy', 'current', 'empty', 'partial', 'failed']) {
    const fixture = JSON.parse(await readFile(new URL(`../examples/snapshot-v1/${name}.json`, import.meta.url), 'utf8'));
    const before = structuredClone(fixtures[name]), text = serialize(fixtures[name]);
    assert.deepEqual(JSON.parse(text), fixture); assert.equal(accepts(fixture), true);
    assert.deepEqual(fixtures[name], before); assert.deepEqual(fixture.report, before);
    assert.equal(fixture.report.generatedAt, before.generatedAt);
    assert.equal(fixture.report.complete, !['partial', 'failed'].includes(name));
    assert.ok(text.endsWith('\n')); assert.ok(!text.startsWith('\ufeff'));
  }
  assert.equal(JSON.parse(serialize(fixtures.current)).report.releases[0].id, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.hasOwn(JSON.parse(serialize(fixtures.legacy)).report.scope, 'since'), false);
  const demo = changed(fixtures.current, 'mode', 'demo');
  assert.equal(JSON.parse(serialize(demo, { synthetic: true })).synthetic, true);
  assert.throws(() => serialize(demo), rejects('snapshot_invalid'));
  assert.throws(() => serializeSnapshot(fixtures.current), rejects('snapshot_invalid'));
});

test('every independently invalid report case is refused; fatal envelopes are never snapshots', () => {
  for (const { label, value, valid } of reportCases) if (!valid) {
    assert.throws(() => serialize(value), rejects('snapshot_invalid'), label);
    assert.equal(accepts({ kind: 'crypto-release-radar-snapshot', snapshotVersion: 1, synthetic: false, report: value }), false, label);
  }
  assert.throws(() => serialize(fixtures.fatal), rejects('snapshot_invalid'));
  assert.equal(accepts({ kind: 'crypto-release-radar-snapshot', snapshotVersion: 1, synthetic: false, report: fixtures.fatal }), false);
});

test('schema requires its own kind/version/provenance and rejects extra container or report fields', () => {
  const value = JSON.parse(serialize(fixtures.current));
  for (const key of ['kind', 'snapshotVersion', 'synthetic', 'report']) {
    const copy = structuredClone(value); delete copy[key]; assert.equal(accepts(copy), false);
  }
  for (const version of [0, 2, '1', true, null]) assert.equal(accepts({ ...value, snapshotVersion: version }), false);
  assert.equal(accepts({ ...value, kind: 'other' }), false);
  assert.equal(accepts({ ...value, synthetic: 'false' }), false);
  assert.equal(accepts({ ...value, token: 'private-sentinel' }), false);
  assert.equal(accepts({ ...value, report: { ...value.report, schemaVersion: 2 } }), false);
});

test('raw/unknown properties at every object level are rejected without copying or invoking them', () => {
  const paths = ['body', 'headers', 'config', 'env', 'requestUrl', 'scope.raw', 'repositories.0.raw',
    'repositories.0.policy.token', 'releases.0.body', 'releases.0.raw', 'releases.0.digest.body', 'display.extra'];
  for (const path of paths) {
    const value = changed(fixtures.current, path, { private: 'private-sentinel' });
    assert.throws(() => serialize(value), rejects('snapshot_invalid'));
    assert.equal(accepts({ kind: 'crypto-release-radar-snapshot', snapshotVersion: 1, synthetic: false, report: value }), false);
  }
  assert.throws(() => serialize(changed(fixtures.partial, 'issues.0.headers', {})), rejects('snapshot_invalid'));
  for (const key of ['__proto__', 'constructor', 'toJSON', Symbol('extra')]) {
    const value = structuredClone(fixtures.current);
    Object.defineProperty(value, key, { get() { assert.fail('Unknown accessors must not run'); }, enumerable: true });
    assert.throws(() => serialize(value), rejects('snapshot_invalid'));
  }
  const value = structuredClone(fixtures.current);
  Object.defineProperty(value.releases[0], 'name', { get() { assert.fail('Known accessor must not run'); }, enumerable: true });
  assert.throws(() => serialize(value), rejects('snapshot_invalid'));
  const cycle = structuredClone(fixtures.current); cycle.releases[0].digest = cycle;
  assert.throws(() => serialize(cycle), rejects('snapshot_invalid'));
  for (const arr of [new Array(2), Object.assign([], { extra: 'private-sentinel' })]) {
    assert.throws(() => serialize(changed(fixtures.current, 'releases', arr)), rejects('snapshot_invalid'));
  }
});

test('active-token checks cover decoded text, serialized keys/container/literals and do not claim arbitrary secret detection', () => {
  for (const path of ['mode', 'generatedAt', 'digestNotice', 'scope.since', 'scope.until', 'scope.groups.0',
    'scope.tagPatterns.0', 'repositories.0.repository', 'releases.0.repository', 'releases.0.name',
    'releases.0.tag', 'releases.0.publishedAt', 'releases.0.url', 'releases.0.digest.text']) {
    assert.throws(() => serialize(changed(fixtures.current, path, 'private-sentinel'), { token: 'private-sentinel' }), rejects('snapshot_secret'));
  }
  for (const path of ['issues.0.code', 'issues.0.repository', 'issues.0.message', 'issues.4.resetAt']) {
    assert.throws(() => serialize(changed(fixtures.partial, path, 'private-sentinel'), { token: 'private-sentinel' }), rejects('snapshot_secret'));
  }
  for (const token of ['snapshot', '"report"', 'true', '9007199254740991']) {
    assert.throws(() => serialize(fixtures.current, { token }), rejects('snapshot_secret'));
  }
  const escaped = 'secret"\\suffix';
  assert.throws(() => serialize(changed(fixtures.current, 'releases.0.name', escaped), { token: escaped }), rejects('snapshot_secret'));
  for (const token of [true, 'bad\nprivate-sentinel', 'x'.repeat(4097)]) assert.throws(() => serialize(fixtures.current, { token }), rejects('snapshot_invalid'));
  const arbitrary = changed(fixtures.current, 'releases.0.name', 'unknown-private-sentinel');
  assert.ok(serialize(arbitrary).includes('unknown-private-sentinel')); // No universal secret detector.
  const redacted = changed(fixtures.current, 'mode', '[REDACTED]');
  assert.equal(JSON.parse(serialize(redacted, { token: 'live' })).synthetic, false);
  assert.throws(() => serialize(redacted, { token: 'R' }), rejects('snapshot_secret'));
});

test('opaque post-redaction strings retain expansion, changed dates/URLs and numeric/boolean metadata', () => {
  let value = changed(fixtures.current, 'releases.0.name', '[REDACTED]'.repeat(100));
  value = changed(value, 'releases.0.digest.text', '[REDACTED]'.repeat(100));
  value.generatedAt = '[REDACTED]-10-03'; value.releases[0].publishedAt = '[REDACTED]';
  value.releases[0].url = 'https://[REDACTED]/example';
  assert.deepEqual(JSON.parse(serialize(value)).report, value);
  assert.equal(accepts(JSON.parse(serialize(value))), true);
});

test('application-shaped exceptions from caller objects cannot inject raw diagnostics', () => {
  for (const code of ['snapshot_invalid', 'snapshot_size', 'snapshot_secret', 'custom']) {
    const proxy = new Proxy({}, { getPrototypeOf() { throw new RadarError(code, 'private-sentinel'); } });
    assert.throws(() => serialize(proxy), rejects(code === 'custom' ? 'snapshot_invalid' : code));
  }
});

test('aggregate text budget is checked before serialization and counts UTF-16 units including surrogate pairs', () => {
  const value = changed(fixtures.legacy, 'releases.0.name', '');
  const sum = v => typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.values(v).reduce((n, x) => n + sum(x), 0) : 0;
  const available = MAX_SNAPSHOT_TEXT_UNITS - sum(value);
  value.releases[0].name = '🚀'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2);
  assert.equal(sum(value), MAX_SNAPSHOT_TEXT_UNITS);
  assert.ok(Buffer.byteLength(serialize(value)) <= MAX_SNAPSHOT_BYTES);
  value.releases[0].name += 'x';
  assert.throws(() => serialize(value), rejects('snapshot_size'));
});

test('serialized UTF-8 budget includes escaping, indentation and final LF, with exact boundary and +1', () => {
  const value = changed(fixtures.legacy, 'releases.0.name', '');
  const available = MAX_SNAPSHOT_BYTES - Buffer.byteLength(serialize(value));
  value.releases[0].name = '\u0001'.repeat(Math.floor(available / 6)) + 'x'.repeat(available % 6);
  const bytes = serialize(value);
  assert.equal(Buffer.byteLength(bytes), MAX_SNAPSHOT_BYTES);
  value.releases[0].name += 'x';
  assert.throws(() => serialize(value), rejects('snapshot_size'));
});

test('snapshot issue count has a resource bound without changing report-v1 issue compatibility', () => {
  let value = changed(fixtures.partial, 'issues', Array(MAX_SNAPSHOT_ISSUES).fill(fixtures.partial.issues[0]));
  assert.equal(accepts(JSON.parse(serialize(value))), true);
  value.issues.push(fixtures.partial.issues[0]);
  assert.throws(() => serialize(value), rejects('snapshot_size'));
  assert.equal(accepts({ kind: 'crypto-release-radar-snapshot', snapshotVersion: 1, synthetic: false, report: value }), false);
});
