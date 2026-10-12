import { RadarError } from './errors.js';
import { validateOutputPath, writeOutput } from './output-file.js';
import { redact } from './text.js';

export const SNAPSHOT_SUFFIX = '.radar-snapshot.json';
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_TEXT_UNITS = 4 * 1024 * 1024;
export const MAX_SNAPSHOT_ISSUES = 1000;
const invalid = () => { throw new RadarError('snapshot_invalid', 'Cannot save snapshot: invalid normalized report or unsupported fields/version.'); };
const tooLarge = () => { throw new RadarError('snapshot_size', 'Cannot save snapshot: text, issue or serialized byte budget exceeded.'); };
const secret = () => { throw new RadarError('snapshot_secret', 'Cannot save snapshot: the active token remains in snapshot data or serialized bytes.'); };

export function validateSnapshotPath(path) {
  try { validateOutputPath(path); }
  catch { throw new RadarError('usage', '--snapshot requires a file path without control characters or a trailing directory component.'); }
  if (!path.endsWith(SNAPSHOT_SUFFIX)) throw new RadarError('usage', '--snapshot requires a filename ending in .radar-snapshot.json.');
}

// A closed projection of the in-memory, already normalized/redacted report.
// Never serialize the caller's objects or enumerate unknown values. These are
// internal writer APIs, not a snapshot reader or general report input command.
function projectReport(input, token) {
  let remainingText = MAX_SNAPSHOT_TEXT_UNITS;
  const text = value => {
    if (typeof value !== 'string') invalid();
    if (value.length > remainingText) tooLarge();
    remainingText -= value.length;
    if (token && value.includes(token)) secret();
    return value;
  };
  const boolean = value => { if (typeof value !== 'boolean') invalid(); return value; };
  const integer = (min, max) => value => {
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
    return value;
  };
  const nullable = check => value => value === null ? null : check(value);
  const own = (value, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
    return descriptor.value;
  };
  const array = (check, min, max, sizeError = false) => value => {
    if (!Array.isArray(value) || value.length < min) invalid();
    if (value.length > max) { if (sizeError) tooLarge(); invalid(); }
    // Dense arrays only; reject extra keys/accessors, including toJSON/symbols.
    if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
    return Array.from({ length: value.length }, (_, i) => check(own(value, String(i))));
  };
  const fields = (value, required, optional = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const allowed = { ...required, ...optional }, keys = Reflect.ownKeys(value);
    if (keys.length > Object.keys(allowed).length || keys.some(key => typeof key !== 'string' || !Object.hasOwn(allowed, key))) invalid();
    const result = {};
    for (const [key, check] of Object.entries(required)) result[key] = check(own(value, key));
    for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(value, key)) result[key] = check(own(value, key));
    return result;
  };
  const scope = value => fields(value, {
    limitPerRepository: nullable(integer(1, 50)), includePrereleases: nullable(boolean), maxPagesPerRepository: integer(1, 10),
  }, { since: nullable(text), until: nullable(text), tagPatterns: array(text, 0, 10), groups: array(text, 0, 10), totalLimit: integer(1, 1000) });
  const repository = value => fields(value, { repository: text, complete: boolean, pagesFetched: integer(0, 10),
    scannedEntries: integer(0, 1000), matchingReleases: integer(0, 1000), returnedReleases: integer(0, 50), selectionLimited: boolean },
  { policy: p => fields(p, { limit: integer(1, 50), includePrereleases: boolean }), requested: boolean,
    selectedReleases: integer(0, 50), globalSelectionLimited: boolean });
  const release = value => fields(value, { repository: text, id: integer(1, Number.MAX_SAFE_INTEGER), name: text, tag: text,
    publishedAt: text, prerelease: boolean, url: text, digest: d => fields(d, { text, truncated: boolean }) });
  const issue = value => fields(value, { repository: text, code: text, message: text }, {
    status: integer(0, 999), count: integer(0, 1000), retryAfterSeconds: integer(0, 9999999), resetAt: text,
  });
  const display = value => fields(value, { matchingReleases: integer(0, 20000), selectedReleases: integer(0, 1000),
    returnedReleases: integer(0, 1000), perRepositoryHiddenReleases: integer(0, 20000), globallyHiddenReleases: integer(0, 1000), globalSelectionLimited: boolean });
  const result = fields(input, { schemaVersion: integer(1, 1), mode: text, generatedAt: text, complete: boolean,
    digestNotice: text, scope, repositories: array(repository, 1, 20), releases: array(release, 0, 1000),
    issues: array(issue, 0, MAX_SNAPSHOT_ISSUES, true) }, { display });
  const global = Object.hasOwn(result.scope, 'totalLimit');
  if (Object.hasOwn(result, 'display') !== global || result.repositories.some(repo =>
    Object.hasOwn(repo, 'selectedReleases') !== global || Object.hasOwn(repo, 'globalSelectionLimited') !== global)) invalid();
  return result;
}

export function serializeSnapshot(report, { token = '', synthetic } = {}) {
  try {
    if (typeof synthetic !== 'boolean' || typeof token !== 'string' || token.length > 4096 || (token && !/^[\x21-\x7e]+$/.test(token))) invalid();
    const projected = projectReport(report, token);
    if (projected.mode !== redact(synthetic ? 'demo' : 'live', token)) invalid();
    const snapshot = { kind: 'crypto-release-radar-snapshot', snapshotVersion: 1, synthetic, report: projected };
    // Projection bounds string content BEFORE stringify. Escaping can expand it
    // by at most six characters per UTF-16 unit, plus bounded keys/formatting.
    const text = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) tooLarge();
    // Also cover keys, container metadata, numbers, boolean literals and escaping.
    // Very short tokens can conservatively match harmless JSON syntax/metadata.
    if (token && text.includes(token)) secret();
    return text;
  } catch (error) {
    // Recreate only our fixed diagnostics, even if a caller's proxy throws an
    // application-shaped error containing arbitrary text.
    if (error instanceof RadarError && error.code === 'snapshot_size') tooLarge();
    if (error instanceof RadarError && error.code === 'snapshot_secret') secret();
    invalid();
  }
}

export function prepareSnapshotWrite(report, options) {
  // Validate/bound before the CLI also formats stdout; retain only immutable
  // checked text in this closure, never a caller-mutable object or exposed buffer.
  const text = serializeSnapshot(report, options);
  return async plan => {
    validateSnapshotPath(plan.target.path);
    await writeOutput(plan, text);
  };
}

export async function writeSnapshot(plan, report, options) {
  // The direct writer has the same validation/secret boundary before temp I/O.
  await prepareSnapshotWrite(report, options)(plan);
}
