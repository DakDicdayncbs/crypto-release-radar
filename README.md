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
--demo                    Use bundled synthetic data (cannot combine with --config)
--help                    Usage
--version                 Version
```

There are no positional arguments, token flags, custom API URLs, telemetry,
notifications, downloads, or background jobs.

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
