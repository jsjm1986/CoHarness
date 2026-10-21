# Agent Note: Remote-desktop live sessions track grant truth through expiry, failure, and mutation

Status: implemented

English | [中文](2026-10-20-remote-desktop-live-sessions-track-grant-truth.zh.md)

## Problem

The VNC provider's `live` session map diverged from authorization truth in three independent ways. An attach token that expired unconsumed deleted only the `pending` entry while the session stayed in `live` forever — `status().attachments` counted phantoms and the map grew without bound. A consumed token whose stream failed before the pump started (missing endpoint, unreachable dial, a recorder that could not open) left the same phantom session plus a connected upstream socket, because only `socket.destroy()` ran. And a live session outlived the grant set that authorized it: `revoke` and `setLevel` downgrades committed the grant change but left the open stream — and its control-level input path — running until the client disconnected. Separately, `listGrants` answered "which rows exist" rather than "which targets may the caller attach under now", so the end-user guide could offer targets bound to another session or another principal.

## Decision

Session bookkeeping now shares one commit path. `attach` arms a per-token timer; an unconsumed token expires into `finishDetach`, which removes the `live` entry, records `detach`, and emits `remote-desktop/attached`. Every `serveStream` failure after the token is consumed — missing endpoint, dial failure, recorder-open failure, an expired entry — destroys both sockets and finishes the same detach, so `live` never holds a session without a stream. `revoke` and `setLevel` call `enforceLiveSessions`, which re-runs `matchingGrants` per live session against the committed store and detaches any session whose resolved level is no longer authorized; a surviving grant keeps the stream open. `listGrants` gains `attachable` plus a caller-bound `sessionId`, filtered through the same `matchingGrants` predicate `resolve` uses and requiring a configured endpoint for the target; the browser controller binds `sessionId` to the addressed agent and the guide passes `attachable: true`, so listed targets are exactly the ones attach would authorize. The tab body exposes the previously dead `disconnect`/`reconnect` copy: disconnect closes the RFB socket (which detaches server-side), and reconnect re-runs status → attach for a fresh token.

## Alternatives considered

**Keep live sessions until the client disconnects, even after revoke.** Rejected: revocation is an administrator action that must take effect; a control-level stream surviving its own revoke silently widens access past the authorization boundary.

**Sweep expired pending entries lazily inside `attach`.** The original `sweepPending` only ran on the next attach, so a deployment with no new attaches held phantom sessions indefinitely. The per-token timer makes expiry self-driving; the sweep is removed rather than kept as a second clock.

**Filter attachable rows in the controller or the guide.** Rejected: session-scope matching must agree with `resolve`, and duplicating it outside `matchingGrants` would let the listing drift from the enforcement predicate.

**Expose a `detach` Remote method instead of closing the socket.** Deferred: the stream close already reaches `finishDetach`, and an explicit force-detach administrator method remains the open follow-up rather than a user-facing call.

## Consequences

`status().attachments` now counts real sessions, `live` is bounded by the token TTL plus stream lifetime, and admin grant mutations take effect on open streams within the same call. The audit trail records the enforced detaches, so a revoked session shows both the `revoke` and its `detach`. Sessions whose stream fails before the pump write a `detach` event, keeping attach/detach pairs balanced. The trade-off is an extra grant-set scan per mutation — bounded by the live-session count, which is itself now bounded. `tests/service.spec.ts` pins the expiry detach, the revoke-downgrade detach, the surviving-grant case, the recorder-failure teardown, and the attachable listing; `tests/ws-duplex.spec.ts` covers the stream adapter that carries detach to the wire.
