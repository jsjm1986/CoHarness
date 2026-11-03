# Agent Note: Default spill storage owns its exit cleanup

Status: implemented

English | [中文](2026-10-31-default-spill-lifetime.zh.md)

## Problem

Importing subprocess output helpers registered a process-exit callback even when no default spill directory existed. Re-imported provider modules accumulated unused callbacks and triggered listener warnings during lifecycle tests, obscuring actual ownership failures.

## Decision

The default-directory allocator registers its cleanup after successfully creating storage, once for that directory. The callback retains the allocated path. Import-only and caller-owned-directory use register no default cleanup. Empty default directories are removed at an observable process exit; completed files remain available for recovery. Failed initial creation registers nothing, and an externally removed directory is not recreated.

## Alternatives considered

**Raise the process listener limit.** The limit would conceal callbacks with no resource to clean.

**Remove exit cleanup.** Empty directories would remain after normal process termination.

## Consequences

The process owns default storage through exit; a plugin unload cannot discard completed output. The published output API and spill limits remain unchanged. This owns directory lifetime, while the [complete-write note](2026-10-25-subprocess-complete-spill-writes.md) owns collector append semantics. Neither decision supersedes the other.

## Verification

Isolated Node processes count callbacks before import, after selecting caller storage and after repeated default allocation. Import and caller storage add none; repeated default allocation adds one. Actual exit removes an empty directory and preserves a completed file. Source and built exports exercise both outcomes. Provider lifecycle tests also dispose the service-duplication fixture's root context and run without the listener warning.
