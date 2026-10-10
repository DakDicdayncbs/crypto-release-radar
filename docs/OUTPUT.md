# Atomic report files

`--output FILE` saves an ordinary report in any existing format: table, JSON,
Markdown, CSV or NDJSON. Without it the stdout contract is unchanged, including
the existing fatal JSON error envelope. With it, stdout stays empty and **only a
normally collected report** may be saved. No error envelope is written to the file.
Filtering, ordering, policy/page/display budgets, redaction, API traces and format
bytes are unchanged. CSV retains CRLF; NDJSON retains its final summary and LF.

```sh
node bin/crypto-release-radar.js --demo --format csv --output report.csv
node bin/crypto-release-radar.js --demo --format ndjson --output report.ndjson
node bin/crypto-release-radar.js --demo --format ndjson --output report.ndjson --overwrite
```

The first two commands require new destination names. **No overwrite is the
default**: any existing entry is refused. `--overwrite` is a valueless, explicit
permission to replace an ordinary file. It also permits creating a new file if
the destination was absent at preparation, using the same no-clobber operation.
There is no implicit extension or format detection, append, automatic directory
creation, backup, output path discovery, or NDJSON input command. File saving does
not make an incomplete scan complete or an excerpt verified.

## CLI and exit behavior

`--output` takes one nonempty path as a separate argument. Both new options may
appear once, in either order; `--overwrite` requires `--output`. `--output=FILE`,
`--overwrite=true`, duplicate options, missing/blank values, ASCII controls/DEL,
trailing `/`, and final `.`/`..` components are usage errors. Quote paths containing
spaces; meaningful surrounding spaces are retained. Prefix a filename beginning
with `--` with `./`. A filename `-` is a literal file, not an alias for stdout.

The options are CLI-only: config keys `output`/`overwrite` remain invalid. Both
conflict with `--validate-config`. Validation of arguments precedes config, token,
network and output filesystem work. Valid help/version requests retain ordinary
text and do not inspect or create an output file, even with both new flags.

| Result | Exit | File/stdout behavior |
| --- | --- | --- |
| Complete scan, including empty or display-limited | 0 | Complete report saved; stdout empty |
| Incomplete scan, including all failed or skipped | 1 | Full incomplete report and all issues saved; stdout empty |
| Usage/config/local/write failure before publication | 2 | No new report published; previous destination untouched; stdout empty |
| Temp cleanup failure after publication | 2 | Complete report already saved; explicit published diagnostic; stdout empty |

Safe scan diagnostics remain on stderr. With file output they are emitted before
writing, so a later write error does not hide already collected issues. File errors
add one safe diagnostic. Paths, config values, raw FS exceptions, credentials and
remote bodies are never included. No successful-save banner is emitted.

## Paths and input protection

This implementation supports Linux/macOS filesystem operations. Use an existing,
trusted local directory with suitable permissions and same-filesystem hard-link/
rename support. Other platforms fail closed. Unsupported filesystem operations
fail without a fallback to copying or truncating the destination. No `mkdir` is
performed, including for a missing ancestor. Write permission/space failures may
only become apparent after collection when the temp is created or written.

Relative names are relative to the process working directory. Parent symlinks
are allowed and resolved through filesystem `realpath`. Original component
traversal is retained: `symlink/../file` is resolved by the filesystem, not by
collapsing `..` with `path.resolve()` before following the symlink. Canonical parent
paths and their device/inode identities are recorded and rechecked. `.` and repeated
separators in parents work when the OS resolves them to an existing directory.

The **actually read** input is protected: explicit/default config for live mode,
or the bundled demo fixture for demo mode. File output captures device/inode from
`fstat` on the opened input descriptor, before reading, and retains it after close.
It never substitutes a later path stat for that identity. Output preparation happens
after valid input/group selection, but before reading `GITHUB_TOKEN` or requesting
the API, and creates no file. It rejects:

- The input's canonical filename, including conservative NFC/case-insensitive
  equality even on case-sensitive filesystems.
- Any existing destination with the device/inode of the opened input, including
  hardlinks after that input was renamed or replaced at its original filename.
- Any hardlink to the current regular file at that input filename, if replaced.
- Every final symlink (also dangling), directory, FIFO, socket or device, even
  with `--overwrite`. Output is never opened through a final symlink.

