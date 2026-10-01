import { cleanText, digest, redact } from './text.js';

export function publishedDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, min, s, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > days || +h > 23 || +min > 59 || +s > 59) return null;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function sourceUrl(value, repo) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const prefix = `/${repo}/releases/`.toLowerCase();
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash ||
        !url.pathname.toLowerCase().startsWith(prefix) || url.pathname.length <= prefix.length) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeReleases(items, repo, includePrereleases, secret = '') {
  const releases = [];
  let invalidCount = 0, duplicateCount = 0;
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.draft !== 'boolean') {
      invalidCount++; continue;
    }
    if (item.draft) continue;
    const publishedAt = publishedDate(item.published_at);
    const url = sourceUrl(item.html_url, repo);
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.prerelease !== 'boolean' ||
        typeof item.tag_name !== 'string' || !cleanText(item.tag_name) || item.tag_name.length > 1024 ||
        !(item.name === null || typeof item.name === 'string') ||
        !(item.body === null || typeof item.body === 'string') || !publishedAt || !url) {
      invalidCount++; continue;
    }
    if (ids.has(item.id)) { duplicateCount++; continue; }
    ids.add(item.id);
    if (item.prerelease && !includePrereleases) continue;
    const tag = cleanText(redact(item.tag_name, secret), 200);
    releases.push({
      repository: repo,
      id: item.id,
      name: cleanText(redact(item.name ?? '', secret), 200) || tag,
      tag,
      publishedAt,
      prerelease: item.prerelease,
      url: redact(url, secret),
      digest: digest(redact(item.body ?? '', secret)),
    });
  }
  return { releases, invalidCount, duplicateCount };
}

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function compareReleases(a, b) {
  return Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
    compareText(a.repository, b.repository) || b.id - a.id;
}
