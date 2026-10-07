# NDJSON report contract — version 1

Select the exact lowercase `--format ndjson`. Aliases such as `jsonl`, uppercase,
`--format=ndjson`, missing values and repeated format flags are usage errors.
The option conflicts with `--validate-config` in either order, before environment
or network access. Help/version retain plain informational text. No config fields,
dependencies, API requests, retries, output-file option or NDJSON input CLI are added.
Table, JSON schema 1, Markdown and CSV keep their existing contracts.

## Encoding and lifecycle

The CLI finishes the bounded scan, validation/deduplication, query filtering,
per-repository selection, global sort and optional total limit before formatting
the normalized, token-redacted report. NDJSON is a serialization of that report;
it does not emit live API pages or stop requests when a display budget fills.
No raw response, headers, credentials or exception messages are exported.

Bytes are UTF-8 without BOM. Each record is exactly one compact JSON object,
followed by a single LF byte (`0A`), including the last record. There are no blank
lines, surrounding array, commas between records, CRLF separators or footer text.
JSON string encoding escapes quotes, backslashes and control characters such as
CR/LF. Embedded record-looking text cannot create a new record. Literal Unicode
U+2028/U+2029 inside strings are data, not separators: split on **LF bytes only**.
Every line parses independently. Object member order is not semantically meaningful;
record order and array order are meaningful. No duplicate object keys are emitted.

Use the direct Node command so an npm banner does not enter stdout. Keep stderr
separate. Shell redirection owns file creation; choose a new filename to retain
earlier reports. For example, this preserves the exit status under `set -e`:

```sh
if node bin/crypto-release-radar.js --config examples/repos.json --format ndjson > release-report.ndjson; then
  radar_status=0
else
  radar_status=$?
fi
case "$radar_status" in
  0|1) : ;; # Validate the document and inspect its scanComplete flag too.
  *) exit "$radar_status" ;;
esac
```

| CLI exit | Report behavior |
| --- | --- |
| 0 | Full document, `scanComplete: true`, possibly empty or display-limited |
| 1 | Full document, `scanComplete: false`, all issues and mandatory summary, possibly zero releases |
| 2 | Fatal usage/config/local error before a report: safe stderr, empty stdout |

A downstream interrupted transfer can truncate stdout independently of the scan
result. A shell redirection can create an empty file even on exit 2. Do not use
exit status, metadata or a parseable prefix alone as proof of document completion.

## Records, order and fields

The document contains exactly these phases, in order. Zero releases or issues
omits that phase, not metadata/repositories/summary. At least one selected repository
is present, even when it failed, was skipped, or has zero matching releases.

| Type | Occurrences | Fields |
| --- | --- | --- |
| `metadata` | Exactly one, first | `type`, `ndjsonVersion`, `schemaVersion`, `mode`, `generatedAt`, `complete`, `digestNotice`, `scope`; optional `display` |
| `repository` | One per selected repository, in selection/request order | `type`, `repository` object |
| `release` | Zero or more, in existing global display order | `type`, `release` object |
| `issue` | Zero or more, in existing diagnostic order | `type`, `issue` object |
| `summary` | Exactly one, last | `type`, `ndjsonVersion`, `documentComplete`, `scanComplete`, `counts` |

All listed fields are required unless marked optional. `ndjsonVersion: 1` versions
this framing/envelope contract and appears in metadata and summary. Metadata's
`schemaVersion: 1` is the existing source-report schema version; no NDJSON envelope
fields are inserted into the old JSON report. Consumers must explicitly support
both versions. This version emits only the fields below; the example reader
rejects unknown fields and versions rather than guessing their meaning.

### Metadata

`mode` is a string, normally `live` or `demo`; demo entries and source links are
fictional. `generatedAt` records the real report generation time as a UTC ISO
string. `complete` is the boolean **scan** result, repeated in summary as
`scanComplete`. It is only provisional document information until terminal
validation. `digestNotice` is the automatic, unverified excerpt notice string.

`scope` retains all original fields and types:

