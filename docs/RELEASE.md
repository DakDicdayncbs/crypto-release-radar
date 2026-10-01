# 0.1.0 baseline handoff

Prepared on 2026-09-30. This is a runnable local release candidate, not a published
GitHub release. At baseline preparation, the account and commit identity were
pending, and no Git initialization, commits, remotes, tags, credential changes,
npm publication, or active Actions workflow were created. Initial publication
preparation on 2026-10-01 updates the account, baseline author, branch, origin, and
CI as recorded below. The coordinator confirmed authentication and repository push
access on 2026-10-01, and the user authorized initial publication that day.

## Included

- `bin/crypto-release-radar.js`: executable CLI with table/JSON and synthetic demo.
- `src/`: config validation, read-only GitHub client, release normalization,
  UTC selection, bounded excerpts, issue/report formatting, and token redaction.
- `test/`: offline unit tests, real loopback HTTP integration, and subprocess tests.
- `fixtures/demo-releases.json`: synthetic releases only, no remote captures.
- `examples/repos.json`: small explicit public repository list.
- `.github/workflows/ci.yml`: Node 22/24 test/demo workflow with verified SHA pins.
- README, MIT license, project AGENTS.md, dependency-free package lock, and 45-item
  roadmap with only the first five baseline items marked complete.

## Verification

Run in the project directory:

```sh
npm ci --ignore-scripts --offline --no-audit --no-fund
npm test
npm run test:coverage
node bin/crypto-release-radar.js --demo
node bin/crypto-release-radar.js --demo --format json --include-prereleases
```

Local validation used Node.js 22.22.3 and npm 10.9.8. Tests need no internet or real
credentials. Local validation used Node 22; Node 24 is included in the CI matrix.
Hosted CI must be checked for the exact pushed SHA through
[the repository's Actions runs](https://github.com/DakDicdayncbs/crypto-release-radar/actions/workflows/ci.yml).
This pre-push baseline document makes no claim about a hosted CI outcome.

Final result: **98 tests passed, 0 failed, 0 skipped**, including the coverage run.
All `src/` modules reached 100% reported line coverage; branch coverage varies by
module, so this is not a claim of exhaustive behavioral coverage. The executable's
exceptional output-stream error paths were not exercised. The coverage run required
permission to bind the fake HTTP server to loopback because the sandbox initially
blocked `listen` with `EPERM`; the authorized rerun passed in full.

An additional read-only smoke test on 2026-09-30 queried `bitcoin/bitcoin` through
the official REST API without any token, using a one-page budget and display limit
of two. It retrieved 68 valid published entries, returned a complete scan, selected
two releases in descending publication time, and produced no issues. Remote
response bodies were not saved. An initial sandboxed request reported a sanitized
network error; the network-authorized retry completed successfully.

Protocol behavior was checked against official sources on that date:

- [List releases](https://docs.github.com/en/rest/releases/releases#list-releases)
- [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Checkout action](https://github.com/actions/checkout) and
  [setup-node action](https://github.com/actions/setup-node)

## Confirmed local identity

The user confirmed the dedicated third account `DakDicdayncbs` and retained
`DragonsMom` as the author. Email privacy remains required: use
`23559880+DakDicdayncbs@users.noreply.github.com` for both author and committer.
The coordinator verified the public account ID; the worker independently verified
the same owner ID on the public repository. No commit was created with a personal
email. The sole unpublished baseline commit was corrected with `amend --reset-author`
under the coordinator's explicit authorization, using real current timestamps.

The first local baseline commit contains the source, tests, synthetic fixtures,
documentation, license, lockfile, and active CI workflow on `main`.
`user.useConfigOnly`, `credential.https://github.com.username=DakDicdayncbs`, and
`credential.useHttpPath=true` are configured locally. Origin is
`https://github.com/DakDicdayncbs/crypto-release-radar.git`; the public API confirmed
the repository was empty with default branch `main` before preparation. No global
Git settings or neighboring projects were changed. Initial publication is authorized
for `main` only, with no tag or GitHub release creation. Published history must never
be rewritten after the first push.

## Prepared CI

The workflow runs for pushes to `main` and pull requests. Each Node 22/24 job uses
`npm ci --ignore-scripts --offline --no-audit --no-fund`, `npm test`, and synthetic
text/JSON demos. It has `contents: read`, `persist-credentials: false`, no custom
secrets, no live RPC/API test calls, no schedule, and no publishing steps.

Pins were verified on 2026-10-01 against official GitHub release tags, commit
objects, and `action.yml` at those commits through the public API without credentials:

| Action | Release | Commit pin |
| --- | --- | --- |
| checkout | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | [3d3c42e5aac5ba805825da76410c181273ba90b1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1) |
| setup-node | [v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) | [820762786026740c76f36085b0efc47a31fe5020](https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020) |

## Publication authorization and scheduling handoff

The coordinator independently verified the existing repository-scoped Keychain
credential with GitHub: the authenticated user is `DakDicdayncbs` (ID `23559880`),
and the exact public origin grants push access. The user authorized the initial
baseline push on 2026-10-01. Use the existing Git/Keychain helper without printing
or copying the token; never borrow another project's credentials. Keep the package
private and do not create tags, GitHub releases, or npm publications.

After the push, verify hosted CI for that exact SHA on both Node 22 and Node 24
and report its actual result. The coordinator enables scheduling after this check.
All later commit/push work requires a separate coordinator dispatch. No additional
functional work belongs in the initial publication run.

The first release's bounded scans, conservative incomplete status, refusal to
follow repository redirects, plain excerpt limitations, and lack of retries/cache
are intentional and documented in the README. They are not pending baseline work.
Future development begins at roadmap item 06 no earlier than 2026-10-02, after a
coordinator dispatch.
