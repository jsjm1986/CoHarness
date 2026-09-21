# @deepseek-ai/dsh-collaboration-gateway

English | [中文](README.zh.md)

Gateway-backed provider for the `dsh-collaboration` Service Definition. It derives the participant from `dsh-gateway-runtime`, delegates project membership and root-conversation ACL decisions to authenticated internal Gateway endpoints, and validates every returned field before publishing it to Consumers.

## Summary

Use `dsh-collaboration-gateway` as the Gateway-backed provider for the `dsh-collaboration` Service Definition. It derives the participant from `dsh-gateway-runtime`, delegates membership and root-conversation ACL decisions to authenticated internal Gateway endpoints, and validates every returned field before publishing to Consumers.


## Runtime contract

- `capture()` freezes the current verified principal into an authority whose participant, expiry, and provider lifetime remain stable for the request or stream operation.
- Project authorization, readable-session filtering, and interaction claims call `/internal/runtime/collaboration/*` with both the runtime bearer token and the captured principal. The captured abort signal reaches the request and response-body reader, so a cancelled history or stream does not keep decoding an ACL response. Unknown HTTP failures and malformed responses become `gateway-unavailable`.
- Personal scope treats existing session ids as readable and interaction claims as accepted; project scope always asks the Gateway for the authoritative result.
- Project root creation requires `rw` membership and runs under the requested visibility. Personal creation passes through without project metadata.
- Disposing the provider aborts its lifetime signal and makes every captured authority fail closed before another request.

## Model Experience

Indirectly, through dsh-collaboration-context, which owns model-visible participant attribution for the operations this provider authorizes.

#### KV Cache effect

No direct invalidation; the consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Gateway availability is authoritative** — a project operation is denied when the internal authorization request fails or returns invalid JSON; there is no stale local ACL cache.
- **Per-operation authorization traffic** — session actions and visibility filtering may issue loopback requests; batching exists only for readable session ids.
- **No offline project mode** — project runtimes cannot continue collaboration authorization after the Gateway or provider becomes unavailable.
