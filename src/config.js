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
  for (const repo of value.repositories) {
    if (typeof repo !== 'string' || !repoPattern.test(repo) || ['.', '..'].includes(repo.split('/')[1])) {
      invalid('Each repository must be an owner/repo slug, without a URL or credentials.');
    }
    if (seen.has(repo.toLowerCase())) invalid('Duplicate repository entries are not allowed (case-insensitive).');
    seen.add(repo.toLowerCase());
  }
  const config = { ...DEFAULTS, ...value, repositories: [...value.repositories] };
  for (const [key, min, max] of [['limit', 1, 50], ['maxPages', 1, 10], ['timeoutMs', 100, 30000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      invalid(`${key} must be an integer between ${min} and ${max}.`);
    }
  }
  if (typeof config.includePrereleases !== 'boolean') invalid('includePrereleases must be a boolean.');
  return config;
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
