# Roadmap

A finite plan of 45 useful increments. Entries 01–05 describe the local 0.1.0
baseline delivered on 2026-09-30; they are not separate fabricated commits.
Entries 06–07 were completed on 2026-10-02, entries 08–09 on 2026-10-03, and entries
10–11 on 2026-10-04, and entry 12 on 2026-10-05; entries 13–45 remain planned.
The count is a planning aid, not a commit target. Combine or revise future scope
when evidence makes that useful.

One coordinator dispatch = one unchecked item. For each item, preserve user work,
implement a coherent change, add meaningful tests, update user documentation and
this checklist, and stop. Use real timestamps. An unchecked item is done only
when its stated behavior and failure cases have been verified. Do not start an
independent scheduler or create additional tasks/agents.

The user confirmed `DakDicdayncbs` and the commit identity for this project.
Author settings are stored in the local Git repository and use the account's
GitHub noreply email, as requested before the first commit. On 2026-10-01 the
coordinator confirmed authentication and push access for the exact origin, and the
user authorized initial publication of the baseline. Subsequent commit/push work
requires separate coordinator dispatches. Scheduling is enabled by the coordinator
after checking the baseline's CI result. Functional roadmap increments are separate
from the initial baseline publication.

## Baseline — complete locally

- [x] **01. Explicit config and runnable CLI.** Node.js 22+ ESM package, zero
  dependencies, lockfile, validated repository allowlist, bounded settings, CLI
  overrides, help/version, and meaningful config/argument tests.
- [x] **02. Read-only GitHub release transport.** Official versioned REST endpoint,
  sequential bounded pagination, whole-page timeouts, response-size limits,
  environment-only token, redirect refusal, and safe 404/403/429/transfer failures.
- [x] **03. Release selection and honest digests.** Validate release fields and
  source URLs; exclude drafts, optionally include prereleases, deduplicate,
  sort publication instants in UTC, and generate bounded plain excerpts with notice.
- [x] **04. Reports and offline demo.** Table/JSON, explicit per-repository scan
  completeness and issue metadata, nonzero partial-result status, preserved good
  records, plus bundled synthetic demo with no network/token access.
- [x] **05. Verification and handoff.** Unit and loopback HTTP integration tests,
  executable checks, live unauthenticated API smoke test, README, MIT license,
  project boundaries, release checklist, and Node 22/24 GitHub Actions CI with
  verified official SHA pins (activated during initial publication preparation).

## Query and configuration

- [x] **06. Publication lower bound.** Completed 2026-10-02: `--since` validates a
  documented timestamp subset and normalizes to UTC milliseconds before requests.
  Filtering is inclusive, precedes sort/limit, and preserves bounded-scan errors.
  Help/README and fake/loopback/CLI tests cover boundaries, offsets, calendar dates,
  local TZ independence, demo behavior, and empty/partial results. All 108 tests pass.
- [x] **07. Publication intervals.** Completed 2026-10-02: CLI-only `--until`
  adds an inclusive upper bound, alone or with `--since`. UTC interval ordering is
  validated before config/token access and requests; equal bounds are allowed.
  Table/JSON expose effective bounds and retain all scan errors/completeness.
  README documents repeatable windows and mutable data. All 119 tests pass,
  including boundary/offset/TZ, invalid input, empty/partial scans and compatibility.
- [x] **08. Tag pattern selection.** Completed 2026-10-03: repeatable CLI-only
  `--tag-pattern` uses bounded Unicode glob matching against whole original tags,
  before display cleanup/redaction. Up to 10 patterns combine with OR and with
  dates/prereleases via AND. Validation/duplicates precede filtering; scan errors,
  pagination and limits remain explicit. Scope/table/help/README document patterns
  and shell quoting. All 136 tests pass, including limits, escaping, Unicode,
  adversarial patterns, raw/display differences, composition and partial results.
- [x] **09. Per-repository policy.** Completed 2026-10-03: mixed string/object
  entries support strict `slug`, `limit` and `includePrereleases` fields. Per-field
  priority is CLI > object > top-level > defaults, preserving explicit false and
  validating overridden config. Reports expose each effective policy, with nullable
  scope summaries for differing policies; README/help document compatibility and
  migration. All 149 tests pass, including precedence, old-config equivalence,
  filters, pagination, partial/skipped results and safe failures/redaction.
