# Agent Note: Absorb peer resets on pre-adoption upgrade sockets

Status: implemented

English | [中文](2026-11-05-upgrade-socket-error-guard.zh.md)

## Problem

The Gateway `upgrade` listener owns the raw socket for the whole asynchronous `finish()` window — node-channel and node-service authorization, session lookup, and context resolution all await database or filesystem work before a channel or proxy adopts the stream. No `error` listener was attached in that window, so a peer reset reached the socket's `error` event unhandled and took the process down. CI observed it as a stray `ECONNRESET` in `node-access-postgres.spec.ts` after an agent died mid-handshake.

## Decision

Attach an absorbing `error` listener at upgrade entry in [server.ts](../../../../gateway/src/server.ts). The existing `close` listener already records the failed upgrade with its `hadError` flag, and every async authorization path still checks `socket.destroyed` before adoption, so a dead socket cannot complete the handshake. Adopted WebSockets keep their own error handling; the guard is additive and does not suppress it.

## Alternatives considered

**Attach the guard inside `node-channel.accept` only.** The same unguarded window exists for browser API upgrades and service-proxy upgrades; the guard belongs at the single ownership point.

**Reject the upgrade on socket error.** The socket is already dead; every consumer already settles through `close` and `destroyed` checks.

## Consequences

A client that resets mid-handshake can no longer crash the Gateway. The failed upgrade remains observable through the performance settlement's `hadError` record.

## Verification

`node-access-postgres.spec.ts` terminates a live node agent whose channel handshake races the authorization window; the run previously produced one unhandled `ECONNRESET` per suite under CI scheduling. All 1222 gateway tests continue to pass.
