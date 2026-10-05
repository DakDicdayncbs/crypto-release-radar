import { readConfigValue } from './config-file.js';
import { RadarError } from './errors.js';

export const DEFAULTS = Object.freeze({
  limit: 5,
  includePrereleases: false,
  maxPages: 3,
  timeoutMs: 10000,
});

const repoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const keys = new Set(['repositories', 'groups', ...Object.keys(DEFAULTS)]);
const repositoryKeys = new Set(['slug', 'limit', 'includePrereleases']);
// Locations consist only of fixed schema segments and generated numeric indices.
const invalid = (location, message) => { throw new RadarError('invalid_config', `${location}: ${message}`); };
export const MAX_GROUPS = 10;
const validGroupName = name => typeof name === 'string' && name.length >= 1 && name.length <= 32 &&
  /^[a-z]/.test(name) && !/[^a-z0-9-]/.test(name);
const cloneEntry = entry => typeof entry === 'string' ? entry : { ...entry };

function validateRepositoryList(entries, location) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 20) {
    invalid(location, 'Each repository list requires 1–20 explicit owner/repo entries.');
  }
  const seen = new Set();
  return Array.from(entries, (entry, index) => {
    const at = `${location}[${index}]`;
    if (typeof entry !== 'string') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        invalid(at, 'Each repository must be a slug string or an object with a slug field.');
      }
      if (!Object.hasOwn(entry, 'slug')) invalid(`${at}.slug`, 'Repository object requires a slug field.');
      if (Object.keys(entry).some(key => !repositoryKeys.has(key))) {
        invalid(at, 'Repository object contains an unsupported field; see the documented schema.');
      }
      if (Object.hasOwn(entry, 'limit') && (!Number.isInteger(entry.limit) || entry.limit < 1 || entry.limit > 50)) {
        invalid(`${at}.limit`, 'Repository limit must be an integer between 1 and 50.');
      }
      if (Object.hasOwn(entry, 'includePrereleases') && typeof entry.includePrereleases !== 'boolean') {
        invalid(`${at}.includePrereleases`, 'Repository includePrereleases must be a boolean.');
      }
    }
    const repo = typeof entry === 'string' ? entry : entry.slug;
    if (typeof repo !== 'string' || !repoPattern.test(repo) || ['.', '..'].includes(repo.split('/')[1])) {
      invalid(typeof entry === 'string' ? at : `${at}.slug`, 'Each repository must be an owner/repo slug, without a URL or credentials.');
    }
    if (seen.has(repo.toLowerCase())) invalid(typeof entry === 'string' ? at : `${at}.slug`, 'Duplicate repository entries are not allowed (case-insensitive).');
    seen.add(repo.toLowerCase());
    return cloneEntry(entry);
  });
}

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('$', 'Config must be a JSON object.');
  }
  if (Object.keys(value).some((key) => !keys.has(key))) {
    invalid('$', 'Config contains an unsupported field; see the documented schema.');
  }
  const config = { ...DEFAULTS, ...value, repositories: validateRepositoryList(value.repositories, '$.repositories') };
  if (Object.hasOwn(value, 'groups')) {
    if (!value.groups || typeof value.groups !== 'object' || Array.isArray(value.groups) || Object.keys(value.groups).length > MAX_GROUPS) {
      invalid('$.groups', 'groups must be an object with at most 10 named repository lists.');
    }
    config.groups = Object.fromEntries(Object.entries(value.groups).map(([name, entries], index) => {
      if (!validGroupName(name)) invalid(`$.groups[${index}].name`, 'Group names must be 1–32 lowercase ASCII letters, digits or hyphens, starting with a letter.');
      return [name, validateRepositoryList(entries, `$.groups[${index}].entries`)];
    }));
  }
  for (const [key, min, max] of [['limit', 1, 50], ['maxPages', 1, 10], ['timeoutMs', 100, 30000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      invalid(`$.${key}`, `${key} must be an integer between ${min} and ${max}.`);
    }
  }
  if (typeof config.includePrereleases !== 'boolean') invalid('$.includePrereleases', 'includePrereleases must be a boolean.');
  return config;
}

export function validateGroupSelection(names = []) {
  if (!Array.isArray(names) || names.length > MAX_GROUPS) throw new RadarError('usage', 'Select at most 10 groups. See --help.');
  const seen = new Set();
  return Array.from(names, name => {
    if (!validGroupName(name)) throw new RadarError('usage', 'Group names must be 1–32 lowercase ASCII letters, digits or hyphens, starting with a letter.');
    if (seen.has(name)) throw new RadarError('usage', 'Repeated group selection is not allowed.');
    seen.add(name);
    return name;
  });
}

// Config definitions are already validated, including groups not selected here.
export function selectRepositoryGroups(config, names = []) {
  const groups = validateGroupSelection(names);
  if (!groups.length) return { groups, repositories: config.repositories.map(cloneEntry) };
  const repositories = [], seen = new Set();
  for (const name of groups) {
    if (!Object.hasOwn(config.groups ?? {}, name)) throw new RadarError('usage', 'Selected group is not defined in the config.');
    for (const entry of config.groups[name]) {
      const slug = (typeof entry === 'string' ? entry : entry.slug).toLowerCase();
      if (seen.has(slug)) throw new RadarError('usage', 'Selected groups overlap: duplicate repository slugs are not allowed, even with identical policies.');
      if (repositories.length === 20) throw new RadarError('usage', 'Selected groups exceed the total budget of 20 repositories.');
      seen.add(slug);
      repositories.push(cloneEntry(entry));
    }
  }
  return { groups, repositories };
}

// Config is validated before overrides are applied; false is an explicit policy.
export function resolveRepositoryPolicies(config, { limit, includePrereleases } = {}) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    throw new RadarError('usage', '--limit must be an integer between 1 and 50.');
  }
  if (includePrereleases !== undefined && typeof includePrereleases !== 'boolean') {
    throw new RadarError('usage', 'Prerelease override must be a boolean.');
  }
  return config.repositories.map(entry => ({
    repository: typeof entry === 'string' ? entry : entry.slug,
    limit: limit ?? (typeof entry === 'string' ? undefined : entry.limit) ?? config.limit,
    includePrereleases: includePrereleases ?? (typeof entry === 'string' ? undefined : entry.includePrereleases) ?? config.includePrereleases,
  }));
}

export async function readConfig(path) {
  return validateConfig(await readConfigValue(path));
}