Input and output parents, the original input identity, the current input path,
and current destination are checked again before writing and publication. An
input path changed to a non-regular entry is refused. If the input disappears,
the original filename and retained original inode remain protected. An existing
overwrite target must still match its preparation device/inode, size, mtime and
ctime; disappearance, substitution or observed mutation is refused. A destination
absent at preparation must still be absent, even with `--overwrite`.

## Write and publication sequence

1. Recheck the prepared paths and destination. Choose a random sibling name
   `.radar-output-<UUID>.tmp`, distinct from input and destination. Open with
   exclusive creation (`O_CREAT | O_EXCL`), no-follow/nonblocking write flags,
   and mode `0600`. There are at most eight name attempts. A collision is never
   opened, truncated or removed. No ownership is assumed on a failed open.
2. Capture the new file's identity with `fstat` and set its mode to `0600` through
   the descriptor. Encode the entire formatted, already-redacted report as UTF-8.
   Write sequentially, advancing by actual byte counts; short writes are retried.
   Zero, negative, fractional or oversized write counts are failures.
3. Await file `fsync` and successful close before publication. Close is attempted
   on earlier failures too; an ambiguous close failure is not retried. Check that
   the temp still has its original identity, expected byte size, one link, and mode
   `0600`. Recheck input/output paths and destination again.
4. For an initially absent destination, link the temp to the final name. The
   no-clobber operation refuses a competitor even after the last existence check.
   Then unlink the owned temp name. For an existing ordinary file with explicit
   overwrite, rename the temp over it atomically. Never truncate the previous
   inode, unlink the destination first, or copy bytes into it. Other hardlinks to
   an old report keep their original contents. Replacement gets the new file's
   ownership/mode; old ACLs, permissions and extended attributes are not copied.

The implementation uses Node's documented [file handle write/sync/close and
filesystem APIs](https://nodejs.org/docs/latest-v22.x/api/fs.html). Operations are
awaited sequentially. It assumes local filesystem support for the link/rename
semantics; Node explicitly cautions that exclusive creation can vary on network
filesystems. No network-filesystem or cross-platform compatibility is claimed.

## Errors, cleanup and concurrency limits

Fixed error codes distinguish `usage`, `output_platform`, `output_path`,
`output_type`, `output_exists`, `output_input`, `output_changed`, `output_write`
and `output_cleanup`. Config/demo errors retain their existing safe codes. A failed
publication link, including a late no-clobber collision, is `output_write`.

Before publication, an error leaves the destination as it was; cleanup closes the
temp if needed and attempts to unlink **only that owned name** after checking its
identity and parent again. If its identity cannot be established (for example,
initial temp `fstat` failed), it was substituted, or its parent changed, cleanup
does not risk unlinking a foreign entry. A leftover temp can therefore remain.
There is no wildcard cleanup, recursive directory removal or automatic removal of
another writer's temp file. Error text does not disclose its pathname.

After a successful link, failed temp unlink returns `output_cleanup` with
**“Report was published”** and an explicit no-rollback message. The final name
already contains the complete report; a private second link may remain. An error
before publication instead says **“Report was not published”**. No rollback is
attempted: removing a final name could destroy a concurrent writer's later result.

Concurrent default writers cannot clobber an occupied final name: one wins and
others fail. Explicit overwrite writers may both succeed if their final checks
race; the last rename wins with one complete report, not interleaved bytes. The
checks detect observed changes, but **are not an atomic compare-and-swap or a
directory lock**. Node's path APIs leave intervals between validation and
link/rename/unlink. A process able to mutate parent paths or entries in those
intervals can defeat rechecks. Use directories not concurrently manipulated by
untrusted users; this is not a hostile-filesystem isolation guarantee.

File `fsync` is performed, but parent directories are not fsynced: no promise of
surviving power loss or crash is made. A killed process can leave a private temp,
or a published report plus a temp link. Graceful SIGINT/SIGTERM lifecycle remains
a later roadmap item. Atomic naming is not a signature, a scan snapshot, proof of
freshness, or evidence that no releases exist. Keep inspecting report completeness,
issues and display counters, regardless of where the report was saved.
