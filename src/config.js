import { readFile } from 'node:fs/promises';
import { RadarError } from './errors.js';

export const DEFAULTS = Object.freeze({
  limit: 5,
  includePrereleases: false,
  maxPages: 3,
  timeoutMs: 10000,
});

const repoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const keys = new Set(['repositories', ...Object.keys(DEFAULTS)]);
const repositoryKeys = new Set(['slug', 'limit', 'includePrereleases']);
const invalid = (message) => { throw new RadarError('invalid_config', message); };

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Config must be a JSON object.');
  }
  if (Object.keys(value).some((key) => !keys.has(key))) {
    invalid('Config contains an unsupported field; see the documented schema.');
  }
  if (!Array.isArray(value.repositories) || value.repositories.length < 1 || value.repositories.length > 20) {
    invalid('Config requires 1–20 explicit owner/repo entries in repositories.');
  }
  const seen = new Set();
  const repositories = Array.from(value.repositories, (entry) => {
    if (typeof entry !== 'string') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.hasOwn(entry, 'slug')) {
        invalid('Each repository must be a slug string or an object with a slug field.');
      }
      if (Object.keys(entry).some(key => !repositoryKeys.has(key))) {
        invalid('Repository object contains an unsupported field; see the documented schema.');
      }
      if (Object.hasOwn(entry, 'limit') && (!Number.isInteger(entry.limit) || entry.limit < 1 || entry.limit > 50)) {
        invalid('Repository limit must be an integer between 1 and 50.');
      }
      if (Object.hasOwn(entry, 'includePrereleases') && typeof entry.includePrereleases !== 'boolean') {
        invalid('Repository includePrereleases must be a boolean.');
      }
    }
    const repo = typeof entry === 'string' ? entry : entry.slug;
    if (typeof repo !== 'string' || !repoPattern.test(repo) || ['.', '..'].includes(repo.split('/')[1])) {
      invalid('Each repository must be an owner/repo slug, without a URL or credentials.');
    }
    if (seen.has(repo.toLowerCase())) invalid('Duplicate repository entries are not allowed (case-insensitive).');
    seen.add(repo.toLowerCase());
    return typeof entry === 'string' ? entry : { ...entry };
  });
  const config = { ...DEFAULTS, ...value, repositories };
  for (const [key, min, max] of [['limit', 1, 50], ['maxPages', 1, 10], ['timeoutMs', 100, 30000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      invalid(`${key} must be an integer between ${min} and ${max}.`);
    }
  }
  if (typeof config.includePrereleases !== 'boolean') invalid('includePrereleases must be a boolean.');
  return config;
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
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch { throw new RadarError('config_read', 'Cannot read config file. Pass --config with a readable JSON file.'); }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new RadarError('invalid_config', 'Config is not valid JSON.'); }
  return validateConfig(value);
}
