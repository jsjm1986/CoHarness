---
kind: upgrade-guide
description: "Inspector cleanup can retry resource completion after a rejected accounting acknowledgement."
---

# Upgrade Inspector cleanup ownership

English | [中文](guide.zh.md)

## Change

`InspectorHandle.close()` and `InspectorStartupCleanupError.cleanup()` retain cleanup responsibility when resource completion fails after Worker exit. Calling them again retries the unacknowledged completion. Concurrent calls share pending work, while successful completion remains idempotent.

Plugin startup retains its resource provider before process admission. Withdrawal or replacement before native allocation rejects with `ResourceAdmissionError` reason `unavailable` and returns the unused grant to its original owner. Failed unused-grant completion also transfers retryable cleanup; startup cancellation and cleanup failures remain available together. Programmatic callers can supply optional `InspectorAdmission.assertOwnership` for current-owner checks.

## Migration

1. Upgrade the complete Inspector package, including its Worker bundle. Existing options and method signatures are unchanged.
2. Retain the handle or transferred cleanup when its call rejects. Resolve the accountant failure and call cleanup again; socket closure alone does not confirm released capacity.
3. Confirm the Worker endpoint is closed and the accountant acknowledges completion before discarding the owner. See [resource ownership](../../../../.agents/notes/implemented/bug-fix/2026-10-29-inspector-resource-completion.md).
4. After ownership rejection, restore admission and start a fresh request. Do not transfer the old grant to a replacement provider.
