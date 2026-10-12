# Independent JSON v1 examples

These handcrafted fixtures are independent of the collector, formatter and
schema. All repositories, links, releases and acquisition times are fictional;
`mode: "live"` illustrates that field and does not claim a live request occurred.

| File | Example | Consumer exit |
| --- | --- | --- |
| [legacy.json](legacy.json) | Original required fields only, before additive query/policy/group metadata | 0 |
| [current.json](current.json) | Mixed policies/null summaries, groups, date/tag filters, both limits and maximum safe-integer ID | 0 |
| [empty.json](empty.json) | Complete empty scan with explicit null/false/zero values and global-budget fields | 0 |
| [partial.json](partial.json) | Preserved releases plus page/record issues, failed request, rate limit with zero delay and skipped member | 1 |
| [failed.json](failed.json) | Empty incomplete full report with failed API access; distinct from fatal | 1 |
| [fatal.json](fatal.json) | Existing smaller config-error envelope | 2 |

Run from the repository root with Node.js 22+:

```sh
node examples/consume-json.js < examples/json-v1/current.json
```

The [consumer](../consume-json.js) emits its own `{kind,data}` wrapper, validates
known fields and omits unknown additions. Exit 1/2 in the last examples is
expected and must remain distinguishable from a complete result. See the
[field and compatibility contract](../../docs/JSON.md) and
[Draft 2020-12 schema](../../schemas/report-v1.schema.json). These are report
examples, not a new snapshot storage or product input feature.