| Field | Type and meaning |
| --- | --- |
| `limitPerRepository` | Positive integer, or null for differing effective limits |
| `includePrereleases` | Boolean, or null for differing effective policies |
| `maxPagesPerRepository` | Positive integer page budget |
| `since`, `until` | Inclusive publication bounds as UTC strings, or null when unset |
| `tagPatterns` | Ordered string array; empty means no tag filter |
| `groups` | Selected group names in CLI order; empty means default/demo list |
| `totalLimit` | Optional positive integer, present only with `--total-limit` |

Optional `display` is present exactly when `scope.totalLimit` is present. It has
numeric `matchingReleases`, `selectedReleases`, `returnedReleases`,
`perRepositoryHiddenReleases`, `globallyHiddenReleases`, and boolean
`globalSelectionLimited`. These are the same counters as JSON, not estimates of
unseen remote data. No display object is synthesized when the option was omitted.

### Repository payload

The wrapper's `repository` object has string `repository` (the displayed slug),
`policy: { limit: positive integer, includePrereleases: boolean }`, booleans
`requested`, `complete`, `selectionLimited`, and nonnegative integer counts
`pagesFetched`, `scannedEntries`, `matchingReleases`, `returnedReleases`.

`requested` records whether API access was attempted, not whether it succeeded;
it is false for skipped entries and synthetic demo entries. `complete` is this
repository's scan result. `scannedEntries` counts received entries before filtering,
including malformed/duplicate entries. `matchingReleases` is after validation and
query filters. `returnedReleases` counts rows actually exported after both limits.
`selectionLimited` indicates rows hidden by this repository's own limit.

With `--total-limit`, and only then, the payload additionally requires numeric
`selectedReleases` (after the repository limit, before global selection) and
boolean `globalSelectionLimited` (returned is less than selected). Otherwise
returned equals selected; these two optional fields are absent.

### Release payload

The `release` object contains strings `repository`, `name`, `tag`, `publishedAt`,
`url`; positive safe integer `id`; boolean `prerelease`; and
`digest: { text: string, truncated: boolean }`. Displayed names already fall back
to tags when upstream names were null. Digests remain excerpts, not verified
security or breaking-change assessments. Upstream text cleanup and bounds remain.

IDs stay JSON numbers, exactly within the supported range 1–9007199254740991;
consumers must preserve those integers. They are never converted to strings.
Publication time is normalized to UTC before sorting. Ordering remains publication
instant descending, original repository ascending, numeric ID descending for ties,
before string redaction. NDJSON neither sorts again nor changes the selected set.

### Issue payload

The `issue` object requires strings `repository`, `code`, `message`. The following
fields are optional and omitted when unavailable: numeric `status` (HTTP status),
`count` (affected entries), `retryAfterSeconds` (nonnegative seconds), and string
`resetAt` (normalized UTC time). Messages are application-owned safe diagnostics.
All issues survive date/tag/display filters, including malformed/duplicate entries,
page-budget failures, late API errors, failed repositories and skipped requests.
The same safe issues are written to stderr as for other formats.

### Summary and accounting

Example terminal record, also present for an incomplete scan:

```json
{"type":"summary","ndjsonVersion":1,"documentComplete":true,"scanComplete":false,"counts":{"records":5,"repositories":1,"releases":1,"issues":1}}
```

The actual output includes an LF after the closing brace. `documentComplete` is
always boolean true in the emitted terminal record: the producer finished the
document. Consumers must validate its position, final LF, counters, scan flag and
end of input before accepting that assertion. There are no abort-summary records.
`scanComplete` is the source report's boolean `complete`, not delivery status.

`counts` contains four nonnegative safe integers:

- `records`: every record, including metadata and summary, exactly
  `2 + repositories + releases + issues`.
- `repositories`, `releases`, `issues`: numbers of their respective payload records.

Summary release count equals the sum of repository `returnedReleases`. Scan
completeness agrees with metadata and all repository completeness flags. A complete
scan has no issues. For repository accounting, selected equals
`min(matchingReleases, policy.limit)`; without a global limit it equals returned.
Per-repository hidden count is matching minus selected. With a total limit,
global returned is `min(sum(selected), totalLimit)`, and the display object sums
matching/selected/returned and both hidden counts. Display limiting never makes
the scan incomplete or repairs an incomplete scan.

