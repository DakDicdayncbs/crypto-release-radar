import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

// Test-only interpreter of this schema's exact Draft 2020-12 subset. No remote
// resolution, recursion, format inference, coercion, defaults or general-validator
// claim. Check every schema branch before evaluating data; unknown keywords fail.
export function compileReportSubset(root) {
  const keywords = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description',
    'type', 'const', 'required', 'properties', 'additionalProperties', 'minimum',
    'maximum', 'minItems', 'maxItems', 'items', 'anyOf', 'oneOf']);
  const types = {
    object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray, string: v => typeof v === 'string',
    integer: Number.isInteger, boolean: v => typeof v === 'boolean', null: v => v === null,
  };
  const resolve = ref => {
    assert.match(ref, /^#\/\$defs\/[A-Za-z]+$/, 'Unsupported test reference');
    const key = ref.slice('#/$defs/'.length);
    assert.ok(Object.hasOwn(root.$defs ?? {}, key), 'Unresolved test reference');
    return root.$defs[key];
  };
  function check(node, ancestors = new Set()) {
    if (typeof node === 'boolean') return;
    assert.ok(types.object(node), 'Invalid test schema');
    assert.ok(!ancestors.has(node), 'Recursive test schemas are unsupported');
    const path = new Set(ancestors).add(node);
    for (const key of Object.keys(node)) assert.ok(keywords.has(key), `Unsupported test schema keyword: ${key}`);
    for (const key of ['$schema', '$id', '$ref', 'title', 'description']) {
      if (Object.hasOwn(node, key)) assert.equal(typeof node[key], 'string');
    }
    if (Object.hasOwn(node, '$schema')) assert.equal(node.$schema, 'https://json-schema.org/draft/2020-12/schema');
    if (Object.hasOwn(node, 'type')) {
      const list = Array.isArray(node.type) ? node.type : [node.type];
      assert.ok(list.length > 0 && list.every(t => typeof t === 'string' && Object.hasOwn(types, t)), 'Unsupported test type');
      assert.equal(new Set(list).size, list.length);
    }
    for (const key of ['minimum', 'maximum']) if (Object.hasOwn(node, key)) assert.ok(Number.isFinite(node[key]));
    for (const key of ['minItems', 'maxItems']) if (Object.hasOwn(node, key)) assert.ok(Number.isInteger(node[key]) && node[key] >= 0);
    if (Object.hasOwn(node, 'required')) {
      assert.ok(Array.isArray(node.required) && node.required.every(k => typeof k === 'string'));
      assert.equal(new Set(node.required).size, node.required.length);
    }
    for (const key of ['properties', '$defs']) {
      if (Object.hasOwn(node, key)) {
        assert.ok(types.object(node[key]));
        for (const child of Object.values(node[key])) check(child, path);
      }
    }
    for (const key of ['items', 'additionalProperties']) if (Object.hasOwn(node, key)) check(node[key], path);
    for (const key of ['anyOf', 'oneOf']) if (Object.hasOwn(node, key)) {
      assert.ok(Array.isArray(node[key]) && node[key].length > 0);
      for (const child of node[key]) check(child, path);
    }
    if (Object.hasOwn(node, '$ref')) check(resolve(node.$ref), path);
  }
  check(root);
  function matches(value, node) {
    if (typeof node === 'boolean') return node;
    if (node.$ref && !matches(value, resolve(node.$ref))) return false;
    if (node.type && !(Array.isArray(node.type) ? node.type : [node.type]).some(t => types[t](value))) return false;
    if (Object.hasOwn(node, 'const') && !isDeepStrictEqual(value, node.const)) return false;
    if (node.anyOf && !node.anyOf.some(child => matches(value, child))) return false;
    if (node.oneOf && node.oneOf.filter(child => matches(value, child)).length !== 1) return false;
    if (typeof value === 'number') {
      if (node.minimum !== undefined && value < node.minimum) return false;
      if (node.maximum !== undefined && value > node.maximum) return false;
    }
    if (Array.isArray(value)) {
      if (node.minItems !== undefined && value.length < node.minItems) return false;
      if (node.maxItems !== undefined && value.length > node.maxItems) return false;
      if (node.items !== undefined && !value.every(v => matches(v, node.items))) return false;
    }
    if (types.object(value)) {
      if (node.required?.some(key => !Object.hasOwn(value, key))) return false;
      for (const key of Object.keys(value)) {
        const child = Object.hasOwn(node.properties ?? {}, key) ? node.properties[key] : node.additionalProperties;
        if (child !== undefined && !matches(value[key], child)) return false;
      }
    }
    return true;
  }
  return value => matches(value, root);
}
