# Agent Note: Recover idle Workspace metadata when a view returns

Status: implemented

English | [中文](2026-10-24-idle-workspace-resource-recovery.zh.md)

## Problem

A Workspace resource can be idle when its transport disconnects and recovers. The reconnect operation reads only subscribed or pinned resources. Reopening a retained idle record must therefore distinguish an obsolete connection failure from a failure that still requires explicit user action.

## Decision

The [Workspace resource registry](../../../../packages/client/runtime/README.md#workspace-file-resources) revalidates a retained connection-unavailable failure when a subscriber or pin returns. The existing connected-state check controls admission, pending reads remain shared, and final release still cancels the owned read. Revalidation preserves retained metadata and marks a changed version through the ordinary version comparison.

Permission denial and ordinary read failures keep their explicit recovery policy. Provider removal discards the record, and target identity remains part of every resource address lookup. Neither a new polling loop nor a content cache participates in recovery.

The [resource model decision](../architecture/2026-09-05-client-resource-model.md) remains active for resource identity, shared observation and pin ownership; this decision supplements idle recovery.

## Alternatives considered

**Refresh all idle records on every reconnect.** Rejected because closed previews would perform work even when no view needs them.

**Retry every failed record on subscription.** Rejected because unrelated failures and permission denial require their own recovery action; remounting a view must not silently repeat them.

**Require Reload after transport recovery.** Rejected because a known obsolete connection failure would force an extra user action although the owning connection is already usable.

## Consequences

A returning view uses its existing metadata read to clear an obsolete connection failure. Concurrent owners share that read, and a view retained during an outage still waits for its owning connection to recover. This removes a manual metadata retry without claiming a network or renderer timing improvement.

## Verification

Controlled registry regressions cover returning subscribers and pins, retained versions, shared pending reads, and denial or ordinary failures. Both recovery assertions fail on the original implementation. The assembled browser closes a CSV preview, holds a real pooled transport outage while another file verifies recovery, then reopens the idle CSV and checks its normal actions against a golden without clicking Reload. Existing active-preview geometry, selection, scrolling and wire-level denial assertions remain in the same journey.
