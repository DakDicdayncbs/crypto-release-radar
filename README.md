# Crypto Release Radar

A small Node.js 22+ CLI that reads an explicit repository list and turns published
GitHub releases into a table, JSON, Markdown, CSV or NDJSON report. No runtime or
development dependencies.

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
node bin/crypto-release-radar.js --demo --format markdown
node bin/crypto-release-radar.js --demo --format csv
node bin/crypto-release-radar.js --demo --format ndjson
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
| `repositories` | required | 1–20 explicit slug strings or repository policy objects; mixed lists allowed |
| `groups` | omitted | Up to 10 local named lists, each with 1–20 explicit repository entries |
| `limit` | `5` | Default display limit per repository, 1–50, after filtering and UTC sorting |
| `includePrereleases` | `false` | Default policy for records GitHub labels as prereleases |
| `maxPages` | `3` | 1–10 pages per repository, 100 records per page |
| `timeoutMs` | `10000` | 100–30000 ms for each complete HTTP page, including its body |

Unknown config keys are rejected, including embedded tokens and alternate hosts.
The CLI uses `radar.config.json` by default; that local file is ignored by Git.
Repository names are compared case-insensitively for duplicates across strings
and objects. URLs, credentials, discovery, and duplicate slugs are not accepted.

Config files must be regular files, strict UTF-8 without a leading BOM, at most
**131072 bytes (128 KiB)** including whitespace, and at most **8 nested containers**.
The same reader enforces these limits for scans and `--validate-config`; see
[file limits and diagnostics](#file-limits-and-diagnostics) below.

```text
--config PATH             Config file
--format FORMAT           table (default), json, markdown, csv, or ndjson
--output FILE             Atomically save a report; stdout stays empty
--overwrite               Allow replacing an ordinary file; requires --output
--include-prereleases     Include prereleases in every repository
--limit NUMBER            Override every repository's display limit
--total-limit NUMBER      Cap the final combined display (1–1000, CLI only)
--since TIMESTAMP         Inclusive publication lower bound (CLI only)
--until TIMESTAMP         Inclusive publication upper bound (CLI only)
--tag-pattern GLOB        Match original tags; repeat up to 10 times (OR, CLI only)
--group NAME              Select local groups; repeat for up to 10 distinct names
--demo                    Use bundled synthetic data (cannot combine with --config)
--validate-config         Validate the entire local config without network/token access
--help                    Usage
--version                 Version
```

There are no positional arguments, token flags, custom API URLs, telemetry,
notifications, downloads, or background jobs.

### Validate a local configuration

```sh
node bin/crypto-release-radar.js --validate-config --config examples/repos.json
node bin/crypto-release-radar.js --validate-config --config examples/groups.json
node bin/crypto-release-radar.js --validate-config
```

The last command reads `radar.config.json` from the current directory. This mode
uses the **same `readConfig` / `validateConfig` path as a scan**, including every
repository and group definition, even unused groups. It checks required fields,
types, bounds, unknown fields, names, slugs and case-insensitive duplicate slugs
within each list. It never reads `GITHUB_TOKEN`, calls the API or report collector,
or writes/modifies files. No config values, paths or tokens are echoed.

Success exits **0**, leaves stderr empty and prints exactly this line to stdout:

```text
Config is valid locally. Repository existence, access and authentication were not checked.
```

Usage, unreadable-file, malformed-JSON and invalid-config failures exit **2**, with
empty stdout and the existing safe `code: message` diagnostic on stderr. There
is no JSON report/error envelope or exit 1 in validation mode. The command checks
local validity only: it does not establish repository existence, accessibility,
credentials, rate limits or release availability.

`--validate-config` is valueless, allowed once, and accepts only `--config PATH`,
`--help` and `--version`. Help/version show information without reading a file
(help takes precedence if both are present). As with ordinary commands, all
arguments must still parse successfully. `--demo`, `--group`, `--format` (even
`table`), `--output`, `--overwrite`, `--limit`, `--total-limit`, `--include-prereleases`, `--since`, `--until` and
`--tag-pattern` are conflicts in either order; `--validate-config=true` and
positional values are also usage errors. Omitted policy values are validated
with the normal defaults; validation does not save those defaults to the file.

Because no groups are selected, independent groups may overlap or contain more
than 20 repositories **in total across definitions** within the existing bounds.
Validation does not promise that every combination of groups can be scanned.
The scan's shared selection validator remains authoritative for unknown/repeated
group selections, case-insensitive overlap and the combined 20-repository budget.

### File limits and diagnostics

The byte limit is inclusive: a file of exactly **131072 UTF-8 bytes** can pass;
131073 bytes cannot. All bytes count, including whitespace, CRLF line endings,
and multibyte characters. No trimming, BOM removal, lossy UTF-8 decoding or file
rewriting is performed. Invalid UTF-8 and a leading BOM are rejected. JSON
escapes retain the normal JSON meaning; slug/name constraints still apply after
decoding. Both example configs and 20 default entries plus 10 groups of 20
maximum-length policy objects fit, including four-space pretty printing. Mixed
string/object entries remain supported.

Depth counts simultaneously open JSON objects and arrays: the root object or
array has depth **1**, each nested container adds one, and scalar values add none.
Depth 8 is allowed by the reader; depth 9 is rejected. A normal config with group
policy objects needs only depth 4. Quoted braces/brackets and escaped quotes or
backslashes do not affect depth. An iterative, bounded-stack check runs **before
JSON.parse**; JSON.parse still validates the complete grammar. A too-deep prefix
can therefore report `config_depth` even if the remaining document is malformed.

The reader checks file type/size before and after opening, but does not trust
size metadata alone: it reads into one **131073-byte buffer**, stopping at the
first extra byte or EOF, and checks size again after EOF. This detects overflow
with stale metadata and observed file growth without loading an unlimited file.
The descriptor is closed in a `finally` block, including on read failures. A
close failure is a read error. Concurrent writes are not an atomic snapshot;
finish saving a config before running the command.

Directories, FIFOs, devices and a **symlink in the final path component** are
rejected. Parent-directory symlinks may resolve normally. Read-only opening uses
[Node's nonblocking and no-follow flags](https://nodejs.org/docs/latest-v22.x/api/fs.html#file-open-constants)
to guard against replacement with a FIFO or symlink between checks. Bounded config
file reads require those flags (Linux/macOS); platforms without them fail closed
with `config_read`. This does not change the offline demo, help or version.

| Code | Meaning |
| --- | --- |
| `config_read` | Missing/refused/unreadable input, unsupported safe-open flags, or a filesystem/close failure |
| `config_size` | Observed file size or bytes read exceed 131072 |
| `config_encoding` | Invalid UTF-8 or a leading BOM |
| `config_depth` | Lexically nested containers exceed depth 8 |
| `config_syntax` | Malformed JSON, including empty input or mismatched/unclosed delimiters |
| `invalid_config` | Parsed config violates the documented fields, types, lists, names, bounds or slug uniqueness |

Semantic error messages now begin with a **safe logical location**, followed by
the explanation. These are schema locations, not filesystem paths, JSON Pointer
expressions, line/column positions, byte offsets or character offsets:

| Location example | Meaning |
| --- | --- |
| `$` | Root value, or unknown field in the root object |
| `$.repositories` | Missing/invalid default list or its length |
| `$.repositories[2]` | Third entry, or unknown field inside that policy object |
| `$.repositories[2].slug` | Missing/invalid/duplicate slug in the third policy object |
| `$.timeoutMs` | A known top-level field |
| `$.groups[1].name` | Invalid name of the second parsed group |
| `$.groups[1].entries[2].limit` | Limit of the third entry in the second parsed group |

All indices are **zero-based**. Group indices follow own-property enumeration
order after JSON parsing: integer-like keys come first in numeric order, followed
by other keys in insertion order. Valid group names cannot be integer-like, so
valid names retain their order. `.name` and `.entries` are fixed diagnostic
segments, not new config fields. Unknown keys point only to their containing
object; duplicate slugs point to the later entry (or its `.slug`). Arbitrary group
names, keys, values, token text and paths never enter diagnostics. There are no
raw parser/system snippets and no source-location claims affected by Unicode or
CRLF. File/encoding/syntax/depth errors do not invent a semantic field location.

For example, `invalid_config: $.groups[1].entries[2].limit: Repository limit must
be an integer between 1 and 50.` identifies the field without echoing its value
or group name. **Compatibility:** semantic errors retain `invalid_config` but
their message gains a location; malformed JSON now uses `config_syntax` instead
of `invalid_config`. File resource/encoding errors have the new codes above.
Use codes rather than matching English messages. Validation still returns 0/2
with its unchanged success line and stderr-only failures; scan config failures
still return 2 and preserve the existing JSON error envelope when `--format json`
is selected. All checks precede overrides, token access and API requests.

### Editor schema

[schemas/config.schema.json](schemas/config.schema.json) uses
[JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12/json-schema-validation).
It describes mixed slug/policy entries, groups, required/unknown fields, strict
ASCII names and slugs, booleans, integers and bounds. Its `default` annotations
are editor hints; runtime supplies defaults. All `$ref` targets stay within the file.

Associate configuration files **externally**, without adding `$schema` to the
config: it remains an unsupported runtime field. For example, open this project
folder in VS Code and merge this into your workspace settings, adjusting the
file patterns for your own configs:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["/radar.config.json", "/examples/repos.json", "/examples/groups.json"],
      "url": "./schemas/config.schema.json"
    }
  ]
}
```

The mapping belongs in editor settings, **not** in a Radar config. See
[VS Code's external schema mapping](https://code.visualstudio.com/docs/languages/json#_mapping-to-a-schema-in-the-workspace).
Editor support for Draft 2020-12 varies (VS Code documents limited support);
always run `--validate-config` as the final local check.

The schema is an aid, not a complete replacement for runtime validation.
`uniqueItems` compares **whole entries**: it catches identical entries but cannot
enforce case-insensitive slug uniqueness across strings and objects or objects
with different policies. Those duplicates are rejected by runtime in every list,
including unused groups. CLI group selection constraints described above are
outside the config schema. Neither the schema nor local validation checks GitHub.
The schema validates **parsed values**, not file byte counts, encoding, file type
or pre-parse depth. For example, padding an otherwise valid document past 128 KiB
does not change schema validity but is rejected by `readConfig`. The file rules
are documented in the schema description, not invented JSON Schema keywords.

Tests interpret the schema's used standard keywords with a small test-only
interpreter, compare a shared structural corpus with runtime, and explicitly
exercise these semantic exceptions. Mutation checks ensure weakened schema rules
are detected. Unsupported test-interpreter keywords fail explicitly; it is not a
general JSON Schema implementation or a separate application validator. This
keeps the application and its offline test suite dependency-free.

### Individual repository policies

A `repositories` entry may be a slug string or an object containing only:

| Field | Required | Meaning |
| --- | --- | --- |
| `slug` | yes | The same explicit `owner/repo` string accepted by the original format |
| `limit` | no | Integer 1–50; inherits the top-level limit when omitted |
| `includePrereleases` | no | Boolean `true` or `false`; inherits the top-level policy when omitted |

For each field independently, the priority is **explicit CLI override > repository
object > top-level config > built-in default**. An explicit `false` overrides a
top-level `true`. `--include-prereleases` sets `true` for every repository; omitting
it leaves configured values in effect. There is no CLI flag to force `false`.
`--limit NUMBER` overrides every repository's limit. Overrides do not bypass
validation: wrong types/ranges, `null`, arrays, missing slugs, and unknown fields
fail safely with exit `2` before token access or API requests, even if CLI options
would replace those values. Optional fields must be omitted to inherit, not set
to `null`. Network budgets remain top-level only; date/tag filters remain CLI-only.

Existing string-only files need no migration. For example, these two entries are
equivalent and can be substituted without changing selection:

```json
"ethereum/go-ethereum"
```

```json
{ "slug": "ethereum/go-ethereum" }
```

To customize only some repositories, save a mixed config such as:

```json
{
  "repositories": [
    "bitcoin/bitcoin",
    { "slug": "ethereum/go-ethereum", "limit": 2, "includePrereleases": false },
    { "slug": "foundry-rs/foundry", "limit": 1 }
  ],
  "limit": 5,
  "includePrereleases": true,
  "maxPages": 3,
  "timeoutMs": 10000
}
```

Without CLI overrides, the effective policies are Bitcoin `5/true`, Geth
`2/false`, and Foundry `1/true` (`limit/includePrereleases`). Running that config
with `--limit 4 --include-prereleases` applies `4/true` to all three. Converting a
string to an object does not grant extra access or change which endpoint is used.

JSON keeps `schemaVersion: 1` and existing scan/release fields. Every entry in the
report's `repositories` array now includes `policy: { limit, includePrereleases }`
with its effective settings, including empty, failed, and skipped repositories.
Table scan-status lines show the same policy. `scope.limitPerRepository` and
`scope.includePrereleases` summarize **actual effective settings**, not fallback
defaults: each retains its previous number/boolean when all repositories agree,
and is **`null` when that particular setting differs**. This is a nullable extension
for mixed policies; consumers using objects should read each repository's `policy`
rather than assume one global setting. Existing string-only configurations retain
their previous scope values and selection. The new policy field is additive, so
the report version remains unchanged. Token redaction still covers report strings;
policy limits and booleans remain typed values.

All filters run before per-repository display limits, followed by the global UTC
sort and optional [total display limit](#total-display-limit). Draft exclusion,
record validation, duplicate detection, scan budgets, partial errors, completeness
and exit codes are unchanged. Policies also
apply to repositories whose requests are skipped after authentication/rate errors;
their displayed policy describes the requested selection, not a successful scan.

### Named repository groups

Define optional local `groups` as an object mapping names to explicit repository
lists. Each member uses the same slug string or `{ "slug", "limit",
"includePrereleases" }` format described above. There is no discovery, group
nesting/reference, external include, regex selection, or remote config loading.
The top-level `repositories` list is still required, even when groups are selected.
The runnable [group example](examples/groups.json) contains:

```json
{
  "repositories": ["bitcoin/bitcoin"],
  "groups": {
    "clients": [
      "bitcoin/bitcoin",
      { "slug": "ethereum/go-ethereum", "limit": 2, "includePrereleases": false }
    ],
    "tooling": [
      { "slug": "foundry-rs/foundry", "limit": 1, "includePrereleases": true }
    ]
  },
  "limit": 3,
  "includePrereleases": false,
  "maxPages": 3,
  "timeoutMs": 10000
}
```

```sh
node bin/crypto-release-radar.js --config examples/groups.json
node bin/crypto-release-radar.js --config examples/groups.json --group clients
node bin/crypto-release-radar.js --config examples/groups.json --group tooling --group clients --format json
node bin/crypto-release-radar.js --config examples/groups.json --group clients --limit 4 --include-prereleases
```

Without `--group`, only top-level `repositories` are selected: the first command
requests Bitcoin. With one or more groups, their lists **replace** the top-level
list; they are not appended to it. Groups expand in CLI argument order, with each
group's members in definition order. Thus the third command requests Foundry,
Bitcoin, then Geth. This is request/scan-status order; releases retain the existing
global publication-time UTC sort. Policy precedence remains CLI > selected member
object > top-level > defaults, including explicit `false`. No group-level policy
fields are supported. The fourth command applies `limit: 4` and
`includePrereleases: true` to both selected members.

Names are **1–32 lowercase ASCII letters, digits or hyphens, starting with a
letter**. They are exact names, not patterns. Use the separate-value spelling
`--group NAME`. A config may define **0–10 groups**, each containing **1–20 members**
(at most 200 group-member definitions, plus up to 20 top-level entries). `{}` is
valid for no definitions; an empty group is not. Select at most **10 distinct
names** and at most **20 repositories total**. All original per-repository page,
request and timeout budgets remain unchanged.

Unknown or repeated selections and totals over 20 are safe usage errors (exit
`2`). Within every list, duplicate slugs are rejected case-insensitively. Across
**selected** groups, any overlapping slug is also an error, even if its policies
are identical or CLI overrides would make them identical. There is no silent
deduplication, policy merging, or repeated repository request. A slug may occur
in separately selectable groups with different policies, but those groups cannot
be selected together. A group may overlap the top-level list because the lists
are alternatives and are never combined.

All definitions, including the top-level list and **unselected groups**, are
validated before token access or API requests. Invalid names, types, unknown
member fields, duplicate members, policy values, or oversized definitions are
configuration errors (exit `2`), even when CLI overrides would hide them. Safe
diagnostics do not echo arbitrary names, slugs, config values or token text.
Group names appear in successful reports and should not contain secrets; existing
token redaction covers them. Configs without `groups` keep their prior behavior.
`--group` cannot be combined with `--demo`; the unchanged demo uses only bundled
synthetic repositories and no network or token.

The report remains `schemaVersion: 1`, with two additive fields:

- `scope.groups` lists the selected names in CLI order, or `[]` for the default
  list/demo. Tables show the same selection.
- Each `repositories` entry adds boolean `requested`: `true` if a live API request
  was attempted, including failed attempts; `false` for skipped members and offline
  demo data. Table scan-status lines show this too. `pagesFetched` still counts
  successfully fetched pages, so it can be zero even when `requested` is true.

Only selected repositories appear in scan status; unselected definitions are not
fetched or included in completeness. After authentication/rate errors, remaining
selected members still appear with `requested: false`, their effective policy,
and the existing `skipped` issue. A successful empty selection result exits `0`;
a partial or skipped scan, including one filtered to zero releases, stays
incomplete and exits `1`. Groups do not change draft exclusion, date/tag filters,
sorting, display limits, duplicate-record detection, or pagination behavior.

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
`selectionLimited` compares that count with the count after the per-repository
limit, before any total display limit, and `scannedEntries` still includes all
retrieved entries.

A publication window **does not guarantee completeness or freeze GitHub data**.
It makes the filter repeatable, but releases can be added, edited, or removed
between runs or during pagination. The CLI still scans every page within the
existing budget, even if a page contains only older or newer releases. Filtering
an incomplete scan to zero releases preserves its issues, `complete: false`, and
exit `1`, including invalid records and duplicates outside the window. A valid
complete scan with no matches exits `0`; all existing exit codes remain unchanged.
Omitting `--until` preserves the existing `--since` selection; omitting both bounds
preserves the unfiltered publication-time selection.

## Tag patterns

Use `--tag-pattern GLOB` to match the **whole original `tag_name`**, with case
sensitivity. Repeat the option to accept a tag matching **any** pattern (OR).
That selection is combined with the date window and prerelease policy (AND),
before sorting and the display limit. Drafts are always excluded. With no patterns,
tag selection is unchanged. This option is CLI-only; `tagPatterns` is not a config
field.

| Syntax | Meaning |
| --- | --- |
| `*` | Zero or more Unicode code points, including spaces and slashes |
| `?` | Exactly one Unicode code point |
| `\*`, `\?`, `\\` | Literal star, question mark, or backslash |
| Everything else | Literal characters, including `.`, `+`, brackets, braces, parentheses, `^` and `$` |

This is a small glob language, not a regular expression or a shell expression.
There is no regex, extglob, brace/class expansion, filesystem traversal, or command
execution. For example, `[12]` matches those four characters, not `1` or `2`;
`?(v1)` matches one character followed by literal `(v1)`, not an optional `v1`.
No Unicode normalization or case folding occurs: `?` matches `🚀`, but an `e`
followed by a combining accent needs two `?` tokens. Matching uses bounded dynamic
programming, not recursive backtracking: at most pattern tokens × tag code points
steps per pattern. Existing record validation caps tags at 1024 UTF-16 code units.

Supply **1–10 patterns**, each **1–128 Unicode code points** including escape
characters. A preliminary cap of **256 UTF-16 code units** applies before Unicode
iteration. Repeated identical patterns are permitted, count toward the ten-pattern
limit, and remain in report order. Empty patterns, unfinished backslashes, and
escapes other than `\*`, `\?`, or `\\` fail with a safe usage error (exit `2`).
Patterns also reject control and format characters (Unicode `Cc`/`Cf`, including
C0/C1 controls, bidi controls and zero-width joiners), line/paragraph separators
(`Zl`/`Zp`), and unpaired surrogates. Ordinary spaces are literal and are not trimmed.
Validation finishes before config/token access or requests; invalid input is not
echoed.

In POSIX shells such as bash and zsh, put each pattern in **single quotes** to
prevent shell expansion and preserve backslashes. Examples:

```sh
node bin/crypto-release-radar.js --demo --tag-pattern 'v1.*' --tag-pattern 'v0.4.?'
node bin/crypto-release-radar.js --demo --tag-pattern 'v1.*' --include-prereleases --limit 1 --format json
node bin/crypto-release-radar.js --demo --tag-pattern 'v*' --since 2026-09-29T00:00:00Z --until 2026-09-29T23:59:59.999Z
node bin/crypto-release-radar.js --demo --tag-pattern 'v1.\*'
node bin/crypto-release-radar.js --demo --tag-pattern='--literal*'
```

The fourth command looks for a literal `v1.*` and has no matches in the demo.
The `--tag-pattern=GLOB` spelling also works and is required if the pattern starts
with `--`, so it is not mistaken for another option. Use your shell's literal
quoting rules if the pattern itself contains a single quote.

Matching happens before display cleanup, truncation to 200 code points, or token
redaction. A long tag can therefore match a suffix omitted from its displayed
value, and a cleaned display value need not itself match. No extra raw-tag field
is exposed. JSON reports include `scope.tagPatterns` (an empty array without a
filter); tables display the patterns as a JSON array to make escaping visible.
**Patterns are public report data, not a place for secrets.** The configured
`GITHUB_TOKEN` is redacted from these fields too, without changing selection.

All received records are still validated and duplicate IDs detected before tag
selection. Errors outside matching tags remain visible. Pagination continues
within its normal budget even after a nonmatching page or enough matches for the
display limits. `matchingReleases` counts filtered records and `selectionLimited`
describes per-repository truncation; `scannedEntries` describes all received
entries. A complete empty selection exits `0`; an empty incomplete scan still exits `1` and retains its
diagnostics. Tag filtering does not guarantee completeness or freeze remote data.

## Total display limit

Use `--total-limit N` to show at most **N releases across all selected repositories**.
It works with live scans, groups, per-repository policies, date/tag filters and
the synthetic demo. Omitting it preserves the existing selection, JSON shape and
table output. It is CLI-only: `totalLimit` and `total-limit` remain invalid
top-level config fields and repository policy fields, including group member
policies; the editor schema is unchanged.

```sh
node bin/crypto-release-radar.js --demo --total-limit 1
node bin/crypto-release-radar.js --demo --include-prereleases --total-limit 2 --format json
node bin/crypto-release-radar.js --config examples/groups.json --group clients --limit 4 --total-limit 5
```

Supply one canonical decimal integer from **1 through 1000**, with a separate
value: `--total-limit 10`. The upper bound is the existing maximum of 20 selected
repositories × 50 releases per repository. Zero, signs, leading zeros, fractions,
exponents, whitespace, missing values, duplicates and `--total-limit=10` are usage
errors. Validation precedes config/token access and network calls; failure exits
**2** with safe stderr and empty stdout, even with `--format json`. The flag
conflicts with `--validate-config` in either order. Valid values may accompany
`--help`/`--version`, which retain their usual information-only behavior; invalid
arguments still fail before those options take effect.

The pipeline is: scan the selected repositories within their existing page
budgets; validate/deduplicate records and apply draft, prerelease, tag and date
filters; sort and apply each repository's effective `limit`; merge and sort all
remaining records; then take the first **N**. Both sorts use publication **instant
descending**, original repository **ascending** (case-sensitive lexical order),
and numeric release ID **descending** for ties. Original identities are used
before output redaction. This is not a quota per repository: a repository may
have matches but no rows in the final display.

With the flag present, JSON retains `schemaVersion: 1` and adds
`scope.totalLimit` plus a top-level `display` object, even if nothing is hidden:

| `display` field | Meaning within retrieved data |
| --- | --- |
| `matchingReleases` | Total matching records after all query filters |
| `selectedReleases` | Total retained by per-repository limits, before the global cap |
| `returnedReleases` | Final displayed count, exactly `releases.length` |
| `perRepositoryHiddenReleases` | Matching minus selected |
| `globallyHiddenReleases` | Selected minus returned |
| `globalSelectionLimited` | Whether the global cap actually hid any selected records |

Each repository also gains `selectedReleases` and `globalSelectionLimited` when
the flag is set. Its existing `returnedReleases` always counts its actual rows in
the final `releases` array, including zero. `selectionLimited` continues to mean
**per-repository** truncation: matching exceeds selected. The new
`globalSelectionLimited` means returned is less than selected. A cap equal to or
above the selected count hides nothing, so the global flag is false. Counts stay
numbers and flags stay booleans through token redaction. Without `--total-limit`,
these new fields are omitted and returned still equals per-repository selected.

The table shows the matching, selected and shown totals, both hidden counts, and
the corresponding stages for every repository. For example, 7 matching records
reduced to 5 by per-repository limits and then to 4 by the total limit means
2 hidden by per-repository limits and 1 hidden by the total limit.

The display budget **never stops requests early** and does not alter `complete`,
issues, scan metadata, effective policies or exit codes. Failed and skipped
repositories remain visible even if other repositories fill the display. A
complete scan truncated for display still exits **0**; a partial scan still
exits **1**, including when filters leave no displayed records. All counts cover
retrieved data, not unknown releases beyond failed or unrequested pages. A small
display limit neither makes the scan exhaustive nor reduces its request budget.

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
are sorted by the **instant** in `published_at` descending, then original
repository ascending and numeric release ID descending for deterministic ties.
The output uses UTC ISO timestamps. Tag numbers, API page order, and `created_at`
do not determine the sort order.

The CLI scans every page within its budget before choosing the display subset;
it does not stop as soon as `limit` or `--total-limit` is reached. The GitHub list
endpoint's `Link` header controls pagination. A full page without that header triggers a
conservative next-page probe. See [GitHub pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api).

- `complete: true` means every selected repository reached the end of the
  accessible release list without detected errors. It is not a snapshot guarantee:
  releases can change while pagination is in progress.
- `selectionLimited: true` means a complete or partial scan had more matching
  releases than its **per-repository** display limit. With `--total-limit`,
  `globalSelectionLimited` separately marks records hidden after global sorting.
  Neither display limit is an error or changes scan completeness.
- `complete: false` means a page budget, request failure, invalid response/record,
  or duplicate release ID made the scan incomplete. Valid records from received
  pages remain available, but newer releases may exist outside those pages.
- An empty complete result means no matching accessible releases. An empty
  incomplete result does not mean the repository has no releases.

JSON contains `schemaVersion`, `mode`, `generatedAt`, `complete`, `digestNotice`,
`scope`, per-repository scan metadata, `releases`, and `issues`, plus `display`
when `--total-limit` is set. Individual releases contain `repository`, `id`,
`name`, `tag`, `publishedAt`, `prerelease`, `url`, and
`digest: { text, truncated }`. Nullable names fall back to the tag. Issues have
stable codes and optional `status`, `count`, `retryAfterSeconds`, or `resetAt`.

Output goes to stdout by default, or to `--output FILE`. Diagnostics always go to stderr; JSON also embeds them in
`issues`, Markdown includes an Issues section, and CSV/NDJSON include issue records.
Use the direct `node` command when piping report formats, because `npm run`
adds its own script banner.
Fatal config/local errors produce a smaller JSON error envelope when valid
arguments selected JSON without `--output`; file output never saves an error envelope.
Fatal errors in Markdown/CSV/NDJSON and argument parsing failures
leave stdout empty and report safe diagnostics on stderr.

| Exit | Meaning |
| --- | --- |
| `0` | Complete scan (possibly empty or display-limited), valid local config, demo, help, or version |
| `1` | Incomplete scan or API failure; inspect `issues` and stderr |
| `2` | Usage, configuration, or local failure |

## Save an atomic report file

Add `--output FILE` to any of the five report formats. It saves exactly the bytes
that would appear on stdout, including incomplete reports with exit **1**; stdout
stays empty. By default **any existing destination is refused**. Add the valueless
`--overwrite` only to replace an existing ordinary report file atomically:

```sh
node bin/crypto-release-radar.js --demo --format json --output demo-report.json
node bin/crypto-release-radar.js --demo --format json --output demo-report.json --overwrite
node bin/crypto-release-radar.js --config examples/repos.json --format ndjson --output releases.ndjson
```

The parent directory must already exist. Config inputs (including the default
config), demo input and their aliases are protected. Final symlinks, directories,
FIFOs and devices are refused even with `--overwrite`. Argument errors and simple
destination refusals occur before token/API access. Help/version do not touch
output files; `--validate-config` rejects both new options. They are CLI-only.

A unique sibling temp is opened exclusively with private `0600` permissions,
fully written, synced and closed before publication. New paths use an atomic
no-clobber link; replacement uses rename, without truncating the old file. Paths
and input identities are rechecked before publication. CSV CRLF and NDJSON's final
summary/LF are retained. Report generation, requests and display limits are unchanged.

Local/write failures exit **2** with safe stderr and no JSON error envelope on
stdout or in the output file. Before publication the previous output remains intact.
If cleanup fails **after** publication, the diagnostic explicitly says the report
was published; exit 2 then does not mean the output is absent or rolled back.
See [file output policy](docs/OUTPUT.md) for exact errors, path/alias handling,
concurrency and cleanup behavior. Use trusted local directories: the checks are
not an atomic compare-and-swap against hostile filesystem mutation, and no crash
durability or network-filesystem guarantees are claimed.

## Markdown reports

Select `--format markdown` for a standalone document that can be read after
redirecting stdout. The format uses headings, paragraphs, lists and explicit
source links; it adds no dependencies, HTML, image embeds or network requests.

```sh
node bin/crypto-release-radar.js --demo --format markdown
node bin/crypto-release-radar.js --config examples/groups.json --group clients --format markdown --total-limit 5 > release-report.md
node bin/crypto-release-radar.js --demo --format markdown --include-prereleases --since 2026-09-29T00:00:00Z --tag-pattern 'v*' > demo-report.md
```

Use `--output release-report.md` for atomic saving with the policy above. Shell
redirection remains available and can overwrite an existing file. Keep
stderr separate so diagnostics do not become document content. In scripts,
capture the exit status even under `set -e`, for example:

```sh
if node bin/crypto-release-radar.js --config examples/repos.json --format markdown > release-report.md; then
  radar_status=0
