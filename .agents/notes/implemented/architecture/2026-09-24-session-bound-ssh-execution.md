# Agent Note: Session-bound SSH execution

Status: implemented

English | [中文](2026-09-24-session-bound-ssh-execution.zh.md)

## Problem

The [SSH execution providers](2026-09-23-ssh-execution-providers.md) make `fs`/`subprocess`/`sandbox`/`ssh` resolvable to one managed remote host, but a provider subtree mounted on the root realm would put every session on that host. Sessions need a durable per-session binding that survives restart, composes the remote realm before the preset's plugins capture `ctx.fs` at registration, and re-authorizes every joining caller without letting one grant's revocation kill another caller's mounts. Projects also need to opt into registered targets without an administrator round-trip for each share.

## Decision

`SessionHeader.sshTarget` is a durable binding recorded at creation, persisted through every storage layer, and authoritative on resume. It follows the `draft` extension pattern through the format library: admitted at the v3 boundary with positive-safe-integer validation, stripped before released-v2 checks, and carried by spread through v4/v5 migration, the logical catalog whitelist, JSONL headers, and the gateway persistence projection. Older codecs still reject the field.

`AgentPresets` standing mounts gain a realm dimension keyed `ssh-target/<targetId>/u<userId>[/p<projectId>]`. A registered realm hook runs inside the fresh standing scope before the composition mounts, so the SSH providers shadow `fs`/`subprocess`/`sandbox`/`ssh` for the whole preset subtree — including the tools that resolve services on their registration context, which per-agent isolate shadowing cannot reach. `packages/host/apiproxy/src/ssh-execution.ts` registers the hook; `packages/preset/agent-presets` owns the realm mechanics.

Admission is per-join: `composeAgent` resolves the caller's own `sshAuthorization` grant, keys the realm by that grant's subject, and returns a publication commit that re-checks `signal.throwIfAborted()` after setup awaits settle — a revocation racing the mount vetoes publication. The hook aborts on the owning grant's invalidation signal, retires the realm generation, and disposes the connection. Resume reads the stored binding, re-resolves under the resuming caller, and rejects a mismatched request as `ssh-target-conflict`; fork inherits the binding because the seeded history ran on that host.

Self-service sharing is scoped to project management: `share` and `listForProject` admit an organization administrator or the project's `owner_user_id`, re-checked inside the same transaction that writes. `/account/api/projects/<id>/ssh-targets` serves a share-flag list (GET) and share toggles (POST) to project managers; `capabilities.sshTargets` reports the capability so the UI does not infer it from role. Target registration, secrets, and revisioned mutation remain administrator-owned in `/admin`.

## Alternatives considered

**Per-agent isolate shadowing** — mounting the four providers on `agentCtx` cannot reach preset tools: they resolve `ctx.fs` on the standing-mount registration context, and `provide` writes to the fiber store of the construction context. The realm'd standing mount is the only point that shadows services for the whole composition.

**Keying realms by target alone** — a shared `ssh-target/<id>` realm would let caller A's revocation dispose the connection under caller B's live sessions. Keying by grant subject confines each revocation to the mounts that grant authorized.

**Request-named target on resume** — letting a later request rebind would replay the session's history against a filesystem its turns never saw. The stored binding wins; a differing request is a conflict, mirroring `agentPreset`.

**Project-level target CRUD** — target rows carry helper digests, host keys, and credential references; registering them is a deployment security decision. Only the share decision — which registered targets this project may use — is delegated to project management.

## Consequences

Realm keying by subject duplicates standing mounts across users of the same target — the fail-closed cost of revocation isolation. A revoked grant retires every mount it authorized and fail-closes in-flight provider calls; `sshTarget` sessions require both a preset roster and `sshAuthorization`, and cold resume fails loudly without them. Sessions bound to a target skip the host `mkdir` on create. The UI change is user-visible and owes real-server acceptance evidence before the pull request lands.

## Testing

`realm.spec.ts` proves providers shadow inside the realm'd standing scope across mount, recompose, invalidation, and stale-generation rollback. `ssh-execution.spec.ts` pins resolve/commit/revoke contracts. `api-proxy-ssh-target.spec.ts` covers header recording, subject-scoped mount, missing-roster and missing-service failures, the publication commit gate, stored-binding resume, and live/persisted conflict refusal; `api-proxy-fork.spec.ts` covers fork inheritance. Codec admission and migration suites cover `sshTarget` round-trip, malformed rejection, and v2 strictness; the JSONL spec covers inspect/listHeaders persistence. `password-channel.spec.ts` covers askpass staging and cleanup. `gateway/tests/ssh.spec.ts` covers owner-vs-member share authority and `listForProject` under PostgreSQL; the client spec covers transport routes, malformed responses, and unavailable degradation.