- [x] **10. Named repository groups.** Completed 2026-10-04: local `groups` and
  repeatable `--group` replace the default list in explicit selection/member order.
  All definitions are validated; unknown/repeated selections, overlapping slugs
  and expansion above 20 repositories fail before token access or requests.
  Policies and scan behavior are preserved; additive selected-group/requested
  metadata, help, README and a runnable config example document the contract.
  All 165 tests pass, including bounds, unused invalid groups, ordering, overrides,
  redaction, compatibility and complete/empty/partial/skipped results.
- [x] **11. Shared config validation command.** Completed 2026-10-04:
  `--validate-config` uses the scan's shared config reader/validator, checks all
  definitions without token/network access or file writes, and returns fixed text
  on success (0), safe stderr on failure (2). Scan options are explicit conflicts.
  Draft 2020-12 schema and external editor association preserve existing configs;
  runtime remains authoritative for slug uniqueness and scan group selection.
  All 176 tests pass, including 210 shared structural cases, four semantic
  exceptions, schema mutation checks, blocked environment/network access, unchanged
  files, flag conflicts, both examples and executable behavior. Both demos pass.
- [x] **12. Config input resource bounds.** Completed 2026-10-05: shared config
  reading accepts regular files up to 131072 bytes, strict UTF-8 without BOM and
  nesting depth at most 8 before JSON.parse. Bounded actual reads, post-open/EOF
  size checks, nonblocking/no-follow opening and guaranteed close attempts cover
  growth, short reads, nonregular inputs and failure paths. Semantic diagnostics
  use fixed field segments and entry/group ordinals without reflecting names,
  values, paths or parser/system snippets. Document distinct read/resource/syntax
  codes, message compatibility, platform/symlink policy and schema/file limits.
  All 194 tests and both demos pass, including exact/+1 byte/depth boundaries,
  220 maximum definitions, malformed encodings/nesting, FIFO/symlink races,
  descriptor cleanup and shared scan/validation diagnostics before token access.
- [ ] **13. Global display budget.** Add an optional total release limit after
  per-repository selection, with deterministic ties and metadata that distinguishes
  query filtering from local display truncation.

## Reports and local files — planned

- [ ] **14. Markdown report export.** Produce a standalone human-readable report
  with source links and visible incomplete status; test Markdown metacharacters,
  untrusted link text, and empty/partial outputs.
- [ ] **15. CSV export.** Add a documented column contract, RFC-style escaping,
  formula-safe cells, and tests for quotes, newlines, Unicode, and partial status
  without confusing consumers about metadata placement.
- [ ] **16. NDJSON export.** Define record types for metadata, releases, and issues;
  preserve final completeness and test recovery from a truncated output stream.
- [ ] **17. Atomic output file.** Add `--output` with a temporary sibling file and
  atomic replacement, explicit overwrite behavior, and filesystem failure tests;
  prevent accidental writes over the config or inputs.
- [ ] **18. JSON contract documentation.** Publish a versioned report schema and
  compatibility examples; add consumer tests for optional fields, error envelopes,
  and future-compatible unknown properties.
- [ ] **19. Sanitized report snapshots.** Save versioned local normalized snapshots
  with atomic writes; never store tokens/raw API responses; test secret rejection,
  restrictive file handling, and interrupted writes.
- [ ] **20. Offline snapshot rendering.** Load validated snapshots for table/JSON
  output, preserve original acquisition time and completeness, and test damaged or
  incompatible versions without any network fallback.
- [ ] **21. New-release comparison.** Compare two snapshots by repository/release
  ID, distinguish new from unknown due to incomplete scans, and test deleted or
  inaccessible repositories without claiming a release was removed.
- [ ] **22. Edited-release comparison.** Detect tag/title/prerelease/note-excerpt
  edits using explicit field comparisons; preserve both source timestamps and
  explain the limits of truncated digests in tests and examples.

## Network reliability — planned

- [ ] **23. Conditional requests.** Add ETag/304 support with validated local cache
  entries scoped to repository, API version, and authenticated visibility; test
  safe cache invalidation without storing credential values.
- [ ] **24. Cache recovery and freshness.** Handle corrupt, expired, or missing
  page cache entries and concurrent writes; show acquisition age and verify that
  stale data can never silently masquerade as a successful live result.
