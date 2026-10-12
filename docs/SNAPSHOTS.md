# Private normalized snapshots — snapshotVersion 1

`--snapshot FILE` saves the fully collected, normalized and token-redacted
report in a versioned local JSON container. It retains the generation time,
query, policies, ordering, display limits, completeness and all safe issues.
An incomplete scan stays incomplete. This is storage only: there is no snapshot
reading, rendering, comparison, cache, background job or network fallback command.

```sh
node bin/crypto-release-radar.js --demo --snapshot demo.radar-snapshot.json
node bin/crypto-release-radar.js --demo --format json --snapshot demo.radar-snapshot.json --overwrite
node bin/crypto-release-radar.js --config examples/repos.json --snapshot scan.radar-snapshot.json
```

The first two examples are offline; demo never reads `GITHUB_TOKEN`, even if an
invalid token is in the environment. The third makes the same explicit GitHub
reads as a normal scan. Saving adds no requests.

## CLI combinations and exit behavior

`--snapshot` takes one separate path ending **exactly** in
`.radar-snapshot.json`, at most once. This suffix matches the repository's Git
ignore rule; it does not infer a format. Blank paths, ASCII controls/DEL,
trailing directory components, missing/duplicate values and `--snapshot=FILE`
are usage errors. The shared [path rules](OUTPUT.md#paths-and-input-protection)
apply: parent directory must already exist, no mkdir, quote spaces, and prefix
option-like filenames with `./`.

| Combination | Behavior |
| --- | --- |
| `--snapshot FILE` with any of the five formats | Save the same JSON container; print the ordinary selected-format report after successful save |
| `--snapshot FILE --overwrite` | Explicitly permit replacing an existing ordinary file, subject to identity/race checks |
| `--snapshot FILE --output OTHER` | Usage error in either order; no two-file transaction |
| `--snapshot FILE --validate-config` | Usage error in either order |
| Valid snapshot arguments with help/version | Informational text; no config/token/API or destination I/O |
| Invalid arguments with help/version | Still a usage error; no bypass of parsing |
| No snapshot option | Existing formats, requests, stdout and `--output` behavior preserved |

`--overwrite` requires one of `--output` or `--snapshot`; it does not disable
input protection or permit special files. All these options are CLI-only:
`snapshot`, `snapshotPath`, `snapshotVersion` and `overwrite` are not config
keys. The [config schema](../schemas/config.schema.json) is unchanged.

| Result | Exit | File / stdout |
| --- | --- | --- |
| Complete scan, including empty/display-limited/demo | 0 | Container saved; ordinary full report on stdout |
| Incomplete scan, including partial/all-failed/skipped | 1 | Container saved with `report.complete: false` and all issues; ordinary incomplete report on stdout |
| Usage/config/token/projection/secret/size/local failure before publication | 2 | No new snapshot published; previous destination retained; stdout empty |
| Temp cleanup failure after publication | 2 | Snapshot already saved; explicit published/no-rollback diagnostic; stdout empty |
| Synchronous stdout write failure after saving | 2 | Snapshot already saved; `snapshot_stdout` published/no-rollback diagnostic |

There is no save banner. Safe scan diagnostics go to stderr before snapshot
validation/writing; a later failure adds its own safe diagnostic. Fatal JSON
envelopes are never saved or printed in snapshot mode, even with JSON format.
Help/version remain the informational exceptions above. Keep stdout and stderr
separate and capture the exit status, including under `set -e`.

An existing file is not evidence this invocation saved it. Publication and
stdout delivery are separate: termination or an asynchronous stream failure can
occur after a successful save. This feature adds no signal/stream lifecycle or
delivery acknowledgement.

## Container and exact whitelist

The self-contained [Draft 2020-12 schema](../schemas/snapshot-v1.schema.json) has
the stable ID
`https://github.com/DakDicdayncbs/crypto-release-radar/blob/main/schemas/snapshot-v1.schema.json`.
All refs are local; load the JSON file rather than fetching its HTML identifier.
The root requires **only** these four fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | string exactly `crypto-release-radar-snapshot` | Distinguishes stored containers from report JSON/config/NDJSON |
| `snapshotVersion` | integer exactly 1 | Container version, separate from embedded report and package versions |
| `synthetic` | boolean | True for CLI demo; false for live collection, even if mode text was redacted |
| `report` | object | Closed projection of one full normalized/redacted report-v1, never a fatal envelope |

The CLI supplies `synthetic` from parsed demo selection. The writer checks that
`report.mode` equals the corresponding `demo`/`live` value after the same token
replacement. It does not infer source from displayed repository names. This is
recorded provenance, not proof of a request or provider honesty; static examples
labeled as live remain explicitly fictional.

The following is the **entire** nested whitelist. `?` means optional; all other
members are required. Optional omissions are preserved without default insertion.
Unknown own properties are rejected at every object level.

| Object | Allowed members |
| --- | --- |
| `report` | `schemaVersion`, `mode`, `generatedAt`, `complete`, `digestNotice`, `scope`, `repositories`, `releases`, `issues`, `display?` |
| `scope` | `limitPerRepository`, `includePrereleases`, `maxPagesPerRepository`, `since?`, `until?`, `tagPatterns?`, `groups?`, `totalLimit?` |
| Each repository | `repository`, `complete`, `pagesFetched`, `scannedEntries`, `matchingReleases`, `returnedReleases`, `selectionLimited`, `policy?`, `requested?`, `selectedReleases?`, `globalSelectionLimited?` |
| Repository `policy` | `limit`, `includePrereleases` |
| Each release | `repository`, `id`, `name`, `tag`, `publishedAt`, `prerelease`, `url`, `digest` |
| Release `digest` | `text`, `truncated` |
| Each issue | `repository`, `code`, `message`, `status?`, `count?`, `retryAfterSeconds?`, `resetAt?` |
| `display` | `matchingReleases`, `selectedReleases`, `returnedReleases`, `perRepositoryHiddenReleases`, `globallyHiddenReleases`, `globalSelectionLimited` |

Types, numeric/array bounds, optional-group presence and meanings follow the
[JSON v1 contract](JSON.md#full-report-fields), with an additional storage limit
of **1000 issues**. Embedded `schemaVersion` must be numeric 1; unsupported
versions, missing required fields, null policies, numeric strings and malformed
known values are refused. `scope.totalLimit`, `display`, and both selected/global
fields on every repository must appear together or be absent together. Mixed
policy summaries stay null; null, zero, false and omitted remain distinct.
Numeric IDs preserve exact values through `9007199254740991`.

`report.generatedAt` is retained **exactly as acquired/redacted**, with no new
timestamp replacing it and no claim of simultaneous page acquisition. Array
order is retained. Projection uses a fixed object-key order; object-member byte
order is not an identity guarantee. Container bytes are UTF-8 without BOM,
two-space indentation and final LF. The ordinary stdout report retains its
original bytes; the snapshot is a separate container, not a copy of stdout bytes.

The closed storage schema does not change the open, forward-compatible
[report-v1 schema](../schemas/report-v1.schema.json). New report extras require
storage-format review; they are never silently copied. The writer accepts plain
data objects and dense arrays, refusing accessors, custom object prototypes,
symbols, extra array properties and `toJSON` hooks. It serializes newly projected
objects rather than caller-controlled objects. There is no product parser here.

## Sanitization and active-token rejection

Collection performs existing release validation, filters, cleanup, digests and
redaction. Only that finished report reaches the writer. Raw response objects,
full note/body fields, headers, request URLs, credentials, environment, complete
config and unknown extras have no whitelist entries. Displayed release source
URLs and automatic digest excerpts are retained intentionally; a short excerpt
can equal the source's short notes. The writer reads no config or environment.

With an active live token there are **two literal checks**: no projected report
string may contain the token, and the finished serialized JSON must not contain
it. Both finish before a temp is opened. The second covers fixed keys, container
metadata, numeric/boolean literals and escaping/syntax. Refusal produces
`snapshot_secret`, empty stdout and no new publication. Typed data is never
altered to bypass rejection.

Very short tokens can conservatively match harmless JSON: `true`, version digits,
a field name, the container kind or part of `[REDACTED]`. Quotes/backslashes in
a token echo are caught in decoded strings even if JSON escaping changes their
serialized spelling. Neither token nor filesystem paths/underlying errors enter
diagnostics. Demo has no active token and never reads one for this check.

Exact substring checks cannot detect **every** secret: arbitrary credentials in
author text, other inactive tokens, encoded/transformed/split secrets and private
business information can remain. Redaction does not establish that titles,
excerpts, tags or repository names are suitable for publication. Review data
before sharing; file permissions and ignore rules are not publication permission
or a guarantee that all secrets were found.

Report strings remain opaque: dates, URLs, mode, issue codes, slugs and globs can
change, collide or grow after redaction. No string enums, URI/date parsing or
old display-length constraints are added to these fields. Treat strings as data;
escape for the display context and independently validate URLs before navigation.

## Bounded validation and serialization

Before stdout formatting or temp I/O, projection checks known types/bounds,
rejects unknown fields without reading their values, and counts report string
occurrences toward **4194304 UTF-16 code units (4 Mi units)**. An astral character
such as `🚀` uses two. Repeated strings count for every serialized occurrence;
fixed property names and container metadata are outside this text budget.
This bounds input before `JSON.stringify`: escaping can expand each unit by at
most six characters, plus bounded keys/indentation. Arrays are limited to 20
repositories, 1000 releases and 1000 issues. Immutable checked text is retained
so caller mutation during filesystem awaits cannot change stored bytes.

Finished JSON, including escaping, indentation and LF, must fit **16777216 UTF-8
bytes (16 MiB)**. Text/issue/byte overflow gives `snapshot_size`; no truncation,
dropped issue or partial snapshot is substituted. A valid ordinary report may
exceed a storage budget and remain exportable without the snapshot flag. These
are new storage-path bounds, not process-wide memory/CPU/time guarantees for the
preceding scan.

The schema enforces structure and the issue-count cap. Aggregate text units,
serialized bytes, token absence, plain-data restrictions and CLI-provenance
consistency are additional writer checks, not invented schema keywords. Neither
schema nor writer proves counter equations, sorting, URL safety, uniqueness
after redaction, freshness, honest provenance or exhaustive GitHub data.
Completeness is preserved rather than inferred from stored rows. There is no
signature/checksum to establish that an external file was not modified.

## Atomic files, failures and interruption

The feature reuses the [existing atomic output writer](OUTPUT.md). Read-only
destination preparation follows config/demo reading and group validation, before
token/API access. It protects the actual opened input's retained device/inode,
canonical path, parent aliases and both old/current input inodes after replacement.
Final symlinks, directories, FIFOs, devices and other special entries are refused.

Exclusive sibling temps `.radar-output-<UUID>.tmp` use **0600**, including descriptor
chmod. Full/short writes, fsync and successful close precede final path/identity/
size/mode rechecks and the no-clobber link or explicitly permitted rename.
The old destination is never opened/truncated; other hardlinks retain its old
contents. A late competitor defeats no-clobber, even with `--overwrite` when the
destination was initially absent.

Before publication, failures preserve existing output. Cleanup checks ownership
before unlinking its own name and never removes a substituted foreign temp.
Shared `output_*` messages distinguish published from unpublished failure, using
“Report” for the stored document. No rollback follows publication.
`snapshot_invalid`, `snapshot_size` and `snapshot_secret` precede temp creation;
`snapshot_stdout` describes a caught stdout failure after successful saving.

Use trusted local Linux/macOS directories. Rechecks are not atomic compare-and-swap
against hostile directory mutation, and concurrent explicit overwrites may leave
the last complete rename winning. Parent directories are not fsynced; no power-loss
or network-filesystem durability guarantee is made. Killing the process before
publication can leave a private partial temp and an unchanged old final file;
killing it later may leave a published snapshot plus temp link. This item adds
no graceful signal handling or automatic scavenging.

`.gitignore` excludes `*.radar-snapshot.json`, `/snapshots/` and
`.radar-output-*.tmp`. It cannot protect already tracked files or forced additions;
do not force-add real snapshots. Tracked [examples](../examples/snapshot-v1/README.md)
use ordinary `.json` names and contain only explicitly fictional data.

Tests cover all scan states, groups/policies/filters/both limits, all five stdout
formats, time preservation, token echoes, strict fields/versions, budget boundaries
and permissions. Fault injection exercises short writes, fsync, close, publication,
cleanup, aliases and races. A child-process interruption test stops during a
partial write and verifies the old destination and private unpromoted temp.
