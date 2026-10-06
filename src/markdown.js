import { cleanText } from './text.js';
import { sourceUrl } from './releases.js';

// Literal inline text only: never interpolate untrusted Markdown or HTML.
// Entities also interrupt GFM's bare URL/email autolink syntax.
export function markdownText(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', ':': '&#58;', '.': '&#46;', '@': '&#64;' };
  return cleanText(String(value), Infinity).replace(/[!-/:-@\[-`{-~]/g, char => entities[char] ?? '\\' + char);
}

export function markdownSource(url, repository, label) {
  // Never reconstruct a pre-redaction URL or turn a placeholder into a link.
  const safe = !url.includes('[REDACTED]') && !repository.includes('[REDACTED]') && sourceUrl(url, repository);
  if (!safe) return `Link unavailable after validation/redaction: ${markdownText(url)}`;
  // Keep valid percent escapes, encode stray percent signs and Markdown delimiters.
  const destination = safe.replace(/%(?![0-9a-f]{2})/gi, '%25')
    .replace(/[^A-Za-z0-9%/:._~-]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  return `[${markdownText(label)}](${destination})`;
}

const yesNo = value => value ? 'yes' : 'no';
const prereleases = value => value ? 'included' : 'excluded';

export function formatMarkdown(report) {
  const matching = report.repositories.reduce((sum, repo) => sum + repo.matchingReleases, 0);
  const selected = report.repositories.reduce((sum, repo) => sum + (repo.selectedReleases ?? repo.returnedReleases), 0);
  const lines = [
    '# Crypto Release Radar', '',
    `Mode: **${report.mode === 'demo' ? 'SYNTHETIC DEMO — fictional data and source links' : 'GitHub releases'}**`, '',
    `Generated at (UTC): ${markdownText(report.generatedAt)}`, '',
    `**Result: ${report.complete ? 'COMPLETE' : 'INCOMPLETE'} scan | ${report.releases.length} shown releases**`, '',
    report.complete
      ? 'Completeness covers this scan; releases can change during pagination.'
      : '**Results cover retrieved pages only. Newest releases outside those pages may be missing.**', '',
    markdownText(report.digestNotice), '',
    '## Query and display', '',
    `- Repository selection: ${report.scope.groups.length ? 'groups ' + markdownText(JSON.stringify(report.scope.groups)) : report.mode === 'demo' ? 'synthetic demo repositories' : 'configured repositories'}.`,
    `- Published from (inclusive): ${report.scope.since === null ? 'unbounded' : markdownText(report.scope.since)}.`,
    `- Published through (inclusive): ${report.scope.until === null ? 'unbounded' : markdownText(report.scope.until)}.`,
    `- Tag patterns (OR, whole original tag): ${report.scope.tagPatterns.length ? markdownText(JSON.stringify(report.scope.tagPatterns)) : 'none'}.`,
    '- Drafts: excluded.',
    `- Prereleases: ${report.scope.includePrereleases === null ? 'varies by repository (see policies below)' : prereleases(report.scope.includePrereleases)}.`,
    `- Per-repository display limit: ${report.scope.limitPerRepository ?? 'varies (see policies below)'}.`,
    `- Page budget per repository: ${report.scope.maxPagesPerRepository}.`,
    `- Total display limit: ${report.scope.totalLimit ?? 'not set'}.`,
    `- Matching: ${matching}; after per-repository limits: ${selected}; shown: ${report.releases.length}.`,
    `- Hidden by per-repository limits: ${matching - selected}; hidden by total limit: ${selected - report.releases.length}.`, '',
    'Counts describe retrieved data only; display truncation does not change scan completeness.', '',
    '## Releases', '',
  ];
  if (!report.releases.length) lines.push(report.complete
    ? 'No matching releases in the retrieved data.'
    : '**No matching releases in the retrieved data. This incomplete scan does not establish that the repositories have no releases.**', '');
  for (const release of report.releases) {
    lines.push(
      `### ${markdownText(release.repository)} — ${markdownText(release.name)}`, '',
      `- Tag: ${markdownText(release.tag)}.`,
      `- Release ID: ${release.id}.`,
      `- Published at (UTC): ${markdownText(release.publishedAt)}.`,
      `- Prerelease: ${yesNo(release.prerelease)}.`,
      `- Source: ${markdownSource(release.url, release.repository, 'GitHub release ' + release.tag)}`, '',
      `Automatic excerpt (not verified; truncated: ${yesNo(release.digest.truncated)}): ${markdownText(release.digest.text)}`, '',
    );
  }
  lines.push('## Repository scan status', '');
  for (const repo of report.repositories) {
    const retained = repo.selectedReleases ?? repo.returnedReleases;
    lines.push(
      `### ${markdownText(repo.repository)}`, '',
      `- Status: **${repo.complete ? 'COMPLETE' : 'INCOMPLETE'}**; API requested: ${yesNo(repo.requested)}.`,
      `- Pages fetched: ${repo.pagesFetched} / ${report.scope.maxPagesPerRepository}; entries scanned: ${repo.scannedEntries}.`,
      `- Policy: per-repository limit ${repo.policy.limit}; prereleases ${prereleases(repo.policy.includePrereleases)}.`,
      `- Matches: ${repo.matchingReleases}; after per-repository limit: ${retained}; shown: ${repo.returnedReleases}.`,
      `- Hidden by per-repository limit: ${repo.matchingReleases - retained}; hidden by total limit: ${retained - repo.returnedReleases}.`, '',
    );
  }
  lines.push('## Issues', '');
  if (!report.issues.length) lines.push('None.');
  for (const issue of report.issues) {
    const details = [
      issue.status !== undefined && `HTTP ${issue.status}`,
      issue.count !== undefined && `count ${issue.count}`,
      issue.retryAfterSeconds !== undefined && `retry after ${issue.retryAfterSeconds}s`,
      issue.resetAt !== undefined && `reset ${issue.resetAt}`,
    ].filter(value => value !== false);
    lines.push(`- **${markdownText(issue.code)}**${issue.repository ? ' — ' + markdownText(issue.repository) : ''}: ${markdownText(issue.message)}${details.length ? ' (' + markdownText(details.join('; ')) + ')' : ''}`);
  }
  return lines.join('\n') + '\n';
}