else
  radar_status=$?
fi
```

Status **0** is a complete report, including no matches or a limited display.
Status **1** still provides a usable report, prominently marked **INCOMPLETE**;
read its Issues section. Status **2** means a fatal configuration, usage or local
failure, with no Markdown report on stdout. A redirection can still create an
empty file in that case. Check the status before using the file. Help and version
retain their informational text behavior, even with `--format markdown`.

Every report includes:

- Generation time in UTC, live or explicitly fictional synthetic-demo provenance,
  and complete/incomplete status near the beginning.
- Inclusive publication bounds, original tag patterns, selected groups, effective
  prerelease and limit summaries, page budgets, and matching/selected/shown counts.
  Mixed policies are labeled and detailed separately for each repository.
- Releases in the same order as table/JSON, with repository identity,
  displayed name/tag, numeric ID, UTC publication time, prerelease flag and a
  GitHub source link. Excerpts remain automatic and unverified, with truncation
  explicitly shown. Demo links remain labeled fictional.
- Every selected repository, including failed and skipped requests: status,
  whether the API was requested, pages fetched versus budget, scanned entries,
  effective policy, matching and returned counts, and both kinds of hidden rows.
- All safe issues, including repository, code, message and available HTTP status,
  count, retry delay or reset time. They also remain on stderr as before.

Empty incomplete reports explicitly say that no displayed matches do **not**
establish the absence of releases. Limits only affect display: Markdown uses the
same normalized, token-redacted report as JSON, preserving requests, filtering,
deduplication, policies, completeness and exit codes. Formatting does not mutate
that report or change numeric/boolean metadata. Table and JSON remain unchanged.

Text is emitted literally using [CommonMark escaping and character references](https://spec.commonmark.org/0.31.2/#backslash-escapes).
Line breaks/controls are flattened; punctuation, backticks, backslashes, brackets,
pipes and HTML characters are escaped in headings, prose, source labels, filters
and diagnostics. Colons, periods and at-signs use character references so
[GFM bare URL/email autolinks](https://github.github.com/gfm/#autolinks-extension-)
cannot create extra active links. Raw Markdown contains escapes that render as
ordinary punctuation; author-provided Markdown/HTML is never interpreted.

Source URLs are revalidated **after token redaction** against the same HTTPS
GitHub repository/release-path rules used during normalization, without credentials,
query strings or fragments. Markdown delimiters in destinations, including
parentheses/brackets, are percent-encoded; existing valid percent escapes are
preserved, spaces are encoded, and stray percent signs become `%25`. A redaction
placeholder or an invalid source leaves escaped plain text labeled as unavailable
for linking. The formatter never reconstructs a secret-containing URL. These are
CommonMark/GFM documents; arbitrary renderer plugins that reinterpret literal text
are outside this format contract.

`markdown` is case-sensitive; `md`, `Markdown`, `--format=markdown`, duplicate
format flags and missing values are usage errors. Like other formats, it conflicts
with `--validate-config`. Config fields and report schema versions are unchanged.
The [normal](test-support/markdown-normal.md), [empty](test-support/markdown-empty.md)
and [partial](test-support/markdown-partial.md) documents are fixed test expectations,
not observations from a real repository.

## CSV reports

`--format csv` writes a standalone UTF-8 CSV document with a fixed 40-column
header, followed by one report row, all selected repository rows, globally sorted
release rows and every safe issue row. Metadata has an explicit place even when
no releases match or every request fails. The report includes query/group and
policy metadata, page budgets, completeness, both display limits, hidden counts,
synthetic/live provenance and the automatic-unverified digest notice.

```sh
node bin/crypto-release-radar.js --demo --format csv
node bin/crypto-release-radar.js --config examples/repos.json --format csv --total-limit 5 > release-report.csv
```

Fields are always quoted, quotes are doubled, commas separate fields, and every
record ends in CRLF. Embedded line breaks are preserved by CSV encoding; existing
upstream text normalization still applies. Text with a dangerous formula start
receives an apostrophe prefix, including full-width markers after leading Unicode
whitespace/control/format characters and leading TAB/CR/LF. This changes exported
text and does not guarantee safety after arbitrary spreadsheet re-saving.
Import columns as **Text** to retain exact large IDs, dates and leading zeros.

Exit 0 means complete, exit 1 still produces full CSV marked incomplete, and
fatal exit 2 leaves stdout empty with safe stderr. `--output FILE` saves the same
CSV bytes atomically; shell redirection remains available. CSV changes neither collection nor the
existing table/JSON/Markdown formats. See the [CSV version 1 contract](docs/CSV.md)
for exact column/row order, field applicability, null versus zero/false, safe
import, formula-prefix rules and standalone normal/empty/partial examples.

## NDJSON reports

`--format ndjson` writes UTF-8 without BOM, one compact JSON object per
LF-terminated line. Record order is one `metadata`, every selected `repository`,
globally ordered `release` records, all safe `issue` records, and one final
`summary`. Empty, failed and skipped repositories stay visible. Numbers,
booleans, nulls, optional fields, query/group/policy metadata and both display
limits retain their JSON meaning. Collection, normalization, redaction, sorting
and limits finish before export; this is not live streaming of API pages.

```sh
node bin/crypto-release-radar.js --demo --format ndjson
node bin/crypto-release-radar.js --config examples/repos.json --format ndjson --total-limit 5 > release-report.ndjson
```

Check both the process exit status and the document: **0** means a complete scan,
**1** an incomplete scan with all issues and a final summary, **2** a fatal error
with safe stderr and empty stdout. Shell redirection may still create an empty
file. `--output FILE` saves identical NDJSON bytes with the atomic file policy
above; no NDJSON input command or extra requests are added.

Only a validated final summary, its terminating LF, consistent counts and end of
input confirm document completion. `summary.documentComplete: true` is separate
from `summary.scanComplete`: a fully delivered incomplete scan remains incomplete.
Metadata, parseable earlier lines, or a valid final JSON object **without LF**
are insufficient. Recovery retains only checked whole records before a broken or
unfinished line; the suffix is never treated as a release or completion signal.
Recovery neither repeats the scan nor proves freshness or the absence of releases.

See the [NDJSON version 1 contract and consumer example](docs/NDJSON.md) for all
record fields, ordering, counters, byte-level recovery, and limits of validation.
The format is not a signature and cannot detect every external modification.

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
