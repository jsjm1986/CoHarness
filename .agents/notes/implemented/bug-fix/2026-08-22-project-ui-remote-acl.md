# Agent Note: Project UI Remotes use session-scoped ACLs

Status: implemented

English | [中文](2026-08-22-project-ui-remote-acl.zh.md)

## Problem

Project collaboration denied the Typert Remotes used by the browser composer because the project policy classified only older domain methods. Command discovery, command execution, file-reference lookup, and session-reference lookup therefore failed before their owning services could run, leaving the `+` menu and `@` completion empty and preventing the permission command from reaching the administrator-only Full access check.

## Decision

`dsh-host-apiproxy` classifies `commands/list`, `fileReferences/list`, and `sessionReferenceResolver/candidates` as Session `read` operations, and classifies `commands/execute` as Session `write`. The existing collaboration authority remains the only source of project membership and root-conversation access. Session-reference discovery and preparation also apply that authority's readable-session filter, so private project sessions are neither suggested nor loaded by a crafted mention. Read-only members can discover candidates and commands for readable sessions; only members authorized for `write` can dispatch a command. The permission preset service continues to restrict `danger-full-access` to an authenticated administrator, and project runtimes remain confined to the project directory.

## Alternatives considered

**Allow all process-wide Remotes in project scope.** Rejected because command execution and reference discovery carry a Session identity and must not bypass private-conversation ACLs; a broad exemption would also authorize future process-wide capabilities without review.

**Keep the UI Remotes denied and add browser-side fallbacks.** Rejected because the Host owns command registration, filesystem discovery, and session snapshots; a fallback would duplicate or weaken those providers and could not authorize command execution safely.

**Treat `commands/execute` as a read operation.** Rejected because command handlers append durable lifecycle events and can mutate Session state, including permission and goal commands.

## Consequences

Project composer discovery works through the same generated Remote namespaces as personal sessions. A read-only participant can use `@` and open `+` to inspect available actions for readable sessions, while command submission still fails with the collaboration write refusal. Direct references to private sessions fail before snapshot reads. Administrator Full access selection reaches the existing role check instead of being stopped by the generic project Remote deny path.

## Testing

`packages/host/apiproxy/tests/api-proxy-collaboration.spec.ts` covers all four newly classified endpoints, the administrator-capable write path, read-only discovery with write refusal, and continued rejection of an unclassified Remote. `packages/context/session-reference/tests/session-reference.spec.ts` covers candidate filtering and direct-reference refusal for unreadable sessions. The package README and collaboration subsystem reference list the same allowlist.
