# Agent Note: The Web sidebar Plugins page brings grant-gated bundle management to users

Status: implemented

English | [中文](2026-10-03-user-side-plugin-manager-page.zh.md)

## Problem

The Admin UI owned all bundle management — installing, enabling, disabling, and removing bundles and switching their rows — while the Web user side held only the grant-gated enablement switch inside the Settings **Plugin list** tab. Upstream `dsh-v0.2.0-rc.2` ships `ui-plugin-manager`, a sidebar **Plugins** entry whose main panel covers the same surface the fork's Admin page does; the package was not carried during the client-lane port, so users had no bundle management even when the deployment granted them plugin management. The earlier [grant-gated enablement](2026-10-02-grant-gated-plugin-enablement.md) note rejected a user-side manager page on the narrower requirement; the requirement grew to admin/user parity under the same grant chain.

## Decision

Port `packages/client/ui-plugin-manager` adapted to the fork's client architecture rather than copied verbatim:

- Upstream's `configForms` service is replaced by `settingsScope`: `describe()` supplies the namespace projection the page reads, and `bind({ namespace, source: 'host' })` returns the mutation scope, cached per namespace on the controller. The slot contract keeps its boolean shape — `ConfigPageForm.mutate` reports `write.status === 'idle'` read after `scope.mutate` settles. The shared-scope mechanism stays owned by [user-preference-cluster-shared-settings-scope](2026-10-02-user-preference-cluster-shared-settings-scope.md).
- The administrator-grant chain from the grant-gate note scopes to mutations: `pluginManager.*` reads are open and `access()` reports the manage grant. The page loads the full inventory for every viewer and reports `manage: false` through a read-only mode — management controls disable under the bilingual `managementDenied` banner — while the Refresh control stays usable so a grant takes effect on the next read without reloading. An older Host without `access` falls back to writable and relies on each mutation to carry its own refusal; one whose reads also refuse still drives the page to the `denied` status.
- `product-analytics` and `sanitize-install-input.ts` are not ported: the classifier exists solely to strip credentials and paths out of analytics events, and the fork runs no analytics service. The Host's `inspect` remains the validation authority for typed specs.
- Icons remap to the fork iconfont (`Icon*Outline18`/`20` names); `dsh-plugin-manager/registry` joins `INLINE_SAFE` in `tsdown.client.ts` as upstream does.
- The browser plugin injects `remote.pluginManager`, `remote.pluginInventory`, and `remote.pluginRegistryProbe` beside `remote`; `remote-events.ts` forwards `plugin-manager/changed`, `plugin-manager/install-log`, and `plugin-manager/install-state` to subscribers.
- Registration follows the slot standard: a `sidebar.panellist` entry, the `main` keyed panel declaring the seven `plugins.*` children (`item`, `bundle.activation`, `bundle.config`, `row.config`, `detail.actions`, `detail.badge`, `detail.section`), a `shell.overlay` refresh toast, and `ctx.pluginNavigation` provided through `ctx.reflect.provide` while the panel mounts so other plugins can open a bundle's detail page.

## Alternatives considered

- **Keep bundle management admin-only.** Rejected: the requirement grew to user parity, and the Host already authorizes every manager call, so the page adds no privilege — it exposes what grants already permit.
- **Vendor upstream `configForms` for this one consumer.** Rejected: it duplicates the settings-scope projection and atomic-mutation machine the fork's Settings surface already runs; the adapter keeps one settings transport.
- **Hide the page or empty the list without a grant.** Rejected: reads are open by design, so a granted-looking blank page would misreport an authorization fact; the read-only mode keeps the inventory visible and marks controls as unavailable.

## Consequences

Granted users manage bundles end-to-end — install with streamed output, registry selection and probing, enable, disable, and uninstall — from the same surface the Admin page offers; ungranted users keep the full inventory read-only under the pointed notice, with Refresh as the retry path. The `plugins.item`, `plugins.bundle.config`, `plugins.row.config`, and `plugins.detail.*` slots ship with no in-tree entries; built-in plugin configuration stays in Settings → Plugins until a package registers into the page. The test-runtime gained `stubMutationScope`/`StubMutationScope` and a `RemoteError` re-export for spec doubles. This note supersedes the rejected user-side-page alternative recorded in [grant-gated plugin enablement](2026-10-02-grant-gated-plugin-enablement.md); the inventory tab's grant-gated switch from that note remains shipped and complementary.
