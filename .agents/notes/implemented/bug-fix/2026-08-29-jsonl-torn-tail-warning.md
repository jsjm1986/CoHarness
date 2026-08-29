# Agent Note: Make torn-tail recovery visible

Status: implemented

English | [中文](2026-08-29-jsonl-torn-tail-warning.zh.md)

## Problem

JSONL persistence repairs an incomplete final frame and continues from the committed prefix, but an operator cannot distinguish that recovery from an ordinary load when no diagnostic is emitted.

## Decision

After a torn tail is truncated and any recoverable closing events are appended, the JSONL backend emits one logger warning containing the backend name and stable session id. It does not include file paths, event contents, or sensitive metadata.

## Alternatives considered

**Silently repair as before.** Rejected because operators need evidence that bytes were discarded and can correlate the affected session.

**Log the raw path and tail contents.** Rejected because paths and event data can contain private project information.

**Fail the session load.** Rejected because the committed prefix and crash-closer recovery remain valid and available to the caller.

## Consequences

Torn-tail repair remains loss-tolerant and deterministic while producing one actionable, privacy-preserving diagnostic per recovery.

## Testing

The zstd recovery test asserts the warning text and stable id alongside the existing repaired-event and frame-integrity checks.
