# Crypto Release Radar worker instructions

Read this file, README.md, and docs/ROADMAP.md before work. Also respect the parent
workspace AGENTS.md. Work only in this project's directory; preserve user changes.
Always set the working directory explicitly for package commands, tests, and any
future Git command. Do not change the coordination folder or neighboring projects.

## Identity and publication

The user confirmed **DakDicdayncbs** as this project's GitHub account and
**DragonsMom** as the commit author. The user requested email privacy before the
first commit. Use `23559880+DakDicdayncbs@users.noreply.github.com` for both
author and committer. This is GitHub's ID-based noreply format for the confirmed
account, whose public numeric ID was verified through the official API. It is set
in this repository's local `user.email`; never restore a personal email or include
one in tracked files. GitHub's web privacy setting does not configure local Git.
The local branch is `main`, and `origin` is
`https://github.com/DakDicdayncbs/crypto-release-radar.git`. Author settings,
`credential.https://github.com.username=DakDicdayncbs`, and
`credential.useHttpPath=true` are project-local. The remote repository exists and
was verified empty before initial publication. On 2026-10-01 the coordinator
verified the existing repository-scoped Keychain credential: authenticated user
`DakDicdayncbs` (ID `23559880`) has push access to this exact repository. The user
authorized the initial baseline push. Use the existing Git/Keychain helper without
printing or copying its token. Subsequent commit/push operations require a separate
coordinator dispatch. No tags or releases are authorized.

This confirmed third account supersedes the previous local account assignment and
any stale pending-account records. The coordinator authorized correcting the sole
unpublished baseline commit with `amend --reset-author`, using real current time,
and activating CI before the first push. That amend permission ends at the first
push: never rewrite published history. Initial publication does not include roadmap
item 06. Do not modify another project or coordinator-owned records.
Do not borrow Tojen-dev or credentials from another project. Never change global
Git identity or credential settings.

Publication must use only a user-confirmed project account and project-local commit
identity. Do not force-push, rewrite published history, invent dates, manufacture
activity, create empty commits, or split trivial work to increase commit counts.
The 45 roadmap entries describe useful work, not a contribution quota.
Keep package.json private; npm publication is not authorized.

## One dispatch, one useful increment

This is the long-lived Release Radar worker managed by the coordinating task
“Изучить очки Developer”. The coordinator owns scheduling and durable run state.
The authorized release-radar slots are 12:00 and 20:00 Europe/Kyiv, with up to
30 minutes of daily variation, dispatched by the coordinator only.
The coordinator enables scheduling after verifying CI for the published baseline.
The next functional item is 06, no earlier than 2026-10-02 and only on its dispatch.

Do not create other tasks, subagents, automations, schedulers, or endless loops.
One future dispatch implements one unchecked roadmap item, adds meaningful tests
and documentation, runs the relevant checks, and updates that item's status.
Stop after the increment. Make commits only after identity is confirmed, with
real timestamps and coherent scope. Routine scheduled success stays quiet; report
failures needing attention, identity setup needs, or roadmap completion.

## Product constraints

- Node.js 22+, ESM, built-in modules; keep this baseline dependency-free.
- Explicit repository lists only. No discovery, trading, downloads, telemetry,
  external notifications, or write requests to GitHub.
- GITHUB_TOKEN is optional, environment-only, and restricted to api.github.com.
  No token flags/files, alternate API hosts, credential creation, or remote redirects.
- Never echo raw remote errors, request headers, credentials, or token-bearing fixtures.
  Use synthetic data and sanitized application-owned issue messages.
- Drafts stay excluded; preserve source links and publication-time UTC ordering.
- Digests are automatic excerpts, never verified breaking/security judgments.
- Preserve partial successes, explicitly mark incomplete results, and return a
  nonzero exit code. Do not present a bounded scan as an exhaustive latest release list.
- CI activation is authorized: `.github/workflows/ci.yml` runs offline install,
  tests, and synthetic demos on Node 22/24. Keep read-only contents permission,
  disabled checkout credential persistence, and verified official action SHA pins.
  No schedules, custom secrets, external RPC/API test calls, or publishing steps.
- Do not send messages to third parties or publish for the user without authorization.

## Validation

Run `npm test` after behavior changes. Tests must use fake API data and loopback
HTTP, never real tokens or network-dependent assertions. Use `npm run demo` to
check user-facing output after relevant changes. Keep config and CLI docs aligned.
Use the official GitHub REST documentation when changing API behavior, and record
material compatibility choices. Each increment should end with a useful, reviewable
local result independently of remote publication.
