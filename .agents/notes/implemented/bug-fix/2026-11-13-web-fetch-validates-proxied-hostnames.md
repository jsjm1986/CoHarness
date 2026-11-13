# Agent Note: Validate proxied web_fetch hostnames locally

Status: implemented

English | [中文](2026-11-13-web-fetch-validates-proxied-hostnames.zh.md)

## Problem

The [outbound proxy policy](../architecture/2026-08-27-outbound-proxy-policy.md) let a proxied `web_fetch` hop skip `resolvePublicAddresses()`: only a non-public IP literal was refused, and a hostname went to the proxy unchecked. With `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` set, a model steered by fetched content could ask the proxy for `metadata.google.internal` or an intranet name and read whatever GET service the proxy reaches. The direct path refuses the same destinations.

## Decision

[provider.ts](../../../../packages/web/web-fetch-http/src/provider.ts) resolves every hop through the provider's resolver before it reads the route. A non-public answer fails with `WEB_BLOCKED_URL` and an unresolvable name fails as a provider or network error, so the proxy receives no request in either case. Only after validation does `proxyRouteFor(url)` choose the transport: a proxied route calls `requestVia` with the policy dispatcher, and a direct route pins the validated address set as before. IP literals reach the same resolver, which refuses them without a DNS query, so the separate `isNonPublicIpLiteral` check is removed.

## Alternatives considered

**Keep trusting the proxy with destination selection.** Rejected: an operator sets a proxy to reach the internet, not to grant the model the proxy's view of the internal network, and the direct path already defines which destinations `web_fetch` may reach.

**Refuse names by suffix (`.internal`, `.local`, metadata hosts).** Rejected as the primary check: a suffix list misses arbitrary intranet names, while local resolution refuses every name that answers with a non-public address and every name the machine cannot resolve.

**Pin the proxied request to the validated address.** Rejected: undici's `fetch` derives the absolute-form target, `Host`, and TLS SNI from the URL, so sending the address to the proxy would break virtual hosting and certificate validation.

**An allowlist for proxy-only names.** Deferred: no current consumer needs a name only the proxy resolves; adding one is a separate, reviewed configuration.

## Consequences

A proxied hop gets the same destination policy as a direct hop. It is validated but not pinned, so a DNS answer that changes between the local lookup and the proxy's lookup can still reach a private address the proxy can route to; the package README records this limitation. A deployment whose machine cannot resolve public names on its own and relies on the proxy for DNS can no longer fetch through `web_fetch`.

## Verification

[proxy.spec.ts](../../../../packages/web/web-fetch-http/tests/proxy.spec.ts) drives a real loopback proxy: a hostname with a stubbed public answer is resolved once and tunnelled without pinning, hostnames answering `10.0.0.1`, `169.254.169.254`, or `127.0.0.1` fail with `WEB_BLOCKED_URL` before the proxy sees a request, a name with no answer is refused without reaching the proxy, non-public literals are still refused, and a bypassed hop still resolves and pins.
