# Agent Note: Repeated sandbox modes need no approval

Status: implemented

English | [中文](2026-09-16-sandbox-same-mode.zh.md)

## Problem

Models can repeat `sandbox_permissions: danger-full-access` while that mode is already effective. Rejecting the call prevents authorized work without preventing any permission increase.

## Decision

`approveEscalation` returns the effective mode immediately when the requested mode matches it. The bash tool keeps one pairing exemption on that path: an exact repeat may omit `justification`, while an explicitly-passed blank or whitespace-only `justification` is always rejected (`invalid justification: expected a non-empty sentence`). The [filesystem family](2026-07-14-cross-family-fs-sandbox.md) keeps pairing mandatory on every request. Wider modes still require approval; narrower and unsupported targets still fail. This partially supersedes the non-widening rejection in the [sandbox decision](2026-07-06-sandbox.md); its confinement and per-call approval decisions remain active.

## Alternatives considered

**Reject every non-widening request.** This makes a redundant argument fatal even though it asks for no additional permission.

**Ask for approval again.** Existing permission is sufficient, so another prompt adds no authorization.

## Consequences

Bash and filesystem tools accept repeated effective modes without an approval service or agent. Shared unit tests cover both advertised targets, both tool consumers execute the repeated mode, and the `fs-same-mode` ACP snapshot verifies an unrestricted write with no approval events and checks the resulting file.
