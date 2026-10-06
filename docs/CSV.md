# CSV report contract — version 1

Use `--format csv` to write one standalone report to stdout. This is an explicit
projection of the same normalized, token-redacted report used by JSON. It does
not change filtering, global ordering, requests, policies, completeness, stderr
or exit status, and does not expose raw API responses, bodies, headers or errors.
There are no runtime dependencies or file-writing options.

```sh
node bin/crypto-release-radar.js --demo --format csv
node bin/crypto-release-radar.js --config examples/groups.json --group clients --format csv --total-limit 5 > release-report.csv
```

Use a new filename: redirection is performed by the shell and can overwrite an
existing file. Keep stderr separate. Under `set -e`, capture status explicitly:

```sh
if node bin/crypto-release-radar.js --config examples/repos.json --format csv > release-report.csv; then
  radar_status=0
else
  radar_status=$?
fi
```

Exit **0** includes a complete CSV report, even when no releases match or display
limits hide rows. Exit **1** includes a full CSV report marked `complete=false`,
even when every repository failed or no releases remain after filtering. Read
the report and repository completeness fields and every issue row. An incomplete
empty selection does not establish that the repositories have no releases.
Exit **2** leaves stdout empty, with safe stderr only; shell redirection may still
create an empty file. Do not treat such a file as a successful report. Help and
version retain their usual informational text output.

`csv` is case-sensitive. `CSV`, `tsv`, `--format=csv`, missing values and repeated
format options are usage errors, before config/token/network access. Like other
formats, CSV conflicts with `--validate-config`. It does not add a config field,
`--output`, NDJSON, a new JSON schema version or spreadsheet automation.

## Encoding and record layout

