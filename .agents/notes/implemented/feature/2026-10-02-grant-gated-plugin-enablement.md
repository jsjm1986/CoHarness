# Agent Note: Grant-gated plugin enablement in the Web Settings plugin list

Status: implemented

English | [中文](2026-10-02-grant-gated-plugin-enablement.zh.md)

## Problem

Plugin enablement writes lived exclusively in the gateway admin UI. Web users could inspect the Settings **Plugin list** tab but could not toggle a plugin even in their own workspace, and the product requirement is narrower than copying the admin surface: users may toggle only after an administrator grants plugin management, and a denied user must see a notice pointing at the administrator rather than a broken switch. Upstream has no administrator-grant concept — its plugin surfaces are local-first — so the grant chain is fork-specific work on top of the upstream-aligned manager.

## Decision

A new `plugin_access_policies` resource rides the existing `ResourceAccess` pattern that already gates desktop, SSH, and terminal access: user rows grant personal-space management, project rows gate project-target operations, and every write carries the optimistic `revision` check plus the `access_invalidation` trigger that forces reauthorization.

- Migration [`048_plugin_access_qualification.sql`](../../../../gateway/deploy/postgres/migrations/048_plugin_access_qualification.sql) creates the table on the existing access-policy template; [`gateway/src/plugin-access.ts`](../../../../gateway/src/plugin-access.ts) adapts it to `ResourceAccess` and `admin-api` serves `plugin` beside the existing resources.
- `eligibleActors` in [`gateway/src/execution-identity.ts`](../../../../gateway/src/execution-identity.ts) no longer requires an admin for `plugin-management`: admins keep unconditional authority, while a non-admin actor needs an enabled user policy and, on project targets, an enabled project policy. [`gateway/src/runtime-api.ts`](../../../../gateway/src/runtime-api.ts) admits ordinary `user` principals on `/internal/runtime/plugin-management/authorize` after the same policy checks; `plugin-admin` purpose assertions remain admin-only, and terminal management is untouched.
- [`packages/context/gateway-execution/src/plugin-management.ts`](../../../../packages/context/gateway-execution/src/plugin-management.ts) stops rejecting non-admin principals locally and forwards every authenticated principal to the gateway endpoint, keeping one authorization decision for reads and mutations. A non-204 answer maps to `plugin-management/forbidden`.
- The Web Settings tab in [`packages/client/ui-settings-plugin-inventory`](../../../../packages/client/ui-settings-plugin-inventory/README.md) probes authorization by calling `pluginManager.listPlugins()` — the manager's own `authorize()` answers the grant, so the probe cannot diverge from what mutations allow. Granted viewers get an enablement switch inside each expanded global-plane card whose entry has a `patchId`; denied viewers see `插件启停需要管理员授权；如需启用或停用插件，请联系管理员开通权限。`; deployments without a plugin manager render neither. Preset rows, protected rows, and unaddressable rows stay switch-free.
- Admin surfaces gain grant editors: a 插件管理 qualification card on the user detail page and a `PluginPermissions` section on the plugins page, both on the shared `ResourcePermissions` component with revision-guarded saves.

## Alternatives considered

**A dedicated capability endpoint.** A separate "can I manage plugins" RPC would drift from the mutation path's real authorization; calling `listPlugins` as the probe reuses the same `authorize()` that `setPluginEnabled` reaches, at the cost of fetching a list the UI discards on denial.

**Admin-purpose assertions for qualified users.** Purpose assertions are HTTP-path-restricted admin credentials; a non-admin carrying one is rejected outright. Ordinary principals keep user calls inside the existing project-membership and policy checks instead of widening the assertion lane.

**A user-side `ui-plugin-manager` page.** Upstream's sidebar manager page duplicates admin functionality the fork keeps centralized; the requirement is enablement only, so the existing inventory tab hosts the grant-gated switch rather than a second page. (The requirement later grew to bundle management and the page shipped — see [the user-side Plugins page](2026-10-03-user-side-plugin-manager-page.md).)

## Consequences

Every non-admin plugin mutation now passes a live database check; revoked grants take effect through the invalidation trigger without waiting on cached UI state. The `plugin-access-policies` admin API joins the resource union, so its read/write endpoints inherit the admin auth and revision guards. Plugin-management authorization coverage runs against real PostgreSQL in `gateway/tests/execution.spec.ts` (grant, project-grant, revocation), and the inventory tab's probe/deny/toggle paths are pinned in `components.client.spec.tsx` and `browser-plugin.client.spec.tsx`. The shipped note [Plugin settings tabs](../architecture/2026-08-11-plugin-settings-tabs.md) predates this surface: its "read-only inventory view" ownership line is updated in place.