- [ ] **25. Run-wide time budget.** Add a total deadline across repositories and
  pages, partial-result preservation, and deterministic fake-clock tests; document
  how it combines with the existing per-page timeout.
- [ ] **26. Bounded transient retries.** Retry selected connection/5xx failures
  within explicit attempt/time budgets, with injectable timing and jitter. Preserve
  rate-limit stop behavior and test no retry storms or duplicate release output.
- [ ] **27. Graceful cancellation.** Propagate SIGINT/SIGTERM to the active request,
  emit the received subset as incomplete, and test executable termination during
  headers/body/output without leaving local temporary files.
- [ ] **28. Rate-limit visibility.** Include validated quota and retry metadata
  from successful responses as well as errors; distinguish resource buckets and
  missing headers without inferring a guaranteed future allowance.
- [ ] **29. Repository move guidance.** Safely parse a canonical GitHub redirect
  into a suggested explicit config correction without following it or changing
  files. Test cross-host, credential-bearing, and malformed locations.
- [ ] **30. API lifecycle warnings.** Parse GitHub deprecation/sunset headers,
  surface actionable version information, and test invalid dates and warning
  propagation without changing completeness for a successful request.
- [ ] **31. Pagination interoperability.** Extend Link parsing for standard
  parameter order/quoting variants while preserving endpoint/page confinement;
  add a corpus covering cycles, duplicate relations, and unexpected parameters.

## Digest and terminal usability — planned

- [ ] **32. Configurable excerpt size.** Support bounded digest length and visible
  truncation settings with code-point-safe limits, predictable JSON metadata, and
  tests for very short/long multilingual notes.
- [ ] **33. Section-aware excerpts.** Let users select named Markdown sections and
  show the selected heading as author-provided text; test absent/duplicate headings
  and keep the automatic/unverified notice visible.
- [ ] **34. Markdown edge cases.** Improve plain-text extraction for nested links,
  reference links, inline code, and HTML entities using bounded parsing; test
  hostile large inputs, readable fallbacks, and unchanged source provenance.
- [ ] **35. Readable terminal wrapping.** Add width-aware column or stacked output
  for narrow terminals; test combining marks, wide characters, emoji, pipes, and
  long URLs while retaining full machine-readable JSON values.
- [ ] **36. Accessible compact output.** Add a concise layout with explicit labels
  for release status and scan errors; test redirected output and screen-reader
  order, and make all information understandable without colors or symbols.
- [ ] **37. Per-repository summaries.** Show stable/prerelease counts, publication
  ranges, and no-match reasons scoped to retrieved data; test incomplete scans
  and query filters so summaries do not overstate coverage.
- [ ] **38. Progress on stderr.** Add opt-in repository/page progress for long scans,
  disabled by default in redirected output; test that JSON stdout stays parseable
  and tokens/raw server messages cannot enter progress lines.

## Maintenance and release readiness — planned

- [ ] **39. Safe support diagnostics.** Add an opt-in diagnostic envelope with local
  version, effective non-secret settings, sanitized request IDs, and timing; test
  credential/URL redaction and document what can safely be shared manually.
- [ ] **40. Scenario replay fixtures.** Build a reusable fake-server scenario format
  for pagination races, quotas, and corrupt transfers; validate fixtures and migrate
  repeated integration setup while preserving behavioral assertions.
- [ ] **41. Opt-in API contract check.** Add a separately invoked read-only live
  smoke check for a tiny explicit repository set with no saved remote bodies or
  routine CI dependency; test request budgeting using the fake server first.
- [ ] **42. Platform compatibility.** Expand the CI workflow and executable
  checks for supported Node versions on Linux, macOS, and Windows; cover paths,
  stdout encoding, and subprocess status conventions locally where possible.
- [ ] **43. Resource regression suite.** Add measured memory/time envelopes for
  maximum allowed page sizes, long notes, and multi-repository merges; use generous
  deterministic bounds and document measured limits and failure behavior.
- [ ] **44. Distribution audit.** Add an offline source-package audit that checks
  executable mode, required files, license, dependency absence, and exclusions for
  secrets/local snapshots. Produce a reviewable manifest without publishing to npm.
- [ ] **45. Stable-release review.** Reconcile implemented behavior, public schemas,
  error codes, compatibility checks, changelog, and known limitations; prepare a
  reviewed release candidate and finite follow-up list. Publishing still requires
  the confirmed project account and authorization; do not manufacture activity.
