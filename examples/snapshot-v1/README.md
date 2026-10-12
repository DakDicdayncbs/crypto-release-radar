# Synthetic snapshot containers

All data, repositories, links and times here are fictional. These manually
specified containers wrap the independent [JSON contract fixtures](../json-v1/README.md).
`synthetic: false` and `mode: "live"` illustrate how live provenance is recorded;
they do not claim that a real request occurred for these fixtures.

- [current.json](current.json): mixed policies, groups, date/tag filters, both
  display limits and maximum safe-integer ID.
- [empty.json](empty.json): a complete empty scan with explicit zero/false/null.
- [partial.json](partial.json): preserved rows, failed/rate-limited/skipped members
  and all safe issues; incomplete remains incomplete.
- [failed.json](failed.json): an empty incomplete full report, not a fatal envelope.
- [legacy.json](legacy.json): baseline required fields with later additions omitted.

These tracked fixtures use `.json`; new CLI destinations require the ignored
`.radar-snapshot.json` suffix. There is no snapshot input/rendering command.
See the [snapshot contract](../../docs/SNAPSHOTS.md) and
[closed Draft 2020-12 schema](../../schemas/snapshot-v1.schema.json).
