---
description: "Cross-runtime UUID generation and bounded byte encoding for browser-safe client code."
kind: "package-library"
---

# dsh-util-crypto

English | [中文](README.zh.md)

Zero-dependency browser-safe UUID and byte-encoding helpers. UUIDs use `crypto.getRandomValues`, which remains available on insecure browser origins and in workers; client code must not depend on secure-context-only `crypto.randomUUID`. The package is a pure library, not a Cordis service or plugin.

## API

```ts
import { bytesToBase64, randomUUID, type Uuid } from '@deepseek-ai/dsh-util-crypto'
```

| Export | Role |
|---|---|
| `randomUUID()` | Random RFC 9562 v4 UUID generated from `crypto.getRandomValues`. |
| `bytesToBase64(data)` | Canonical base64 encoding in bounded chunks. |
| `Uuid` | Five-group UUID string type. |

## Model Experience

Indirectly, through consumers that mint request, session, and attachment identifiers; the identifiers are not semantic prompt content.

#### KV Cache effect

No direct effect; identifier consumers own any request changes.

## Known Limitations and Deferred Work

- **v4 only** — namespaces and other UUID versions are outside this utility.
- **Probabilistic uniqueness** — collision detection remains the consumer's responsibility.
