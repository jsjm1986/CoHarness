# Agent Note: Remote-desktop actor resolves from the request principal

Status: implemented

English | [中文](2026-10-20-remote-desktop-interactive-principal.zh.md)

## Problem

The remote-desktop controller borrowed the terminal authorization seam: `RemoteDesktopAccess.authorize` delegated identity to `userTerminalAuthorization`, which mints a `terminal_session_grants` row through the Gateway's `terminal-authorize` endpoint. That endpoint enforces terminal qualification — for project runtimes, an enabled project-level `harness.terminal_access_policies` row — so every `remoteDesktop/*` call in a project runtime without terminal access failed `terminal/forbidden` and the guide rendered a read failure. Two latent defects rode the same substrate: `administrator()` required a `terminal-admin` purpose assertion that only `/api/terminal/admin*` requests carry, so `actor.admin` was permanently false and management methods were unreachable over the wire; and `String(authority.creator)` produced the terminal creator blob rather than the username administrators write into the grant file, so grant matching could never succeed.

## Decision

`RemoteDesktopAccess.actor` resolves the caller directly from the request's verified Gateway principal via `gatewayRuntime.interactive()`: `principal` is the claim's `user.username`, `admin` is `user.role === 'admin'`. Administrator-issued grants are the complete product permission — the call needs no terminal grant. Restricted-purpose and non-interactive callers (agent-driven requests, `webhook-dispatch`, expired assertions) are denied with `remote-desktop/forbidden`. Standalone deployments keep the `local-operator` administrator. The controller drops the two-step authorize/administrator resolution; `adminActor` asserts the claim role. Provider-side enforcement is unchanged: grants still gate `status`/`confirm`/`attach`, and `requireAdmin` still gates management even if the wire actor were forged.

## Alternatives considered

**Enable project-level terminal policies in the deployment.** Rejected: it preserves the wrong dependency — remote-desktop availability would still rise and fall with an unrelated product's access policy, and the `creator` blob still mismatches grant principals.

**Keep `userTerminalAuthorization` and add a username mapping.** Rejected: the seam would still mint terminal grants as a side effect of reading remote-desktop grants, and the permanent `admin: false` defect would remain.

**Resolve the actor inside the provider.** Rejected: the controller owns the wire boundary where the verified principal is already scoped; pushing claim reads into the capability would spread transport knowledge into the service layer.

## Consequences

Guide `listGrants`, consent, attach, and wire-level grant administration all work for interactive users on any runtime without touching terminal policy. Administrator grants now reach real administrators — previously those methods were unreachable for everyone. The terminal seam keeps its own contract; remote desktop no longer mints terminal grants as a side effect. `tests/access.spec.ts` pins standalone, user, admin, non-interactive, restricted-purpose, and expired-claim resolution; the [capability-seam note](2026-10-19-remote-desktop-capability-seam.md) keeps owning the grant/consent/attach design this actor feeds.
