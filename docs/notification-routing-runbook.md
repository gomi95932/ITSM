# Targeted Notification Routing

## Scope

This change implements blueprint B10/B11 audience selection, restricted retries and recovery when a send outcome is unknown. Live delivery remains subject to DingTalk configuration and acceptance.

## ActionCard Processing Entry

Work notifications use the classic DingTalk `action_card` message with a short identifier/status, a title and one `查看并处理` link. The link opens the existing H5 ticket, fulfillment or routing workspace. It contains no session, approval, action credential, description or private evidence. Message titles remove control characters and are capped at 64 characters; status text escapes Markdown. The configured base URL must be HTTPS without credentials, query or fragment, and the final link is capped at 500 characters. The contract is checked against the official DingTalk Java SDK 2.0.0 `OapiMessageCorpconversationAsyncsendV2Request.ActionCard` source snapshot; current enterprise compatibility still requires a real send.

Opening or forwarding the card does not accept, approve or close a ticket. The H5 application authenticates the current user and reads current ticket/position permissions. A user explicitly submits the permitted action, with the existing CSRF, version and idempotency checks. Results are written to the same ITSM ticket/event/audit records as platform processing. This is an H5 processing entry inside DingTalk, not an inline interactive-card callback implementation. Native in-card commands and their callback verification remain outside this candidate and must not be reported as delivered.

The isolated desktop/mobile deep-link cases exercise opening without mutation, authorized engineer processing and a forwarded link rejected for an unrelated employee. They use development identities and do not verify enterprise SSO. Live acceptance must additionally prove real message delivery, DingTalk mobile link opening, enterprise SSO, revoked-identity denial and a ticket update visible to its requester.

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

The notification list returns a live `canRetry` flag per delivery. The web client shows the retry command only for DEAD deliveries with that flag. The flag is presentation guidance, not an authorization token; POST always checks current permissions again.

## Unconfirmed Sends

The worker commits `DISPATCHING` before submitting a live notification. A provable token or configuration failure can return the delivery to the send queue. A timeout, interruption, or missing task ID after the checkpoint moves the delivery to `REVIEW_REQUIRED`. A known provider task may only be queried for a receipt. The worker matches the original enterprise, application and recipient before querying a receipt or recording SLA evidence.

The DingTalk receipt must include the intended recipient in `read_user_id_list` or `unread_user_id_list` and exclude them from the failed, forbidden and invalid recipient lists. The worker preserves the numeric task ID exactly when querying the receipt. First-response timing still uses the configured acceptance notification policy. Confirm that policy in the live acceptance test.

The notification list prioritizes records that require review. The current support group should check the work notification in DingTalk or contact the intended recipient. For a P1 incident, use the approved on-call channel and record the outcome in the ticket timeline. Keep the original delivery record for investigation. Migration 029 moves older in-flight deliveries with unverified send attempts or unbound task IDs to review.

## Verification

The candidate notification health report at `GET /api/v1/reports/notifications` summarizes the full authorized current-group cohort by the Shanghai outbox event date, with optional current-state filtering. It separates provider-confirmed delivery, simulation, skipped delivery, retries and uncertain outcomes, and reports unexpanded and expanded-without-recipient events separately. Provider details and recipient identities are excluded. This is a current-state snapshot, not lifetime failed-attempt history: manual retry resets the current attempt cycle. See `docs/p1-notification-report.md` for boundaries and pending CI/live acceptance. Investigation and retry continue in the existing restricted workspace.

CI runs the action policy unit tests and `tests/integration/notification-audience.mjs` in the disposable Compose environment. It verifies exact recipients, no group broadcast, stale handover exclusion, idempotent expansion, revocation/expiry/employee checks and API-level retry scope/audits. Do not run fixture tests against the development server's persistent database.

`tests/e2e/notifications.spec.ts` covers desktop and mobile command presentation with a mocked notification-list response: DEAD plus permission shows the command, missing/false permission or a non-DEAD state hides it, and a refreshed revocation removes it. Employee identities have no notification navigation. Screenshots are collected by CI; these mocked cases do not prove backend authorization or real DingTalk delivery.

Before enabling real messages, complete DingTalk identity mappings, application permissions, trusted public URL and real-provider UAT. Check an authorized recipient, a denied recipient, a handover, a provider timeout and dead-letter retry. Monitor SKIPPED/DEAD records and correlate operational audits; do not infer business completion from message acceptance.
