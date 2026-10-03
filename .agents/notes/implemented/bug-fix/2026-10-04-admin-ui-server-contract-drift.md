# Agent Note: Close admin UI drift against gateway server contracts

Status: implemented

English | [中文](2026-10-04-admin-ui-server-contract-drift.zh.md)

## Problem

An end-to-end audit of every `gateway/admin-ui` request against its `gateway/src/admin-api.ts` handler found four contract drifts the type system could not catch:

- The Webhook editor offered disabled users as execution accounts and, for `runtimeKind: 'user'`, let the runtime target differ from the execution account; delivery rejects both, and the user-target combination can never dispatch.
- The Webhook and SSH editors forwarded values the server schema refuses outright (empty required text, non-`owner/repo` repository filters, numeric fields past their service bounds, relative paths, malformed host aliases), so admins learned of misconfiguration only as a generic 400 after save.
- `setMaintenance` declared a `DeploymentState` return while `POST /admin/api/deployment/maintenance` answers the bare cluster state without `migrations`/`operations`.
- `ProfileSettingsController` published `bundles`/`rows` as permanently empty sets, so the manager page's configured badges and per-row configuration markers could never light up.

## Decision

Mirror server constraints at the form boundary and derive ledger facts from wire data. The Webhook editor filters execution accounts and user-runtime targets to `status === 'active'`, fixes the user runtime target to the execution account, and validates every field against the `webhook-endpoint-service` bounds (required text maxima, 64-item filters, `owner/repo` repository names, numeric ceilings). The SSH editor applies the `ssh-target-service` bounds the same way, including absolute paths and the host-alias pattern. `setMaintenance` returns the new `ClusterState` interface that `DeploymentState` extends, matching what the route actually sends. The settings ledger derives `bundles` and `rows` from configuration keys under the `rowConfigKey` convention: `bundle#rowId` marks a row and its package, a bare `bundle` marks the package alone.

## Files

- `gateway/admin-ui/src/pages/WebhooksPage.tsx` — active-account selects, user-target lock, field validation mirroring the service schema.
- `gateway/admin-ui/src/pages/SshPage.tsx` — backend-bound validation for names, host alias, absolute paths, and numeric limits.
- `gateway/admin-ui/src/api.ts` — `ClusterState` extracted; `setMaintenance` returns it.
- `gateway/admin-ui/src/plugins/settings-store.ts` — `bundles`/`rows` derived from namespace keys.
- `gateway/admin-ui/src/pages/WebhooksPage.spec.tsx`, `gateway/admin-ui/src/plugins/settings-store.spec.ts` — coverage for the new derivation and the disabled-account filter.

## Consequences

Forms refuse locally what the service would reject remotely, so save errors describe the actual constraint instead of `invalid webhook endpoint`/`invalid ssh target`. Editing an endpoint whose execution account was later disabled presents an empty select and forces a new active account, matching the delivery check. Adding a constraint to either service schema still requires updating the matching form validator by hand.
