# Agent Note: Remote-desktop administration lives only in the gateway admin surface

Status: implemented

English | [中文](2026-10-20-remote-desktop-admin-surface-boundary.zh.md)

## Problem

`ui-remote-desktop-admin` registered a `settings.section` into the end-user settings page: a grants table, an issue form, revoke/setLevel actions, and an audit tail — the same administration the gateway admin surface already provides through `RemoteDesktopPage` (endpoints, grants, audit). Placing it in user settings duplicated an admin surface inside the wrong audience and exposed admin-gated `remoteDesktop/*` wire calls to users who could never satisfy `requireAdmin`, so the section rendered a permanently failing control set for non-admin accounts.

## Decision

Remote-desktop administration has exactly one home: the gateway admin surface (`/admin` → Remote Desktop). The `settings.section` contribution is removed with its whole package — `packages/client/ui-remote-desktop-admin` is deleted, its `web-app` composition entry and manifest dependency are dropped, and the registry rows that listed it (coverage baseline, README Model Experience contract, upstream-sync manifest, tsconfig paths/references, generated catalogs) are regenerated or cleaned. End users keep the consent → attach → RFB flow through the `ui-remote-desktop` sidebar guide; nothing user-operable is lost, because the removed section performed administrator operations through the session wire, not user-facing settings.

## Alternatives considered

**Keep the package mounted but gated to admin actors.** Rejected: user settings would still carry an administration section, and the gateway admin page already renders the same operations with a fuller endpoint editor — a second home for the same decision invites divergence.

**Unmount but keep the package.** Rejected: an unmounted plugin is dead weight every static gate must keep carrying; the capability's administration path is already owned by `gateway/src/remote-desktop-service.ts`, so no unique code would remain behind.

## Consequences

The user settings page no longer lists a remote-desktop section; administrators use the admin surface exclusively. Wire-level admin methods (`grant`, `revoke`, `setLevel`, `listGrants` for other principals) remain enforced by `requireAdmin` in the provider — removal of the section changes presentation, not authorization. The [capability-seam note](2026-10-19-remote-desktop-capability-seam.md) keeps owning the grant/consent/attach design; its deferred-work list no longer names the removed package.

## Verification

`verify-cordis-config` passes with the mount entry removed; the web-app composition spec boots without the plugin; `grep -r remote-desktop-admin` over the tree returns no live references after regeneration of the module graph, config catalog, and composition-reference packages table.
