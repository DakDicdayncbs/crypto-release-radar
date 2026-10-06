import { DIGEST_NOTICE } from '../src/text.js';

export const normalReport = {
  schemaVersion: 1, mode: 'live', generatedAt: '2026-10-06T09:30:00.000Z', complete: true,
  digestNotice: DIGEST_NOTICE,
  scope: { limitPerRepository: 1, includePrereleases: false, maxPagesPerRepository: 3, since: null, until: null, tagPatterns: [], groups: [] },
  repositories: [{ repository: 'demo/one', policy: { limit: 1, includePrereleases: false }, requested: true, complete: true,
    pagesFetched: 1, scannedEntries: 2, matchingReleases: 2, returnedReleases: 1, selectionLimited: true }],
  releases: [{ repository: 'demo/one', id: 2, name: 'Release two', tag: 'v2', publishedAt: '2026-10-05T12:00:00.000Z',
    prerelease: false, url: 'https://github.com/demo/one/releases/tag/v2', digest: { text: 'Fixed search.', truncated: false } }],
  issues: [],
};

export const emptyReport = structuredClone(normalReport);
emptyReport.releases = [];
Object.assign(emptyReport.repositories[0], { scannedEntries: 0, matchingReleases: 0, returnedReleases: 0, selectionLimited: false });

export const partialReport = structuredClone(normalReport);
partialReport.complete = false;
partialReport.scope.maxPagesPerRepository = 1;
partialReport.repositories[0].complete = false;
partialReport.issues = [{ repository: 'demo/one', code: 'page_limit', message: 'Page budget reached; newer releases may exist outside the retrieved pages.' }];
