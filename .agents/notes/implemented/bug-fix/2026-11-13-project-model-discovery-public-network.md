# Agent Note: Restrict non-administrator project model discovery to public network addresses

Status: implemented

English | [中文](2026-11-13-project-model-discovery-public-network.zh.md)

## Problem

`POST /account/api/projects/:id/model-settings/discover` accepted any `baseURL` from a project owner and fetched it from the Gateway process through the global `fetch`. A non-administrator could therefore make the Gateway request loopback, private, link-local, or cloud metadata addresses, and `accountProjectError` returned the upstream error message, including its URL, status, and response body text.

## Decision

[discovery.ts](../../../../packages/llm/llm/src/discovery.ts) accepts an optional `fetch` used for every listing request, including same-origin redirects. [public-network-fetch.ts](../../../../gateway/src/public-network-fetch.ts) supplies a Node `http`/`https` request with a replacement `lookup`: it resolves every address for the host and fails with `NonPublicNetworkTargetError` unless all of them are public unicast, so the socket dials only a checked address and a DNS answer that changes after validation cannot reach a private address. IP literals are checked before the request, and no proxy agent is used. IPv4-mapped, NAT64, 6to4, and Teredo IPv6 ranges are refused rather than decoded. `discoverOrganizationModels` takes a required `allowPrivateNetwork`; organization discovery, which is administrator-only, passes `true`, and the project route passes `user.role === 'admin'`. For non-administrators the project route replaces every discovery failure except authorization and publication-availability errors with `model-discovery-target-not-public` or `model-discovery-failed`.

## Alternatives considered

**Validate the resolved hostname before calling the global `fetch`.** Rejected: `fetch` resolves again, so a DNS answer that changes between validation and connection bypasses the check.

**An administrator-configured endpoint allowlist.** Rejected for this fix: it needs new configuration and administration UI, while public-address enforcement closes the request path without changing how project owners use public Providers.

## Consequences

Project owners who are not Gateway administrators can no longer discover models from self-hosted endpoints on private networks; administrators keep that ability. Runtime model requests to a saved project Provider `baseURL` do not pass through this fetch.

## Verification

`gateway/tests/public-network-fetch.spec.ts` classifies addresses, proves `localhost`, `127.0.0.1`, and `[::1]` are refused before any listener receives a request, and proves `allowPrivateNetwork: true` still reaches the listener. `gateway/tests/project-model-settings.spec.ts` checks the route passes `allowPrivateNetwork` by role and withholds upstream messages from non-administrators. `packages/llm/llm/tests/discovery.spec.ts` checks redirects use the supplied `fetch`.
