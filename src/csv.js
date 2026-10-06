export const CSV_COLUMNS = Object.freeze([
  'row_type', 'csv_version', 'report_schema_version', 'mode', 'generated_at', 'complete', 'digest_notice',
  'since', 'until', 'tag_patterns', 'groups', 'limit_per_repository', 'include_prereleases',
  'max_pages_per_repository', 'total_limit', 'repository', 'requested', 'pages_fetched', 'scanned_entries',
  'matching_releases', 'selected_releases', 'returned_releases', 'per_repository_hidden_releases',
  'globally_hidden_releases', 'selection_limited', 'global_selection_limited',
  'release_id', 'name', 'tag', 'published_at', 'prerelease', 'url', 'digest_text', 'digest_truncated',
  'issue_code', 'issue_message', 'http_status', 'issue_count', 'retry_after_seconds', 'reset_at',
]);

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string') {
    // Inspect leading whitespace/control/format characters without removing them.
    const prefix = text.match(/^[\p{White_Space}\p{Cc}\p{Cf}]*/u)[0];
    if (/[=+\-@＝＋－＠]/u.test(text.charAt(prefix.length)) || /[\t\r\n]/u.test(prefix)) text = "'" + text;
  }
  // Quoting and doubled quotes keep delimiters and all embedded CR/LF in one cell.
  return '"' + text.replace(/"/g, '""') + '"';
}

const csvRow = values => CSV_COLUMNS.map(column => csvCell(values[column])).join(',');

export function formatCsv(report) {
  const matching = report.repositories.reduce((sum, repo) => sum + repo.matchingReleases, 0);
  const selected = report.repositories.reduce((sum, repo) => sum + (repo.selectedReleases ?? repo.returnedReleases), 0);
  // Explicit projections: no raw responses, unknown fields or incidental metadata.
  const rows = [CSV_COLUMNS.map(csvCell).join(','), csvRow({
    row_type: 'report', csv_version: 1, report_schema_version: report.schemaVersion,
    mode: report.mode, generated_at: report.generatedAt, complete: report.complete, digest_notice: report.digestNotice,
    since: report.scope.since, until: report.scope.until, tag_patterns: JSON.stringify(report.scope.tagPatterns),
    groups: JSON.stringify(report.scope.groups), limit_per_repository: report.scope.limitPerRepository,
    include_prereleases: report.scope.includePrereleases, max_pages_per_repository: report.scope.maxPagesPerRepository,
    total_limit: report.scope.totalLimit, matching_releases: matching, selected_releases: selected,
    returned_releases: report.releases.length, per_repository_hidden_releases: matching - selected,
    globally_hidden_releases: selected - report.releases.length, selection_limited: matching > selected,
    global_selection_limited: selected > report.releases.length,
  })];
  for (const repo of report.repositories) {
    const retained = repo.selectedReleases ?? repo.returnedReleases;
    rows.push(csvRow({
      row_type: 'repository', repository: repo.repository, complete: repo.complete, requested: repo.requested,
      limit_per_repository: repo.policy.limit, include_prereleases: repo.policy.includePrereleases,
      max_pages_per_repository: report.scope.maxPagesPerRepository, pages_fetched: repo.pagesFetched,
      scanned_entries: repo.scannedEntries, matching_releases: repo.matchingReleases, selected_releases: retained,
      returned_releases: repo.returnedReleases, per_repository_hidden_releases: repo.matchingReleases - retained,
      globally_hidden_releases: retained - repo.returnedReleases, selection_limited: repo.selectionLimited,
      global_selection_limited: retained > repo.returnedReleases,
    }));
  }
  for (const release of report.releases) rows.push(csvRow({
    row_type: 'release', repository: release.repository, release_id: release.id, name: release.name, tag: release.tag,
    published_at: release.publishedAt, prerelease: release.prerelease, url: release.url,
    digest_text: release.digest.text, digest_truncated: release.digest.truncated,
  }));
  for (const issue of report.issues) rows.push(csvRow({
    row_type: 'issue', repository: issue.repository, issue_code: issue.code, issue_message: issue.message,
    http_status: issue.status, issue_count: issue.count, retry_after_seconds: issue.retryAfterSeconds, reset_at: issue.resetAt,
  }));
  return rows.join('\r\n') + '\r\n';
}
