# Independent Browser Login

Employees can open the ITSM HTTPS address in an ordinary browser and select DingTalk authorization login. DingTalk authenticates the person; ITSM owns sessions, service data, authorization and ticket handling. The existing in-client login and optional enterprise OIDC login remain available.

## Configuration

- Register the exact callback `https://<ITSM-host>/api/v1/auth/dingtalk-web/callback` in the same internal application's security settings / redirect URL.
- Check user-delegated profile access (`Contact.User.Read`) and the application permission for resolving a unionId to an enterprise userId (`topapi/user/getbyunionid`). Apply any permission changes in the provider console.
- In the private server environment set `ENABLE_DINGTALK_WEB_LOGIN=true`, `COOKIE_SECURE=true`, the exact HTTPS root `ITSM_PUBLIC_URL`, and the existing application's corpId, app key and secret. Never commit credentials.
- The provider callback is a browser redirect. The employee's browser must be able to resolve and reach the internal ITSM host. This feature does not change the network allowlist.

## Identity And Security

The authorization request uses `scope=openid corpid`, a fixed callback and a cryptographically random state bound to a short-lived Secure/HttpOnly/Lax browser cookie. Only hashes of state, browser identifier and configuration are stored for five minutes. An atomic database delete consumes the attempt before exchanging the authorization code. Codes are single-use and provider tokens exist only in server memory during the exchange.

The server requires the returned corpId to match the configured enterprise, resolves the authenticated unionId to that enterprise's userId, and selects an existing active employee through the exact `(corp_id, ding_user_id)` identity link. Names, email addresses and mobile numbers cannot create, merge or grant accounts. Existing role rules apply unchanged. Employee deactivation and identity reassignment revoke sessions through the existing database triggers.

The callback issues the existing eight-hour HttpOnly session and redirects to `/` without authorization parameters. Query strings are excluded from callback access logs. Failures expose no provider response, secret or identity data. No development identity is enabled.

## Acceptance

Automated verification covers browser binding, invalid/missing/expired state, concurrent callbacks, code replay, configuration changes, cross-enterprise identities, inactive or unsynchronized employees, provider errors, secure cookies, CSRF and identity-revocation reuse, and desktop/mobile layout. Real acceptance additionally requires an employee to scan/authorize on their own phone, see their own name and effective roles, open the workbench, sign out and log in again. Automated protocol fixtures are not evidence of a real employee login.

Provider references: DingTalk developer encyclopedia, `docs/develop/permission/token/browser/get_user_app_token_browser`; DingTalk Open Platform, obtaining user AccessToken, retrieving user contact information, and obtaining userId by unionId.
