# Agent Note: remote-access concepts land on the collaboration authorization seam

Status: implemented

English | [中文](2026-10-17-remote-access-concepts-at-authorize-seam.zh.md)

## Problem

Upstream `api/remote-access` is a generalized endpoint/action/resource RBAC subsystem with a host service that decides non-owner calls, filters lists, and serves per-peer access snapshots. This fork already authorizes the same operations through `authorizeTypertRemote` and the collaboration authority; the question is which upstream concepts are absent rather than which package to copy.

## Decision

Keep `apiproxy` sovereign and map the upstream concepts onto the existing collaboration seam:

- **Per-principal access snapshot** — `CollaborationAuthority.capabilities()` plus `collaborationCapabilities(participant)` derive scope-permitted action classes locally (`personal` → all verbs, `ro` → `read`, `rw` → `read`/`write`/`approve`, `manage` rides the scope grant). Session-level rules still apply through `authorize()`.
- **Business-owned method ACLs** — `registerRemoteSessionPolicy(endpoint, policy)` lets a Host extension declare a Session-scoped Remote endpoint beside the built-in `REMOTE_SESSION_POLICIES` table; `lookupRemoteSessionPolicy` resolves both for dispatch, `remoteSessionId`, and `mapRemoteSessionIds`. A duplicate declaration throws — one endpoint has one access-class owner.
- **Decisions before dispatch** — `authorizeTypertRemote` is unchanged: process-wide reads/operations, registry-authorized endpoints, and manager/personal configuration categories still gate on the captured authority, and Session-specific calls still go through `authority.authorize` with the policy's execution attribution.

## Alternatives considered

Porting `packages/api/remote-access` wholesale would create a second authorization stack beside collaboration authority — two decide paths for the same operations, which both drift. Upstream's snapshot frames and grant stream (`follow()`/`REMOTE_ACCESS_SNAPSHOT_KEY`) duplicate what participants already learn through `participant.scope` and the gateway `access` response; upstream's resource-kind role objects have no counterpart here because this fork's resource model is root-inherited Session ACLs with four action classes.

## Consequences

Consumers gain a wire-free capability projection for gating UI, and Host extensions can declare Session-scoped ACLs without editing the central table. `manage` in `capabilities()` is scope-level only — callers needing certainty still call `authorize()`.

## Verification

`client-session-routing.spec` covers registration, duplicate rejection, and wire mapping through a registered policy; `collaboration-gateway.spec` covers `capabilities()` derivation for personal, `rw`, managed, and `ro` participants without contacting the gateway.
