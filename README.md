# Crypto Release Radar

A small Node.js 22+ CLI that reads an explicit repository list and turns published
GitHub releases into a table or JSON report. No runtime or development dependencies.

It shows the repository, release name, tag, publication time in UTC, prerelease
flag, source link, and a short automatic excerpt of the release notes. It never
claims that an excerpt is a verified breaking-change or security assessment.

Version **0.1.0** is the initial baseline for
[DakDicdayncbs/crypto-release-radar](https://github.com/DakDicdayncbs/crypto-release-radar).
Commits use the account's GitHub noreply email. The package is deliberately
`private: true` to prevent accidental npm publication.

## Quick start

Run these commands from the `crypto-release-radar` project directory:

```sh
node --version  # 22 or newer
npm ci --ignore-scripts --offline --no-audit --no-fund
npm test
npm run demo
node bin/crypto-release-radar.js --demo --format json --include-prereleases
```

The demo never uses the network or reads a token. All entries under `radar-demo/*`
in [the fixture](fixtures/demo-releases.json) are fictional, including their links.
They demonstrate draft filtering, prereleases, missing notes, and timezone sorting.

For real public repositories:

```sh
node bin/crypto-release-radar.js --config examples/repos.json
node bin/crypto-release-radar.js --config examples/repos.json --format json
```

The [example config](examples/repos.json) includes Bitcoin, Geth, and Foundry.
These are example inputs, not endorsements or investment recommendations.
Results depend on live GitHub data. Large histories can exceed the scan budget;
the report and exit status make that visible.

## Configuration

```json
{
  "repositories": ["bitcoin/bitcoin", "ethereum/go-ethereum"],
  "limit": 5,
  "includePrereleases": false,
  "maxPages": 3,
  "timeoutMs": 10000
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `repositories` | required | 1–20 explicit `owner/repo` strings; no URLs, duplicates, or discovery |
| `limit` | `5` | 1–50 displayed releases **per repository**, after filtering and UTC sorting |
| `includePrereleases` | `false` | Include records GitHub labels as prereleases |
| `maxPages` | `3` | 1–10 pages per repository, 100 records per page |
| `timeoutMs` | `10000` | 100–30000 ms for each complete HTTP page, including its body |

Unknown config keys are rejected, including embedded tokens and alternate hosts.
The CLI uses `radar.config.json` by default; that local file is ignored by Git.
Repository names are compared case-insensitively for duplicates.

```text
--config PATH             Config file
--format table|json       Table by default
--include-prereleases     Override config to include prereleases
--limit NUMBER            Override display limit per repository
--since TIMESTAMP         Inclusive publication lower bound (CLI only)
--until TIMESTAMP         Inclusive publication upper bound (CLI only)
--demo                    Use bundled synthetic data (cannot combine with --config)
--help                    Usage
--version                 Version
```

There are no positional arguments, token flags, custom API URLs, telemetry,
notifications, downloads, or background jobs.

## Publication windows

`--since` keeps releases whose `published_at` instant is **greater than or equal
to** the lower bound. `--until` keeps releases **less than or equal to** the upper
bound. Either option works alone; together they select the closed interval
`[since, until]`, including **both endpoints**. Equal bounds select only that exact
instant. A lower bound later than the upper bound is a safe usage error (exit `2`),
detected before reading configuration or a token, or making any GitHub request.

Both options work with live repositories and the synthetic demo. Records are
validated and draft/prerelease policies applied before the publication filter,
sorting and display limits. These options are CLI-only: neither `since` nor `until`
is accepted as a JSON config field.

```sh
node bin/crypto-release-radar.js --config examples/repos.json --since 2026-09-29T19:30:00Z
node bin/crypto-release-radar.js --demo --since 2026-09-29T22:30:00+03:00 --format json --include-prereleases
```

The timestamps above represent the same lower bound. Use explicit endpoints to
repeat a date window, such as all publication instants on September 29 UTC:

```sh
node bin/crypto-release-radar.js --config examples/repos.json --since 2026-09-29T00:00:00Z --until 2026-09-29T23:59:59.999Z --format json
node bin/crypto-release-radar.js --demo --since 2026-09-29T03:00:00+03:00 --until 2026-09-30T02:59:59.999+03:00 --format json
node bin/crypto-release-radar.js --demo --until 2026-09-29T19:30:00Z
```

The first two commands use equivalent boundaries with different data sources.
The third has no lower bound and includes releases exactly at the upper bound.
Adjacent closed windows that share an endpoint both include releases at that
instant. For consecutive UTC days, use each day's `00:00:00.000` through
`23:59:59.999` as shown above.

Both options accept the same deliberately limited
[RFC 3339](https://www.rfc-editor.org/rfc/rfc3339.html#section-5.6)/ISO timestamp:
`YYYY-MM-DDTHH:mm:ss[.sss](Z|+HH:mm|-HH:mm)`.

- Use uppercase `T` and `Z`, required seconds, and either `Z` or a numeric offset.
  Offset hours are `00–23`, minutes `00–59`; `+00:00` is accepted. The unknown-offset
  notation `-00:00` is not supported.
- Years must be `1970–9999` both in the input and after UTC conversion. Calendar
  dates must exist, including leap-year rules. Hours are `00–23`; minutes and
  seconds are `00–59`. Leap seconds and `24:00` are not supported.
- Fractional seconds are optional; when present, supply **1–3 digits**. `.1` becomes
  `.100`, `.12` becomes `.120`, and `.123` stays exact. More digits are rejected,
  never rounded or truncated. Reports normalize the value to UTC with three digits:
  `YYYY-MM-DDTHH:mm:ss.sssZ`.
- Whitespace, trailing text, missing zones/values, and repeated options are rejected
  with a safe usage error (exit `2`) before configuration/token access or any GitHub
  request. Input is not echoed.

Comparison does not depend on the computer's local timezone. JSON exposes the
effective UTC bounds in `scope.since` and `scope.until`, each `null` when absent;
the table labels the active bounds as inclusive, or shows that no publication
filter is set. `matchingReleases` counts records after all filters;
`selectionLimited` compares that count with the displayed count, and
`scannedEntries` still includes all retrieved entries.

A publication window **does not guarantee completeness or freeze GitHub data**.
It makes the filter repeatable, but releases can be added, edited, or removed
between runs or during pagination. The CLI still scans every page within the
existing budget, even if a page contains only older or newer releases. Filtering
an incomplete scan to zero releases preserves its issues, `complete: false`, and
exit `1`, including invalid records and duplicates outside the window. A valid
complete scan with no matches exits `0`; all existing exit codes remain unchanged.
Omitting `--until` preserves the existing `--since` selection; omitting both bounds
preserves the unfiltered publication-time selection.

## Authentication and network behavior

Public releases work without authentication. If needed, supply an existing token
through `GITHUB_TOKEN` in the process environment using your usual secure method.
The CLI does not read `.env`, GitHub CLI credentials, Git settings, or token files.
Never put a token in config, command-line arguments, fixtures, or captured output.

Requests are sequential `GET` calls only to
`https://api.github.com/repos/{owner}/{repo}/releases`, with GitHub's JSON media
type and API version `2026-03-10`. Redirects are refused even for renamed repos;
update the explicit slug if a redirect is reported. Pagination URLs are validated
against the same endpoint and requests are reconstructed locally. Responses are
capped at 4 MiB per page, including decompressed streamed bodies.

GitHub documents public access and the optional fine-grained token permission
`Contents: read` in [List releases](https://docs.github.com/en/rest/releases/releases#list-releases).
The pinned version is listed in [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions).
No account credentials are created or modified by this project.

## Completeness, sorting, and output

Drafts are always excluded. Prereleases follow the config/CLI setting. Records
are sorted by the **instant** in `published_at`, then repository and numeric
release ID for deterministic ties. The output uses UTC ISO timestamps. Tag
numbers, API page order, and `created_at` do not determine the sort order.

The CLI scans every page within its budget before choosing the display subset;
it does not stop as soon as `limit` is reached. The GitHub list endpoint's
`Link` header controls pagination. A full page without that header triggers a
conservative next-page probe. See [GitHub pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api).

- `complete: true` means every configured repository reached the end of the
  accessible release list without detected errors. It is not a snapshot guarantee:
  releases can change while pagination is in progress.
- `selectionLimited: true` means a complete or partial scan had more matching
  releases than the requested **display** limit. This alone is not an error.
- `complete: false` means a page budget, request failure, invalid response/record,
  or duplicate release ID made the scan incomplete. Valid records from received
  pages remain available, but newer releases may exist outside those pages.
- An empty complete result means no matching accessible releases. An empty
  incomplete result does not mean the repository has no releases.

JSON contains `schemaVersion`, `mode`, `generatedAt`, `complete`, `digestNotice`,
`scope`, per-repository scan metadata, `releases`, and `issues`. Individual releases
contain `repository`, `id`, `name`, `tag`, `publishedAt`, `prerelease`, `url`, and
`digest: { text, truncated }`. Nullable names fall back to the tag. Issues have
stable codes and optional `status`, `count`, `retryAfterSeconds`, or `resetAt`.

Output goes to stdout. Diagnostics always go to stderr; JSON also embeds them in
`issues`. Use the direct `node` command when piping JSON, because `npm run` adds
its own script banner. Fatal config/local errors produce a smaller JSON error
envelope when valid arguments selected JSON; argument parsing failures go to stderr.

| Exit | Meaning |
| --- | --- |
| `0` | Complete scan (possibly empty or display-limited), demo, help, or version |
| `1` | Incomplete scan or API failure; inspect `issues` and stderr |
| `2` | Usage, configuration, or local failure |

## Errors and digest limits

`404` becomes `not_found` (missing or inaccessible). `401` becomes `unauthorized`.
`429`, or `403` with rate-limit headers, becomes `rate_limited`; a bare `403`
becomes `forbidden` because it may also indicate a secondary rate limit. Each
stops remaining repository requests and marks them `skipped`. Other repository
failures allow independent repositories to be fetched. There are no automatic retries.

For rate limits, honor `retryAfterSeconds` and `resetAt` when present; if no timing
is supplied, wait at least a minute. Consult [GitHub rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit)
before rerunning. A timeout covers headers and body transfer. Broken transfers,
malformed JSON, unexpected shapes, unsafe source links, malformed pagination, and
oversized responses are explicit failures. Raw response error bodies, exception
messages, headers, and stack traces are not logged. The configured token is redacted
from output strings even if remote release text echoes it.

The digest strips common Markdown, fenced code, HTML tags, terminal controls,
and bidi controls. It is a plain-text excerpt, not a complete Markdown parser or
an assessment of the release. At most the first 16,000 input characters are
processed; output is limited to 280 Unicode code points with `truncated` metadata.
Name/tag display fields are capped at 200 code points. Full notes remain at the
validated GitHub source link. Always check those notes before making upgrade decisions.

## Development

```sh
npm test
npm run test:coverage
```

Tests use Node's built-in runner, fake fetch responses, a real loopback HTTP server,
and CLI subprocesses. They never depend on live GitHub or real credentials.
Coverage includes pagination, UTC ordering, filtering, token redaction, unsafe
links, 404/403/429, full-body timeouts, truncated transfers, malformed responses,
partial-result preservation, config validation, and offline demo behavior.

`src/github.js` owns transport and page limits; `src/releases.js` validates release
data; `src/radar.js` combines repository results; `src/cli.js` handles input/output.
The injected fetch function is an internal test seam, not a CLI host override.

The [CI workflow](.github/workflows/ci.yml) runs on pushes to `main` and pull requests.
It uses Node 22/24, an offline dependency install, the full test suite, and text/JSON
synthetic demos. Official checkout and setup-node actions are pinned to verified
commit SHAs, with read-only repository permission and checkout credential persistence
disabled. Tests and demos use no live RPC/API services or custom secrets. There is
no schedule, release creation, or publishing step.

See [AGENTS.md](AGENTS.md) for project boundaries,
[ROADMAP](docs/ROADMAP.md) for 45 useful increments, and
[RELEASE](docs/RELEASE.md) for local verification and publication handoff.

## License

[MIT](LICENSE).
