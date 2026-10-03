import { fetchReleases } from './github.js';
import { compareReleases, normalizeReleases } from './releases.js';
import { DIGEST_NOTICE } from './text.js';
import { parseSince, parseUntil, validateWindowOrder } from './publication-window.js';
import { compileTagPatterns } from './tag-patterns.js';

export async function collectReport(config, { token = '', fetchImpl, demoData, now = () => new Date(), since = null, until = null, tagPatterns = [] } = {}) {
  const sinceUtc = since === null ? null : parseSince(since);
  const untilUtc = until === null ? null : parseUntil(until);
  validateWindowOrder(sinceUtc, untilUtc);
  const tags = compileTagPatterns(tagPatterns);
  const sinceMs = sinceUtc === null ? null : Date.parse(sinceUtc);
  const untilMs = untilUtc === null ? null : Date.parse(untilUtc);
  const releases = [], repositories = [], issues = [];
  let stop = false;
  for (const repo of config.repositories) {
    const result = stop
      ? { items: [], pagesFetched: 0, scanComplete: false, issues: [{ code: 'skipped', message: 'Not requested after an authentication, access, or rate-limit failure.' }] }
      : demoData
        ? { items: demoData[repo] ?? [], pagesFetched: 0, scanComplete: Object.hasOwn(demoData, repo), issues: Object.hasOwn(demoData, repo) ? [] : [{ code: 'demo_missing', message: 'Demo has no data for this repository.' }] }
        : await fetchReleases(repo, config, { token, fetchImpl });
    const normalized = normalizeReleases(result.items, repo, config.includePrereleases, token, tags.matches);
    if (normalized.invalidCount) result.issues.push({ code: 'invalid_record', message: 'Malformed release entries were omitted.', count: normalized.invalidCount });
    if (normalized.duplicateCount) result.issues.push({ code: 'duplicate_release', message: 'Duplicate release IDs were omitted; pagination may have changed during the scan.', count: normalized.duplicateCount });
    const matching = normalized.releases.filter((release) => {
      const publishedMs = Date.parse(release.publishedAt);
      return (sinceMs === null || publishedMs >= sinceMs) && (untilMs === null || publishedMs <= untilMs);
    });
    const selected = matching.sort(compareReleases).slice(0, config.limit);
    const complete = result.scanComplete && result.issues.length === 0;
    repositories.push({ repository: repo, complete, pagesFetched: result.pagesFetched, scannedEntries: result.items.length,
      matchingReleases: matching.length, returnedReleases: selected.length,
      selectionLimited: matching.length > selected.length });
    releases.push(...selected);
    issues.push(...result.issues.map((issue) => ({ repository: repo, ...issue })));
    if (result.issues.some((issue) => ['rate_limited', 'forbidden', 'unauthorized'].includes(issue.code))) stop = true;
  }
  return {
    schemaVersion: 1,
    mode: demoData ? 'demo' : 'live',
    generatedAt: now().toISOString(),
    complete: repositories.every((repo) => repo.complete),
    digestNotice: DIGEST_NOTICE,
    scope: { limitPerRepository: config.limit, includePrereleases: config.includePrereleases, maxPagesPerRepository: config.maxPages, since: sinceUtc, until: untilUtc, tagPatterns: tags.patterns },
    repositories,
    releases: releases.sort(compareReleases),
    issues,
  };
}
