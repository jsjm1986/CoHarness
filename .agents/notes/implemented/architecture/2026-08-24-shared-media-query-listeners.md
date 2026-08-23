# Agent Note: Shared media-query listeners

Status: implemented

English | [中文](2026-08-24-shared-media-query-listeners.zh.md)

## Problem

Several portal-facing controls observe the same breakpoint independently, so one browser query can own several native `MediaQueryList` listeners while the UI is mounted.

## Decision

`useMediaQuery` keeps a module-local registry keyed by the exact query string. The registry owns one `MediaQueryList` and one native `change` listener per active query, fans the event out to each React subscriber, and removes both when the last subscriber leaves. A changed `window.matchMedia` implementation migrates the subscriber set to a fresh entry, which keeps test realms and browser shims from retaining a stale list. Snapshot reads reuse the active list and continue to return `false` when the browser API is unavailable.

## Alternatives considered

**Keep one `MediaQueryList` per hook.** Rejected because repeated breakpoint listeners add objects and callbacks without improving the browser result.

**Move the breakpoint into a global viewport Context.** Rejected because portal content is outside the shell frame and the frame's responsive stamp is not equivalent to the window media query.

**Add a general viewport event bus.** Rejected because it would introduce a broader mutable surface for a single exact-query reuse case.

## Consequences

Mounted controls now share native breakpoint work while preserving each hook's `useSyncExternalStore` updates, query switching, cleanup, and unavailable-API fallback. The registry is scoped to live subscribers, so it does not retain browser objects after the final unmount. Coverage includes multiple subscribers, last-unmount removal, query replacement, and a replaced `matchMedia` implementation.
