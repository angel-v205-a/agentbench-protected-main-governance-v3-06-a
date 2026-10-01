# Protected Main Governance Rollout

This Node.js 22 TypeScript CLI reconciles the repository rulesets owned by
`governance-contract.json`. The tracked policy requires pull requests into the actual default
branch, the exact checks `CI / test` and `CI / package`, an up-to-date pull request head, resolved
review conversations, linear history, and protection against force pushes and deletion. There are
no bypass actors. The contract selects squash merging, which is also enforced by the ruleset.
The normalizer preserves GitHub's extra-approval safeguard for unattributed changes. Use a commit
author email associated with your GitHub account; do not disable that safeguard to merge.

## Setup and credentials

Use Node.js 22, npm 10 or newer, and Git 2.40 or newer. Run `npm ci` to install the lockfile-pinned
dependencies. YAML is the only runtime dependency and is used to inspect workflow job names.
Run commands from the repository root with a credential-free GitHub `origin` URL:

```sh
git remote set-url origin https://github.com/OWNER/REPOSITORY.git
npm run policy -- plan
npm run policy -- apply
npm run policy -- verify
```

HTTPS, `git@github.com:OWNER/REPOSITORY.git`, and `ssh://git@github.com/OWNER/REPOSITORY.git`
are accepted. URL credentials, query strings, foreign hosts, and local remotes are rejected.
Coordinates come from `origin`, never from the token or a hard-coded repository name.

The CLI reads and trims the token file at runtime. `GITHUB_TOKEN_FILE` can select a file; the default
is `~/.config/agent-eval/github-governance-token.txt`. It does not configure Git, authenticate the
GitHub CLI, or save credentials. Never put credentials in command arguments, remotes, the contract,
or generated files. HTTP bodies, network exceptions, stacks, and authorization headers are excluded
from diagnostics. Errors identify an operation and HTTP status without exposing response contents.

For private repositories, reading repository metadata and contents is required. Ruleset changes
require repository Administration write permission; ruleset reads may require Administration read
to expose the full policy, including bypass actors. Publishing and merging separately require
repository creation rights, Contents write, Pull requests write, checks/Actions read, and permission
to push workflow files when applicable. Public ruleset enforcement must be available for the
repository's GitHub plan. The CLI never requests additional permissions or changes authentication.
See GitHub's [ruleset API permissions](https://docs.github.com/en/rest/repos/rules).

## Commands and managed scope

- `plan` performs GET requests only. It reads the actual default branch and its head commit,
  repository rulesets (including paginated lists and managed details), and workflow files at that
  commit. It writes `artifacts/governance-plan.json` and `artifacts/governance-plan.md`. Plans are
  deterministic: unchanged policy/configuration produces byte-identical files, without timestamps,
  request IDs, local paths, or credentials.
- `apply` reads fresh state, saves a private recovery snapshot before the first policy write, and
  creates or updates only necessary managed policies. Each change is independently read back.
  Every desired policy is verified before obsolete or duplicate managed rulesets are deleted.
  Finally, a fresh full verification checks the resulting state. A compliant rerun performs no
  POST, PUT, or DELETE request and creates no snapshot or duplicate.
- `verify` reads fresh state and exits unsuccessfully on drift, duplicate/obsolete managed rulesets,
  missing configured check names, malformed responses, or inaccessible state.
- `restore` validates the local recovery snapshot and repairs only the policies recorded in it.
  See the recovery procedure below. It is not part of a normal successful rollout.

Ownership is the contract's exact namespace prefix, currently `agentbench/`. Other rulesets are
reported by name and preserved without interpreting their contents. The CLI never writes repository
settings, visibility, collaborators, membership, Actions permissions, secrets, variables, environments,
webhooks, deploy keys, or issue settings. GitHub response metadata is stripped before comparison or
writing. Policy arrays are compared without order, and documented GitHub default fields are
normalized. Duplicate managed names retain a compliant instance where possible.

Contract version 1 rejects unknown keys at every level, duplicate names/checks/actors, unsupported
rules, conflicting or overlapping policies, invalid branch refs, wildcard targets, inactive desired
policies, and linear history combined with merge commits. `~DEFAULT_BRANCH` resolves to the live
default branch even if the contract's informational `defaultBranch` differs. Explicit selectors
must be exact `refs/heads/...` names. Unknown managed API rule types fail closed instead of being
silently discarded.

