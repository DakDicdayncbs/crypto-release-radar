# JSON report contract — schemaVersion 1

`--format json` emits the existing normalized, token-redacted report. This
document and [report-v1.schema.json](../schemas/report-v1.schema.json) describe
that output; they do not introduce an input command, snapshot format, runtime
validator, dependency, new discriminator or byte change. The [config schema](../schemas/config.schema.json)
and [NDJSON contract](NDJSON.md) describe different documents.

The schema uses [JSON Schema Draft 2020-12 validation](https://json-schema.org/draft/2020-12/json-schema-validation)
and [core applicators](https://json-schema.org/draft/2020-12/json-schema-core#section-10).
It is self-contained: every `$ref` is local. Its stable `$id` is
`https://github.com/DakDicdayncbs/crypto-release-radar/blob/main/schemas/report-v1.schema.json`.
Load the actual local JSON file into a Draft 2020-12 validator; the identifier
does not require fetching a GitHub HTML page. The root accepts exactly one of
`$defs.report` and `$defs.fatal`. Those definitions can also be selected separately
with a local reference while retaining the file's `$defs`.

## Bytes, stdout and exit status

Successful serialization produces one UTF-8 JSON object without BOM, two-space
indentation and a final LF. Object-member order is not a consumer contract;
array order is described below. Numeric values are JSON numbers, booleans are
booleans, and absent members are not emitted as `null`. Standard JSON parsing
does not by itself establish report validity or delivery completeness.

| Invocation/result | Exit | stdout / saved content |
| --- | --- | --- |
| JSON scan, complete (including empty or display-limited) | 0 | Full report, `complete: true` |
| JSON scan, incomplete or failed API access | 1 | Full report, `complete: false`, preserved successes and issues |
| Successfully parsed JSON scan arguments, fatal config/token/local error, **no `--output` or `--snapshot`** | 2 | Smaller fatal envelope below, plus safe stderr |
| Argument parsing/validation failure, even if `--format json` appeared earlier | 2 | Empty stdout; safe stderr |
| `--validate-config` | 0 / 2 | Fixed success text / empty stdout; no JSON envelope; `--format` is a conflict |
| Successfully parsed `--help` or `--version`, even with JSON format | 0 | Informational text; no report |
| JSON scan with `--output FILE` | 0 / 1 | Empty stdout; identical full-report bytes saved atomically |
| Fatal error with `--output FILE` | 2 | Empty stdout; no fatal envelope saved |

The opt-in [snapshot mode](SNAPSHOTS.md) writes a separate versioned container
and prints the same ordinary report after successful saving (0/1). Snapshot
failures return 2 with empty stdout and no fatal envelope; a post-publication
failure can leave a saved snapshot. It does not change this report-v1 schema.

JSON scan issues also appear on stderr; keep it separate from stdout. Help and
version still require arguments to parse. Check the command's status **and**
the document form, rather than assuming every exit 2 has JSON. A write cleanup
failure after publication can return 2 while a full report remains saved; see
the [output policy](OUTPUT.md). An ordinary redirected file can be empty or
partially written after a process/stream failure. There is no JSON final-summary
record, checksum or authenticity proof.

## Full report fields

`R` means required in the original baseline. `O` means a later additive field:
older producers may omit it, but a present known field must have the listed
type. Current producers emit all O fields except the opt-in global-limit group.
Every integer range here is inclusive; no numeric strings or boolean coercion
are accepted. The schema checks structural bounds, not relationships between
fields. **String** always means opaque text after redaction, as explained below.

| Root field | Presence / type | Meaning |
| --- | --- | --- |
| `schemaVersion` | R, integer exactly 1 | Report contract version, separate from package/API versions |
| `mode` | R, string | Normally `live` or `demo` before final redaction; demo data and links are fictional |
| `generatedAt` | R, string | Local generation time, normally UTC ISO milliseconds; not a GitHub observation timestamp, freshness proof or acquisition interval |
| `complete` | R, boolean | All selected repository scans completed without issues within the accessible bounded scan |
| `digestNotice` | R, string | Automatic/unverified excerpt warning; retain its meaning when presenting notes |
| `scope` | R, object | Effective query summary below |
| `repositories` | R, array of 1–20 objects | Every selected repository, including failed, skipped and empty results |
| `releases` | R, array of 0–1000 objects | Final displayed records, after both selection stages |
| `issues` | R, array of objects | All safe scan issues; empty is allowed; no fixed array-length bound in this schema |
| `display` | O, object | Present exactly with the global-limit presence group below |

### Scope

| Field | Presence / type | Meaning |
| --- | --- | --- |
| `limitPerRepository` | R, integer 1–50 or null | Common effective per-repository limit; null when limits differ |
| `includePrereleases` | R, boolean or null | Common effective prerelease policy; null when policies differ |
| `maxPagesPerRepository` | R, integer 1–10 | Page budget for each repository; each fetched page contains at most 100 entries |
| `since` | O, string or null | Inclusive normalized UTC publication lower bound; null means no lower bound |
| `until` | O, string or null | Inclusive normalized UTC publication upper bound; null means no upper bound |
| `tagPatterns` | O, array of 0–10 strings | CLI-order globs matched against original tags; OR within this array, AND with dates/prerelease policy; empty means no tag filter |
| `groups` | O, array of 0–10 strings | Selected group names in CLI order; empty means default list or demo |
| `totalLimit` | O, integer 1–1000 | Optional final combined display cap; omitted without `--total-limit` |

Missing `since`, `until`, `tagPatterns` or `groups` means that producer did not
record the field; a consumer should retain the omission instead of inserting
defaults. Null policy summaries mean **mixed**, not zero, unlimited, false or a
missing setting. Read individual `policy` objects when available. Absence of
those objects in a legacy report is distinct from an invalid/null policy.

### Repository scan objects

| Field | Presence / type | Meaning |
| --- | --- | --- |
| `repository` | R, string | Selected original slug, possibly redacted in output |
| `complete` | R, boolean | Pagination reached its end and that repository has no scan/normalization issues |
| `pagesFetched` | R, integer 0–10 | Successfully received and parsed page arrays; a later pagination-metadata error does not subtract the received page |
| `scannedEntries` | R, integer 0–1000 | All entries in received pages, including drafts, duplicates, invalid and filtered-out records |
| `matchingReleases` | R, integer 0–1000 | Valid, unique, nondraft releases after prerelease, tag and date filters, before display limits |
| `returnedReleases` | R, integer 0–50 | This repository's rows in the final root `releases` array |
| `selectionLimited` | R, boolean | Its per-repository limit hid matching records, independently of the global cap |
| `policy` | O, object | Required members when present: `limit` (integer 1–50), `includePrereleases` (boolean); effective CLI > member > config > default policy |
| `requested` | O, boolean | A live request was attempted; true even on failure, false for skipped members and offline demo |
| `selectedReleases` | O, integer 0–50 | Retained after per-repository limit, before global cap; global-limit presence group only |
| `globalSelectionLimited` | O, boolean | The global cap hid this repository's selected records; global-limit presence group only |

Zero pages with `requested: true` can mean a failed first request; false does not
mean a successful empty live scan. The bundled demo has `requested: false` and
zero pages, while its synthetic entries can still form a complete report. Older
reports omit `requested`; do not infer it from page count.

### Display counts and the global-limit presence group

All of `scope.totalLimit`, root `display`, and **both** `selectedReleases` and
`globalSelectionLimited` on **every** repository are either present together or
absent together. This preserves the actual additive shape introduced by the
global budget, including zero-match reports. The schema checks this presence
rule, while allowing all earlier additions independently.

All six members of a present `display` object are required:

| Field | Type | Meaning within retrieved data |
| --- | --- | --- |
| `matchingReleases` | integer 0–20000 | Sum of all repository matching counts |
| `selectedReleases` | integer 0–1000 | Sum retained after per-repository selection |
| `returnedReleases` | integer 0–1000 | Final `releases.length` |
| `perRepositoryHiddenReleases` | integer 0–20000 | Matching minus selected |
| `globallyHiddenReleases` | integer 0–1000 | Selected minus returned |
| `globalSelectionLimited` | boolean | Whether the global cap hid any selected rows |

These equations describe the producer, not schema assertions. Without the group,
repository `returnedReleases` equals its per-repository selected count. With it,
`selectionLimited` still means matching > selected, while the new global flag
means selected > returned. Neither flag changes `complete` or the scan exit code.
All counters describe received data; they say nothing about unseen releases.

### Release and digest objects

All members below are required:

| Field | Type | Provenance / meaning |
| --- | --- | --- |
| `repository` | string | Explicit selected repository, possibly redacted |
| `id` | integer 1–9007199254740991 | Positive safe-integer GitHub release ID; preserve exact numeric value |
| `name` | string | Cleaned/truncated API name, falling back to displayed tag for null/empty names |
| `tag` | string | Cleaned/truncated `tag_name`; original value was used for filtering |
| `publishedAt` | string | Validated `published_at`, normalized to UTC ISO milliseconds before final redaction |
| `prerelease` | boolean | GitHub's prerelease flag; not a maturity or safety assessment |
| `url` | string | Originally validated HTTPS GitHub release link for that repository, then redacted; demo links are fictional |
| `digest` | object | Required `text` (string) and `truncated` (boolean) |
| `digest.text` | string | Plain automatic excerpt, or fixed missing/plain-text-unavailable notice |
| `digest.truncated` | boolean | Input/excerpt truncation occurred; false does not imply full original Markdown was retained |

Drafts are excluded. Input notes processing is bounded at 16000 characters;
excerpt cleanup normally limits output to 280 code points, and name/tag cleanup
to 200. **Those are not final-string schema limits**: the final redaction pass
can expand them. Source validation/normalization precedes serialization; schema
acceptance of an independently supplied document does not perform those checks.

### Issue objects

Full-report issues require `repository`, `code` and `message` strings. Fatal
issues require only `code` and `message`; current fatal output emits no repository
or metadata. The following known metadata is optional in either form and typed
if present, leaving room for future safe diagnostic additions:

| Field | Type | Meaning |
| --- | --- | --- |
| `repository` | string | Selected repository for a full-report issue |
| `code` | string | Application-owned code before final redaction; not a closed enumeration |
| `message` | string | Safe application-owned explanation before final redaction; never match exact English wording for control flow |
| `status` | integer 0–999 | Fetch HTTP status metadata; conservative three-digit/sentinel range, not proof that a status is meaningful or retryable |
| `count` | integer 0–1000 | Malformed or duplicate record count when supplied; zero remains a number |
| `retryAfterSeconds` | integer 0–9999999 | Validated one-to-seven-digit retry header, including zero; not an automatic retry request or guaranteed future quota |
| `resetAt` | string | Validated reset header converted to an ISO time before redaction; may use an extended year |

Existing codes cover `not_found`, `unauthorized`, `forbidden`, `rate_limited`,
`redirect_refused`, `http_error`, `network_error`, `timeout`, `invalid_response`,
`response_too_large`, `invalid_pagination`, `page_limit`, `invalid_record`,
`duplicate_release`, `skipped` and `demo_missing`. This list is illustrative, not
an enum. Fatal codes describe usage/config/token/local failures when eligible for
the envelope. New codes/messages can be added without changing schemaVersion.
Keep unknown codes as diagnostics and retain completeness/status; do not convert
them to success or automatically retry, execute text or follow links.

## Ordering, selection and completeness

Repository order follows the selected default list, or selected groups in CLI
order and their member order. All selected repositories are scanned within
their page budgets. Validation/deduplication and draft/prerelease/tag/date filters
precede per-repository sorting and limits. Remaining releases are merged,
globally sorted, then optionally capped by `totalLimit`.

Both sorts use publication instant **descending**, original repository slug
**ascending** by case-sensitive lexical comparison, then numeric ID **descending**.
These comparisons happen before final redaction; displayed strings can no longer
be parsed/sorted or joined uniquely. Issues remain in repository/collection order,
with normalization issues added after transport/pagination issues. No consumer
should depend on issue order for prioritization.

A complete scan reached the accessible end of pagination without issues; it can
still be display-limited or empty. Errors, malformed/duplicate entries, exhausted
page budgets and skipped repositories preserve `complete: false` and exit 1,
even when all errors concern releases outside the filters or no rows remain.
Display budgets never stop requests early. GitHub data can change during or
between page reads. Completeness is not an exhaustive-history, immutable-data,
latest-release, credential-access or authenticity guarantee.

## Fatal envelope and unambiguous structural recognition

The existing envelope is demonstrated by [fatal.json](../examples/json-v1/fatal.json):

```json
{
  "schemaVersion": 1,
  "complete": false,
  "releases": [],
  "issues": [{ "code": "config_read", "message": "Cannot read config file. Pass --config with a readable JSON file." }]
}
```

All four fields are required. `complete` must be false, releases empty, and
issues an array of **exactly one** issue. The full-report-only names `mode`,
`generatedAt`, `digestNotice`, `scope`, `repositories` and `display` are reserved
and prohibited in this branch, even with null values. Their presence requires
validation as a full report. Thus a damaged partial report retaining any of
these names cannot silently fall back to fatal. The root schema uses `oneOf`;
no valid parsed value matches both branches. There is no new producer `kind`.

This distinguishes shapes, not their historical origin: if an external tool
removes every distinguishing field and leaves a valid fatal shape, neither a
schema nor the example can prove that it was once a full report. Keep the
producer exit status and document together.

## Compatibility, unknown fields and opaque strings

All full-report root, scope, repository, policy, release, digest, issue and
display objects allow unknown additive properties. The fatal root/issue do too,
except for the reserved full-report names. A consumer should validate known
fields/version, ignore unknown fields, and project only approved fields when
forwarding data. Unknown keys do not excuse invalid known values. Unsupported
schemaVersion values must be rejected, not coerced to 1.

The baseline required fields stay required. Later `since`, `until`, tag/group
metadata, policy, requested and global-budget additions remain optional for
legacy compatibility. No schema defaults fill omissions. Changes to required
fields, types, bounds or established meaning need an explicit compatibility
review and, for incompatible changes, a new version; additions do not authorize
reinterpreting old reports. String categories such as mode and issue code remain
open: recognize known values when useful, otherwise retain them as opaque data
without assuming live provenance, success, retryability or a new capability.

The configured token is replaced in report string values before serialization;
that final pass can change **any** string, including mode, code, repository,
generation/publication/reset times, URLs, group names and globs. It can expand
text beyond earlier cleanup limits or make distinct strings identical. Therefore
the schema deliberately has no string enum, pattern, URI/date format, uniqueness
or length assertions. Numeric/boolean/null values and field names keep their
types. Empty strings are structurally accepted. The example neither parses dates
nor restores redacted values or uses strings to construct requests.

Schema acceptance does **not** prove counters add up, arrays are sorted, IDs are
unique, repository references match, timestamps/URLs/slugs are valid, limits are
semantically respected, or completeness flags agree. It does not prove strings
safe for HTML/terminal/shell use, absence of secrets, honest provenance, freshness
or remote completeness. Contextually escape text and independently validate URLs
before rendering or navigation. Output is data, not trusted instructions.

## Runnable offline consumer and examples

[examples/consume-json.js](../examples/consume-json.js) uses only Node built-ins
and accepts **stdin**, with no arguments, network, token access or file writes:

```sh
node examples/consume-json.js < examples/json-v1/legacy.json
node examples/consume-json.js < examples/json-v1/current.json
```

It independently validates/project known fields and emits an **example-only**
`{ "kind": "report" | "fatal", "data": ... }` wrapper. That wrapper is not a Radar
output change. Omitted fields stay omitted; null, false, zero and incomplete
states are retained. Unknown properties are dropped at every documented object
level without copying `__proto__` or executing property text. It exits 0 for a
complete report, 1 for an incomplete report, 2 for a fatal envelope. Invalid
UTF-8, a leading BOM, malformed JSON, unsupported versions, invalid known fields
or extra arguments yield exit 2, empty stdout and a fixed stderr diagnostic;
the raw input is not echoed. A valid fatal result is distinguishable by its
example wrapper on stdout.

To keep producer and consumer statuses distinct, use separate commands and files
in a trusted directory. For example, after making sure `demo-report.json` is a
new path (the output command refuses an existing file):

```sh
if node bin/crypto-release-radar.js --demo --format json --output demo-report.json; then
  radar_status=0
else
  radar_status=$?
fi
case "$radar_status" in
  0|1) node examples/consume-json.js < demo-report.json ;;
  *) printf '%s\n' 'No successful report publication; inspect stderr.' >&2 ;;
esac
```

A pipeline's last status normally belongs to the consumer, not Radar. This
example buffers all stdin and uses `JSON.parse`; it is not a hardened ingestion
service, streaming parser, byte/depth quota or general JSON Schema validator.
Duplicate JSON keys follow the host parser's last-value behavior; lexical number
precision already lost during parsing cannot be reconstructed. Range checks
preserve safe integer IDs present in producer JSON. It makes no semantic/safety
assertions beyond the documented projection/structural checks.

The [fixture index](../examples/json-v1/README.md) links independent, handcrafted
legacy/current mixed-policy+filter+group+limit, empty, partial/failed/skipped and
fatal documents. They are fictional examples even where mode says `live`.
Tests compare these and a separate boundary/type/omission corpus against the
schema and consumer; mutations verify that weakened schema rules are detected.
Real CLI demo and fake API runs check exits 0/1/2, file/stdout byte equivalence,
large IDs, redaction and process-level consumption without external services.

The offline test interpreter supports exactly `$schema`, `$id`, `$defs`, `$ref`,
`title`, `description`, `type`, `const`, `required`, `properties`,
`additionalProperties`, `minimum`, `maximum`, `minItems`, `maxItems`, `items`,
`anyOf` and `oneOf`, including boolean schemas and nullable type arrays. It rejects
unsupported keywords/ref forms/types/dialects and recursion, including unused
branches. It is a test utility, not production validation or a claim of general
Draft 2020-12 compliance. Use an independent conforming validator when available.
