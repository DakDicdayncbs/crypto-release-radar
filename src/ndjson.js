// Serialize only normalized, redacted report fields. Collection finishes before
// this formatter runs; record boundaries never change selection or request order.
const project = (value, keys) => Object.fromEntries(keys
  .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

export function formatNdjson(report) {
  const metadata = {
    type: 'metadata', ndjsonVersion: 1,
    ...project(report, ['schemaVersion', 'mode', 'generatedAt', 'complete', 'digestNotice']),
    scope: project(report.scope, ['limitPerRepository', 'includePrereleases', 'maxPagesPerRepository',
      'since', 'until', 'tagPatterns', 'groups', 'totalLimit']),
  };
  if (report.display) metadata.display = project(report.display, ['matchingReleases', 'selectedReleases',
    'returnedReleases', 'perRepositoryHiddenReleases', 'globallyHiddenReleases', 'globalSelectionLimited']);
  const records = [metadata];
  for (const repo of report.repositories) records.push({ type: 'repository', repository: {
    ...project(repo, ['repository', 'requested', 'complete', 'pagesFetched', 'scannedEntries',
      'matchingReleases', 'returnedReleases', 'selectionLimited', 'selectedReleases', 'globalSelectionLimited']),
    policy: project(repo.policy, ['limit', 'includePrereleases']),
  } });
  for (const release of report.releases) records.push({ type: 'release', release: {
    ...project(release, ['repository', 'id', 'name', 'tag', 'publishedAt', 'prerelease', 'url']),
    digest: project(release.digest, ['text', 'truncated']),
  } });
  for (const issue of report.issues) records.push({ type: 'issue', issue: project(issue,
    ['repository', 'code', 'message', 'status', 'count', 'retryAfterSeconds', 'resetAt']) });
  records.push({ type: 'summary', ndjsonVersion: 1, documentComplete: true, scanComplete: report.complete,
    counts: { records: records.length + 1, repositories: report.repositories.length,
      releases: report.releases.length, issues: report.issues.length } });
  return records.map(record => JSON.stringify(record) + '\n').join('');
}
