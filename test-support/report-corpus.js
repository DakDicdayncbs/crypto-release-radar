import { readFileSync } from 'node:fs';

// Handwritten examples and field expectations, never derived from the schema or
// producer. Values deliberately include structurally valid but inconsistent
// counters: these validators are not semantic/integrity checkers.
export const fixtures = Object.fromEntries(['legacy', 'current', 'empty', 'partial', 'failed', 'fatal'].map(name =>
  [name, JSON.parse(readFileSync(new URL(`../examples/json-v1/${name}.json`, import.meta.url), 'utf8'))]));
export const reportCases = [];
const add = (label, value, valid) => reportCases.push({ label, value, valid });
export function changed(source, path, value, remove = false) {
  const copy = structuredClone(source), parts = path.split('.'), key = parts.pop();
  const parent = parts.reduce((obj, part) => obj[part], copy);
  if (remove) delete parent[key]; else parent[key] = value;
  return copy;
}
const bad = (source, path, value) => add(`invalid ${path}=${JSON.stringify(value)}`, changed(source, path, value), false);
const good = (source, path, value) => add(`valid ${path}=${JSON.stringify(value).slice(0, 60)}`, changed(source, path, value), true);
const missing = (source, path) => add(`required ${path}`, changed(source, path, null, true), false);
for (const [name, value] of Object.entries(fixtures)) add(name, value, true);
const { legacy, current, partial, fatal } = fixtures;
for (const value of [null, false, 0, [], 'report']) add('non-object root', value, false);
for (const key of ['schemaVersion', 'mode', 'generatedAt', 'complete', 'digestNotice', 'scope', 'repositories', 'releases', 'issues']) missing(legacy, key);
for (const key of ['schemaVersion', 'complete', 'releases', 'issues']) missing(fatal, key);
for (const source of [legacy, fatal]) for (const value of [0, 2, 1.5, '1', true, null]) bad(source, 'schemaVersion', value);
for (const key of ['limitPerRepository', 'includePrereleases', 'maxPagesPerRepository']) missing(legacy, `scope.${key}`);
for (const key of ['repository', 'complete', 'pagesFetched', 'scannedEntries', 'matchingReleases', 'returnedReleases', 'selectionLimited']) missing(legacy, `repositories.0.${key}`);
for (const key of ['repository', 'id', 'name', 'tag', 'publishedAt', 'prerelease', 'url', 'digest']) missing(legacy, `releases.0.${key}`);
for (const key of ['text', 'truncated']) missing(legacy, `releases.0.digest.${key}`);
for (const key of ['limit', 'includePrereleases']) missing(current, `repositories.0.policy.${key}`);
for (const key of ['repository', 'code', 'message']) missing(partial, `issues.0.${key}`);
for (const key of ['code', 'message']) missing(fatal, `issues.0.${key}`);
for (const key of ['matchingReleases', 'selectedReleases', 'returnedReleases', 'perRepositoryHiddenReleases', 'globallyHiddenReleases', 'globalSelectionLimited']) missing(current, `display.${key}`);

// Types for every known string/boolean/object/array field, including optional ones.
for (const path of ['mode', 'generatedAt', 'digestNotice', 'repositories.0.repository', 'releases.0.repository',
  'releases.0.name', 'releases.0.tag', 'releases.0.publishedAt', 'releases.0.url', 'releases.0.digest.text',
  'scope.since', 'scope.until', 'scope.tagPatterns.0', 'scope.groups.0']) {
  for (const value of [false, 3, {}, []]) bad(current, path, value);
  if (!['scope.since', 'scope.until'].includes(path)) bad(current, path, null);
  good(current, path, ''); good(current, path, '[REDACTED] 🚀 <script>opaque & untrusted</script>');
}
for (const path of ['issues.0.repository', 'issues.0.code', 'issues.0.message', 'issues.4.resetAt']) {
  for (const value of [null, false, 3, {}, []]) bad(partial, path, value);
  good(partial, path, 'new-code-or-redacted-value');
}
for (const path of ['complete', 'scope.includePrereleases', 'repositories.0.complete', 'repositories.0.selectionLimited',
  'repositories.0.requested', 'repositories.0.policy.includePrereleases', 'repositories.0.globalSelectionLimited',
  'releases.0.prerelease', 'releases.0.digest.truncated', 'display.globalSelectionLimited']) {
  for (const value of [0, 1, 'false', {}, []]) bad(current, path, value);
  if (path !== 'scope.includePrereleases') bad(current, path, null);
  for (const value of [false, true]) good(current, path, value);
}
for (const path of ['scope', 'repositories.0', 'repositories.0.policy', 'releases.0', 'releases.0.digest', 'display']) {
  for (const value of [null, [], false, 'object']) bad(current, path, value);
}
for (const value of [null, [], false, 'object']) bad(partial, 'issues.0', value);
for (const path of ['repositories', 'releases', 'issues', 'scope.groups', 'scope.tagPatterns']) {
  for (const value of [null, {}, false, 'array']) bad(current, path, value);
}