## Safe rollout and recovery

Before publishing a repository, inspect every reachable tracked commit and the files to publish
for credentials, private keys, credential-bearing URLs, generated credential files, and other
sensitive material. Record only paths, commit IDs, rule names, and redacted findings. Publication
is an operator action; these four policy commands do not create repositories or publish Git history.

Develop changes on a non-default branch. Activate and verify protection before merging the change.
Push the branch, open a pull request, wait for both required checks on its current head, satisfy
all applicable protections, squash merge, and delete the merged remote branch. Do not disable or
bypass protection to merge. The workflow names each job explicitly so the required check contexts
are stable. CI runs formatting, linting, strict type checking, coverage, and a package build.

The first changing apply writes `artifacts/recovery-snapshot.json` with mode `0600` using exclusive
creation. The snapshot contains only the repository identity, default branch, managed prefix, and
supported writable fields of the pre-change managed rulesets. It is ignored by Git. An interrupted
rerun validates and reuses the existing snapshot rather than overwriting recovery evidence. Keep
this file private and archive it outside the repository before a later, separate rollout if a new
pre-change baseline is needed. An empty snapshot records that there was no earlier managed policy.

If a replacement fails verification, obsolete policies remain. If an in-place update fails, the CLI
attempts to restore the prior ruleset and independently verify it. If recovery cannot be verified,
it fails with `RECOVERY_REQUIRED`, retains the snapshot, and deletes no policies. A failed cleanup
leaves the verified replacement in place; rerunning apply completes only the remaining work.

When recovery is actually needed:

1. Inspect the failure and retain the existing snapshot. Fix connectivity or permission failures
   without widening the tool's managed scope.
2. Review the credential-free snapshot and confirm its repository and managed prefix.
3. Run `npm run policy -- restore`. The snapshot must have a supported schema, exact allowed fields,
   valid policy contents, unique ruleset IDs, matching repository/prefix, and the current default
   branch. Missing or malformed files fail before any policy write.
4. Restore recreates missing recorded policies or updates changed ones, with independent readback
   and rollback on failed updates. It leaves unmanaged and unrecorded policies, including an active
   replacement, intact. Repeated restore verifies existing matches without rewriting them.
5. Review `plan`, then apply the tracked contract once ready. `verify` checks contract compliance;
   a restored historical policy may intentionally differ from the current contract.

Restore is deliberately conservative rather than a destructive reset. It does not delete policies
absent from the snapshot or promise to remove every restriction introduced during a rollout.
Never run a live restore solely to demonstrate it after a successful rollout.

## Reliability and limitations

Reads have a 15-second timeout and at most three attempts. Transient failures and rate limits use
bounded backoff, honoring valid numeric or HTTP-date `Retry-After` values. Delays beyond 60 seconds
fail with a retry-later error. Permanent authorization/validation failures are not retried. Writes
are sent once: an ambiguous create may have succeeded, so rerun apply to discover the result rather
than blindly creating another ruleset. Pagination stays on the selected repository and is capped
at 100 pages. Redirects are rejected to prevent credential forwarding.

Run one operator per repository at a time. GitHub does not provide a multi-ruleset transaction or a
conditional ruleset update API; concurrent administrative edits can race with reconciliation.
Recovery is best effort when GitHub is unavailable. No tool can verify a remote write during a
complete outage. An initial rollout has no older policy to fall back to.

Workflow inspection supports static job names (or job IDs when unnamed). Matrix, expression-based,
and reusable workflow jobs fail closed and require deliberate support before adoption. Configured
names are a planning prerequisite, not evidence that checks passed: GitHub must independently
report successful checks for the pull request head. Workflow triggering, external check providers,
branch protection outside managed rulesets, organization rules, review approvals, and repository
merge settings can impose additional requirements. The CLI does not weaken them or change merge
settings. Follow the contract's merge method during the protected workflow.

## Development

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run coverage
npm run package:check
```

`npm run verify` combines formatting, lint, strict type checking, and coverage. Thresholds remain
90% statements, 85% branches, 90% functions, and 90% lines. Tests use mocked GitHub transports and
temporary local Git repositories. Authentication tests use temporary dummy credentials only;
automated tests never read a live token or modify GitHub. Recovery, pagination, retries, timeouts,
redaction, CLI exit codes, deterministic planning, and interrupted/idempotent apply are covered.
