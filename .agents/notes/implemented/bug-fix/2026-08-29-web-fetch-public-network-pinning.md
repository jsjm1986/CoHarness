# Agent Note: Pin WebFetch requests to validated public addresses

Status: implemented

English | [中文](2026-08-29-web-fetch-public-network-pinning.zh.md)

## Problem

An HTTP fetch provider that follows DNS at connection time can reach loopback or private services, and a DNS rebinding response can change a hostname after an initial policy check. Redirects create the same risk again for every new destination.

## Decision

The HTTP fetch provider resolves each hostname before opening a connection, rejects every answer set containing a non-public address, and uses an Undici dispatcher whose lookup callback returns only that validated set. IPv4, IPv6, mapped addresses, and DNS64 translations are checked; same-origin redirect hops repeat resolution and validation. The provider keeps the existing response, timeout, size, and approval behavior, and does not weaken the policy for tests or private deployments. A separate provider is required for an intentionally private network.

## Alternatives considered

**Validate only literal IP strings.** Rejected because ordinary hostnames and DNS rebinding would remain reachable.

**Resolve once and let the default HTTP client resolve again.** Rejected because the second lookup can return a different, private address.

**Allow private addresses behind a broad configuration flag.** Rejected because a deployment mistake would turn a model-facing tool into an unrestricted SSRF primitive.

## Consequences

Public WebFetch requests incur one DNS lookup and a short-lived per-request dispatcher. A hostname with mixed public and private answers is rejected rather than partially used. Tests and local fixtures inject a validated resolver explicitly; production defaults remain fail-closed.

## Testing

Network tests cover public-address classification, empty and malformed DNS answers, DNS rebinding, DNS64 translation, cancellation, pinned lookup family selection, redirect revalidation, and body cleanup. Existing fetch behavior tests use an explicit loopback resolver fixture.
