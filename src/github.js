import { RadarError, safeError } from './errors.js';

export const API_ORIGIN = 'https://api.github.com';
export const API_VERSION = '2026-03-10';
export const PAGE_SIZE = 100;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function retryDetails(headers) {
  const details = {};
  const retry = headers.get('retry-after');
  if (retry && /^\d{1,7}$/.test(retry)) details.retryAfterSeconds = Number(retry);
  const reset = headers.get('x-ratelimit-reset');
  if (reset && /^\d{1,12}$/.test(reset)) details.resetAt = new Date(Number(reset) * 1000).toISOString();
  return details;
}

function httpIssue(response) {
  const status = response.status;
  if (status === 429 || (status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    return { code: 'rate_limited', message: 'GitHub rate limit reached. Stop and retry later.', status, ...retryDetails(response.headers) };
  }
  const known = {
    401: ['unauthorized', 'GitHub rejected authentication. Check GITHUB_TOKEN.'],
    403: ['forbidden', 'GitHub denied access; permissions or a secondary rate limit may be responsible. Retry later or check access.'],
    404: ['not_found', 'Repository not found or not accessible with the current credentials.'],
  };
  const [code, message] = known[status] ?? (status >= 300 && status < 400
    ? ['redirect_refused', 'GitHub returned a redirect. Verify the configured repository slug; redirects are not followed.']
    : ['http_error', 'GitHub returned an unsuccessful HTTP status.']);
  return { code, message, status };
}

function hasNextPage(link, endpoint, page, count) {
  if (!link) return count === PAGE_SIZE; // Probe full pages when pagination metadata is absent.
  const parts = link.split(',');
  let next = false;
  for (const part of parts) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([a-z ]+)"\s*$/.exec(part);
    if (!match) throw new RadarError('invalid_pagination', 'GitHub returned invalid pagination metadata.');
    if (!match[2].split(' ').includes('next')) continue;
    if (next) throw new RadarError('invalid_pagination', 'GitHub returned duplicate next-page links.');
    let url;
    try { url = new URL(match[1]); } catch { throw new RadarError('invalid_pagination', 'GitHub returned an invalid next-page URL.'); }
    if (url.origin !== API_ORIGIN || url.username || url.password || url.pathname !== endpoint || url.hash ||
        url.searchParams.getAll('page').length !== 1 || url.searchParams.get('page') !== String(page + 1) ||
        url.searchParams.getAll('per_page').length !== 1 || url.searchParams.get('per_page') !== String(PAGE_SIZE) ||
        [...url.searchParams.keys()].some((key) => !['page', 'per_page'].includes(key))) {
      throw new RadarError('invalid_pagination', 'GitHub returned an unexpected next-page URL.');
    }
    next = true;
  }
  return next;
}

async function readJson(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(type)) {
    await response.body?.cancel();
    throw new RadarError('invalid_response', 'GitHub returned a non-JSON response.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RadarError('response_too_large', 'GitHub response exceeds the 4 MiB page limit.');
  }
  if (!response.body) throw new RadarError('invalid_response', 'GitHub returned an empty response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RadarError('response_too_large', 'GitHub response exceeds the 4 MiB page limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RadarError('invalid_response', 'GitHub returned malformed JSON or invalid UTF-8.'); }
  if (!Array.isArray(value) || value.length > PAGE_SIZE) {
    throw new RadarError('invalid_response', 'GitHub release response must be an array of at most 100 entries.');
  }
  return value;
}

// fetchImpl is an internal test seam; the CLI has no alternate host/base URL option.
export async function fetchReleases(repo, config, { token = '', fetchImpl = fetch } = {}) {
  const endpoint = `/repos/${repo}/releases`;
  const items = [], issues = [];
  let pagesFetched = 0, scanComplete = false;
  for (let page = 1; page <= config.maxPages; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'crypto-release-radar/0.1.0',
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetchImpl(`${API_ORIGIN}${endpoint}?per_page=${PAGE_SIZE}&page=${page}`, {
        method: 'GET', headers, redirect: 'manual', signal: controller.signal,
      });
      if (response.status !== 200) {
        issues.push(httpIssue(response));
        await response.body?.cancel();
        break;
      }
      const records = await readJson(response);
      pagesFetched++;
      items.push(...records);
      const next = hasNextPage(response.headers.get('link'), endpoint, page, records.length);
      if (!next) { scanComplete = true; break; }
      if (records.length === 0) throw new RadarError('invalid_pagination', 'GitHub returned an empty page with a next-page link.');
      if (page === config.maxPages) {
        issues.push({ code: 'page_limit', message: 'Page budget reached; additional releases may exist. Increase maxPages to scan further.' });
      }
    } catch (error) {
      issues.push(controller.signal.aborted
        ? { code: 'timeout', message: 'GitHub request timed out before the complete page was received.' }
        : error instanceof RadarError ? safeError(error)
          : { code: 'network_error', message: 'GitHub request or response transfer failed. Check connectivity and retry.' });
      break;
    } finally { clearTimeout(timer); }
  }
  return { items, pagesFetched, scanComplete, issues };
}
