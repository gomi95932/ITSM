# P1-03: Candidate Notification and Supervisor Confirmation

## Scope and Status

2026-11-21 supplement: see [priority governance](p1-priority-governance.md) for the configurable P1-P4 matrix, evidence-based AI drafts, authorized adjustments, independent configuration approval, generation-specific reminders and preserved/added SLA obligations. This supersedes the fixed reminder threshold below. Its validation is tracked separately from older CI evidence.

2026-11-10. Code candidate only; not business acceptance, not deployment evidence. Follow V1.1 and `docs/implementation-baseline.md`. Monitoring and configuration-item links remain phase 2; full SEC remains phase 3. Phase-1 ordinary-entry protection remains mandatory.

## Implemented Contract

- The server computes priority from impact/urgency. A resulting P1 starts in `QUEUED` with `priority_review_state=PENDING`; its SLA starts immediately using the P1 snapshot. No approval gate blocks claim or response.
- The creation transaction persists `P1_CANDIDATE`, audit and a dedicated `P1_ALERT` outbox event. Worker expansion/delivery prioritizes these alerts. The normal 2-second worker polling and provider latency still apply; this is not a guaranteed notification-time promise.
- `priority_reviewers(employee_id,group_id)` is explicit authorization, not a privilege of every agent. Reviewer must be active, belong to the current group and cannot review their own request. Removing group membership cascades the role removal. No production appointments are seeded.
- `POST /tickets/:id/priority-review` accepts `contentClass=GENERAL`, `expectedVersion`, `priority` and nonempty `reason`, with normal session/CSRF, content checks, transaction locks and idempotency. Pending active candidates only. Concurrent confirmation succeeds once; stale/repeated conflicting changes fail. Reviewer authority is rechecked in the transaction.
- Confirm P1 or adjust to P2/P3/P4. Record reviewer, time, reason and before/after priority. This does not claim the ticket or replace its individual owner. Cross-group accepted handover generates another P1 review-routing notification; the current group's authorization governs confirmation.
- Current SLA cycle, start, calendar, priority, response timestamps, targets and breach history are preserved even on downgrade. Current-cycle calculation, including pause and worker checks, uses the SLA snapshot, not the revised ticket priority. Reopen starts a new cycle at the then-current priority. This conservative pilot rule needs business approval before production.
- Review increments optimistic version but does not touch `updated_at`, so confirmation itself cannot postpone auto-close. The existing ownership-to-auto-close clock issue remains assigned to P1-08.
- Existing active P1 tickets become pending through migration; the worker creates missing candidate alerts once. Terminal historical tickets are not retroactively recategorized.
- A 5-minute pilot reminder creates one durable `P1_REVIEW_OVERDUE` event. This is an extra review reminder, not a replacement for the 15-minute response SLA, not a staffed escalation chain. The threshold is a shared constant awaiting business confirmation.
- Detail view shows review state, authorized review form, frozen SLA priority, missing independent reviewer, overdue review, disabled/fake notifications and dead/pending/delivered states. Fake delivery is never shown as real delivery or first response.

## Verification Plan

- Required schema: migrations 001 through 004. Readiness rejects 003-only schema; migration rollback probe now uses 005.
- New integration suite runs only in disposable GitHub CI. Covers durable alerts before review, active response before review, role and group isolation, self-review denial, revoked/inactive reviewer, required reasons, idempotency and concurrent review, frozen SLA and timestamps, accepted handover routing and overdue reminder.
- SLA unit regression covers a P1 cycle paused across weekend hours after ticket priority was reduced to P2.
- New Playwright flow covers requester/agent denial, pre-confirmation claim, independent supervisor downgrade and desktop/mobile screenshots and overflow checks.
- Execution results must be appended after actual remote CI observation. Local Mac remains code-only; no app builds, tests, DB or containers run locally.

## Verification Evidence

- Feature commit: `29d33d995117cf7a056e8754a47a5cf98eac7c68`. Application CI #30/#31 failed compilation because `IntakeChannel` omitted `priority-review`; these runs are not passing evidence.
- Fix and tested code: `5b9752467e6a8c580ef940b1806569761dfa9ed1`. Observed on GitHub: [push Application CI #32](https://github.com/gomi95932/ITSM/actions/runs/42765967916) succeeded with build-test 4m9s; [PR Application CI #33](https://github.com/gomi95932/ITSM/actions/runs/42765973234) succeeded with build-test 3m17s.
- Remote checks passed: build, typecheck, unit tests, isolated ticket/workspace/intake checks, migrations and backup recovery, personal-ownership regression, the new priority-review integration suite, and desktop/mobile Playwright flows. The priority suite verified durable alerts before review, response before review, scoped independent reviewers, concurrent/idempotent review, frozen SLA, rerouting, overdue reminders and revocation.
- Downloaded browser artifact: `/Users/robinzhu/Downloads/workspace-browser-results-4` (12 PNGs). Visually inspected `p1-review-desktop.png`, `p1-review-mobile.png` and `p1-reviewed-mobile.png`: review controls fit their sections; reviewed mobile retains the owner and original P1 SLA after downgrade; fake notification delivery remains visibly labelled. Existing mobile navigation text clipping and raw reviewer IDs remain UI follow-ups.
- GitHub displayed artifact ID `13739259248` and digest `sha256:29690c62189f496945d5ae0d8ea99f15a83a3c4092c04ac11b94990752b7ea2c`; the digest was not independently recomputed locally.
- No local application build, test, database or container was run. Notifications used fake mode, not real DingTalk delivery. Feature-branch image publishing and release-bundle jobs were skipped. PR remains unmerged; this candidate was not deployed to `10.10.81.125`. Evidence applies to code `5b97524`; subsequent documentation-only commits do not establish new runtime validation or business acceptance.

## Remaining Before Acceptance

1. Business appoints actual reviewers, deputies, duty schedule, review threshold and escalation chain. No 7x24 coverage claim without staffing.
2. Configure real DingTalk identity links, credentials, HTTPS deep links and live message delivery; verify retry/dead-letter and fallback contact procedures in the test enterprise.
3. Current overdue reminder re-notifies the group/reviewers only; higher-level escalation, telephone escalation, provider-outage external monitoring and a dedicated pending-review filter are not delivered by this slice.
4. Terminal tickets may retain pending review in history. A production rule for late retrospective review is not implemented; no terminal review is permitted silently.
5. Review downgrade deliberately does not relax an existing P1 SLA. Obtain explicit service-owner acceptance or define an audited segment-based SLA adjustment separately.
6. Main merge and deployment to `10.10.81.125` require approval. This code does not prove real environment/release readiness or complete P1-03 acceptance.
