# Agent Note: Provider teardown retains observers through consumer cleanup

Status: implemented

English | [中文](2026-10-18-provider-teardown-observers.zh.md)

## Problem

A consumer can append its final Session event while its provider is being unloaded. Closing the JSONL tracker with the service removes the event listener and file handles before that consumer finishes, leaving the event in memory without a durable record. A credentials watcher has a related lifetime requirement: Chokidar clears listeners during close but a pending write-settle poll can still emit an error.

## Decision

The JSONL plugin owns the tracker outside the storage service's child fiber. Provider unload awaits service and dependent-consumer disposal before releasing the tracker, so consumer cleanup can append events and the final writer drain includes them. This ordering applies to provider-triggered unload; concurrent root disposal does not establish an ordering between unrelated sibling fibers. The application must stop active producers before disposing the root.

The credentials provider closes admission, calls `watcher.close()`, reattaches its error handler, and awaits close plus accepted credential operations. While active, the handler reports watcher errors; after closure it consumes late errors without publishing or logging. Retaining that handler accommodates callbacks that Chokidar's close promise does not quiesce.

These provider-specific lifetimes apply the [bounded runtime teardown rules](2026-08-27-bounded-runtime-work-and-teardown-fences.md).

## Alternatives considered

**Drain the writer before disposing consumers.** Rejected: a successful drain covers only events already accepted, not the final events consumers append during cleanup.

**Register tracker cleanup beside service cleanup.** Rejected: sibling disposal effects do not express the required ordering.

**Remove every watcher listener at close.** Rejected: a subsequent EventEmitter `error` without a listener escapes as an exception even though the provider can no longer act on it.

## Consequences

Provider unload retains the existing Session format and append semantics while preserving final consumer events. The watcher handler remains attached to the closed watcher for its remaining callback lifetime; it does not reopen the provider or accept work. Neither change promises recovery from process termination before accepted writes drain.

## Verification

The [Loader teardown test](../../../../packages/session/session-persistence-jsonl/tests/teardown-loader.e2e.ts) unloads the actual provider while a dependent consumer appends its final event, then reads the file and checks listener and handle release. Storage tests exercise flushing and failure paths. Credential tests reproduce close-time listener removal and a later error emission; this is deterministic library-lifecycle evidence, not native Windows filesystem acceptance.