Output is **UTF-8 without a BOM**, with comma separators. Every field, including
headers, numbers, booleans and empty cells, is enclosed in ASCII double quotes.
Inside a field, each double quote becomes two double quotes. Records end with
**CRLF**, including the final record. No `sep=` directive, prose, blank record,
alternate delimiter, unstructured preamble or footer is inserted. These quoting
and record rules follow [RFC 4180 section 2](https://www.rfc-editor.org/rfc/rfc4180#section-2).
Unicode is retained as UTF-8 rather than restricted to ASCII.

CSV quoting preserves embedded CR, LF and CRLF exactly; never read this format
by splitting physical lines. Existing upstream normalization already cleans and
flattens remote names/tags and builds bounded plain-text excerpts from notes.
CSV does not restore those original strings or apply another cleanup pass. The
formula-protection prefix described below is the only additional text change.

Every row has the same **40 columns**, in the exact order below. Record order is:

1. One header row containing the column names.
2. Exactly one `report` row, including when there are no release rows.
3. One `repository` row for every selected repository, in selection/request order,
   including failed, skipped, empty and display-hidden repositories. Unselected
   config definitions do not appear.
4. All `release` rows in the existing global order: publication instant descending,
   original repository ascending, numeric ID descending. Redaction does not resort.
5. All `issue` rows, preserving the report's issue order.

Rows are distinguished by `row_type`, not their position alone. The `csv_version`
on the report row versions this column/row contract independently of
`report_schema_version`, which records the underlying report version. Both are 1
in this implementation.

## Columns

`report/repository` means the field applies to both row types; all other types
leave it empty. Integer and Boolean describe the logical type: CSV readers return
strings, and quoted cells do not force a spreadsheet to preserve those types.
Integers are exact base-10 digits without grouping or exponents; booleans are the
literal lowercase `true` and `false`. All counts refer to retrieved data.

| Position | Column | Rows | Meaning |
| --- | --- | --- | --- |
| 1 | `row_type` | all | `report`, `repository`, `release` or `issue` |
| 2 | `csv_version` | report | Integer CSV contract version, 1 |
| 3 | `report_schema_version` | report | Integer source report schema version |
| 4 | `mode` | report | `live` or `demo`; demo data and source links are fictional |
| 5 | `generated_at` | report | Actual report generation time, UTC ISO timestamp |
| 6 | `complete` | report/repository | Boolean: whole-scan or this repository's completeness |
| 7 | `digest_notice` | report | Notice that excerpts are automatic, not verified breaking/security assessments |
| 8 | `since` | report | Inclusive publication lower bound, UTC ISO; empty means unbounded |
| 9 | `until` | report | Inclusive publication upper bound, UTC ISO; empty means unbounded |
| 10 | `tag_patterns` | report | Compact JSON array of effective whole-original-tag OR patterns; `[]` means no tag filter |
| 11 | `groups` | report | Compact JSON array of selected group names in CLI order; `[]` means default/demo repositories |
| 12 | `limit_per_repository` | report/repository | Integer display cap per repository; report summary is empty for mixed caps; each repository has its effective cap |
| 13 | `include_prereleases` | report/repository | Boolean effective policy; report summary is empty for mixed policies; drafts remain excluded |
| 14 | `max_pages_per_repository` | report/repository | Integer page budget, repeated on each repository row; up to 100 entries per page |
| 15 | `total_limit` | report | Integer global display cap; empty means the flag was omitted |
| 16 | `repository` | repository/release/issue | Repository identity as displayed after redaction; empty on an issue if no repository was supplied |
| 17 | `requested` | repository | Boolean: whether the API was requested; false for synthetic demo or skipped repositories |
| 18 | `pages_fetched` | repository | Integer count of successfully fetched pages, including 0 |
| 19 | `scanned_entries` | repository | Integer count of all retrieved entries, before filters/deduplication |
| 20 | `matching_releases` | report/repository | Integer matching count after validation/deduplication and all query filters, before display limits |
| 21 | `selected_releases` | report/repository | Integer count retained by per-repository limits, before the global cap |
| 22 | `returned_releases` | report/repository | Integer count actually in final release rows, overall or for this repository |
| 23 | `per_repository_hidden_releases` | report/repository | Integer matching minus selected; sum across repositories on the report row |
| 24 | `globally_hidden_releases` | report/repository | Integer selected minus returned; 0 when the global cap hides nothing or is absent |
| 25 | `selection_limited` | report/repository | Boolean per-repository truncation; report is true if any repository hid matching releases at this stage |
| 26 | `global_selection_limited` | report/repository | Boolean: whether the global cap actually hid selected releases overall or for this repository |
| 27 | `release_id` | release | Positive safe integer GitHub release ID, serialized exactly, including values up to 9007199254740991 |
| 28 | `name` | release | Normalized display name, with existing tag fallback |
| 29 | `tag` | release | Normalized display tag; filters matched the original tag before cleanup |
| 30 | `published_at` | release | Publication instant, UTC ISO timestamp |
| 31 | `prerelease` | release | Boolean GitHub prerelease flag |
| 32 | `url` | release | Validated source URL after token redaction, as text; may contain a redaction placeholder |
| 33 | `digest_text` | release | Automatic, unverified plain-text excerpt |
| 34 | `digest_truncated` | release | Boolean: whether excerpt generation was truncated |
| 35 | `issue_code` | issue | Existing safe application issue code |
| 36 | `issue_message` | issue | Safe application-owned diagnostic, never the raw remote error |
| 37 | `http_status` | issue | Integer HTTP status if provided; empty if unavailable |
| 38 | `issue_count` | issue | Integer count attached to this issue (e.g. invalid/duplicate rows); empty if unavailable |
| 39 | `retry_after_seconds` | issue | Retry hint in whole seconds, including 0; empty if unavailable; no retry is performed |
| 40 | `reset_at` | issue | Validated rate-limit reset time, UTC ISO, if available |

An empty cell (`""` in CSV) denotes null, absent or not applicable according to
the row and column definitions. It is distinct from `"0"` and `"false"`; neither
zero nor false is dropped. CSV has no separate null type: empty text would also
be empty, so use JSON if that distinction is needed outside these valid report
fields. Empty arrays are serialized explicitly as `"[]"`, not an empty cell.
JSON array strings occupy one quoted CSV cell and preserve array/member order;
parse CSV first and JSON-decode just these two cells afterward.

The counts and truncation flags are always present on report/repository rows,
even when `--total-limit` is omitted. In that case selected equals returned,
global hidden counts are 0 and global flags are false. This is a CSV presentation
choice; it does not add fields to JSON or mutate the source report. Individual
limits and global limits do not determine completeness, and all issues survive
filtering or display truncation. Unknown source-object fields are not exported.

## Text-cell formula protection and import

CSV quotation alone does not stop spreadsheet formula interpretation. This
export applies one centralized guard to **every string cell**, including names,
tags, excerpts, URLs, scope/array text and diagnostics, before CSV quoting:

- If its first character after leading Unicode whitespace, control (`Cc`) or
  format (`Cf`) characters is `=`, `+`, `-`, `@`, `＝`, `＋`, `－` or `＠`, prepend
  one ASCII apostrophe (`'`) at the absolute start of the cell.
- Also prepend that apostrophe when TAB, CR or LF occurs within that leading
  whitespace/control/format prefix, even without a formula marker afterward.
- Preserve the complete original string after the prefix, including spaces,
  Unicode and embedded line breaks. Do not normalize full-width symbols or
  strip leading controls. Other strings stay unchanged; native numeric/Boolean
  metadata keeps its exact decimal/Boolean representation.

For example, string `=SUM(1,2)` becomes the CSV field `"'=SUM(1,2)"`; string
`  ＋1` becomes `"'  ＋1"`. This deliberately changes exported text and some
viewers show the apostrophe. Existing leading apostrophes remain unchanged;
there is no lossless inverse that distinguishes an existing apostrophe from one
added for protection. JSON remains available for the original normalized values.
Formula-looking strings inside JSON arrays are JSON data within a cell beginning
with `[`, not separate spreadsheet cells. Do not split them using commas.

This policy addresses [CSV/formula injection risks described by OWASP](https://owasp.org/www-community/attacks/CSV_Injection).
It does **not** promise safety in every spreadsheet/editor or after re-saving,
trimming, removing prefixes or converting the data. **Import columns as Text**
with UTF-8 and a comma delimiter, especially release IDs: spreadsheet inference
can round large integers, interpret dates or alter leading zeros even when fields
are quoted. Never rely on opening a CSV file with automatic type inference to
preserve exact data. Use a CSV parser and this contract for programmatic use.

Redaction precedes both formula protection and CSV escaping. A redacted URL is
never rebuilt from secrets, and input metadata types remain unchanged. Labels,
filenames and formulas in the tests are synthetic. The independent
[normal](../test-support/csv-normal.csv), [empty](../test-support/csv-empty.csv)
and [partial](../test-support/csv-partial.csv) expected documents retain exact CRLF
bytes through Git attributes; they are test fixtures, not real observations.
