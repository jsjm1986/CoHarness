# Agent Note: Cloud Workspace file resources use relative, read-only RPCs

Status: implemented

English | [中文](2026-09-12-cloud-workspace-file-resources.zh.md)

## Problem

A remote browser needs to inspect files in an authorized cloud Workspace. Desktop application launch cannot deliver that content. CoHarness also has multiple runtime connections, project and private Session ACLs, and directory grants that a file preview must respect independently of Agent tools.

## Decision

The existing ApiProxy owns `workspaceFiles.list`, `stat`, `read`, and `readBytes`. Each request names a Session and relative path. Reads use a live or persisted header without materializing an Agent or Session body. The Host resolves canonical containment before probing path components, rejects symlinks, applies the `workspace-files/authorize` policy event, and checks identity and authorization again before returning a response. The directory guard consumes that event using its existing grants; an arbitrary Session cwd cannot bypass those grants. Responses carry relative paths and hashed provider freshness tokens. Version-guarded paging rejects a file replaced during reading.

Local byte windows use an opened descriptor, bounded reads, and freshness checks. Text streams release the descriptor only after the final freshness check, including when a page consumer stops early. The E2B adapter copies only the requested window and cancels its SDK stream; the SDK still transfers skipped prefixes and returns complete directory metadata. Its before/after metadata checks do not provide a local descriptor's identity guarantee.

Resource providers bind explicit API clients. The Client key includes a runtime target and Session-relative address; `base` denotes the bootstrap connection, never the focused pane. Metadata records have a Host-configured bound, share loads, and cancel pending reads after the last pin or subscriber releases them. Idle records can be evicted without invalidating a retained source handle. Transient errors preserve the last value; access loss and runtime removal clear it. Preview content remains view-local.

Agent observations travel over existing Host streams, with authorization before publication; file resources open no additional streams. Reconnect aborts old requests and revalidates metadata. A changed version marks the preview stale until explicit reload. HTTP failures preserve their status separately from file RPC errors.

Gateway access-changing handlers close matching admitted generic proxy responses and WebSockets after their database operation commits. This invalidation is process-local. Other Gateway processes and direct database mutations still rely on per-operation authorization and principal expiry; cross-process delivery is not established by this change.

## Alternatives considered

**Copy upstream resource and Session controllers.** Their implicit current-Session lookup does not identify a CoHarness Workbench pane's runtime. The existing ApiProxy and runtime pool retain transport and lifecycle ownership.

**Permit absolute addresses or use a same-origin file HTTP route.** Either would broaden file access beyond the new Session-relative protocol; active HTML would also share the authenticated application origin.

**Treat Session ownership as file authorization.** A personally owned Session may carry a caller-selected cwd. The directory-grant plugin must authorize file access independently.

**Add resource writes.** Agent tools already own CAS, approvals, filesystem observations, and audit. A second write path would require another conflict and authorization model.

## Consequences

The Workbench lists direct children for the active pane, opens text pages, and falls back to bounded Base64 windows for binary files. It uses existing slots and a bounded resource registry. User Documents retain their catalog, transfers, and storage semantics. Local application handoff requires loopback and an affirmative Host capability; cloud file actions cannot launch applications on the server.

Real local-provider tests cover cold reads, path rejection, directory-policy disposal, project read modes, mid-read revocation, size limits, and version changes. Resource tests cover target isolation, cancellation, eviction, pins, and stale generations. Full browser revocation, Gateway PostgreSQL, E2B transport measurements, Windows descriptor behavior, and production rollback remain named verification gaps in the [upgrade plan](../../../../upgrades/plans/UPGRADE-PLAN-dsh-v0.1.5-rc.2.md).
