# Agent Note: Event streams subscribe when opened

Status: implemented

English | [中文](2026-08-17-event-stream-open-subscription.zh.md)

## Problem

The API Proxy originally installed `events.mux` and `events.host` listeners when each method was called. The collaboration ACL integration moved asynchronous visibility initialization into async-generator bodies. Async generators do not execute until their first pull, so an admitted connection could call a stream opener, delay consumption briefly, and lose every Session or Host increment committed during that interval. The mux view test exposed the same timing error when a Session was created, appended, and disposed before iteration began.

## Decision

Both event-stream methods remain single-consumer async generators, but the API Proxy starts each generator through one internal `openStream` adapter before returning it. The adapter retains the first pending result for the eventual consumer and delegates `next`, `return`, and `throw` to the same generator. Listener registration and collaboration initialization therefore begin at method invocation, matching the carrier's stream-open lifecycle, while frame delivery remains pull-based.

The two stream implementations use the same adapter. ACL filtering, initialization queues, principal expiry, abort handling, and cleanup stay owned by their existing generators; the adapter changes only when their work begins. A caller that returns the iterator still reaches the generator's cleanup path.

This timing rule extends the project collaboration decision in [Project collaborative conversations](../feature/2026-08-15-project-collaborative-conversations.md): authorization may delay publication, but it must not create an unobserved interval after the Host has admitted the stream.

## Verification

API Proxy tests cover a mux stream opened before a Session is created and disposed, plus a Host stream that receives a Session addition committed before its first pull. Collaboration tests continue to cover increments committed while the initial ACL batch is pending and stream closure at principal expiry.

## Alternatives considered

**Require every caller to pull before performing work.** Rejected because the public opener already represents stream admission, and carrier scheduling must not become part of event-delivery correctness.

**Move every listener and snapshot operation outside the generators.** Rejected because that would duplicate setup and error handling across both streams. Starting the existing generators preserves one lifecycle owner and the established cleanup paths.

## Consequences

Calling `events.mux` or `events.host` immediately begins subscription and authorization work. Consumers may defer their first pull without losing later increments, and both streams retain their existing wire frames, ACL decisions, backpressure, expiry, and disposal behavior.
