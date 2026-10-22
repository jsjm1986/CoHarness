# Execution resource admission

English | [中文](resource-budget.zh.md)

The [Resource Budget definition](../../packages/context/resource-budget/README.md) describes reservations acquired before execution and retained through cleanup. Its abstract service does not supply a scheduler. The package reference owns provider composition and consumer release obligations.

<a id="resource-types"></a>
## Resource types

[`ResourceKind`](../../packages/context/resource-budget/src/types.ts) distinguishes `model` and `process` reservations. A persistent terminal consumes process capacity; there is no separate worker-thread kind.

[`ResourceRequest`](../../packages/context/resource-budget/src/types.ts) contains the resource kind, an optional cancellation signal, and an optional branded Session id. Verified actor and project facts are resolved by the provider.

[`ResourceLease`](../../packages/context/resource-budget/src/types.ts) reports either proven quiescence through `release()` or unconfirmed cleanup through `uncertain()`. Uncertainty retains resource occupancy; a disconnected transport is not proof of release.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxresourcebudget--resourcebudget-abstract-seam"></a>

### `ctx.resourceBudget` — `ResourceBudget` (abstract seam)

Provider-owned node budget; standalone compositions may omit this service.

```ts cordis-catalog
/**
 * Wait for one bounded, fairly scheduled reservation before execution.
 * @param request - resource, cancellation and optional executing Session.
 * @returns a permit retained until the caller proves execution quiescence.
 * @throws when admission is refused, canceled, expired or unavailable.
 */
abstract acquire(request: ResourceRequest): Promise<ResourceLease>
```

Source: [`packages/context/resource-budget/src/index.ts`](../../packages/context/resource-budget/src/index.ts)
<!-- END GENERATED cordis-surface -->
