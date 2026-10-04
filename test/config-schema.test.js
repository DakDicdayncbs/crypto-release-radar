import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateConfig, selectRepositoryGroups } from '../src/config.js';
import { structuralCases, semanticExceptions } from '../test-support/config-corpus.js';

const schema = JSON.parse(await readFile(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'));

// Test-only interpreter for the exact standard keywords used by our schema.
// Not a general JSON Schema validator or a second runtime config validator.
// Unknown keywords/ref forms fail even in branches the corpus doesn't visit.
// Semantics: https://json-schema.org/draft/2020-12/json-schema-validation
// Applicators: https://json-schema.org/draft/2020-12/json-schema-core#section-10
function compileSubset(root) {
  const keywords = new Set(['$schema', '$defs', '$ref', 'title', 'description', 'default',
    'type', 'required', 'properties', 'additionalProperties', 'propertyNames',
    'maxProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
    'minItems', 'maxItems', 'uniqueItems', 'items', 'anyOf', 'not']);
  const types = {
    object: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    array: Array.isArray, string: value => typeof value === 'string',
    integer: Number.isInteger, boolean: value => typeof value === 'boolean',
  };
  const resolve = ref => {
    assert.match(ref, /^#\/\$defs\/[A-Za-z]+$/);
    const key = ref.slice('#/$defs/'.length);
    assert.ok(Object.hasOwn(root.$defs ?? {}, key), 'Unresolved schema reference');
    return root.$defs[key];
  };
  function check(node) {
    if (typeof node === 'boolean') return;
    assert.ok(types.object(node));
    for (const key of Object.keys(node)) assert.ok(keywords.has(key), `Unsupported test schema keyword: ${key}`);
    for (const key of ['$schema', '$ref', 'title', 'description', 'pattern']) {
      if (key in node) assert.equal(typeof node[key], 'string', key);
    }
    for (const key of ['minimum', 'maximum']) if (key in node) assert.ok(Number.isFinite(node[key]), key);
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength', 'maxProperties']) {
      if (key in node) assert.ok(Number.isInteger(node[key]) && node[key] >= 0, key);
    }
    if ('uniqueItems' in node) assert.equal(typeof node.uniqueItems, 'boolean');
    if ('required' in node) {
      assert.ok(Array.isArray(node.required) && node.required.every(key => typeof key === 'string'));
      assert.equal(new Set(node.required).size, node.required.length);
    }
    if ('anyOf' in node) assert.ok(Array.isArray(node.anyOf) && node.anyOf.length > 0);
    if ('$ref' in node) resolve(node.$ref);
    if ('type' in node) assert.ok(Object.hasOwn(types, node.type), 'Unsupported schema type');
    if ('pattern' in node) new RegExp(node.pattern, 'u');
    for (const key of ['properties', '$defs']) {
      if (key in node) assert.ok(types.object(node[key]));
      for (const child of Object.values(node[key] ?? {})) check(child);
    }
    for (const key of ['additionalProperties', 'propertyNames', 'items', 'not']) if (key in node) check(node[key]);
    for (const child of node.anyOf ?? []) check(child);
  }
  check(root);
  function matches(value, node) {
    if (typeof node === 'boolean') return node;
    if (node.$ref && !matches(value, resolve(node.$ref))) return false;
    if (node.type && !types[node.type](value)) return false;
    if (node.anyOf && !node.anyOf.some(child => matches(value, child))) return false;
    if (node.not !== undefined && matches(value, node.not)) return false;
    if (typeof value === 'number') {
      if (node.minimum !== undefined && value < node.minimum) return false;
      if (node.maximum !== undefined && value > node.maximum) return false;
    }
    if (typeof value === 'string') {
      const length = [...value].length;
      if (node.minLength !== undefined && length < node.minLength) return false;
      if (node.maxLength !== undefined && length > node.maxLength) return false;
      if (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(value)) return false;
    }
    if (Array.isArray(value)) {
      if (node.minItems !== undefined && value.length < node.minItems) return false;
      if (node.maxItems !== undefined && value.length > node.maxItems) return false;
      if (node.uniqueItems && value.some((item, i) => value.slice(0, i).some(other => isDeepStrictEqual(item, other)))) return false;
      if (node.items !== undefined && !value.every(item => matches(item, node.items))) return false;
    }
    if (types.object(value)) {
      if (node.maxProperties !== undefined && Object.keys(value).length > node.maxProperties) return false;
      if (node.required?.some(key => !Object.hasOwn(value, key))) return false;
      for (const key of Object.keys(value)) {
        if (node.propertyNames !== undefined && !matches(key, node.propertyNames)) return false;
        const child = Object.hasOwn(node.properties ?? {}, key) ? node.properties[key] : node.additionalProperties;
        if (child !== undefined && !matches(value[key], child)) return false;
      }
    }
    return true;
  }
  return value => matches(value, root);
}

const accepts = compileSubset(schema);
const runtimeAccepts = value => {
  try { validateConfig(value); return true; }
  catch (error) { assert.equal(error.code, 'invalid_config'); return false; }
};

test('Draft 2020-12 schema and runtime agree across the structural corpus', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  for (const [label, input, valid] of structuralCases) {
    const value = JSON.parse(JSON.stringify(input));
    assert.equal(accepts(value), valid, 'schema: ' + label);
    assert.equal(runtimeAccepts(value), valid, 'runtime: ' + label);
  }
});

test('both runnable examples validate and schema defaults match runtime defaults', async () => {
  for (const file of ['repos', 'groups']) {
    const value = JSON.parse(await readFile(new URL(`../examples/${file}.json`, import.meta.url), 'utf8'));
    assert.equal(accepts(value), true);
    assert.equal(runtimeAccepts(value), true);
  }
  const minimal = { repositories: ['a/b'] };
  const config = validateConfig(minimal);
  for (const key of ['limit', 'includePrereleases', 'maxPages', 'timeoutMs']) {
    assert.equal(schema.properties[key].default, config[key]);
  }
  accepts(minimal);
  assert.deepEqual(minimal, { repositories: ['a/b'] }); // default is an annotation, not a write.
});

test('documented semantic exceptions remain authoritative runtime errors', () => {
  for (const value of semanticExceptions) {
    assert.equal(accepts(value), true);
    assert.equal(runtimeAccepts(value), false);
  }
  const groups = { a: Array.from({ length: 20 }, (_, i) => `demo/a${i}`), b: ['demo/b'] };
  for (const value of [
    { repositories: ['a/b'], groups },
    { repositories: ['a/b'], groups: { a: ['demo/repo'], b: ['DEMO/repo'] } },
  ]) {
    assert.equal(accepts(value), true);
    const config = validateConfig(value);
    assert.throws(() => selectRepositoryGroups(config, ['a', 'b']), { code: 'usage' });
    assert.throws(() => selectRepositoryGroups(config, ['missing']), { code: 'usage' });
    assert.throws(() => selectRepositoryGroups(config, ['a', 'a']), { code: 'usage' });
  }
});

test('schema interpreter exercises applicators, character counts and keyword type applicability', () => {
  assert.equal(compileSubset({ minLength: 2 })('🚀'), false);
  assert.equal(compileSubset({ maxLength: 1 })('🚀'), true);
  assert.equal(compileSubset({ pattern: 'b' })('abc'), true); // patterns are not implicitly anchored.
  assert.equal(compileSubset({ minimum: 3 })('2'), true);
  assert.equal(compileSubset({ required: ['a'] })(null), true);
  assert.equal(compileSubset({ uniqueItems: true })([{ a: 1, b: 2 }, { b: 2, a: 1 }]), false);
  assert.equal(compileSubset({ anyOf: [false, { type: 'boolean' }] })(false), true);
  assert.equal(compileSubset({ anyOf: [false, { type: 'boolean' }] })(0), false);
  assert.equal(compileSubset({ not: false })(null), true);
  assert.equal(compileSubset({ additionalProperties: false })({ constructor: 1 }), false);
  assert.equal(compileSubset({ $defs: { number: { minimum: 2 } }, $ref: '#/$defs/number', maximum: 3 })(4), false);
  assert.throws(() => compileSubset({ anyOf: [true, { inventedKeyword: true }] }), /Unsupported/);
  assert.throws(() => compileSubset({ $ref: 'https://example.invalid/schema' }));
  assert.throws(() => compileSubset({ minItems: '1' }));
  assert.throws(() => compileSubset({ required: ['slug', 'slug'] }));
});

test('corpus detects representative weakened schema constraints rather than checking keyword presence', () => {
  const mutations = [
    s => { s.additionalProperties = true; },
    s => { s.required = []; },
    s => { s.$defs.repositoryList.minItems = 0; },
    s => { s.$defs.repositoryList.maxItems = 21; },
    s => { s.$defs.repositoryList.uniqueItems = false; },
    s => { s.$defs.repositoryList.items = true; },
    s => { s.properties.groups.maxProperties = 11; },
    s => { s.properties.groups.propertyNames.maxLength = 33; },
    s => { s.properties.groups.propertyNames.pattern = '.*'; },
    s => { s.properties.groups.additionalProperties = true; },
    s => { s.$defs.slug.pattern = '.*'; },
    s => { delete s.$defs.slug.not; },
    s => { s.$defs.repositoryEntry.anyOf[1].additionalProperties = true; },
    s => { s.$defs.repositoryEntry.anyOf[1].required = []; },
    s => { s.$defs.limit.minimum = 0; },
    s => { s.$defs.limit.maximum = 51; },
    s => { s.properties.timeoutMs.minimum = 99; },
    s => { s.properties.maxPages.maximum = 11; },
    s => { s.properties.includePrereleases = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(schema);
    mutate(changed);
    const weakened = compileSubset(changed);
    assert.ok(structuralCases.some(([, value, expected]) => weakened(value) !== expected), 'Undetected mutation: ' + mutate.toString());
  }
});
