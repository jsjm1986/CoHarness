# Agent Note: Hide service credentials from confined commands and require manage access for Runtime session removal

Status: implemented

English | [中文](2026-11-13-runtime-credential-sandbox-and-session-removal.zh.md)

## Problem

A systemd-launched Runtime reads its Gateway API bearer token from `LoadCredential=` (`DSH_GATEWAY_CREDENTIAL_FILE=%d/dsh-gateway`). The bwrap profile mounted `/` read-only and the Landlock profile granted `/` for reads, so a model shell command running as the same account could read `/run/credentials/<unit>/dsh-gateway`; `$CREDENTIALS_DIRECTORY` also reached the command environment. With that token, `/internal/runtime/session/remove` deleted any conversation tree inside the Runtime scope without a Gateway-signed principal assertion, including another member's private session.

## Decision

[profiles.ts](../../../../packages/sandbox/sandbox-local/src/profiles.ts) computes `hiddenCredentialRoots()` (existing `/run/credentials` and `$CREDENTIALS_DIRECTORY`). bwrap mounts an empty tmpfs over each; Landlock replaces the `/` read grant with the sibling paths of every ancestor of a hidden directory, because Landlock grants cannot be subtracted. `scrubbedParentEnv()` drops `CREDENTIALS_DIRECTORY`. For project Runtimes, `/internal/runtime/session/remove` requires a current principal assertion and `collaboration.access(..., 'manage').canManage`; `GatewaySessionPersistence.remove` forwards the request principal.

## Alternatives considered

**Deliver the credential by file descriptor only.** Deferred: an inherited descriptor reaches confined children unless every spawn closes it, which is a larger lifecycle change; the directory hiding applies to both delivery modes.

**Require a principal on every Runtime session route.** Deferred: Runtime persistence can call load, list, and append outside a request principal scope, where `GatewayRuntime.request` with `principal: true` throws `Gateway request principal is unavailable`, so a per-route principal requirement needs a separate service-identity design.

## Consequences

Confined shell commands on systemd hosts see an empty credential directory under both Linux runners. Landlock grants cannot exclude a subtree, so when the Runtime holds a `$CREDENTIALS_DIRECTORY` its Landlock-confined commands cannot list `/` or `/run`; reads of other paths are unchanged, and processes without a credential directory keep the `/` grant. Removal of a project conversation through the Runtime API now fails with `forbidden` unless the forwarded member can manage it. Personal Runtime removal keeps the existing creator-scoped check. Bearer-only reads and appends remain scoped by `belongsToRuntime`; hiding the token from confined commands is the control for those routes.

## Verification

`local.spec.ts` asserts the bwrap tmpfs arguments, a Landlock read allow-list without the hidden directory or its ancestors, and `hiddenCredentialRoots` normalization. `runtime-api.spec.ts` asserts that removal without an assertion and removal by a non-manager return 403 without `removeTree`, and that a manager removes the tree.
