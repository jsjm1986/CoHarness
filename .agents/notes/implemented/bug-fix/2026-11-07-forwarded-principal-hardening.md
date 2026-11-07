# Agent Note: Forwarded-principal verification fails closed and cheap

Status: implemented

English | [中文](2026-11-07-forwarded-principal-hardening.zh.md)

## Problem

`x-dsh-gateway-forward` is client-settable and its verification ran ahead of session validation. Three gaps turned malformed or unresolvable assertions into cost or outage for ordinary requests: `forwardIssuerOf` returned any non-empty string, so a payload naming `issuerNode: "junk"` reached a `uuid`-typed directory query and threw `22P02`, producing an unauthenticated 500 per request; a directory or database failure inside verification propagated the same way; and unknown-but-well-formed issuers were never memoized, so each request paid a fresh database read.

## Decision

Malformed issuers never reach the directory: [forwardIssuerOf](../../../../gateway/src/forwarded-principal.ts) now requires the issuer to satisfy `nodeUuidSchema` before it is returned, so non-node values take the ordinary session path instead of surfacing a database type error. The [forwardedPrincipal](../../../../gateway/src/index.ts) wiring treats any thrown error as an absent assertion and returns null, preserving the designed fallback to session validation on every failure mode, not only clean nulls. [NodePrincipalDirectory](../../../../gateway/src/postgres/node-principal-directory.ts) memoizes negative verdicts for the same TTL as keys — a claim about an unknown issuer costs one read per TTL, and enrollment still clears entries through the access monitor's `invalidate()`.

## Alternatives considered

**Validate shape only at the directory.** The caller is the one place every forward flows through; containing errors there covers directory bugs this change has not imagined, while the shape gate keeps the obviously-malformed case off the wire entirely.

**Skip negative caching.** Each unauthenticated request would keep paying a database read forever; caching is bounded by the same TTL and invalidated on the same monitor events as keys.

## Consequences

A malformed or unresolvable forward header degrades to an ordinary session-validated request rather than an error response. The pre-auth cost of the forward path is one cached read per issuer per TTL. A disabled mid-window user is still honored for the assertion TTL — that documented granularity tradeoff is unchanged.
