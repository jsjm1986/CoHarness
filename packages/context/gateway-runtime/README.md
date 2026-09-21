# @deepseek-ai/dsh-gateway-runtime

English | [中文](README.zh.md)

Authenticated request context and private loopback transport for a Harness runtime launched by the Gateway. A launch credential binds the process to one organization, one personal or project runtime identity, and the Gateway key that verifies short-lived browser principals.

## Summary

Use `dsh-gateway-runtime` for the authenticated request context and private loopback transport of a Gateway-launched Harness runtime. A launch credential binds the process to one organization and one personal or project runtime identity and verifies short-lived browser principals for other collaboration packages.


## Runtime contract

- The launch credential is read from exactly one of `DSH_GATEWAY_CREDENTIAL_FD` or `DSH_GATEWAY_CREDENTIAL_FILE`. It contains a loopback-only Gateway origin, runtime bearer token, runtime generation, organization, and Ed25519 public key.
- The `connection/request` listener requires `x-dsh-gateway-principal`, verifies its signature, lifetime, organization, scope, runtime identity, and generation, then exposes it through request-local `current()` / `requireCurrent()` access.
- `request()` accepts only absolute `/internal/runtime/` paths on the credential's loopback origin, adds the private bearer token, and forwards a browser principal only when the caller explicitly requests it.
- The private `/api/internal/gateway/readiness` endpoint accepts only a nonce plus an HMAC derived from the launch token and exact runtime identity, and returns a matching response proof; an arbitrary listener on the runtime port cannot satisfy Gateway readiness.
- Credentials and principal assertions fail closed at their parsing and request boundaries. The runtime bearer token is never exposed through the public service fields.
- Consumers that read a private JSON response use `readGatewayResponseJson()` (or its byte-level companion) with a domain limit and optional `AbortSignal`; chunked bodies are cancelled when the limit or signal is reached, so `Content-Length` is not the only protection.

## Invariants

**Runtime invariant:** No companion is published. The launch credential binds one fixed identity for the process lifetime; request context is derived per call, so nothing mutable exists to compare.

## Model Experience

None, as the request context authenticates Host operations and contributes no model input.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Gateway-launched runtimes only** — loading the plugin without a valid private launch credential fails startup.
- **Request-local principals** — `current()` is unavailable outside an authenticated HTTP or WebSocket operation; Consumers that outlive dispatch must capture the verified principal or a derived authority.
- **Short-lived assertions** — the shipped Gateway defaults `HGW_PRINCIPAL_ASSERTION_TTL_MS` to 30 seconds. A verified principal freezes its project scope mode until `expiresAt`; Session Consumers must use `ctx.collaboration` for current membership and ACL decisions. Seamless in-connection principal renewal and expiry watchdogs for long-lived streams remain a deployment follow-up; current clients reconnect when their carrier generation ends.
