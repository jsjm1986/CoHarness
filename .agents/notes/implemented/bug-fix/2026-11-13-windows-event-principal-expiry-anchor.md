# Agent Note: Anchor signed principal expiry to the backdated issue time

Status: implemented

English | [中文](2026-11-13-windows-event-principal-expiry-anchor.zh.md)

## Problem

`GatewayPrincipalSigner` backdates `issuedAt` by one Windows clock tick (16 ms) on `win32` so an immediately delivered assertion survives the coarse V8 clock baseline resample. `expiresAt`, however, was anchored to the unadjusted `now`. On Windows every signed principal's declared lifetime (`expiresAt - issuedAt`) therefore exceeded its intended lifetime by one tick, and for [event-connection principals](../architecture/2026-10-23-event-stream-principal-renewal.md) issued at the 30-second cap the declared lifetime read 30 016 ms. `StreamPrincipalLeases.register` rejects any assertion above 30 000 ms, so every `events.mux`/`events.host` upgrade through a Windows-hosted Gateway was refused, destroyed the node-service bridge stream, and surfaced at the center as `node-service/unavailable` (503) while ordinary HTTP requests over the same channel stayed healthy.

## Decision

`expiresAt` in [principal.ts](../../../../gateway/src/principal.ts) is now `issuedAt + lifetimeMs` for both the request-principal path and `issueForward`, so the document's declared lifetime always equals the intended lifetime on every platform. On Windows the absolute deadline lands 16 ms earlier — an immaterial shift against 30-second and larger TTLs — and every existing invariant (`issuedAt` never in the future, `expiresAt` never already past, declared lifetime at or under the register's cap) holds without platform branches in the checker.

## Alternatives considered

**Widening the register cap by one tick on Windows.** Rejected: it leaks the signing platform's clock compensations into the verification contract and leaves the document's declared lifetime inconsistent with what was asked for.

**Clamping only `issueStream`.** Rejected: the mis-anchoring existed in every `signPrincipal` and `issueForward` emission; fixing the shared anchor resolves the defect class once.

## Consequences

Event connections through Windows-hosted Gateways — including every remote node's browser event stream — now register and proxy normally. Ordinary principals lose nothing: their effective validity shrinks by at most 16 ms on Windows. `issueForward` claims carry the same anchored expiry for consistency even though no duration check currently consumes it.

## Verification

`principal.spec.ts` asserts the anchored expiry and both boundary instants against the platform-aware `first` instant, and the updated [run-windows-principal-clock.mjs](../../../../gateway/tests/run-windows-principal-clock.mjs) adds the regression proof on real Windows: an `issueStream` assertion must stay inside the 30-second register window and must register in `StreamPrincipalLeases`. The defect was reproduced live on the `windows-vps-47` node before this change (bridge `ERR_STREAM_PREMATURE_CLOSE`, `event principal is not short-lived browser authority`) and cleared after it — the upgraded socket returned 101 and the public site booted the Windows runtime end to end.
