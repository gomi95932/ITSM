# CI Throughput and Delivery Boundaries

## Superseded validation runs

`Application CI` uses a concurrency group scoped to workflow, event type and
Git ref. A new feature-branch push cancels an older run for the same branch;
a PR update cancels the older validation run for that PR. Unrelated branches
and workflows do not cancel each other.

Push and PR runs intentionally have different groups: a branch-head run
cannot cancel a PR merge-ref check that may be required for review. This
policy does not deduplicate push and PR validation of the same change.

An in-progress `main` run is not canceled by a newer commit. This protects
image publication and release rehearsal from automatic interruption. GitHub
keeps only the newest pending run in the same concurrency group by default;
this is not a promise to publish every intermediate main commit. Only a
completed, successful release archive is eligible for deployment.

`Bootstrap checks` has no publication or deployment side effects and can
cancel superseded runs even on main. Reusable security jobs inherit the
calling workflow lifecycle; they have no competing concurrency group.

No required check, security gate, integration test, browser journey, backup
verification or release rehearsal is removed. Cancellation saves work on
outdated commits; it does not establish a shorter duration for a single run.

## Operational boundaries

- The Mac edits source and uses Git only; runtime tests execute in Actions
  or on the development server.
- GitHub-hosted release rehearsal is not deployment to `10.10.81.125`.
- Development-server readiness alone does not prove the deployed commit,
  ticket lifecycle, backup recovery or live DingTalk integration.
- Noninteractive SSH authentication must be established with a dedicated,
  authorized deployment identity before claiming unattended CD. Do not
  place a password/private key in Git, chat, a script or an Actions log.
- A canceled run is superseded, not passed. Review the completed checks for
  the exact PR/head or release SHA before merging or deploying.

## Validation

On 2026-11-15, a read-only check confirmed the development readiness
endpoint returned `status: ok`; SSH in batch mode failed authentication.
Remote main was `4759163954ebf7d06e22f6979d97cf14baa832d3`, and the
security-gate branch was `a84747608b006cddfda9c7c604921f9f670e54d4`.
These observations do not establish automatic server deployment.

The concurrency changes require real Actions validation. To exercise
cancellation, push a newer feature commit while the preceding run is
actually in progress, then record both run IDs, commit SHAs and terminal
results. A passing ordinary run alone does not prove cancellation behavior.

Reference: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
