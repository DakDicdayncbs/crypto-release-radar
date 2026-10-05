// JSON-compatible cases shared by CLI and schema/runtime agreement tests.
const base = { repositories: ['demo/base'] };
const repos = count => Array.from({ length: count }, (_, i) => `demo/r${i}`);
const groups = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [`g${i}`, repos(20)]));
const largestEntries = () => Array.from({ length: 20 }, (_, i) => ({
  slug: 'a'.repeat(39) + '/' + String(i).padStart(100, 'r'), limit: 50, includePrereleases: true,
}));
export const maximumDefinitions = {
  repositories: largestEntries(),
  groups: Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['g' + String(i).padStart(31, 'x'), largestEntries()])),
  limit: 50, includePrereleases: true, maxPages: 10, timeoutMs: 30000,
};
export const structuralCases = [
  ['all maximum definitions and policies', maximumDefinitions, true],
  ['legacy strings', { repositories: ['a/b', 'Owner/Repo'] }, true],
  ['mixed policies', { repositories: ['a/b', { slug: 'demo/c', limit: 1, includePrereleases: false }], includePrereleases: true }, true],
  ['max list', { repositories: repos(20) }, true],
  ['max groups and entries', { ...base, groups: groups(10) }, true],
  ['empty group map', { ...base, groups: {} }, true],
  ['group names at bounds', { ...base, groups: { a: ['a/b'], ['z'.repeat(32)]: ['a/c'] } }, true],
  ['constructor is a valid own group', { ...base, groups: { constructor: ['a/b'], prototype: ['a/c'] } }, true],
  ['same repo in independent lists', { ...base, groups: { a: ['demo/base'], b: [{ slug: 'DEMO/base', limit: 2 }] } }, true],
  ['maximum slug lengths', { repositories: ['A'.repeat(39) + '/' + 'B'.repeat(100)] }, true],
  ['allowed slug punctuation', { repositories: ['a-/_.-', 'b/...', '0/0'] }, true],
  ['unknown top field', { ...base, token: 'private-sentinel' }, false],
  ['inline schema is not a config field', { ...base, $schema: 'private-sentinel' }, false],
  ['group-only file', { groups: { a: ['a/b'] } }, false],
  ['unknown object member', { repositories: [{ slug: 'a/b', token: 'private-sentinel' }] }, false],
  ['missing slug', { repositories: [{ limit: 1 }] }, false],
  ['eleven groups', { ...base, groups: groups(11) }, false],
  ['identical strings', { repositories: ['a/b', 'a/b'] }, false],
  ['identical objects reordered', { repositories: [{ slug: 'a/b', limit: 2 }, { limit: 2, slug: 'a/b' }] }, false],
];
for (const value of [null, false, true, 3, 'private-sentinel', [], {}]) {
  structuralCases.push(['invalid root ' + JSON.stringify(value), value, false]);
}
for (const value of [null, false, 3, 'a/b', {}, [], repos(21)]) {
  structuralCases.push(['invalid list ' + JSON.stringify(value), { repositories: value }, false]);
  structuralCases.push(['invalid unused list ' + JSON.stringify(value), { ...base, groups: { unused: value } }, false]);
}
for (const value of [null, false, 3, 'private-sentinel', []]) {
  structuralCases.push(['invalid groups ' + JSON.stringify(value), { ...base, groups: value }, false]);
}
for (const value of [null, false, true, 3, [], {}, { slug: null }, { slug: 3 }, { slug: ['a/b'] }]) {
  structuralCases.push(['invalid entry ' + JSON.stringify(value), { repositories: [value] }, false]);
  structuralCases.push(['invalid unused entry ' + JSON.stringify(value), { ...base, groups: { unused: [value] } }, false]);
}
for (const name of ['', 'a'.repeat(33), 'Upper', '0name', '-name', 'a_b', 'a.b', 'a/b', 'a b', 'é', '__proto__', 'toString', 'a\n', 'a\r', 'a\t', 'a\u0000', 'a\u2028', 'a\u2029', 'a\u202e']) {
  structuralCases.push(['invalid group name ' + JSON.stringify(name), { ...base, groups: Object.fromEntries([[name, ['a/b']]]) }, false]);
}
for (const slug of ['', '/b', 'a/', '-a/b', 'a_b/c', 'a'.repeat(40) + '/b', 'a/' + 'b'.repeat(101), 'a/.', 'a/..', 'https://github.com/a/b', 'a/b/c', 'a/b?private-sentinel', 'a/b#fragment', 'a/b ', 'a/é', 'a/b\n', 'a/b\r\n', 'a/b\t', 'a/b\u0000', 'a/b\u2028', 'a/b\u2029', 'a/b\u202e']) {
  structuralCases.push(['invalid slug ' + JSON.stringify(slug), { repositories: [slug] }, false]);
  structuralCases.push(['invalid object slug ' + JSON.stringify(slug), { ...base, groups: { unused: [{ slug }] } }, false]);
}
for (const key of ['__proto__', 'constructor', 'prototype']) {
  structuralCases.push(['unknown top property ' + key, { ...base, [key]: {} }, false]);
  structuralCases.push(['unknown member property ' + key, { repositories: [{ slug: 'a/b', [key]: {} }] }, false]);
}
for (const [key, min, max] of [['limit', 1, 50], ['maxPages', 1, 10], ['timeoutMs', 100, 30000]]) {
  for (const value of [min, max, min - 1, max + 1, min + 0.5, null, true, false, String(min), [], {}]) {
    const valid = value === min || value === max;
    structuralCases.push([`${key} ${JSON.stringify(value)}`, { ...base, [key]: value }, valid]);
    if (key === 'limit') {
      structuralCases.push([`member limit ${JSON.stringify(value)}`, { repositories: [{ slug: 'a/b', limit: value }] }, valid]);
      structuralCases.push([`unused limit ${JSON.stringify(value)}`, { ...base, groups: { unused: [{ slug: 'a/b', limit: value }] } }, valid]);
    }
  }
}
for (const value of [true, false, null, 0, 1, 'false', [], {}]) {
  const valid = typeof value === 'boolean';
  structuralCases.push(['includePrereleases ' + JSON.stringify(value), { ...base, includePrereleases: value }, valid]);
  structuralCases.push(['member boolean ' + JSON.stringify(value), { repositories: [{ slug: 'a/b', includePrereleases: value }] }, valid]);
  structuralCases.push(['unused boolean ' + JSON.stringify(value), { ...base, groups: { unused: [{ slug: 'a/b', includePrereleases: value }] } }, valid]);
}

// Schema compares complete entries; runtime compares case-insensitive slugs.
export const semanticExceptions = [
  { repositories: ['Owner/Repo', 'owner/repo'] },
  { repositories: ['a/b', { slug: 'a/b' }] },
  { repositories: [{ slug: 'a/b', limit: 1 }, { slug: 'a/b', limit: 2 }] },
  { ...base, groups: { unused: ['A/B', { slug: 'a/b', includePrereleases: false }] } },
];
