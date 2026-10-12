# Agent Note: host.openPath verifies client paths through the filesystem

Status: implemented

English | [中文](2026-10-13-openpath-fs-roundtrip-verification.zh.md)

## Problem

`host.openPath` and `host.fileApplications` accepted whatever absolute string the browser payload carried and handed it straight to the native opener or association query. `authorizePersonalConfiguration` stopped collaborative callers, but the trusted local client could still name a path the composed filesystem had no authority over — a remote-workspace path, a symlink whose canonical target lives elsewhere, or any Host path the deployment never vouched for. Upstream's `SessionController.verifyDesktopPath` (present in both alpha releases) closes that gap.

## Decision

Before an opener or handler query accepts a client-supplied path, `verifyDesktopPath` requires it to round-trip through `ctx.fs`: `processPathFromHostPath` must map the resolved absolute path into the filesystem's execution world, and `fs.resolve` + `fs.processPath` must report the identical Host path back. An unmapped or remapped path fails `bad-request`, a filesystem failure surfaces as `internal`, and an abort surfaces as `cancelled`. A deployment without an `fs` capability has no filesystem authority to verify against, so its injected opener keeps the trust it always had.

The two surfaces that carry client paths — the `host.openPath` and `host.fileApplications` RPCs — verify; server-resolved targets (`agentPreset.openDocument`'s preset directory, `settings.openDocument`'s provider materialization) carry no client path and skip the check.

## Alternatives considered

**Verifying inside `openTarget`.** Rejected: `agentPreset.openDocument` and `settings.openDocument` reach the same helper with server-resolved paths that legitimately live outside the fs authority (a shipped preset directory), so the boundary sits at the RPC surface where the caller's path enters, matching upstream's method-level verification.

**Refusing when `ctx.fs` is absent.** Rejected: fs is an optional capability in this composition (`ctx.get('fs')`), and deployments legitimately mount an injected opener without it; removing their desktop gestures would be a behavior regression, not a security gain.

## Consequences

A payload naming a path the composed filesystem cannot vouch for fails `bad-request` before any native command runs; paths that do round-trip — including relative paths normalized through `resolve` — open unchanged. Spec fixtures must name canonical paths: on macOS `/tmp/x` realpaths to `/private/tmp/x`, which is precisely what the check rejects.

## Verification

`packages/host/apiproxy/tests/native-open-policy.spec.ts` covers the verified absolute/relative handoff, unmapped and remapped `bad-request` refusals for both `open` and `reveal`, the empty path, a filesystem round-trip failure as `internal`, and the same verification for `fileApplications`. `api-proxy-workspace.spec.ts` exercises the pass-through against the real `LocalFileSystem` on canonical temp paths.

## Related

- [Filesystem capability seam](../architecture/2026-06-17-filesystem-capability-seam.md) — owns the `processPath`/`processPathFromHostPath` vocabulary this check uses.
