const cell = (value) => String(value).replace(/\|/g, '¦');

export function formatReport(report, format) {
  if (format === 'json') return JSON.stringify(report, null, 2) + '\n';
  const lines = [
    `Crypto Release Radar — ${report.mode === 'demo' ? 'SYNTHETIC DEMO' : 'GitHub releases'}`,
    `Result: ${report.complete ? 'complete scan' : 'INCOMPLETE scan'} | ${report.releases.length} selected releases | ${report.generatedAt}`,
    report.digestNotice,
    report.scope.since
      ? `Publication filter: published_at >= ${report.scope.since} (inclusive)`
      : 'Publication filter: none (--since not set)',
    '',
    'Repository | Tag | Name | Published (UTC) | Prerelease | Source',
    '--- | --- | --- | --- | --- | ---',
    ...report.releases.map((r) => [r.repository, r.tag, r.name, r.publishedAt, r.prerelease ? 'yes' : 'no', r.url].map(cell).join(' | ')),
  ];
  if (!report.releases.length) lines.push('(No matching releases in the retrieved data.)');
  for (const release of report.releases) lines.push('', `${release.repository} ${release.tag} — excerpt: ${release.digest.text}`);
  lines.push('', 'Repository scan status:');
  for (const repo of report.repositories) {
    lines.push(`${repo.repository}: ${repo.complete ? 'complete' : 'INCOMPLETE'}; ${repo.scannedEntries} entries scanned; ${repo.returnedReleases}/${repo.matchingReleases} matching releases shown${repo.selectionLimited ? ' (display limit)' : ''}`);
  }
  if (!report.complete) lines.push('', 'Results cover retrieved pages only. Newest releases outside those pages may be missing.');
  return lines.join('\n') + '\n';
}

export function formatIssues(issues) {
  return issues.map((issue) => {
    const details = [issue.status && `HTTP ${issue.status}`, issue.count && `count ${issue.count}`,
      issue.retryAfterSeconds !== undefined && `retry after ${issue.retryAfterSeconds}s`, issue.resetAt && `reset ${issue.resetAt}`].filter(Boolean);
    return `${issue.repository ? issue.repository + ': ' : ''}${issue.code}: ${issue.message}${details.length ? ' (' + details.join('; ') + ')' : ''}\n`;
  }).join('');
}
