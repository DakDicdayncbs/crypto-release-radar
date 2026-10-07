// Independent example consumer, not imported by production. Accept bytes, not a
// pre-decoded string: replacement decoding would conceal a split/invalid UTF-8.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';
const bool = value => typeof value === 'boolean';
const uint = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => uint(value) && value > 0;
const nullable = check => value => value === null || check(value);
const strings = value => Array.isArray(value) && value.every(string);
const shape = (value, required, optional = {}) => object(value)
  && Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
  && Object.keys(value).every(key => Object.hasOwn(required, key)
    || (Object.hasOwn(optional, key) && optional[key](value[key])));
const scope = value => shape(value, {
  limitPerRepository: nullable(positive), includePrereleases: nullable(bool), maxPagesPerRepository: positive,
  since: nullable(string), until: nullable(string), tagPatterns: strings, groups: strings,
}, { totalLimit: positive });
const display = value => shape(value, { matchingReleases: uint, selectedReleases: uint, returnedReleases: uint,
  perRepositoryHiddenReleases: uint, globallyHiddenReleases: uint, globalSelectionLimited: bool });
const repository = value => shape(value, {
  repository: string, requested: bool, complete: bool, pagesFetched: uint, scannedEntries: uint,
  matchingReleases: uint, returnedReleases: uint, selectionLimited: bool,
  policy: p => shape(p, { limit: positive, includePrereleases: bool }),
}, { selectedReleases: uint, globalSelectionLimited: bool });
const release = value => shape(value, { repository: string, id: positive, name: string, tag: string,
  publishedAt: string, prerelease: bool, url: string, digest: d => shape(d, { text: string, truncated: bool }) });
const issue = value => shape(value, { repository: string, code: string, message: string },
  { status: uint, count: uint, retryAfterSeconds: uint, resetAt: string });
const schemas = {
  metadata: r => shape(r, { type: v => v === 'metadata', ndjsonVersion: v => v === 1, schemaVersion: v => v === 1,
    mode: string, generatedAt: string, complete: bool, digestNotice: string, scope }, { display }),
  repository: r => shape(r, { type: v => v === 'repository', repository }),
  release: r => shape(r, { type: v => v === 'release', release }),
  issue: r => shape(r, { type: v => v === 'issue', issue }),
  summary: r => shape(r, { type: v => v === 'summary', ndjsonVersion: v => v === 1,
    documentComplete: v => v === true, scanComplete: bool,
    counts: c => shape(c, { records: uint, repositories: uint, releases: uint, issues: uint }) }),
};

function consistentSummary(records, summary) {
  const metadata = records[0];
  const repos = records.filter(r => r.type === 'repository').map(r => r.repository);
  const releases = records.filter(r => r.type === 'release').map(r => r.release);
  const issues = records.filter(r => r.type === 'issue').map(r => r.issue);
  const counts = summary.counts;
  if (!repos.length || counts.records !== records.length + 1 || counts.repositories !== repos.length
    || counts.releases !== releases.length || counts.issues !== issues.length
    || summary.scanComplete !== metadata.complete || metadata.complete !== repos.every(r => r.complete)
    || (metadata.complete && issues.length)) return false;
  const global = Object.hasOwn(metadata.scope, 'totalLimit');
  if (Object.hasOwn(metadata, 'display') !== global) return false;
  let matching = 0, selected = 0, returned = 0;
  // Redaction may collapse different repository names; compare aggregate counts
  // per displayed identity, never assume those names remain unique.
  const expected = new Map(), actual = new Map();
  for (const repo of repos) {
    const retained = global ? repo.selectedReleases : repo.returnedReleases;
    if (Object.hasOwn(repo, 'selectedReleases') !== global || Object.hasOwn(repo, 'globalSelectionLimited') !== global
      || retained !== Math.min(repo.matchingReleases, repo.policy.limit) || repo.returnedReleases > retained
      || repo.matchingReleases > repo.scannedEntries || repo.pagesFetched > metadata.scope.maxPagesPerRepository
      || repo.selectionLimited !== (repo.matchingReleases > retained)
      || (global && repo.globalSelectionLimited !== (repo.returnedReleases < retained))) return false;
    matching += repo.matchingReleases; selected += retained; returned += repo.returnedReleases;
    expected.set(repo.repository, (expected.get(repo.repository) ?? 0) + repo.returnedReleases);
  }
  for (const entry of releases) actual.set(entry.repository, (actual.get(entry.repository) ?? 0) + 1);
  if (returned !== releases.length || [...actual].some(([key]) => !expected.has(key))
    || [...expected].some(([key, count]) => count !== (actual.get(key) ?? 0))
    || issues.some(entry => !expected.has(entry.repository))) return false;
  if (global) {
    const d = metadata.display;
    if (returned !== Math.min(selected, metadata.scope.totalLimit) || d.matchingReleases !== matching
      || d.selectedReleases !== selected || d.returnedReleases !== returned
      || d.perRepositoryHiddenReleases !== matching - selected || d.globallyHiddenReleases !== selected - returned
      || d.globalSelectionLimited !== (selected > returned)) return false;
  }
  return true;
}

export function readNdjson(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected UTF-8 bytes.');
  const records = [], decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const order = ['metadata', 'repository', 'release', 'issue', 'summary'];
  let offset = 0, phase = 0, terminal = false;
  const result = (status, error = null) => ({ status, error, records, verifiedBytes: offset,
    remainingBytes: bytes.length - offset, scanComplete: status === 'complete' ? records.at(-1).scanComplete : null });
  while (offset < bytes.length) {
    if (terminal) return result('invalid', 'trailing_data');
    const end = bytes.indexOf(10, offset);
    if (end === -1) return result('truncated', 'missing_summary');
    let text, record;
    try { text = decoder.decode(bytes.subarray(offset, end)); }
    catch { return result('invalid', 'utf8'); }
    try { record = JSON.parse(text); }
    catch { return result('invalid', 'json'); }
    if (!object(record) || !string(record.type) || !Object.hasOwn(schemas, record.type) || !schemas[record.type](record)
      || text.includes('\r')) return result('invalid', 'record');
    const next = order.indexOf(record.type);
    if ((!records.length && next !== 0) || (records.length && next === 0) || next < phase) return result('invalid', 'order');
    if (next === 4 && !consistentSummary(records, record)) return result('invalid', 'summary');
    records.push(record);
    phase = next; terminal = next === 4; offset = end + 1;
  }
  return result(terminal ? 'complete' : 'truncated', terminal ? null : 'missing_summary');
}

export function readNdjsonReport(bytes) {
  const result = readNdjson(bytes);
  if (result.status !== 'complete') throw new Error('NDJSON document is not complete and valid.');
  const { type: _type, ndjsonVersion: _version, ...metadata } = result.records[0];
  return { ...metadata,
    repositories: result.records.filter(r => r.type === 'repository').map(r => r.repository),
    releases: result.records.filter(r => r.type === 'release').map(r => r.release),
    issues: result.records.filter(r => r.type === 'issue').map(r => r.issue),
  };
}
