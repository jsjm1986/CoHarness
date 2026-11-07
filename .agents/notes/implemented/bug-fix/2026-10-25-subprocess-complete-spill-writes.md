# Agent Note: Complete subprocess recovery-file writes

Status: implemented

English | [中文](2026-10-25-subprocess-complete-spill-writes.zh.md)

## Problem

A synchronous filesystem write can accept fewer bytes than requested. The subprocess collector advertises its spill as the complete output stream, so ignoring the returned byte count gives readers an incomplete recovery file even when the retained tail and total byte count are accurate.

## Decision

The [local subprocess collector](../../../../packages/subprocess/subprocess-local/src/output.ts) advances by the actual written byte count for both buffered bytes captured before overflow and subsequent stream chunks. Zero progress enters the existing spill-failure path: discard the incomplete file, report one failure and retain the in-memory tail. An incomplete file never becomes a full-output locator.

The [tool-result spill policy](../architecture/2026-07-08-tool-output-spill-files.md) owns a separate storage seam and remains independent of raw subprocess stream collection.

## Alternatives considered

**Assume a successful syscall wrote the whole buffer.** A resolved call provides a byte count, which is the only established progress. A short write does not require an exception.

**Keep the partial file as the recovery artifact.** A reader cannot reconstruct omitted stdout from a file advertised as complete. The bounded tail remains available when full recovery fails.

## Consequences

Partial writes require additional synchronous syscalls while preserving the existing output limits. Zero progress produces one contained filesystem failure instead of a busy loop or a false recovery path. The process and its in-memory output continue through that failure.

## Verification

Real-file tests force short and stalled writes across the pre-overflow prefix and later chunks. A keyless Loader composition runs an actual Node child, forces partial writes only on its recovery descriptor and records complete file contents, the retained tail and process quiescence. The collector participates in the POSIX per-file coverage check with these I/O failures included.
