# CI Throughput and Delivery Boundaries

## Validation triggers

From the 2026-11-18 candidate, open a draft integration PR early. Opening
or updating that PR runs the complete application and bootstrap checks.
A feature-branch push no longer starts a second, identical validation run.
Branches without a PR do not receive automatic validation; open the PR
before treating any candidate as checked. A manual workflow-dispatch entry
is available once this workflow definition is on the default branch.

Main pushes still run the complete checks and, only after success, publish
images and rehearse the fixed release bundle. Manual runs never publish:
publication retains its explicit main-push-only condition. No path filter,
draft exemption, security exemption or test subset is introduced.

This removes one duplicate automatic run per PR update; it does not halve
the duration of a single check, change GitHub pricing, or resolve a blocked
billing account. Trigger behavior still needs a real successful Actions
run after the candidate is pushed and the account can start jobs.

## Superseded validation runs

`Application CI` uses a concurrency group scoped to workflow, event type and
Git ref. A PR update cancels the older validation run for that PR; a newer
manual run on the same non-main ref can replace an older manual run.
Unrelated branches and workflows do not cancel each other.

Event types keep different concurrency groups, so a manual run cannot
cancel a PR merge-ref check that may be required for review. The earlier
policy of automatic feature-push plus PR validation is superseded by the
trigger policy above.

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

## Browser evidence retention

The general, manual-delivery and request-intake browser phases use separate
Playwright output directories below `test-results/`. Scene screenshots keep
their explicit filenames in the parent directory. A later Playwright
invocation must not clean that parent and erase earlier screenshots or
failure traces. Before artifact upload, the workflow checks both desktop
and mobile evidence for request feedback, separate request reports, first
delivery and employee intake progress. Upload still runs on failure so
available partial evidence can be inspected.

Run `44254124986` passed its tests but its final artifact contained only six
request-intake images. That artifact cannot prove the visual appearance of
the earlier feedback scenes. The output-directory change is a candidate
fix, not retroactive visual acceptance of missing screenshots.

## Validation

On 2026-11-15, a read-only check confirmed the development readiness
endpoint returned `status: ok`; SSH in batch mode failed authentication.
Remote main was `4759163954ebf7d06e22f6979d97cf14baa832d3`, and the
security-gate branch was `a84747608b006cddfda9c7c604921f9f670e54d4`.
These observations do not establish automatic server deployment.

The concurrency changes require real Actions validation. To exercise
cancellation, update an open PR while the preceding PR run is
actually in progress, then record both run IDs, commit SHAs and terminal
results. A passing ordinary run alone does not prove cancellation behavior.

Reference: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

## Actions account start failures

On 2026-11-18, candidate `ef2d3ee130bad332007153e7fba39d850a486aa6`
had no job steps in Application CI run `44256523732`. The build check
annotation explicitly said recent account payments had failed or the
spending limit needed to be increased. This is not a test assertion failure
and does not prove the candidate passes. Previous `bb3943a` passed complete
Application CI run `44254124986`; that result does not validate later code.

The account owner must inspect Billing & plans, payment status and Actions
budgets/limits. Do not raise a paid limit, change repository visibility,
disable checks, or install a privileged self-hosted runner as a workaround.
After the account can start jobs, rerun the exact latest PR checks and
record their final results. Avoid repeatedly retrying while this condition
persists. Server readiness is not an alternative to the missing checks.
