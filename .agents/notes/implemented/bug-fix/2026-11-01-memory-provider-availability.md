# Agent Note: Effective memory source changes cancel unavailable work

Status: implemented

English | [中文](2026-11-01-memory-provider-availability.zh.md)

## Problem

Attaching or replacing a settings provider can withdraw recall or curation without committing a namespace edit. Removing a provider can also withdraw those features through the composition fallback. Consumers listening only to `settings/updated` miss these changes: requests already waiting for model capacity keep their live signal and can dispatch after their effective switch is off.

## Decision

The memory service publishes `memory/switches-updated` after its effective source is replaced and synchronously during a committed memory namespace update. Consumers re-read their own injected memory service and cancel unavailable work through the existing recall or operation controller. Source replacement and ordinary edits use the same control path; queued model grants, stream cleanup and cursor writes retain their existing completion owners.

The event carries no settings snapshot. A notification can reach consumers bound to different service instances, and a consumer's own getter is the authority for its current switches. Provider wiring may reaffirm unchanged values. All callbacks run synchronously before the source-change call returns; independent observer failures are reported after every callback has been invoked through Cordis parallel dispatch. Asynchronous cleanup stays owned by its consumer.

Composition fallback remains unchanged: removing the settings provider uses the configured entry. It cancels work only when that effective configuration makes the operation unavailable. The service adds no settings cache or persisted switch state.

## Alternatives considered

**Subscribe only to namespace commits.** Initial registration and provider removal replace the resolved source without a settings write. Waiting for another commit leaves already queued requests admitted under the old availability.

**Treat a broadcast settings snapshot as every consumer's state.** Isolated service instances can have different effective settings. A notification requests a local recheck rather than transferring another instance's decision.

**Disable all memory when a provider disappears.** Optional settings explicitly fall back to composition. Changing that default also changes standalone applications and independently enabled features.

## Consequences

Recall and curation respond to provider lifetime changes as well as explicit edits. Re-enabling affects fresh operations; it does not revive an aborted request. Owner reads, admitted durable writes, model authorization, usage attribution, quotas and Session/storage formats remain unchanged. This complements [live publication](2026-10-31-memory-live-availability.md) and [independent curation cancellation](2026-10-31-memory-curation-live-availability.md). Project qualification and captured-issuer checks follow the [curation authorization decision](2026-11-01-memory-curation-authority.md); broader project revocation review remains open.

## Verification

Real LLM admission tests hold a grant across provider attachment or removal, observe cancellation before disposal, then release the late grant without adapter dispatch. Real settings-provider cases cover attachment, commit, fallback, observer failure and service replacement. Shipped SDK processes exercise recall, extraction and consolidation across edits, file-provider remount and provider removal, retaining the request and its permit until iterator cleanup. Private complete old packages reproduce the missing cancellation without editing shared source.
