# Resource admission

English | [中文](resource-budget.zh.md)

The [resource-budget package](../../packages/context/resource-budget/README.md) declares node-wide resource permits and their execution ownership obligations.

## Permit records

`ResourceKind` selects `model` or `process`; terminals consume process permits.

`ResourceOperationId` is a branded, provider-generated identity for one queued or admitted operation.

`ResourceRequest` carries `kind`, optional cancellation `signal`, optional branded `sessionId`, and `origin` intent (`execution`, `interactive`, or `infrastructure`). The provider captures verified ownership before queueing and never accepts caller-supplied actor or project identities.

`ResourceLease.signal` cancels owned execution without releasing its occupation. Awaited `release()` reports proven quiescence; awaited `uncertain()` retains occupation until a later exact completion or confirmed Runtime stop. Reporting uncertainty preserves cancellation from the caller and provider. Losing a connection does not prove execution stopped.

The `./wire` entry defines the bounded remote messages and committed policy. The [package reference](../../packages/context/resource-budget/README.md#remote-coordination) documents operation ownership and the Gateway's restricted completion authentication.

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
