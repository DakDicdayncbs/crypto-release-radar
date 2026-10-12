// Offline interoperability example, independent of the producer and schema
// interpreter. Not a product input command, snapshot reader or general validator.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const invalid = () => { throw new Error('Unsupported or invalid JSON report.'); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const scalar = check => v => check(v) ? v : invalid();
const text = scalar(v => typeof v === 'string');
const bool = scalar(v => typeof v === 'boolean');
const integer = (min, max) => scalar(v => Number.isSafeInteger(v) && v >= min && v <= max);
const nullable = check => v => v === null ? null : check(v);
const array = (check, min = 0, max = Infinity) => v => {
  if (!Array.isArray(v) || v.length < min || v.length > max) invalid();
  return v.map(check);
};
function fields(value, required, optional = {}) {
  if (!object(value)) invalid();
  const projected = {};
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(value, key)) invalid();
    projected[key] = check(value[key]);
  }
  for (const [key, check] of Object.entries(optional)) {
    if (Object.hasOwn(value, key)) projected[key] = check(value[key]);
  }
  return projected; // Never enumerate/copy unknown input properties.
}
const scope = v => fields(v, { limitPerRepository: nullable(integer(1, 50)), includePrereleases: nullable(bool),
  maxPagesPerRepository: integer(1, 10) }, { since: nullable(text), until: nullable(text),
  tagPatterns: array(text, 0, 10), groups: array(text, 0, 10), totalLimit: integer(1, 1000) });
const repository = v => fields(v, { repository: text, complete: bool, pagesFetched: integer(0, 10),
  scannedEntries: integer(0, 1000), matchingReleases: integer(0, 1000), returnedReleases: integer(0, 50), selectionLimited: bool },
{ policy: p => fields(p, { limit: integer(1, 50), includePrereleases: bool }), requested: bool,
  selectedReleases: integer(0, 50), globalSelectionLimited: bool });
const release = v => fields(v, { repository: text, id: integer(1, 9007199254740991), name: text, tag: text,
  publishedAt: text, prerelease: bool, url: text, digest: d => fields(d, { text, truncated: bool }) });
const issue = v => fields(v, { code: text, message: text }, { repository: text, status: integer(0, 999),
  count: integer(0, 1000), retryAfterSeconds: integer(0, 9999999), resetAt: text });
const reportIssue = v => { if (!object(v) || !Object.hasOwn(v, 'repository')) invalid(); return issue(v); };
const display = v => fields(v, { matchingReleases: integer(0, 20000), selectedReleases: integer(0, 1000),
  returnedReleases: integer(0, 1000), perRepositoryHiddenReleases: integer(0, 20000),
  globallyHiddenReleases: integer(0, 1000), globalSelectionLimited: bool });
const version = scalar(v => v === 1);
const reportOnly = ['mode', 'generatedAt', 'digestNotice', 'scope', 'repositories', 'display'];

export function consumeJson(value) {
  if (!object(value)) invalid();
  if (reportOnly.some(key => Object.hasOwn(value, key))) {
    const data = fields(value, { schemaVersion: version, mode: text, generatedAt: text, complete: bool,
      digestNotice: text, scope, repositories: array(repository, 1, 20), releases: array(release, 0, 1000),
      issues: array(reportIssue) }, { display });
    const global = Object.hasOwn(data.scope, 'totalLimit');
    if (Object.hasOwn(data, 'display') !== global || data.repositories.some(repo =>
      Object.hasOwn(repo, 'selectedReleases') !== global || Object.hasOwn(repo, 'globalSelectionLimited') !== global)) invalid();
    return { kind: 'report', data };
  }
  return { kind: 'fatal', data: fields(value, { schemaVersion: version, complete: scalar(v => v === false),
    releases: array(release, 0, 0), issues: array(issue, 1, 1) }) };
}

// Run with: node examples/consume-json.js < examples/json-v1/legacy.json
// stdout is a new example-only envelope {kind,data}; scan CLI bytes are untouched.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) invalid();
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    const result = consumeJson(JSON.parse(input));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.kind === 'fatal' ? 2 : result.data.complete ? 0 : 1;
  } catch {
    process.stderr.write('Unsupported or invalid JSON report.\n');
    process.exitCode = 2;
  }
}
