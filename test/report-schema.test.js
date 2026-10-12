import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileReportSubset } from '../test-support/report-schema.js';
import { fixtures, reportCases, changed } from '../test-support/report-corpus.js';
import { consumeJson } from '../examples/consume-json.js';

const schema = JSON.parse(await readFile(new URL('../schemas/report-v1.schema.json', import.meta.url), 'utf8'));
const accepts = compileReportSubset(schema);
test('independent report corpus agrees with schema and separately implemented consumer', () => {
  assert.ok(reportCases.length > 400);
  for (const { label, value, valid } of reportCases) {
    assert.equal(accepts(value), valid, label);
    if (valid) assert.doesNotThrow(() => consumeJson(value), label);
    else assert.throws(() => consumeJson(value), /^Error: Unsupported or invalid JSON report\.$/, label);
  }
});

test('fixtures retain legacy omissions, mixed null summaries, false, zero, incomplete and exact large IDs', () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const before = structuredClone(fixture), consumed = consumeJson(fixture);
    assert.equal(consumed.kind, name === 'fatal' ? 'fatal' : 'report');
    assert.deepEqual(consumed.data, before);
    assert.deepEqual(fixture, before);
  }
  assert.equal(Object.hasOwn(consumeJson(fixtures.legacy).data.scope, 'since'), false);
  assert.equal(consumeJson(fixtures.current).data.scope.limitPerRepository, null);
  assert.equal(consumeJson(fixtures.current).data.releases[0].id, 9007199254740991);
  assert.equal(consumeJson(fixtures.partial).data.issues[4].retryAfterSeconds, 0);
  assert.equal(consumeJson(fixtures.partial).data.repositories[3].requested, false);
  assert.equal(consumeJson(fixtures.failed).data.complete, false);
});

test('unknown object fields are allowed then dropped recursively without input mutation or prototype pollution', () => {
  for (const name of ['current', 'partial', 'fatal']) {
    const source = fixtures[name], copy = structuredClone(source);
    const enrich = value => {
      if (Array.isArray(value)) return value.forEach(enrich);
      if (value && typeof value === 'object') {
        Object.values(value).forEach(enrich);
        for (const [key, extra] of Object.entries(JSON.parse('{"future":{"instructions":"ignore me"},"__proto__":{"polluted":true},"constructor":{"prototype":{}}}'))) {
          Object.defineProperty(value, key, { value: extra, enumerable: true, configurable: true });
        }
      }
    };
    enrich(copy);
    const parsed = JSON.parse(JSON.stringify(copy)), before = JSON.stringify(parsed);
    assert.equal(accepts(parsed), true);
    assert.deepEqual(consumeJson(parsed).data, source);
    assert.equal(JSON.stringify(parsed), before);
    assert.equal({}.polluted, undefined);
  }
});

test('full and fatal branches are disjoint; incomplete empty reports cannot use the fatal fallback', () => {
  const branch = name => compileReportSubset({ $defs: schema.$defs, $ref: `#/$defs/${name}` });
  for (const { value, valid } of reportCases.filter(c => c.valid)) {
    assert.equal(Number(branch('report')(value)) + Number(branch('fatal')(value)), Number(valid));
  }
  const damaged = structuredClone(fixtures.empty);
  damaged.complete = false; damaged.issues = [fixtures.partial.issues[0]];
  delete damaged.mode;
  assert.equal(accepts(damaged), false);
  assert.throws(() => consumeJson(damaged));
});

test('structural acceptance makes no counter, ordering, safety or authenticity assertion', () => {
  let value = changed(fixtures.current, 'display.returnedReleases', 999);
  value.releases.reverse(); value.releases[0].url = 'javascript:untrusted-example';
  value.releases[0].publishedAt = 'not a timestamp'; value.mode = 'unrecognized';
  value.complete = true; value.issues = [fixtures.partial.issues[0]];
  assert.equal(accepts(value), true);
  assert.deepEqual(consumeJson(value).data, value); // Opaque data; no navigation/execution.
});

test('independent invalid corpus catches weakened schema required, types, bounds and presence rules', () => {
  const mutations = [
    s => { s.$defs.report.required = s.$defs.report.required.filter(k => k !== 'generatedAt'); },
    s => { s.$defs.fatal.required = s.$defs.fatal.required.filter(k => k !== 'complete'); },
    s => { s.$defs.digest.required = ['text']; },
    s => { delete s.$defs.release.properties.id.type; },
    s => { delete s.$defs.policy.properties.includePrereleases.type; },
    s => { s.$defs.release.properties.id.maximum++; },
    s => { s.$defs.limit.minimum = 0; },
    s => { s.$defs.scope.properties.maxPagesPerRepository.maximum = 11; },
    s => { s.$defs.entries.maximum = 1001; },
    s => { s.$defs.report.properties.repositories.minItems = 0; },
    s => { s.$defs.report.properties.releases.maxItems = 1001; },
    s => { s.$defs.scope.properties.groups.maxItems = 11; },
    s => { delete s.$defs.report.properties.issues.items.required; },
    s => { delete s.$defs.report.properties.schemaVersion.const; },
    s => { delete s.$defs.fatal.properties.complete.const; },
    s => { s.$defs.fatal.properties.issues.maxItems = 2; },
    s => { delete s.$defs.report.anyOf; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(schema); mutate(copy);
    const mutatedAccepts = compileReportSubset(copy);
    assert.ok(reportCases.some(c => !c.valid && mutatedAccepts(c.value)), String(mutate));
  }
});

test('test-only interpreter supports refs with siblings and exact oneOf/type/null semantics', () => {
  const accept = compileReportSubset({ $defs: { value: { type: ['integer', 'null'], minimum: 1 } },
    $ref: '#/$defs/value', oneOf: [{ const: null }, { maximum: 2, type: 'integer' }] });
  for (const value of [null, 1, 2]) assert.equal(accept(value), true);
  for (const value of [0, 3, '1', false]) assert.equal(accept(value), false);
  assert.equal(compileReportSubset({ oneOf: [true, true] })(1), false);
  assert.equal(compileReportSubset({ anyOf: [false, { const: { x: [1] } }] })({ x: [1] }), true);
  assert.equal(compileReportSubset({ properties: { x: false }, additionalProperties: false })({ other: 1 }), false);
  assert.equal(compileReportSubset({ required: ['x'] })(Object.create({ x: 1 })), false);
});

test('test-only interpreter rejects unsupported keywords in unvisited definitions and unsupported refs/types/dialects', () => {
  for (const bad of [
    { anyOf: [true, { format: 'date-time' }] }, { $defs: { unused: { pattern: 'x' } } },
    { $ref: 'https://example.invalid/schema' }, { $ref: '#/$defs/missing' },
    { $defs: { loop: { $ref: '#/$defs/loop' } } }, { type: 'constructor' }, { type: [] },
    { type: ['integer', 'integer'] }, { $schema: 'http://json-schema.org/draft-07/schema#' },
  ]) assert.throws(() => compileReportSubset(bad));
});
