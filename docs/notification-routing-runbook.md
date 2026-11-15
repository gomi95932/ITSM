# Targeted Notification Routing

## Scope

This change implements blueprint B10/B11 audience selection and dead-letter retry authorization. It does not enable live DingTalk delivery or prove real DingTalk integration. Existing environment gates remain unchanged. No schema migration is required.

## Recipient Rules

| Event | Recipients |
| --- | --- |
| Submit, reopen, classification correction | Requester and current owner; if unassigned, effective dispatcher/group lead |
| Accept, request/add information, resolve, confirm, cancel, auto-close, accept handover, priority reviewed | Requester and current owner |
| Handover proposed | Current owner and exact current candidate matching the event; unassigned queue dispatcher/group lead |
| Handover declined/cancelled | Current owner; unassigned queue dispatcher/group lead |
| Wait vendor, feedback submitted | Current owner only |
| P1 candidate/review overdue/review routed | Current owner, effective current-group dispatcher/group lead and explicitly appointed P1 reviewers |
| SLA breach, ownership recovered | Current owner and effective current-group dispatcher/group lead |
| Unknown/internal-only events | No recipients until an explicit policy is added |

Ordinary group membership and platform administration do not grant notification broadcast authority. Queue alerts exclude terminal tickets. Current owners and candidates must retain their group membership. Former owners do not retain notification access after cross-group handover. P1 review appointments remain independent of dispatch appointments.

## Authorization And Retry

Audience selection runs when the outbox expands and again before each send attempt. Inactive employees, removed members, expired/revoked role holders and stale handover candidates are skipped. Expansion is idempotent per event/recipient. These checks do not recall messages already accepted by a provider, nor guarantee delivery to a newly appointed person after an earlier expansion.

Only an effective dispatcher or group lead for the ticket's current owning group may retry a DEAD delivery. Role authorization uses the shared role-change transaction lock and existing live role predicates. Denied retries return 404 and do not reset delivery state. Successful retries retain the delivery ID and provider task ID, reset the existing attempt cycle and write an operational audit. Provider acceptance is not proof of user receipt. Existing attempt limits apply per retry cycle; this change does not introduce a lifetime manual-retry cap.

## Verification

CI runs the action policy unit tests and `tests/integration/notification-audience.mjs` in the disposable Compose environment. It verifies exact recipients, no group broadcast, stale handover exclusion, idempotent expansion, revocation/expiry/employee checks and API-level retry scope/audits. Do not run fixture tests against the development server's persistent database.

Before enabling real messages, complete DingTalk identity mappings, application permissions, trusted public URL and real-provider UAT. Check an authorized recipient, a denied recipient, a handover, a provider timeout and dead-letter retry. Monitor SKIPPED/DEAD records and correlate operational audits; do not infer business completion from message acceptance.