Null, false, zero, empty arrays and absent optional properties remain distinct.
Token redaction runs **before** serialization on strings only, including metadata,
repository identities, timestamps and source URLs. Numeric/boolean fields and
envelope names/types/versions/counters are not redacted into strings. Redaction
can make displayed identities collide or timestamps/URLs no longer usable; consumers
must not reconstruct hidden strings or assume displayed names remain unique.

## Recovering a received byte prefix

The independent [example reader](../test-support/read-ndjson.js) imports no
production formatter and consumes a `Uint8Array`/Node `Buffer`. It holds the supplied
bytes in memory; it is a small local example, not a bounded network ingestion
service or an NDJSON CLI input feature. Do not replacement-decode the input before
passing it to the reader. A production stream consumer should retain the unfinished
byte suffix across chunks and defer completion until EOF, with its own resource limits.

The reader scans LF **bytes**, then strictly decodes each terminated record as
UTF-8 and parses one JSON object. It checks version 1 field shapes/types, record
order and summary accounting. It stops at the first bad or unfinished record;
it never skips ahead to a later parseable record. Before terminal validation,
retained records have passed individual schema/order checks, not whole-document
consistency or authenticity checks.

| Returned field | Meaning |
| --- | --- |
| `status` | `complete`, `truncated`, or `invalid` |
| `records` | Only whole records accepted before the first failure; a rejected summary is excluded |
| `verifiedBytes` | Byte offset immediately after the last accepted LF |
| `remainingBytes` | Unaccepted suffix length; suffix contents are not returned as a record |
| `scanComplete` | Boolean only when status is `complete`; otherwise null |
| `error` | Null on success; fixed category, without parser messages or input text |

`truncated` means no accepted final summary at EOF: empty input, a clean boundary
before summary, or any unfinished final line. It includes valid JSON lacking its
final LF, and a cut inside a multibyte UTF-8 character, escape or string. The reader
does not decode/parse an unfinished line, so it cannot distinguish an interrupted
line from malformed bytes that also lack LF. Neither is accepted as a record.

`invalid` means a terminated line failed strict UTF-8 (`utf8`), JSON parsing
(`json`), field/encoding checks (`record`), order (`order`), summary accounting
(`summary`), or bytes appeared after a valid summary (`trailing_data`). All trailing
bytes count, including whitespace, blank lines or another document. If trailing
data is found, `records` can contain the previously accepted summary but status
is invalid and `scanComplete` is null; check status, not mere summary presence.
CRLF and BOM are rejected by this reader because this exporter specifies LF/no BOM.

This example reads a previously redirected file without making requests or writes:

```js
import { readFile } from 'node:fs/promises';
import { readNdjson, readNdjsonReport } from './test-support/read-ndjson.js';

const bytes = await readFile('release-report.ndjson');
const result = readNdjson(bytes);
console.log({ status: result.status, error: result.error, acceptedRecords: result.records.length,
  verifiedBytes: result.verifiedBytes, remainingBytes: result.remainingBytes, scanComplete: result.scanComplete });
if (result.status === 'complete') {
  const report = readNdjsonReport(bytes); // Reconstructs the original redacted JSON report.
  console.log({ shown: report.releases.length, issues: report.issues.length, scanComplete: report.complete });
} else {
  // result.records is an individually checked prefix, never a complete report.
  process.exitCode = 1;
}
```

Both helpers are tested against independently encoded [normal](../test-support/ndjson-normal.ndjson),
[empty](../test-support/ndjson-empty.ndjson) and [partial](../test-support/ndjson-partial.ndjson)
fixtures. These are synthetic expectations, not real repository observations.
Tests cut representative Unicode documents at every byte boundary, including
before summary and its last LF, and inject malformed encodings/JSON, reordered
records, inconsistent counts and trailing garbage. Integration tests reconstruct
the selected JSON data with identical fake API traces, including partial failures.

Recovery performs no new scan and establishes neither freshness nor the absence
of releases. Even a complete scan covers accessible data and configured filters;
display limits can hide matches, and remote data can change during pagination.
A partial scan or recovered prefix cannot establish that a repository has no releases.
Counts/framing are **not a signature or checksum**: valid value edits, balanced
record substitutions or a regenerated summary may pass. This reader uses ordinary
JSON parsing (it does not detect duplicate-key substitutions), and does not verify
remote provenance, source URLs, time validity or cryptographic authenticity.
