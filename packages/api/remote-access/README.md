---
description: "Method-level Remote access control for non-owner Peers: role-based policy decisions, list filtering, and the per-Peer access snapshot."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-remote-access

English | [中文](README.zh.md)

## Summary

Decides which Remote methods a non-owner Peer may call and which forwarded events it may receive. Business packages define roles, each an action set over one resource kind, and register one policy per non-owner principal kind that binds roles to resources. List methods filter items through `allows()`, and each Peer follows its own access snapshot, so the Client can hide entries the Host would refuse. Dispatch authorization stays with the collaboration seam: the Gateway's `typert-gateway/authorize` carries no principal, so nothing calls `decide` today — the [authorize-seam Agent Note](../../../.agents/notes/implemented/feature/2026-10-17-remote-access-concepts-at-authorize-seam.md) owns the single-path rationale and the [port note](../../../.agents/notes/implemented/feature/2026-11-15-forge-panel-remote-access-port.md) records what shipped.

## Table of Contents

- [Host service: `RemoteAccessService` (ctx key: `remoteAccess`)](#host-service)
- [Client face](#client-face)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="host-service"></a>
## Host service: `RemoteAccessService` (ctx key: `remoteAccess`)

Compositions mount this service beside [API Gateway](../gateway/README.md) when they need policies, snapshots, or `allows` filtering; the local Gateway does not inject it. The owner (`{ kind: 'owner' }`) is never checked; every method below concerns non-owner principals.

| Member | Contract |
|---|---|
| `registerPolicy(kind, policy)` | Registers the `RemoteAccessPolicy` of one non-owner principal kind; its `bindings()` and `explain()` receive principals typed by that kind. A second policy for the same kind throws. The registration is a Cordis effect of the caller's fiber; registration and removal recompute open snapshots. |
| `invalidate(principal?)` | Reports that bindings or condition answers for one principal, or for every principal, may have changed. A business package calls it on every grant, revocation, mode change, and expiry. |
| `decide(request)` | Gateway-facing. `request` is `{ principal, action, resources, args? }`: the caller or recipient, the endpoint `ns/method` or `event:<name>`, the valid resources the caller resolved, and a call's arguments validated against their Typert-compiled types, with lookup parameters as wire identities. Returns `{ kind: 'allow' }` or `{ kind: 'deny', reason }`; a caller that wires it throws `remote-access/denied` with details `{ action, reason }` for a denied call and drops a denied event without building an error. No local dispatcher calls it — `typert-gateway/authorize` carries no principal. The owner and `remoteAccess/follow` are always allowed. |
| `allows(resource)` | Reads the invocation of the Context that accessed the service, so a list method calls `this.ctx.remoteAccess.allows(resource)` for each item. Decides the call's endpoint action on that resource without arguments, reading the bindings again on every check. True for the owner and outside a Remote call. |
| `snapshotFor(principal)` | The baseline a page opens with: `{ type: 'baseline', owner: true }` for the owner, otherwise the principal's current grants. |
| `follow(signal)` | Remote stream `remoteAccess/follow`: one `baseline`, then `upsert` and `remove` frames. The owner receives only `{ type: 'baseline', owner: true }`. The stream ends when `signal` aborts or the service unloads, so a reloaded service starts every reader from a fresh baseline. |

A role `{ name, resource, actions }` is a plain value naming an action set over one resource kind, `global` or a kind declared in `TypertResourceMap`. A binding `{ role, resource, condition? }` grants the role on one resource of the role's kind. A policy answers `bindings(principal)` and an optional `explain(request)` synchronously from state it holds in memory. A request is allowed only when, on every resolved resource, some binding names that resource, its role lists the action, and it has no condition or its condition allows. Resources are independent: a grant on `global` implies nothing on any other resource, and no resource implies another. A condition receives `{ action, resource, args? }` and runs only for a binding whose resource and role match; `args` is absent for events, snapshots, and list filtering. `bindings()` runs once per `decide()`, once per `allows()` check, and once per snapshot computation; it is never cached across decisions, so time-dependent state applies to the next call.

A caller wiring `decide` resolves resources from `@Remote` and `@RemoteScope` `resources` readers, lookup and Host Context adapter `resource` declarations, and the default field or resolver declarations in `typert.resources`; this package reads no argument field. A call that names no resource touches the `global` resource alone, so only a `global` role can allow it; putting an action in a `global` role lets the principal call it on any resource the call does not name. The caller refuses a call whose resources are invalid with `resource-invalid` without asking `decide()`.

When `bindings()`, a condition, or `explain()` throws, the decision is refused with `policy-failed`; in a snapshot, a throwing `bindings()` leaves the principal no grant and a throwing condition excludes its action. A faulty rule therefore never breaks the shared `$events` source, the snapshot stream, or page rendering. The service logger reports the first failure of each policy after each `invalidate()` and each policy registration or removal; later failures of that policy stay silent until then.

A forwarded event is decided as the action `event:<name>` on the resources its forwarding entry's readers name, or on `global` when the entry declares none, and reaches a non-owner whole or not at all; its payload is never trimmed. An event carries every resource it declares, so a reader that returns `undefined` makes the event's resources invalid, and a wired caller delivers it to no non-owner without asking `decide()`. An event names at most one resource, so collection changes travel on follow streams whose methods decide each item inline through `allows()`.

The service adds a `global` row named `REMOTE_ACCESS_SNAPSHOT_KEY` (`__DSH_REMOTE_ACCESS__`) holding `snapshotFor(owner)` to every index the webServer renders through `webserver/index-inject` — the local document requester is always the owner, so every page opens with `{ type: 'baseline', owner: true }`; a composition that renders a page for a non-owner Peer would push that Peer's snapshot instead. The Client entry reads the global when it mounts.

| `details.reason` of `remote-access/denied` | Cause |
|---|---|
| `resource-invalid` | Given by the caller before `decide()`: a resource reader threw or returned an empty list, or a resource id, including a Context identity, is not a non-empty string. |
| `no-allow` | The principal kind has no policy, or no binding allows the action on some resource and neither a condition nor `explain()` names a reason. |
| `policy-failed` | `bindings()`, a condition, or `explain()` threw; the failure is logged as described above. |
| condition or `explain()` reason | On the first resource no binding allows, the first refusing condition of a matching binding names the reason; without one, `explain(request)` does. |

Snapshot grants list, per resource the principal's bindings name, the sorted endpoint actions of those bindings' roles that `decide()` allows there without call arguments, so the snapshot agrees with `decide()` for the same principal, action, and resource; a resource with no such action gets no grant, and the stream pushes `remove` once its allowed set becomes empty. `event:` actions never enter the snapshot. Snapshots are recomputed only after `invalidate()` and policy registration or removal.

<a id="client-face"></a>
## Client face

The Client entry reads the baseline the index injected under `REMOTE_ACCESS_SNAPSHOT_KEY` synchronously, mounts the generated `remoteAccess` contribution itself through `mountAccess(ctx, contribution, initial)`, follows the snapshot stream, and provides:

- the Client service `ctx.remoteAccess.source(kind, id, action)`, an identity-stable boolean source per `(kind, id, action)` for one resource of a declared kind;
- `ctx.remoteAccess.whenAccess(action, callback)`, which keeps the callback's effects installed while the `global` resource allows `action`: the callback runs when the answer becomes true, its effects dispose in reverse order when it becomes false, and it runs again on the next true. The callback returns one disposer or an iterable of disposers, as with `ctx.slots.inject`; it runs synchronously when the answer is already true, as it always is for the owner; the controller belongs to the caller's fiber. A setup failure while allowed throws at once; a later one retires the controller and is rethrown in a microtask. `whenResourceAccess(kind, id, action, callback)` is the same for one resource of a declared kind;
- the standard Hook `useRemoteAccess(action)`, which answers on the `global` resource.

A domain UI package that owns a resource kind builds that kind's access Hook over `source()` and its `whenAccess` over `whenResourceAccess()`; other plugins read access through the access Hooks and the `whenAccess` methods — no local package declares a resource kind yet, so the global `useRemoteAccess` is the only published Hook. A Hook's `action` is a `RemoteEndpoint`, an endpoint some Client Remote namespace declares. A non-owner answer is whether that resource's grant lists the action and never falls back to the `global` answer, so a resource without a grant, or whose grant lists no action, answers false. Every answer is true for the owner; a non-owner page without an injected baseline, and a non-owner page whose stream fails terminally, answers false; the terminal failure is reported with its error, for a non-owner with the advice to reload the page and for the owner with the note that its answers are unaffected; a reconnect keeps the last snapshot. A malformed injected baseline fails the mount. Hooks never issue requests, and the Host still checks every call. [`dsh-client-test-runtime`](../../test-support/client-runtime/README.md) replaces this row with fixed answers, allow-all by default, in Client specs.

<a id="model-experience"></a>
## Model Experience

None, as this package decides Remote access for Client callers and registers nothing model-facing.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Non-owner dispatch is not wired.** `typert-gateway/authorize` emits a `TypertGatewayAuthorizationRequest` that carries no principal, and `InvokeRemoteRequest` has no Peer field, so no local dispatcher calls `decide`, filters a forwarded event, or refuses a route — the non-owner semantics in this README are package contracts the test suite exercises, pending a carrier that mints non-owner principals. Upstream's `session/attachment`, `api-session/added`, `$events`, `session/follow`, `session/control`, `workspace/follow`, and Fetch-route wiring is not carried; authorization stays with `authorizeTypertRemote` and the collaboration authority.
- Snapshot and list-filtering decisions carry no call arguments, so a condition that refines its answer from `args` can refuse a call that the snapshot shows as allowed.
- Resource readers and automatic resolution must cover every resource a method touches; a resource the call does not name is not checked, so a principal granted on the named resources reaches it.
- Default resource resolution matches wire field names; adding a field with a registered kind's name to a method adds that kind's resource to the call.
- `core/session` declares the only `TypertResourceMap` kind (`session`); a Session the caller may not read is filtered out of lists — the forge panel drops such Sessions' change-request states — but nothing denies its methods at dispatch while the non-owner path is unwired.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
