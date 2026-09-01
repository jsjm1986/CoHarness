# Agent Note: Canonical repository gates for credentialed CI automation

Status: implemented

English | [中文](2026-09-01-canonical-ci-automation-gates.zh.md)

## Problem

Real-API tests and Issue Project automation require repository-scoped credentials, GitHub App installation, and Project data. Running those workflows in a non-canonical repository reports misleading secret, authentication, or 404 failures and can target the wrong repository.

## Decision

Credentialed E2E and Issue automation workflows run only when the workflow repository is `jsjm1986/CoHarness` and the corresponding repository variable explicitly enables the capability. Fork and non-canonical repositories continue to use keyless CI and do not receive real-API secrets or Issue Project access. The Issue policy executable independently verifies `GITHUB_REPOSITORY` and the event repository against the configured canonical repository before making any GitHub API request. Repository ownership and Project ownership are configured separately: `repositoryOwner` identifies the REST and repository GraphQL target, while `projectOwner` plus `projectOwnerType` selects `user(login:)` or `organization(login:)` for the Project lookup. The E2E workflow remains on `pull_request`; it must not use `pull_request_target` to expose secrets to untrusted code.

## Alternatives considered

**Run the automation dynamically against every fork.** Rejected because forks do not reliably have the required Project, GitHub App installation, or repository-scoped permissions, and dynamic targeting would make the shared Project configuration ambiguous.

**Use `pull_request_target` for secret-backed E2E.** Rejected because checking out untrusted PR code in the base repository context with secrets permits secret exfiltration.

**Treat 404 responses as an optional missing Issue or Project.** Rejected because a 404 from a configured repository is evidence of an identity or permission error and must remain fail-closed.

## Consequences

The canonical repository must configure `DSH_REAL_API_E2E_ENABLED`, `DSH_ISSUE_AUTOMATION_ENABLED`, `DEEPSEEK_API_KEY_EXTERNAL`, and the GitHub App credentials before enabling the corresponding workflows. The configured Project owner is the `jsjm1986` user account, so the policy uses the user Project query rather than assuming an organization-owned Project. Non-canonical repositories see those jobs skipped rather than failed. Repository and Project identities are intentionally explicit in configuration, workflow guards, and policy runtime validation, so changing either owner requires updating the configuration and regression tests together.
