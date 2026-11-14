# Development Security Gates

Scope: engineering CI/CD, required by blueprint section 9. These checks do not implement the phase-three SEC business workflow and do not prove the application is free of vulnerabilities.

## Checks

- `Application CI / security / secrets`: checksum-verified Gitleaks 8.30.1 scans the full checked-out Git history. A generated, nonfunctional canary first proves detection and redaction. Findings fail the job; raw secrets are not uploaded as artifacts. There is no blanket baseline or allowlist.
- `Application CI / security / sast`: Semgrep 1.185.0 runs repository-owned rules without a cloud token, remote registry configuration, usage metrics, or a version check. Positive and negative fixtures exercise the rules. The initial rules reject direct dynamic code evaluation, child-process shell command strings, shell-enabled options, and disabled TLS verification in application/shared/release code. They are a focused baseline, not complete taint analysis or an authorization review.
- `Application CI / security / dependencies`: `npm ci --ignore-scripts` verifies the lockfile and `npm audit --audit-level=high` blocks high/critical advisories in both runtime and development dependencies. Registry errors fail the gate; they are not treated as a clean scan. The registry receives dependency names and versions, not source files or application credentials.
- Both main image-publication jobs require build/test and all security checks. The release archive therefore cannot be produced by the normal workflow when a security gate fails.

All scanner execution is on disposable GitHub-hosted runners. The Mac remains for source editing and Git only. No deployment secret, internal runner, or company production data is provided to these jobs. Fixtures under `tests/security` are scanned by the self-test, not by the application-code scan.

## Findings

Do not add `continue-on-error`, replace the exit code, broadly exclude a directory, disable an entire rule, or run an automatic forced dependency upgrade to make CI green. Confirm the path/rule/advisory, patch the actual issue with scoped tests, and review any truly necessary exact exception with an owner and expiry. A leaked credential must be revoked, not merely deleted in a later commit; historical findings remain blocking until handled through an approved remediation plan.

Repository-wide PR/branch enforcement depends on the actual GitHub plan and configured rules. These jobs gate this workflow's image publication, but do not themselves prevent an administrator from directly pushing to `main`. Do not claim protected branches are enabled without checking repository settings.

## Validation Status

Initial implementation on 2026-11-14. Actual branch CI results must be recorded against the committed SHA before calling these gates operational. No application tests or security scanners were executed on the Mac.

Official metadata checked on 2026-11-14: GitHub release `gitleaks/gitleaks` tag `v8.30.1`, Linux x64 asset ID `378332058`, SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`; PyPI confirms Semgrep `1.185.0` supports Python `>=3.10`. The command-execution rule is import-scoped, with a negative fixture for normal regular-expression `.exec()` calls.
