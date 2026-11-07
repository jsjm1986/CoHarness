---
kind: upgrade-guide
description: "Member MemoryWriter callers supply captured collaboration authority instead of a participant."
---

# Member memory writers retain collaboration authority

English | [中文](guide.zh.md)

## Change

Integrations constructing a member `MemoryWriter` replace `participant` with `authority`. The memory service retains principal expiry and provider invalidation while the mutation is queued. The built-in member Remote methods capture this authority themselves.

Agent writers observe cancellation before entry persistence. Gateway authorization and relay also honour cancellation during Session registration and inheritance restoration. Project writes recheck current permissions after their durable marker and refuse a changed execution state, replaced provider, revoked qualification, or unavailable authorization stream, including idle curation. Permission checks do not reserve or bill model requests. Disabling memory while a marker is pending prevents the entry mutation. Standalone member writes also refuse if collaboration becomes required while they wait.

Explicit personal and project model reads also use the current Agent scope set. With `memory.enabled: false`, every memory tool returns `memory_invalid` before accessing storage. Member Remote reads remain available for inspecting retained entries.

Disabling memory during a pending model read or search also refuses the completed result with `memory_invalid`. Catalog and recall consumers discard newly completed data from withdrawn scopes. Turning off `enabled` or `recall` cancels in-flight selectors, including queued model requests; owner reads and already logged conversation history remain available.

## Migration

1. In callers of `ctx.memory.save` or `ctx.memory.delete`, construct `{ kind: 'member', authority: ctx.collaboration.capture() }` inside the authenticated request. Pass the complete captured object rather than extracting `participant`.
2. Omit `authority` only for a standalone composition without a collaboration provider. Do not omit it to bypass an expired principal or unloaded provider.
3. Typecheck the integration and verify that an expired queued write receives `collaboration-forbidden` without changing the entry. See the [memory service reference](../../../../packages/memory/memory/README.md#member-remote).
4. Agent integrations pass their operation's `signal` in `{ kind: 'agent', agent, signal }`. Handle cancellation or `execution/forbidden`; start a fresh authorized operation instead of retrying with an old grant. Curation cursor integrations pass the same signal to `writeCursor` or `writeCursorIfUnchanged` so cancelled queued work cannot advance progress.

5. Handle `memory_invalid` from model tools while memory is disabled. Re-enable the `memory` settings section before starting a new model operation; use member Remote reads to inspect retained data while it stays disabled. See the [tool scope reference](../../../../packages/memory/tool-memory/README.md#scope-resolution).