for (const [source, path, min, max] of [
  [current, 'scope.limitPerRepository', 1, 50], [current, 'scope.maxPagesPerRepository', 1, 10],
  [current, 'scope.totalLimit', 1, 1000], [current, 'repositories.0.policy.limit', 1, 50],
  [current, 'repositories.0.pagesFetched', 0, 10], [current, 'repositories.0.scannedEntries', 0, 1000],
  [current, 'repositories.0.matchingReleases', 0, 1000], [current, 'repositories.0.returnedReleases', 0, 50],
  [current, 'repositories.0.selectedReleases', 0, 50], [current, 'releases.0.id', 1, 9007199254740991],
  [current, 'display.matchingReleases', 0, 20000], [current, 'display.selectedReleases', 0, 1000],
  [current, 'display.returnedReleases', 0, 1000], [current, 'display.perRepositoryHiddenReleases', 0, 20000],
  [current, 'display.globallyHiddenReleases', 0, 1000], [partial, 'issues.0.count', 0, 1000],
  [partial, 'issues.0.status', 0, 999], [partial, 'issues.0.retryAfterSeconds', 0, 9999999],
]) {
  for (const value of [min - 1, max + 1, 1.5, '1', false, {}, []]) bad(source, path, value);
  if (path !== 'scope.limitPerRepository') bad(source, path, null);
  for (const value of [min, max]) good(source, path, value);
}
for (const path of ['scope.limitPerRepository', 'scope.includePrereleases', 'scope.since', 'scope.until']) good(current, path, null);
for (const [path, item, max] of [['repositories', current.repositories[0], 20], ['releases', current.releases[0], 1000],
  ['scope.groups', 'redacted', 10], ['scope.tagPatterns', '*', 10]]) {
  good(current, path, Array(max).fill(item)); bad(current, path, Array(max + 1).fill(item));
}
bad(current, 'repositories', []); good(current, 'releases', []); good(current, 'issues', []);
good(partial, 'issues', Array(1001).fill(partial.issues[0])); // No invented issue-array limit.
for (const key of ['since', 'until', 'tagPatterns', 'groups']) add(`legacy only ${key}`, changed(legacy, `scope.${key}`, current.scope[key]), true);
for (const key of ['policy', 'requested']) add(`legacy only ${key}`, changed(legacy, `repositories.0.${key}`, current.repositories[0][key]), true);
for (const path of ['scope.totalLimit', 'display', 'repositories.0.selectedReleases', 'repositories.0.globalSelectionLimited']) missing(current, path);
bad(legacy, 'display', current.display); bad(legacy, 'scope.totalLimit', 1);
bad(legacy, 'repositories.0.selectedReleases', 0); bad(legacy, 'repositories.0.globalSelectionLimited', false);
for (const key of ['mode', 'generatedAt', 'digestNotice', 'scope', 'repositories', 'display']) bad(fatal, key, null);
bad(fatal, 'complete', true); bad(fatal, 'complete', 0); bad(fatal, 'releases', legacy.releases);
bad(fatal, 'issues', []); bad(fatal, 'issues', [fatal.issues[0], fatal.issues[0]]);
bad(fatal, 'issues.0.code', null); bad(fatal, 'issues.0.message', 1);
good(current, 'releases.0.name', '[REDACTED]'.repeat(300));
good(current, 'mode', 'future-mode');
for (const source of [current, partial, fatal]) good(source, 'future', { anything: [null, 0, false, { nested: 'ignored' }] });
for (const path of ['scope.future', 'repositories.0.future', 'repositories.0.policy.future', 'releases.0.future',
  'releases.0.digest.future', 'display.future']) good(current, path, { ignored: true });
good(partial, 'issues.0.future', [false]); good(fatal, 'issues.0.future', [false]);
