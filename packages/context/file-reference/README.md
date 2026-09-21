# `@deepseek-ai/dsh-file-reference`

English | [中文](README.zh.md)

File-reference discovery seam and browser-safe `@file` grammar shared by host-backed user interfaces. `ctx.fileReferences.list(agent, query, signal)` returns path-only file or directory candidates for the addressed agent; concrete providers own namespace access, ranking, caching, and invalidation. The same contract is remotely callable as the unary `fileReferences/list` Remote method (`@Remote` on the Service Definition, cancelled through the reserved trailing signal), so browser consumers call `ctx.remote.fileReferences.list` without an API Proxy route.

`activeAtToken()` recognizes an `@path` or open `@"path with spaces` token only at the start of input or after whitespace, so email-like text does not open completion. `formatFileMention()` emits the matching prompt spelling, appends `/` to directory candidates, preserves an explicitly opened quote, and rejects control characters or embedded quotes that the editor grammar cannot represent safely.

Selecting a candidate does not read or attach file contents. The exported `FILE_REFERENCE_PROMPT` is stable guidance that a provider may install when the addressed agent can call `read`.

## Summary

Host-backed user interfaces use `dsh-file-reference` to offer `@file` completion: a UI asks for path candidates for the addressed agent, the model types `@path` or `@"path with spaces"`, and picking a candidate inserts the matching mention as ordinary prompt text. The seam itself owns no filesystem access — a concrete provider such as `@deepseek-ai/dsh-file-reference-local` supplies candidates, ranking, caching, and invalidation. Selecting a candidate never reads or attaches file contents; the model must call a filesystem tool to inspect a file. Session Controller exposes the same discovery to browser consumers through the `fileReferences/list` Remote.

## Model Experience

Indirectly, through the composed provider, which owns the file-reference guidance that this package's discovery seam and grammar delegate to it.

#### KV Cache effect

The interface and grammar add no request tokens; a provider-owned prompt section determines whether the reusable prefix changes.

## Known Limitations and Deferred Work

- **Path candidates are advisory** — the seam does not prove that a later model-facing filesystem tool can access the same namespace; deployments must align the provider with the effective `read` implementation.
- **No file-content reference object** — selected files remain ordinary prompt text and require an explicit model tool call before their contents become model-visible.
- **`zod` is a runtime dependency of generated Typert faces, not of `src`.** The published `./typert` and `./remote` exports resolve to unbundled `lib/typert.*.js` files with bare `zod` imports. The manifest must retain `zod`; `knip.config.ts` adds a workspace-scoped exception only when neither generated JavaScript face exists, while a built checkout lets Knip observe the import directly.
