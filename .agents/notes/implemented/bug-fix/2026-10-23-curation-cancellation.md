# Agent Note: Curation cancellation and cleanup

Status: implemented

English | [中文](2026-10-23-curation-cancellation.zh.md)

## Problem

A curation response can contain several memory tools. Checking cancellation only before the next model request allows later tools in the same response to mutate memory after plugin unloading. Removing a Session's lane also loses the task handle needed to wait for its model iterator cleanup.

## Decision

Each tool checks the lane's signal before execution. The memory service carries that signal through entry admission and queued completion-cursor writes, checking it before starting persistence. Active lane tasks remain owned separately from the Session routing map until they settle. Unloading aborts lanes and joins those tasks; a lane drains its pending captures inside one task. Final cleanup removes a routing entry only when it still belongs to that lane.

## Alternatives considered

**Check only the next model round.** A single completed response can contain several mutations before another round begins.

**Wait only for tasks still in the Session map.** Session disposal removes that map entry before the cancelled provider iterator necessarily finishes.

## Consequences

Cancellation prevents later tool dispatch and entry or completion-cursor admission, including work queued behind another writer. Durable writes already admitted are not rolled back. Plugin unloading waits for the core model runtime's cancellation and iterator cleanup instead of leaving detached work.

## Verification

The built-product reproduction used the real model runtime and JSON memory: unloading after the first save still persisted both entries. Regressions verify that only the first write survives and hold real iterator cleanup until the curation disposer is proven to wait. The headless Loader snapshot stops the actual entry between two memory tools and checks durable keys and extraction progress.

Queued extraction and conditional consolidation cursor regressions retain their preceding progress after cancellation. The extraction lane test stops its Session while progress waits behind another writer and joins plugin disposal before checking the absent completion cursor. A second Loader snapshot stops curation after its marker and before the entry mutation.
